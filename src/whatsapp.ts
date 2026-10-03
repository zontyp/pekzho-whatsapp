// ============================================================================
// 📡 Graph API helpers — the "mouth" of the bot. Everything that talks BACK to
// WhatsApp lives here so the agent + skills never have to know about HTTP.
// ============================================================================

const TOKEN         = process.env.WHATSAPP_CLOUD_TOKEN ?? '';
const PHONE_NUMBER  = process.env.WHATSAPP_PHONE_NUMBER_ID ?? '';
const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION ?? 'v25.0';
if (!TOKEN || !PHONE_NUMBER) console.warn('⚠️  WHATSAPP_CLOUD_TOKEN / WHATSAPP_PHONE_NUMBER_ID missing — replies will fail');

const MESSAGES_URL = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER}/messages`;

// 📏 WhatsApp's hard limits — Graph 400s if we go over, so we trim client-side.
const MAX_TEXT_CHARS    = 4096;
const MAX_BUTTON_TITLE  = 20;
const MAX_BUTTONS       = 3;

// 📮 One POST to /<phone_number_id>/messages; throws with Meta's error text on non-2xx
// so the caller's log line says exactly what Meta was grumpy about.
// 🧪 WHATSAPP_DRY_RUN=1 → log what we WOULD send and pretend it worked. Lets you
// replay fake webhooks end-to-end without messaging a real human.
export const DRY_RUN = process.env.WHATSAPP_DRY_RUN === '1';
// 🧪 the fake numbers dry-run tests use — dry-run reminders touch ONLY these, since
// the test container shares the live DB with real users
export const DRY_RUN_TEST_USER_PREFIX = '9100000000';
if (DRY_RUN) console.warn('🧪 WHATSAPP_DRY_RUN=1 — nothing will actually be sent to WhatsApp');

const postToGraph = async (body: Record<string, unknown>): Promise<any> => {
  if (DRY_RUN) {
    console.log(`🧪 [dry-run] would POST ${JSON.stringify(body)}`);
    return { messages: [{ id: 'dry-run' }] };
  }
  const r = await fetch(MESSAGES_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Graph ${r.status}: ${JSON.stringify(json?.error ?? json).slice(0, 300)}`);
  return json;
};

const clip = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max - 1) + '…');

// 💬 Free-form text. Only allowed inside the 24h customer-service window — which is
// always true when we're replying to something they just sent us. Returns the wamid.
export const sendText = async (to: string, text: string): Promise<string> => {
  const json = await postToGraph({
    recipient_type: 'individual', to, type: 'text',
    text: { body: clip(text, MAX_TEXT_CHARS), preview_url: false },
  });
  return json?.messages?.[0]?.id ?? '?';
};

// 🔘 A message with up to 3 tappable "reply buttons". A tap comes back to our
// webhook as type=interactive / button_reply with the button's `id` — that's how
// the habit checklist's ✅ / ❌ taps find their way home.
export interface ReplyButton { id: string; title: string }
export const sendButtons = async (to: string, body: string, buttons: ReplyButton[]): Promise<string> => {
  const json = await postToGraph({
    recipient_type: 'individual', to, type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: clip(body, 1024) },
      action: {
        buttons: buttons.slice(0, MAX_BUTTONS).map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: clip(b.title, MAX_BUTTON_TITLE) },
        })),
      },
    },
  });
  return json?.messages?.[0]?.id ?? '?';
};

// 📜 An approved template — the ONLY thing WhatsApp lets us send outside the
// 24h customer-service window. Quick-reply payloads come back to the webhook
// as type=button with button.payload, and that tap re-opens the 24h window.
export const sendTemplate = async (
  to: string, name: string, language: string, bodyParams: string[], quickReplyPayloads: string[] = [],
): Promise<string> => {
  // 🧽 Meta rejects template params with newlines/tabs or 4+ spaces in a row.
  const cleanParam = (s: string) => s.replace(/[\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim() || '-';
  const components: any[] = [];
  if (bodyParams.length) components.push({ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: cleanParam(t) })) });
  quickReplyPayloads.forEach((payload, i) =>
    components.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload }] }));
  const json = await postToGraph({
    recipient_type: 'individual', to, type: 'template',
    template: { name, language: { code: language }, components },
  });
  return json?.messages?.[0]?.id ?? '?';
};

// ✅ Has Meta approved this template yet? (PENDING / REJECTED / PAUSED → false)
// Asked once per reminder run, so a template still in review is never attempted.
const WABA_ID = process.env.WHATSAPP_WABA_ID ?? '';
export const templateStatus = async (name: string, language: string): Promise<string> => {
  // 🧪 dry-run can pretend Meta already ruled (e.g. =APPROVED) to exercise the template path
  if (DRY_RUN && process.env.WHATSAPP_DRY_RUN_TEMPLATE_STATUS) return process.env.WHATSAPP_DRY_RUN_TEMPLATE_STATUS;
  if (!WABA_ID) return 'NO_WABA_ID';
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${WABA_ID}/message_templates?name=${encodeURIComponent(name)}&fields=name,status,language`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const json: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Graph ${r.status}: ${JSON.stringify(json?.error ?? json).slice(0, 300)}`);
  const match = (json?.data ?? []).find((t: any) => t.name === name && t.language === language);
  return match?.status ?? 'NOT_FOUND';
};

// 📥 Fetch an inbound media file (voice note, image…). Two hops: the media id
// resolves to a short-lived lookaside URL, which ALSO needs our bearer token.
const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // 🧯 OpenAI's transcription cap (WA voice notes are far smaller)
export const downloadMedia = async (mediaId: string): Promise<{ data: Buffer; mimeType: string }> => {
  // 🧪 dry-run tests can point a fake voice note at a local file: id "dryrun-file:/path.ogg"
  if (DRY_RUN && mediaId.startsWith('dryrun-file:')) {
    const { readFile } = await import('node:fs/promises');
    return { data: await readFile(mediaId.slice('dryrun-file:'.length)), mimeType: 'audio/ogg' };
  }
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const meta = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, { headers: auth });
  const info: any = await meta.json().catch(() => ({}));
  if (!meta.ok || !info?.url) throw new Error(`media lookup ${meta.status}: ${JSON.stringify(info?.error ?? info).slice(0, 200)}`);
  if (Number(info.file_size) > MAX_MEDIA_BYTES) throw new Error(`media too large (${info.file_size} bytes)`);
  const file = await fetch(info.url, { headers: auth });
  if (!file.ok) throw new Error(`media download ${file.status}`);
  return { data: Buffer.from(await file.arrayBuffer()), mimeType: info.mime_type ?? 'audio/ogg' };
};

// 👀 Blue ticks + "typing…" bubble in one call. The bubble shows until we reply
// (or ~25s), which covers the LLM thinking time nicely.
export const markReadAndShowTyping = async (messageId: string): Promise<void> => {
  await postToGraph({ status: 'read', message_id: messageId, typing_indicator: { type: 'text' } });
};
