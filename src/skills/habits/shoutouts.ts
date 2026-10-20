// ============================================================================
// 📣 Yesterday's shoutouts — the "who won / who's back / who's warming up" line
// that rides on top of the 21:00 daily reminder (template AND free-form).
//
// Everyone with a habit lands in exactly ONE bucket for yesterday:
//   🏆 winners    → marked ANYTHING yesterday (✅ done or ❌ skip — showing up wins)
//   🔥 comebacks  → marked yesterday after a day (or more) with no marks at all
//                   (they had a habit back then, so a brand-new user isn't "back")
//   💪 warming up → marked nothing yesterday
//
// Rate-neutral on purpose: one mark is a win whether you track 1 habit or 6.
// Every bucket gets an upbeat nickname ("Champ Karan", "Phoenix Geeta",
// "Fighter Tejkumar") — the warming-up crowd included: the tone is "your turn
// is coming", never "you lost". 🌱
//
// 🏆 ALL of yesterday's winners and comebacks are named — they earned it.
// 💪 Warming-up is the biggest bucket by far, so only WARMING_UP_PER_DAY of them
// are named per day: the ones who've waited longest since their last mention
// (users.last_spotlight_on, never-named first). The reminder run stamps them
// via stampSpotlight(), so tomorrow it's someone else's turn — everybody gets
// cycled through before anyone is named twice.
//
// 🤖 Nicknames come from DeepSeek, picked from each person's WEEKLY stats on
// their best habit (most dones in the 7 days ending yesterday): dones, longest
// streak, skips, days since their last mark. ONE call per evening covers all
// named people. The model never sees habit names (and is told not to invent
// any) — these lines go to EVERY user, so a nickname must never leak what
// someone is tracking. If the call fails/times out → the word pools below.
//
// 🙈 People who sent STOP are never named in anyone's message.
// ============================================================================

import { db } from '../../db.ts';
import { addDays, TIMEZONE } from '../../clock.ts';
import { greetingName } from '../../pekzho/user-context.ts';
import { DRY_RUN } from '../../whatsapp.ts';

const WARMING_UP_PER_DAY = 3;
const COMEBACK_GAP_DAYS  = 1;   // no marks on the day(s) before yesterday → "comeback"

// 🎖️ Fallback nickname pools (DeepSeek down / bad answer) — all gender-neutral (we don't know anyone's gender from a
// WhatsApp name, so no King/Queen guessing) and all positive.
const WINNER_NICKNAMES   = ['Champ', 'Legend', 'Rockstar', 'Superstar', 'Captain', 'Ace', 'Boss', 'MVP', 'Hero', 'Titan', 'Star'];
const COMEBACK_NICKNAMES = ['Phoenix', 'Comeback Kid', 'Unstoppable', 'Bounce-back', 'Never-quit', 'Rising Star'];
const WARMUP_NICKNAMES   = ['Fighter', 'Warrior', 'Persistent', 'About-to-comeback', 'Never-give-up', 'Comeback-loading', 'Brave-heart', 'Determined', 'Unbreakable'];

export interface Shoutout { userId: string; name: string; nickname: string; lastSpotlightOn?: string | null; week?: WeekStats }

// 📊 What DeepSeek gets to see about one person (numbers only — no habit names)
export interface WeekStats {
  topHabitDones: number;      // ✅ dones on their best habit, last 7 days
  topHabitLongestStreak: number;
  topHabitSkips: number;
  totalMarks: number;         // ✅+❌ across all habits, last 7 days
  daysSinceLastMark: number | null;   // null = never marked anything
}
export interface Shoutouts { day: string; winners: Shoutout[]; comebacks: Shoutout[]; warmingUp: Shoutout[]; warmingUpTotal: number }

// 🔠 "PAVAN" → "Pavan" (same rule as the leaderboard)
const tidyName = (n: string) => (n === n.toUpperCase() ? n.charAt(0) + n.slice(1).toLowerCase() : n);
const TEST_PREFIXES = ['9100000000', '9199999999'];
const isTestUser = (id: string) => TEST_PREFIXES.some((p) => id.startsWith(p));

