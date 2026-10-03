// ============================================================================
// 🤖 pekzho — our own WhatsApp agent, built on the pi agent framework
// (@earendil-works/pi-agent-core + pi-ai; source in refrences/pi/packages).
//
// One inbound turn goes:
//   1. ⚡ skill shortcuts (button taps, exact commands) — instant, no LLM
//   2. 🧠 otherwise a pi Agent run: DeepSeek + every skill's tools, with the
//      user's rolling chat memory loaded from Postgres and saved back after.
//
// We build a FRESH Agent per turn (cheap — it's just state) so tools can be
// bound to the current user via closures, and nothing leaks between users.
// ============================================================================

import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core';
import { createModels } from '@earendil-works/pi-ai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { db, getUserFlags, markWelcomed, type UserFlags } from '../db.ts';
import { localDateLong, TIMEZONE } from '../clock.ts';
import { SKILLS } from '../skills/index.ts';
import { downloadMedia } from '../whatsapp.ts';
import { transcribeAudio, transcriptionEnabled } from '../transcribe.ts';
import type { InboundTurn, UserContext } from '../skills/types.ts';

// 🧠 Model wiring. DeepSeek's provider reads DEEPSEEK_API_KEY from env — the same
// upstream key pektown-api's LLM proxy uses for HInstaBot / InstawebsBot.
const MODEL_ID = process.env.PEKZHO_MODEL ?? 'deepseek-flash';
const models = createModels();
models.setProvider(deepseekProvider());
const model = models.getModel('deepseek', MODEL_ID);
if (!model) throw new Error(`🧠 unknown DeepSeek model "${MODEL_ID}" — check PEKZHO_MODEL`);
if (!process.env.DEEPSEEK_API_KEY) console.warn('⚠️  DEEPSEEK_API_KEY is empty — LLM turns will fail');

const TURN_TIMEOUT_MS = 90_000;   // ⏳ give up (and apologise) instead of hanging forever
const MEMORY_MAX_MESSAGES = 40;   // 🧹 rolling window of chat memory per user

// --------------------------------------------------------------------------
// 📜 System prompt — rebuilt every turn so the date is always right, and
// never persisted, so editing it here takes effect for everyone instantly.
// --------------------------------------------------------------------------
const buildSystemPrompt = (user: UserContext, flags: UserFlags, firstContact: boolean, skillStates: string[]) => [
  'You are *pekzho*, a warm, upbeat personal productivity AI assistant that lives in WhatsApp. 🌱',
  `You are chatting with ${user.name ? `"${user.name}"` : 'a user'} (WhatsApp +${user.userId}).`,
  `Today is ${localDateLong()} (${user.today}), timezone ${TIMEZONE}.`,
  '',
  '## Style',
  '- This is WhatsApp: SHORT replies — 1–2 lines by default, never more than 4. One emoji is plenty.',
  '- Answer or act first; skip greetings, filler and repeating back what they said.',
  '- Ask at most ONE question, and only when you genuinely need the answer.',
  '- Formatting: *bold*, _italic_, plain "-" bullets. No markdown headings, tables or code blocks.',
  '- Use your tools to act; never pretend you did something you did not do.',
  '- When a send_* tool already delivered the answer, do not add any extra text.',
  '- Never say "tap below" / mention buttons unless a send_* tool just sent them — your own replies are plain text.',
  '- Messages starting "[voice note, auto-transcribed]" were spoken: forgive small transcription slips (match "eye wash" to *eyewash*), reply in text as usual.',
  '- Off-topic asks: help in a line if you can, then steer back to what you can do.',
  '',
  // 🧭 Chatbot-maintained state: the LLM reads it, the code owns it.
  '## User state (live, from the database)',
  `- is_user_new: ${flags.isUserNew}  (true = hasn't added a first habit yet)`,
  ...(firstContact ? ['- first_contact: true → a one-line intro ("I\'m pekzho, your personal productivity AI assistant") was JUST sent; don\'t introduce yourself again.'] : []),
  ...skillStates,
  '',
  ...SKILLS.map((s) => s.prompt),
].join('\n');

// --------------------------------------------------------------------------
// 👋 The one-time welcome for brand-new users who open with a greeting.
// Deterministic (no LLM) so every new user gets the same crisp first impression.
// --------------------------------------------------------------------------
const GREETING = /^(?:hi+|hey+|hello+|helo|hii+|yo|hola|namaste|namaskar|good\s+(?:morning|afternoon|evening|night)|start|menu|help)[\s!.👋🙏]*$/i;

