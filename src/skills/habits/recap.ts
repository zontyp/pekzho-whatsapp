// ============================================================================
// 🏅 Weekly recap — every Sunday at HABIT_RECAP_TIME (default 16:00) each user
// gets a scorecard for the last 7 days: marks, best + weakest habit, longest
// streak, POINTS, and where they rank on the Pekzho leaderboard.
//
// 🧮 Points (the user-facing "how scoring works" line mirrors this exactly):
//   • ❌ skipped mark      → 1 pt   (honesty counts — you showed up and checked in)
//   • ✅ done mark         → 2 pts
//   • 🔥 streak bonus      → +1 pt for every done that's part of a streak
//                            (2+ done days in a row for the same habit; a run
//                            that started last week still counts)
//
// The window is "the last 7 days ending today", so the Sunday 16:00 run covers
// Mon–Sun and an on-demand "recap" on a Wednesday still shows a full week.
// ============================================================================

import { db } from '../../db.ts';
import { addDays, TIMEZONE } from '../../clock.ts';
import { greetingName } from '../../pekzho/user-context.ts';
import { DRY_RUN } from '../../whatsapp.ts';

type Status = 'done' | 'skipped';

export interface HabitWeek {
  name: string;
  byDate: Map<string, Status>;
  daysTracked: number;   // 📆 7, or fewer for a habit created mid-week
  done: number;
  skipped: number;
  longestRun: number;    // 🔥 consecutive done days INSIDE this week
  streakBonus: number;
}

export interface UserWeek {
  userId: string;
  name: string;          // 👋 greeting name ("Geeta", "Mr. Tejkumar")
  habits: HabitWeek[];
  done: number;
  skipped: number;
  streakBonus: number;
  points: number;
  rank: number;          // 🏅 1 = top; ties share a rank (1, 2, 2, 4…)
}

export interface Leaderboard {
  weekStart: string;
  today: string;
  users: UserWeek[];     // sorted best first
}

// 🔠 "PAVAN" → "Pavan" on the leaderboard (WhatsApp names are sometimes ALL CAPS)
const tidyName = (n: string) => (n === n.toUpperCase() ? n.charAt(0) + n.slice(1).toLowerCase() : n);

// 🧪 The fake dry-run numbers never sit on the real leaderboard (and vice versa).
const TEST_PREFIXES = ['9100000000', '9199999999'];
const isTestUser = (id: string) => TEST_PREFIXES.some((p) => id.startsWith(p));

// --------------------------------------------------------------------------
// 📥 One query for everybody: every habit of every user, plus this week's logs
// (and the day before, so a streak running into Monday earns its bonus).
// --------------------------------------------------------------------------
export const buildLeaderboard = async (today: string): Promise<Leaderboard> => {
  const weekStart = addDays(today, -6);
  const { rows } = await db.query(
    `SELECT u.user_id, u.display_name, h.id::int AS habit_id, h.name,
            (h.created_at AT TIME ZONE $3)::date::text AS created_on,
            l.log_date::text AS log_date, l.status
       FROM users u
       JOIN habits h USING (user_id)
       LEFT JOIN habit_logs l ON l.habit_id = h.id AND l.log_date BETWEEN $1::date - 1 AND $2::date
      ORDER BY h.id`, [weekStart, today, TIMEZONE]);

  // 🧺 user → habit → logs
  const users = new Map<string, { name: string; habits: Map<number, { name: string; createdOn: string; byDate: Map<string, Status> }> }>();
  for (const r of rows) {
    if (isTestUser(r.user_id) !== DRY_RUN) continue;
    const u = users.get(r.user_id) ?? { name: tidyName(greetingName(r.display_name) ?? 'Someone'), habits: new Map() };
    users.set(r.user_id, u);
    const h = u.habits.get(r.habit_id) ?? { name: r.name, createdOn: r.created_on, byDate: new Map() };
    u.habits.set(r.habit_id, h);
    if (r.log_date) h.byDate.set(r.log_date, r.status);
  }

  const scored: UserWeek[] = [...users.entries()].map(([userId, u]) => {
    const habits = [...u.habits.values()].map((h) => scoreHabit(h.name, h.createdOn, h.byDate, weekStart, today));
    const done = habits.reduce((n, h) => n + h.done, 0);
    const skipped = habits.reduce((n, h) => n + h.skipped, 0);
    const streakBonus = habits.reduce((n, h) => n + h.streakBonus, 0);
    return { userId, name: u.name, habits, done, skipped, streakBonus, points: 2 * done + skipped + streakBonus, rank: 0 };
  });

  // 🏁 best first; ties share a rank, then alphabetical so the board is stable
  scored.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  for (const u of scored) u.rank = 1 + scored.filter((o) => o.points > u.points).length;
  return { weekStart, today, users: scored };
};