// 🎲 Cheap stable hash: same user + same day → same nickname / same rotation slot
const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
// 🎖️ Hand out nicknames down the list from a day-dependent starting point, so
// nobody in the same group shares one ("Almost-there ×3" looked like a bug 🙃)
// and everyone's title changes from day to day.
const nickname = (group: Shoutout[], pool: string[], key: string) => {
  const start = hash(key) % pool.length;
  group.forEach((s, i) => { s.nickname = pool[(start + i) % pool.length]; });
};

// 📥 One query: per user, did they mark anything yesterday / in the gap before it,
// and did they already have a habit back then.
export const buildShoutouts = async (today: string): Promise<Shoutouts> => {
  const day = addDays(today, -1);
  const gapStart = addDays(day, -COMEBACK_GAP_DAYS);
  const { rows } = await db.query(
    `SELECT u.user_id, u.display_name, u.last_spotlight_on::text AS last_spotlight_on,
            bool_or(l.log_date = $1::date)                                           AS marked_yesterday,
            bool_or(l.log_date >= $2::date AND l.log_date < $1::date)                AS marked_in_gap,
            bool_or((h.created_at AT TIME ZONE $3)::date <= $2::date)                AS had_habit_before_gap,
            bool_or((h.created_at AT TIME ZONE $3)::date <= $1::date)                AS had_habit_yesterday
       FROM users u
       JOIN habits h USING (user_id)
       LEFT JOIN habit_logs l ON l.habit_id = h.id AND l.log_date BETWEEN $2::date AND $1::date
      WHERE NOT u.reminders_opt_out
      GROUP BY u.user_id, u.display_name, u.last_spotlight_on`, [day, gapStart, TIMEZONE]);

  const winners: Shoutout[] = [], comebacks: Shoutout[] = [], warmingUp: Shoutout[] = [];
  for (const r of rows) {
    if (isTestUser(r.user_id) !== DRY_RUN) continue;   // 🧪 test and real users never mix
    if (!r.had_habit_yesterday) continue;              // 🐣 joined today — nothing to judge yet
    const name = tidyName(greetingName(r.display_name) ?? 'Someone');
    const who = { userId: r.user_id, name, nickname: '', lastSpotlightOn: r.last_spotlight_on };
    if (r.marked_yesterday && !r.marked_in_gap && r.had_habit_before_gap) comebacks.push(who);
    else if (r.marked_yesterday) winners.push(who);
    else warmingUp.push(who);
  }
  winners.sort((a, b) => a.name.localeCompare(b.name));
  comebacks.sort((a, b) => a.name.localeCompare(b.name));
  // 🔄 longest-waiting first. Anyone already stamped TODAY sorts to the very
  // front, so a re-run (restart, preview) picks the same 3 instead of 3 new ones.
  const waitKey = (s: Shoutout) => (s.lastSpotlightOn === today ? '0' : s.lastSpotlightOn ? `2${s.lastSpotlightOn}` : '1');
  warmingUp.sort((a, b) => waitKey(a).localeCompare(waitKey(b)) || hash(`${a.userId}:${day}`) - hash(`${b.userId}:${day}`));
  const named = { winners, comebacks, warmingUp: warmingUp.slice(0, WARMING_UP_PER_DAY) };
  // 🎖️ pools first (instant, always works) — then DeepSeek's stats-based picks on top
  nickname(named.winners, WINNER_NICKNAMES, `${day}:win`);
  nickname(named.comebacks, COMEBACK_NICKNAMES, `${day}:back`);
  nickname(named.warmingUp, WARMUP_NICKNAMES, `${day}:warm`);
  const everyone = [...named.winners, ...named.comebacks, ...named.warmingUp];
  if (everyone.length) {
    await attachWeekStats(everyone, day);
    try { await nicknamesFromDeepSeek(named); }
    catch (e: any) { console.warn(`📣 DeepSeek nicknames failed, using the word pools: ${e.message}`); }
  }
  return { day, ...named, warmingUpTotal: warmingUp.length };
};

