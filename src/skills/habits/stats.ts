// ============================================================================
// 📊 Habit stats cards — a TypeScript port of FlowTalkr's habit_stats_wasm.wasm.
// Same idea: header + a 7-per-row emoji calendar ending today.
// Upgrades over the WASM: skipped days are 🟥 (not ⬜ like "no entry"), plus a
// streak/count summary, a grid cap so a year of data stays readable, and a
// consolidated all-habits card that fits in ONE WhatsApp message.
// ============================================================================

import { addDays } from '../../clock.ts';
import type { HabitLog } from './store.ts';

const MAX_DAYS_SHOWN = 12 * 7;      // 🧱 single-habit card: 12 weeks of squares
const ALL_HABITS_DAYS_SHOWN = 4 * 7; // 🧱 all-habits card: 4 weeks each, so 10 habits fit in 4096 chars

const CELL = { done: '🟩', skipped: '🟥', none: '⬜' } as const;
const LEGEND = `${CELL.done} done  ${CELL.skipped} skipped  ${CELL.none} no entry`;

interface HabitSummary {
  gridRows: string[];   // 7 cells per row, oldest first
  gridStart: string;    // first date shown in the grid
  done: number;
  skipped: number;
  currentStreak: number;
  bestStreak: number;
}

// 🧮 Crunch one habit's logs into grid + numbers. The grid starts at the first
// log (or `maxDays` ago, whichever is later) and ends today.
const summarize = (logs: HabitLog[], today: string, maxDays: number): HabitSummary => {
  const byDate = new Map(logs.map((l) => [l.date, l.status]));
  const firstDate = logs[0].date;
  const earliestShown = addDays(today, -(maxDays - 1));
  const gridStart = firstDate < earliestShown ? earliestShown : firstDate;

  const cells: string[] = [];
  for (let d = gridStart; d <= today; d = addDays(d, 1)) cells.push(CELL[byDate.get(d) ?? 'none']);
  const gridRows: string[] = [];
  for (let i = 0; i < cells.length; i += 7) gridRows.push(cells.slice(i, i + 7).join(' '));

  // 🔥 Current streak: consecutive "done" days ending today — or yesterday, so an
  // un-marked today doesn't zero out a streak the user is still on.
  let currentStreak = 0;
  let cursor = byDate.get(today) === 'done' ? today : addDays(today, -1);
  while (byDate.get(cursor) === 'done') { currentStreak++; cursor = addDays(cursor, -1); }

  // 🏆 Best streak ever, walking every day from the very first log.
  let bestStreak = 0, run = 0;
  for (let d = firstDate; d <= today; d = addDays(d, 1)) {
    run = byDate.get(d) === 'done' ? run + 1 : 0;
    bestStreak = Math.max(bestStreak, run);
  }

  const done = logs.filter((l) => l.status === 'done').length;
  return { gridRows, gridStart, done, skipped: logs.length - done, currentStreak, bestStreak };
};

// 📊 One habit, full detail.
export const renderStatsCard = (habitName: string, logs: HabitLog[], today: string): string => {
  if (!logs.length) return `📊 *${habitName}*\nNo entries yet — mark it done or skipped today to start your streak! 💪`;
  const s = summarize(logs, today, MAX_DAYS_SHOWN);
  return [
    `📊 *${habitName}* Habit Performance`,
    `from ${s.gridStart} to ${today}`,
    '',
    ...s.gridRows,
    '',
    `✅ done ${s.done} · ❌ skipped ${s.skipped}`,
    `🔥 current streak ${s.currentStreak} · 🏆 best ${s.bestStreak}`,
    '',
    LEGEND,
  ].join('\n');
};

// 📊📊 Every habit in ONE message — compact block per habit (last 4 weeks).
export const renderAllStatsCard = (habits: Array<{ name: string; logs: HabitLog[] }>, today: string): string => {
  const blocks = habits.map(({ name, logs }) => {
    if (!logs.length) return `🎯 *${name}*\n_no entries yet_`;
    const s = summarize(logs, today, ALL_HABITS_DAYS_SHOWN);
    return [
      `🎯 *${name}*`,
      ...s.gridRows,
      '', // 📱 breathing room — on iPhone the squares' bottom edge touches the next line's emoji
      `✅ ${s.done} · ❌ ${s.skipped} · 🔥 ${s.currentStreak} · 🏆 ${s.bestStreak}`,
    ].join('\n');
  });
  return [
    `📊 *All habits* — up to the last 4 weeks, to ${today}`,
    '',
    blocks.join('\n\n'),
    '',
    `✅ done · ❌ skipped · 🔥 current streak · 🏆 best streak`,
    '',
    LEGEND,
  ].join('\n');
};

// 📅 Chosen days only: one row of squares per habit, one square per day (in
// date order), e.g. "🟩 🟥  *eyewash*". Squares first so they line up on a phone.
export const renderDaysCard = (habits: Array<{ name: string; byDate: Map<string, HabitLog['status']> }>, dates: string[]): string => {
  const label = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const rows = habits.map(({ name, byDate }) => `${dates.map((d) => CELL[byDate.get(d) ?? 'none']).join(' ')}  *${name}*`);
  const done = habits.reduce((n, h) => n + dates.filter((d) => h.byDate.get(d) === 'done').length, 0);
  return [
    `📅 *${dates.map(label).join(' · ')}*`,
    '',
    ...rows,
    '',
    `✅ ${done} of ${habits.length * dates.length} done`,
    '',
    LEGEND,
  ].join('\n');
};
