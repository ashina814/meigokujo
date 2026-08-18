import {
  GuildSystemChannelFlags,
  MessageType,
  PermissionFlagsBits,
  type Client,
  type Message,
} from "discord.js";
import { TREASURY } from "@meigokujo/core";
import { BOOST_REWARD_LD, BOOST_REWARD_MONTHLY_LIMIT } from "@meigokujo/core/ledger/boost-reward";
import { fmtLd } from "./format.js";
import type { Services } from "./services.js";

export { BOOST_REWARD_LD, BOOST_REWARD_MONTHLY_LIMIT };
export const BOOST_REWARD_STARTED_AT_SETTING = "boost_reward:auto_started_at";
export const BOOST_REWARD_LAST_RECOVERY_AT_SETTING = "boost_reward:last_recovery_at";

const JST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const RECOVERY_OVERLAP_SEC = 60;

type RecoveryState = "idle" | "recovering" | "blocked";
type BlockedBoostUser = { messageId: string; eventTimestampMs: number };

// 起動時backfill中・復旧失敗後に届いた新着Boostを先払いしないためのプロセス内barrier。
// 履歴を安全に確認できるまでqueueへ保持し、Discord上の発生時刻順に処理する。
let recoveryState: RecoveryState = "idle";
const queuedLiveBoosts = new Map<string, Message>();
// 個別イベント失敗はuser単位でも保持し、先行イベントが解決するまでそのuserのlive支給を止める。
const blockedBoostUsers = new Map<string, BlockedBoostUser>();

type CountRow = { c: number };
type EventRow = {
  user_id: string;
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
    .prepare("SELECT user_id, outcome, reward, event_at, month_key FROM boost_reward_events WHERE message_id = ?")
    .get(messageId) as EventRow | undefined;
}