// 📊 Last 7 days (ending yesterday) per person: find the habit with the most
// dones, and read its longest streak + skips off the same rows.
const attachWeekStats = async (people: Shoutout[], day: string) => {
  const weekStart = addDays(day, -6);
  const { rows } = await db.query(
    `SELECT h.user_id, h.id::int AS habit_id, l.log_date::text AS log_date, l.status
       FROM habits h JOIN habit_logs l ON l.habit_id = h.id
      WHERE h.user_id = ANY($1) AND l.log_date BETWEEN $2::date AND $3::date`, [people.map((p) => p.userId), weekStart, day]);
  const { rows: last } = await db.query(
    `SELECT h.user_id, max(l.log_date)::text AS last_mark
       FROM habits h JOIN habit_logs l ON l.habit_id = h.id
      WHERE h.user_id = ANY($1) AND l.log_date <= $2::date GROUP BY h.user_id`, [people.map((p) => p.userId), day]);
  for (const p of people) {
    const mine = rows.filter((r: any) => r.user_id === p.userId);
    const byHabit = new Map<number, Map<string, string>>();
    for (const r of mine) byHabit.set(r.habit_id, (byHabit.get(r.habit_id) ?? new Map()).set(r.log_date, r.status));
    let best = { dones: 0, streak: 0, skips: 0 };
    for (const marks of byHabit.values()) {
      let dones = 0, skips = 0, run = 0, streak = 0;
      for (let d = weekStart; d <= day; d = addDays(d, 1)) {
        const st = marks.get(d);
        if (st === 'done') { dones++; run++; streak = Math.max(streak, run); } else { run = 0; if (st === 'skipped') skips++; }
      }
      if (dones > best.dones || (dones === best.dones && streak > best.streak)) best = { dones, streak, skips };
    }
    const lastMark = last.find((r: any) => r.user_id === p.userId)?.last_mark;
    p.week = {
      topHabitDones: best.dones, topHabitLongestStreak: best.streak, topHabitSkips: best.skips,
      totalMarks: mine.length,
      daysSinceLastMark: lastMark ? Math.round((Date.parse(day) - Date.parse(lastMark)) / 86_400_000) : null,
    };
  }
};

// 🤖 One DeepSeek call → {"<key>": "Nickname"} for everyone named tonight.
// Keys are p1, p2… (not phone numbers, not names) — the model sees only numbers.
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const NICKNAME_MODEL = process.env.HABIT_NICKNAME_MODEL ?? process.env.PEKZHO_MODEL ?? 'deepseek-flash';
const NICKNAME_TIMEOUT_MS = 45_000;

