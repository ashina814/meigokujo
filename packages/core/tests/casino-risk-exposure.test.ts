import { describe, expect, it } from "vitest";
import {
  Casino,
  CasinoChipAssets,
  CasinoChipFlow,
  CasinoMetrics,
  ChipLedger,
  ChipTx,
  DailyRisk,
  DailyRiskError,
  Escrow,
  EventLog,
  HOUSE_HOLDER,
  HouseReservations,
  Ledger,
  PersistentTables,
  RankedDisputes,
  RankedTableError,
  RankedTables,
  TREASURY,
  openDb,
  registerDefaultTxTypes,
} from "../src/index.js";
import { openFormally } from "./helpers/chip-ctx.js";

registerDefaultTxTypes();

/**
 * PR23 レビュー追補。
 *
 * ここで見るのは、永続卓を持たない賭博（ルーレット卓・`/勝負` の対人卓）にも
 * 正本 §15 の安全上限が効くこと、そして枠の取り忘れが「静かに上限を無視する」のではなく
 * **失敗する**こと（fail-closed）。
 */

const DEFAULT_TEST_NOW = Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60;

function setup(
  options: {
    now?: number;
    dailyLossLimitBps?: number;
    boundaryOffsetMinutes?: number;
    highCooldownSec?: number | null;
    superHighEnabled?: boolean;
    extremeEnabled?: boolean;
    /** 正式開業させない（開業前の照会・作成を見るテスト用） */
    preformal?: boolean;
  } = {},
) {
  let now = options.now ?? DEFAULT_TEST_NOW;
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  if (!options.preformal) {
    openFormally(chipTx, ledger);
    db.prepare("UPDATE casino_chip_opening_versions SET created_at=? WHERE opening_version='opening_v1'").run(now - 31 * 24 * 60 * 60);
  }
  const assets = new CasinoChipAssets(db, chips);
  const dailyRisk = new DailyRisk(db, ledger, assets, {
    now: () => now,
    openingPhase: () => chipTx.openingPhase(),
    dailyLossLimitBps: () => options.dailyLossLimitBps ?? 3_000,
    boundaryOffsetMinutes: () => options.boundaryOffsetMinutes ?? 0,
  });
  const casino = new Casino(db, chips, events, { dailyRisk });
  const reservations = new HouseReservations(db, chips, events);
  chips.setReservedProvider((holderId) => (holderId === HOUSE_HOLDER ? reservations.totalReserved() : 0));
  const escrow = new Escrow(db, chips, events, { onPlayerNet: (userId, net) => casino.recordGameNet(userId, net) });
  const persistentTables = new PersistentTables(db, events, { openingPhase: () => chipTx.openingPhase(), now: () => now });
  const chipFlow = new CasinoChipFlow(db, chips, events, assets);
  const disputes = new RankedDisputes(db, chips, escrow, persistentTables, reservations, events, {
    now: () => now,
    openingPhase: () => chipTx.openingPhase(),
    onPlayerNet: (userId, net) => casino.recordGameNet(userId, net),
    dailyRisk,
  });
  const rankedTables = new RankedTables(db, chips, escrow, persistentTables, events, new CasinoMetrics(db, chipTx, () => now), {
    now: () => now,
    chipFlow,
    reservations,
    disputes,
    dailyRisk,
    openingPhase: () => chipTx.openingPhase(),
    highCooldownSec: () => options.highCooldownSec ?? null,
    superHighEnabled: () => options.superHighEnabled === true,
    extremeEnabled: () => options.extremeEnabled === true,
  });
  return {
    db,
    ledger,
    chips,
    assets,
    dailyRisk,
    casino,
    escrow,
    reservations,
    rankedTables,
    setNow: (value: number) => {
      now = value;
    },
  };
}

function seedChips(ctx: ReturnType<typeof setup>, userId: string, amount: number): void {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  ctx.ledger.transfer({ from: TREASURY, to: `user:${userId}`, amount, type: "initial", actor: "test", idempotencyKey: `seed:${userId}:${amount}` });
  ctx.chips.deposit(userId, amount, `deposit:${userId}:${amount}`);
}

