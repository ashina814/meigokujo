import Database from "better-sqlite3";
import { WITHDRAWN_DELIVERY_KINDS, parseDeliverySnapshot } from "../shop/service.js";

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
                      CHECK (status IN ('waiting','ghost','majin','kenma','mazoku','meirei','departed')),
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
  -- いま動かしている操作そのものの冪等キーと実行者（入れ子なら内側）。
  -- 内側の runGroup は外側グループへ合流するので group_key では操作を特定できない。
  -- Land取引の冪等キーと 1:1 で突き合わせる正本はこちら。
  op_key       TEXT,
  op_actor_id  TEXT,
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

-- ============================================================
-- 名前（サーバーニックネーム）の正本
-- ============================================================
--
-- 唯一性は **nickname_reservations だけ**が担保する。member_names 側に
-- UNIQUE を置かないのは、既存の重複（同じ名前の2人）をそのまま記録として
-- 残せるようにするため。片方を消したり勝手に改名したりしない。

CREATE TABLE IF NOT EXISTS nickname_reservations (
  -- 正規化済みの鍵。**これが同名禁止の正本**で、主キーなので二重登録は
  -- アプリの事前チェックをすり抜けても DB が必ず落とす
  name_key   TEXT PRIMARY KEY,
  -- member         … 特定の1人が持っている予約
  -- legacy_conflict … **誰の持ち物でもない**。制度導入前から複数人が使っていた
  --                   名前で、当人たちを改名させないまま新規の取得だけを止める。
  --                   所有者を立てると、その人が改名・退出した瞬間に予約が外れ、
  --                   まだ同じ名前で残っている人がいるのに新規へ開放されてしまう
  kind       TEXT NOT NULL CHECK (kind IN ('member','legacy_conflict')),
  user_id    TEXT,
  display    TEXT NOT NULL,
  -- 改名の途中で押さえている予約。**旧名を手放す前に新名を確保する**ために使う。
  -- 商館の改名は「新名を仮押さえ → Discord変更 → 成功したら旧名を解放」の順で進む。
  -- 先に旧名を解放すると、Discord変更に失敗して戻すときには他の人に取られている
  staged_for_purchase INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((kind = 'member' AND user_id IS NOT NULL) OR (kind = 'legacy_conflict' AND user_id IS NULL))
);
-- 「確定済みは1人1つ」の索引は **DDLではなく移行側で張る**。
-- 既存DBではこの時点でまだ staged_for_purchase 列が無く、列を参照する索引は作れない

