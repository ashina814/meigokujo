import { EventLog, Ledger, Shop, ShopError, openDb, registerDefaultTxTypes } from "../../src/index.js";

registerDefaultTxTypes();

const input = JSON.parse(process.argv[2] ?? "{}") as {
  dbPath: string;
  startAt: number;
  operationId: string;
};

while (Date.now() < input.startAt) {
  // Separate processes wait on the same wall-clock instant.
}

const db = openDb(input.dbPath);
try {
  const shop = new Shop(db, new Ledger(db), new EventLog(db), { reevalItemId: () => 1 });
  const purchase = shop.purchaseReevaluation({
    itemId: 1,
    userId: "alice",
    actor: "user:alice",
    memberRoleIds: [],
    mode: "invite",
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
