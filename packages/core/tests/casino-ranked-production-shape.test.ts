import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Casino,
  CasinoMetrics,
  ChipLedger,
  ChipTx,
  Escrow,
  EventLog,
  HOUSE_HOLDER,
  HouseReservations,
  Ledger,
  PersistentTables,
  RankedDisputes,
  RankedTables,
  TREASURY,
  openDb,
  registerDefaultTxTypes,
} from "../src/index.js";
import { openFormally } from "./helpers/chip-ctx.js";

registerDefaultTxTypes();

/**
 * 本番の形（production shape）で順位卓を触るテスト。
 *
 * 既存の順位卓テストは `alice` / `g` / `c` のような短い値しか使っておらず、
 * **実際の Discord Snowflake（19桁）を一度も踏んでいなかった**。
 * その結果、request_fingerprint が ID 用の長さ上限（200文字）を超えるという
 * 本番専用の不具合を丸ごと素通しし、正式開業後に「卓を開く」が
 * `persistent table field is invalid` で全て失敗していた。
 *
 * ここでは次の3点を本番と同じ形で踏む。
 *   1. Snowflake は19桁（guild/channel/user/interaction すべて）
 *   2. 卓スキーマがまだ1行も無い初期状態からの初回書き込み
 *   3. 正式開業済み
 */

/** 実際の Discord Snowflake と同じ19桁。冥獄城のギルドIDと同じ桁数 */
const GUILD_ID = "1463201396567441441";
const CHANNEL_ID = "1189234567890123456";
const OPERATOR_ID = "1234567890123456789";
const ALICE = "9876543210987654321";
const BOB = "8765432109876543210";
/** interaction.id も19桁。これが operationId になり table_id の素になる */
const CREATE_OP = "1470000000000000001";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    // Windows は SQLite のハンドルが離れる前だと EPERM になることがある。
    // 後始末の失敗でテスト結果を汚さない（本題は卓の挙動）
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 一時ディレクトリはOSに任せる */
    }
  }
});

const NOW = 1_800_000_000;

function productionShapeCtx() {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-prodshape-"));
  tempDirs.push(dir);
  const db = openDb(join(dir, "casino.db"));
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  openFormally(chipTx, ledger);
  const casino = new Casino(db, chips, events);
  const reservations = new HouseReservations(db, chips, events);
  chips.setReservedProvider((holderId) => (holderId === HOUSE_HOLDER ? reservations.totalReserved() : 0));
  const escrow = new Escrow(db, chips, events, { onPlayerNet: (userId, net) => casino.recordGameNet(userId, net) });
  const persistentTables = new PersistentTables(db, events, { openingPhase: () => chipTx.openingPhase(), now: () => NOW });
  const metrics = new CasinoMetrics(db, chipTx, () => NOW);
  const disputes = new RankedDisputes(db, chips, escrow, persistentTables, reservations, events, {
    openingPhase: () => chipTx.openingPhase(),
    now: () => NOW,
    onPlayerNet: (userId, net) => casino.recordGameNet(userId, net),
  });
  const rankedTables = new RankedTables(db, chips, escrow, persistentTables, events, metrics, {
    now: () => NOW,
    reservations,
    disputes,
    openingPhase: () => chipTx.openingPhase(),
  });
  return { db, dir, ledger, chips, escrow, persistentTables, rankedTables, disputes };
}

function fund(ctx: ReturnType<typeof productionShapeCtx>, userId: string, amount = 200_000): void {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  ctx.ledger.transfer({ from: TREASURY, to: `user:${userId}`, amount, type: "initial", actor: "test", idempotencyKey: `seed:${userId}` });
  ctx.chips.deposit(userId, amount, `deposit:${userId}`);
}

describe("順位卓 production shape（19桁Snowflake・空スキーマ・正式開業済み）", () => {
  it("正式開業済み・卓スキーマ無しの初期状態から、本番サイズのIDで卓を開ける", () => {
    const ctx = productionShapeCtx();
    // 本番の初期状態: 卓の表がまだ1つも無い
    expect(ctx.persistentTables.hasSchema()).toBe(false);

    const snapshot = ctx.rankedTables.create({
      gameKey: "gf",
      tierKey: "middle",
      creatorId: OPERATOR_ID,
      operatorId: OPERATOR_ID,
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      operationId: CREATE_OP,
      authority: "employee",
    });

    expect(snapshot.table.state).toBe("recruiting");
    expect(snapshot.table.creatorId).toBe(OPERATOR_ID);
    expect(snapshot.table.guildId).toBe(GUILD_ID);
    // 読み戻せること自体が要点。ここが200文字上限に当たって rollback していた
    expect(snapshot.table.requestFingerprint.length).toBeGreaterThan(200);
    expect(ctx.persistentTables.get(snapshot.table.tableId)?.tableId).toBe(snapshot.table.tableId);
  });

  it("同じ operationId の再送は新しい卓を作らず、同じ卓を返す（本番サイズでも冪等）", () => {
    const ctx = productionShapeCtx();
    const first = ctx.rankedTables.create({
      gameKey: "gf",
      tierKey: "middle",
      creatorId: OPERATOR_ID,
      operatorId: OPERATOR_ID,
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      operationId: CREATE_OP,
      authority: "employee",
    });
    const again = ctx.rankedTables.create({
      gameKey: "gf",
      tierKey: "middle",
      creatorId: OPERATOR_ID,
      operatorId: OPERATOR_ID,
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      operationId: CREATE_OP,
      authority: "employee",
    });
    expect(again.table.tableId).toBe(first.table.tableId);
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_tables").get() as { n: number }).n).toBe(1);
  });

  it("参加から結果承認まで、本番サイズのIDで一周できる", () => {
    const ctx = productionShapeCtx();
    const created = ctx.rankedTables.create({
      gameKey: "gf",
      tierKey: "middle",
      creatorId: OPERATOR_ID,
      operatorId: OPERATOR_ID,
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      operationId: CREATE_OP,
      authority: "employee",
    });
    const tableId = created.table.tableId;
    fund(ctx, ALICE);
    fund(ctx, BOB);

    ctx.rankedTables.join({ tableId, userId: ALICE, seat: 1, operationId: "1470000000000000002" });
    ctx.rankedTables.join({ tableId, userId: BOB, seat: 2, operationId: "1470000000000000003" });
    ctx.rankedTables.ready({ tableId, userId: ALICE, operationId: "1470000000000000004" });
    ctx.rankedTables.ready({ tableId, userId: BOB, operationId: "1470000000000000005" });
    const submitted = ctx.rankedTables.submitResult({
      tableId,
      userId: ALICE,
      orderedUserIds: [ALICE, BOB],
      operationId: "1470000000000000006",
    });
    const hash = submitted.result!.hash;

    // 承認の fingerprint は tableId + userId + 64文字ハッシュ + operationId + action。
    // 本番サイズだと 200 文字を超えるため、ID 用の上限で読み戻すと失敗する
    ctx.rankedTables.approve({ tableId, userId: ALICE, resultHash: hash, operationId: "1470000000000000007" });
    const final = ctx.rankedTables.approve({ tableId, userId: BOB, resultHash: hash, operationId: "1470000000000000008" });

    expect(final.table.state).toBe("settled");
    const participants = ctx.persistentTables.participants(tableId);
    expect(participants).toHaveLength(2);
    for (const participant of participants) {
      expect(participant.approvalFingerprint!.length).toBeGreaterThan(200);
    }
  });
});