CREATE TABLE IF NOT EXISTS member_names (
  user_id        TEXT PRIMARY KEY,
  nickname       TEXT NOT NULL,
  name_key       TEXT NOT NULL,
  -- registered … 新制度で登録した（入城の条件を満たす）
  -- legacy     … 制度導入前からの名前を取り込んだだけ（重複なし）
  -- conflict   … 導入前からの名前で、他の人と重なっている（予約は legacy_conflict 側）
  state          TEXT NOT NULL CHECK (state IN ('registered','legacy','conflict')),
  policy_version TEXT,
  locked_at      INTEGER,
  -- 禁止語の flag に触れた名前を、門番が目で見て通した記録。
  -- flag は機械では白黒つかないものなので、**人が1回許可して初めて通る**。
  -- 名前を変えたら承認も消える（別の名前は見ていないため）
  flag_ok_at     INTEGER,
  flag_ok_by     TEXT,
  -- 承認した時点で「実際に当たっていた要確認語」。あとから別の要確認語が
  -- 増えたとき、**門番が見ていない語まで承認済みに見えてしまう**のを防ぐ
  flag_ok_words  TEXT,
  set_via        TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_member_names_key ON member_names(name_key);

-- 不適切名の語彙。**コードに焼き込まない**（語を足すたびに deploy したくない）。
-- 判定は正規化済みの鍵に対する部分一致だけ。正規表現は今は持たない
-- ============================================================
-- オリジナルロール（申請 → 承認 → 支払い → 作成・付与 → 30日契約）
-- ============================================================
--
-- **支払いは承認のあとだけ。** 申請の時点では Land を一切動かさない。
-- 1人で複数持てるので、行は「1契約 = 1行」。誰のどのロールかは**この表だけ**が
-- 正本で、旧商品の購入履歴からは推測しない（対応の記録がそもそも無い）。
CREATE TABLE IF NOT EXISTS original_roles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL,
  -- 作成後に入る。承認前・支払い前は NULL
  role_id       TEXT,
  name          TEXT NOT NULL,
  color         INTEGER,
  -- pending   … 申請中（運営待ち）
  -- approved  … 承認済み・支払い待ち（放置されたら期限で cancelled へ）
  -- active    … 支払い済み・ロール作成/付与済み・契約中
  -- expired   … 期限切れ（ロールは剥奪する）
  -- returned  … 差し戻し（直して申請し直せる）
  -- rejected  … 却下
  -- cancelled … 承認後に支払われないまま期限が来た
  status        TEXT NOT NULL CHECK (status IN ('pending','approved','active','expired','returned','rejected','cancelled')),
  expires_at    INTEGER,
  approved_by   TEXT,
  approved_at   INTEGER,
  decided_by    TEXT,
  decided_at    INTEGER,
  decide_reason TEXT,
  -- 新規作成の課金。更新は購入行を作らない（課金と期限延長が同じ取引で閉じるため）
  purchase_id   INTEGER,
  -- 期限予告を出した時刻。**通知は業務の正本にしない**が、二重に出さないために持つ
  notified_expiry_at INTEGER,
  -- ロールを剥奪できた時刻。剥奪に失敗しても巡回で拾い直す
  role_removed_at    INTEGER,
  -- Discord へロールを作りにいった時刻。**作成と記録の間にクラッシュ窓がある**ので、
  -- 「作りかけた」ことだけ先に残す。再試行はこれを見て、同じロールを2個作らずに拾い直す
  role_creation_started_at INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
-- 更新の確認画面ごとに1回だけ課金する。**確認IDを永続的に消費する**ので、
-- 同じ確認画面を何度押しても2回目以降は何も動かない
CREATE TABLE IF NOT EXISTS original_role_renewals (
  operation_id     TEXT PRIMARY KEY,
  original_role_id INTEGER NOT NULL,
  user_id          TEXT NOT NULL,
  price            INTEGER NOT NULL,
  created_at       INTEGER NOT NULL
);
-- サブ垢。**main ↔ alt の対応はここが正本。**
-- 旧商品の購入履歴には「買った」しか残っておらず、どのアカウントがサブ垢かの記録が無い。
-- 推測すると他人のアカウントを本体に紐付ける事故になるので、必ず人が突き合わせる
CREATE TABLE IF NOT EXISTS sub_accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  main_user_id   TEXT NOT NULL,
  alt_user_id    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','active','returned','rejected','cancelled')),
  purchase_id    INTEGER,
  approved_by    TEXT,
  approved_at    INTEGER,
  decided_by     TEXT,
  decided_at     INTEGER,
  decide_reason  TEXT,
  activated_at   INTEGER,
  -- 人が旧契約のmain/altを明示確認して引き継いだ事実。解除後も消さない
  legacy_imported_at INTEGER,
  -- 有効化を始める前の階級ロール集合（JSON配列）。**Discordを変更する前に書く。**
  -- 途中で落ちても、再起動後の再試行がここを基準に巻き戻せる
  activation_rank_baseline TEXT,
  activation_rank_settled_at INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  -- 自分自身をサブ垢にはできない
  CHECK (main_user_id <> alt_user_id)
);
-- 1つのサブ垢が2人の本体にぶら下がらない。**進行中のものだけを見る**ので、
-- 却下・解除された古い組み合わせは同じ相手の再登録を邪魔しない
CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_accounts_alt_open
  ON sub_accounts(alt_user_id) WHERE status IN ('pending','approved','active');
CREATE INDEX IF NOT EXISTS idx_sub_accounts_main ON sub_accounts(main_user_id, status);
CREATE INDEX IF NOT EXISTS idx_sub_accounts_status ON sub_accounts(status);
-- サブ垢のDiscord階級操作を直列化する短期lease。
-- scheduler同期と運営解除が同時に走り、解除中に階級を付け直す競合を防ぐ。
CREATE TABLE IF NOT EXISTS sub_account_rank_operations (
  sub_account_id INTEGER PRIMARY KEY REFERENCES sub_accounts(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('sync','deactivate')),
  token          TEXT NOT NULL,
  expires_at     INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);

-- 再評価チャレンジの招待払い。invites は歴史の正本なので変更せず、
-- 商館で使った事実だけを追記する。既存購入への遡及登録は行わない。
CREATE TABLE IF NOT EXISTS shop_reeval_invite_uses (
  invite_id   INTEGER PRIMARY KEY REFERENCES invites(id),
  purchase_id INTEGER NOT NULL REFERENCES shop_purchases(id),
  user_id     TEXT NOT NULL,
  used_at     INTEGER NOT NULL,
  UNIQUE(purchase_id, invite_id)
);
CREATE INDEX IF NOT EXISTS idx_shop_reeval_invite_uses_purchase
  ON shop_reeval_invite_uses(purchase_id);

