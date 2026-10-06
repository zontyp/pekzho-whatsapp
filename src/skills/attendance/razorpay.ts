// ============================================================================
// 🕘 Razorpay Payroll (payroll.razorpay.com) — Check In / Check Out by driving
// a real Chrome, because there's no public API (its own API wants a CSRF token
// that only lives in the page's JS memory).
//
// Proven by hand on 2026-10-04 before this was written:
//   1. open /attendance-v2 on the user's saved profile
//   2. not logged in? → click Google's "Sign in with Google" button (it's in an
//      iframe) → popup → pick the saved account → consent → back on /attendance
//      — ~25s, no human, as long as the Google login in the profile is alive
//   3. read GET /v2/api/attendance/today → is_checkin_done, checkin_time, …
//   4. click "Check In" → POST /v2/api/attendance/check-in {"location":"-1"}
//      → {"attendance-id":…, "checkin-time":"12:46 AM"}
//
// ⚠️ Browserbase Chrome runs on UTC and Razorpay takes "today" from the BROWSER
// clock — so we pin the browser to the user's timezone AND refuse to click
// unless the page's "Mark attendance for today (4th Oct 2026)" banner shows
// the day we expect. A check-in on the wrong day is worse than none. 😬
// ============================================================================

import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { localTime, TIMEZONE } from '../../clock.ts';
import { releaseBrowser, startBrowser } from '../../browserbase.ts';

export const RAZORPAY_LOGIN_URL = 'https://payroll.razorpay.com/login?redirect=%2Fattendance';
const ATTENDANCE_PAGE = 'https://payroll.razorpay.com/attendance-v2';
export const ON_ATTENDANCE_PAGE = /^https:\/\/payroll\.razorpay\.com\/attendance/;
const RUN_MAX_SECONDS = 180; // 🧯 one check-in takes ~30–60s; Browserbase kills it at 3 min regardless

export type AttendanceAction = 'check-in' | 'check-out' | 'status';

export interface TodayStatus {
  webCheckinAllowed: boolean;
  checkedInAt: string | null;   // "09:42:00"
  checkedOutAt: string | null;
}

export type AttendanceResult =
  | { outcome: 'done'; action: 'check-in' | 'check-out'; time: string; status: TodayStatus }
  | { outcome: 'already'; action: 'check-in'; time: string; status: TodayStatus }   // only check-in — see the ☝️ below
  | { outcome: 'status'; status: TodayStatus }
  | { outcome: 'needs-login' }                       // Google wants a human again → send a login link
  | { outcome: 'refused'; reason: string };          // not allowed / page looked wrong → told the user why

// 🇮🇳 Make the browser think it's in the user's timezone (see the ⚠️ above).
export const pinBrowserTimezone = async (context: BrowserContext, page: Page) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: TIMEZONE });
};

// 📅 "2026-10-04" → matches "4th Oct 2026" (month matched on its first 3
// letters, so "Sep" vs "Sept" can't trip us up).
const bannerDatePattern = (isoDate: string): RegExp => {
  const [y, m, d] = isoDate.split('-').map(Number);
  const month = new Date(Date.UTC(y, m - 1, d)).toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' }).slice(0, 3);
  return new RegExp(`\\b${d}(st|nd|rd|th)\\s+${month}\\w*\\s+${y}\\b`, 'i');
};

const toStatus = (body: any): TodayStatus => {
  const d = body?.data ?? body ?? {};
  return {
    webCheckinAllowed: d.show_web_checkin !== false,
    checkedInAt: d.is_checkin_done ? (d.checkin_time ?? '?') : null,
    checkedOutAt: d.checkout_time ?? null,
  };
};

// 🕰️ "09:42:00" → "9:42 AM" for WhatsApp replies.
export const friendlyTime = (hhmmss: string | null): string => {
  const m = hhmmss?.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return hhmmss ?? '?';
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
};

// 🔐 The no-human Google re-login. Returns false if Google wants a person
// (password / 2FA / "choose an account" we can't pick) — caller sends a link.
const signInWithSavedGoogle = async (context: BrowserContext, page: Page): Promise<boolean> => {
  try {
    if (!/\/login/.test(page.url())) await page.goto(RAZORPAY_LOGIN_URL, { waitUntil: 'domcontentloaded' });
    // 🔘 Google renders its button inside an iframe (Google Identity Services)
    const googleButton = page.frameLocator('iframe[src*="accounts.google.com/gsi/button"]').locator('[role=button]').first();
    const popupOpens = context.waitForEvent('page', { timeout: 20_000 });
    await googleButton.click({ timeout: 20_000 });
    const popup = await popupOpens.catch(() => null);
    if (popup) {
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      // 👤 account chooser → the saved account; then a possible "Continue" consent
      const savedAccount = popup.locator('[data-identifier], [data-email]').first();
      if (await savedAccount.isVisible({ timeout: 8000 }).catch(() => false)) await savedAccount.click();
      const continueButton = popup.getByRole('button', { name: /continue|allow|confirm/i }).first();
      if (await continueButton.isVisible({ timeout: 5000 }).catch(() => false)) await continueButton.click();
    }
    await page.waitForURL(ON_ATTENDANCE_PAGE, { timeout: 35_000 });
    return true;
  } catch (e: any) {
    console.log(`🕘 Google auto sign-in didn't finish: ${e.message.split('\n')[0]}`);
    return false;
  }
};

