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

// 🏷️ "Wed 21 Oct" — short, unambiguous, for prompts and confirmations.
export const shortDay = (isoDate: string): string =>
  new Date(isoDate + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

// 🧮 "yesterday" / "day before yesterday" / "last monday" / "20th" / "20 oct" →
// YYYY-MM-DD, done HERE so the LLM never does calendar math. (It once read
// "yesterday (16 Oct)" out of an old chat turn and marked the wrong day. 🙈)
// Returns null when it can't make sense of the words — the caller says so.
// Future days come back as-is (e.g. "tomorrow"); callers decide if that's OK.
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export const resolveDayWords = (words: string | undefined, today: string): string | null => {
  const w = (words ?? '').trim().toLowerCase().replace(/[.,!]/g, '').replace(/\s+/g, ' ');
  if (!w || w === 'today' || w === 'tonight' || w === 'this morning' || w === 'this evening') return today;
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) return w;
  if (w === 'yesterday' || w === 'last night') return addDays(today, -1);
  if (/^(the )?day before yesterday$/.test(w)) return addDays(today, -2);
  if (w === 'tomorrow') return addDays(today, 1);
  const ago = w.match(/^(\d+) days? ago$/);
  if (ago) return addDays(today, -Number(ago[1]));

  // 📆 "monday" / "on monday" / "last monday" / "this monday" → most recent one.
  //    Plain "monday" said ON a Monday = today; "last monday" then = a week ago.
  const wd = w.match(/^(?:on |last |this |past )?(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/);
  if (wd) {
    const target = WEEKDAYS.findIndex((d) => d.startsWith(wd[1]));
    const todayIdx = new Date(today + 'T00:00:00Z').getUTCDay();
    let back = (todayIdx - target + 7) % 7;
    if (back === 0 && w.startsWith('last ')) back = 7;
    return addDays(today, -back);
  }

  // 🗓️ "20th", "20 oct", "oct 20", "20th of october" → most recent such date
  //    (so on 2 Nov, "30th" means 30 Oct, not 30 Nov).
  const dayFirst = w.match(/^(?:on )?(?:the )?(\d{1,2})(?:st|nd|rd|th)?(?: of)?(?: ([a-z]+))?$/);
  const monthFirst = w.match(/^(?:on )?([a-z]+) (\d{1,2})(?:st|nd|rd|th)?$/);
  const [dayStr, monthStr] = dayFirst ? [dayFirst[1], dayFirst[2]] : monthFirst ? [monthFirst[2], monthFirst[1]] : [];
  if (dayStr) {
    const day = Number(dayStr);
    const month = monthStr ? MONTHS.findIndex((m) => monthStr.startsWith(m)) : -1;
    if (monthStr && month < 0) return null;
    if (day < 1 || day > 31) return null;
    // 🔙 walk back from today until the day (and month, if given) matches — max ~a year
    for (let back = 0; back < 370; back++) {
      const d = addDays(today, -back);
      if (Number(d.slice(8, 10)) === day && (month < 0 || Number(d.slice(5, 7)) === month + 1)) return d;
    }
  }
  return null;
};
