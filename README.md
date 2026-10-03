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
| `src/scheduler.ts` | ⏲️ 1-minute tick → each skill's `everyMinute` (daily reminder) |
| `src/db.ts` | 🐘 Pool + idempotent schema (DB `pekzho_whatsapp` in `pektown-pg`) |
| `refrences/` | Cloned `pi` + `FlowTalkr` for reading (gitignored, not in the image) |

## 🐘 Tables
`users` (**`user_id` = the WhatsApp number the message came from**, e.g. `919820011185`) ·
`habits` · `habit_logs` (one done/skipped per habit per day) · `conversations` (pekzho's chat memory).

## 🎯 Habits skill (FlowTalkr parity)
`addhabit` → asks for a name → saves it · `listhabits` → one message per habit with ✅ Done / ⏭️ Skip buttons ·
`stats <habit>` → emoji calendar + streaks · `help` · daily checklist at `HABIT_REMINDER_TIME` (only to users inside
WhatsApp's 24h window — outside it needs an approved template). Anything else → the LLM, which has the same
abilities as tools (`add_habit`, `mark_habit`, `list_habits`, `delete_habit`, `send_habit_checklist`, `send_habit_stats`).

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
