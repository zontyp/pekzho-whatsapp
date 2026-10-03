// ============================================================================
// 📲 Pekzho-WhatsApp — the webhook front door for the pekzho agent.
//
// Meta's WhatsApp Cloud API calls https://pk.pekzho.com/webhook → Caddy → here.
//   GET  /webhook → one-time verify handshake (echo hub.challenge if token matches)
//   POST /webhook → inbound messages + status receipts. We ACK 200 fast, then
//                   hand each message to pekzho (src/pekzho/agent.ts).
//   GET  /healthz → liveness for docker / curl pokes.
//   GET  /attendance/login/<token>[/view] → the attendance skill's one-time sign-in page
//
// Plain node:http, no framework. Node ≥22.18 runs these .ts files directly
// (type stripping), so there's no build step either. 🪶
// ============================================================================

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { markReadAndShowTyping } from './whatsapp.ts';
import { ensureSchema, touchUser } from './db.ts';
import { pekzhoHandle } from './pekzho/agent.ts';
import { userContextFor } from './pekzho/user-context.ts';
import { startScheduler } from './scheduler.ts';
import type { InboundTurn } from './skills/types.ts';
import { LOGIN_LINK_PATH, serveLoginLink } from './skills/attendance/login-link.ts';

// ⚙️ Config — everything comes from env (see .env.example). Fail loud at boot
// rather than silently 403-ing Meta at 3 AM.
const PORT         = Number(process.env.PORT ?? 3000);
const VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? '';
const APP_SECRET   = process.env.WHATSAPP_APP_SECRET ?? ''; // optional until wired
if (!VERIFY_TOKEN) console.warn('⚠️  WHATSAPP_WEBHOOK_VERIFY_TOKEN is empty — Meta verify handshakes will 403');
if (!APP_SECRET)   console.warn('⚠️  WHATSAPP_APP_SECRET is empty — POST signatures are NOT being checked');

// 🧾 The bits of Meta's webhook payload we actually touch. Their schema is much
// bigger; we type only what we read so the compiler keeps us honest.
interface InboundMessage {
  id: string;            // wamid — unique per message, used for dedupe + read receipts
  from: string;          // sender's phone in E.164 without the "+", e.g. "9198xxxxxxx"
  type: string;          // text | image | audio | button | interactive | ...
  text?: { body: string };
  // 🔘 taps on our reply buttons / list rows come back as type=interactive
  interactive?: {
    type: 'button_reply' | 'list_reply' | string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
  // 🎙️ voice notes (voice: true) and other audio files
  audio?: { id: string; mime_type?: string; voice?: boolean };
  // 🔘 taps on template quick-reply buttons come back as type=button
  button?: { payload: string; text: string };
}

// 🧽 Flatten Meta's many message shapes into the one InboundTurn skills understand.
const toInboundTurn = (msg: InboundMessage): InboundTurn => {
  if (msg.type === 'text') return { kind: 'text', text: msg.text?.body ?? '', rawType: msg.type };
  const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
  if (reply) return { kind: 'button', text: reply.title, buttonId: reply.id, rawType: msg.type };
  if (msg.button) return { kind: 'button', text: msg.button.text, buttonId: msg.button.payload, rawType: msg.type };
  if (msg.type === 'audio' && msg.audio?.id) return { kind: 'voice', text: '', mediaId: msg.audio.id, mimeType: msg.audio.mime_type ?? 'audio/ogg', rawType: msg.type };
  return { kind: 'other', text: '', rawType: msg.type };
};
interface WebhookPayload {
  entry?: Array<{
    changes?: Array<{
      field?: string;    // "messages" | "message_template_status_update" | …
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: Array<{ wa_id: string; profile?: { name?: string } }>;
        messages?: InboundMessage[];
        statuses?: unknown[];
      };
    }>;
  }>;
}

// 🔁 Meta retries webhooks it thinks failed, so the same wamid can show up twice.
// A small in-memory "already answered" set stops us double-replying. Lost on
// restart, which is fine for v0 — worst case is one duplicate Hello World.
const alreadyAnswered = new Set<string>();
const rememberAnswered = (id: string) => {
  alreadyAnswered.add(id);
  if (alreadyAnswered.size > 5000) alreadyAnswered.delete(alreadyAnswered.values().next().value!);
};

// 🥤 Slurp the raw request body. We need the exact bytes for HMAC validation,
// so no JSON parsing until after the signature check.
const readRawBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

// 🔏 Meta signs every POST with HMAC-SHA256(App Secret, raw body) in X-Hub-Signature-256.
const signatureLooksLegit = (raw: string, header: string | undefined): boolean => {
  if (!APP_SECRET) return true; // not wired yet → don't block bring-up
  const ours   = Buffer.from('sha256=' + createHmac('sha256', APP_SECRET).update(raw).digest('hex'));
  const theirs = Buffer.from(header ?? '');
  return ours.length === theirs.length && timingSafeEqual(ours, theirs);
};

