// ============================================================================
// 🌐 Browserbase — rented Chrome in the cloud (https://browserbase.com).
// We use it for one thing: sites with no API, where pekzho has to click a
// button like a human would (Razorpay Payroll's "Check In", for now).
//
// Three ideas, all plain REST (no SDK needed):
//   • profile  = a Browserbase "context": saved cookies + storage that outlive
//                a single browser. One per user → their logins stick around.
//   • browser  = a Browserbase "session": one live Chrome. Playwright drives it
//                over CDP via connectUrl. Billed by the minute → always release!
//   • live view= a URL that streams ONE TAB of that Chrome and accepts taps +
//                typing — how a human signs in once. ⚠️ It's per tab, so popups
//                (Google sign-in!) get their own URL.
// ============================================================================

const API = 'https://api.browserbase.com/v1';
const API_KEY = process.env.BROWSERBASE_API_KEY ?? '';
const PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID || undefined; // optional on newer keys

export const browserbaseEnabled = () => Boolean(API_KEY);

// 💸 Browserbase says 402 when the plan's browser minutes are used up — not a
// "busy, retry in a minute" situation; it stays broken until the plan changes.
export const isOutOfBrowserMinutes = (e: unknown) => /→ 402/.test(String((e as Error)?.message ?? e));

// 📱 Phone-sized window: Razorpay + Google render their mobile layouts, and the
// live view fills a phone screen without pinch-zooming.
const PHONE_VIEWPORT = { width: 412, height: 860 };

const callBrowserbase = async (path: string, init: { method?: string; body?: unknown } = {}): Promise<any> => {
  const r = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    // 📭 Content-Type only WITH a body — Browserbase 400s an empty "JSON" body
    // (that's how "unlink attendance" silently failed to delete a profile)
    headers: { 'X-BB-API-Key': API_KEY, ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Browserbase ${init.method ?? 'GET'} ${path} → ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
};

// 💾 A fresh, empty saved profile — one per user, made when they first link.
export const createBrowserProfile = async (): Promise<string> =>
  (await callBrowserbase('/contexts', { method: 'POST', body: { projectId: PROJECT_ID } })).id;

// 🗑️ Throw a profile (and every login saved in it) away — "unlink attendance".
export const deleteBrowserProfile = async (profileId: string): Promise<void> => {
  await callBrowserbase(`/contexts/${profileId}`, { method: 'DELETE' });
};

export interface LiveBrowser { id: string; connectUrl: string }

// 🚀 Start a Chrome on that profile. persist:true writes the cookies we end
// with back into the profile when the browser is released — that's what keeps
// the user's Google login alive between check-ins.
export const startBrowser = async (profileId: string, maxSeconds: number): Promise<LiveBrowser> => {
  const s = await callBrowserbase('/sessions', {
    method: 'POST',
    body: {
      projectId: PROJECT_ID,
      timeout: maxSeconds, // 🧯 Browserbase kills it after this even if we crash — caps the bill
      browserSettings: { viewport: PHONE_VIEWPORT, context: { id: profileId, persist: true } },
    },
  });
  return { id: s.id, connectUrl: s.connectUrl };
};

// 🛑 Stop billing + save the profile. Never throws — it runs in finally blocks.
export const releaseBrowser = async (browserId: string): Promise<void> => {
  await callBrowserbase(`/sessions/${browserId}`, { method: 'POST', body: { projectId: PROJECT_ID, status: 'REQUEST_RELEASE' } })
    .catch((e) => console.warn(`🌐 release ${browserId} failed: ${e.message}`));
};

// 📺 One live-view link per open tab. navbar=false hides Browserbase's own
// tab strip, so on a phone it's just the website.
export interface LiveTab { url: string; title: string; liveViewUrl: string }
export const liveViewTabs = async (browserId: string): Promise<LiveTab[]> => {
  const d = await callBrowserbase(`/sessions/${browserId}/debug`);
  return (d.pages ?? []).map((p: any) => ({ url: p.url ?? '', title: p.title ?? '', liveViewUrl: `${p.debuggerFullscreenUrl}&navbar=false` }));
};