const nicknamesFromDeepSeek = async (named: { winners: Shoutout[]; comebacks: Shoutout[]; warmingUp: Shoutout[] }) => {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY not set');
  const people = [
    ...named.winners.map((p) => ({ p, group: 'winner — marked a habit yesterday' })),
    ...named.comebacks.map((p) => ({ p, group: 'comeback — marked yesterday after a day or more off' })),
    ...named.warmingUp.map((p) => ({ p, group: 'warming up — marked nothing yesterday' })),
  ].map((x, i) => ({ ...x, key: `p${i + 1}` }));

  const brief = people.map(({ key, group, p }) => ({ key, group, last7days: p.week }));
  const prompt = [
    'You name people in a friendly daily habit-tracker shoutout that EVERY user of the app reads.',
    'For each person, invent ONE short nickname that reflects their weekly stats on their best habit',
    '(last7days: topHabitDones / topHabitLongestStreak / topHabitSkips out of 7 days, totalMarks, daysSinceLastMark).',
    'Examples of the spirit: 5-day streak → "Five-Day Flame"; 7/7 dones → "Perfect Week"; many skips but still showing up → "Never-Quit";',
    'a comeback → "Phoenix Rising"; warming up with no marks in a while → "Comeback Loading", "Warrior", "Fighter", "Persistent".',
    'Rules:',
    '- Positive and inspiring for EVERY group — warming-up people must feel encouraged, never mocked or called losers.',
    '- 1 to 3 words, max 22 characters, Title Case, no emoji, no quotes.',
    '- Gender-neutral (no King/Queen/Mr/Ms/Bro/Girl).',
    '- Never mention or guess what the habit is, and nothing personal — just the numbers and the vibe.',
    '- All nicknames must be different from each other.',
    'Reply with JSON only: {"<key>": "<nickname>", ...} with every key below.',
    '',
    JSON.stringify(brief),
  ].join('\n');

  const r = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: NICKNAME_MODEL,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 1.1,   // 🎨 a little playful, so names vary day to day
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(NICKNAME_TIMEOUT_MS),
  });
  const json: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`DeepSeek ${r.status}: ${JSON.stringify(json?.error ?? json).slice(0, 200)}`);
  const picks = JSON.parse(json?.choices?.[0]?.message?.content ?? '{}');

  // 🧽 Trust but verify: tidy each pick, keep the pool name for anything off
  const used = new Set<string>();
  let applied = 0;
  for (const { key: k, p } of people) {
    const nick = String(picks?.[k] ?? '').replace(/[^\p{L}\p{N}' -]/gu, '').replace(/\s+/g, ' ').trim();
    const ok = nick.length >= 3 && nick.length <= 24 && !used.has(nick.toLowerCase())
      && !/\b(king|queen|mr|mrs|ms|bro|girl|boy|loser|lazy)\b/i.test(nick);
    if (ok) { p.nickname = nick; applied++; }
    used.add(p.nickname.toLowerCase());
  }
  console.log(`📣 DeepSeek nicknames: ${applied}/${people.length} applied`);
};

// 📝 "these 3 had their turn today" — called by the reminder run, not by previews
export const stampSpotlight = async (s: Shoutouts, today: string) => {
  if (!s.warmingUp.length) return;
  await db.query('UPDATE users SET last_spotlight_on = $2 WHERE user_id = ANY($1)', [s.warmingUp.map((w) => w.userId), today]);
};

const titled = (s: Shoutout) => `${s.nickname} ${s.name}`;
const list = (xs: Shoutout[]) => xs.map(titled).join(', ');
const isAre = (n: number) => (n === 1 ? 'is' : 'are');

// 📜 ONE line for the template's {{2}} — Meta rejects newlines/tabs in params.
export const shoutoutLine = (s: Shoutouts): string => {
  const parts: string[] = [];
  if (s.winners.length)   parts.push(`🏆 ${list(s.winners)} won the day`);
  if (s.comebacks.length) parts.push(`🔥 ${list(s.comebacks)} ${isAre(s.comebacks.length)} BACK`);
  if (s.warmingUp.length) parts.push(`💪 ${list(s.warmingUp)} ${isAre(s.warmingUp.length)} gearing up for a big one`);
  return parts.length ? parts.join(' · ') : 'a fresh start for everyone — be tonight\'s first champ 🏆';
};

// 💬 The free-form version (inside the 24h window) — a little stage of its own.
export const shoutoutBlock = (s: Shoutouts): string | undefined => {
  const lines: string[] = [];
  if (s.winners.length)   lines.push(`🏆 *Won the day:* ${list(s.winners)}`);
  if (s.comebacks.length) lines.push(`🔥 *Comeback of the day:* ${list(s.comebacks)} — welcome back!`);
  if (s.warmingUp.length) lines.push(`💪 *Gearing up:* ${list(s.warmingUp)} — tonight could be your night!`);
  return lines.length ? [`📣 *Yesterday on Pekzho*`, ...lines].join('\n') : undefined;
};