const send = (res: ServerResponse, status: number, body: string) => {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
};

// 🤝 GET /webhook — Meta's "are you really the owner of this URL?" handshake.
const handleVerifyHandshake = (url: URL, res: ServerResponse) => {
  const mode      = url.searchParams.get('hub.mode');
  const token     = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge') ?? '';
  if (mode === 'subscribe' && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    console.log('🤝 webhook verified by Meta ✅');
    return send(res, 200, challenge);
  }
  console.warn('🚫 webhook verify FAILED — token mismatch or wrong mode');
  return send(res, 403, 'Forbidden');
};

// 💬 Answer one inbound message. Runs AFTER we've ACKed Meta, so any slowness or
// Graph API hiccup here can never make Meta think the webhook is broken.
const answerMessage = async (msg: InboundMessage, senderName: string | undefined) => {
  if (alreadyAnswered.has(msg.id)) {
    console.log(`🔁 duplicate delivery of ${msg.id} — skipping`);
    return;
  }
  rememberAnswered(msg.id);

  const turn = toInboundTurn(msg);
  console.log(`📥 from=${msg.from} name=${senderName ?? '?'} kind=${turn.kind} ${turn.buttonId ? `button=${turn.buttonId} ` : ''}text=${JSON.stringify(turn.text)}`);

  // 👀 Blue ticks + "typing…" while pekzho thinks (best-effort, never blocks).
  markReadAndShowTyping(msg.id).catch((e) => console.warn(`👀 read/typing failed: ${e.message}`));
  // 👤 users.user_id = the number this message came from
  await touchUser(msg.from, senderName);
  await pekzhoHandle(turn, userContextFor(msg.from, senderName));
};

// 📬 POST /webhook — the main event.
const handleInboundEvent = async (req: IncomingMessage, res: ServerResponse) => {
  const raw = await readRawBody(req);

  if (!signatureLooksLegit(raw, req.headers['x-hub-signature-256'] as string | undefined)) {
    console.warn('🔐 POST rejected — bad X-Hub-Signature-256');
    return send(res, 401, 'invalid signature');
  }

  let payload: WebhookPayload;
  try { payload = JSON.parse(raw); }
  catch { return send(res, 400, 'bad json'); }

  // ⏱️ ACK first, think later — Meta wants a 200 within a few seconds.
  send(res, 200, 'EVENT_RECEIVED');

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      // 📜 Meta's verdict on a template we submitted (APPROVED / REJECTED / PAUSED …)
      if (change.field === 'message_template_status_update') {
        console.log('📜 template status update:', JSON.stringify(value).slice(0, 300));
        continue;
      }
      if (!value?.messages?.length) {
        // 📨 delivered/read receipts + account updates. Just a peek in the logs.
        if (value?.statuses?.length) console.log('📨 status event:', JSON.stringify(value.statuses).slice(0, 200));
        continue;
      }
      const nameOf = (waId: string) => value.contacts?.find((c) => c.wa_id === waId)?.profile?.name;
      for (const msg of value.messages) {
        answerMessage(msg, nameOf(msg.from)).catch((e) =>
          console.error(`💥 failed to answer ${msg.id} from ${msg.from}: ${e.message}`));
      }
    }
  }
};

// 🚦 Tiny router — three routes don't deserve a framework (yet).
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/healthz') return send(res, 200, 'ok');
  // 🔗 the attendance skill's one-time Razorpay sign-in page (+ its poll endpoint)
  const loginLink = req.method === 'GET' ? url.pathname.match(LOGIN_LINK_PATH) : null;
  if (loginLink) return serveLoginLink(loginLink[1], Boolean(loginLink[2]), res);
  if (url.pathname === '/webhook' && req.method === 'GET')  return handleVerifyHandshake(url, res);
  if (url.pathname === '/webhook' && req.method === 'POST') {
    return void handleInboundEvent(req, res).catch((e) => {
      console.error('💥 webhook handler crashed:', e);
      if (!res.headersSent) send(res, 500, 'error');
    });
  }
  return send(res, 404, 'not found');
});

// 🏁 Schema first (so the very first message can't hit a missing table), then
// open the doors and arm the reminder clock.
await ensureSchema();
server.listen(PORT, () => console.log(`🚀 pekzho listening on :${PORT}`));
startScheduler();

// 🛑 Be polite to `docker stop` — finish in-flight requests, then exit.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => { console.log(`👋 ${sig} — shutting down`); server.close(() => process.exit(0)); });
}
