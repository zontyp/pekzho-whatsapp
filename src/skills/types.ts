// ============================================================================
// 🧩 What a pekzho "skill" is. A skill is a self-contained bundle of abilities
// the user can use — habits today, more later. Each one can bring:
//   • prompt     → a section of the system prompt (teaches the LLM the skill)
//   • tools      → pi AgentTools the LLM may call (bound to the current user)
//   • shortcut   → a deterministic fast path that answers WITHOUT the LLM
//                  (button taps, exact commands, multi-step state) — instant + free
//   • everyMinute→ a scheduler hook for timed jobs (daily reminders etc.)
// Adding a skill = new folder in src/skills/ + one line in src/skills/index.ts. 🔌
// ============================================================================

import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { ReplyButton } from '../whatsapp.ts';

// 🧑 Who we're talking to right now + how to talk back to them. Skills never
// call the Graph API directly — they go through these, so a future Telegram /
// web channel only has to provide a different UserContext.
export interface UserContext {
  userId: string;                // the WhatsApp number the message came from (wa_id, e.g. "919820011185") = users.user_id
  name?: string;                 // WhatsApp profile name
  today: string;                 // YYYY-MM-DD in the user's timezone
  sayText: (text: string) => Promise<void>;
  sayWithButtons: (text: string, buttons: ReplyButton[]) => Promise<void>;
  // 📜 approved template — for business-initiated sends outside the 24h window
  sayTemplate: (name: string, language: string, bodyParams: string[], quickReplyPayloads?: string[]) => Promise<void>;
}

// 📨 One inbound message, already flattened from Meta's payload shape.
export interface InboundTurn {
  kind: 'text' | 'button' | 'voice' | 'other';
  text: string;                  // message text, the tapped button's title, or (after transcription) what was SAID
  buttonId?: string;             // set for kind === 'button', e.g. "done:42"
  mediaId?: string;              // set for kind === 'voice' — Meta media id of the voice note
  mimeType?: string;             // e.g. "audio/ogg; codecs=opus"
  viaVoice?: boolean;            // 🎙️ true once a voice note has been turned into this text turn
  rawType: string;               // Meta's original msg.type (image, audio, …)
}

export interface Skill {
  name: string;
  prompt: string;
  tools: (user: UserContext) => AgentTool<any>[];
  // ⚡ Return true if you fully handled the turn (the LLM is then skipped).
  shortcut?: (turn: InboundTurn, user: UserContext) => Promise<boolean>;
  // ⏲️ Called once a minute by the scheduler with the local HH:MM.
  everyMinute?: (localTime: string) => Promise<void>;
  // 👋 What this skill adds to the one-time welcome for brand-new users:
  // example commands (shown as bullets) + an optional one-tap starter button.
  welcome?: { examples: string[]; starter?: { text: string; buttons: ReplyButton[] } };
  // 🧭 This user's current state for this skill, injected into the system prompt
  // every LLM turn — so the model knows where the user is without a tool call.
  describeState?: (user: UserContext) => Promise<string>;
  // 🎙️ Words this user is likely to SAY (e.g. their habit names) — handed to the
  // transcriber as hints so "eyewash streak" isn't heard as "I watched streak".
  vocabulary?: (user: UserContext) => Promise<string[]>;
}
