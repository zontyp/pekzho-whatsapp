// ============================================================================
// 🕰️ "What day is it for the USER?" — habits are daily, and a 11:30 PM IST tap
// must count for today, not for UTC's tomorrow. Everything date-ish goes via here.
// ============================================================================

export const TIMEZONE = process.env.PEKZHO_TIMEZONE ?? 'Asia/Kolkata';

// 📅 YYYY-MM-DD in TIMEZONE (en-CA happens to format exactly like ISO dates).
export const localDate = (at: Date = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

// ⏰ HH:MM (24h) in TIMEZONE — the scheduler compares this to HABIT_REMINDER_TIME.
export const localTime = (at: Date = new Date()): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false }).format(at);

// 🗓️ Friendly "Friday, 2 October 2026" for the system prompt.
export const localDateLong = (at: Date = new Date()): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(at);

// ➕ Pure calendar math on YYYY-MM-DD strings (UTC under the hood, so no DST surprises).
export const addDays = (isoDate: string, days: number): string => {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