-- 例外補償は元購入の返金ではなく部署経費。1購入につき1回だけ許可する。
CREATE TABLE IF NOT EXISTS shop_reeval_compensations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id           INTEGER NOT NULL UNIQUE REFERENCES shop_purchases(id),
  user_id               TEXT NOT NULL,
  -- 実行時点の部署キーを監査スナップショットとして保持する。部署削除後も履歴を残すためFKは張らない。
  department_key        TEXT NOT NULL,
  amount                INTEGER NOT NULL CHECK(amount > 0),
  reason                TEXT NOT NULL,
  actor_id               TEXT NOT NULL,
  ledger_transaction_id INTEGER NOT NULL UNIQUE REFERENCES transactions(id),
  created_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_reeval_compensations_user
  ON shop_reeval_compensations(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sub_account_rank_operations_expiry
  ON sub_account_rank_operations(expires_at);
CREATE INDEX IF NOT EXISTS idx_original_roles_user ON original_roles(user_id, status);
CREATE INDEX IF NOT EXISTS idx_original_roles_status ON original_roles(status, expires_at);
-- 同じロールを2つの契約に結び付けない（引き継ぎ登録の二重実行を止める）
CREATE UNIQUE INDEX IF NOT EXISTS idx_original_roles_role ON original_roles(role_id) WHERE role_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS nickname_denylist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern    TEXT NOT NULL UNIQUE,
  -- reject … その場で拒否   flag … 登録は通すが門番へ⚠️で上げる（「過度な」の線引きは人が持つ）
  action     TEXT NOT NULL DEFAULT 'reject' CHECK (action IN ('reject','flag')),
  note       TEXT,
  added_by   TEXT NOT NULL,
  created_at INTEGER NOT NULL
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
  // 既に member_names がある本番へ後から足す（承認済みの語を記録する列）
  ensureColumn(db, "member_names", "flag_ok_words", "TEXT");
  // 改名の仮押さえ列。旧い一意制約（1人1予約）は仮押さえを許さないので張り替える
  ensureColumn(db, "nickname_reservations", "staged_for_purchase", "INTEGER");
  db.exec("DROP INDEX IF EXISTS idx_nickname_res_user");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_nickname_res_user_committed ON nickname_reservations(user_id) WHERE user_id IS NOT NULL AND staged_for_purchase IS NULL",
  );
  ensureColumn(db, "shop_purchases", "request_json", "TEXT");
  applyNicknameItemSetting(db);
  // 既に original_roles がある本番へ後から足す
  ensureColumn(db, "original_roles", "role_creation_started_at", "INTEGER");
  applyOriginalRoleItemSetting(db);
  // 既に sub_accounts がある本番へ後から足す
  ensureColumn(db, "sub_accounts", "legacy_imported_at", "INTEGER");
  // PR125で登録済みの行は、明示的なimport eventの契約ID一致だけを根拠に移す。
  // purchase_id/activated_atからaltを推測するbackfillはしない。
  db.exec(`
    UPDATE sub_accounts
       SET legacy_imported_at = (
         SELECT MIN(e.created_at)
           FROM events e
          WHERE e.type = 'sub_account_imported'
            AND e.target_id = sub_accounts.main_user_id
            AND CASE WHEN json_valid(e.payload_json)
                     THEN CAST(json_extract(e.payload_json, '$.id') AS INTEGER)
                END = sub_accounts.id
       )
     WHERE legacy_imported_at IS NULL
       AND EXISTS (
         SELECT 1
           FROM events e
          WHERE e.type = 'sub_account_imported'
            AND e.target_id = sub_accounts.main_user_id
            AND CASE WHEN json_valid(e.payload_json)
                     THEN CAST(json_extract(e.payload_json, '$.id') AS INTEGER)
                END = sub_accounts.id
       )
  `);
  ensureColumn(db, "sub_accounts", "activation_rank_baseline", "TEXT");
  ensureColumn(db, "sub_accounts", "activation_rank_settled_at", "INTEGER");
  applySubAccountItemSetting(db);
  ensureColumn(db, "casino_tx", "op_key", "TEXT");
  ensureColumn(db, "casino_tx", "op_actor_id", "TEXT");
  backfillChipTxOperationKey(db);
  migrateMonthlyToThirtyDayTerms(db);
  // Land を動かした明細は、操作キーで一意。同じ操作キーで二重に動かせない
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_casino_tx_op_key ON casino_tx(op_key) WHERE ledger_tx_id IS NOT NULL",
  );
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
  // 出戻り（退出→再参加）の記録。再参加でいったん waiting へ戻すため、
  // 元の階級を失わないよう退避先を持つ
  ensureColumn(db, "souls", "left_at", "INTEGER");
  ensureColumn(db, "souls", "returned_at", "INTEGER");
  ensureColumn(db, "souls", "rank_at_leave", "TEXT");
  ensureColumn(db, "souls", "ever_meirei", "INTEGER NOT NULL DEFAULT 0");
  // 評価サイクルごとの招待の起点と、そのサイクルで適用するアリ閾値。
  // 過去の招待数を新しいサイクルへ持ち越さないために使う
  ensureColumn(db, "souls", "eval_invite_baseline", "INTEGER");
  ensureColumn(db, "souls", "eval_invite_threshold", "INTEGER");
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
  // 配送状態を課金から分離する（購入は成立したが配送が終わっていない、を表せるようにする）。
  // 旧行の移行は backfillShopDeliveryState() で行う。
  ensureColumn(db, "shop_purchases", "delivery_state", "TEXT");
  ensureColumn(db, "shop_purchases", "delivery_attempts", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "shop_purchases", "delivery_error", "TEXT");
  ensureColumn(db, "shop_purchases", "delivery_updated_at", "INTEGER");
  ensureColumn(db, "scheduler_chunk_batches", "sent_at", "INTEGER");
  ensureColumn(db, "casino_chip_external_confirmations", "chip_amount", "INTEGER NOT NULL DEFAULT 0 CHECK (chip_amount >= 0)");
  // PR12監査: opening_resetの所有権（execution・actor）をcasino_status自体から機械的に
  // 照合できるようにする。beginOpeningReset()とOpeningExecutionStore.acquire()を
  // 単一のトランザクションへ統合し（opening-reset.tsのapply() R0）、その結果をここへ書く。
  ensureColumn(db, "casino_status", "opening_execution_id", "TEXT");
  ensureColumn(db, "casino_status", "opening_actor_id", "TEXT");
  migrateSoulStatusCheck(db);
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
  backfillShopDeliveryState(db);
  backfillEverMeirei(db);
  backfillInviteThresholdSnapshot(db);
  return db;
}

