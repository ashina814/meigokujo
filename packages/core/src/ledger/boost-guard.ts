import type Database from "better-sqlite3";

/** サーバーブースト1回あたりのLand報酬。 */
export const BOOST_REWARD_LD = 50_000;
/** 1ユーザーにつき1暦月（JST）に支払うBoost報酬の最大回数。 */
export const BOOST_REWARD_MONTHLY_LIMIT = 2;

/**
 * `reward_boost` のDB不変条件をLedger境界で準備する。
 *
 * - 新規のBoost報酬は必ずDiscordのGuildBoost message IDへ結び付ける
 * - idempotency keyも `boost:<message id>` に固定する
 * - 支給元は国庫、金額は1回50,000Ldに固定する
 * - 同一ユーザーのJST暦月2回上限をDB triggerで最終保証する
 * - 旧来の手動 `reward_boost` は履歴として残し、event行が無い場合は取引日時のJST月で数える
 * - 未解決のBoost eventは別tableへ永続化し、Bot再起動後も後続の先払いを防ぐ
 *
 * Bot固有の初期化に依存させない。`Ledger` を使うmaintenance scriptでも、
 * `reward_boost` を発行する前にこのguardが必ず存在することが目的。
 */
export function ensureBoostRewardLedgerSchema(db: Database.Database): void {
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS boost_reward_events (
        message_id TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        outcome    TEXT NOT NULL CHECK(outcome IN ('paid', 'capped')),
        reward     INTEGER NOT NULL,
        event_at   INTEGER,
        month_key  TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS boost_reward_pending (
        message_id  TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        event_at_ms INTEGER NOT NULL,
        created_at  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_boost_reward_pending_user_event
        ON boost_reward_pending(user_id, event_at_ms, message_id);
    `);

    // #146のdraft途中をローカルDBで起動していても現行schemaへ収束させる。
    const columns = db.prepare("PRAGMA table_info(boost_reward_events)").all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "event_at")) {
      db.exec("ALTER TABLE boost_reward_events ADD COLUMN event_at INTEGER");
    }
    if (!columns.some((c) => c.name === "month_key")) {
      db.exec("ALTER TABLE boost_reward_events ADD COLUMN month_key TEXT");
    }
    db.exec(`
      UPDATE boost_reward_events
         SET event_at = COALESCE(event_at, created_at),
             month_key = COALESCE(month_key, strftime('%Y-%m', COALESCE(event_at, created_at), 'unixepoch', '+9 hours'))
       WHERE event_at IS NULL OR month_key IS NULL;
      CREATE INDEX IF NOT EXISTS idx_boost_reward_events_user_month
        ON boost_reward_events(user_id, month_key, event_at);
    `);

    // trigger定義はversion付きで毎回置換する。DROP→CREATEも同一transactionに閉じ、
    // 新定義の作成に失敗した場合は旧guardごとrollbackする。
    db.exec(`
      DROP TRIGGER IF EXISTS trg_reward_boost_monthly_limit;
      DROP TRIGGER IF EXISTS trg_reward_boost_event_required_v1;
      DROP TRIGGER IF EXISTS trg_reward_boost_event_required_v2;
      DROP TRIGGER IF EXISTS trg_reward_boost_event_required_v3;
      DROP TRIGGER IF EXISTS trg_reward_boost_monthly_limit_v2;
      DROP TRIGGER IF EXISTS trg_reward_boost_monthly_limit_v3;

      CREATE TRIGGER trg_reward_boost_event_required_v3
      BEFORE INSERT ON transactions
      WHEN NEW.type = 'reward_boost' AND NEW.reversal_of IS NULL
      BEGIN
        SELECT CASE WHEN
          NEW.from_account <> 'sys:treasury'
          OR NEW.amount <> ${BOOST_REWARD_LD}
          OR NEW.ref_type IS NOT 'discord_boost'
          OR NEW.ref_id IS NULL
          OR NEW.idempotency_key <> ('boost:' || NEW.ref_id)
          OR NOT EXISTS (
            SELECT 1
              FROM boost_reward_events e
             WHERE e.message_id = NEW.ref_id
               AND ('user:' || e.user_id) = NEW.to_account
               AND e.event_at IS NOT NULL
               AND e.month_key IS NOT NULL
          )
        THEN RAISE(ABORT, 'ERR_BOOST_EVENT_REQUIRED') END;
      END;

      CREATE TRIGGER trg_reward_boost_monthly_limit_v3
      BEFORE INSERT ON transactions
      WHEN NEW.type = 'reward_boost' AND NEW.reversal_of IS NULL
      BEGIN
        SELECT CASE WHEN (
          SELECT COUNT(*)
            FROM transactions t
            LEFT JOIN boost_reward_events e
              ON t.ref_type = 'discord_boost' AND e.message_id = t.ref_id
           WHERE t.type = 'reward_boost'
             AND t.reversal_of IS NULL
             AND t.to_account = NEW.to_account
             AND COALESCE(
                   e.month_key,
                   strftime('%Y-%m', t.created_at, 'unixepoch', '+9 hours')
                 ) = (
                   SELECT e2.month_key
                     FROM boost_reward_events e2
                    WHERE e2.message_id = NEW.ref_id
                 )
        ) >= ${BOOST_REWARD_MONTHLY_LIMIT}
        THEN RAISE(ABORT, 'ERR_BOOST_MONTHLY_LIMIT') END;
      END;
    `);
  });

  migrate.immediate();
}
