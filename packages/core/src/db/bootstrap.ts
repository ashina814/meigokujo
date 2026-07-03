import Database from "better-sqlite3";

/**
 * スキーマは追記専用の台帳を中心に設計されている（経済設計.md §3）。
 * transactions への UPDATE/DELETE は一切行わない。訂正は逆取引（reversal_of）で表現する。
 */
const DDL = `
CREATE TABLE IF NOT EXISTS accounts (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('user','system')),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  from_account    TEXT NOT NULL REFERENCES accounts(id),
  to_account      TEXT NOT NULL REFERENCES accounts(id),
  amount          INTEGER NOT NULL CHECK (amount > 0),
  type            TEXT NOT NULL,
  reason          TEXT,
  ref_type        TEXT,
  ref_id          TEXT,
  actor_id        TEXT NOT NULL,
  approved_by     TEXT,
  reversal_of     INTEGER REFERENCES transactions(id),
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_from ON transactions(from_account, created_at);
CREATE INDEX IF NOT EXISTS idx_tx_to ON transactions(to_account, created_at);
CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(type, created_at);
CREATE INDEX IF NOT EXISTS idx_tx_reversal ON transactions(reversal_of);

CREATE TABLE IF NOT EXISTS balances (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  amount     INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(delivered_at) WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS salary_table (
  role_id    TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  amount     INTEGER NOT NULL CHECK (amount >= 0),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  type         TEXT NOT NULL,
  actor_id     TEXT,
  target_id    TEXT,
  payload_json TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, created_at);
CREATE INDEX IF NOT EXISTS idx_events_target ON events(target_id, created_at);

CREATE TABLE IF NOT EXISTS souls (
  user_id             TEXT PRIMARY KEY,
  status              TEXT NOT NULL DEFAULT 'waiting'
                      CHECK (status IN ('waiting','ghost','majin','mazoku','meirei','departed')),
  joined_at           INTEGER,
  ghost_at            INTEGER,
  eval_deadline_at    INTEGER,
  eval_extension_days INTEGER NOT NULL DEFAULT 0,
  inviter_user_id     TEXT,
  inviter_source      TEXT,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entry_bookings (
  user_id         TEXT PRIMARY KEY,
  slot            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'booked'
                  CHECK (status IN ('booked','attended','ghosted','dropped')),
  inviter_user_id TEXT,
  inviter_source  TEXT NOT NULL DEFAULT 'none',
  no_show_count   INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_slot ON entry_bookings(slot, status);

CREATE TABLE IF NOT EXISTS invites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  inviter_id TEXT NOT NULL,
  invitee_id TEXT NOT NULL UNIQUE,
  credited_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS marks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id  TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('promotion','demotion')),
  granted_by TEXT NOT NULL,
  ref        TEXT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_marks_target ON marks(target_id, kind);

CREATE TABLE IF NOT EXISTS evaluations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id    TEXT NOT NULL,
  evaluator_id TEXT NOT NULL,
  scores_json  TEXT NOT NULL,
  texts_json   TEXT NOT NULL,
  conclusion   TEXT NOT NULL CHECK (conclusion IN ('promotion','demotion','none')),
  mark_id      INTEGER REFERENCES marks(id),
  thread_id    TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eval_target ON evaluations(target_id, created_at);

CREATE TABLE IF NOT EXISTS eval_threads (
  user_id   TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vc_segments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  self_muted    INTEGER NOT NULL DEFAULT 0,
  self_deafened INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_vc_user ON vc_segments(user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_vc_open ON vc_segments(ended_at) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vc_channel ON vc_segments(channel_id, started_at);

CREATE TABLE IF NOT EXISTS tickets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id   TEXT NOT NULL UNIQUE,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','closed')),
  claimed_by  TEXT,
  reminded_at INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS migration_staging (
  rank         INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL,
  amount       INTEGER NOT NULL CHECK (amount > 0),
  status       TEXT NOT NULL
               CHECK (status IN ('auto','ambiguous','over_cap','unmatched','ready','done','excluded')),
  user_id      TEXT,
  note         TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payout_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  period      TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft','approved','executed','cancelled')),
  plan_json   TEXT NOT NULL,
  report_json TEXT,
  created_by  TEXT NOT NULL,
  approved_by TEXT,
  executed_at INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
`;

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  if (path !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  db.pragma("foreign_keys = ON");
  db.exec(DDL);
  return db;
}
