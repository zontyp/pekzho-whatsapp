// ============================================================================
// 🎯 Habits skill — pekzho's first skill, a re-implementation of FlowTalkr's
// StreakSetGo workflow (refrences/FlowTalkr/src/main/resources/workflows/).
//
// FlowTalkr node            →  here
//   commandSwitch           →  habitShortcut()  (exact commands + button taps)
//   readIsAddingHabit/IF    →  the "adding_habit" state branch in habitShortcut()
//   writeHabitDone/Skipped  →  store.logHabit()   ← button ids "done:<id>" / "skip:<id>"
//   sendHabitsListActions   →  sendHabitChecklist()  (TG inline keyboard → WA reply buttons)
//   readHabitStats + WASM   →  store.habitLogs() + renderStatsCard()
//   daily_reminder cron     →  everyMinute() at HABIT_REMINDER_TIME
//   helpFlow (default)      →  falls through to the pekzho LLM, which has the
//                              same abilities as tools, so free-form chat works too 🧠
// ============================================================================

import { Type, type TSchema } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { db } from '../../db.ts';
import { addDays, localDate } from '../../clock.ts';
import { greetingName, userContextFor } from '../../pekzho/user-context.ts';
import { DRY_RUN, DRY_RUN_TEST_USER_PREFIX, templateStatus, uploadPng } from '../../whatsapp.ts';
import type { InboundTurn, Skill, UserContext } from '../types.ts';
import * as store from './store.ts';
import { habitNumbers, renderAllStatsCard, renderDaysCard, renderStatsCard } from './stats.ts';
import { buildLeaderboard, recapTeaser, renderWeeklyRecap } from './recap.ts';
import { buildShoutouts, shoutoutBlock, shoutoutLine } from './shoutouts.ts';
import { renderAllHabitsPng, renderHabitCalendarPng, renderHabitWeekStripPng, renderWeekGridPng } from './grid-image.ts';

const REMINDER_TIME = process.env.HABIT_REMINDER_TIME ?? '21:00';
const MAX_CHECKLIST_HABITS = 10; // 🧯 one WA message per habit — don't flood the chat

export const HELP_TEXT = [
  '🎯 *Habit tracker* — here is what I can do:',
  '',
  '• *add habit daily exercise* — add a habit (or just *add habit*)',
  '• *show habits* — your habits + today\'s status',
  '• *checklist* / *mark all* — tap ✅ / ❌ for each habit',
  '• *daily exercise streak* — calendar + streaks (also *stats* / *tracker*)',
  '• *streak all* — every habit in one message',
  '• *weekly recap* — your points, best habit + leaderboard rank',
  '',
  `Or just talk to me normally — "I ran today", "how am I doing on reading?" 💬`,
  `⏰ I'll nudge you at ${REMINDER_TIME} every evening — reply *STOP* to turn that off.`,
].join('\n');

// --------------------------------------------------------------------------
// 📋 The checklist: a header, then one message per habit with ✅ / ❌ buttons.
// --------------------------------------------------------------------------
export const sendHabitChecklist = async (user: UserContext, header?: string): Promise<string> => {
  const habits = await store.listHabits(user.userId);
  if (!habits.length) {
    await user.sayText('You have no habits yet 🌱 Try *add habit daily exercise* to start your first one 💪');
    return 'User has no habits; told them how to add one.';
  }
  const statuses = await store.todaysStatuses(user.userId, user.today);
  await user.sayText(header ?? 'Please mark (done / skipped) your habits for today 👇');
  const shown = habits.slice(0, MAX_CHECKLIST_HABITS);
  // 🎨 draw + upload every habit's pastel week strip IN PARALLEL (one by one took
  //    ~2.5s per habit), then send the bubbles in order. A strip that fails → plain bubble.
  const strips = await Promise.all(shown.map(async (h) => {
    try {
      const logs = await store.habitLogs(h.id);
      const png = renderHabitWeekStripPng(h.name, new Map(logs.map((l) => [l.date, l.status] as const)), user.today,
        logs.length ? habitNumbers(logs, user.today).currentStreak : 0);
      return await uploadPng(png);
    } catch (e: any) {
      console.error(`🎨 checklist strip for ${user.userId}/${h.id} failed, sending plain: ${e.message}`);
      return undefined;
    }
  }));
  for (const [i, h] of shown.entries()) {
    const s = statuses.get(h.id);
    const body = s === 'done' ? `✅ *${h.name}* — done today, nice! Tap to change.`
      : s === 'skipped' ? `❌ *${h.name}* — skipped today. Tap to change.`
      : `🎯 *${h.name}* — did you do it today?`;
    await user.sayWithButtons(body, [{ id: `done:${h.id}`, title: '✅ Done' }, { id: `skip:${h.id}`, title: '❌ Skip' }], strips[i]);
  }
  if (habits.length > MAX_CHECKLIST_HABITS) {
    await user.sayText(`…plus ${habits.length - MAX_CHECKLIST_HABITS} more — just tell me "done <habit>" for those.`);
  }
  return `Checklist with ${habits.length} habit(s) sent to the user.`;
};

// ✍️ Right after a habit's stats: one tap to mark it for today ("✅ Done eyewash").
// WhatsApp caps button titles at 20 chars, so long names get a "…".
const offerMarkToday = async (user: UserContext, habit: store.Habit) => {
  const status = (await store.todaysStatuses(user.userId, user.today)).get(habit.id);
  const title = (prefix: string) => {
    const room = 20 - prefix.length;
    return prefix + (habit.name.length > room ? habit.name.slice(0, room - 1).trimEnd() + '…' : habit.name);
  };
  const body = status
    ? `Today *${habit.name}* is ${status === 'done' ? '✅ done' : '❌ skipped'} — tap to change it 👇`
    : `Mark *${habit.name}* for today 👇`;
  await user.sayWithButtons(body, [
    { id: `done:${habit.id}`, title: title('✅ Done ') },
    { id: `skip:${habit.id}`, title: title('❌ Skip ') },
  ]);
};

