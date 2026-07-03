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