function assertEventIdentity(existing: EventRow, event: BoostRewardEvent): void {
  const eventAt = Math.floor(event.eventTimestampMs / 1_000);
  const monthKey = boostRewardMonthKeyJst(event.eventTimestampMs);
  if (existing.user_id !== event.userId || existing.event_at !== eventAt || existing.month_key !== monthKey) {
    throw new Error(
      `ERR_BOOST_EVENT_CONFLICT message=${event.messageId} ` +
        `stored=${existing.user_id}/${existing.event_at}/${existing.month_key} ` +
        `incoming=${event.userId}/${eventAt}/${monthKey}`,
    );
  }
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

function assertPriorBoostTransaction(
  services: Services,
  event: BoostRewardEvent,
  tx: NonNullable<ReturnType<Services["ledger"]["findByIdempotencyKey"]>>,
): void {
  const accountId = `user:${event.userId}`;
  const reversed = services.db
    .prepare("SELECT 1 AS found FROM transactions WHERE reversal_of = ? LIMIT 1")
    .get(tx.id) as { found: number } | undefined;
  if (
    tx.type !== "reward_boost" ||
    tx.from_account !== TREASURY ||
    tx.to_account !== accountId ||
    tx.amount !== BOOST_REWARD_LD ||
    tx.ref_type !== "discord_boost" ||
    tx.ref_id !== event.messageId ||
    tx.reversal_of !== null ||
    reversed
  ) {
    throw new Error(`ERR_BOOST_PRIOR_TX_CONFLICT message=${event.messageId} tx=${tx.id}`);
  }
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
    const existing = eventAlreadyHandled(services, event.messageId);
    if (existing) {
      assertEventIdentity(existing, event);
      return { kind: "already" };
    }

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
    // keyが同じというだけでは信用せず、送金内容がこのBoost eventと完全一致する場合だけ復旧扱いにする。
    const prior = services.ledger.findByIdempotencyKey(`boost:${event.messageId}`);
    if (prior) {
      assertPriorBoostTransaction(services, event, prior);
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

function isMainGuildBoost(message: Message, services: Services): boolean {
  if (message.type !== MessageType.GuildBoost) return false;
  const mainGuildId = services.settings.getString("guild:main");
  return Boolean(mainGuildId && message.guildId === mainGuildId);
}

async function processBoostRewardMessage(message: Message, services: Services): Promise<boolean> {
  if (!isMainGuildBoost(message, services)) return false;

  const userId = message.author.id;
  if (!userId || message.author.bot) {
    console.warn(`[boost] 実行者を特定できないため支給しません message=${message.id}`);
    return true;
  }

  // 通常はClientReady初期化で開始時刻が先に入る。もし初期化より先にBoostが届いた場合だけ、
  // 実際にGuildBoost messageを受信できているため、そのBoost自身の発生時刻を開始点にする。
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
 * DiscordのGUILD_BOOSTシステムメッセージを正本として自動支給する。
 * 起動時復旧中・復旧失敗後の新着は即時支給せずqueueし、履歴と時系列順に合流させる。
 */
export async function handleBoostRewardMessage(message: Message, services: Services): Promise<boolean> {
  if (!isMainGuildBoost(message, services)) return false;
  const userId = message.author.id;
  const userBlocked = Boolean(userId && blockedBoostUsers.has(userId));
  if (recoveryState !== "idle" || userBlocked) {
    queuedLiveBoosts.set(message.id, message);
    const reason = recoveryState === "blocked"
      ? "復旧停止中"
      : recoveryState === "recovering"
        ? "起動時復旧中"
        : "同一userの先行イベント未解決";
    console.info(`[boost] ${reason}の新着イベントを待機 message=${message.id} user=${userId}`);
    return true;
  }
  return processBoostRewardMessage(message, services);
}

function takeOldestPending(pending: Map<string, Message>): Message | undefined {
  let oldest: Message | undefined;
  for (const message of pending.values()) {
    if (
      !oldest ||
      message.createdTimestamp < oldest.createdTimestamp ||
      (message.createdTimestamp === oldest.createdTimestamp && message.id.localeCompare(oldest.id) < 0)
    ) {
      oldest = message;
    }
  }
  if (oldest) pending.delete(oldest.id);
  return oldest;
}

function isAfterBlocker(message: Message, blocker: BlockedBoostUser): boolean {
  if (message.id === blocker.messageId) return false;
  if (message.createdTimestamp !== blocker.eventTimestampMs) {
    return message.createdTimestamp > blocker.eventTimestampMs;
  }
  return message.id.localeCompare(blocker.messageId) > 0;
}

/**
 * Bot停止中にsystem channelへ届いたBoostメッセージを起動時に回収する。
 * 初回導入時は履歴読取権限とAPI利用可否をpreflightし、started_atより前は支払わない。
 * 履歴fetch自体が失敗した場合はfail-closedでblockedのままにし、新着もqueueへ保持する。
 */
export async function initializeBoostRewardRecovery(client: Client, services: Services): Promise<void> {
  const mainGuildId = services.settings.getString("guild:main");
  if (!mainGuildId) {
    recoveryState = "blocked";
    console.warn("[boost] guild:main が未設定のため自動支給を初期化できません");
    return;
  }
  const guild = client.guilds.cache.get(mainGuildId);
  if (!guild) {
    recoveryState = "blocked";
    console.warn(`[boost] メインGuildがclient cacheにありません guild=${mainGuildId}`);
    return;
  }

  const suppressed = guild.systemChannelFlags.has(GuildSystemChannelFlags.SuppressPremiumSubscriptions);
  if (suppressed) {
    recoveryState = "blocked";
    console.warn(
      "[boost] Discord側でサーバーブースト通知が抑止されています。自動支給の開始時刻は確定しません。Boost通知を有効にしてから再起動してください。",
    );
    return;
  }
  const systemChannel = guild.systemChannel;
  if (!systemChannel) {
    recoveryState = "blocked";
    console.warn(
      "[boost] Discordのsystem channelが未設定です。自動支給の開始時刻は確定しません。system channelを設定してから再起動してください。",
    );
    return;
  }

  // Discord APIはReadMessageHistory不足時に空結果を返し得るため、fetch結果から権限を推測しない。
  // 実オブジェクトではpermissionsForが必ず存在する。構造だけのunit-test mockでは未定義を許容する。
  const permissionsFor = systemChannel.permissionsFor?.bind(systemChannel);
  if (permissionsFor) {
    const me = guild.members.me;
    const permissions = me ? permissionsFor(me) : null;
    const canView = permissions?.has(PermissionFlagsBits.ViewChannel) ?? false;
    const canReadHistory = permissions?.has(PermissionFlagsBits.ReadMessageHistory) ?? false;
    if (!canView || !canReadHistory) {
      recoveryState = "blocked";
      console.warn(
        "[boost] system channelの ViewChannel / ReadMessageHistory 権限が不足しています。開始時刻やwatermarkは更新しません。権限を直してから再起動してください。",
      );
      return;
    }
  }

  const scanStartedAt = Math.floor(Date.now() / 1_000);
  const existingStartedAt = parseEpochSeconds(services.settings.getString(BOOST_REWARD_STARTED_AT_SETTING));
  const pending = new Map<string, Message>();
  const deferredMessages = new Map<string, Message>();
  recoveryState = "recovering";

  try {
    // 初回導入でも、将来の停止中backfillに必要な履歴APIが利用できることをpreflightする。
    // 権限自体は上で明示確認済み。APIエラーならstarted_at/watermarkを作らずfail-closed。
    if (existingStartedAt === null) {
      await systemChannel.messages.fetch({ limit: 1, cache: false });
    }

    const start = automationStartedAt(services, scanStartedAt * 1_000);
    const lastRecoveryAt =
      parseEpochSeconds(services.settings.getString(BOOST_REWARD_LAST_RECOVERY_AT_SETTING)) ?? start.startedAt;
    const cutoff = Math.max(start.startedAt, lastRecoveryAt - RECOVERY_OVERLAP_SEC);

    // 初回は過去分を遡及走査しない。2回目以降のみwatermarkから履歴を回収する。
    if (!start.created) {
      let before: string | undefined;
      for (;;) {
        const batch = await systemChannel.messages.fetch({ limit: 100, before, cache: false });
        if (batch.size === 0) break;

        let oldest: Message | undefined;
        for (const message of batch.values()) {
          if (!oldest || message.createdTimestamp < oldest.createdTimestamp) oldest = message;
          const createdAt = Math.floor(message.createdTimestamp / 1_000);
          if (createdAt < cutoff || createdAt < start.startedAt || createdAt > scanStartedAt) continue;
          if (message.type === MessageType.GuildBoost) pending.set(message.id, message);
        }

        if (!oldest || Math.floor(oldest.createdTimestamp / 1_000) < cutoff || batch.size < 100) break;
        before = oldest.id;
      }
    }

    let recovered = 0;
    let failed = 0;
    let deferred = 0;
    const failedThisPass = new Set<string>();

    // fetch中・処理中に届いた新着も毎周回pendingへ合流する。
    // 残り全体から毎回最古を選ぶため、liveイベントが履歴より先に月枠を消費しない。
    for (;;) {
      for (const [id, message] of queuedLiveBoosts) {
        pending.set(id, message);
        queuedLiveBoosts.delete(id);
      }
      const message = takeOldestPending(pending);
      if (!message) break;

      const userId = message.author.id;
      const blocker = blockedBoostUsers.get(userId);
      if (failedThisPass.has(userId) || (blocker && isAfterBlocker(message, blocker))) {
        deferred += 1;
        deferredMessages.set(message.id, message);
        console.warn(
          `[boost] 同一userの先行イベント未解決により後続を次回へ繰越 message=${message.id} user=${userId}`,
        );
        continue;
      }

      try {
        const beforeCount = boostRewardPaidCountThisMonth(services, userId, message.createdTimestamp);
        await processBoostRewardMessage(message, services);
        const afterCount = boostRewardPaidCountThisMonth(services, userId, message.createdTimestamp);
        if (afterCount > beforeCount) recovered += 1;
        if (blocker?.messageId === message.id) {
          blockedBoostUsers.delete(userId);
          console.info(`[boost] user単位の支給停止を解除 message=${message.id} user=${userId}`);
        }
      } catch (error) {
        failed += 1;
        failedThisPass.add(userId);
        blockedBoostUsers.set(userId, {
          messageId: message.id,
          eventTimestampMs: message.createdTimestamp,
        });
        console.error(`[boost] 起動時復旧の個別イベント処理に失敗 message=${message.id}:`, error);
      }
    }

    for (const [id, message] of deferredMessages) queuedLiveBoosts.set(id, message);

    // 未解決userが残る限り、その最古イベント時刻にwatermarkを留める。
    // 全件解決なら走査開始時刻まで進める。
    let earliestBlockedAt: number | null = null;
    for (const blocker of blockedBoostUsers.values()) {
      const blockedAt = Math.floor(blocker.eventTimestampMs / 1_000);
      earliestBlockedAt = earliestBlockedAt === null ? blockedAt : Math.min(earliestBlockedAt, blockedAt);
    }
    const nextWatermark = earliestBlockedAt ?? scanStartedAt;
    services.settings.set(BOOST_REWARD_LAST_RECOVERY_AT_SETTING, nextWatermark, "system:boost-recovery");
    recoveryState = "idle";
    console.info(
      `[boost] 起動時復旧完了 cutoff=${cutoff} newlyPaid=${recovered} failed=${failed} deferred=${deferred} blockedUsers=${blockedBoostUsers.size} watermark=${nextWatermark}`,
    );
  } catch (error) {
    // 履歴取得・watermark保存など復旧全体の障害時に新着だけ払い始めると、月2回枠の順序が壊れる。
    // blockedのままqueueを保持し、再起動または明示的な再初期化で履歴確認が成功するまで支給しない。
    recoveryState = "blocked";
    console.error("[boost] 起動時復旧を安全停止しました。新着Boostはqueueへ保持します:", error);
    throw error;
  }
}
