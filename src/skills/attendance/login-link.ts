// ============================================================================
// 🔗 The one-time "sign in to Razorpay" link.
//
// A user signs in ONCE (and again only if Google ever asks). pekzho:
//   1. starts a Chrome on the user's saved profile, opens Razorpay's login page
//   2. sends them  https://pk.pekzho.com/attendance/login/<token>  on WhatsApp
//   3. that page embeds Browserbase's live view of the Chrome — and keeps
//      SWITCHING to whichever tab matters, because "Sign in with Google" opens a
//      popup tab that a plain live-view link never shows (we learned that the
//      hard way: "I click Sign in with Google and nothing happens") 🪟
//   4. the moment any tab reaches /attendance we release the Chrome (which
//      saves the Google login into the profile) and tell the user ✅
//
// Tokens are random, single-user, live for LINK_MINUTES, and only kept in
// memory — a restart just means "send check in again for a fresh link".
// ⚠️ Whoever holds a live link controls that Chrome, so it's never logged.
// ============================================================================

import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { chromium } from 'playwright-core';
import { liveViewTabs, releaseBrowser, startBrowser } from '../../browserbase.ts';
import { ON_ATTENDANCE_PAGE, pinBrowserTimezone, RAZORPAY_LOGIN_URL } from './razorpay.ts';

const PUBLIC_BASE_URL = process.env.PEKZHO_PUBLIC_URL ?? 'https://pk.pekzho.com';
const LINK_MINUTES = 10;
const WATCH_EVERY_MS = 2500;

type LinkState = 'waiting' | 'linked' | 'expired' | 'failed';
interface LoginLink { userId: string; state: LinkState; liveViewUrl: string; expiresAt: number }

const linksByToken = new Map<string, LoginLink>();
const openLinkByUser = new Map<string, string>(); // userId → token, while 'waiting'

export const loginLinkUrl = (token: string) => `${PUBLIC_BASE_URL}/attendance/login/${token}`;

// 🎯 Which tab should the user be looking at? Google's sign-in popup while it's
// open, otherwise Razorpay.
const pickTabToShow = (tabs: Awaited<ReturnType<typeof liveViewTabs>>) =>
  tabs.find((t) => /accounts\.google\.com/.test(t.url)) ?? tabs.find((t) => /razorpay\.com/.test(t.url)) ?? tabs[0];

export interface LoginLinkCallbacks {
  whenLinked: () => Promise<void>;    // signed in 🎉 (the profile is saved by then)
  whenAbandoned: () => Promise<void>; // expired or broke before they finished
}