const sendWelcome = async (user: UserContext) => {
  const firstName = user.name?.split(/\s+/)[0];
  const examples = SKILLS.flatMap((s) => s.welcome?.examples ?? []);
  await user.sayText([
    `👋 Hi${firstName ? ` ${firstName}` : ''}! I'm *pekzho*, your personal productivity AI assistant. Try:`,
    ...examples.map((e) => `• ${e}`),
  ].join('\n'));
  const starter = SKILLS.find((s) => s.welcome?.starter)?.welcome?.starter;
  if (starter) await user.sayWithButtons(starter.text, starter.buttons);
};

// --------------------------------------------------------------------------
// 💾 Chat memory — pi AgentMessage[] (minus system messages) in `conversations`.
// --------------------------------------------------------------------------
const loadMemory = async (userId: string): Promise<AgentMessage[]> => {
  const { rows } = await db.query('SELECT messages FROM conversations WHERE user_id = $1', [userId]);
  return (rows[0]?.messages as AgentMessage[] | undefined) ?? [];
};

// ✂️ Keep only the newest MEMORY_MAX_MESSAGES, and always START at a user
// message — slicing mid tool-call/tool-result pair would confuse the model.
const trimMemory = (messages: AgentMessage[]): AgentMessage[] => {
  const convo = messages.filter((m) => m.role !== 'system');
  if (convo.length <= MEMORY_MAX_MESSAGES) return convo;
  let start = convo.length - MEMORY_MAX_MESSAGES;
  while (start < convo.length && convo[start].role !== 'user') start++;
  return convo.slice(start);
};

const saveMemory = async (userId: string, messages: AgentMessage[]) => {
  await db.query(
    `INSERT INTO conversations (user_id, messages, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (user_id) DO UPDATE SET messages = EXCLUDED.messages, updated_at = now()`,
    [userId, JSON.stringify(trimMemory(messages))]);
};

// 📝 Pull the plain text out of an assistant message (skipping thinking blocks).
const assistantText = (m: AgentMessage | undefined): string => {
  if (!m || m.role !== 'assistant') return '';
  return m.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('').trim();
};

// --------------------------------------------------------------------------
// 🧠 The LLM path.
// --------------------------------------------------------------------------
const runLlmTurn = async (turn: InboundTurn, user: UserContext, flags: UserFlags, firstContact: boolean) => {
  const memory = await loadMemory(user.userId);
  const skillStates = await Promise.all(SKILLS.map((s) => s.describeState?.(user) ?? Promise.resolve('')));
  const agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(user, flags, firstContact, skillStates.filter(Boolean)),
      model,
      thinkingLevel: 'low',              // 🏎️ snappy replies; bump for harder skills later
      tools: SKILLS.flatMap((s) => s.tools(user)),
      messages: memory,
    },
    streamFn: models.streamSimple.bind(models),
    sessionId: `wa:${user.userId}`,       // 🗂️ lets the provider reuse its prompt cache
    toolExecution: 'sequential',         // 📬 tools send WA messages — keep them in order
  });
  agent.subscribe((e) => {
    if (e.type === 'tool_execution_start') console.log(`🛠️  ${user.userId} → ${e.toolName} ${JSON.stringify(e.args)}`);
    if (e.type === 'tool_execution_end' && e.isError) console.warn(`🛠️  ${e.toolName} errored: ${JSON.stringify(e.result?.content).slice(0, 200)}`);
  });

  const timer = setTimeout(() => agent.abort(), TURN_TIMEOUT_MS);
  const started = Date.now();
  try {
    // 🎙️ flag spoken turns so the model forgives transcription slips ("eye wash" → eyewash)
    await agent.prompt(turn.viaVoice ? `[voice note, auto-transcribed] ${turn.text}` : turn.text);
  } finally {
    clearTimeout(timer);
  }

  const messages = agent.state.messages;
  const last = messages.at(-1);
  if (last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'aborted')) {
    // 💥 Don't save a broken turn into memory — it would poison every later turn.
    console.error(`🧠 LLM turn failed for ${user.userId}: ${last.stopReason} ${last.errorMessage ?? agent.state.errorMessage ?? ''}`);
    await user.sayText('😵 Sorry, my brain hiccuped. Please try again in a moment.');
    return;
  }

  // 💬 Ended on an assistant message → that's the reply. Ended on a tool result
  // → a terminating send_* tool already replied, so we stay quiet.
  const reply = assistantText(last);
  if (reply) await user.sayText(reply);
  await saveMemory(user.userId, messages);
  const usage = last?.role === 'assistant' ? last.usage : undefined;
  console.log(`🧠 turn done for ${user.userId} in ${Date.now() - started}ms tokens=${usage?.totalTokens ?? '?'}`);
};

