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
// 🙈 People who sent STOP are never named in anyone's message.
// ============================================================================

import { db } from '../../db.ts';
import { addDays, TIMEZONE } from '../../clock.ts';
import { greetingName } from '../../pekzho/user-context.ts';
import { DRY_RUN } from '../../whatsapp.ts';

const WARMING_UP_PER_DAY = 3;
const COMEBACK_GAP_DAYS  = 1;   // no marks on the day(s) before yesterday → "comeback"

// 🎖️ Nickname pools — all gender-neutral (we don't know anyone's gender from a
// WhatsApp name, so no King/Queen guessing) and all positive.
const WINNER_NICKNAMES   = ['Champ', 'Legend', 'Rockstar', 'Superstar', 'Captain', 'Ace', 'Boss', 'MVP', 'Hero', 'Titan', 'Star'];
const COMEBACK_NICKNAMES = ['Phoenix', 'Comeback Kid', 'Unstoppable', 'Bounce-back', 'Never-quit', 'Rising Star'];
const WARMUP_NICKNAMES   = ['Fighter', 'Warrior', 'Persistent', 'About-to-comeback', 'Never-give-up', 'Comeback-loading', 'Brave-heart', 'Determined', 'Unbreakable'];

export interface Shoutout { userId: string; name: string; nickname: string; lastSpotlightOn?: string | null }
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
  nickname(named.winners, WINNER_NICKNAMES, `${day}:win`);
  nickname(named.comebacks, COMEBACK_NICKNAMES, `${day}:back`);
  nickname(named.warmingUp, WARMUP_NICKNAMES, `${day}:warm`);
  return { day, ...named, warmingUpTotal: warmingUp.length };
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