// 🎬 The whole run: one Chrome, open → (re)login → read today → maybe click → release.
export const runAttendance = async (browserProfileId: string, action: AttendanceAction, today: string): Promise<AttendanceResult> => {
  const live = await startBrowser(browserProfileId, RUN_MAX_SECONDS);
  const browser = await chromium.connectOverCDP(live.connectUrl);
  const started = Date.now();
  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? await context.newPage();
    await pinBrowserTimezone(context, page);

    // 👂 Remember the page's own "today" answer — the freshest one wins.
    let todayBody: any = null;
    let todayRejected = false; // 🔒 401/403 on /today = Razorpay's ~4h session is gone
    page.on('response', async (res) => {
      if (!/\/v2\/api\/attendance\/today/.test(res.url())) return;
      if (res.ok()) todayBody = await res.json().catch(() => todayBody);
      else if ([401, 403].includes(res.status())) todayRejected = true;
    });

    // ⏳ Razorpay's app ALWAYS opens /attendance-v2 first — even logged out — and
    // only bounces to /login after its /today call is refused. So "on the
    // attendance URL" proves nothing; wait for /today to answer OR the bounce.
    // (Checking the URL too early made 3 check-ins fail on 2026-10-05.)
    const waitForTodayOrLogin = async (): Promise<'today' | 'login' | 'timeout'> => {
      for (let i = 0; i < 60; i++) {
        if (todayBody) return 'today';
        if (todayRejected || /\/login/.test(page.url())) return 'login';
        await page.waitForTimeout(400);
      }
      return 'timeout';
    };
    const openAttendance = () => page.goto(`${ATTENDANCE_PAGE}?month=${today.slice(0, 7)}`, { waitUntil: 'domcontentloaded' });

    await openAttendance();
    let landed = await waitForTodayOrLogin();
    if (landed === 'login') {
      console.log('🕘 Razorpay session expired → Google auto sign-in');
      if (!(await signInWithSavedGoogle(context, page))) return { outcome: 'needs-login' };
      todayBody = null; todayRejected = false;
      await openAttendance();                 // 🔁 fresh load so /today answers with the new session
      landed = await waitForTodayOrLogin();
      if (landed === 'login') return { outcome: 'needs-login' };
    }
    if (!todayBody) return { outcome: 'refused', reason: "Razorpay's attendance page didn't load properly." };
    const status = toStatus(todayBody);

    // 📅 the wrong-day guard
    const banner = (await page.getByText(/mark attendance for today/i).first().innerText({ timeout: 10_000 }).catch(() => '')).trim();
    if (!bannerDatePattern(today).test(banner)) {
      return { outcome: 'refused', reason: `Razorpay's page shows a different day ("${banner || 'no date found'}") — I didn't click anything.` };
    }
    if (action === 'status') return { outcome: 'status', status };
    if (!status.webCheckinAllowed) return { outcome: 'refused', reason: "your company hasn't enabled web check-in on Razorpay." };
    // ☝️ Razorpay allows ONE check-in a day — but after a check-out it keeps
    // showing "Check Out", and pressing it again just moves the check-out time
    // (last one wins). So a repeat check-out is a normal click, not "already".
    if (action === 'check-in' && status.checkedInAt) return { outcome: 'already', action, time: friendlyTime(status.checkedInAt), status };
    if (action === 'check-out' && !status.checkedInAt) return { outcome: 'refused', reason: "you haven't checked in today, so there's nothing to check out of." };

    // 👆 the click. Matched by visible text — the label carries a clock icon,
    // which made accessible-name matching miss it in testing.
    const label = action === 'check-in' ? /^\s*check\s*in\s*$/i : /^\s*check\s*out\s*$/i;
    const button = page.locator('button, [role=button]').filter({ hasText: label }).first();
    if (!(await button.isVisible({ timeout: 10_000 }).catch(() => false))) {
      return { outcome: 'refused', reason: `I couldn't find the "${action === 'check-in' ? 'Check In' : 'Check Out'}" button on Razorpay.` };
    }
    const punchResponse = page.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/v2\/api\/attendance\/check-(in|out)/.test(r.url()), { timeout: 25_000 });
    await button.click();
    // 🪟 a confirm dialog may pop up (seen for some orgs) — confirming IS the check-in
    const confirm = page.locator('[role=dialog], [role=alertdialog]').getByRole('button', { name: /check\s*(in|out)|confirm|yes|submit/i }).first();
    if (await confirm.isVisible({ timeout: 3000 }).catch(() => false)) await confirm.click();

    const res = await punchResponse;
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok()) return { outcome: 'refused', reason: `Razorpay said no: ${body?.message ?? `HTTP ${res.status()}`}` };
    // ⏰ {"checkin-time":"12:46 AM"} / {"checkout-time":…} — grab whichever *time key
    const timeKey = Object.keys(body).find((k) => /time/i.test(k));
    const time = timeKey ? String(body[timeKey]) : friendlyTime(localTime()); // 🕰️ user's clock, not the container's UTC
    return { outcome: 'done', action, time, status };
  } finally {
    await browser.close().catch(() => {});
    await releaseBrowser(live.id);
    console.log(`🕘 razorpay ${action} run took ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
};
