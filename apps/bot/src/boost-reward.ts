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
/** 1ユーザーにつき1暦月（JST）に支払う最大回数。core DB guardと同じ運用定数。 */
export const BOOST_REWARD_MONTHLY_LIMIT = 2;

export const BOOST_REWARD_STARTED_AT_SETTING = "boost_reward:auto_started_at";
export const BOOST_REWARD_LAST_RECOVERY_AT_SETTING = "boost_reward:last_recovery_at";

const JST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const RECOVERY_OVERLAP_SEC = 60;

type CountRow = { c: number };
type EventRow = {
  outcome: "paid" | "capped";
  reward: number;
  event_at: number;
  month_key: string;
};

export interface BoostRewardEvent {
  /** DiscordのGuildBoost system message ID。支払い冪等性の正本。 */
  messageId: string;
  userId: string;
  /** Discord message.createdTimestamp。処理時刻ではなくBoost発生月を決める。 */
  eventTimestampMs: number;
}

export type BoostRewardApplyResult =
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

/**
 * 1つのDiscord Boost eventをLand台帳へ適用する唯一の内部経路。
 * event行の仮記録 → 月次判定 → 送金 → paid確定を同一IMMEDIATE transactionで閉じる。
 */
function applyBoostRewardEvent(
  event: BoostRewardEvent,
  services: Services,
  actor: string,
): BoostRewardApplyResult {
  if (!event.messageId.trim() || !event.userId.trim()) throw new Error("ERR_BOOST_EVENT_INVALID");
  if (!Number.isFinite(event.eventTimestampMs) || event.eventTimestampMs <= 0) {
    throw new Error("ERR_BOOST_EVENT_INVALID");
  }
  if (!actor.trim()) throw new Error("ERR_BOOST_ACTOR_REQUIRED");

  const eventAt = Math.floor(event.eventTimestampMs / 1_000);
  const monthKey = boostRewardMonthKeyJst(event.eventTimestampMs);

  const apply = services.db.transaction((): BoostRewardApplyResult => {
    if (eventAlreadyHandled(services, event.messageId)) return { kind: "already" };

    // DB triggerがDiscord eventとの結び付きを要求するため、送金より先にeventを仮記録する。
    // transactionが失敗すればこの行もrollbackされる。
    services.db
      .prepare(
        `INSERT INTO boost_reward_events
           (message_id, user_id, outcome, reward, event_at, month_key, created_at)
         VALUES (?, ?, 'capped', 0, ?, ?, ?)`,
      )
      .run(event.messageId, event.userId, eventAt, monthKey, Math.floor(Date.now() / 1_000));

    // draft途中など「canonical keyで送金済み・event記録だけ欠落」の既存DBにも収束する。
    const prior = services.ledger.findByIdempotencyKey(`boost:${event.messageId}`);
    if (prior) {
      services.db
        .prepare("UPDATE boost_reward_events SET outcome = 'paid', reward = ? WHERE message_id = ?")
        .run(prior.amount, event.messageId);
      return { kind: "recovered" };
    }

    const paidCount = paidCountForMonth(services, event.userId, monthKey);
    if (paidCount >= BOOST_REWARD_MONTHLY_LIMIT) {
      return { kind: "capped", count: paidCount };
    }

    const accountId = `user:${event.userId}`;
    services.ledger.ensureAccount(accountId, "user");
    const result = services.ledger.transfer({
      from: TREASURY,
      to: accountId,
      amount: BOOST_REWARD_LD,
      type: "reward_boost",
      actor,
      reason: "サーバーブースト報酬",
      refType: "discord_boost",
      refId: event.messageId,
      idempotencyKey: `boost:${event.messageId}`,
    });

    services.db
      .prepare("UPDATE boost_reward_events SET outcome = 'paid', reward = ? WHERE message_id = ?")
      .run(BOOST_REWARD_LD, event.messageId);

    if (result.duplicate) return { kind: "recovered" };
    return { kind: "paid", count: paidCount + 1 };
  });

  return apply.immediate();
}

/**
 * 自動検知を取りこぼした場合の手動補償API。
 *
 * 汎用 `ledger.transfer(type='reward_boost')` はcore DB guardが拒否する。
 * 補償する人はDiscordのGuildBoost message ID・実行者・発生時刻を確認してこの経路を使う。
 * そのため後から自動復旧が同じmessageを拾っても `boost:<messageId>` / event PKで二重払いしない。
 */
export function recordManualBoostCompensation(
  event: BoostRewardEvent,
  services: Services,
  actor: string,
): BoostRewardApplyResult {
  const startedAt = parseEpochSeconds(services.settings.getString(BOOST_REWARD_STARTED_AT_SETTING));
  if (startedAt === null) throw new Error("ERR_BOOST_AUTOMATION_NOT_STARTED");
  if (Math.floor(event.eventTimestampMs / 1_000) < startedAt) {
    throw new Error("ERR_BOOST_BEFORE_AUTOMATION");
  }
  return applyBoostRewardEvent(event, services, actor);
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

  // 通常はClientReady初期化で開始時刻が先に入る。もし初期化より先にBoostが届いた場合だけ、
  // そのBoost自身の発生時刻を開始点にして「最初の1回」を秒境界で落とさない。
  const { startedAt } = automationStartedAt(services, message.createdTimestamp);
  const eventAt = Math.floor(message.createdTimestamp / 1_000);
  if (eventAt < startedAt) {
    console.info(`[boost] 自動化開始前のイベントをスキップ message=${message.id} eventAt=${eventAt} start=${startedAt}`);
    return true;
  }

  const result = applyBoostRewardEvent(
    { messageId: message.id, userId, eventTimestampMs: message.createdTimestamp },
    services,
    "system:boost",
  );
  const monthKey = boostRewardMonthKeyJst(message.createdTimestamp);

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
  let failed = 0;
  let earliestFailedAt: number | null = null;
  for (const message of candidates) {
    try {
      const beforeCount = boostRewardPaidCountThisMonth(services, message.author.id, message.createdTimestamp);
      await handleBoostRewardMessage(message, services);
      const afterCount = boostRewardPaidCountThisMonth(services, message.author.id, message.createdTimestamp);
      if (afterCount > beforeCount) recovered += 1;
    } catch (error) {
      failed += 1;
      const failedAt = Math.floor(message.createdTimestamp / 1_000);
      earliestFailedAt = earliestFailedAt === null ? failedAt : Math.min(earliestFailedAt, failedAt);
      console.error(`[boost] 起動時復旧の個別イベント処理に失敗 message=${message.id}:`, error);
    }
  }

  // 全件成功なら走査開始時刻まで進める。個別失敗があれば最古の失敗時刻に留め、
  // 次回は60秒overlap込みで再試行する。後続イベントは今回すでに処理済みなので冪等に吸収される。
  const nextWatermark = earliestFailedAt ?? scanStartedAt;
  services.settings.set(BOOST_REWARD_LAST_RECOVERY_AT_SETTING, nextWatermark, "system:boost-recovery");
  console.info(
    `[boost] 起動時復旧完了 cutoff=${cutoff} candidates=${candidates.length} newlyPaid=${recovered} failed=${failed} watermark=${nextWatermark}`,
  );
}
