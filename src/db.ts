// ============================================================================
// 🐘 Postgres — one shared pool + idempotent schema setup on boot.
// Lives in its own `pekzho_whatsapp` database inside the pektown-pg instance.
// ============================================================================

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
if (!DATABASE_URL) console.warn('⚠️  DATABASE_URL is empty — every DB call will fail');

export const db = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
db.on('error', (e) => console.error('🐘 idle pg client error:', e.message));

// 🏗️ Schema. Every statement is IF NOT EXISTS, so running this on every boot is
// safe and there's no separate migration tool to forget about. When a change
// isn't additive, add a new numbered block below rather than editing old ones.
const SCHEMA = `
  -- 👤 one row per WhatsApp user. user_id = the WhatsApp number the message came from
  --    (Meta's wa_id: country code + number, no '+', e.g. '919820011185')
  CREATE TABLE IF NOT EXISTS users (
    user_id          text PRIMARY KEY,
    display_name     text,
    adding_habit     boolean NOT NULL DEFAULT false,   -- FlowTalkr's user_state.is_adding_habit
    last_inbound_at  timestamptz,                      -- 24h customer-service window check
    last_reminded_on date,                             -- so the daily reminder fires once/day
    created_at       timestamptz NOT NULL DEFAULT now()
  );

  -- 🎯 FlowTalkr's user_habits
  CREATE TABLE IF NOT EXISTS habits (
    id         bigserial PRIMARY KEY,
    user_id    text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS habits_user_name_uq ON habits (user_id, lower(btrim(name)));

  -- ✅ FlowTalkr's user_habits_done — one verdict per habit per day, last tap wins
  CREATE TABLE IF NOT EXISTS habit_logs (
    habit_id   bigint NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
    log_date   date   NOT NULL,
    status     text   NOT NULL CHECK (status IN ('done', 'skipped')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (habit_id, log_date)
  );

  -- 🧠 pekzho's rolling chat memory per user (pi AgentMessage[] minus the system prompt)
  CREATE TABLE IF NOT EXISTS conversations (
    user_id    text PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    messages   jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  -- 🆕 v2 (2026-10-03) — onboarding state.
  --   is_user_new: true until the user adds their FIRST habit (any path: command,
  --                button, or LLM tool) — drives the welcome + "add a habit" nudges
  --   welcomed_at: when we sent the one-line intro, so it's only ever sent once
  ALTER TABLE users ADD COLUMN IF NOT EXISTS is_user_new boolean NOT NULL DEFAULT true;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS welcomed_at timestamptz;
  -- 🔕 v3 (2026-10-03) — STOP opt-out for business-initiated reminders (free-form AND template)
  ALTER TABLE users ADD COLUMN IF NOT EXISTS reminders_opt_out boolean NOT NULL DEFAULT false;
  -- 🕘 v4 (2026-10-04) — attendance skill: one Razorpay Payroll link per user.
  --   browser_profile_id: their saved Browserbase profile (holds the Google login
  --                       that lets pekzho sign in to Razorpay with no human)
  --   linked_at:          NULL until their first sign-in through the link succeeds
  CREATE TABLE IF NOT EXISTS attendance_accounts (
    user_id            text PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    browser_profile_id text NOT NULL,
    linked_at          timestamptz,
    last_punch_at      timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now()
  );
  -- 🏷️ v5 (2026-10-04) — a name the operator typed in by hand ("Mr. Tejkumar Ahuja")
  --    must survive the user's first message, which would otherwise overwrite it
  --    with their WhatsApp profile name.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS name_set_by_hand boolean NOT NULL DEFAULT false;
  -- 💸 v6 (2026-10-05) — operator's per-user switch for the PAID template reminder.
  --    Outside the 24h window a reminder can only go out as a marketing template
  --    (~₹1 each), so it's opt-IN per user, flipped by hand in Postgres:
  --      UPDATE users SET template_reminder_on = true  WHERE user_id = '91…';
  --    Inside the window the free checklist goes out regardless of this switch.
  --    ANY inbound message flips it back OFF (see touchUser) — re-enable by hand.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS template_reminder_on boolean NOT NULL DEFAULT false;
  -- 🧹 anyone who already has a habit is, by definition, not new (backfills old rows)
  UPDATE users u SET is_user_new = false
   WHERE u.is_user_new AND EXISTS (SELECT 1 FROM habits h WHERE h.user_id = u.user_id);
`;

export const ensureSchema = async () => {
  await db.query(SCHEMA);
  console.log('🐘 schema ready');
};

// 👋 Upsert the user on every inbound message — keeps their name fresh and
// stamps the 24h window clock.
export const touchUser = async (userId: string, displayName: string | undefined) => {
  await db.query(
    `INSERT INTO users (user_id, display_name, last_inbound_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE
       SET display_name = CASE WHEN users.name_set_by_hand THEN users.display_name   -- 🏷️ hand-set name wins
                               ELSE COALESCE(EXCLUDED.display_name, users.display_name) END,
           -- 💸 they replied → the 24h window is open (free messages again), so the
           --    paid template switch flips OFF; the operator re-enables it by hand
           template_reminder_on = false,
           last_inbound_at = now()`,
    [userId, displayName ?? null],
  );
};

// 🚩 The chatbot-level state flags pekzho reads at the start of every turn.
export interface UserFlags { isUserNew: boolean; welcomed: boolean }
export const getUserFlags = async (userId: string): Promise<UserFlags> => {
  const { rows } = await db.query('SELECT is_user_new, welcomed_at FROM users WHERE user_id = $1', [userId]);
  return { isUserNew: rows[0]?.is_user_new ?? true, welcomed: rows[0]?.welcomed_at != null };
};
export const markWelcomed = async (userId: string) => {
  await db.query('UPDATE users SET welcomed_at = COALESCE(welcomed_at, now()) WHERE user_id = $1', [userId]);
};
export const markNotNew = async (userId: string) => {
  await db.query('UPDATE users SET is_user_new = false WHERE user_id = $1 AND is_user_new', [userId]);
};
