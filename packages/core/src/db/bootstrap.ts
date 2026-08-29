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
CREATE INDEX IF NOT EXISTS idx_rooms_owner_history ON rooms(owner_id, kind, created_at);

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

-- 評価フォーラムv2。旧 eval_threads は既存 Evaluation API / 履歴互換のためそのまま残し、
-- 新方式だけを評価サイクル単位の additive table へ保存する。
CREATE TABLE IF NOT EXISTS eval_cycle_threads (
  user_id          TEXT NOT NULL,
  cycle_started_at INTEGER NOT NULL,
  thread_id        TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (user_id, cycle_started_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_cycle_threads_thread
  ON eval_cycle_threads(thread_id);

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
  self_deafened INTEGER NOT NULL DEFAULT 0,
  -- ended_at の値の出自。NULL=まだ開いている、または本列追加前のlegacy行で品質不明。
  -- 'observed'=通常のVoiceStateUpdateで閉じた。'recovered_estimate'=closeAllDangling()の推定値。
  -- 既存closed行をobservedへ推測で埋めてはいけない（title称号の取得順証明に使うため）。
  end_quality   TEXT,
  -- この行が開いた理由。NULL=本列追加前のlegacy行（品質不明）。
  -- 'join'=切断状態からの新規入室。'move'=チャンネル移動。'state_change'=同一チャンネル内の
  -- mute/deafen変化。derived layer(vc/derived.ts)のcoalesceは 'state_change' のときだけ
  -- 前segmentへ合成してよい（'join'/'move'は同一visitの継続とはみなさない）。
  start_reason  TEXT
);
CREATE INDEX IF NOT EXISTS idx_vc_user ON vc_segments(user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_vc_open ON vc_segments(ended_at) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vc_channel ON vc_segments(channel_id, started_at);

-- main guildのpublic GuildVoiceで、human occupancy >= 2だったことをlive eventで
-- 観測したuser-level interval。guild/channel identityはpublic判定の再収束にだけ使い、
-- title safe payloadへは出さない。observed endは通常transitionまたはGateway/writerの
-- exact trust-loss boundary。recovered_estimateはクラッシュ時の終了境界が不明なので
-- derived readerが信頼せず、起動時刻までのdowntimeをbackfillしない。
CREATE TABLE IF NOT EXISTS vc_public_social_presence (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  guild_id    TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  started_at  INTEGER NOT NULL CHECK (started_at >= 0),
  ended_at    INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
  end_quality TEXT CHECK (end_quality IS NULL OR end_quality IN ('observed','recovered_estimate'))
);

-- Titles v2 F3a: souls.status のcanonical append-only temporal provenance。
-- baseline/transitionのcapture triggerはsouls CHECK migration後にinstallする。
CREATE TABLE IF NOT EXISTS soul_status_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('waiting','ghost','majin','kenma','mazoku','meirei','departed')),
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  provenance  TEXT NOT NULL CHECK (provenance IN ('f3a_baseline','soul_insert','status_transition'))
);
CREATE INDEX IF NOT EXISTS idx_soul_status_history_user_time
  ON soul_status_history(user_id, observed_at, id);
