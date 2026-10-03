// ============================================================================
// 🗄️ Habit data access — the PG_READ / PG_WRITE nodes of FlowTalkr's
// StreakSetGo.json, as plain functions. Every query is scoped by user_id (the WhatsApp number) so one
// user can never touch another user's habits (FlowTalkr trusted the button id
// alone — we don't).
// ============================================================================

import { db, markNotNew } from '../../db.ts';

export interface Habit { id: number; name: string }
export type HabitStatus = 'done' | 'skipped';
export interface HabitLog { date: string; status: HabitStatus }

export class HabitError extends Error {}

// 📋 readUserHabits
export const listHabits = async (userId: string): Promise<Habit[]> => {
  const { rows } = await db.query(
    'SELECT id::int AS id, name FROM habits WHERE user_id = $1 ORDER BY id ASC', [userId]);
  return rows;
};

// ➕ writeInsertHabit — duplicate names (case/space-insensitive) are refused nicely.
export const addHabit = async (userId: string, rawName: string): Promise<Habit> => {
  const name = rawName.trim().replace(/\s+/g, ' ');
  if (!name) throw new HabitError('Habit name is empty.');
  if (name.length > 60) throw new HabitError('Habit name is too long (max 60 characters).');
  const { rows } = await db.query(
    `INSERT INTO habits (user_id, name) VALUES ($1, $2)
     ON CONFLICT (user_id, lower(btrim(name))) DO NOTHING
     RETURNING id::int AS id, name`, [userId, name]);
  if (!rows[0]) throw new HabitError(`You already track a habit called "${name}".`);
  // 🎓 first habit = onboarding done → the user stops being "new"
  await markNotNew(userId);
  return rows[0];
};

export const deleteHabit = async (userId: string, habitId: number): Promise<void> => {
  await db.query('DELETE FROM habits WHERE user_id = $1 AND id = $2', [userId, habitId]);
};

// 🔎 Name → habit, forgiving about case and stray spaces (like FlowTalkr's
// LOWER(TRIM(...)) match). Falls back to a unique prefix/substring match so
// "stats run" finds "Daily Run" when it's the only candidate.
export const findHabit = async (userId: string, nameOrId: string): Promise<Habit | undefined> => {
  const habits = await listHabits(userId);
  const needle = nameOrId.trim().toLowerCase();
  if (/^\d+$/.test(needle)) {
    const byId = habits.find((h) => h.id === Number(needle));
    if (byId) return byId;
  }
  const exact = habits.find((h) => h.name.toLowerCase() === needle);
  if (exact) return exact;
  const fuzzy = habits.filter((h) => h.name.toLowerCase().includes(needle));
  return fuzzy.length === 1 ? fuzzy[0] : undefined;
};

export const getHabitById = async (userId: string, habitId: number): Promise<Habit | undefined> => {
  const { rows } = await db.query(
    'SELECT id::int AS id, name FROM habits WHERE user_id = $1 AND id = $2', [userId, habitId]);
  return rows[0];
};

// ✅ writeHabitDone / writeHabitSkipped — upsert, so re-tapping flips the verdict.
export const logHabit = async (userId: string, habitId: number, date: string, status: HabitStatus): Promise<Habit> => {
  const habit = await getHabitById(userId, habitId);
  if (!habit) throw new HabitError('That habit no longer exists.');
  await db.query(
    `INSERT INTO habit_logs (habit_id, log_date, status) VALUES ($1, $2, $3)
     ON CONFLICT (habit_id, log_date) DO UPDATE SET status = EXCLUDED.status, created_at = now()`,
    [habitId, date, status]);
  return habit;
};

// 📊 readHabitStats
export const habitLogs = async (habitId: number): Promise<HabitLog[]> => {
  const { rows } = await db.query(
    `SELECT log_date::text AS date, status FROM habit_logs WHERE habit_id = $1 ORDER BY log_date`, [habitId]);
  return rows;
};

// 🗓️ What's already been marked today — the checklist shows it.
export const todaysStatuses = async (userId: string, date: string): Promise<Map<number, HabitStatus>> => {
  const { rows } = await db.query(
    `SELECT l.habit_id::int AS id, l.status FROM habit_logs l JOIN habits h ON h.id = l.habit_id
     WHERE h.user_id = $1 AND l.log_date = $2`, [userId, date]);
  return new Map(rows.map((r: any) => [r.id, r.status]));
};

// 🔁 readIsAddingHabit / writeIsAddHabit / writeResetAddHabitState
export const isAddingHabit = async (userId: string): Promise<boolean> => {
  const { rows } = await db.query('SELECT adding_habit FROM users WHERE user_id = $1', [userId]);
  return rows[0]?.adding_habit === true;
};
export const setAddingHabit = async (userId: string, adding: boolean): Promise<void> => {
  await db.query('UPDATE users SET adding_habit = $2 WHERE user_id = $1', [userId, adding]);
};
