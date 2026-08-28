import { EventLog, Ledger, Shop, ShopError, openDb, registerDefaultTxTypes } from "../../src/index.js";

registerDefaultTxTypes();

const input = JSON.parse(process.argv[2] ?? "{}") as {
  dbPath: string;
  startAt: number;
  operationId: string;
  /** 差し替え後の新商品Bなど、購入対象を明示する（既定は1）。 */
  itemId?: number;
  /** 現在の販売設定として見せる商品（既定は購入対象と同じ）。 */
  saleItemId?: number;
  mode?: "land" | "invite";
};
const itemId = input.itemId ?? 1;
const saleItemId = input.saleItemId ?? itemId;

while (Date.now() < input.startAt) {
  // Separate processes wait on the same wall-clock instant.
}

const db = openDb(input.dbPath);
try {
  const shop = new Shop(db, new Ledger(db), new EventLog(db), { reevalItemId: () => saleItemId });
  const purchase = shop.purchaseReevaluation({
    itemId,
    userId: "alice",
    actor: "user:alice",
    memberRoleIds: [],
    mode: input.mode ?? "invite",
    idempotencyKey: input.operationId,
  }).purchase;
  console.log(JSON.stringify({ outcome: "ok", purchaseId: purchase.id }));
} catch (error) {
  console.log(
    JSON.stringify({
      outcome: "error",
      code: error instanceof ShopError ? error.code : null,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
} finally {
  db.close();
}