const sendStats = async (user: UserContext, habitName: string): Promise<string> => {
  const habit = await store.findHabit(user.userId, habitName);
  if (!habit) {
    const names = (await store.listHabits(user.userId)).map((h) => h.name).join(', ');
    await user.sayText(`I couldn't find a habit called "${habitName}" 🤔${names ? `\nYour habits: ${names}` : ''}`);
    return 'Habit not found; told the user.';
  }
  const logs = await store.habitLogs(habit.id);
  // 🎨 pastel calendar picture first; the emoji card is the fallback (and the
  //    only option before the first mark — an empty calendar isn't worth a picture)
  if (logs.length) {
    try {
      const n = habitNumbers(logs, user.today);
      await user.sayImage(
        renderHabitCalendarPng(habit.name, new Map(logs.map((l) => [l.date, l.status])), logs[0].date, user.today, n),
        `📊 *${habit.name}* — ${n.currentStreak ? `🔥 ${n.currentStreak}-day streak, keep it going!` : 'mark it today to start a new streak 💪'}`,
      );
      await offerMarkToday(user, habit);
      return `Stats picture for "${habit.name}" + Done/Skip buttons for today sent to the user.`;
    } catch (e: any) {
      console.error(`🎨 stats image for ${user.userId} failed, falling back to emoji: ${e.message}`);
    }
  }
  await user.sayText(renderStatsCard(habit.name, logs, user.today));
  await offerMarkToday(user, habit);
  return `Stats card for "${habit.name}" + Done/Skip buttons for today sent to the user.`;
};

// 📊📊 "stats all" / "streak all habits" / bare "streak" → ONE consolidated
// message with every habit (compact 2-week grid each). ~150 chars per habit,
// so 20 habits stay well under WhatsApp's 4096-char cap.
const MAX_HABITS_IN_ALL_STATS = 20;
const sendAllStats = async (user: UserContext): Promise<string> => {
  const habits = await store.listHabits(user.userId);
  if (!habits.length) {
    await user.sayText('You have no habits yet 🌱 Try *add habit daily exercise* to start your first one 💪');
    return 'User has no habits; told them how to add one.';
  }
  const shown = habits.slice(0, MAX_HABITS_IN_ALL_STATS);
  const withLogs = await Promise.all(shown.map(async (h) => ({ name: h.name, logs: await store.habitLogs(h.id) })));
  // 🎨 the 2-week pastel picture; emoji card if drawing/uploading fails
  try {
    const rows = withLogs.map(({ name, logs }) => ({
      name,
      byDate: new Map(logs.map((l) => [l.date, l.status] as const)),
      currentStreak: logs.length ? habitNumbers(logs, user.today).currentStreak : 0,
    }));
    const best = [...rows].sort((a, b) => b.currentStreak - a.currentStreak)[0];
    await user.sayImage(
      renderAllHabitsPng(rows, user.today),
      best?.currentStreak ? `📊 All habits — best current streak: *${best.name}* 🔥 ${best.currentStreak} day${best.currentStreak === 1 ? '' : 's'}` : '📊 All habits — mark one today to start a streak 💪',
    );
    return `One consolidated stats picture for ${shown.length} habit(s) sent to the user.`;
  } catch (e: any) {
    console.error(`🎨 all-stats image for ${user.userId} failed, falling back to emoji: ${e.message}`);
  }
  let card = renderAllStatsCard(withLogs, user.today);
  if (habits.length > shown.length) card += `\n\n…plus ${habits.length - shown.length} more — send *stats <habit>* for those.`;
  await user.sayText(card);
  return `One consolidated stats message for ${shown.length} habit(s) sent to the user.`;
};

// 🏅 The weekly recap card (points, best/weakest habit, rank) + two next-step buttons.
export const sendWeeklyRecap = async (user: UserContext): Promise<string> => {
  const board = await buildLeaderboard(user.today);
  const me = board.users.find((u) => u.userId === user.userId);
  if (!me) {
    await user.sayText('You have no habits yet 🌱 Add one and you\'ll be on next week\'s leaderboard — try *add habit daily exercise* 💪');
    return 'User has no habits; told them how to add one.';
  }
  // 🎨 the pastel grid picture first; if drawing/uploading it fails, the text
  //    card carries the emoji grid instead, so the recap always arrives whole
  let sentPicture = false;
  try {
    await user.sayImage(renderWeekGridPng(me.habits, board.today));
    sentPicture = true;
  } catch (e: any) {
    console.error(`🎨 grid image for ${user.userId} failed, falling back to emoji: ${e.message}`);
  }
  await user.sayText(renderWeeklyRecap(me, board, !sentPicture));
  await user.sayWithButtons('Keep the momentum going 👇', [
    { id: PAYLOAD_CHECKLIST, title: "✅ Mark today" },
    { id: 'addhabit', title: '➕ Add a habit' },
  ]);
  return `Weekly recap sent: ${me.points} points, rank #${me.rank} of ${board.users.length}.`;
};
const RECAP_COMMANDS = new Set([
  'recap', 'weekly recap', 'week recap', 'my recap', 'weekly report', 'weekly summary', 'my week',
  'leaderboard', 'rank', 'my rank', 'points', 'my points', 'score card', 'scorecard',
]);

// 🌐 "all", "all habits", "every habit", "everything" → the consolidated card.
// Checked BEFORE habit-name matching, so "all" never fuzzy-matches "Football".
const ALL_HABITS_WORDS = /^(?:all|all habits?|every habit|each habit|everything|habits)$/i;