function fundHouse(ctx: ReturnType<typeof setup>, amount: number): void {
  ctx.ledger.ensureAccount(`user:house-funder`, "user");
  ctx.ledger.transfer({ from: TREASURY, to: "user:house-funder", amount, type: "initial", actor: "test", idempotencyKey: `house:${amount}` });
  ctx.chips.deposit("house-funder", amount, `deposit:house:${amount}`);
  ctx.chips.runGroup({ groupKey: `house-fund:${amount}`, kind: "admin", actorId: "test" }, () => {
    ctx.chips.transfer("house-funder", HOUSE_HOLDER, amount, { reason: "test house funding" });
  });
}

function exposureRows(ctx: ReturnType<typeof setup>) {
  return ctx.db
    .prepare("SELECT scope_key, user_id, day_key, max_player_loss FROM casino_risk_exposures ORDER BY scope_key, user_id")
    .all() as Array<{ scope_key: string; user_id: string; day_key: string; max_player_loss: number }>;
}

function eventRows(ctx: ReturnType<typeof setup>) {
  // 失敗経路のテストでは、まだリスク表が1つも作られていないことがある（＝イベント0件）
  if (!ctx.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='casino_daily_risk_events'").get()) return [];
  return ctx.db
    .prepare("SELECT event_key, user_id, day_key, source_kind, net_signed FROM casino_daily_risk_events ORDER BY event_key")
    .all() as Array<{ event_key: string; user_id: string; day_key: string; source_kind: string; net_signed: number }>;
}

describe("shared-table risk exposure", () => {
  it("passes at exactly 50% holdings and rejects one Land over without writing an exposure", () => {
    const ctx = setup({ dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 10_000);
    seedChips(ctx, "bob", 10_000);

    // ちょうど50%は通る
    const ok = ctx.dailyRisk.authorizeExposure({
      userId: "alice",
      scopeKey: "roulette:s1",
      operationId: "op1",
      game: "ルーレット",
      maxPlayerLoss: 5_000,
      mode: "replace",
    });
    expect(ok.maxPlayerLoss).toBe(5_000);

    // 1 Ld でも超えたら断る。露出は1行も書かれない
    expect(() =>
      ctx.dailyRisk.authorizeExposure({
        userId: "bob",
        scopeKey: "roulette:s2",
        operationId: "op2",
        game: "ルーレット",
        maxPlayerLoss: 5_001,
        mode: "replace",
      }),
    ).toThrow(DailyRiskError);
    expect(exposureRows(ctx)).toEqual([{ scope_key: "roulette:s1", user_id: "alice", day_key: ok.dayKey, max_player_loss: 5_000 }]);
  });

  it("replaces a rebet instead of stacking it, and shrinks it back", () => {
    const ctx = setup({ dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 10_000);
    const base = { userId: "alice", scopeKey: "roulette:s1", game: "ルーレット", mode: "replace" as const };

    ctx.dailyRisk.authorizeExposure({ ...base, operationId: "op1", maxPlayerLoss: 500 });
    ctx.dailyRisk.authorizeExposure({ ...base, operationId: "op2", maxPlayerLoss: 1_000 });
    // 500 + 1000 = 1500 にはならない
    expect(exposureRows(ctx)[0]?.max_player_loss).toBe(1_000);

    ctx.dailyRisk.authorizeExposure({ ...base, operationId: "op3", maxPlayerLoss: 500 });
    expect(exposureRows(ctx)[0]?.max_player_loss).toBe(500);
  });

  it("adds up stakes taken on the same table (multi-round chohan style)", () => {
    const ctx = setup({ dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 10_000);
    const base = { userId: "alice", scopeKey: "pvp:s1", game: "chohan-multi", mode: "add" as const };

    // 実際の徴収と同じ順序（枠を取る → エスクローへ預ける）で積み増す
    ctx.dailyRisk.authorizeExposure({ ...base, operationId: "op1", maxPlayerLoss: 1_000 });
    ctx.escrow.hold("pvp:s1", "alice", 1_000, "chohan-multi", "hold-1");
    ctx.dailyRisk.authorizeExposure({ ...base, operationId: "op2", maxPlayerLoss: 500 });
    ctx.escrow.hold("pvp:s1", "alice", 500, "chohan-multi", "hold-2");
    expect(exposureRows(ctx)[0]?.max_player_loss).toBe(1_500);

    // 積み増した結果が所持50%を超えるなら断る（積み増しぶんだけでは判定しない）
    expect(() => ctx.dailyRisk.authorizeExposure({ ...base, operationId: "op3", maxPlayerLoss: 4_000 })).toThrow(DailyRiskError);
    expect(exposureRows(ctx)[0]?.max_player_loss).toBe(1_500);
  });

  it("judges a split stake the same as a single one by adding the table's own escrow back", () => {
    // 所持は「通常Land + 自由チップ」でエスクローを含めないので、素直に比べると
    // 同じ 5,000 でも「1口で張る」と「3,000+2,000 に割る」で判定が変わってしまう。
    // その卓へ預けたぶんだけ足し戻して、どちらでも同じ結論になることを固定する。
    const single = setup({ dailyLossLimitBps: 10_000 });
    seedChips(single, "alice", 10_000);
    expect(
      single.dailyRisk.authorizeExposure({ userId: "alice", scopeKey: "keiba:s1", operationId: "op1", game: "競馬", maxPlayerLoss: 5_000, mode: "add" })
        .maxPlayerLoss,
    ).toBe(5_000);

    const split = setup({ dailyLossLimitBps: 10_000 });
    seedChips(split, "alice", 10_000);
    const base = { userId: "alice", scopeKey: "keiba:s1", game: "競馬", mode: "add" as const };
    split.dailyRisk.authorizeExposure({ ...base, operationId: "op1", maxPlayerLoss: 3_000 });
    split.escrow.hold("keiba:s1", "alice", 3_000, "keiba", "hold-1");
    expect(split.dailyRisk.holdings("alice")).toBe(7_000); // エスクローは所持から抜けている
    expect(split.dailyRisk.authorizeExposure({ ...base, operationId: "op2", maxPlayerLoss: 2_000 }).maxPlayerLoss).toBe(5_000);

    // 1 Ld 上乗せは合計 5,001 になるので、どちらの張り方でも断られる
    split.escrow.hold("keiba:s1", "alice", 2_000, "keiba", "hold-2");
    expect(() => split.dailyRisk.authorizeExposure({ ...base, operationId: "op3", maxPlayerLoss: 1 })).toThrow(DailyRiskError);
    expect(exposureRows(split)[0]?.max_player_loss).toBe(5_000);
  });

  it("replays the same operation and rejects the same operation with a different payload", () => {
    const ctx = setup({ dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 10_000);
    const base = { userId: "alice", scopeKey: "roulette:s1", game: "ルーレット", mode: "replace" as const };

    const first = ctx.dailyRisk.authorizeExposure({ ...base, operationId: "op1", maxPlayerLoss: 500 });
    const replay = ctx.dailyRisk.authorizeExposure({ ...base, operationId: "op1", maxPlayerLoss: 500 });
    expect(replay).toEqual(first);
    expect(exposureRows(ctx)[0]?.max_player_loss).toBe(500);

    expect(() => ctx.dailyRisk.authorizeExposure({ ...base, operationId: "op1", maxPlayerLoss: 900 })).toThrow(DailyRiskError);
    expect(exposureRows(ctx)[0]?.max_player_loss).toBe(500);
  });

  it("revokes exactly the last operation and refuses out-of-order revokes", () => {
    const ctx = setup({ dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 10_000);
    const base = { userId: "alice", scopeKey: "pvp:s1", game: "chohan-multi", mode: "add" as const };
    ctx.dailyRisk.authorizeExposure({ ...base, operationId: "op1", maxPlayerLoss: 1_000 });
    ctx.dailyRisk.authorizeExposure({ ...base, operationId: "op2", maxPlayerLoss: 500 });

    // 古い操作の取り消しは順序が壊れるので拒否
    expect(() => ctx.dailyRisk.revokeExposure({ scopeKey: "pvp:s1", userId: "alice", operationId: "op1" })).toThrow(DailyRiskError);
    // 最新の操作だけ取り消せる。1回目の 1,000 は残る
    ctx.dailyRisk.revokeExposure({ scopeKey: "pvp:s1", userId: "alice", operationId: "op2" });
    expect(exposureRows(ctx)[0]?.max_player_loss).toBe(1_000);
    // 存在しない操作の取り消しは何もしない（再試行安全）
    ctx.dailyRisk.revokeExposure({ scopeKey: "pvp:s1", userId: "alice", operationId: "op2" });
    expect(exposureRows(ctx)[0]?.max_player_loss).toBe(1_000);
    // 最初の操作まで取り消せば露出そのものが消える
    ctx.dailyRisk.revokeExposure({ scopeKey: "pvp:s1", userId: "alice", operationId: "op1" });
    expect(exposureRows(ctx)).toEqual([]);
  });

  it("fixes the exposure day at the first acceptance and refuses to carry it across midnight", () => {
    const ctx = setup({ dailyLossLimitBps: 10_000, boundaryOffsetMinutes: 0 });
    seedChips(ctx, "alice", 40_000);
    const base = { userId: "alice", scopeKey: "keiba:s1", game: "競馬" };

    const first = ctx.dailyRisk.authorizeExposure({ ...base, operationId: "op1", maxPlayerLoss: 3_000, mode: "add" });
    const dayStart = ctx.dailyRisk.dayFor("alice").dayStartAt;
    // 23:59 の受付 → 00:00 へ日が変わる
    ctx.setNow(dayStart + 86_400 + 1);
    expect(ctx.dailyRisk.dayFor("alice").dayKey).not.toBe(first.dayKey);

    // A: 日を跨いだ積み増しは断る（前日に取った枠ごと翌日へ移せてしまうため）
    expect(() => ctx.dailyRisk.authorizeExposure({ ...base, operationId: "op2", maxPlayerLoss: 1_000, mode: "add" })).toThrow(DailyRiskError);
    // B: 張り直しも同じ
    expect(() => ctx.dailyRisk.authorizeExposure({ ...base, operationId: "op3", maxPlayerLoss: 1_000, mode: "replace" })).toThrow(DailyRiskError);
    // 既存の露出は日も額も変わっていない
    expect(exposureRows(ctx)).toEqual([{ scope_key: "keiba:s1", user_id: "alice", day_key: first.dayKey, max_player_loss: 3_000 }]);

    // C: 成功済み操作の replay は日界判定より先に保存済みの結果を返す
    expect(ctx.dailyRisk.authorizeExposure({ ...base, operationId: "op1", maxPlayerLoss: 3_000, mode: "add" })).toEqual(first);
    expect(exposureRows(ctx)).toEqual([{ scope_key: "keiba:s1", user_id: "alice", day_key: first.dayKey, max_player_loss: 3_000 }]);

    // D: 翌日に精算しても、当日枠は受付日のほうへ入る
    ctx.dailyRisk.settleExposure({ scopeKey: "keiba:s1", userId: "alice", operationId: "race", netSigned: -3_000 });
    expect(eventRows(ctx)).toEqual([
      expect.objectContaining({ event_key: "exposure_result:keiba:s1:alice", day_key: first.dayKey, net_signed: -3_000 }),
    ]);
    expect(ctx.dailyRisk.dayFor("alice", dayStart + 10).netSigned).toBe(-3_000);
    expect(ctx.dailyRisk.dayFor("alice").netSigned).toBe(0); // 翌日の枠は無傷
  });

  it("rejects a bet once the daily loss cap is reached without touching the exposure table", () => {
    const ctx = setup({ dailyLossLimitBps: 3_000 });
    seedChips(ctx, "alice", 10_000);
    // 当日枠は 3,000。まず 3,000 負けたことにする
    ctx.dailyRisk.authorizeSoloStart({ userId: "alice", operationId: "solo1", game: "slots", bet: 3_000, maxPlayerLoss: 3_000 });
    ctx.dailyRisk.recordSoloResult({ userId: "alice", operationId: "solo1", netSigned: -3_000 });
    expect(ctx.dailyRisk.remainingLossBudget("alice")).toBe(0);

    expect(() =>
      ctx.dailyRisk.authorizeExposure({
        userId: "alice",
        scopeKey: "roulette:s1",
        operationId: "op1",
        game: "ルーレット",
        maxPlayerLoss: 1,
        mode: "replace",
      }),
    ).toThrow(DailyRiskError);
    expect(exposureRows(ctx)).toEqual([]);
  });

  it("attributes the settlement to the day the bet was accepted, even across the day boundary", () => {
    const ctx = setup({ dailyLossLimitBps: 10_000, boundaryOffsetMinutes: 0 });
    seedChips(ctx, "alice", 10_000);
    fundHouse(ctx, 100_000);
    const accepted = ctx.dailyRisk.authorizeExposure({
      userId: "alice",
      scopeKey: "roulette:s1",
      operationId: "op1",
      game: "ルーレット",
      maxPlayerLoss: 1_000,
      mode: "replace",
    });

    // 受付は day A、精算は day B
    ctx.setNow(ctx.dailyRisk.dayFor("alice").dayStartAt + 86_400 + 60);
    const nextDay = ctx.dailyRisk.dayFor("alice");
    expect(nextDay.dayKey).not.toBe(accepted.dayKey);

    ctx.casino.settle("alice", "roulette", 1_000, 0, 0, {
      chain: false,
      fuku: false,
      operationId: "roulette:s1:alice",
      risk: { kind: "exposure", scopeKey: "roulette:s1" },
    });

    expect(eventRows(ctx)).toEqual([
      expect.objectContaining({ event_key: "exposure_result:roulette:s1:alice", day_key: accepted.dayKey, net_signed: -1_000 }),
    ]);
    // 露出は精算で解ける
    expect(exposureRows(ctx)).toEqual([]);
  });

  it("records a win once and a loss once, and leaves refunds at zero", () => {
    const ctx = setup({ dailyLossLimitBps: 10_000, boundaryOffsetMinutes: 0 });
    seedChips(ctx, "alice", 10_000);
    seedChips(ctx, "bob", 10_000);
    fundHouse(ctx, 100_000);
    for (const userId of ["alice", "bob"]) {
      ctx.dailyRisk.authorizeExposure({ userId, scopeKey: "roulette:s1", operationId: `op:${userId}`, game: "ルーレット", maxPlayerLoss: 1_000, mode: "replace" });
    }
    // alice は赤で的中（2倍）、bob は外れ
    ctx.casino.settle("alice", "roulette", 1_000, 2_000, 0, { chain: false, fuku: false, operationId: "s1:alice", risk: { kind: "exposure", scopeKey: "roulette:s1" } });
    ctx.casino.settle("bob", "roulette", 1_000, 0, 0, { chain: false, fuku: false, operationId: "s1:bob", risk: { kind: "exposure", scopeKey: "roulette:s1" } });

    expect(ctx.dailyRisk.dayFor("alice").netSigned).toBe(1_000);
    expect(ctx.dailyRisk.dayFor("bob").netSigned).toBe(-1_000);
    expect(eventRows(ctx).filter((row) => row.source_kind === "exposure_result")).toHaveLength(2);

    // 流れた卓（返金）は純損益0。イベントは増えない
    ctx.dailyRisk.authorizeExposure({ userId: "alice", scopeKey: "roulette:s2", operationId: "op:void", game: "ルーレット", maxPlayerLoss: 1_000, mode: "replace" });
    ctx.dailyRisk.releaseExposureScope("roulette:s2");
    expect(ctx.dailyRisk.dayFor("alice").netSigned).toBe(1_000);
    expect(eventRows(ctx).filter((row) => row.source_kind === "exposure_result")).toHaveLength(2);
  });
});

describe("missing risk authorization is fail-closed", () => {
  it("throws and rolls back the money when a solo settlement has no start", () => {
    const ctx = setup({ dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 10_000);
    fundHouse(ctx, 100_000);
    const before = { alice: ctx.chips.balanceOf("alice"), house: ctx.chips.balanceOf(HOUSE_HOLDER) };

    expect(() => ctx.casino.settleSolo("alice", "slots", 1_000, 0, { operationId: "never-authorized", chain: false, fuku: false })).toThrow(
      DailyRiskError,
    );

    expect({ alice: ctx.chips.balanceOf("alice"), house: ctx.chips.balanceOf(HOUSE_HOLDER) }).toEqual(before);
    expect(eventRows(ctx)).toEqual([]);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_stats WHERE user_id='alice'").get()).toEqual({ n: 0 });
  });

  it("throws and rolls back the money when a shared-table settlement has no exposure", () => {
    const ctx = setup({ dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 10_000);
    fundHouse(ctx, 100_000);
    const before = { alice: ctx.chips.balanceOf("alice"), house: ctx.chips.balanceOf(HOUSE_HOLDER) };

    expect(() =>
      ctx.casino.settle("alice", "roulette", 1_000, 0, 0, {
        chain: false,
        fuku: false,
        operationId: "s9:alice",
        risk: { kind: "exposure", scopeKey: "roulette:s9" },
      }),
    ).toThrow(DailyRiskError);

    expect({ alice: ctx.chips.balanceOf("alice"), house: ctx.chips.balanceOf(HOUSE_HOLDER) }).toEqual(before);
    expect(eventRows(ctx)).toEqual([]);
  });

  it("refuses to attach an extra loss to another user's solo start", () => {
    const ctx = setup({ dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 10_000);
    ctx.dailyRisk.authorizeSoloStart({ userId: "alice", operationId: "chinchiro:1", game: "chinchiro", bet: 1_000, maxPlayerLoss: 2_000 });

    expect(() => ctx.dailyRisk.recordSoloExtraLoss({ userId: "mallory", operationId: "chinchiro:1", netSigned: -1_000 })).toThrow(DailyRiskError);
    expect(() => ctx.dailyRisk.recordSoloResult({ userId: "mallory", operationId: "chinchiro:1", netSigned: -1_000 })).toThrow(DailyRiskError);
    expect(eventRows(ctx)).toEqual([]);
  });

  it("does not duplicate the risk event when the same settlement operation replays", () => {
    const ctx = setup({ dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 10_000);
    fundHouse(ctx, 100_000);
    ctx.dailyRisk.authorizeSoloStart({ userId: "alice", operationId: "op1", game: "slots", bet: 1_000, maxPlayerLoss: 1_000 });

    ctx.casino.settleSolo("alice", "slots", 1_000, 0, { operationId: "op1", chain: false, fuku: false });
    ctx.casino.settleSolo("alice", "slots", 1_000, 0, { operationId: "op1", chain: false, fuku: false });

    expect(eventRows(ctx).filter((row) => row.source_kind === "solo_result")).toHaveLength(1);
    expect(ctx.dailyRisk.dayFor("alice").netSigned).toBe(-1_000);
  });
});

describe("day-start holdings reconstruction", () => {
  function schemaNames(ctx: ReturnType<typeof setup>): string[] {
    return (ctx.db.prepare("SELECT name FROM sqlite_master ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
  }

  it("is unchanged by same-day deposits, redeems, escrow holds and incoming Land transfers", () => {
    const ctx = setup({ dailyLossLimitBps: 3_000, boundaryOffsetMinutes: 0 });
    seedChips(ctx, "alice", 10_000);
    const opening = ctx.dailyRisk.dayFor("alice").openingHoldings;
    expect(ctx.dailyRisk.dayFor("alice").lossCap).toBe(Math.floor((opening * 3_000) / 10_000));

    // Land → 自由チップ（預入）: 所持の内訳が変わるだけ
    ctx.ledger.ensureAccount("user:alice", "user");
    ctx.ledger.transfer({ from: TREASURY, to: "user:alice", amount: 4_000, type: "initial", actor: "test", idempotencyKey: "noon-land" });
    ctx.chips.deposit("alice", 4_000, "noon-deposit");
    expect(ctx.dailyRisk.dayFor("alice").openingHoldings).toBe(opening);

    // 自由チップ → Land（払戻）
    ctx.chips.redeem("alice", 1_000, "noon-redeem");
    expect(ctx.dailyRisk.dayFor("alice").openingHoldings).toBe(opening);

    // エスクロー預託と返金
    ctx.escrow.hold("escrow-test", "alice", 2_000, "test", "hold-1");
    expect(ctx.dailyRisk.dayFor("alice").openingHoldings).toBe(opening);
    ctx.escrow.refund("escrow-test");
    expect(ctx.dailyRisk.dayFor("alice").openingHoldings).toBe(opening);
  });

  it("keeps the same snapshot after a restart and fails closed on a corrupt day row", () => {
    const ctx = setup({ dailyLossLimitBps: 3_000, boundaryOffsetMinutes: 0 });
    seedChips(ctx, "alice", 10_000);
    const day = ctx.dailyRisk.dayFor("alice");

    // 「再起動」= 同じ DB の上でサービスを組み直す
    const restarted = new DailyRisk(ctx.db, ctx.ledger, ctx.assets, { boundaryOffsetMinutes: () => 0, dailyLossLimitBps: () => 3_000 });
    expect(restarted.dayFor("alice", day.dayStartAt + 100).openingHoldings).toBe(day.openingHoldings);

    // 設定が壊れていれば新しい賭博を始めさせない（0扱いで続行しない）
    const broken = new DailyRisk(ctx.db, ctx.ledger, ctx.assets, { dailyLossLimitBps: () => -1 });
    expect(() => broken.dayFor("bob")).toThrow(DailyRiskError);
  });

  it("does not move the daily gambling net for non-gambling economy operations", () => {
    const ctx = setup({ dailyLossLimitBps: 3_000, boundaryOffsetMinutes: 0 });
    seedChips(ctx, "alice", 10_000);
    expect(ctx.dailyRisk.dayFor("alice").netSigned).toBe(0);

    ctx.chips.redeem("alice", 1_000, "redeem-1");
    ctx.chips.deposit("alice", 1_000, "deposit-1");
    ctx.escrow.hold("escrow-test", "alice", 500, "test", "hold-1");
    ctx.escrow.refund("escrow-test");

    expect(ctx.dailyRisk.dayFor("alice").netSigned).toBe(0);
    expect(eventRows(ctx)).toEqual([]);
    expect(schemaNames(ctx)).toContain("casino_daily_risk_days");
  });
});

describe("ranked tier availability is read-only before formal opening", () => {
  function schemaSnapshot(ctx: ReturnType<typeof setup>): string {
    return (ctx.db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all() as Array<Record<string, unknown>>)
      .map((row) => JSON.stringify(row))
      .join("\n");
  }

  it("reports every tier as unavailable before formal opening without touching sqlite_master", () => {
    const ctx = setup({ preformal: true, highCooldownSec: 3_600, superHighEnabled: true, extremeEnabled: true });
    const before = schemaSnapshot(ctx);

    for (const authority of ["employee", "manager"] as const) {
      const rows = ctx.rankedTables.rankedTierAvailability(authority);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.available === false)).toBe(true);
      expect(rows.every((row) => row.reason === "ranked tables require formal opening")).toBe(true);
    }

    expect(schemaSnapshot(ctx)).toBe(before);
    expect(ctx.db.prepare("SELECT 1 FROM sqlite_master WHERE name='casino_ranked_open_history'").get()).toBeUndefined();
  });

  it("rejects a pre-formal high create and leaves the open-history schema absent", () => {
    const ctx = setup({ preformal: true, highCooldownSec: 3_600 });
    const before = schemaSnapshot(ctx);

    expect(() =>
      ctx.rankedTables.create({ tableId: "high1", gameKey: "gf", baseAmount: 10_000, creatorId: "operator", operatorId: "operator", operationId: "create:high1" }),
    ).toThrow(RankedTableError);

    expect(schemaSnapshot(ctx)).toBe(before);
    expect(ctx.db.prepare("SELECT 1 FROM sqlite_master WHERE name='casino_ranked_open_history'").get()).toBeUndefined();
  });

  it("does not mutate the schema when reading availability after formal opening either", () => {
    const ctx = setup({ highCooldownSec: 3_600 });
    const before = schemaSnapshot(ctx);
    const rows = ctx.rankedTables.rankedTierAvailability("employee");
    expect(rows.find((row) => row.tierKey === "high")?.available).toBe(true);
    expect(rows.find((row) => row.tierKey === "super_high")?.available).toBe(false);
    expect(schemaSnapshot(ctx)).toBe(before);
  });

  it("creates the open-history table only on the real write path", () => {
    const ctx = setup({ highCooldownSec: 3_600 });
    ctx.rankedTables.create({ tableId: "high1", gameKey: "gf", baseAmount: 10_000, creatorId: "operator", operatorId: "operator", operationId: "create:high1" });
    expect(ctx.db.prepare("SELECT 1 FROM sqlite_master WHERE name='casino_ranked_open_history'").get()).toBeDefined();
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_ranked_open_history").get()).toEqual({ n: 1 });
  });

  it("fails closed on a partial open-history schema instead of repairing it", () => {
    const ctx = setup({ highCooldownSec: 3_600 });
    ctx.db.exec("CREATE TABLE casino_ranked_open_history (operation_id TEXT PRIMARY KEY, table_id TEXT NOT NULL)");

    const rows = ctx.rankedTables.rankedTierAvailability("employee");
    expect(rows.find((row) => row.tierKey === "high")?.reason).toBe("ranked open history schema is incomplete");
    // 見習い〜中卓（高卓未満）はクールダウンの対象外なので影響を受けない
    expect(rows.find((row) => row.tierKey === "middle")?.available).toBe(true);

    expect(() =>
      ctx.rankedTables.create({ tableId: "high1", gameKey: "gf", baseAmount: 10_000, creatorId: "operator", operatorId: "operator", operationId: "create:high1" }),
    ).toThrow(RankedTableError);
    // 壊れた表を勝手に直していない
    expect((ctx.db.prepare("PRAGMA table_info(casino_ranked_open_history)").all() as Array<{ name: string }>).map((c) => c.name)).toEqual([
      "operation_id",
      "table_id",
    ]);
  });
});

describe("ranked tier policy regression", () => {
  const create = (ctx: ReturnType<typeof setup>, tableId: string, baseAmount: number, authority: "employee" | "manager") =>
    ctx.rankedTables.create({ tableId, gameKey: "gf", baseAmount, creatorId: "operator", operatorId: "operator", operationId: `create:${tableId}`, authority });

  it("lets an employee open minarai through high, but nothing above it", () => {
    const ctx = setup({ highCooldownSec: 3_600, superHighEnabled: true, extremeEnabled: true });
    const rows = ctx.rankedTables.rankedTierAvailability("employee");
    expect(rows.filter((row) => row.available).map((row) => row.tierKey)).toEqual(["minarai", "low", "middle", "high"]);
    expect(() => create(ctx, "super1", 30_000, "employee")).toThrow(RankedTableError);
    expect(() => create(ctx, "extreme1", 50_000, "employee")).toThrow(RankedTableError);
  });

  it("closes high-or-above when the cooldown setting is missing or invalid", () => {
    for (const cooldown of [null, 0, -1]) {
      const ctx = setup({ highCooldownSec: cooldown });
      expect(ctx.rankedTables.rankedTierAvailability("employee").find((row) => row.tierKey === "high")?.available).toBe(false);
      expect(() => create(ctx, "high1", 10_000, "employee")).toThrow(RankedTableError);
      // 高卓未満は通常どおり開ける
      expect(create(ctx, "mid1", 5_000, "employee").config.baseAmount).toBe(5_000);
    }
  });

  it("keeps super high closed until 30 formal days and an explicit enable, and meigoku manager-only", () => {
    const disabled = setup({ highCooldownSec: 3_600 });
    expect(() => create(disabled, "super1", 30_000, "manager")).toThrow(RankedTableError);

    const youngNow = 1_700_000_000;
    const young = setup({ now: youngNow, highCooldownSec: 3_600, superHighEnabled: true });
    young.db.prepare("UPDATE casino_chip_opening_versions SET created_at=? WHERE opening_version='opening_v1'").run(youngNow - 29 * 24 * 60 * 60);
    expect(() => create(young, "super2", 30_000, "manager")).toThrow(RankedTableError);

    const ready = setup({ highCooldownSec: 3_600, superHighEnabled: true });
    expect(create(ready, "super3", 30_000, "manager").config.baseAmount).toBe(30_000);
  });

  it("cannot bypass the canonical tier list with a raw base amount", () => {
    const ctx = setup({ highCooldownSec: 3_600 });
    expect(() => create(ctx, "odd1", 9_900, "manager")).toThrow(RankedTableError);
  });
});