const scoreHabit = (name: string, createdOn: string, byDate: Map<string, Status>, weekStart: string, today: string): HabitWeek => {
  const isDone = (d: string) => byDate.get(d) === 'done';
  let done = 0, skipped = 0, streakBonus = 0, run = 0, longestRun = 0;
  for (let d = weekStart; d <= today; d = addDays(d, 1)) {
    const s = byDate.get(d);
    if (s === 'done') {
      done++;
      // 🔥 part of a streak = a done neighbour on either side (yesterday may be last week)
      if (isDone(addDays(d, -1)) || (d < today && isDone(addDays(d, 1)))) streakBonus++;
      run++;
    } else {
      if (s === 'skipped') skipped++;
      run = 0;
    }
    longestRun = Math.max(longestRun, run);
  }
  // 🗓️ only this week's days in the grid map (drop the "day before" helper entry)
  const weekOnly = new Map([...byDate].filter(([d]) => d >= weekStart));
  // 📆 a habit added mid-week counts from its first day — or from its earliest mark,
  //    since "I ran yesterday" can be back-marked on a habit created today
  const earliestMark = [...weekOnly.keys()].sort()[0];
  const startedOn = earliestMark && earliestMark < createdOn ? earliestMark : createdOn;
  const firstDay = startedOn > weekStart ? startedOn : weekStart;
  const daysTracked = Math.max(1, Math.round((Date.parse(today) - Date.parse(firstDay)) / 86_400_000) + 1);
  return { name, byDate: weekOnly, daysTracked: Math.min(7, daysTracked), done, skipped, longestRun, streakBonus };
};

// --------------------------------------------------------------------------
// 🖼️ The recap card — one WhatsApp message, written to feel like a coach, not a bill.
// --------------------------------------------------------------------------
const CELL = { done: '🟩', skipped: '🟥', none: '⬜' } as const;
const MAX_HABITS_IN_GRID = 10;
const MEDALS = ['🥇', '🥈', '🥉'];

const dayLabel = (d: string, withMonth: boolean) =>
  new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', ...(withMonth ? { month: 'short' } : {}), timeZone: 'UTC' });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// 💬 The closing pep talk, picked from how the week actually went.
const pepTalk = (u: UserWeek): string => {
  const marks = u.done + u.skipped;
  const possible = u.habits.reduce((n, h) => n + h.daysTracked, 0);
  const rate = possible ? u.done / possible : 0;
  if (!marks) return "💙 No marks this week — and that's okay. Every streak starts with a single tap. Let's make next week yours.";
  if (rate >= 0.8) return '🌟 Outstanding week! This is what real consistency looks like — keep protecting that streak.';
  if (rate >= 0.5) return '💪 Solid week — you showed up more often than not. One extra ✅ a day and you climb fast.';
  return "🌱 Every mark counts, and you kept checking in. Small steps compound — let's aim for one more ✅ next week.";
};

