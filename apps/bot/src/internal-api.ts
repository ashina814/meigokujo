import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Services } from "./services.js";

/**
 * 内部専用・読み取り専用の経済API（ログBotの観測用）。
 *
 * 設計の要点:
 * - 通貨Botが経済情報の「正本」。ここには **書き込み系エンドポイントを一切作らない**。
 *   実装上も SELECT しか発行しない（残高を動かせるのは Ledger.transfer だけ）。
 * - transactions は追記専用で id が単調増加するため、`after_id` カーソルで
 *   「取りこぼしなし・重複なし・停止中の追いつき」が構造的に保証される。
 * - 依存を増やさないため Node 標準の http のみを使う。
 * - 待受は docker0（既定 172.17.0.1）のみ。ホスト内からしか到達できないインターフェースで、
 *   さらに Bearer トークンを要求する。外部公開はしない。
 *
 * 環境変数:
 *   ECONOMY_API_TOKEN … 必須。未設定なら **起動しない**（無認証で開けるより安全）
 *   ECONOMY_API_HOST  … 既定 172.17.0.1
 *   ECONOMY_API_PORT  … 既定 8787
 */

const LOG = "[economy-api]";
export const SCHEMA_VERSION = 1;

/** 金額は最大でも1.9億程度で Number.MAX_SAFE_INTEGER に遠く及ばないため number で扱う */
interface TxDto {
  sourceTxId: number;
  idempotencyKey: string;
  fromAccount: string;
  toAccount: string;
  amount: number;
  currency: "LD";
  type: string;
  reason: string | null;
  refType: string | null;
  refId: string | null;
  actorId: string;
  approvedBy: string | null;
  reversalOf: number | null;
  createdAt: number; // unix秒（通貨Bot側の発生時刻）
  createdAtIso: string;
}

interface TxRowRaw {
  id: number;
  idempotency_key: string;
  from_account: string;
  to_account: string;
  amount: number;
  type: string;
  reason: string | null;
  ref_type: string | null;
  ref_id: string | null;
  actor_id: string;
  approved_by: string | null;
  reversal_of: number | null;
  created_at: number;
}

function toDto(r: TxRowRaw): TxDto {
  return {
    sourceTxId: r.id,
    idempotencyKey: r.idempotency_key,
    fromAccount: r.from_account,
    toAccount: r.to_account,
    amount: r.amount,
    currency: "LD",
    type: r.type,
    reason: r.reason,
    refType: r.ref_type,
    refId: r.ref_id,
    actorId: r.actor_id,
    approvedBy: r.approved_by,
    reversalOf: r.reversal_of,
    createdAt: r.created_at,
    createdAtIso: new Date(r.created_at * 1000).toISOString(),
  };
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** transactions の最大IDと件数（カーソルの終端判定に使う） */
function ledgerHead(services: Services): { maxTransactionId: number; txCount: number } {
  const row = services.db
    .prepare("SELECT COALESCE(MAX(id),0) AS maxId, COUNT(*) AS c FROM transactions")
    .get() as { maxId: number; c: number };
  return { maxTransactionId: row.maxId, txCount: row.c };
}

function handleTransactions(services: Services, url: URL, res: ServerResponse): void {
  const afterId = Math.max(0, Number(url.searchParams.get("after_id") ?? 0) || 0);
  const limitRaw = Number(url.searchParams.get("limit") ?? 500) || 500;
  const limit = Math.min(Math.max(1, limitRaw), 2000);

  const rows = services.db
    .prepare("SELECT * FROM transactions WHERE id > ? ORDER BY id ASC LIMIT ?")
    .all(afterId, limit) as TxRowRaw[];
  const head = ledgerHead(services);
  const items = rows.map(toDto);
  const nextCursor = items.length > 0 ? items[items.length - 1]!.sourceTxId : afterId;

  json(res, 200, {
    schemaVersion: SCHEMA_VERSION,
    items,
    count: items.length,
    nextCursor,
    maxTransactionId: head.maxTransactionId,
    hasMore: nextCursor < head.maxTransactionId,
  });
}

function handleBalances(services: Services, res: ServerResponse): void {
  const head = ledgerHead(services);
  const rows = services.db
    .prepare(
      `SELECT a.id AS accountId, a.kind AS kind, COALESCE(b.amount,0) AS amount
       FROM accounts a LEFT JOIN balances b ON b.account_id = a.id
       ORDER BY a.id`,
    )
    .all() as Array<{ accountId: string; kind: string; amount: number }>;

  let userTotal = 0;
  let systemTotal = 0;
  let identitySum = 0;
  for (const r of rows) {
    identitySum += r.amount;
    if (r.kind === "user") userTotal += r.amount;
    else systemTotal += r.amount;
  }

  json(res, 200, {
    schemaVersion: SCHEMA_VERSION,
    capturedAt: Math.floor(Date.now() / 1000),
    maxTransactionId: head.maxTransactionId,
    moneySupply: services.ledger.moneySupply(),
    accounts: rows.map((r) => ({ ...r, currency: "LD" as const })),
    totals: {
      user: userTotal,
      system: systemTotal,
      /** 複式の恒等式。健全なら 0 */
      identitySum,
    },
  });
}

function handleHealth(services: Services, url: URL, res: ServerResponse): void {
  const head = ledgerHead(services);
  // 検算は全取引を舐めるためポーリング毎には流さない。?verify=1 のときだけ実行する
  const verify = url.searchParams.get("verify") === "1";
  const integrity = verify ? services.ledger.verifyIntegrity() : null;
  json(res, 200, {
    schemaVersion: SCHEMA_VERSION,
    ok: true,
    serverTime: Math.floor(Date.now() / 1000),
    txCount: head.txCount,
    maxTransactionId: head.maxTransactionId,
    moneySupply: services.ledger.moneySupply(),
    integrityChecked: verify,
    integrityOk: integrity ? integrity.ok : null,
    integrityMismatches: integrity && !integrity.ok ? integrity.mismatches.slice(0, 20) : null,
  });
}

export function startInternalApi(services: Services): void {
  const token = process.env.ECONOMY_API_TOKEN;
  if (!token) {
    console.warn(`${LOG} ECONOMY_API_TOKEN が未設定のため内部APIを起動しません（無認証公開を避けるため）`);
    return;
  }
  const host = process.env.ECONOMY_API_HOST ?? "172.17.0.1";
  const port = Number(process.env.ECONOMY_API_PORT ?? 8787);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      // 読み取り専用APIなので GET 以外は受け付けない
      if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });

      const auth = req.headers.authorization ?? "";
      const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!provided || !tokenMatches(provided, token)) {
        return json(res, 401, { error: "unauthorized" });
      }

      const url = new URL(req.url ?? "/", `http://${host}:${port}`);
      switch (url.pathname) {
        case "/internal/v1/health":
          return handleHealth(services, url, res);
        case "/internal/v1/economy/transactions":
          return handleTransactions(services, url, res);
        case "/internal/v1/economy/balances":
          return handleBalances(services, res);
        default:
          return json(res, 404, { error: "not_found" });
      }
    } catch (e) {
      console.error(`${LOG} リクエスト処理に失敗:`, e);
      json(res, 500, { error: "internal_error" });
    }
  });

  server.on("error", (e) => console.error(`${LOG} サーバエラー:`, e));
  server.listen(port, host, () => {
    console.log(`${LOG} 読み取り専用APIを起動: http://${host}:${port}/internal/v1/ （Bearer認証・ホスト内限定）`);
  });
}
