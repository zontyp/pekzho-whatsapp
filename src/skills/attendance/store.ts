// ============================================================================
// 🗄️ attendance_accounts — "which saved browser profile is this user's
// Razorpay login in?" Every query is scoped by user_id (the WhatsApp number).
// ============================================================================

import { db } from '../../db.ts';

export interface AttendanceAccount {
  browserProfileId: string;
  linked: boolean;        // true once their first sign-in through the link worked
}

export const getAttendanceAccount = async (userId: string): Promise<AttendanceAccount | undefined> => {
  const { rows } = await db.query(
    'SELECT browser_profile_id, linked_at FROM attendance_accounts WHERE user_id = $1', [userId]);
  return rows[0] ? { browserProfileId: rows[0].browser_profile_id, linked: rows[0].linked_at != null } : undefined;
};

export const saveNewAttendanceAccount = async (userId: string, browserProfileId: string): Promise<void> => {
  await db.query(
    `INSERT INTO attendance_accounts (user_id, browser_profile_id) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET browser_profile_id = EXCLUDED.browser_profile_id, linked_at = NULL`,
    [userId, browserProfileId]);
};

export const markAttendanceLinked = async (userId: string): Promise<void> => {
  await db.query('UPDATE attendance_accounts SET linked_at = now() WHERE user_id = $1', [userId]);
};

export const stampPunch = async (userId: string): Promise<void> => {
  await db.query('UPDATE attendance_accounts SET last_punch_at = now() WHERE user_id = $1', [userId]);
};

export const forgetAttendanceAccount = async (userId: string): Promise<void> => {
  await db.query('DELETE FROM attendance_accounts WHERE user_id = $1', [userId]);
};