/**
 * 進行中の評価サイクルへ、いまの招待アリ閾値を**焼き付ける**。
 *
 * 招待アリは「3人以上で1アリ・最大1」の段階式へ変わった。旧サイクルは閾値を
 * 持たないので、読むたびに現在設定を参照することになる。それだと後で設定を変えたときに
 * **進行中の人の基準が後から動いてしまう**（policy snapshot を持つ意味が消える）。
 * ここで一度だけ現在値を焼き、以後はその値で評価する。
 *
 * 旧モデル（1人=0.5・上限1）は再現しない。廃止された仕様なので、進行中の人も
 * 新ルールへ移す（この移行の影響は deploy 前に dry-run で一覧化する）。
 */
function backfillInviteThresholdSnapshot(db: Database.Database): void {
  const threshold = settingNumber(db, "invite_marks_threshold", 3);
  db.prepare(
    `UPDATE souls
        SET eval_invite_threshold = ?,
            eval_invite_baseline = COALESCE(eval_invite_baseline, 0)
      WHERE eval_invite_threshold IS NULL
        AND status = 'ghost'
        AND eval_deadline_at IS NOT NULL`,
  ).run(threshold);
}

/**
 * 「過去に迷霊だったことがあるか」を既存データから復元する。
 *
 * 出戻りの判断画面で「以前は迷霊でした」と出すために使う。いま迷霊の人と、
 * 降格の事件録が残っている人を立てる。**判断材料であって自動処理の根拠にはしない。**
 */
function backfillEverMeirei(db: Database.Database): void {
  db.prepare(
    `UPDATE souls
        SET ever_meirei = 1
      WHERE ever_meirei = 0
        AND (status = 'meirei'
             OR EXISTS (SELECT 1 FROM events WHERE events.target_id = souls.user_id AND events.type = 'demotion'))`,
  ).run();
}

