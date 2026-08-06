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

-- 説明会の予定変更（通常枠に対する日付ごとの例外）。
-- 物理削除しない: 誰がいつ休止・追加し、誰が取り消したかを残す。
-- 取り消した行は canceled_at が入り、開催予定の合成から外れる（＝通常予定へ復元される）。
CREATE TABLE IF NOT EXISTS entry_session_overrides (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT NOT NULL,                        -- JSTの日付 'YYYY-MM-DD'
  hour        INTEGER,                              -- JSTの時。skip で NULL ならその日を全休
  kind        TEXT NOT NULL CHECK (kind IN ('skip','add')),
  reason      TEXT,
  actor_id    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  canceled_at INTEGER,
  canceled_by TEXT,
  CHECK (hour IS NULL OR (hour >= 0 AND hour <= 23)),
  CHECK (kind = 'skip' OR hour IS NOT NULL)         -- 臨時追加に「その日全部」は無い
);
-- 二重登録はDB側で弾く（アプリのチェックだけだと同時実行で抜ける）。
-- 対象は有効な行だけなので、取り消せば同じ枠をもう一度登録できる。
CREATE UNIQUE INDEX IF NOT EXISTS idx_entry_session_overrides_active
  ON entry_session_overrides(date, kind, IFNULL(hour, -1))
  WHERE canceled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_entry_session_overrides_date
  ON entry_session_overrides(date)
  WHERE canceled_at IS NULL;

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


-- PR10: automatic deposit/redemption activity and persistent confirmation/saga state.
CREATE TABLE IF NOT EXISTS casino_chip_activity (
  user_id        TEXT PRIMARY KEY,
  last_active_at INTEGER NOT NULL CHECK(last_active_at >= 0),
  updated_at     INTEGER NOT NULL CHECK(updated_at >= 0)
);
CREATE INDEX IF NOT EXISTS idx_casino_chip_activity_last ON casino_chip_activity(last_active_at);

