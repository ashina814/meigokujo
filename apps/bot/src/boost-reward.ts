import {
  GuildSystemChannelFlags,
  MessageType,
  type Client,
  type Message,
} from "discord.js";
import { TREASURY } from "@meigokujo/core";
import { fmtLd } from "./format.js";
import type { Services } from "./services.js";

/** サーバーブースト1回あたりのLand報酬。 */
export const BOOST_REWARD_LD = 50_000;
/** 1ユーザーにつき1暦月（JST）に支払う最大回数。 */
export const BOOST_REWARD_MONTHLY_LIMIT = 2;

export const BOOST_REWARD_STARTED_AT_SETTING = "boost_reward:auto_started_at";
export const BOOST_REWARD_LAST_RECOVERY_AT_SETTING = "boost_reward:last_recovery_at";

const JST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const RECOVERY_OVERLAP_SEC = 60;
const schemaReady = new WeakSet<object>();

type CountRow = { c: number };
type EventRow = {
  outcome: "paid" | "capped";
  reward: number;
  event_at: number;
  month_key: string;
};

type ApplyResult =
  | { kind: "already" }
  | { kind: "paid"; count: number }
  | { kind: "recovered" }
  | { kind: "capped"; count: number };

function parseEpochSeconds(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** JSTの暦月キー（YYYY-MM）。 */
export function boostRewardMonthKeyJst(nowMs = Date.now()): string {
  const shifted = new Date(nowMs + JST_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** JSTの暦月をUnix秒の半開区間 [start, end) へ変換する。 */
export function boostRewardMonthRangeJst(nowMs = Date.now()): { start: number; end: number } {
  const shifted = new Date(nowMs + JST_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const startMs = Date.UTC(year, month, 1) - JST_OFFSET_MS;
  const endMs = Date.UTC(year, month + 1, 1) - JST_OFFSET_MS;
  return { start: Math.floor(startMs / 1_000), end: Math.floor(endMs / 1_000) };
}

/**
 * Boost報酬用スキーマを起動時に準備する。
 *
 * `reward_boost` はこのBot以外の手動支給経路からも作れるため、月2回上限の最後の砦は
 * アプリのifではなくDB triggerに置く。Discord由来の自動支給は boost_reward_events.month_key、
 * 手動支給はtransactions.created_atのJST月で数える。
 */
export function ensureBoostRewardSchema(services: Services): void {
  if (schemaReady.has(services.db)) return;

  // まず表だけを作る。#146初版の旧表が残っている場合、新列を足す前にindexを張ると失敗するため順序を固定する。
  services.db.exec(`
    CREATE TABLE IF NOT EXISTS boost_reward_events (
      message_id TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      outcome    TEXT NOT NULL CHECK(outcome IN ('paid', 'capped')),
      reward     INTEGER NOT NULL,
      event_at   INTEGER,
      month_key  TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  // #146初版をローカルDBで一度動かしていても安全に新列へ収束させる。
  const columns = services.db.prepare("PRAGMA table_info(boost_reward_events)").all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "event_at")) {
    services.db.exec("ALTER TABLE boost_reward_events ADD COLUMN event_at INTEGER");
  }
  if (!columns.some((c) => c.name === "month_key")) {
    services.db.exec("ALTER TABLE boost_reward_events ADD COLUMN month_key TEXT");
  }
  services.db.exec(`
    UPDATE boost_reward_events
       SET event_at = COALESCE(event_at, created_at),
           month_key = COALESCE(month_key, strftime('%Y-%m', COALESCE(event_at, created_at), 'unixepoch', '+9 hours'))
     WHERE event_at IS NULL OR month_key IS NULL;
    CREATE INDEX IF NOT EXISTS idx_boost_reward_events_user_month
      ON boost_reward_events(user_id, month_key, event_at);
  `);

  services.db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_reward_boost_monthly_limit
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
               ) = COALESCE(
                 (
                   SELECT e2.month_key
                     FROM boost_reward_events e2
                    WHERE NEW.ref_type = 'discord_boost'
                      AND e2.message_id = NEW.ref_id
                 ),
                 strftime('%Y-%m', NEW.created_at, 'unixepoch', '+9 hours')
               )
      ) >= ${BOOST_REWARD_MONTHLY_LIMIT}
      THEN RAISE(ABORT, 'ERR_BOOST_MONTHLY_LIMIT') END;
    END;
  `);

  schemaReady.add(services.db);
}

function paidCountForMonth(services: Services, userId: string, monthKey: string): number {
  const row = services.db
    .prepare(
      `SELECT COUNT(*) AS c
         FROM transactions t
         LEFT JOIN boost_reward_events e
           ON t.ref_type = 'discord_boost' AND e.message_id = t.ref_id
        WHERE t.type = 'reward_boost'
          AND t.reversal_of IS NULL
          AND t.to_account = ?
          AND COALESCE(
                e.month_key,
                strftime('%Y-%m', t.created_at, 'unixepoch', '+9 hours')
              ) = ?`,
    )
    .get(`user:${userId}`, monthKey) as CountRow | undefined;
  return row?.c ?? 0;
}

/** 指定時刻が属するJST月で、実際に支払われたBoost報酬を数える。 */
export function boostRewardPaidCountThisMonth(
  services: Services,
  userId: string,
  nowMs = Date.now(),
): number {
  ensureBoostRewardSchema(services);
  return paidCountForMonth(services, userId, boostRewardMonthKeyJst(nowMs));
}

function eventAlreadyHandled(services: Services, messageId: string): EventRow | undefined {
  return services.db
    .prepare("SELECT outcome, reward, event_at, month_key FROM boost_reward_events WHERE message_id = ?")
    .get(messageId) as EventRow | undefined;
}

function automationStartedAt(services: Services, nowMs = Date.now()): { startedAt: number; created: boolean } {
  const existing = parseEpochSeconds(services.settings.getString(BOOST_REWARD_STARTED_AT_SETTING));
  if (existing !== null) return { startedAt: existing, created: false };

  const startedAt = Math.floor(nowMs / 1_000);
  services.settings.set(BOOST_REWARD_STARTED_AT_SETTING, startedAt, "system:boost-init");
  // 初回導入ではこの時点より前を絶対にbackfillしない。次回起動の走査起点もここから。
  services.settings.set(BOOST_REWARD_LAST_RECOVERY_AT_SETTING, startedAt, "system:boost-init");
  console.info(`[boost] 自動支給を有効化しました start=${startedAt}（過去分は遡及しません）`);
  return { startedAt, created: true };
}

async function notify(message: Message, content: string, userId: string): Promise<void> {
  if (!message.channel.isSendable()) return;
  await message.channel
    .send({
      content,
      allowedMentions: { users: [userId], roles: [] },
    })
    .catch((error) => console.warn(`[boost] 支給通知失敗 message=${message.id}:`, error));
}

/**
 * DiscordのGUILD_BOOSTシステムメッセージを正本として自動支給する。
 * true = boostイベントとして処理対象だった / false = boost以外（呼び出し元は他処理を継続可）。
 */
export async function handleBoostRewardMessage(message: Message, services: Services): Promise<boolean> {
  if (message.type !== MessageType.GuildBoost) return false;

  const mainGuildId = services.settings.getString("guild:main");
  if (!mainGuildId || message.guildId !== mainGuildId) return false;

  const userId = message.author.id;
  if (!userId || message.author.bot) {
    console.warn(`[boost] 実行者を特定できないため支給しません message=${message.id}`);
    return true;
  }

  ensureBoostRewardSchema(services);
  // 通常はClientReady初期化で開始時刻が先に入る。もし初期化より先にBoostが届いた場合だけ、
  // そのBoost自身の発生時刻を開始点にして「最初の1回」を秒境界で落とさない。
  const { startedAt } = automationStartedAt(services, message.createdTimestamp);
  const eventAt = Math.floor(message.createdTimestamp / 1_000);
  if (eventAt < startedAt) {
    console.info(`[boost] 自動化開始前のイベントをスキップ message=${message.id} eventAt=${eventAt} start=${startedAt}`);
    return true;
  }
  const monthKey = boostRewardMonthKeyJst(message.createdTimestamp);

  const apply = services.db.transaction((): ApplyResult => {
    if (eventAlreadyHandled(services, message.id)) return { kind: "already" };

    // 最初のwriteをイベント仮記録にしてIMMEDIATE transaction内で月次判定と送金を直列化する。
    // cappedを仮値に使うが、このtransactionが失敗すれば丸ごとrollbackされる。
    services.db
      .prepare(
        `INSERT INTO boost_reward_events
           (message_id, user_id, outcome, reward, event_at, month_key, created_at)
         VALUES (?, ?, 'capped', 0, ?, ?, ?)`,
      )
      .run(message.id, userId, eventAt, monthKey, Math.floor(Date.now() / 1_000));

    // #146初版の「送金成功→イベント記録前クラッシュ」を模した既存データにも収束できる。
    const prior = services.ledger.findByIdempotencyKey(`boost:${message.id}`);
    if (prior) {
      services.db
        .prepare("UPDATE boost_reward_events SET outcome = 'paid', reward = ? WHERE message_id = ?")
        .run(prior.amount, message.id);
      return { kind: "recovered" };
    }

    const paidCount = paidCountForMonth(services, userId, monthKey);
    if (paidCount >= BOOST_REWARD_MONTHLY_LIMIT) {
      return { kind: "capped", count: paidCount };
    }

    const accountId = `user:${userId}`;
    services.ledger.ensureAccount(accountId, "user");
    const result = services.ledger.transfer({
      from: TREASURY,
      to: accountId,
      amount: BOOST_REWARD_LD,
      type: "reward_boost",
      actor: "system:boost",
      reason: "サーバーブースト報酬",
      refType: "discord_boost",
      refId: message.id,
      idempotencyKey: `boost:${message.id}`,
    });

    services.db
      .prepare("UPDATE boost_reward_events SET outcome = 'paid', reward = ? WHERE message_id = ?")
      .run(BOOST_REWARD_LD, message.id);

    if (result.duplicate) return { kind: "recovered" };
    return { kind: "paid", count: paidCount + 1 };
  });

  const result = apply.immediate();
  if (result.kind === "already") {
    console.info(`[boost] 処理済みイベントをスキップ message=${message.id} user=${userId}`);
    return true;
  }
  if (result.kind === "recovered") {
    console.info(`[boost] 送金済みイベントを記録へ追いつかせました message=${message.id} user=${userId}`);
    return true;
  }
  if (result.kind === "capped") {
    console.info(
      `[boost] 月次上限のため支給なし message=${message.id} user=${userId} month=${monthKey} count=${result.count}/${BOOST_REWARD_MONTHLY_LIMIT}`,
    );
    await notify(
      message,
      `💎 <@${userId}> ブーストありがとう！ 今月のLand報酬は **${BOOST_REWARD_MONTHLY_LIMIT}回まで** のため、この回の支給はありません。`,
      userId,
    );
    return true;
  }

  console.info(
    `[boost] 支給成功 message=${message.id} user=${userId} month=${monthKey} reward=${BOOST_REWARD_LD} count=${result.count}/${BOOST_REWARD_MONTHLY_LIMIT}`,
  );
  await notify(
    message,
    `💎 <@${userId}> にサーバーブースト報酬 **${fmtLd(BOOST_REWARD_LD)}** を支給しました！（今月 ${result.count}/${BOOST_REWARD_MONTHLY_LIMIT}回）`,
    userId,
  );
  return true;
}

/**
 * Bot停止中にsystem channelへ届いたBoostメッセージを起動時に回収する。
 * 初回導入時はstarted_atを「今」に固定して走査しないため、既存ブースターへの遡及支給は起きない。
 */
export async function initializeBoostRewardRecovery(client: Client, services: Services): Promise<void> {
  ensureBoostRewardSchema(services);

  const mainGuildId = services.settings.getString("guild:main");
  if (!mainGuildId) {
    console.warn("[boost] guild:main が未設定のため自動支給を初期化できません");
    return;
  }
  const guild = client.guilds.cache.get(mainGuildId);
  if (!guild) {
    console.warn(`[boost] メインGuildがclient cacheにありません guild=${mainGuildId}`);
    return;
  }

  if (guild.systemChannelFlags.has(GuildSystemChannelFlags.SuppressPremiumSubscriptions)) {
    console.warn(
      "[boost] Discord側でサーバーブースト通知が抑止されています。system channelのBoost通知を有効にしない限り自動支給できません。",
    );
  }
  const systemChannel = guild.systemChannel;
  if (!systemChannel) {
    console.warn("[boost] Discordのsystem channelが未設定です。Boost通知を受信・復旧できません。");
  }

  const scanStartedAt = Math.floor(Date.now() / 1_000);
  const start = automationStartedAt(services, scanStartedAt * 1_000);
  if (start.created) return;
  if (!systemChannel) return;

  const lastRecoveryAt =
    parseEpochSeconds(services.settings.getString(BOOST_REWARD_LAST_RECOVERY_AT_SETTING)) ?? start.startedAt;
  const cutoff = Math.max(start.startedAt, lastRecoveryAt - RECOVERY_OVERLAP_SEC);

  const candidates: Message[] = [];
  let before: string | undefined;
  for (;;) {
    const batch = await systemChannel.messages.fetch({ limit: 100, before, cache: false });
    if (batch.size === 0) break;

    let oldest: Message | undefined;
    for (const message of batch.values()) {
      if (!oldest || message.createdTimestamp < oldest.createdTimestamp) oldest = message;
      const createdAt = Math.floor(message.createdTimestamp / 1_000);
      if (createdAt < cutoff || createdAt < start.startedAt) continue;
      if (message.type === MessageType.GuildBoost) candidates.push(message);
    }

    if (!oldest || Math.floor(oldest.createdTimestamp / 1_000) < cutoff || batch.size < 100) break;
    before = oldest.id;
  }

  candidates.sort((a, b) => a.createdTimestamp - b.createdTimestamp || a.id.localeCompare(b.id));
  let recovered = 0;
  for (const message of candidates) {
    const beforeCount = boostRewardPaidCountThisMonth(services, message.author.id, message.createdTimestamp);
    await handleBoostRewardMessage(message, services);
    const afterCount = boostRewardPaidCountThisMonth(services, message.author.id, message.createdTimestamp);
    if (afterCount > beforeCount) recovered += 1;
  }

  // 走査開始時刻までを確認済みにする。走査中に届いたMessageCreateを次回復旧から落とさない。
  services.settings.set(BOOST_REWARD_LAST_RECOVERY_AT_SETTING, scanStartedAt, "system:boost-recovery");
  console.info(
    `[boost] 起動時復旧完了 cutoff=${cutoff} candidates=${candidates.length} newlyPaid=${recovered} watermark=${scanStartedAt}`,
  );
}