CREATE INDEX IF NOT EXISTS idx_vc_public_social_user
  ON vc_public_social_presence(user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_vc_public_social_channel
  ON vc_public_social_presence(guild_id, channel_id, started_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vc_public_social_open_user_channel
  ON vc_public_social_presence(user_id, guild_id, channel_id)
  WHERE ended_at IS NULL;

-- 公開TCの会話構造を後から安全に分類するためのrestricted metadata正本。
-- message本文・attachment・embed・mention・emoji等はschema自体に持たない。
CREATE TABLE IF NOT EXISTS tc_message_observations (
  message_id          TEXT PRIMARY KEY,
  author_id           TEXT NOT NULL,
  surface_id          TEXT NOT NULL,
  area_id             TEXT NOT NULL,
  surface_kind        TEXT NOT NULL CHECK (surface_kind IN ('channel','public_thread','announcement_thread','forum_post')),
  reply_to_message_id TEXT,
  created_at_ms       INTEGER NOT NULL CHECK (created_at_ms >= 0),
  observed_at_ms      INTEGER NOT NULL CHECK (observed_at_ms >= 0),
  thread_owner_id     TEXT,
  thread_created_at_ms INTEGER CHECK (thread_created_at_ms IS NULL OR thread_created_at_ms >= 0)
);
CREATE INDEX IF NOT EXISTS idx_tc_message_author_created
  ON tc_message_observations(author_id, created_at_ms, message_id);
CREATE INDEX IF NOT EXISTS idx_tc_message_area_created
  ON tc_message_observations(area_id, created_at_ms, message_id);
CREATE INDEX IF NOT EXISTS idx_tc_message_surface_created
  ON tc_message_observations(surface_id, created_at_ms, message_id);
CREATE INDEX IF NOT EXISTS idx_tc_message_reply
  ON tc_message_observations(reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;

-- Discord reaction addにはcanonical occurrence timestampが無いため、Botが初めて
-- 観測した時刻だけを保存する。emojiは保存せず、1 post × 1 reactorを最大1 factにする。
CREATE TABLE IF NOT EXISTS tc_reaction_observations (
  message_id     TEXT NOT NULL REFERENCES tc_message_observations(message_id),
  reactor_id     TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
  PRIMARY KEY (message_id, reactor_id)
);
CREATE INDEX IF NOT EXISTS idx_tc_reaction_observed_message
  ON tc_reaction_observations(observed_at_ms, message_id);

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

-- Titles v2 F3a: explicit versioned role-family manifest。current departments.role_idを
-- 過去へJOINせず、観測したrevisionへ凍結する。
CREATE TABLE IF NOT EXISTS role_family_manifest_revisions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL,
  activated_at INTEGER NOT NULL CHECK (activated_at >= 0),
  fingerprint  TEXT NOT NULL,
  provenance   TEXT NOT NULL CHECK (provenance IN ('departments_snapshot','explicit_manifest'))
);
CREATE INDEX IF NOT EXISTS idx_role_family_manifest_revision_guild_time
  ON role_family_manifest_revisions(guild_id, activated_at, id);
CREATE TABLE IF NOT EXISTS role_family_manifest_families (
  revision_id INTEGER NOT NULL REFERENCES role_family_manifest_revisions(id),
  family_key  TEXT NOT NULL,
  PRIMARY KEY (revision_id, family_key)
);
CREATE TABLE IF NOT EXISTS role_family_manifest_family_tags (
  revision_id INTEGER NOT NULL,
  family_key  TEXT NOT NULL,
  tag         TEXT NOT NULL CHECK (tag IN ('public_department','inn','economy','shop','casino')),
  PRIMARY KEY (revision_id, family_key, tag),
  FOREIGN KEY (revision_id, family_key)
    REFERENCES role_family_manifest_families(revision_id, family_key)
);
CREATE TABLE IF NOT EXISTS role_family_manifest_roles (
  revision_id INTEGER NOT NULL,
  family_key  TEXT NOT NULL,
  role_id     TEXT NOT NULL,
  PRIMARY KEY (revision_id, family_key, role_id),
  FOREIGN KEY (revision_id, family_key)
    REFERENCES role_family_manifest_families(revision_id, family_key)
);
CREATE INDEX IF NOT EXISTS idx_role_family_manifest_roles_lookup
  ON role_family_manifest_roles(revision_id, role_id, family_key);

CREATE TABLE IF NOT EXISTS role_observation_sessions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id           TEXT NOT NULL,
  manifest_revision_id INTEGER NOT NULL REFERENCES role_family_manifest_revisions(id),
  started_at         INTEGER NOT NULL CHECK (started_at >= 0),
  last_checkpoint_at INTEGER NOT NULL CHECK (last_checkpoint_at >= started_at),
  ended_at           INTEGER,
  end_quality        TEXT CHECK (end_quality IS NULL OR end_quality IN (
    'disconnect','guild_unavailable','guild_delete','manifest_change','shutdown','crash_recovered'
  )),
  CHECK ((ended_at IS NULL AND end_quality IS NULL)
      OR (ended_at IS NOT NULL AND ended_at >= started_at AND end_quality IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_role_observation_one_open_session
  ON role_observation_sessions(guild_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS role_family_member_presence (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id             TEXT NOT NULL,
  session_id           INTEGER NOT NULL REFERENCES role_observation_sessions(id),
  manifest_revision_id INTEGER NOT NULL REFERENCES role_family_manifest_revisions(id),
  user_id              TEXT NOT NULL,
  family_key           TEXT NOT NULL,
  started_at           INTEGER NOT NULL CHECK (started_at >= 0),
  ended_at             INTEGER,
  end_reason           TEXT CHECK (end_reason IS NULL OR end_reason IN (
    'role_removed','member_unknown','member_left','disconnect','guild_unavailable',
    'guild_delete','manifest_change','shutdown','crash_recovered','session_replaced'
  )),
  FOREIGN KEY (manifest_revision_id, family_key)
    REFERENCES role_family_manifest_families(revision_id, family_key),
  CHECK ((ended_at IS NULL AND end_reason IS NULL)
      OR (ended_at IS NOT NULL AND ended_at >= started_at AND end_reason IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_role_family_member_one_open
  ON role_family_member_presence(guild_id, user_id, family_key) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_role_family_member_presence_user_time
  ON role_family_member_presence(user_id, started_at, ended_at);

CREATE TRIGGER IF NOT EXISTS trg_role_manifest_revision_no_update
BEFORE UPDATE ON role_family_manifest_revisions BEGIN
  SELECT RAISE(ABORT, 'role family manifest revisions are append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_role_manifest_revision_no_delete
BEFORE DELETE ON role_family_manifest_revisions BEGIN
  SELECT RAISE(ABORT, 'role family manifest revisions are append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_role_manifest_family_no_update
BEFORE UPDATE ON role_family_manifest_families BEGIN
  SELECT RAISE(ABORT, 'role family manifest families are append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_role_manifest_family_no_delete
BEFORE DELETE ON role_family_manifest_families BEGIN
  SELECT RAISE(ABORT, 'role family manifest families are append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_role_manifest_tag_no_update
BEFORE UPDATE ON role_family_manifest_family_tags BEGIN
  SELECT RAISE(ABORT, 'role family manifest tags are append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_role_manifest_tag_no_delete
BEFORE DELETE ON role_family_manifest_family_tags BEGIN
  SELECT RAISE(ABORT, 'role family manifest tags are append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_role_manifest_role_no_update
BEFORE UPDATE ON role_family_manifest_roles BEGIN
  SELECT RAISE(ABORT, 'role family manifest roles are append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_role_manifest_role_no_delete
BEFORE DELETE ON role_family_manifest_roles BEGIN
  SELECT RAISE(ABORT, 'role family manifest roles are append-only');
END;

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

-- Titles v2 F2k: shop_purchases は通常商館・特別service・legacy移行を同じ表へ持つため、
-- purchase時点のcanonical origin/product identityを別のappend-only provenanceへ凍結する。
-- 既存rowをcurrent shop_items/request/reasonから推測してbackfillしない。
CREATE TABLE IF NOT EXISTS shop_purchase_title_provenance (
  purchase_id       INTEGER PRIMARY KEY REFERENCES shop_purchases(id),
  user_id           TEXT NOT NULL,
  product_key       TEXT NOT NULL,
  purchased_at      INTEGER NOT NULL,
  origin            TEXT NOT NULL CHECK (origin IN (
    'storefront',
    'original_role_application',
    'original_role_invoice',
    'evaluation_extension',
    'reevaluation',
    'legacy_timed_access_import'
  )),
  title_eligible    INTEGER NOT NULL CHECK (title_eligible IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_shop_purchase_title_provenance_user_time
  ON shop_purchase_title_provenance(user_id, purchased_at, purchase_id);

-- Phase D: 購入した時点の「提供のしかた」を凍結する。
--
-- delivery_snapshot_json が NULL でも「手動配送だった」の証拠にならない。snapshotは
-- delivery='auto' のときしか作られないので、snapshot導入前のauto購入もNULLになる。
-- 現在の shop_items.delivery から遡って推測すると、商品を自動化しただけで過去の仕事が
-- 消え、手動化しただけで過去の購入が仕事として湧く。だから購入時の事実を別に残す。
--
-- stock_consumed は「item.stockが有限そうだった」ではなく、**この購入のtransactionの中で
-- 実際に在庫を1減らした**という事実。未提供のまま返金するとき、この1枠だけを戻す根拠になる。
-- 既存rowをcurrent shop_itemsから推測してbackfillしない（証明できないものはunknownのまま）。
CREATE TABLE IF NOT EXISTS shop_purchase_fulfillment_provenance (
  purchase_id     INTEGER PRIMARY KEY REFERENCES shop_purchases(id),
  delivery_mode   TEXT NOT NULL CHECK (delivery_mode IN ('auto','manual')),
  stock_consumed  INTEGER NOT NULL CHECK (stock_consumed IN (0,1)),
  captured_at     INTEGER NOT NULL,
  source          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_purchase_fulfillment_mode
  ON shop_purchase_fulfillment_provenance(delivery_mode, purchase_id);

-- 在庫を戻した記録。purchase_idがPRIMARY KEYなので、返金が二度走っても在庫は二度戻らない。
--
-- applied=1 … 実際に shop_items.stock を +1 した（現在も有限在庫の商品）
-- applied=0 … 現在は無制限販売なので数値は動かさない。ただし「1枠を戻すべきだった」という
--             事実は消さずに残す（後で有限へ戻すときの判断材料。今回はその設計をしない）
CREATE TABLE IF NOT EXISTS shop_purchase_stock_restorations (
  purchase_id  INTEGER PRIMARY KEY REFERENCES shop_purchases(id),
  item_id      INTEGER NOT NULL,
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  restored_at  INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  applied      INTEGER NOT NULL CHECK (applied IN (0,1))
);

-- Phase E: この購入は「購入した時点でどのロールを与える契約だったか」を凍結する。
--
-- 失効時のロール剥奪対象を、現在の shop_items.delivery_data から引くと、運営が商品の
-- ロール設定を R1 から R2 へ変えただけで、**過去の購入から R2 を剥がす**ことになる。
-- その購入で R2 を与えた証拠はどこにも無い。だから購入時の事実を別に残す。
--
-- 自動配送のスナップショット（delivery_snapshot_json）は auto 購入しか持たないので、
-- 手動配送の add_role 商品もここに記録する。
-- **行が無いこと**を「ロール商品ではなかった」の証拠にしない。add_role なのに
-- role_id が壊れている購入も、非ロール商品も、同じ「行が無い」になってしまうため。
-- 購入時にどちらだったかを grant_kind として明示的に凍結する。
--
--   role      … add_role で、対象ロールを特定できた（role_id あり）
--   non_role  … ロールを与える契約ではなかった（role_id なし）
--   invalid   … add_role だが対象を特定できなかった（role_id なし・推測しない）
CREATE TABLE IF NOT EXISTS shop_purchase_role_grant_provenance (
  purchase_id    INTEGER PRIMARY KEY REFERENCES shop_purchases(id),
  grant_kind     TEXT NOT NULL CHECK (grant_kind IN ('role','non_role','invalid')),
  role_id        TEXT,
  delivery_mode  TEXT NOT NULL CHECK (delivery_mode IN ('auto','manual')),
  source         TEXT NOT NULL,
  captured_at    INTEGER NOT NULL,
  CHECK ((grant_kind = 'role') = (role_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_shop_purchase_role_grant_role
  ON shop_purchase_role_grant_provenance(role_id, purchase_id);

-- Phase D round 2: 「配送したか」と「自動で再実行してよいか」を分ける。
--
-- 購入時autoのスナップショットは **配送方式** の証拠であって、**配送が成功した** 証拠では
-- ない。しかし古い add_role / extend_deadline を機械的に流し直すのは危険なので、
-- 「再実行しない」を delivery_state='delivered'（＝成功した）と書いて表現していた。
-- それは事実の記録として嘘なので、抑止だけを別の台帳へ出す。
--
--   配送の真実  … delivered_at / shop_delivered event / provenance付きのdelivered
--   再実行の可否 … この表
--
-- append-only。purchase_id が主キーなので二重登録されない。
CREATE TABLE IF NOT EXISTS shop_delivery_replay_suppressions (
  purchase_id  INTEGER PRIMARY KEY REFERENCES shop_purchases(id),
  reason       TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

-- status current-stateだけではfixed observedAtを再現できない。refund/cancel occurrenceを
-- purchaseごとに一度だけappendし、historical snapshotは occurred_at で切る。
CREATE TABLE IF NOT EXISTS shop_purchase_status_history (
  purchase_id  INTEGER NOT NULL REFERENCES shop_purchases(id),
  status       TEXT NOT NULL CHECK (status IN ('refunded','cancelled')),
  occurred_at  INTEGER NOT NULL,
  PRIMARY KEY (purchase_id, status)
);
CREATE INDEX IF NOT EXISTS idx_shop_purchase_status_history_snapshot
  ON shop_purchase_status_history(purchase_id, occurred_at, status);

CREATE TRIGGER IF NOT EXISTS trg_shop_purchase_title_provenance_no_update
BEFORE UPDATE ON shop_purchase_title_provenance
BEGIN
  SELECT RAISE(ABORT, 'shop purchase title provenance is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_shop_purchase_title_provenance_no_delete
BEFORE DELETE ON shop_purchase_title_provenance
BEGIN
  SELECT RAISE(ABORT, 'shop purchase title provenance is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_shop_purchase_role_grant_provenance_no_update
BEFORE UPDATE ON shop_purchase_role_grant_provenance
BEGIN
  SELECT RAISE(ABORT, 'shop purchase role grant provenance is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_shop_purchase_role_grant_provenance_no_delete
BEFORE DELETE ON shop_purchase_role_grant_provenance
BEGIN
  SELECT RAISE(ABORT, 'shop purchase role grant provenance is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_shop_delivery_replay_suppressions_no_update
BEFORE UPDATE ON shop_delivery_replay_suppressions
BEGIN
  SELECT RAISE(ABORT, 'shop delivery replay suppression is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_shop_delivery_replay_suppressions_no_delete
BEFORE DELETE ON shop_delivery_replay_suppressions
BEGIN
  SELECT RAISE(ABORT, 'shop delivery replay suppression is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_shop_purchase_fulfillment_provenance_no_update
BEFORE UPDATE ON shop_purchase_fulfillment_provenance
BEGIN
  SELECT RAISE(ABORT, 'shop purchase fulfillment provenance is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_shop_purchase_fulfillment_provenance_no_delete
BEFORE DELETE ON shop_purchase_fulfillment_provenance
BEGIN
  SELECT RAISE(ABORT, 'shop purchase fulfillment provenance is append-only');
END;
-- Phase F: 「戻すべきだった在庫」(applied=0) をどう始末したかの台帳。
--
-- shop_purchase_stock_restorations は返金時点の事実なので append-only のまま触らない
-- （applied=0 を 1 へ書き換えない）。始末は別の事実として、こちらへ1行だけ足す。
--
-- disposition
--   applied  … 運営が入力した数に返金分を上乗せした（実際に在庫が増えた）
--   absorbed … 運営が入力した数を「最終販売可能数」として確定し、その中に含めた
--
-- purchase_id が主キーなので、**同じ返金義務を二度始末できない**。
CREATE TABLE IF NOT EXISTS shop_stock_restoration_settlements (
  purchase_id  INTEGER PRIMARY KEY REFERENCES shop_purchase_stock_restorations(purchase_id),
  item_id      INTEGER NOT NULL,
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  disposition  TEXT NOT NULL CHECK (disposition IN ('applied','absorbed')),
  settled_at   INTEGER NOT NULL,
  actor_id     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_stock_restoration_settlements_item
  ON shop_stock_restoration_settlements(item_id, purchase_id);
CREATE TRIGGER IF NOT EXISTS trg_shop_stock_restoration_settlements_no_update
BEFORE UPDATE ON shop_stock_restoration_settlements
BEGIN
  SELECT RAISE(ABORT, 'shop stock restoration settlement ledger is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_shop_stock_restoration_settlements_no_delete
BEFORE DELETE ON shop_stock_restoration_settlements
BEGIN
  SELECT RAISE(ABORT, 'shop stock restoration settlement ledger is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_shop_purchase_stock_restorations_no_update
BEFORE UPDATE ON shop_purchase_stock_restorations
BEGIN
  SELECT RAISE(ABORT, 'shop stock restoration ledger is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_shop_purchase_stock_restorations_no_delete
BEFORE DELETE ON shop_purchase_stock_restorations
BEGIN
  SELECT RAISE(ABORT, 'shop stock restoration ledger is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_shop_purchase_status_history_no_update
BEFORE UPDATE ON shop_purchase_status_history
BEGIN
  SELECT RAISE(ABORT, 'shop purchase status history is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_shop_purchase_status_history_no_delete
BEFORE DELETE ON shop_purchase_status_history
BEGIN
  SELECT RAISE(ABORT, 'shop purchase status history is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_shop_purchase_status_history_capture
AFTER UPDATE OF status ON shop_purchases
WHEN OLD.status <> NEW.status AND NEW.status IN ('refunded','cancelled')
BEGIN
  INSERT OR IGNORE INTO shop_purchase_status_history (purchase_id, status, occurred_at)
  VALUES (
    NEW.id,
    NEW.status,
    unixepoch()
  );
END;

CREATE TABLE IF NOT EXISTS shop_timed_access_legacy_runs (
  migration_key TEXT PRIMARY KEY,
  plan_json     TEXT NOT NULL,
  actor_id      TEXT NOT NULL,
  reason        TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  completed_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shop_timed_access_legacy_imports (
  purchase_id   INTEGER PRIMARY KEY REFERENCES shop_purchases(id),
  migration_key TEXT NOT NULL REFERENCES shop_timed_access_legacy_runs(migration_key),
  item_id       INTEGER NOT NULL REFERENCES shop_items(id),
  user_id       TEXT NOT NULL,
  role_id       TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  reason        TEXT NOT NULL,
  actor_id      TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE(item_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_shop_timed_access_legacy_imports_run
  ON shop_timed_access_legacy_imports(migration_key, item_id);

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

-- オリジナルロールの人対応カルテ。既存 original_roles は契約/実ロール互換台帳として残す。
CREATE TABLE IF NOT EXISTS original_role_cases (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_thread_id TEXT NOT NULL UNIQUE REFERENCES tickets(thread_id) ON DELETE RESTRICT,
  user_id          TEXT NOT NULL,
  original_role_id INTEGER UNIQUE REFERENCES original_roles(id),
  created_by       TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_original_role_cases_user ON original_role_cases(user_id, id);

-- 金額と意味を分離して明示保存する。Botは金額から new/continuation/restart を推測しない。
CREATE TABLE IF NOT EXISTS original_role_invoices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES original_role_cases(id) ON DELETE RESTRICT,
  user_id        TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('new','continuation','restart','exception')),
  amount         INTEGER NOT NULL CHECK (amount > 0),
  reason         TEXT,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','cancelled')),
  issued_by      TEXT NOT NULL,
  issued_at      INTEGER NOT NULL,
  paid_by        TEXT,
  paid_at        INTEGER,
  purchase_id    INTEGER UNIQUE REFERENCES shop_purchases(id),
  transaction_id INTEGER UNIQUE REFERENCES transactions(id),
  cancelled_by   TEXT,
  cancelled_at   INTEGER,
  CHECK (kind <> 'exception' OR (reason IS NOT NULL AND length(trim(reason)) > 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_original_role_invoice_pending
  ON original_role_invoices(case_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_original_role_invoices_user ON original_role_invoices(user_id, issued_at);
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

-- 評価期間+1日の使用台帳。eval_started_atをサイクルIDとして期限変化を監査する。
-- 旧購入は推測backfillせず、V2購入から追記する。
CREATE TABLE IF NOT EXISTS shop_eval_extension_uses (
  purchase_id          INTEGER PRIMARY KEY REFERENCES shop_purchases(id),
  item_id              INTEGER NOT NULL REFERENCES shop_items(id),
  user_id              TEXT NOT NULL,
  eval_started_at      INTEGER NOT NULL,
  previous_deadline_at INTEGER NOT NULL,
  new_deadline_at      INTEGER NOT NULL,
  sequence             INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 5),
  created_at           INTEGER NOT NULL,
  UNIQUE(user_id, eval_started_at, sequence)
);
CREATE INDEX IF NOT EXISTS idx_shop_eval_extension_uses_cycle
  ON shop_eval_extension_uses(user_id, eval_started_at, sequence);
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

/**
 * Titles v2 F3a: every souls.status writerをDB boundaryで捕捉する。
 *
 * 既存rowはこのmigrationを実際に観測したDB時刻からbaseline化し、joined_at/ghost_at/
 * updated_atへbackdateしない。triggerはstatusがsemanticに変化したUPDATEだけをappendするため、
 * repo内のservice writer・rank-sync・直SQL writerを個別に列挙して取りこぼす余地がない。
 */
function ensureSoulStatusHistory(db: Database.Database): void {
  const install = db.transaction(() => {
    db.prepare(
      `INSERT INTO soul_status_history (user_id, status, observed_at, provenance)
       SELECT s.user_id, s.status, unixepoch(), 'f3a_baseline'
         FROM souls s
        WHERE NOT EXISTS (
          SELECT 1 FROM soul_status_history h WHERE h.user_id = s.user_id
        )`,
    ).run();
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_soul_status_history_insert
      AFTER INSERT ON souls
      BEGIN
        INSERT INTO soul_status_history (user_id, status, observed_at, provenance)
        VALUES (NEW.user_id, NEW.status, unixepoch(), 'soul_insert');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_soul_status_history_transition
      AFTER UPDATE OF status ON souls
      WHEN OLD.status IS NOT NEW.status
      BEGIN
        INSERT INTO soul_status_history (user_id, status, observed_at, provenance)
        VALUES (NEW.user_id, NEW.status, unixepoch(), 'status_transition');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_soul_status_history_no_update
      BEFORE UPDATE ON soul_status_history
      BEGIN
        SELECT RAISE(ABORT, 'soul status history is append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_soul_status_history_no_delete
      BEFORE DELETE ON soul_status_history
      BEGIN
        SELECT RAISE(ABORT, 'soul status history is append-only');
      END;
    `);
  });
  install.immediate();
}

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
  // 既存本番行はNULL（品質不明）のまま残る。observedと推測して書き換えない。
  ensureColumn(db, "vc_segments", "end_quality", "TEXT");
  // 既存本番行はNULL（理由不明）のまま残る。joinやstate_changeへ推測で埋めない。
  ensureColumn(db, "vc_segments", "start_reason", "TEXT");
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
  // Phase E: 「このworkerがDiscordのroleを外しにいった」ことを**DBに**残す。
  // メモリ上のフラグでは remove 成功直後にプロセスが落ちた場合に失われ、
  // 再起動後は「有効な契約がある」だけを見て done にしてしまう
  // （＝roleが無いまま失効処理が完了扱いになる）。
  ensureColumn(db, "shop_role_revocations", "remove_attempted_at", "INTEGER");
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
    CREATE INDEX IF NOT EXISTS idx_rooms_owner_history
      ON rooms(owner_id, kind, created_at);
  `);
  backfillEvaluationMarkWeights(db);
  backfillEvaluationPolicySnapshots(db);
  migrateRoleGrantProvenanceShape(db);
  backfillShopDeliveryState(db);
  backfillLegacyAutoReplaySuppression(db);
  backfillEverMeirei(db);
  backfillInviteThresholdSnapshot(db);
  ensureSoulStatusHistory(db);
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
/**
 * 既に移行済みの旧auto購入へ、再実行抑止を後追いで記録する。
 *
 * `backfillShopDeliveryState()` は `delivery_state IS NULL` の行しか触らないので、
 * 以前のバージョンで移行済みの行（`delivered` と書かれてしまった行）には抑止の記録が
 * 無い。状態値そのものは書き換えない——過去の記録を塗り替えるより、**その値をどこでも
 * 根拠にしない**方が安全で、監査もしやすい。ここでは「自動では流し直さない」という
 * 判断だけを追加する。購入・Land・在庫には一切触れない。
 */
function backfillLegacyAutoReplaySuppression(db: Database.Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO shop_delivery_replay_suppressions (purchase_id,reason,created_at)
     SELECT p.id, 'legacy_auto_outcome_unknown', ?
       FROM shop_purchases p
      WHERE p.status = 'active'
        AND p.delivered_at IS NULL
        AND p.delivery_snapshot_json IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM shop_purchase_fulfillment_provenance f WHERE f.purchase_id = p.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM events e
           WHERE e.type = 'shop_delivered'
             AND CASE
                   WHEN e.payload_json IS NULL THEN 0
                   WHEN NOT json_valid(e.payload_json) THEN 0
                   -- Shop.deliveredEventSql() と同じ厳密さ。整数フィールドとして
                   -- 記録されている場合だけ証拠にする（"5" や 5.0 を 5 に寄せない）。
                   -- ここが緩いと、証拠があると誤判定した行に抑止が入らず、
                   -- 古い自動配送が流し直される。
                   WHEN json_type(e.payload_json, '$.purchaseId') <> 'integer' THEN 0
                   ELSE COALESCE(json_extract(e.payload_json, '$.purchaseId') = p.id, 0)
                 END
        )`,
  ).run(Math.floor(Date.now() / 1000));
}

/**
 * `shop_purchase_role_grant_provenance` の旧形（`grant_kind` 無し）を作り直す。
 *
 * この表は本PRで初めて導入したもので、productionにも main にも存在しない。
 * 途中版のブランチで作られたローカルDBだけが旧形を持ちうる。旧形の行はすべて
 * 「対象を特定できた add_role」だったので `grant_kind='role'` として移す。
 */
function migrateRoleGrantProvenanceShape(db: Database.Database): void {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shop_purchase_role_grant_provenance'")
    .get();
  if (!exists) return;
  const columns = db.prepare("PRAGMA table_info(shop_purchase_role_grant_provenance)").all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === "grant_kind")) return;

  db.exec("DROP TRIGGER IF EXISTS trg_shop_purchase_role_grant_provenance_no_update");
  db.exec("DROP TRIGGER IF EXISTS trg_shop_purchase_role_grant_provenance_no_delete");
  db.exec(`
    CREATE TABLE shop_purchase_role_grant_provenance_new (
      purchase_id    INTEGER PRIMARY KEY REFERENCES shop_purchases(id),
      grant_kind     TEXT NOT NULL CHECK (grant_kind IN ('role','non_role','invalid')),
      role_id        TEXT,
      delivery_mode  TEXT NOT NULL CHECK (delivery_mode IN ('auto','manual')),
      source         TEXT NOT NULL,
      captured_at    INTEGER NOT NULL,
      CHECK ((grant_kind = 'role') = (role_id IS NOT NULL))
    );
    INSERT INTO shop_purchase_role_grant_provenance_new
      (purchase_id, grant_kind, role_id, delivery_mode, source, captured_at)
      SELECT purchase_id, 'role', role_id, delivery_mode, source, captured_at
        FROM shop_purchase_role_grant_provenance;
    DROP TABLE shop_purchase_role_grant_provenance;
    ALTER TABLE shop_purchase_role_grant_provenance_new
      RENAME TO shop_purchase_role_grant_provenance;
  `);
  // **作り直したら index と append-only trigger を戻す。**
  // DDLはこのmigrationより先に流れているので、ここで戻さないと
  // 「作り直した直後の1回だけ append-only ではない」DBができてしまう。
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_shop_purchase_role_grant_role
      ON shop_purchase_role_grant_provenance(role_id, purchase_id);
    CREATE TRIGGER IF NOT EXISTS trg_shop_purchase_role_grant_provenance_no_update
    BEFORE UPDATE ON shop_purchase_role_grant_provenance
    BEGIN
      SELECT RAISE(ABORT, 'shop purchase role grant provenance is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_shop_purchase_role_grant_provenance_no_delete
    BEFORE DELETE ON shop_purchase_role_grant_provenance
    BEGIN
      SELECT RAISE(ABORT, 'shop purchase role grant provenance is append-only');
    END;
  `);
}

function backfillShopDeliveryState(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT p.id, p.user_id, p.delivered_at, p.purchased_at, p.delivery_snapshot_json
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
  }>;
  if (rows.length === 0) return;

  const update = db.prepare("UPDATE shop_purchases SET delivery_state = ?, delivery_updated_at = ? WHERE id = ? AND delivery_state IS NULL");
  const markWithdrawn = db.prepare(
    "UPDATE shop_purchases SET delivery_error = 'auto_delivery_withdrawn:revoke_meirei' WHERE id = ? AND delivery_error IS NULL",
  );
  const withdrawn: number[] = [];
  const legacyAuto: number[] = [];
  const suppress = db.prepare(
    "INSERT OR IGNORE INTO shop_delivery_replay_suppressions (purchase_id,reason,created_at) VALUES (?,?,?)",
  );
  const assign = db.transaction(() => {
    for (const row of rows) {
      let state: "delivered" | "pending" | "failed";
      if (row.delivered_at !== null) {
        // 実際に配送した記録がある。これだけが delivered の一次証拠。
        state = "delivered";
      } else {
        // 判定の根拠は**購入時スナップショット**。商品の現在設定は使わない
        const snapshot = parseDeliverySnapshot(row.delivery_snapshot_json);
        if (snapshot === null) {
          // **配送したかどうかを証明できない行。**
          //
          // 以前はここで移行時点の `shop_items.delivery` を見て、auto なら delivered、
          // manual なら pending にしていた。これは「過去の購入時状態を現在の商品設定から
          // 推測しない」に反するうえ、既定値が delivered だったため
          // **配送していない購入が「提供済み」として静かに消える**経路になっていた。
          //
          // 分からないものを delivered と書かない。未提供として pending に置き、
          // 提供済みかどうかは読み手が独立した記録（delivered_at / shop_delivered event）で
          // 判断する。
          state = "pending";
        } else if (WITHDRAWN_DELIVERY_KINDS.has(snapshot.delivery_kind)) {
          // 自動配送を取りやめた種別（再評価チャレンジ）。配送は完了していないが、
          // 自動でも運営の回収導線でも実行しない。事実として failed に置き、
          // 面談導線で人が処理する
          withdrawn.push(row.id);
          state = "failed";
        } else {
          // 購入時autoのスナップショットがある行。**配送方式は分かるが結末は分からない。**
          //
          // 以前はここで delivered と書いていた。理由は「再配送させないため」で、
          // 判断としては正しいが、記録としては嘘になる（成功したとは証明できない）。
          // その嘘を返金も期限付きアクセスも信じてしまう。
          //
          // いまは事実として pending（未提供）に置き、**再実行しないという判断は
          // 別の台帳へ**書く。台帳は下の recordLegacyAutoReplaySuppression() が入れる。
          state = "pending";
          legacyAuto.push(row.id);
        }
      }
      update.run(state, row.delivered_at ?? row.purchased_at, row.id);
    }
    for (const id of withdrawn) markWithdrawn.run(id);
    // 「配送したか分からない」と「自動で流し直してよいか」を別々に記録する。
    const now = Math.floor(Date.now() / 1000);
    for (const id of legacyAuto) suppress.run(id, "legacy_auto_outcome_unknown", now);
    for (const id of withdrawn) suppress.run(id, "auto_delivery_withdrawn", now);
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