/**
 * 既存購入へ配送状態を割り当てる。
 *
 * `delivered_at` は「手動配送のスタッフ完了マーク」でしか埋まっておらず、
 * **自動配送は成功しても NULL のまま**だった。つまり `delivered_at IS NULL` は
 * 「未配送」ではなく「手動配送の完了操作をしていない」を意味する行が大半を占める。
 * そのまま `pending` にすると、自動配送の再実行が大量に走ってしまう。
 *
 * そこで移行では**再配送を発生させない**ことを優先し、次の規則で割り当てる。
 * - `delivered_at` が入っている … `delivered`（根拠のある完了）
 * - 手動配送(`delivery='manual'`)で未マーク … `pending`（元から人手待ち。意味が変わらない）
 * - 自動配送で未マーク … 原則 `delivered`（過去分は完了扱い）。
 *   `add_role` と `extend_deadline` は再実行の副作用が読めないので、ここで pending にしない
 * - **自動配送を取りやめた種別**（`revoke_meirei`＝再評価チャレンジ）… `failed`。
 *   配送は完了していないという事実を残しつつ、自動でも運営の回収導線でも実行しない。
 *   この商品は「購入 → 再評価面談チケット → 面談OKで亡霊へ復帰」に変わったため、
 *   機械が status とロールを動かしてよい対象ではなくなった。
 *
 * 判定の根拠は**購入時スナップショットだけ**にする。商品の現在設定を見ると、買った後に
 * 商品を自動配送へ変えただけで過去の購入が再配送候補になってしまう。スナップショットを
 * 持たない旧購入は「legacy unknown」として自動再配送の候補にしない。
 *
 * `pending` にしても**自動では何も起きない**。運営が回収導線から purchase を選んだ時だけ走る。
 *
 * 以後の購入は配送経路が自分で `pending → delivered/failed` を書くので、
 * この移行が効くのは**この変更より前に作られた行だけ**。
 */