// --------------------------------------------------------------------------
// 🚪 Front door — one turn in, replies out.
// --------------------------------------------------------------------------
// 🎙️ Voice note → text turn. Returns undefined (after telling the user) when we
// couldn't hear anything usable — the turn then simply ends.
const hearVoiceNote = async (turn: InboundTurn, user: UserContext): Promise<string | undefined> => {
  if (!transcriptionEnabled() || !turn.mediaId) {
    await user.sayText('🎙️ I can\'t listen to voice notes right now — please type it 🙏');
    return undefined;
  }
  try {
    const { data, mimeType } = await downloadMedia(turn.mediaId);
    const vocabulary = (await Promise.all(SKILLS.map((s) => s.vocabulary?.(user) ?? Promise.resolve([])))).flat();
    const heard = await transcribeAudio(data, turn.mimeType ?? mimeType, vocabulary);
    if (!heard) { await user.sayText("🙉 I couldn't make that out — try again, or type it."); return undefined; }
    return heard;
  } catch (e: any) {
    console.error(`🎙️ voice note from ${user.userId} failed: ${e.message}`);
    await user.sayText("🙉 Sorry, I couldn't process that voice note — please try again or type it.");
    return undefined;
  }
};

const handleTurn = async (incoming: InboundTurn, user: UserContext) => {
  // 🎙️ Voice notes become plain text turns FIRST, so everything below (welcome,
  // shortcuts, LLM) works exactly the same whether they typed or spoke.
  let turn = incoming;
  if (turn.kind === 'voice') {
    const heard = await hearVoiceNote(turn, user);
    if (heard === undefined) return;
    turn = { ...turn, kind: 'text', text: heard, viaVoice: true };
    console.log(`🎙️ ${user.userId} said: ${JSON.stringify(heard)}`);
  }

  // 🚩 Read the chatbot state first — it decides welcome vs normal flow.
  const flags = await getUserFlags(user.userId);
  const firstContact = flags.isUserNew && !flags.welcomed;

  // 👋 Brand-new user saying hi → the welcome card, nothing else.
  if (firstContact && turn.kind === 'text' && GREETING.test(turn.text.trim())) {
    await sendWelcome(user);
    await markWelcomed(user.userId);
    console.log(`👋 ${user.userId} welcomed (new user)`);
    return;
  }
  // 🏁 New user whose first message is a real ask ("I want to drink more water"):
  // code sends the one-line intro (deterministic — the LLM forgot it in testing),
  // then the turn carries on normally and actually answers them.
  if (firstContact) {
    const firstName = user.name?.split(/\s+/)[0];
    await user.sayText(`👋 Hi${firstName ? ` ${firstName}` : ''}! I'm *pekzho*, your personal productivity AI assistant.`);
    await markWelcomed(user.userId);
  }

  for (const skill of SKILLS) {
    if (skill.shortcut && (await skill.shortcut(turn, user))) {
      console.log(`⚡ ${user.userId} handled by ${skill.name} shortcut`);
      return;
    }
  }
  if (turn.kind === 'other') {
    await user.sayText(`🙈 I can only handle text and voice messages for now (got a ${turn.rawType}).`);
    return;
  }
  await runLlmTurn(turn, user, flags, firstContact);
};

// 🚦 One turn at a time PER USER — two quick messages must not race on the same
// memory row (the second would overwrite the first's saved transcript).
const userQueues = new Map<string, Promise<void>>();

export const pekzhoHandle = (turn: InboundTurn, user: UserContext): Promise<void> => {
  const previous = userQueues.get(user.userId) ?? Promise.resolve();
  const next = previous
    .then(() => handleTurn(turn, user))
    .catch(async (e) => {
      console.error(`💥 pekzho turn crashed for ${user.userId}:`, e);
      await user.sayText('😵 Something went wrong on my side. Please try again.').catch(() => {});
    });
  userQueues.set(user.userId, next);
  void next.finally(() => { if (userQueues.get(user.userId) === next) userQueues.delete(user.userId); });
  return next;
};