export const renderWeeklyRecap = (u: UserWeek, board: Leaderboard): string => {
  const { weekStart, today } = board;
  const total = board.users.length;
  const marks = u.done + u.skipped;
  const lines: string[] = [
    '🏅 *Your Pekzho Weekly Recap*',
    `_${dayLabel(weekStart, true)} – ${dayLabel(today, true)}_`,
    '',
    `Hi ${u.name} 👋 here's how your week went.`,
    '',
  ];

  // 🟩 one row per habit — the week at a glance
  for (const h of u.habits.slice(0, MAX_HABITS_IN_GRID)) {
    const cells: string[] = [];
    for (let d = weekStart; d <= today; d = addDays(d, 1)) cells.push(CELL[h.byDate.get(d) ?? 'none']);
    lines.push(`${cells.join('')}  ${h.name}`);
  }
  if (u.habits.length > MAX_HABITS_IN_GRID) lines.push(`…plus ${u.habits.length - MAX_HABITS_IN_GRID} more`);
  lines.push('');

  // 📈 the numbers
  if (marks) {
    lines.push(`✅ *${plural(marks, 'mark')}* this week — ${u.done} done · ${u.skipped} skipped`);
    const streakHabit = [...u.habits].sort((a, b) => b.longestRun - a.longestRun)[0];
    if (streakHabit?.longestRun >= 2) lines.push(`🔥 Longest streak: *${streakHabit.name}* — ${streakHabit.longestRun} days in a row`);
    const ranked = [...u.habits].sort((a, b) => b.done / b.daysTracked - a.done / a.daysTracked || b.longestRun - a.longestRun);
    const best = ranked[0];
    const weakest = ranked.at(-1)!;
    if (best.done) lines.push(`🏆 Most successful: *${best.name}* (${best.done}/${best.daysTracked} days)`);
    if (u.habits.length > 1 && weakest !== best && weakest.done / weakest.daysTracked < best.done / best.daysTracked) {
      lines.push(`🌱 Needs some love: *${weakest.name}* (${weakest.done}/${weakest.daysTracked} days)`);
    }
  } else {
    lines.push('📭 No marks yet this week.');
  }
  lines.push('');

  // ⭐ points, with the maths shown so it feels earned (and legit)
  lines.push(`⭐ *${plural(u.points, 'point')}*`);
  if (u.points) {
    const parts = [`✅ ${u.done}×2`, `❌ ${u.skipped}×1`];
    if (u.streakBonus) parts.push(`🔥 streak bonus +${u.streakBonus}`);
    lines.push(`   ${parts.join(' · ')}`);
  }
  lines.push('');

  // 🏅 rank + who's just ahead
  const tied = board.users.some((o) => o !== u && o.points === u.points);
  lines.push(`📊 *Your rank: #${u.rank} of ${total}*${tied ? ' (tied)' : ''} on Pekzho Habit Tracker`);
  const ahead = board.users.filter((o) => o.points > u.points);
  if (!ahead.length && u.points) {
    lines.push("👑 You're top of the leaderboard this week!");
  } else if (ahead.length) {
    const nearest = ahead.slice(-2).reverse(); // 👀 the two people right above you
    lines.push(`Ahead of you: ${nearest.map((o) => `${o.name} (${o.points})`).join(', ')}${ahead.length > 2 ? ` +${ahead.length - 2} more` : ''}`);
    const gap = nearest[0].points - u.points + 1;
    lines.push(`🎯 ${plural(gap, 'point')} to pass ${nearest[0].name} — that's about ${plural(Math.ceil(gap / 2), 'done')} ✅`);
  }
  lines.push('');

  // 🏆 the podium (first names only, and only people who actually scored)
  const podium = board.users.filter((o) => o.points > 0).slice(0, 3);
  if (podium.length) {
    lines.push("🏆 *This week's top 3*");
    podium.forEach((o, i) => lines.push(`${MEDALS[i]} ${o.name} — ${o.points}${o.userId === u.userId ? '  ← you' : ''}`));
    lines.push('');
  }

  lines.push(pepTalk(u));
  if (u.habits.length < 3) {
    lines.push('💡 Ready for one more? Easy wins like _Drink 2L water_, _Read 10 pages_ or _Sleep by 11_ — tap *Add a habit* below.');
  }
  lines.push('', '_Scoring: ✅ done 2 · ❌ skip 1 · 🔥 +1 per done in a streak_');
  return lines.join('\n');
};

// 📜 The one-line teaser for the TEMPLATE ({{2}}) — the full card follows the tap.
export const recapTeaser = (u: UserWeek, board: Leaderboard): string =>
  u.points
    ? `You scored ${plural(u.points, 'point')} and you're ranked #${u.rank} of ${board.users.length} this week.`
    : `A fresh week starts tomorrow, and your habits are waiting for you.`;