// 🚀 Returns the URL to send. Re-asking while a link is still open re-sends the
// same one instead of starting (and paying for) a second Chrome.
export const startLoginLink = async (userId: string, browserProfileId: string, callbacks: LoginLinkCallbacks): Promise<string> => {
  const openToken = openLinkByUser.get(userId);
  if (openToken && linksByToken.get(openToken)?.state === 'waiting') return loginLinkUrl(openToken);

  const live = await startBrowser(browserProfileId, LINK_MINUTES * 60 + 60);
  let browser;
  try {
    browser = await chromium.connectOverCDP(live.connectUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? await context.newPage();
    await pinBrowserTimezone(context, page);
    await page.goto(RAZORPAY_LOGIN_URL, { waitUntil: 'domcontentloaded' });
    const firstTab = pickTabToShow(await liveViewTabs(live.id));
    if (!firstTab) throw new Error('no live-view tab');

    const token = randomBytes(18).toString('base64url');
    const link: LoginLink = { userId, state: 'waiting', liveViewUrl: firstTab.liveViewUrl, expiresAt: Date.now() + LINK_MINUTES * 60_000 };
    linksByToken.set(token, link);
    openLinkByUser.set(userId, token);
    console.log(`🔗 login link opened for ${userId} (browser ${live.id})`);

    // 👀 Watch in the background — the WhatsApp turn must not wait 10 minutes.
    const connected = browser;
    void (async () => {
      let finalState: LinkState = 'expired';
      try {
        while (Date.now() < link.expiresAt && connected.isConnected()) {
          if (context.pages().some((p) => ON_ATTENDANCE_PAGE.test(p.url()))) {
            finalState = 'linked';
            await page.waitForTimeout(2000); // 🍪 let Razorpay finish setting its cookies
            break;
          }
          const tab = pickTabToShow(await liveViewTabs(live.id).catch(() => []));
          if (tab) link.liveViewUrl = tab.liveViewUrl;
          await new Promise((r) => setTimeout(r, WATCH_EVERY_MS));
        }
        if (!connected.isConnected() && finalState !== 'linked') finalState = 'failed';
      } catch (e: any) {
        finalState = 'failed';
        console.error(`🔗 login link for ${userId} broke: ${e.message}`);
      }
      // 💾 release FIRST — that's when Browserbase saves the profile
      await connected.close().catch(() => {});
      await releaseBrowser(live.id);
      link.state = finalState;
      if (openLinkByUser.get(userId) === token) openLinkByUser.delete(userId);
      setTimeout(() => linksByToken.delete(token), 30 * 60_000); // 🧹 page can still say "done" for a while
      console.log(`🔗 login link for ${userId} ended: ${finalState}`);
      try {
        if (finalState === 'linked') await callbacks.whenLinked();
        else await callbacks.whenAbandoned();
      } catch (e: any) {
        console.error(`🔗 after-link step for ${userId} failed: ${e.message}`);
      }
    })();

    return loginLinkUrl(token);
  } catch (e) {
    await browser?.close().catch(() => {});
    await releaseBrowser(live.id);
    throw e;
  }
};

// --------------------------------------------------------------------------
// 🌍 HTTP side: GET /attendance/login/<token>        → the page
//               GET /attendance/login/<token>/view   → {state, liveViewUrl} (polled)
// --------------------------------------------------------------------------
export const LOGIN_LINK_PATH = /^\/attendance\/login\/([\w-]{20,40})(\/view)?$/;

export const serveLoginLink = (token: string, wantsView: boolean, res: ServerResponse) => {
  const link = linksByToken.get(token);
  const noStore = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' };
  if (wantsView) {
    res.writeHead(link ? 200 : 404, { 'Content-Type': 'application/json', ...noStore });
    res.end(JSON.stringify(link
      ? { state: link.state, liveViewUrl: link.state === 'waiting' ? link.liveViewUrl : null }
      : { state: 'expired', liveViewUrl: null }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...noStore });
  res.end(LOGIN_PAGE_HTML);
};

// 📄 One self-contained page: a slim instruction bar + the live view filling
// the rest of the phone screen. It polls /view every 2s and swaps the iframe
// only when the tab to show actually changes (so typing isn't interrupted).
const LOGIN_PAGE_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>pekzho · Razorpay sign-in</title>
<style>
  :root { --bg:#0f1115; --card:#181b22; --text:#e8eaf0; --muted:#9aa1b2; --accent:#22c55e; }
  @media (prefers-color-scheme: light) { :root { --bg:#f6f7f9; --card:#fff; --text:#14161b; --muted:#5b6170; } }
  * { box-sizing:border-box; } html,body { margin:0; height:100%; background:var(--bg); color:var(--text);
    font:15px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .wrap { display:flex; flex-direction:column; height:100dvh; }
  header { padding:10px 16px; background:var(--card); border-bottom:1px solid #0002; }
  header b { display:block; } header small { color:var(--muted); }
  iframe { flex:1; width:100%; border:0; background:#fff; }
  .msg { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:24px; gap:8px; }
  .msg .big { font-size:48px; }
</style></head><body><div class="wrap">
<header><b>🔐 Sign in to Razorpay Payroll</b>
<small id="hint">Tap <b>Sign in with Google</b> and finish signing in. This page follows along by itself.</small></header>
<iframe id="view" allow="clipboard-read; clipboard-write" hidden></iframe>
<div class="msg" id="msg"><div class="big">⏳</div><div>Opening Razorpay…</div></div>
</div><script>
  const token = location.pathname.split('/')[3];
  const frame = document.getElementById('view'), msg = document.getElementById('msg'), hint = document.getElementById('hint');
  const show = (emoji, text) => { frame.hidden = true; frame.src = 'about:blank'; msg.hidden = false; msg.innerHTML = '<div class="big">' + emoji + '</div><div>' + text + '</div>'; };
  let current = '';
  const poll = async () => {
    try {
      const r = await fetch('/attendance/login/' + token + '/view', { cache: 'no-store' });
      const v = await r.json();
      if (v.state === 'linked') { hint.textContent = 'All done.'; return show('✅', 'Signed in! You can close this and go back to WhatsApp.'); }
      if (v.state !== 'waiting') return show('⌛', 'This link has expired. Send <b>check in</b> to pekzho on WhatsApp for a new one.');
      if (v.liveViewUrl && v.liveViewUrl !== current) {
        current = v.liveViewUrl; frame.src = current; frame.hidden = false; msg.hidden = true;
      }
    } catch (e) { /* network blip — try again next tick */ }
    setTimeout(poll, 2000);
  };
  poll();
</script></body></html>`;