CREATE TABLE IF NOT EXISTS casino_chip_external_confirmations (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  operation_id   TEXT NOT NULL,
  required_land  INTEGER NOT NULL CHECK(required_land > 0),
  chip_amount    INTEGER NOT NULL CHECK(chip_amount > 0),
  status         TEXT NOT NULL CHECK(status IN ('pending','executing','completed','cancelled','expired')),
  created_at     INTEGER NOT NULL CHECK(created_at >= 0),
  expires_at     INTEGER NOT NULL CHECK(expires_at >= created_at),
  completed_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chip_external_user_status
  ON casino_chip_external_confirmations(user_id,status,expires_at);

CREATE TABLE IF NOT EXISTS casino_chip_refund_sagas (
  id             TEXT PRIMARY KEY,
  scope          TEXT NOT NULL CHECK(scope IN ('user','all')),
  requested_by   TEXT NOT NULL,
  target_user_id TEXT,
  status         TEXT NOT NULL CHECK(status IN ('draft','executing','completed','blocked','cancelled')),
  target_count   INTEGER NOT NULL CHECK(target_count >= 0),
  target_total   INTEGER NOT NULL CHECK(target_total >= 0),
  created_at     INTEGER NOT NULL CHECK(created_at >= 0),
  started_at     INTEGER,
  completed_at   INTEGER,
  failure_json   TEXT,
  CHECK((scope='user' AND target_user_id IS NOT NULL) OR (scope='all' AND target_user_id IS NULL))
);

CREATE TABLE IF NOT EXISTS casino_chip_refund_saga_targets (
  saga_id      TEXT NOT NULL REFERENCES casino_chip_refund_sagas(id),
  user_id      TEXT NOT NULL,
  amount       INTEGER NOT NULL CHECK(amount > 0),
  status       TEXT NOT NULL CHECK(status IN ('pending','completed','failed','blocked')),
  group_key    TEXT NOT NULL UNIQUE,
  result_json  TEXT,
  failure      TEXT,
  completed_at INTEGER,
  PRIMARY KEY(saga_id,user_id)
);

CREATE TABLE IF NOT EXISTS shop_purchase_operations (
  operation_id TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  item_id      INTEGER NOT NULL,
  mode         TEXT NOT NULL CHECK(mode IN ('land','alt')),
  purchase_id  INTEGER,
  status       TEXT NOT NULL CHECK(status IN ('executing','completed')),
  created_at   INTEGER NOT NULL,
  completed_at INTEGER
);

-- 賭場チップの取引監査（大型UPD PR1）。チップ残高は現在値しか持たないので、
-- 「業務操作の単位(group)」と「その中の1移動(tx)」を追記し、開始残高から再現できるようにする。
CREATE TABLE IF NOT EXISTS casino_tx_groups (
  group_key    TEXT PRIMARY KEY,                 -- 業務操作の冪等キー
  kind         TEXT NOT NULL,                    -- solo_game / table_settle / deposit など
  status       TEXT NOT NULL CHECK (status IN ('settled','failed')),
  actor_id     TEXT NOT NULL,
  result_json  TEXT,                             -- 二度目の呼び出しへ返す結果
  created_at   INTEGER NOT NULL,
  settled_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_casino_tx_groups_kind ON casino_tx_groups(kind, created_at);

CREATE TABLE IF NOT EXISTS casino_tx (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  group_key    TEXT NOT NULL REFERENCES casino_tx_groups(group_key),
  seq          INTEGER NOT NULL,
  tx_kind      TEXT NOT NULL CHECK (tx_kind IN ('internal_transfer','deposit','redeem')),
  from_holder  TEXT,
  to_holder    TEXT,
  amount       INTEGER NOT NULL CHECK (amount > 0),
  reason       TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  game         TEXT,
  session_id   TEXT,
  actor_id     TEXT NOT NULL,
  opening_version TEXT NOT NULL,                     -- この取引が属する開始残高の版（検算の窓）
  land_amount  INTEGER,                              -- 預入・返還で動いたLand（内部移動はNULL）
  ledger_tx_id INTEGER REFERENCES transactions(id),
  created_at   INTEGER NOT NULL,
  -- 内部移動は両側必須でLandを動かさない。預入は発行、返還は消却。
  -- 預入・返還は動いたLand額を必ず持ち、1 Ldでも動いたなら対応するLand取引IDも必須。
  -- （端数で0 Ldになる返還は現行仕様として存在するため、land_amount = 0 のときだけID無しを許す）
  CHECK (
    (tx_kind = 'internal_transfer' AND from_holder IS NOT NULL AND to_holder IS NOT NULL
      AND ledger_tx_id IS NULL AND land_amount IS NULL)
    OR (tx_kind = 'deposit' AND from_holder IS NULL AND to_holder IS NOT NULL
      AND land_amount IS NOT NULL AND land_amount > 0 AND ledger_tx_id IS NOT NULL)
    OR (tx_kind = 'redeem' AND from_holder IS NOT NULL AND to_holder IS NULL
      AND land_amount IS NOT NULL AND land_amount >= 0
      AND (land_amount = 0 OR ledger_tx_id IS NOT NULL))
  ),
  UNIQUE (group_key, seq)
);
CREATE INDEX IF NOT EXISTS idx_casino_tx_group ON casino_tx(group_key, seq);
CREATE INDEX IF NOT EXISTS idx_casino_tx_version ON casino_tx(opening_version, id);
CREATE INDEX IF NOT EXISTS idx_casino_tx_from ON casino_tx(from_holder, id);
CREATE INDEX IF NOT EXISTS idx_casino_tx_to ON casino_tx(to_holder, id);

-- 開始残高の版。版の前後関係は version_seq（単調増加）で決める。
-- 取引IDで順序を決めると、取引を挟まず2つの版を作った場合や、開業初期化で
-- casino_tx を初期化した場合（新版のIDが旧版より小さくなる）に順序が壊れる。
CREATE TABLE IF NOT EXISTS casino_chip_opening_versions (
  opening_version TEXT PRIMARY KEY,
  version_seq     INTEGER NOT NULL UNIQUE,
  from_tx_id      INTEGER NOT NULL,          -- 参考値（その時点の最終取引ID）
  -- その版を開いた時点の準備プール(sys:escrow:ether)の Land。検算Bの出発点。
  pool_land       INTEGER,
  -- その時点の Land 台帳の最終取引ID。検算Bはこれ以降の準備口座の出入りを1件ずつ監査する。
  -- pool_land と揃って初めて基準が成立する。NULL なら検算Bは NG（自動では埋めない）
  from_ledger_tx_id INTEGER,
  created_at      INTEGER NOT NULL
);

-- 賭場の稼働状態（1行だけ）。停止は理由・実行者・時刻とセットでしか作れない。
-- startup_check だけが自動で解除され、それ以外は人の明示操作でしか開かない。
CREATE TABLE IF NOT EXISTS casino_status (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  status     TEXT NOT NULL,
  reason     TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
-- 状態の変遷は全部残す（いつ誰がなぜ止めた/開けたか）
CREATE TABLE IF NOT EXISTS casino_status_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  status     TEXT NOT NULL,
  reason     TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_casino_status_history ON casino_status_history(changed_at);

-- 検算の出発点。ここに載せた版の残高 + その版の窓の casino_tx = その時点の残高 になる
CREATE TABLE IF NOT EXISTS casino_chip_opening_balances (
  opening_version TEXT NOT NULL,
  holder          TEXT NOT NULL,
  amount          INTEGER NOT NULL CHECK (amount >= 0),
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (opening_version, holder)
);

-- 正式開業初期化（PR12）自体の永続execution状態機械。apply()がどの工程まで進んだ状態で
-- プロセスが落ちても、再起動後にどこから再開してよいかを判定する唯一の真実源。
-- 分類表上は archive/reset の対象外（PR12自身の記録なので、正式開業initializationの
-- plan hashにも含めない — 自分自身の書き込みでplanがstale化する自己参照を避けるため）。
CREATE TABLE IF NOT EXISTS casino_opening_executions (
  id                              TEXT PRIMARY KEY,
  plan_hash                       TEXT NOT NULL,
  status                          TEXT NOT NULL CHECK (status IN (
    'planned','opening_reset_acquired','backup_started','backup_verified',
    'external_started','external_completed','applying','applied',
    'post_commit_pending','completed','failed','manual_review_required'
  )),
  actor_id                        TEXT NOT NULL,
  configuration_json              TEXT NOT NULL,
  configuration_hash               TEXT NOT NULL,
  backup_manifest_json            TEXT,
  external_operation_id           TEXT,
  external_operation_result_json  TEXT,
  old_settlement_land_tx_id       INTEGER,
  new_investment_land_tx_id       INTEGER,
  opening_version                 TEXT,
  postflight_json                 TEXT,
  notifier_status                 TEXT,
  funds_applied                   INTEGER NOT NULL DEFAULT 0,
  reapply_allowed                 INTEGER NOT NULL DEFAULT 1,
  manual_reopen_required          INTEGER NOT NULL DEFAULT 0,
  failure_stage                   TEXT,
  failure_reason                  TEXT,
  manual_review_reason            TEXT,
  started_at                      INTEGER NOT NULL,
  updated_at                      INTEGER NOT NULL,
  applied_at                      INTEGER,
  completed_at                    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_casino_opening_executions_plan ON casino_opening_executions(plan_hash);

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
`;

export function openDb(path: string): Database.Database {
  // 複数接続（別プロセス・別スレッド）から同じDBを触ったとき、ロック待ちで即失敗せず
  // 待ってから再試行できるようにする。賭場の業務グループは書き込みが衝突しうる。
  const db = new Database(path, { timeout: 5_000 });
  if (path !== ":memory:") {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
  }
  db.pragma("foreign_keys = ON");
  // マイグレーション: den_vcs.kind の古い CHECK 制約（応接室を弾く）を外すため作り直す。
  // 一時的な追跡データなので破棄して問題ない。
  const denSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='den_vcs'").get() as { sql?: string } | undefined)?.sql;
  if (denSql && denSql.includes("CHECK")) db.exec("DROP TABLE den_vcs");
  // マイグレーション: 旧カジノの chip_balances は ether_balances に置き換え（旧カジノは開帳前に廃止＝データ無し）
  db.exec("DROP TABLE IF EXISTS chip_balances");
  db.exec(DDL);
  ensureColumn(db, "casino_chip_opening_versions", "pool_land", "INTEGER");
  ensureColumn(db, "casino_chip_opening_versions", "from_ledger_tx_id", "INTEGER");
  ensureColumn(db, "vc_segments", "parent_id", "TEXT");
  ensureColumn(db, "marks", "weight", "INTEGER NOT NULL DEFAULT 1 CHECK (weight > 0)");
  ensureColumn(db, "evaluations", "mark_weight", "INTEGER NOT NULL DEFAULT 0 CHECK (mark_weight >= 0)");
  ensureColumn(db, "souls", "eval_started_at", "INTEGER");
  ensureColumn(db, "souls", "eval_policy_version", "TEXT");
  ensureColumn(db, "souls", "eval_promotion_required", "INTEGER");
  ensureColumn(db, "souls", "eval_demotion_threshold", "INTEGER");
  ensureColumn(db, "souls", "eval_invite_mark_per_person", "REAL");
  ensureColumn(db, "souls", "eval_invite_mark_cap", "REAL");
  // 招待経路の「検出・補足」層（未確定）。確定は invites 行 + souls.inviter_user_id。
  // waiting の人は予約行を持たないので、置き場所を souls 側に持つ。
  ensureColumn(db, "souls", "inviter_hint_user_id", "TEXT");
  ensureColumn(db, "souls", "inviter_hint_source", "TEXT");
  ensureColumn(db, "souls", "inviter_hint_origin", "TEXT");
  ensureColumn(db, "souls", "inviter_hint_at", "INTEGER");
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
  ensureColumn(db, "casino_chip_external_confirmations", "chip_amount", "INTEGER NOT NULL DEFAULT 0 CHECK (chip_amount >= 0)");
  // PR12監査: opening_resetの所有権（execution・actor）をcasino_status自体から機械的に
  // 照合できるようにする。beginOpeningReset()とOpeningExecutionStore.acquire()を
  // 単一のトランザクションへ統合し（opening-reset.tsのapply() R0）、その結果をここへ書く。
  ensureColumn(db, "casino_status", "opening_execution_id", "TEXT");
  ensureColumn(db, "casino_status", "opening_actor_id", "TEXT");
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
