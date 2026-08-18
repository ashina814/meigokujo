import { MessageType, type Message } from "discord.js";
import { TREASURY } from "@meigokujo/core";
import { fmtLd } from "./format.js";
import type { Services } from "./services.js";

/** サーバーブースト1回あたりのLand報酬。 */
export const BOOST_REWARD_LD = 50_000;
/** 1ユーザーにつき1暦月（JST）に支払う最大回数。 */
export const BOOST_REWARD_MONTHLY_LIMIT = 2;

const JST_OFFSET_MS = 9 * 60 * 60 * 1_000;

type CountRow = { c: number };
type EventRow = { outcome: "paid" | "capped" };

function ensureEventTable(services: Services): void {
  services.db.exec(`
    CREATE TABLE IF NOT EXISTS boost_reward_events (
      message_id TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      outcome    TEXT NOT NULL CHECK(outcome IN ('paid', 'capped')),
      reward     INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_boost_reward_events_user
      ON boost_reward_events(user_id, created_at);
  `);
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
 * 今月すでに実際に支給された boost 報酬を台帳から数える。
 * reward_boost の既存手動支給も同じ月2回上限へ含める。
 */
export function boostRewardPaidCountThisMonth(
  services: Services,
  userId: string,
  nowMs = Date.now(),
): number {
  const { start, end } = boostRewardMonthRangeJst(nowMs);
  const row = services.db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM transactions
       WHERE type = 'reward_boost'
         AND to_account = ?
         AND created_at >= ?
         AND created_at < ?`,
    )
    .get(`user:${userId}`, start, end) as CountRow | undefined;
  return row?.c ?? 0;
}

function eventAlreadyHandled(services: Services, messageId: string): boolean {
  const row = services.db
    .prepare("SELECT outcome FROM boost_reward_events WHERE message_id = ?")
    .get(messageId) as EventRow | undefined;
  return row !== undefined;
}

function recordEvent(
  services: Services,
  messageId: string,
  userId: string,
  outcome: "paid" | "capped",
  reward: number,
): void {
  services.db
    .prepare(
      `INSERT OR IGNORE INTO boost_reward_events (message_id, user_id, outcome, reward, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(messageId, userId, outcome, reward, Math.floor(Date.now() / 1_000));
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

  ensureEventTable(services);
  if (eventAlreadyHandled(services, message.id)) {
    console.info(`[boost] 処理済みイベントをスキップ message=${message.id} user=${userId}`);
    return true;
  }

  const paidCount = boostRewardPaidCountThisMonth(services, userId);
  if (paidCount >= BOOST_REWARD_MONTHLY_LIMIT) {
    recordEvent(services, message.id, userId, "capped", 0);
    console.info(
      `[boost] 月次上限のため支給なし message=${message.id} user=${userId} count=${paidCount}/${BOOST_REWARD_MONTHLY_LIMIT}`,
    );
    await notify(
      message,
      `💎 <@${userId}> ブーストありがとう！ 今月のLand報酬は **${BOOST_REWARD_MONTHLY_LIMIT}回まで** のため、この回の支給はありません。`,
      userId,
    );
    return true;
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

  // 支払い後・イベント記録前に落ちても、再処理時は台帳の冪等キーで二重払いせずここへ収束する。
  recordEvent(services, message.id, userId, "paid", BOOST_REWARD_LD);
  if (result.duplicate) {
    console.info(`[boost] 送金済みイベントを記録へ追いつかせました message=${message.id} user=${userId}`);
    return true;
  }

  const currentCount = paidCount + 1;
  console.info(
    `[boost] 支給成功 message=${message.id} user=${userId} reward=${BOOST_REWARD_LD} count=${currentCount}/${BOOST_REWARD_MONTHLY_LIMIT}`,
  );
  await notify(
    message,
    `💎 <@${userId}> にサーバーブースト報酬 **${fmtLd(BOOST_REWARD_LD)}** を支給しました！（今月 ${currentCount}/${BOOST_REWARD_MONTHLY_LIMIT}回）`,
    userId,
  );
  return true;
}