function backfillShopDeliveryState(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT p.id, p.user_id, p.delivered_at, p.purchased_at, p.delivery_snapshot_json,
              i.delivery AS item_delivery,
              (SELECT status FROM souls WHERE souls.user_id = p.user_id) AS soul_status
         FROM shop_purchases p
         JOIN shop_items i ON i.id = p.item_id
        WHERE p.delivery_state IS NULL`,
    )
    .all() as Array<{
    id: number;
    user_id: string;
    delivered_at: number | null;
    purchased_at: number;
    delivery_snapshot_json: string | null;
    item_delivery: string;
    soul_status: string | null;
  }>;
  if (rows.length === 0) return;

  const update = db.prepare("UPDATE shop_purchases SET delivery_state = ?, delivery_updated_at = ? WHERE id = ? AND delivery_state IS NULL");
  const markWithdrawn = db.prepare(
    "UPDATE shop_purchases SET delivery_error = 'auto_delivery_withdrawn:revoke_meirei' WHERE id = ? AND delivery_error IS NULL",
  );
  const withdrawn: number[] = [];
  const assign = db.transaction(() => {
    for (const row of rows) {
      let state: "delivered" | "pending" | "failed" = "delivered";
      if (row.delivered_at !== null) {
        state = "delivered";
      } else {
        // 判定の根拠は**購入時スナップショット**。商品の現在設定は使わない
        const snapshot = parseDeliverySnapshot(row.delivery_snapshot_json);
        if (snapshot && WITHDRAWN_DELIVERY_KINDS.has(snapshot.delivery_kind)) {
          // 自動配送を取りやめた種別（再評価チャレンジ）。配送は完了していないが、
          // 自動でも運営の回収導線でも実行しない。事実として failed に置き、
          // 面談導線で人が処理する
          withdrawn.push(row.id);
          state = "failed";
        } else if (snapshot === null && row.item_delivery === "manual") {
          // スナップショットを持たない手動配送＝元から人手待ちのキュー。
          // 自動再配送の候補にはならない（listUndeliveredAuto はスナップショット必須）ので、
          // 意味を変えずに pending のまま残す
          state = "pending";
        }
      }
      update.run(state, row.delivered_at ?? row.purchased_at, row.id);
    }
    for (const id of withdrawn) markWithdrawn.run(id);
  });
  assign.immediate();
}

/** `souls.status` が取り得る値。CHECK制約・型・同期ロジックの唯一の真実源 */
export const SOUL_STATUSES = ["waiting", "ghost", "majin", "kenma", "mazoku", "meirei", "departed"] as const;

/**
 * `souls.status` の CHECK 制約へ `kenma`（眷魔）を足す。
 *
 * **DDL を書き換えるだけでは既存DBに効かない。** `CREATE TABLE IF NOT EXISTS` は
 * 表がある限り何もしないので、本番のように既に souls を持つDBは旧CHECKのまま残り、
 * `status='kenma'` の書き込みが CHECK 違反で落ちる。SQLite は CHECK だけを
 * 後から変更する構文を持たないため、表を作り直して移す必要がある。
 *
 * 安全のために次を守る。
 * - **列は動的に読む**。ここで列名を書き下すと、あとで `ensureColumn` が増えたときに
 *   移行で列が落ちる。評価スナップショット・招待メタデータもこれで丸ごと運ぶ
 * - **移行先が知らない列が旧表にあれば、元の表に触れる前に throw する**（fail-closed）。
 *   警告を出しつつ列を捨てて起動すると、失われたことに気づくのは復旧できなくなった後になる
 * - 新旧に共通する列だけを INSERT..SELECT で移す（順序も明示する）
 * - 1つのトランザクションで行い、途中で落ちたら元のまま
 * - 既に新CHECKなら何もしない（冪等）
 */
function migrateSoulStatusCheck(db: Database.Database): void {
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='souls'").get() as { sql?: string } | undefined)?.sql;
  if (!sql) return; // souls がまだ無い＝新規DB。DDL が新CHECKで作る
  if (sql.includes("'kenma'")) return; // 移行済み

  const columns = (db.prepare("PRAGMA table_info(souls)").all() as Array<{ name: string }>).map((c) => c.name);
  if (columns.length === 0) return;

  // 外部キーの再解決を止めてから作り直す（souls を参照する表の行を壊さない）
  const foreignKeysWereOn = db.pragma("foreign_keys", { simple: true }) === 1;
  if (foreignKeysWereOn) db.pragma("foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    db.exec(`
      CREATE TABLE souls__new (
        user_id             TEXT PRIMARY KEY,
        status              TEXT NOT NULL DEFAULT 'waiting'
                            CHECK (status IN ('waiting','ghost','majin','kenma','mazoku','meirei','departed')),
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
        inviter_hint_user_id TEXT,
        inviter_hint_source  TEXT,
        inviter_hint_origin  TEXT,
        inviter_hint_at      INTEGER,
        left_at             INTEGER,
        returned_at         INTEGER,
        rank_at_leave       TEXT,
        ever_meirei         INTEGER NOT NULL DEFAULT 0,
        eval_invite_baseline INTEGER,
        eval_invite_threshold INTEGER,
        updated_at          INTEGER NOT NULL
      )
    `);
    const newColumns = (db.prepare("PRAGMA table_info(souls__new)").all() as Array<{ name: string }>).map((c) => c.name);
    // 旧表にしか無い列は移せない。**元の表に触れる前に落とす**（fail-closed）。
    // 移行コードが知らない列が本番にあるなら、それはこのコードが古いということ。
    // 黙ってデータを捨てて起動するより、deploy を失敗させて人間に判断させる方がよい。
    // ここで throw すれば ROLLBACK が走り、旧 souls も未知列も全データも元のまま残る。
    const dropped = columns.filter((c) => !newColumns.includes(c));
    if (dropped.length > 0) {
      throw new Error(
        `souls migration blocked: 移行先が知らない列があります: ${dropped.join(", ")}。` +
          `このまま移すとその列のデータを失います。bootstrap.ts の souls__new の定義へ列を足してから再実行してください（DBは変更していません）。`,
      );
    }
    const shared = columns.filter((c) => newColumns.includes(c));
    const quoted = shared.map((c) => `"${c}"`).join(", ");
    db.exec(`INSERT INTO souls__new (${quoted}) SELECT ${quoted} FROM souls`);
    db.exec("DROP TABLE souls");
    db.exec("ALTER TABLE souls__new RENAME TO souls");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    if (foreignKeysWereOn) db.pragma("foreign_keys = ON");
  }
}

/**
 * 既存の `casino_tx` へ「操作の冪等キー」を埋める。
 *
 * Land が動いた明細は `ledger_tx_id` で Land 取引と 1:1 に結ばれており、その取引の
 * 冪等キーこそが**その明細を動かした操作のキー**（入れ子でも外側へ合流するため
 * `group_key` では特定できない）。Land が動かない内部移動は操作＝グループなので
 * `group_key` を入れる。
 *
 * **この埋め戻しの弱点は明示しておく。** 過去行については Land 取引のキーと実行者を
 * そのまま写すので、`op_key` / `op_actor_id` と Land 側の一致検査は過去行に対しては
 * 実質的な検査にならない（他の突き合わせ—金額・holder・種別・版・グループ確定・
 * 明細とグループの actor 一致—はそのまま効く）。以後に記録される行は `ChipTx.record()` が
 * Land 取引とは独立に書くため、一致検査が本来の意味を持つ。
 * 何件をどちらの根拠で埋めたかは監査記録として残す。
 */
function backfillChipTxOperationKey(db: Database.Database): void {
  const pending = db.prepare("SELECT COUNT(*) AS n FROM casino_tx WHERE op_key IS NULL").get() as { n: number };
  if (pending.n === 0) return;

  const nested = db
    .prepare(
      `SELECT c.id, c.group_key, t.idempotency_key
         FROM casino_tx c JOIN transactions t ON t.id = c.ledger_tx_id
        WHERE c.op_key IS NULL AND t.idempotency_key <> c.group_key`,
    )
    .all() as Array<{ id: number; group_key: string; idempotency_key: string }>;

  // Land が動いた明細は、その Land 取引が操作そのもの。キーも実行者もそこから取る
  // （入れ子だと `actor_id` は外側グループの実行者になっており、表記も揺れている）
  const fromLedger = db.prepare(
    `UPDATE casino_tx
        SET op_key = (SELECT t.idempotency_key FROM transactions t WHERE t.id = casino_tx.ledger_tx_id),
            op_actor_id = (SELECT t.actor_id FROM transactions t WHERE t.id = casino_tx.ledger_tx_id)
      WHERE op_key IS NULL AND ledger_tx_id IS NOT NULL`,
  ).run().changes;
  const fromGroup = db.prepare(
    "UPDATE casino_tx SET op_key = group_key, op_actor_id = actor_id WHERE op_key IS NULL",
  ).run().changes;

  db.prepare("INSERT INTO outbox (kind, payload, created_at) VALUES ('audit_log', ?, ?)").run(
    JSON.stringify({
      event: "casino_tx_op_key_backfilled",
      fromLedger,
      fromGroup,
      // 入れ子で動いていた明細（＝旧検算が group_key_mismatch と呼んでいたもの）
      nested: nested.map((r) => ({ id: r.id, groupKey: r.group_key, opKey: r.idempotency_key })),
      actor: "system:migration",
    }),
    Math.floor(Date.now() / 1000),
  );
}

/**
 * 暦月の月額を「購入から30日」へ移す。
 *
 * 旧仕様は「当月末まで有効・毎月1日に一括再課金」だったので、月末に買った人ほど
 * 短い期間に満額を払っていた（本番では8/8購入が23日間）。30日制へ揃えるにあたり、
 * **誰の期限も短くしない**ことを唯一の条件にする。
 *
 * 起点は「最後に支払いが成立した時刻」。初回購入だけの契約は購入時刻、
 * 一括請求で更新された契約はその請求の時刻を使う（Land取引に残っている）。
 * そこから30日を数え、いまの期限より後になる場合だけ延ばす。
 */
function migrateMonthlyToThirtyDayTerms(db: Database.Database): void {
  const target = db
    .prepare("SELECT COUNT(*) AS n FROM shop_items WHERE kind = 'monthly' AND (duration_days IS NULL OR duration_days <= 0)")
    .get() as { n: number };
  if (target.n === 0) return;

  const ts = Math.floor(Date.now() / 1000);
  const run = db.transaction(() => {
    // 商品側: 暦月ではなく30日の期限商品にする
    db.prepare(
      "UPDATE shop_items SET duration_days = 30, updated_at = ? WHERE kind = 'monthly' AND (duration_days IS NULL OR duration_days <= 0)",
    ).run(ts);

    // 契約側: 最後に払った時刻 + 30日 と、いまの期限の遅い方へ
    const rows = db
      .prepare(
        `SELECT p.id, p.expires_at,
                MAX(p.purchased_at, COALESCE(
                  (SELECT MAX(t.created_at) FROM transactions t
                    WHERE t.ref_type = 'shop_monthly' AND t.ref_id = CAST(p.id AS TEXT)), 0)) AS last_paid_at
           FROM shop_purchases p JOIN shop_items i ON i.id = p.item_id
          WHERE p.status = 'active' AND i.kind = 'monthly' AND p.expires_at IS NOT NULL`,
      )
      .all() as Array<{ id: number; expires_at: number; last_paid_at: number }>;
    const changed: Array<{ purchaseId: number; from: number; to: number }> = [];
    const update = db.prepare("UPDATE shop_purchases SET expires_at = ? WHERE id = ?");
    for (const row of rows) {
      const next = Math.max(row.expires_at, row.last_paid_at + 30 * 86_400);
      if (next === row.expires_at) continue;
      update.run(next, row.id);
      changed.push({ purchaseId: row.id, from: row.expires_at, to: next });
    }
    // **手動配送の旧月額は販売を止める。** Botが利用権の実体を管理していないので
    // （どのDiscordロールが契約かDBが知らない）、汎用の30日延長を受け付けられない。
    // 既存契約は期限まで有効なまま残し、専用台帳へ移すまで新規購入だけ塞ぐ
    const stopped = db
      .prepare("UPDATE shop_items SET enabled = 0, updated_at = ? WHERE kind = 'monthly' AND delivery <> 'auto' AND enabled = 1")
      .run(ts).changes;

    db.prepare("INSERT INTO outbox (kind, payload, created_at) VALUES ('audit_log', ?, ?)").run(
      JSON.stringify({
        event: "shop_term_migrated_to_30d",
        items: target.n,
        contracts: rows.length,
        extended: changed,
        stoppedManualMonthly: stopped,
        actor: "system:migration",
      }),
      ts,
    );
  });
  run.immediate();
}

/**
 * 名前変更をセルフサービスへ切り替える（運営が有効化したときだけ）。
 *
 * `shop:nickname_item_id` が指す商品を「Botが自分で処理する商品」にする。
 * **設定が無ければ何もしない**ので、コードを入れただけでは挙動が変わらない。
 *
 * ## 反映のタイミング
 *
 * ここは `openDb()` の中、つまり**起動時にだけ**走る。設定を入れただけでは
 * 商品は切り替わらず、**Botの再起動（deploy で自動）で反映**される。
 * 起動を待たずに反映したい場合は、設定を書いたあとにこの関数を直接呼ぶ。
 */
/**
 * オリジナルロールの新規作成を、Botが自分で処理する商品にする（運営が有効化したときだけ）。
 * `shop:original_role_item_id` が指す商品だけを切り替える。**設定が無ければ何もしない。**
 * 反映は `openDb()` の中＝起動時（deploy で自動）。
 */
export function applyOriginalRoleItemSetting(db: Database.Database): void {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'shop:original_role_item_id'").get() as
    | { value: string }
    | undefined;
  const itemId = Number(row?.value);
  if (!Number.isInteger(itemId) || itemId <= 0) return;
  db.prepare(
    `UPDATE shop_items
        SET delivery = 'auto', delivery_kind = 'create_original_role', updated_at = ?
      WHERE id = ? AND (delivery <> 'auto' OR delivery_kind IS NOT 'create_original_role')`,
  ).run(Math.floor(Date.now() / 1000), itemId);
}

/**
 * `shop:sub_account_item_id` が指す商品を「Botが自分で処理する商品」にする。
 *
 * **同時に魔人以上の要件を必ず固定する。** 旧商品#4は `require_role_id` が
 * 作成時から未設定のまま売られ、迷霊のまま購入が成立した。運用ルールを人の記憶に
 * 置いた結果なので、開業の手続きそのものに要件の設定を組み込む。
 *
 * `role:majin` が未設定なら**何もしない**（fail-closed）。要件を付けられないまま
 * 自動化だけ進むと、同じ事故をもう一度起こす。
 *
 * なお資格判定の正本は `souls.status` の3段階判定（申請・承認・支払い直前）で、
 * ここで入れる Discord ロール要件は**二重防御**。
 */
export function applySubAccountItemSetting(db: Database.Database): void {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'shop:sub_account_item_id'").get() as
    | { value: string }
    | undefined;
  const itemId = Number(row?.value);
  if (!Number.isInteger(itemId) || itemId <= 0) return;
  const majin = db.prepare("SELECT value FROM settings WHERE key = 'role:majin'").get() as
    | { value: string }
    | undefined;
  const majinRoleId = majin?.value?.trim();
  // **要件を付けられないなら自動化もしない**
  if (!majinRoleId) return;
  db.prepare(
    `UPDATE shop_items
        SET delivery = 'auto', delivery_kind = 'activate_sub_account', require_role_id = ?, updated_at = ?
      WHERE id = ?
        AND (delivery <> 'auto' OR delivery_kind IS NOT 'activate_sub_account' OR require_role_id IS NOT ?)`,
  ).run(majinRoleId, Math.floor(Date.now() / 1000), itemId, majinRoleId);
}

export function applyNicknameItemSetting(db: Database.Database): void {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'shop:nickname_item_id'").get() as
    | { value: string }
    | undefined;
  const itemId = Number(row?.value);
  if (!Number.isInteger(itemId) || itemId <= 0) return;
  db.prepare(
    `UPDATE shop_items
        SET delivery = 'auto', delivery_kind = 'set_nickname', updated_at = ?
      WHERE id = ? AND (delivery <> 'auto' OR delivery_kind IS NOT 'set_nickname')`,
  ).run(Math.floor(Date.now() / 1000), itemId);
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
