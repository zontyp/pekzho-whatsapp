# 📲 Pekzho-WhatsApp — the **pekzho** agent

Our own WhatsApp agent for **+91 81081 03360** (Cloud API, Phone Number ID `1140071969198046`), built on the
[pi agent framework](refrences/pi) (`@earendil-works/pi-agent-core` + `pi-ai`) with **DeepSeek** as the brain.
It replaced Hermes (`hm_5tgzd`) as the webhook target on 2026-10-02.

```
Meta ─POST─▶ pk.pekzho.com/webhook ─Caddy─▶ pekzho-whatsapp:3000 ─▶ ACK 200
                                              │
                                              ├─ ⚡ skill shortcuts (button taps, exact commands) — no LLM
                                              └─ 🧠 pi Agent (DeepSeek + skill tools + chat memory) ─▶ Graph API
```

## 🗂️ Layout
| Path | Job |
| --- | --- |
| `src/server.ts` | Webhook: verify handshake, HMAC check, dedupe, flatten Meta payload → `InboundTurn` |
| `src/whatsapp.ts` | Graph API: text, reply buttons, read+typing. `WHATSAPP_DRY_RUN=1` logs instead of sending |
| `src/pekzho/agent.ts` | 🤖 pekzho: shortcuts → else pi `Agent` run; per-user queue; memory in `conversations` |
| `src/skills/` | 🧩 Skills. `types.ts` = the contract; `index.ts` = registry |
| `src/skills/habits/` | 🎯 First skill: FlowTalkr's StreakSetGo habit tracker, re-implemented |
| `src/skills/attendance/` | 🕘 "check in" → Razorpay Payroll Check In, by driving a real Chrome on Browserbase |
| `src/browserbase.ts` | 🌐 Browserbase REST client: saved profiles, browsers, per-tab live-view links |
| `src/scheduler.ts` | ⏲️ 1-minute tick → each skill's `everyMinute` (daily reminder) |
| `src/db.ts` | 🐘 Pool + idempotent schema (DB `pekzho_whatsapp` in `pektown-pg`) |
| `refrences/` | Cloned `pi` + `FlowTalkr` for reading (gitignored, not in the image) |

## 🐘 Tables
`users` (**`user_id` = the WhatsApp number the message came from**, e.g. `919820011185`) ·
`habits` · `habit_logs` (one done/skipped per habit per day) · `conversations` (pekzho's chat memory) ·
`attendance_accounts` (each user's saved Browserbase profile id + when they linked Razorpay).

## 🎯 Habits skill (FlowTalkr parity)
`addhabit` → asks for a name → saves it · `listhabits` → one message per habit with ✅ Done / ⏭️ Skip buttons ·
`stats <habit>` → emoji calendar + streaks · `help` · daily checklist at `HABIT_REMINDER_TIME` (only to users inside
WhatsApp's 24h window — outside it needs an approved template). Anything else → the LLM, which has the same
abilities as tools (`add_habit`, `mark_habit`, `list_habits`, `delete_habit`, `send_habit_checklist`, `send_habit_stats`).

## 🕘 Attendance skill (Razorpay Payroll)
`check in` / `check out` / `attendance` (status) / `link attendance` / `unlink attendance`, or free-form via LLM tools
(`attendance_check_in`, `_check_out`, `_status`, `_unlink`). Runs in the background (~10–60s) and replies by itself;
one job per user at a time.
- **No API** — Razorpay's API wants a CSRF token that only lives in page memory, so `razorpay.ts` drives a real
  Chrome on **Browserbase** (`BROWSERBASE_API_KEY`). Each user has a **saved profile** holding their **Google login**;
  when Razorpay's own cookie (~4h) has expired, pekzho clicks *Sign in with Google* → saved account → back on
  /attendance with no human. Password login was rejected: Razorpay emails an OTP on every login.
- **First time / Google re-asks** → a one-time link `pk.pekzho.com/attendance/login/<token>` (Caddy route
  `/attendance/login/*`, 10 min, in-memory). The page embeds Browserbase's live view and **follows the Google popup
  tab** (a plain live-view link only shows one tab). Tokens are bearer secrets → redacted from logs.
- ⚠️ **Wrong-day guard:** Browserbase Chrome runs on UTC and Razorpay takes "today" from the browser, so we pin the
  browser to `PEKZHO_TIMEZONE` AND refuse to click unless the page's "Mark attendance for today (4th Oct 2026)"
  banner matches. Check-in = `POST /v2/api/attendance/check-in {"location":"-1"}`.
- ⚠️ A saved profile = a full Google session for that user, on Browserbase. `unlink attendance` deletes it.
- Testing: `attendance` (status) and `check in` when already checked in are read-only — safe for dry-run tests.

## ➕ Adding a skill
New folder `src/skills/<name>/` exporting a `Skill` (`prompt`, `tools`, optional `shortcut` / `everyMinute`), then one line in `src/skills/index.ts`.

## 🔁 Deploy / test
```bash
./run.sh             # rebuild + replace container (after any src/ change)
./run.sh --no-build  # env-only change
docker logs -f pekzho-whatsapp
npm run typecheck
```
Dry-run test: run a second container with `-e WHATSAPP_DRY_RUN=1 --name pekzho-test` and POST Meta-shaped payloads to `http://pekzho-test:3000/webhook` from inside `openclaw-net`.

`.env` (gitignored, 0600): verify token, Graph token, `DATABASE_URL`, `DEEPSEEK_API_KEY` (same upstream key pektown-api uses
for HInstaBot / InstawebsBot), `PEKZHO_MODEL`, `PEKZHO_TIMEZONE`, `HABIT_REMINDER_TIME`. See `.env.example`.

## ⏪ Rollback to Hermes
Point the Caddyfile `pk.pekzho.com` block back to `pektown-api:3000`, rewrite the file in place (`cat new > Caddyfile`),
then `docker exec caddy caddy reload --config /etc/caddy/Caddyfile`. Backup: `caddy/Caddyfile.bak-pre-pekzho-whatsapp`.