// 🗣️ Every word that means "show me how I'm doing" — stats, streak, tracker &
// friends all open the SAME stats card. ("track" is deliberately NOT here:
// "track reading" means "add a habit", not "show stats".)
const STATS_WORDS = new Set([
  'stats', 'stat', 'statistics', 'streak', 'streaks', 'tracker', 'trackers',
  'progress', 'report', 'history', 'calendar', 'performance', 'score', 'record',
]);
// 🧹 Polite padding we peel off the front: "show me my streak for eyewash"
const LEADING_FILLER = /^(?:(?:please|show|see|view|get|check|give|me|my|the|of|for|on|about)\s+)+/i;

// 🔎 "stats eyewash" · "streak for eyewash" · "my eyewash tracker" · "streak" →
// { habit: 'eyewash' } or { habit: '' } (= all habits). Undefined when there's
// no stats word at either end, so normal chat isn't hijacked.
const parseStatsCommand = (text: string): { habit: string } | undefined => {
  const peel = (s: string) => s.replace(LEADING_FILLER, '').trim();
  const isStatsWord = (w = '') => STATS_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, ''));
  const words = peel(text).split(/\s+/).filter(Boolean);
  if (!words.length) return undefined;
  if (isStatsWord(words[0])) return { habit: peel(words.slice(1).join(' ')) };            // stats-word first
  if (isStatsWord(words.at(-1))) return { habit: peel(words.slice(0, -1).join(' ')) };    // stats-word last
  return undefined;
};

// --------------------------------------------------------------------------
// ⚡ Shortcut — FlowTalkr's commandSwitch. Instant, deterministic, no LLM cost.
// --------------------------------------------------------------------------
// 📋 "Show me my habits" → ONE plain message with today's status, no buttons.
const LIST_COMMANDS = new Set([
  'listhabits', 'list habits', 'list', 'show habits', 'show my habits', 'my habits', 'habits',
  'today', "today's habits", 'todays habits', 'status', "today's status",
]);
// ✅ "Let me mark them" → the tappable checklist (one message per habit, ✅ / ❌).
const CHECKLIST_COMMANDS = new Set([
  'checklist', 'show checklist', 'mark all', 'mark habits', 'mark all habits',
  'mark today', "mark today's habits", 'mark todays habits', 'mark',
]);

// 📋 The plain habit list: one message, today's status per habit, a hint at the end.
const sendHabitList = async (user: UserContext): Promise<string> => {
  const habits = await store.listHabits(user.userId);
  if (!habits.length) {
    await user.sayText('You have no habits yet 🌱 Try *add habit daily exercise* to start your first one 💪');
    return 'User has no habits; told them how to add one.';
  }
  const statuses = await store.todaysStatuses(user.userId, user.today);
  const icon = (id: number) => (statuses.get(id) === 'done' ? '✅' : statuses.get(id) === 'skipped' ? '❌' : '⬜');
  const done = habits.filter((h) => statuses.get(h.id) === 'done').length;
  const unmarked = habits.filter((h) => !statuses.has(h.id)).length;
  await user.sayText([
    '📋 *Your habits — today*',
    ...habits.map((h) => `${icon(h.id)} ${h.name}`),
    '',
    `${done}/${habits.length} done` + (unmarked ? ` · say *checklist* to mark the rest` : ' · all marked 🎉'),
  ].join('\n'));
  return `Habit list (${habits.length} habits, ${done} done, ${unmarked} unmarked) sent to the user.`;
};

const askForHabitName = async (user: UserContext) => {
  await store.setAddingHabit(user.userId, true);
  await user.sayText("✍️ Type the habit name — e.g. _Daily Exercise_, _Read 10 pages_, _Sleep by 11_\n(or *cancel*)");
};

// 🎉 Add the habit, then offer today's verdict right away — one tap from
// "new habit" to "first ✅" keeps momentum (and gets new users to their first win).
const addHabitAndOfferToday = async (user: UserContext, rawName: string) => {
  try {
    const habit = await store.addHabit(user.userId, rawName);
    await user.sayWithButtons(`🎉 *${habit.name}* added! Did you do it today?`, [
      { id: `done:${habit.id}`, title: '✅ Done today' },
      { id: `skip:${habit.id}`, title: '❌ Skip today' },
    ]);
  } catch (e) {
    if (!(e instanceof store.HabitError)) throw e;
    await user.sayText(`⚠️ ${e.message}`);
  }
};

