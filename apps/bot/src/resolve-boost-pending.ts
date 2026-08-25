import "dotenv/config";
import { resolveDbPath } from "./env-contract.js";
import { Ledger, Settings, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import { recordManualBoostCompensation } from "./boost-reward.js";
import type { Services } from "./services.js";

type PendingRow = {
  message_id: string;
  user_id: string;
  event_at_ms: number;
};

function parseArgs(argv: string[]): { messageId: string; actorUserId: string; execute: boolean } {
  let messageId: string | undefined;
  let actorUserId: string | undefined;
  let execute = false;

  for (const arg of argv) {
    if (arg === "--execute") {
      execute = true;
      continue;
    }
    if (arg.startsWith("--message-id=")) {
      if (messageId !== undefined) throw new Error("duplicate --message-id");
      messageId = arg.slice("--message-id=".length);
      continue;
    }
    if (arg.startsWith("--actor-user-id=")) {
      if (actorUserId !== undefined) throw new Error("duplicate --actor-user-id");
      actorUserId = arg.slice("--actor-user-id=".length);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (!messageId || !/^\d+$/.test(messageId)) {
    throw new Error("--message-id=<Discord Boost message ID> is required");
  }
  if (!actorUserId || !/^\d+$/.test(actorUserId)) {
    throw new Error("--actor-user-id=<operator Discord user ID> is required");
  }
  return { messageId, actorUserId, execute };
}

const args = parseArgs(process.argv.slice(2));
const dbPath = resolveDbPath(process.env);
registerDefaultTxTypes();
const db = openDb(dbPath);
const ledger = new Ledger(db);
const settings = new Settings(db);
const services = { db, ledger, settings } as unknown as Services;

try {
  const pending = db
    .prepare("SELECT message_id, user_id, event_at_ms FROM boost_reward_pending WHERE message_id = ?")
    .get(args.messageId) as PendingRow | undefined;
  if (!pending) {
    throw new Error(`ERR_BOOST_PENDING_NOT_FOUND message=${args.messageId}`);
  }

  const oldest = db
    .prepare(
      `SELECT message_id, user_id, event_at_ms
         FROM boost_reward_pending
        WHERE user_id = ?
        ORDER BY event_at_ms, message_id
        LIMIT 1`,
    )
    .get(pending.user_id) as PendingRow | undefined;
  if (!oldest || oldest.message_id !== pending.message_id) {
    throw new Error(
      `ERR_BOOST_EARLIER_PENDING requested=${pending.message_id} earliest=${oldest?.message_id ?? "unknown"}`,
    );
  }

  const actor = `operator:${args.actorUserId}`;
  console.log(`[boost補償] DB: ${dbPath}`);
  console.log(`[boost補償] pending: message=${pending.message_id} user=${pending.user_id}`);
  console.log(`[boost補償] event: ${new Date(pending.event_at_ms).toISOString()} (${pending.event_at_ms})`);
  console.log(`[boost補償] actor: ${actor}`);
  console.log("[boost補償] Botサービスを停止した状態で実行し、完了後に再起動してください。");

  if (!args.execute) {
    console.log("[boost補償] dry-runのみ。内容を確認後、同じ引数に --execute を追加してください。");
  } else {
    const result = recordManualBoostCompensation(
      {
        messageId: pending.message_id,
        userId: pending.user_id,
        eventTimestampMs: pending.event_at_ms,
      },
      services,
      actor,
    );
    console.log(`[boost補償] 完了: ${JSON.stringify(result)}`);
    console.log("[boost補償] Botサービスを再起動し、起動時Boost recoveryログを確認してください。");
  }
} finally {
  db.close();
}
