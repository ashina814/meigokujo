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
  eval_started_at     INTEGER,
  eval_policy_version TEXT,
  eval_promotion_required INTEGER,
  eval_demotion_threshold INTEGER,
  eval_invite_mark_per_person REAL,
  eval_invite_mark_cap REAL,
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

CREATE TABLE IF NOT EXISTS rooms (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL CHECK (kind IN ('normal','mitsugetsu','oborozuki','game')),
  channel_id   TEXT NOT NULL UNIQUE,
  owner_id     TEXT NOT NULL,
  capacity     INTEGER NOT NULL DEFAULT 2,
  expires_at   INTEGER,
  warned_at    INTEGER,
  activated_at INTEGER,
  empty_since  INTEGER,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  pending_delete INTEGER NOT NULL DEFAULT 0 CHECK (pending_delete IN (0,1)),
  delete_attempts INTEGER NOT NULL DEFAULT 0,
  next_delete_retry_at INTEGER,
  close_reason TEXT,
  close_actor_id TEXT,
  closed_at INTEGER,
  unused_refund_tx_id INTEGER REFERENCES transactions(id),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rooms_open ON rooms(status) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS recruits (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id          INTEGER NOT NULL REFERENCES rooms(id),
  owner_id         TEXT NOT NULL,
  target_gender    TEXT NOT NULL CHECK (target_gender IN ('male','female')),
  purpose          TEXT NOT NULL,
  message          TEXT,
  panel_channel_id TEXT,
  panel_message_id TEXT,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','matched','expired','cancelled')),
  matched_user_id  TEXT,
  refund_tx_id     INTEGER REFERENCES transactions(id),
  updated_at       INTEGER,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recruits_open ON recruits(status, expires_at);

CREATE TABLE IF NOT EXISTS oborozuki_invites (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id   TEXT NOT NULL,
  target_id      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','accepted','declined','expired','cancelled')),
  token          TEXT NOT NULL UNIQUE,
  price          INTEGER NOT NULL CHECK (price >= 0),
  expires_at     INTEGER NOT NULL,
  room_id        INTEGER REFERENCES rooms(id),
  channel_id     TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  decided_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_oborozuki_invites_pending ON oborozuki_invites(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_oborozuki_invites_requester ON oborozuki_invites(requester_id, status);

CREATE TABLE IF NOT EXISTS marks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id  TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('promotion','demotion')),
  granted_by TEXT NOT NULL,
  ref        TEXT,
  weight     INTEGER NOT NULL DEFAULT 1 CHECK (weight > 0),
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
  mark_weight  INTEGER NOT NULL DEFAULT 0 CHECK (mark_weight >= 0),
  thread_id    TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eval_target ON evaluations(target_id, created_at);

CREATE TABLE IF NOT EXISTS eval_threads (
  user_id   TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS titles (
  user_id    TEXT NOT NULL,
  title_key  TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, title_key)
);
CREATE INDEX IF NOT EXISTS idx_titles_user ON titles(user_id);

CREATE TABLE IF NOT EXISTS vc_segments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  parent_id     TEXT,
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
  panel_id    TEXT,
  panel_name  TEXT,
  panel_notify_role_ids_json TEXT,
  panel_staff_role_ids_json  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ticket_panels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  button_label TEXT NOT NULL,
  button_emoji TEXT,
  notify_role_ids_json TEXT NOT NULL DEFAULT '[]',
  staff_role_ids_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  archived_at INTEGER,
  archived_by TEXT,
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
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

CREATE TABLE IF NOT EXISTS departments (
  key        TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  role_id    TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auctions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  description    TEXT,
  start_price    INTEGER NOT NULL CHECK (start_price >= 0),
  min_increment  INTEGER NOT NULL DEFAULT 1 CHECK (min_increment >= 1),
  current_bid    INTEGER,
  current_bidder TEXT,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','cancelled')),
  channel_id     TEXT,
  message_id     TEXT,
  ends_at        INTEGER NOT NULL,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auctions_open ON auctions(status, ends_at);

CREATE TABLE IF NOT EXISTS auction_bids (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_id INTEGER NOT NULL REFERENCES auctions(id),
  bidder_id  TEXT NOT NULL,
  amount     INTEGER NOT NULL CHECK (amount > 0),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auction_bids ON auction_bids(auction_id, created_at);

CREATE TABLE IF NOT EXISTS lotteries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','drawn','cancelled')),
  ticket_price   INTEGER NOT NULL CHECK (ticket_price > 0),
  house_edge_bps INTEGER NOT NULL DEFAULT 2000 CHECK (house_edge_bps >= 0 AND house_edge_bps <= 10000),
  pot            INTEGER NOT NULL DEFAULT 0,
  carryover_in   INTEGER NOT NULL DEFAULT 0,
  winner_id      TEXT,
  prize          INTEGER,
  rake           INTEGER,
  draws_at       INTEGER NOT NULL,
  channel_id     TEXT,
  message_id     TEXT,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lotteries_open ON lotteries(status, draws_at);

CREATE TABLE IF NOT EXISTS lottery_entries (
  lottery_id INTEGER NOT NULL REFERENCES lotteries(id),
  user_id    TEXT NOT NULL,
  qty        INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (lottery_id, user_id)
);

CREATE TABLE IF NOT EXISTS races (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT,
  horses_json    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','settled','cancelled')),
  house_edge_bps INTEGER NOT NULL DEFAULT 1000 CHECK (house_edge_bps >= 0 AND house_edge_bps <= 10000),
  pool           INTEGER NOT NULL DEFAULT 0,
  winner_index   INTEGER,
  starts_at      INTEGER NOT NULL,
  channel_id     TEXT,
  message_id     TEXT,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_races_open ON races(status, starts_at);

CREATE TABLE IF NOT EXISTS race_bets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id     INTEGER NOT NULL REFERENCES races(id),
  bettor_id   TEXT NOT NULL,
  horse_index INTEGER NOT NULL,
  amount      INTEGER NOT NULL CHECK (amount > 0),
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_race_bets ON race_bets(race_id, horse_index);

CREATE TABLE IF NOT EXISTS den_vcs (
  channel_id TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ether_balances (
  user_id    TEXT PRIMARY KEY,
  amount     INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shop_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  description       TEXT,
  price_land        INTEGER,
  price_alt_kind    TEXT,
  price_alt_amount  INTEGER,
  kind              TEXT NOT NULL CHECK (kind IN ('one_shot','monthly')),
  duration_days     INTEGER,
  require_role_id   TEXT,
  delivery          TEXT NOT NULL DEFAULT 'manual' CHECK (delivery IN ('auto','manual')),
  delivery_kind     TEXT,
  delivery_data     TEXT,
  stock             INTEGER,
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_items_enabled ON shop_items(enabled);

CREATE TABLE IF NOT EXISTS shop_purchases (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id          INTEGER NOT NULL REFERENCES shop_items(id),
  user_id          TEXT NOT NULL,
  purchased_at     INTEGER NOT NULL,
  expires_at       INTEGER,
  paid_land        INTEGER,
  paid_alt_kind    TEXT,
  paid_alt_amount  INTEGER,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','refunded','cancelled')),
  delivered_at     INTEGER,
  auto_renew       INTEGER NOT NULL DEFAULT 1,
  delivery_snapshot_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_shop_purchases_user ON shop_purchases(user_id, status);
CREATE INDEX IF NOT EXISTS idx_shop_purchases_expiry ON shop_purchases(status, expires_at);

CREATE TABLE IF NOT EXISTS shop_role_revocations (
  purchase_id INTEGER PRIMARY KEY REFERENCES shop_purchases(id),
  user_id     TEXT NOT NULL,
  role_id     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_shop_role_revocations_status ON shop_role_revocations(status, updated_at);

CREATE TABLE IF NOT EXISTS scheduler_chunk_batches (
  batch_key       TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed')),
  target_ids_json TEXT NOT NULL,
  role_ids_json   TEXT NOT NULL,
  chunks_json     TEXT,
  sent_chunks_json TEXT NOT NULL DEFAULT '[]',
  metadata_json   TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  sent_at         INTEGER,
  completed_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_scheduler_chunk_batches_kind ON scheduler_chunk_batches(kind, status, created_at);

CREATE TABLE IF NOT EXISTS rank_text (
  user_id       TEXT PRIMARY KEY,
  xp            INTEGER NOT NULL DEFAULT 0,
  messages      INTEGER NOT NULL DEFAULT 0,
  last_award_at INTEGER NOT NULL DEFAULT 0,
  last_tier     INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rank_voice (
  user_id       TEXT PRIMARY KEY,
  xp            INTEGER NOT NULL DEFAULT 0,
  minutes       INTEGER NOT NULL DEFAULT 0,
  last_award_at INTEGER NOT NULL DEFAULT 0,
  last_tier     INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bump_counts (
  user_id    TEXT PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 0,
  last_at    INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fiscal_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('tax','pension')),
  period      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','executed','cancelled')),
  plan_json   TEXT NOT NULL,
  report_json TEXT,
  created_by  TEXT NOT NULL,
  approved_by TEXT,
  executed_at INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (kind, period)
);

-- 称号判定は「自分が actor として何をしたか」を大量に数える。type だけの索引では
-- 該当 type を全走査して actor_id を絞ることになるため、actor 起点の索引を持つ。
CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor_id, type);
CREATE INDEX IF NOT EXISTS idx_tx_actor ON transactions(actor_id, type);

-- 同席台帳: 「誰と何秒 同じVCに居たか」の集計。vc_segments の自己結合は重いので、
-- セグメントが閉じるたびに加算し、判定時は1クエリで読めるようにする。
-- ペアは (user_id, other_id) の双方向で記録する（読み出しを片側だけで済ませるため）。
--
-- 「回数」の列は意図的に持たない。vc_segments はミュート/デフン切替やチャンネル移動の
-- たびに分割されるため、加算回数は「一緒にいた回数」にならず誤解を招く。
-- 必要になったら、結合済み区間から数える正しい実装と一緒に追加する。
CREATE TABLE IF NOT EXISTS vc_companions (
  user_id    TEXT NOT NULL,
  other_id   TEXT NOT NULL,
  seconds    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, other_id)
);
CREATE INDEX IF NOT EXISTS idx_vc_companions_user ON vc_companions(user_id, seconds DESC);

-- 旧カタログで付与された称号の引き継ぎ跡。旧行は消さずに残し、新キー行を足す方式なので
-- 「どの旧キーから写したか」を記録して冪等性と将来の整理手順を担保する。
CREATE TABLE IF NOT EXISTS title_key_migrations (
  user_id     TEXT NOT NULL,
  legacy_key  TEXT NOT NULL,
  new_key     TEXT NOT NULL,
  migrated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, legacy_key)
);

-- 装備称号: 獲得数が3桁になるため、カードに出すのは本人が選んだ数枠だけにする。
-- slot は 0 起点の表示順。title_key は titles(user_id, title_key) を持っている前提。
CREATE TABLE IF NOT EXISTS title_equips (
  user_id    TEXT NOT NULL,
  slot       INTEGER NOT NULL,
  title_key  TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, slot),
  UNIQUE (user_id, title_key)
);
`;

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  if (path !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  db.pragma("foreign_keys = ON");
  // マイグレーション: den_vcs.kind の古い CHECK 制約（応接室を弾く）を外すため作り直す。
  // 一時的な追跡データなので破棄して問題ない。
  const denSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='den_vcs'").get() as { sql?: string } | undefined)?.sql;
  if (denSql && denSql.includes("CHECK")) db.exec("DROP TABLE den_vcs");
  // マイグレーション: 旧カジノの chip_balances は ether_balances に置き換え（旧カジノは開帳前に廃止＝データ無し）
  db.exec("DROP TABLE IF EXISTS chip_balances");
  db.exec(DDL);
  ensureColumn(db, "vc_segments", "parent_id", "TEXT");
  ensureColumn(db, "marks", "weight", "INTEGER NOT NULL DEFAULT 1 CHECK (weight > 0)");
  ensureColumn(db, "evaluations", "mark_weight", "INTEGER NOT NULL DEFAULT 0 CHECK (mark_weight >= 0)");
  ensureColumn(db, "souls", "eval_started_at", "INTEGER");
  ensureColumn(db, "souls", "eval_policy_version", "TEXT");
  ensureColumn(db, "souls", "eval_promotion_required", "INTEGER");
  ensureColumn(db, "souls", "eval_demotion_threshold", "INTEGER");
  ensureColumn(db, "souls", "eval_invite_mark_per_person", "REAL");
  ensureColumn(db, "souls", "eval_invite_mark_cap", "REAL");
  ensureColumn(db, "rooms", "pending_delete", "INTEGER NOT NULL DEFAULT 0 CHECK (pending_delete IN (0,1))");
  ensureColumn(db, "rooms", "delete_attempts", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "rooms", "next_delete_retry_at", "INTEGER");
  ensureColumn(db, "rooms", "close_reason", "TEXT");
  ensureColumn(db, "rooms", "close_actor_id", "TEXT");
  ensureColumn(db, "rooms", "closed_at", "INTEGER");
  ensureColumn(db, "rooms", "unused_refund_tx_id", "INTEGER REFERENCES transactions(id)");
  ensureColumn(db, "recruits", "matched_user_id", "TEXT");
  ensureColumn(db, "recruits", "refund_tx_id", "INTEGER REFERENCES transactions(id)");
  ensureColumn(db, "recruits", "updated_at", "INTEGER");
  ensureColumn(db, "shop_purchases", "delivery_snapshot_json", "TEXT");
  ensureColumn(db, "scheduler_chunk_batches", "sent_at", "INTEGER");
  assertNoDuplicateOpenRoomOwnership(db);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_owner_normal_open
      ON rooms(owner_id)
      WHERE status = 'open' AND kind = 'normal';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_owner_special_open
      ON rooms(owner_id)
      WHERE status = 'open' AND kind IN ('mitsugetsu','oborozuki','game');
    CREATE INDEX IF NOT EXISTS idx_rooms_pending_delete
      ON rooms(status, pending_delete, next_delete_retry_at)
      WHERE status = 'open' AND pending_delete = 1;
  `);
  backfillEvaluationMarkWeights(db);
  backfillEvaluationPolicySnapshots(db);
  return db;
}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((r) => r.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function assertNoDuplicateOpenRoomOwnership(db: Database.Database): void {
  const duplicates = db
    .prepare(
      `SELECT
         owner_id,
         CASE WHEN kind = 'normal' THEN 'normal' ELSE 'special' END AS ownership_slot,
         COUNT(*) AS room_count,
         GROUP_CONCAT(id || ':' || kind || ':' || channel_id, ', ') AS rooms
       FROM rooms
       WHERE status = 'open'
       GROUP BY owner_id, CASE WHEN kind = 'normal' THEN 'normal' ELSE 'special' END
       HAVING COUNT(*) > 1
       ORDER BY owner_id, ownership_slot`,
    )
    .all() as Array<{ owner_id: string; ownership_slot: string; room_count: number; rooms: string }>;
  if (duplicates.length === 0) return;
  const details = duplicates
    .map((d) => `owner=${d.owner_id} slot=${d.ownership_slot} count=${d.room_count} rooms=[${d.rooms}]`)
    .join("; ");
  throw new Error(`rooms migration blocked: duplicate open room ownership would violate room ownership indexes: ${details}`);
}

function settingNumber(db: Database.Database, key: string, fallback: number): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return fallback;
  const value = Number(row.value);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function settingNonNegativeNumber(db: Database.Database, key: string, fallback: number): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return fallback;
  const value = Number(row.value);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function backfillEvaluationMarkWeights(db: Database.Database): void {
  db.prepare(
    `UPDATE evaluations
     SET mark_weight = CASE
       WHEN conclusion = 'none' THEN 0
       ELSE COALESCE((SELECT weight FROM marks WHERE marks.id = evaluations.mark_id), 1)
     END
     WHERE mark_weight = 0`,
  ).run();
}

function backfillEvaluationPolicySnapshots(db: Database.Database): void {
  const promotionRequired = settingNumber(db, "promotion_marks_required", 5);
  const demotionThreshold = settingNumber(db, "demotion_marks_threshold", 4);
  const inviteMarkPerPerson = settingNonNegativeNumber(db, "invite_mark_per_person", 0.5);
  const inviteMarkCap = settingNonNegativeNumber(db, "invite_mark_cap", 1.0);
  const ts = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE souls
     SET eval_started_at = COALESCE(eval_started_at, ghost_at, updated_at, ?),
         eval_policy_version = COALESCE(eval_policy_version, ?),
         eval_promotion_required = COALESCE(eval_promotion_required, ?),
         eval_demotion_threshold = COALESCE(eval_demotion_threshold, ?),
         eval_invite_mark_per_person = COALESCE(eval_invite_mark_per_person, ?),
         eval_invite_mark_cap = COALESCE(eval_invite_mark_cap, ?)
     WHERE status = 'ghost'
       AND (
         eval_promotion_required IS NULL OR eval_demotion_threshold IS NULL
         OR eval_invite_mark_per_person IS NULL OR eval_invite_mark_cap IS NULL
       )`,
  ).run(ts, `migration:${ts}`, promotionRequired, demotionThreshold, inviteMarkPerPerson, inviteMarkCap);
}