const habitShortcut = async (turn: InboundTurn, user: UserContext): Promise<boolean> => {
  // 🌱 Starter buttons from the new-user welcome: "add:<name>" / "addhabit"
  if (turn.buttonId?.startsWith('add:')) { await addHabitAndOfferToday(user, turn.buttonId.slice(4)); return true; }
  if (turn.buttonId === 'addhabit') { await askForHabitName(user); return true; }

  // 📜 Taps on the reminder TEMPLATE's quick replies (the tap re-opened the 24h window)
  if (turn.buttonId === PAYLOAD_CHECKLIST) { await sendHabitChecklist(user); return true; }
  if (turn.buttonId === PAYLOAD_STREAKS) { await sendAllStats(user); return true; }
  if (turn.buttonId === PAYLOAD_RECAP) { await sendWeeklyRecap(user); return true; }

  // 🔘 Button taps from the checklist: "done:<id>" / "skip:<id>"
  const tap = turn.buttonId?.match(/^(done|skip):(\d+)$/);
  if (tap) {
    const status = tap[1] === 'done' ? 'done' : 'skipped';
    try {
      const habit = await store.logHabit(user.userId, Number(tap[2]), user.today, status);
      await user.sayText(status === 'done' ? `✅ *${habit.name}* — done for today. Nice! 🔥` : `❌ *${habit.name}* — skipped for today.`);
    } catch (e) {
      if (!(e instanceof store.HabitError)) throw e;
      await user.sayText(`⚠️ ${e.message}`);
    }
    return true;
  }
  if (turn.kind !== 'text') return false;

  // FlowTalkr stripped a leading "/" so Telegram-style commands still work.
  // …and drops trailing punctuation, which voice transcripts love ("Show habits.").
  const text = turn.text.trim().replace(/^\//, '').replace(/[.!?।]+$/, '').trim();
  const command = text.toLowerCase().replace(/\s+/g, ' ');

  // ✍️ Mid-"addhabit": the next message IS the habit name (writeInsertHabit).
  if (await store.isAddingHabit(user.userId)) {
    await store.setAddingHabit(user.userId, false);
    if (command === 'cancel') { await user.sayText('👍 Cancelled — no habit added.'); return true; }
    await addHabitAndOfferToday(user, text);
    return true;
  }

  // 🔕 STOP / START reminders. Plain "start" re-subscribes only if they'd opted out
  // (otherwise "start" keeps meaning help, as before).
  if (STOP_COMMANDS.has(command)) {
    await setReminders(user, false);
    await user.sayText(`🔕 Reminders off — I won't message you first anymore. Your habits are still here; send *start reminders* to turn them back on.`);
    return true;
  }
  if (START_COMMANDS.has(command) || (command === 'start' && (await remindersAreOff(user.userId)))) {
    await setReminders(user, true);
    await user.sayText(`🔔 Reminders on — I'll check in at ${REMINDER_TIME} every evening.`);
    return true;
  }

  if (command === 'addhabit' || command === 'add habit') {
    await askForHabitName(user);
    return true;
  }
  // ➕ "add habit daily exercise" / "addhabit Daily Exercise" — one-shot add.
  // Lists ("add habit lunch, dinner") go to the LLM, which splits them properly.
  const oneShotAdd = text.match(/^(?:add\s*habit)\s+(.+)$/i);
  if (oneShotAdd && !/,|\band\b|&/i.test(oneShotAdd[1])) {
    await addHabitAndOfferToday(user, oneShotAdd[1]);
    return true;
  }
  if (LIST_COMMANDS.has(command)) {
    await sendHabitList(user);
    return true;
  }
  if (CHECKLIST_COMMANDS.has(command)) {
    await sendHabitChecklist(user);
    return true;
  }
  if (RECAP_COMMANDS.has(command)) {
    await sendWeeklyRecap(user);
    return true;
  }
  // 📊 stats / streak / tracker (+ synonyms) → the same stats card.
  const statsAsk = parseStatsCommand(text);
  if (statsAsk) {
    if (!statsAsk.habit || ALL_HABITS_WORDS.test(statsAsk.habit)) { await sendAllStats(user); return true; }
    // Only claim it when the habit really exists — "progress was slow today…"
    // should go to the LLM, not get a "habit not found" reply.
    if (await store.findHabit(user.userId, statsAsk.habit)) { await sendStats(user, statsAsk.habit); return true; }
  }
  if (command === 'help' || command === 'menu' || command === 'start') {
    await user.sayText(HELP_TEXT);
    return true;
  }
  return false; // 🧠 not a command → let the LLM handle it
};

// --------------------------------------------------------------------------
// 🛠️ LLM tools — same abilities, for free-form chat ("I meditated yesterday").
// --------------------------------------------------------------------------
// 🏷️ Keeps each tool's params typed from its own schema (an AgentTool<any>[]
// literal would otherwise widen every `p` to unknown).
const defineTool = <T extends TSchema>(tool: AgentTool<T>): AgentTool<any> => tool;

const text = (t: string, terminate = false) => ({ content: [{ type: 'text' as const, text: t }], details: {}, terminate });

const resolveHabitOrThrow = async (user: UserContext, habit: string) => {
  const found = await store.findHabit(user.userId, habit);
  if (!found) {
    const names = (await store.listHabits(user.userId)).map((h) => `${h.id}: ${h.name}`).join('; ');
    throw new Error(`No habit matches "${habit}". User's habits: ${names || 'none'}`);
  }
  return found;
};

const habitTools = (user: UserContext): AgentTool<any>[] => [
  defineTool({
    name: 'list_habits',
    label: 'List habits',
    description: "List the user's habits with ids and today's status. Read-only; use it to look things up before acting.",
    parameters: Type.Object({}),
    execute: async () => {
      const habits = await store.listHabits(user.userId);
      const statuses = await store.todaysStatuses(user.userId, user.today);
      if (!habits.length) return text('The user has no habits yet.');
      return text(habits.map((h) => `${h.id}: ${h.name} — today: ${statuses.get(h.id) ?? 'not marked'}`).join('\n'));
    },
  }),
  defineTool({
    name: 'add_habit',
    label: 'Add habit',
    description: 'Create a new habit for the user to track daily.',
    parameters: Type.Object({ name: Type.String({ description: "Short habit name, e.g. 'Daily Run'" }) }),
    execute: async (_id, p) => {
      const habit = await store.addHabit(user.userId, p.name);
      return text(`Added habit ${habit.id}: ${habit.name}`);
    },
  }),
  defineTool({
    name: 'mark_habit',
    label: 'Mark habit',
    description: 'Mark a habit as done or skipped for a day (default today). Re-marking overwrites. Only today or the previous 7 days are allowed.',
    parameters: Type.Object({
      habit: Type.String({ description: 'Habit name or id' }),
      status: Type.Union([Type.Literal('done'), Type.Literal('skipped')]),
      date: Type.Optional(Type.String({ description: 'YYYY-MM-DD in the user timezone; omit for today' })),
    }),
    execute: async (_id, p) => {
      const date = p.date ?? user.today;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > user.today || date < addDays(user.today, -7)) {
        throw new Error(`Date must be between ${addDays(user.today, -7)} and ${user.today}.`);
      }
      const habit = await resolveHabitOrThrow(user, p.habit);
      await store.logHabit(user.userId, habit.id, date, p.status);
      return text(`Marked "${habit.name}" as ${p.status} on ${date}.`);
    },
  }),
  defineTool({
    name: 'delete_habit',
    label: 'Delete habit',
    description: 'Permanently delete a habit and its history. Only when the user clearly asks to remove it.',
    parameters: Type.Object({ habit: Type.String({ description: 'Habit name or id' }) }),
    execute: async (_id, p) => {
      const habit = await resolveHabitOrThrow(user, p.habit);
      await store.deleteHabit(user.userId, habit.id);
      return text(`Deleted habit "${habit.name}".`);
    },
  }),
  defineTool({
    name: 'set_reminders',
    label: 'Reminders on/off',
    description: `Turn the daily ${REMINDER_TIME} habit reminder on or off for this user ("stop reminding me", "remind me again").`,
    parameters: Type.Object({ on: Type.Boolean() }),
    execute: async (_id, p) => {
      await setReminders(user, p.on);
      return text(p.on ? 'Reminders turned ON.' : 'Reminders turned OFF (user can say "start reminders" to resume).');
    },
  }),
  defineTool({
    name: 'send_habit_list',
    label: 'Send habit list',
    description: "Send ONE plain message listing the user's habits with today's status (✅ / ❌ / ⬜), no buttons. Use for 'show/list my habits', 'what are my habits', 'what's left today'. Goes straight to the user — don't repeat it.",
    parameters: Type.Object({}),
    execute: async () => text(await sendHabitList(user), true),
  }),
  defineTool({
    name: 'send_habit_checklist',
    label: 'Send checklist',
    description: "Send the tappable checklist (one message per habit with ✅ Done / ❌ Skip buttons). ONLY when the user wants to mark/tick habits via buttons ('checklist', 'mark all', 'let me mark them') — for just viewing habits use send_habit_list. Goes straight to the user — don't repeat it.",
    parameters: Type.Object({}),
    // 🛑 terminate: the checklist IS the reply, no extra LLM chatter after it.
    execute: async () => text(await sendHabitChecklist(user), true),
  }),
  defineTool({
    name: 'send_habit_days',
    label: 'Send days',
    description: 'Send the habit squares for SPECIFIC day(s): "stats/status/streak/tracker for 4th October", "for 4th and 5th Oct", "yesterday", "last Monday". One 🟩 done / 🟥 skipped / ⬜ no entry square per habit per day. Resolve the dates yourself from today\'s date. Goes straight to the user — don\'t repeat it.',
    parameters: Type.Object({
      dates: Type.Array(Type.String({ description: 'YYYY-MM-DD in the user timezone' }), { minItems: 1, maxItems: 31 }),
      habit: Type.Optional(Type.String({ description: 'Habit name or id; omit for all habits' })),
    }),
    execute: async (_id, p) => {
      // 🧹 valid, unique, sorted, and not in the future
      const dates = [...new Set(p.dates.filter((d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= user.today))].sort();
      if (!dates.length) throw new Error(`No valid past dates given (today is ${user.today}).`);
      let habits = await store.listHabits(user.userId);
      if (p.habit && !ALL_HABITS_WORDS.test(p.habit.trim())) habits = [await resolveHabitOrThrow(user, p.habit)];
      if (!habits.length) { await user.sayText('You have no habits yet 🌱 Send *add habit <name>* to start.'); return text('User has no habits.', true); }
      const logs = await store.logsOnDates(user.userId, dates);
      const card = renderDaysCard(habits.map((h) => ({ name: h.name, byDate: new Map(logs.filter((l) => l.habitId === h.id).map((l) => [l.date, l.status])) })), dates);
      await user.sayText(card);
      return text(`Day squares for ${dates.join(', ')} sent to the user.`, true);
    },
  }),
  defineTool({
    name: 'send_habit_stats',
    label: 'Send stats',
    description: 'Send the stats card (emoji calendar, done/skipped counts, current + best streak). Use for ANY ask about stats, streak, tracker, progress, history, report, consistency or "how am I doing". Omit habit (or pass "all") to send ONE consolidated message covering all habits. Goes straight to the user — don\'t repeat it.',
    parameters: Type.Object({ habit: Type.Optional(Type.String({ description: 'Habit name or id; omit for all habits' })) }),
    execute: async (_id, p) => text(p.habit && !ALL_HABITS_WORDS.test(p.habit.trim()) ? await sendStats(user, p.habit) : await sendAllStats(user), true),
  }),
  defineTool({
    name: 'send_weekly_recap',
    label: 'Send weekly recap',
    description: "Send the weekly recap card: last 7 days' marks, points (done 2, skip 1, +1 per done in a streak), longest streak, best + weakest habit, leaderboard rank and who's ahead. Use for 'recap', 'my week', 'points', 'rank', 'leaderboard', 'how did my week go'. Goes straight to the user — don't repeat it.",
    parameters: Type.Object({}),
    execute: async () => text(await sendWeeklyRecap(user), true),
  }),
];

// --------------------------------------------------------------------------
// ⏰ Daily reminder — FlowTalkr's "daily_reminder" cron trigger.
// WhatsApp only lets us send free-form messages within 24h of the user's last
// message; outside that window we'd need an approved template (not set up yet),
// so those users are skipped and logged.
// --------------------------------------------------------------------------
// 📜 The Meta-approved template for users OUTSIDE the 24h window (submitted
// 2026-10-03, id 28225925883774643). {{1}} = first name, {{2}} = habit list;
// its two quick replies carry the payloads below back to habitShortcut().
const REMINDER_TEMPLATE      = process.env.HABIT_REMINDER_TEMPLATE ?? 'habit_checklist_reminder';
const REMINDER_TEMPLATE_LANG = process.env.HABIT_REMINDER_TEMPLATE_LANG ?? 'en';
// 📣 The shoutout flavour of the same reminder ({{1}} name, {{2}} yesterday's
// winners / comebacks / warming-up line, {{3}} habit list; same two buttons).
// Used once Meta approves it — until then the plain template above keeps going out.
const SHOUTOUT_TEMPLATE = process.env.HABIT_SHOUTOUT_TEMPLATE ?? 'habit_daily_shoutout';
const PAYLOAD_CHECKLIST = 'habits:checklist';   // "Mark today's habits"
const PAYLOAD_STREAKS   = 'habits:streaks';     // "Show my streaks"
const PAYLOAD_RECAP     = 'habits:recap';       // weekly recap template's "See my recap"

// ✂️ {{2}} must be one line and not huge: "Daily Exercise, Read 10 pages, +3 more"
// 🙌 Marked anything for today within this many hours before the reminder? Then
// skip them — at 21:00 that means "since about noon".
const SKIP_IF_MARKED_WITHIN_HOURS = Number(process.env.HABIT_REMINDER_SKIP_IF_MARKED_HOURS ?? 9);

// 📣 The free-form reminder's opening line. The default works any day; the operator
// can swap in a special one from .env (no code change), e.g. a Thursday pep talk:
//   HABIT_REMINDER_HEADER="Hey {name}, Thursday EOD…"   ({name} → greetingName, or "there")
//   HABIT_REMINDER_HEADER_ON=2026-10-08                  (optional: ONLY that local date —
//                                                         so "Thursday" never goes out on a Friday)
// Only the free-form checklist uses it — the template's wording is locked by Meta's approval.
const DEFAULT_REMINDER_HEADER = '⏰ Evening check-in! How did your habits go today? 👇';
const STOP_FOOTER = '_(reply STOP to turn off reminders)_';
const reminderHeaderFor = (displayName: string | null | undefined, today: string): string => {
  const custom = process.env.HABIT_REMINDER_HEADER?.trim();
  const onlyOn = process.env.HABIT_REMINDER_HEADER_ON?.trim();
  const useCustom = custom && (!onlyOn || onlyOn === today);
  const header = useCustom ? custom.replaceAll('{name}', greetingName(displayName) ?? 'there') : DEFAULT_REMINDER_HEADER;
  return `${header}\n${STOP_FOOTER}`;
};

const habitListParam = (names: string[], maxChars = 180): string => {
  const shown: string[] = [];
  for (const n of names) {
    if ([...shown, n].join(', ').length > maxChars) break;
    shown.push(n);
  }
  const rest = names.length - shown.length;
  return shown.join(', ') + (rest ? `, +${rest} more` : '');
};

const sendDailyReminders = async () => {
  const today = localDate();
  const { rows } = await db.query(
    `SELECT u.user_id, u.display_name, u.template_reminder_blocked,
            (u.last_inbound_at > now() - interval '23 hours 50 minutes') AS in_window,
            -- 🙌 already marked something for TODAY in the last few hours → no nudge needed
            EXISTS (SELECT 1 FROM habit_logs l JOIN habits h ON h.id = l.habit_id
                     WHERE h.user_id = u.user_id AND l.log_date = $1
                       AND l.created_at > now() - make_interval(hours => $3)) AS marked_recently
     FROM users u
     WHERE EXISTS (SELECT 1 FROM habits h WHERE h.user_id = u.user_id)
       AND NOT u.reminders_opt_out
       AND (u.last_reminded_on IS NULL OR u.last_reminded_on < $1)
       AND ($2::text IS NULL OR u.user_id LIKE $2 || '%')`, [today, DRY_RUN ? DRY_RUN_TEST_USER_PREFIX : null, SKIP_IF_MARKED_WITHIN_HOURS]);
  if (!rows.length) { console.log('⏰ daily habit reminders: nobody due'); return; }

  // 💸 Outside the window = a PAID template (~₹1). Since 2026-10-16 it goes to
  // EVERYONE who hasn't said STOP (the query above already drops opted-out
  // users) — the old per-user hand switch (users.template_reminder_on) flipped
  // itself off on every reply, so exactly the most engaged users lost their
  // reminder the first evening they forgot to mark. The column stays, unused.
  const wantsTemplate = (r: any) => !r.in_window && !r.template_reminder_blocked && !r.marked_recently;

  // ✅ Ask Meta once per run whether the template is usable yet (PENDING → skip).
  //    Shoutout template preferred; the plain one is the fallback while it's pending.
  let templateReady = false, shoutoutReady = false;
  if (rows.some(wantsTemplate)) {
    try {
      const status = await templateStatus(SHOUTOUT_TEMPLATE, REMINDER_TEMPLATE_LANG);
      shoutoutReady = status === 'APPROVED';
      if (!shoutoutReady) console.warn(`⏰ template ${SHOUTOUT_TEMPLATE} is ${status} — using ${REMINDER_TEMPLATE}`);
    } catch (e: any) {
      console.error(`⏰ shoutout template status check failed: ${e.message}`);
    }
    if (!shoutoutReady) try {
      const status = await templateStatus(REMINDER_TEMPLATE, REMINDER_TEMPLATE_LANG);
      templateReady = status === 'APPROVED';
      if (!templateReady) console.warn(`⏰ template ${REMINDER_TEMPLATE} is ${status} — out-of-window users skipped this run`);
    } catch (e: any) {
      console.error(`⏰ template status check failed: ${e.message}`);
    }
    templateReady ||= shoutoutReady;
  }

  // 📣 Yesterday's winners / comebacks / warming-up — built ONCE, same for everyone tonight
  let shoutouts: Awaited<ReturnType<typeof buildShoutouts>> | undefined;
  try {
    shoutouts = await buildShoutouts(today);
    console.log(`📣 shoutouts for ${shoutouts.day}: ${shoutoutLine(shoutouts)} (warming-up total ${shoutouts.warmingUpTotal})`);
  } catch (e: any) {
    console.error(`📣 shoutouts failed, reminders go out without them: ${e.message}`);
  }

  let freeForm = 0, viaTemplate = 0, skipped = 0, blocked = 0, alreadyMarked = 0, failed = 0;
  for (const r of rows) {
    if (r.marked_recently) { alreadyMarked++; continue; } // 🙌 they're on it today — don't nag (or pay for a template)
    if (!r.in_window && r.template_reminder_blocked) { blocked++; continue; } // 🚫 operator blocked the paid template for this user
    if (!r.in_window && !templateReady) { skipped++; continue; } // 💤 retry tomorrow, don't stamp
    // 📝 stamp first, so a crash mid-loop can't double-remind anyone
    await db.query('UPDATE users SET last_reminded_on = $2 WHERE user_id = $1', [r.user_id, today]);
    const user = userContextFor(r.user_id, r.display_name);
    try {
      if (r.in_window) {
        // 🟢 inside 24h → the full tappable checklist, free-form
        const block = shoutouts && shoutoutBlock(shoutouts);
        await sendHabitChecklist(user, (block ? `${block}\n\n` : '') + reminderHeaderFor(r.display_name, today));
        freeForm++;
      } else {
        // 📜 outside 24h → the template; a tap on it re-opens the window
        const names = (await store.listHabits(r.user_id)).map((h) => h.name);
        const firstName = greetingName(r.display_name) ?? 'there';
        if (shoutoutReady && shoutouts) {
          await user.sayTemplate(SHOUTOUT_TEMPLATE, REMINDER_TEMPLATE_LANG, [firstName, shoutoutLine(shoutouts), habitListParam(names)], [PAYLOAD_CHECKLIST, PAYLOAD_STREAKS]);
        } else {
          await user.sayTemplate(REMINDER_TEMPLATE, REMINDER_TEMPLATE_LANG, [firstName, habitListParam(names)], [PAYLOAD_CHECKLIST, PAYLOAD_STREAKS]);
        }
        viaTemplate++;
      }
    } catch (e: any) {
      failed++;
      console.error(`⏰ reminder to ${r.user_id} failed: ${e.message}`);
    }
  }
  console.log(`⏰ daily habit reminders: free_form=${freeForm} template=${viaTemplate} skipped_template_not_ready=${skipped} skipped_template_blocked=${blocked} skipped_already_marked=${alreadyMarked} failed=${failed}`);
};

// --------------------------------------------------------------------------
// 🏅 Weekly recap — Sundays at HABIT_RECAP_TIME. Same money rule as the reminder:
// inside the 24h window the full card goes out FREE; outside it, the paid
// `weekly_habit_recap` template ({{1}} name, {{2}} teaser) whose "See my recap"
// tap re-opens the window and pulls the full card. STOP and the per-user
// template block both apply.
// --------------------------------------------------------------------------
const RECAP_TIME          = process.env.HABIT_RECAP_TIME ?? '16:00';
const RECAP_WEEKDAY       = Number(process.env.HABIT_RECAP_WEEKDAY ?? 0);   // 0 = Sunday
const RECAP_TEMPLATE      = process.env.HABIT_RECAP_TEMPLATE ?? 'weekly_habit_recap';
const RECAP_TEMPLATE_LANG = process.env.HABIT_RECAP_TEMPLATE_LANG ?? 'en';

const isRecapDay = (date: string) => new Date(date + 'T00:00:00Z').getUTCDay() === RECAP_WEEKDAY;

const sendWeeklyRecaps = async () => {
  const today = localDate();
  const board = await buildLeaderboard(today);
  const { rows } = await db.query(
    `SELECT u.user_id, u.display_name, u.template_reminder_blocked,
            (u.last_inbound_at > now() - interval '23 hours 50 minutes') AS in_window
       FROM users u
      WHERE EXISTS (SELECT 1 FROM habits h WHERE h.user_id = u.user_id)
        AND NOT u.reminders_opt_out
        AND (u.last_recap_on IS NULL OR u.last_recap_on < $1)
        AND ($2::text IS NULL OR u.user_id LIKE $2 || '%')`, [today, DRY_RUN ? DRY_RUN_TEST_USER_PREFIX : null]);
  if (!rows.length) { console.log('🏅 weekly recaps: nobody due'); return; }

  let templateReady = false;
  if (rows.some((r: any) => !r.in_window && !r.template_reminder_blocked)) {
    try {
      const status = await templateStatus(RECAP_TEMPLATE, RECAP_TEMPLATE_LANG);
      templateReady = status === 'APPROVED';
      if (!templateReady) console.warn(`🏅 template ${RECAP_TEMPLATE} is ${status} — out-of-window users skipped this week`);
    } catch (e: any) {
      console.error(`🏅 recap template status check failed: ${e.message}`);
    }
  }

  let freeForm = 0, viaTemplate = 0, notReady = 0, blocked = 0, failed = 0;
  for (const r of rows) {
    const me = board.users.find((u) => u.userId === r.user_id);
    if (!me) continue; // 🧪 not on this board (test/real split)
    if (!r.in_window && r.template_reminder_blocked) { blocked++; continue; }
    if (!r.in_window && !templateReady) { notReady++; continue; }
    await db.query('UPDATE users SET last_recap_on = $2 WHERE user_id = $1', [r.user_id, today]); // 📝 stamp first — never twice
    const user = userContextFor(r.user_id, r.display_name);
    try {
      if (r.in_window) {
        await sendWeeklyRecap(user);
        freeForm++;
      } else {
        await user.sayTemplate(RECAP_TEMPLATE, RECAP_TEMPLATE_LANG, [me.name, recapTeaser(me, board)], [PAYLOAD_RECAP, PAYLOAD_CHECKLIST]);
        viaTemplate++;
      }
    } catch (e: any) {
      failed++;
      console.error(`🏅 recap to ${r.user_id} failed: ${e.message}`);
    }
  }
  console.log(`🏅 weekly recaps: free_form=${freeForm} template=${viaTemplate} skipped_template_not_ready=${notReady} skipped_template_blocked=${blocked} failed=${failed}`);
};

// 🔕 STOP / START for reminders (Meta requires an opt-out for business-initiated messages)
const setReminders = async (user: UserContext, on: boolean) => {
  await db.query('UPDATE users SET reminders_opt_out = $2 WHERE user_id = $1', [user.userId, !on]);
};
const remindersAreOff = async (userId: string): Promise<boolean> => {
  const { rows } = await db.query('SELECT reminders_opt_out FROM users WHERE user_id = $1', [userId]);
  return rows[0]?.reminders_opt_out === true;
};
const STOP_COMMANDS  = new Set(['stop', 'stop reminders', 'unsubscribe', 'no reminders', 'reminders off', 'turn off reminders']);
const START_COMMANDS = new Set(['start reminders', 'resume reminders', 'reminders on', 'turn on reminders', 'subscribe']);

// 🧭 What the LLM should know about this user's habits RIGHT NOW (injected into
// the system prompt each turn) — saves a list_habits round-trip on most turns.
const describeHabitState = async (user: UserContext): Promise<string> => {
  const habits = await store.listHabits(user.userId);
  if (!habits.length) return '- habits: none yet';
  const statuses = await store.todaysStatuses(user.userId, user.today);
  // 📅 Stamp the real date: the model once read "marked ✅ for today" from LAST
  // NIGHT's chat as today and told the user "already done" without marking. 🙈
  const lines = habits.map((h) => `  - ${h.id}: ${h.name} — ${user.today}: ${statuses.get(h.id) ?? 'NOT marked'}`);
  const unmarked = habits.filter((h) => !statuses.has(h.id)).length;
  return [`- habits on ${user.today} (${habits.length}, ${unmarked} not marked yet) — this live list is the ONLY truth about today:`, ...lines].join('\n');
};

export const habitsSkill: Skill = {
  name: 'habits',
  prompt: [
    '## Skill: habit tracking 🎯',
    'You help the user build daily habits: add habits, mark them done/skipped, and show progress.',
    '- The "User state" section already lists their habits + today\'s status — use it instead of calling list_habits.',
    '- When the user says they did (or skipped) something matching a habit, ALWAYS call mark_habit — even if you think it is already marked (re-marking is harmless). Never reply "already done" without calling it.',
    '- Earlier messages in this chat may be from previous days: "for today" in them meant THAT day. Today\'s status comes only from the live habits list above.',
    '- "Yesterday" etc. → pass the right date (you know today\'s date). Only the last 7 days can be changed.',
    '- Showing/listing habits → send_habit_list (one plain message). Buttons to mark them → send_habit_checklist, only when they ask to mark / want the checklist.',
    '- Weekly recap / points / rank / leaderboard / "how did my week go" → send_weekly_recap. A recap also goes out by itself every Sunday afternoon.',
    '- Stats/status/streak/tracker for SPECIFIC day(s) ("for 4th Oct", "4th and 5th October", "yesterday") → send_habit_days with those dates (one call, all dates).',
    '- stats, streak, tracker, progress, history, report, "how am I doing" and similar ALL mean send_habit_stats. For several or all habits make ONE call with no habit (never one call per habit).',
    '- Never invent habits or stats — always use the tools.',
    '- Status emojis: done = ✅, skipped = ❌, not marked = ⬜ (never use ⏭️ — older messages in the chat may still show it).',
    '- If they have no habits yet, nudge them to add one — suggest *Daily Exercise* as an easy first habit.',
    '- When you mention commands, ONLY use these real ones: *add habit <name>*, *show habits*, *checklist* (buttons to mark), *<habit> streak*, *streak all*, *weekly recap*, *help*.',
    `- A reminder is sent daily at ${REMINDER_TIME}. If they want reminders off/on, call set_reminders (they can also type STOP / *start reminders*).`,
  ].join('\n'),
  tools: habitTools,
  shortcut: habitShortcut,
  everyMinute: async (hhmm) => {
    if (hhmm === REMINDER_TIME) await sendDailyReminders();
    if (hhmm === RECAP_TIME && isRecapDay(localDate())) await sendWeeklyRecaps();
  },
  describeState: describeHabitState,
  vocabulary: async (user) => [
    ...(await store.listHabits(user.userId)).map((h) => h.name),
    'streak', 'stats', 'tracker', 'checklist', 'recap', 'leaderboard', 'show habits', 'add habit', 'mark all',
  ],
  welcome: {
    examples: ['*add habit daily exercise*', '*daily exercise streak*', '*show habits*'],
    starter: {
      text: "Let's start with *Daily Exercise* — tap to add it 💪",
      buttons: [
        { id: 'add:Daily Exercise', title: '💪 Daily Exercise' },
        { id: 'addhabit', title: '✍️ My own habit' },
      ],
    },
  },
};
