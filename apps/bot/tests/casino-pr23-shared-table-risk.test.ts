import { beforeEach, describe, expect, it } from "vitest";
import {
  Casino,
  CasinoChipAssets,
  CasinoChipFlow,
  ChipLedger,
  ChipTx,
  DailyRisk,
  Escrow,
  EventLog,
  FreeSpins,
  HOUSE_HOLDER,
  HouseReservations,
  Items,
  JACKPOT_HOLDER,
  Ledger,
  TREASURY,
  CHIP_ESCROW,
  FORMAL_OPENING_VERSION,
  openDb,
  registerDefaultTxTypes,
  scriptedRng,
  type CasinoRng,
} from "@meigokujo/core";
import type { Services } from "../src/services.js";
import { acceptRouletteBet, rouletteRiskScope, settleRoulette, voidRouletteTable } from "../src/casino/roulette.js";
import { collectStakes, pvpRiskScope, refundAll, settlePvp, settleProportional, voidPvpTable } from "../src/casino/pvp-common.js";
import { acquireSeat, releaseSeat } from "../src/casino/common.js";
import { spinPaid } from "../src/casino/slots.js";
import { hasTransientParticipation, resetTransientParticipationForTesting } from "../src/casino/participation.js";

registerDefaultTxTypes();

/**
 * PR23 レビュー BLOCKER A / B。
 *
 * ルーレット卓（共有セッション）と `/勝負` の対人卓は、永続順位卓とは別のしくみだが
 * **現役のマモン賭博入口**なので、正本 §15 の安全上限を必ず通す。ここではその接続と、
 * 賭博どうしの排他（1人1卓）を見る。場代の行き先・配当・勝敗判定・RTP は一切触っていない。
 */

/** 生きている常設順位卓の有無を差し替えられる最小スタブ */
let liveRankedTableUsers = new Set<string>();

/**
 * 当日枠の基準時刻。種まきの取引より**後**の日を「今日」にしておく。
 * 実時刻のままだと、当日開始時点の所持額の再構成が種まき取引を差し引いてしまい、
 * 上限0の日から始まってしまう。
 */
const TEST_NOW = Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60;

function setup(rng: CasinoRng = scriptedRng([0.5]), options: { dailyLossLimitBps?: number } = {}) {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  chipTx.captureOpening(FORMAL_OPENING_VERSION, [], { poolLand: ledger.balanceOf(CHIP_ESCROW), fromLedgerTxId: ledger.lastTransactionId() });
  const items = new Items(db);
  const reservations = new HouseReservations(db, chips, events);
  chips.setReservedProvider((holderId) => (holderId === HOUSE_HOLDER ? reservations.totalReserved() : 0));
  const chipAssets = new CasinoChipAssets(db, chips);
  const dailyRisk = new DailyRisk(db, ledger, chipAssets, {
    now: () => TEST_NOW,
    openingPhase: () => chipTx.openingPhase(),
    dailyLossLimitBps: () => options.dailyLossLimitBps ?? 3_000,
  });
  const casino = new Casino(db, chips, events, { items, reservations, dailyRisk });
  const escrow = new Escrow(db, chips, events, { onPlayerNet: (userId, net) => casino.recordGameNet(userId, net) });
  const chipFlow = new CasinoChipFlow(db, chips, events, chipAssets);
  const freeSpins = new FreeSpins(db);
  const services = {
    db,
    ledger,
    events,
    chipTx,
    chips,
    ether: chips,
    chipAssets,
    chipFlow,
    casino,
    escrow,
    items,
    reservations,
    dailyRisk,
    freeSpins,
    rng,
    persistentTables: { participantHasLiveTable: (userId: string) => liveRankedTableUsers.has(userId) },
  } as unknown as Services;
  // 翌日から同じ卓を触りにいくための窓（日界跨ぎの確認用）
  const tomorrowRisk = new DailyRisk(db, ledger, chipAssets, {
    now: () => TEST_NOW + 86_400,
    openingPhase: () => chipTx.openingPhase(),
    dailyLossLimitBps: () => options.dailyLossLimitBps ?? 3_000,
  });
  const tomorrowServices = { ...services, dailyRisk: tomorrowRisk } as unknown as Services;
  return { db, ledger, chips, chipAssets, dailyRisk, casino, escrow, reservations, services, tomorrowServices };
}

type Ctx = ReturnType<typeof setup>;

function seedChips(ctx: Ctx, userId: string, amount: number): void {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  ctx.ledger.transfer({ from: TREASURY, to: `user:${userId}`, amount, type: "initial", actor: "test", idempotencyKey: `seed:${userId}:${amount}` });
  ctx.chips.deposit(userId, amount, `deposit:${userId}:${amount}`);
}

function fundHouse(ctx: Ctx, amount: number): void {
  seedChips(ctx, "house-funder", amount);
  ctx.chips.runGroup({ groupKey: `house-fund:${amount}`, kind: "admin", actorId: "test" }, () => {
    ctx.chips.transfer("house-funder", HOUSE_HOLDER, amount, { reason: "test house funding" });
  });
}

function fundsSnapshot(ctx: Ctx, userIds: string[]) {
  return {
    chips: Object.fromEntries(userIds.map((u) => [u, ctx.chips.balanceOf(u)])),
    land: Object.fromEntries(userIds.map((u) => [u, ctx.ledger.balanceOf(`user:${u}`)])),
    free: Object.fromEntries(userIds.map((u) => [u, ctx.chipAssets.freeChips(u)])),
    house: ctx.chips.balanceOf(HOUSE_HOLDER),
    jackpot: ctx.chips.balanceOf(JACKPOT_HOLDER),
    reservations: ctx.reservations.totalReserved(),
    casinoTx: (ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_tx").get() as { n: number }).n,
  };
}

function exposureRows(ctx: Ctx) {
  if (!ctx.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='casino_risk_exposures'").get()) return [];
  return ctx.db.prepare("SELECT scope_key, user_id, max_player_loss FROM casino_risk_exposures ORDER BY scope_key, user_id").all() as Array<{
    scope_key: string;
    user_id: string;
    max_player_loss: number;
  }>;
}

function riskEvents(ctx: Ctx) {
  if (!ctx.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='casino_daily_risk_events'").get()) return [];
  return ctx.db
    .prepare("SELECT event_key, user_id, day_key, source_kind, net_signed FROM casino_daily_risk_events ORDER BY event_key")
    .all() as Array<{ event_key: string; user_id: string; day_key: string; source_kind: string; net_signed: number }>;
}

/** 当日枠を使い切らせる（ソロ枠を通して確定させる。資金は動かさない） */
function exhaustDailyBudget(ctx: Ctx, userId: string): void {
  const remaining = ctx.dailyRisk.remainingLossBudget(userId);
  ctx.dailyRisk.authorizeSoloStart({ userId, operationId: `drain:${userId}`, game: "slots", bet: remaining, maxPlayerLoss: remaining });
  ctx.dailyRisk.recordSoloResult({ userId, operationId: `drain:${userId}`, netSigned: -remaining });
  expect(ctx.dailyRisk.remainingLossBudget(userId)).toBe(0);
}

beforeEach(() => {
  liveRankedTableUsers = new Set<string>();
  resetTransientParticipationForTesting();
});

describe("roulette goes through the PR23 risk gates", () => {
  it("rejects a bet once the daily cap is reached and moves no funds at all", () => {
    const ctx = setup();
    fundHouse(ctx, 1_000_000);
    seedChips(ctx, "alice", 10_000);
    exhaustDailyBudget(ctx, "alice");
    const before = fundsSnapshot(ctx, ["alice"]);

    const r = acceptRouletteBet(ctx.services, "roulette:s1", new Map(), "alice", "red", 100, "op1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("risk");

    expect(fundsSnapshot(ctx, ["alice"])).toEqual(before);
    expect(ctx.escrow.poolOf("roulette:s1")).toBe(0);
    expect(exposureRows(ctx)).toEqual([]);
    expect(hasTransientParticipation("alice")).toBe(false);
  });

  it("records a roulette loss exactly once as a negative daily net", () => {
    const ctx = setup();
    fundHouse(ctx, 1_000_000);
    seedChips(ctx, "alice", 10_000);
    const bets = new Map();
    expect(acceptRouletteBet(ctx.services, "roulette:s1", bets, "alice", "red", 1_000, "op1").ok).toBe(true);

    // 出目0（緑）→ 赤は外れ
    settleRoulette({ ...ctx.services, rng: scriptedRng([0]) } as Services, "roulette:s1", [...bets.values()]);

    expect(ctx.dailyRisk.dayFor("alice").netSigned).toBe(-1_000);
    expect(riskEvents(ctx).filter((row) => row.source_kind === "exposure_result")).toHaveLength(1);
    expect(exposureRows(ctx)).toEqual([]);
  });

  it("records a roulette win exactly once as a positive daily net", () => {
    const ctx = setup();
    fundHouse(ctx, 1_000_000);
    seedChips(ctx, "alice", 10_000);
    const bets = new Map();
    expect(acceptRouletteBet(ctx.services, "roulette:s1", bets, "alice", "red", 1_000, "op1").ok).toBe(true);

    // 出目1（赤）→ 的中で 2倍
    const spin = settleRoulette({ ...ctx.services, rng: scriptedRng([0.03]) } as Services, "roulette:s1", [...bets.values()]);
    expect(spin.results[0]?.won).toBe(true);

    expect(ctx.dailyRisk.dayFor("alice").netSigned).toBe(1_000);
    expect(riskEvents(ctx).filter((row) => row.source_kind === "exposure_result")).toHaveLength(1);
  });

  it("attributes a settlement that crosses midnight to the day the bet was accepted", () => {
    const ctx = setup();
    fundHouse(ctx, 1_000_000);
    seedChips(ctx, "alice", 10_000);
    const bets = new Map();
    acceptRouletteBet(ctx.services, "roulette:s1", bets, "alice", "red", 1_000, "op1");
    const acceptedDay = ctx.dailyRisk.dayFor("alice").dayKey;

    // 精算だけ翌日に回す
    const tomorrow = new DailyRisk(ctx.db, ctx.ledger, ctx.chipAssets, { now: () => TEST_NOW + 86_400 });
    const nextDayKey = tomorrow.dayFor("alice").dayKey;
    expect(nextDayKey).not.toBe(acceptedDay);

    settleRoulette({ ...ctx.services, rng: scriptedRng([0]) } as Services, "roulette:s1", [...bets.values()]);
    const events = riskEvents(ctx).filter((row) => row.source_kind === "exposure_result");
    expect(events).toHaveLength(1);
    expect(events[0]?.day_key).toBe(acceptedDay);
  });

  it("resizes a rebet instead of stacking it, in both directions", () => {
    const ctx = setup();
    fundHouse(ctx, 1_000_000);
    seedChips(ctx, "alice", 10_000);
    const scope = rouletteRiskScope("roulette:s1");
    const bets = new Map();

    acceptRouletteBet(ctx.services, "roulette:s1", bets, "alice", "red", 500, "op1");
    expect(ctx.dailyRisk.exposureOf(scope, "alice")?.maxPlayerLoss).toBe(500);

    acceptRouletteBet(ctx.services, "roulette:s1", bets, "alice", "red", 1_000, "op2");
    expect(ctx.dailyRisk.exposureOf(scope, "alice")?.maxPlayerLoss).toBe(1_000);
    expect(ctx.escrow.poolOf("roulette:s1")).toBe(1_000);

    acceptRouletteBet(ctx.services, "roulette:s1", bets, "alice", "red", 500, "op3");
    expect(ctx.dailyRisk.exposureOf(scope, "alice")?.maxPlayerLoss).toBe(500);
    expect(ctx.escrow.poolOf("roulette:s1")).toBe(500);
  });

  it("replays the same bet operation and rejects the same operation with a different payload", () => {
    const ctx = setup();
    fundHouse(ctx, 1_000_000);
    seedChips(ctx, "alice", 10_000);
    const scope = rouletteRiskScope("roulette:s1");
    const bets = new Map();

    expect(acceptRouletteBet(ctx.services, "roulette:s1", bets, "alice", "red", 1_000, "op1").ok).toBe(true);
    expect(acceptRouletteBet(ctx.services, "roulette:s1", bets, "alice", "red", 1_000, "op1").ok).toBe(true);
    expect(ctx.escrow.poolOf("roulette:s1")).toBe(1_000);
    expect(ctx.dailyRisk.exposureOf(scope, "alice")?.maxPlayerLoss).toBe(1_000);

    const conflict = acceptRouletteBet(ctx.services, "roulette:s1", bets, "alice", "black", 4_000, "op1");
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.reason).toBe("conflict");
    expect(ctx.escrow.poolOf("roulette:s1")).toBe(1_000);
    expect(ctx.dailyRisk.exposureOf(scope, "alice")?.maxPlayerLoss).toBe(1_000);
  });

  it("releases the exposure and the seat when the table is voided", () => {
    const ctx = setup();
    fundHouse(ctx, 1_000_000);
    seedChips(ctx, "alice", 10_000);
    const bets = new Map();
    acceptRouletteBet(ctx.services, "roulette:s1", bets, "alice", "red", 1_000, "op1");

    voidRouletteTable(ctx.services, "roulette:s1", [...bets.keys()]);

    expect(exposureRows(ctx)).toEqual([]);
    expect(hasTransientParticipation("alice")).toBe(false);
    expect(ctx.dailyRisk.dayFor("alice").netSigned).toBe(0);
    expect(riskEvents(ctx)).toEqual([]);
  });
});

describe("/勝負 legacy PvP goes through the PR23 risk gates", () => {
  it("passes at exactly 50% holdings and rejects one Land over without moving funds", () => {
    const ctx = setup(scriptedRng([0.5]), { dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 20_000);
    seedChips(ctx, "bob", 19_999);
    const before = fundsSnapshot(ctx, ["alice", "bob"]);

    expect(collectStakes(ctx.services, ["alice"], 10_000, "op:a", "sashi:1", "sashi").ok).toBe(true);

    const rejected = collectStakes(ctx.services, ["bob"], 10_000, "op:b", "sashi:2", "sashi");
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.reason).toBe("risk");
    expect(ctx.chips.balanceOf("bob")).toBe(before.chips.bob);
    expect(ctx.escrow.poolOf("sashi:2")).toBe(0);
    expect(hasTransientParticipation("bob")).toBe(false);
  });

  it("stops exactly at the remaining daily budget", () => {
    const ctx = setup(scriptedRng([0.5]), { dailyLossLimitBps: 3_000 });
    seedChips(ctx, "alice", 20_000);
    const remaining = ctx.dailyRisk.remainingLossBudget("alice");
    expect(remaining).toBe(6_000);

    expect(collectStakes(ctx.services, ["alice"], remaining, "op:ok", "sashi:1", "sashi").ok).toBe(true);
    voidPvpTable(ctx.services, "sashi:1");

    const over = collectStakes(ctx.services, ["alice"], remaining + 1, "op:over", "sashi:2", "sashi");
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe("risk");
  });

  it("records the actual winner and loser nets exactly once on settlement", () => {
    const ctx = setup(scriptedRng([0.5]), { dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 40_000);
    seedChips(ctx, "bob", 40_000);
    const bet = 10_000;
    expect(collectStakes(ctx.services, ["alice", "bob"], bet, "op:collect", "sashi:1", "sashi").ok).toBe(true);

    const aliceBefore = ctx.chips.balanceOf("alice");
    const bobBefore = ctx.chips.balanceOf("bob");
    const jackpotBefore = ctx.chips.balanceOf(JACKPOT_HOLDER);
    const { payout, houseCut } = settlePvp(ctx.services, ["alice"], bet * 2, "sashi:1:settle", "sashi:1");

    // 経済仕様は不変: 場代3%はJPプールへ、勝者は残り総取り
    expect(houseCut).toBe(Math.floor(bet * 2 * 0.03));
    expect(payout).toBe(bet * 2 - houseCut);
    expect(ctx.chips.balanceOf(JACKPOT_HOLDER)).toBe(jackpotBefore + houseCut);

    // 日次純損益は実際の残高変動と一致する
    const events = riskEvents(ctx).filter((row) => row.source_kind === "exposure_result");
    expect(events).toHaveLength(2);
    expect(events.find((row) => row.user_id === "alice")?.net_signed).toBe(ctx.chips.balanceOf("alice") - aliceBefore - bet);
    expect(events.find((row) => row.user_id === "bob")?.net_signed).toBe(ctx.chips.balanceOf("bob") - bobBefore - bet);
    expect(ctx.dailyRisk.dayFor("alice").netSigned).toBe(bet - houseCut);
    expect(ctx.dailyRisk.dayFor("bob").netSigned).toBe(-bet);
    expect(exposureRows(ctx)).toEqual([]);
    expect(hasTransientParticipation("alice")).toBe(false);
  });

  it("keeps a refund at a net of zero", () => {
    const ctx = setup(scriptedRng([0.5]), { dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 40_000);
    collectStakes(ctx.services, ["alice"], 10_000, "op:collect", "sashi:1", "sashi");
    refundAll(ctx.services, ["alice"], 10_000, "sashi:1:refund", "sashi:1");

    expect(ctx.chips.balanceOf("alice")).toBe(40_000);
    expect(ctx.dailyRisk.dayFor("alice").netSigned).toBe(0);
    expect(riskEvents(ctx)).toEqual([]);
    expect(hasTransientParticipation("alice")).toBe(false);
  });

  it("attributes a PvP settlement that crosses midnight to the collection day", () => {
    const ctx = setup(scriptedRng([0.5]), { dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 40_000);
    seedChips(ctx, "bob", 40_000);
    collectStakes(ctx.services, ["alice", "bob"], 10_000, "op:collect", "sashi:1", "sashi");
    const collectedDay = ctx.dailyRisk.dayFor("alice").dayKey;
    const tomorrow = new DailyRisk(ctx.db, ctx.ledger, ctx.chipAssets, { now: () => TEST_NOW + 86_400 });
    expect(tomorrow.dayFor("alice").dayKey).not.toBe(collectedDay);

    settlePvp(ctx.services, ["alice"], 20_000, "sashi:1:settle", "sashi:1");
    for (const row of riskEvents(ctx).filter((r) => r.source_kind === "exposure_result")) {
      expect(row.day_key).toBe(collectedDay);
    }
  });

  it("accumulates the stakes of an open recruitment table and settles them proportionally", () => {
    const ctx = setup(scriptedRng([0.5]), { dailyLossLimitBps: 10_000 });
    for (const u of ["alice", "bob", "carol"]) seedChips(ctx, u, 40_000);
    const scope = pvpRiskScope("chohan:1");

    expect(collectStakes(ctx.services, ["alice"], 3_000, "op:a", "chohan:1", "chohan-multi").ok).toBe(true);
    // 同じ卓での増し賭けは合算される（張り直しではない）
    expect(collectStakes(ctx.services, ["alice"], 2_000, "op:a2", "chohan:1", "chohan-multi").ok).toBe(true);
    expect(ctx.dailyRisk.exposureOf(scope, "alice")?.maxPlayerLoss).toBe(5_000);
    expect(collectStakes(ctx.services, ["bob"], 5_000, "op:b", "chohan:1", "chohan-multi").ok).toBe(true);

    const bobBefore = ctx.chips.balanceOf("bob");
    settleProportional(ctx.services, [{ userId: "alice", bet: 5_000 }], [{ userId: "bob", bet: 5_000 }], "chohan:1:settle", "chohan:1");

    const events = riskEvents(ctx).filter((row) => row.source_kind === "exposure_result");
    expect(events).toHaveLength(2);
    expect(events.find((row) => row.user_id === "bob")?.net_signed).toBe(ctx.chips.balanceOf("bob") - bobBefore - 5_000);
    expect(ctx.dailyRisk.dayFor("bob").netSigned).toBe(-5_000);
    expect(exposureRows(ctx)).toEqual([]);
  });

  it("leaves the first stake untouched when a later collection on the same table is rejected", () => {
    const ctx = setup(scriptedRng([0.5]), { dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 20_000);
    const scope = pvpRiskScope("chohan:1");
    expect(collectStakes(ctx.services, ["alice"], 5_000, "op:a", "chohan:1", "chohan-multi").ok).toBe(true);
    const before = fundsSnapshot(ctx, ["alice"]);

    // 合算すると所持50%（10,000）を超える増し賭けは断る
    const rejected = collectStakes(ctx.services, ["alice"], 6_000, "op:a2", "chohan:1", "chohan-multi");
    expect(rejected.ok).toBe(false);

    expect(fundsSnapshot(ctx, ["alice"])).toEqual(before);
    expect(ctx.dailyRisk.exposureOf(scope, "alice")?.maxPlayerLoss).toBe(5_000);
    // 1人目の預り金があるので席は手放さない
    expect(hasTransientParticipation("alice")).toBe(true);
  });

  it("does not leave one participant's funds behind when another is rejected", () => {
    const ctx = setup(scriptedRng([0.5]), { dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 40_000);
    seedChips(ctx, "bob", 100); // 所持が足りない
    const before = fundsSnapshot(ctx, ["alice", "bob"]);

    const result = collectStakes(ctx.services, ["alice", "bob"], 10_000, "op:collect", "sashi:1", "sashi");
    expect(result.ok).toBe(false);

    expect(fundsSnapshot(ctx, ["alice", "bob"])).toEqual(before);
    expect(ctx.escrow.poolOf("sashi:1")).toBe(0);
    expect(exposureRows(ctx)).toEqual([]);
    expect(hasTransientParticipation("alice")).toBe(false);
    expect(hasTransientParticipation("bob")).toBe(false);
  });
});

describe("simultaneous gambling is mutually exclusive in both directions", () => {
  it("blocks solo, roulette and legacy PvP while a persistent ranked table is live", () => {
    const ctx = setup(scriptedRng([0.5]), { dailyLossLimitBps: 10_000 });
    fundHouse(ctx, 1_000_000);
    seedChips(ctx, "alice", 40_000);
    liveRankedTableUsers.add("alice");

    expect(acquireSeat(ctx.services, "alice")).toBe(false);
    const roulette = acceptRouletteBet(ctx.services, "roulette:s1", new Map(), "alice", "red", 1_000, "op1");
    expect(roulette.ok).toBe(false);
    expect(collectStakes(ctx.services, ["alice"], 1_000, "op:a", "sashi:1", "sashi").ok).toBe(false);
    expect(ctx.escrow.poolOf("sashi:1")).toBe(0);
    expect(ctx.escrow.poolOf("roulette:s1")).toBe(0);
  });

  it("blocks roulette and legacy PvP while a solo seat is held, and releases on seat release", () => {
    const ctx = setup(scriptedRng([0.5]), { dailyLossLimitBps: 10_000 });
    fundHouse(ctx, 1_000_000);
    seedChips(ctx, "alice", 40_000);

    expect(acquireSeat(ctx.services, "alice")).toBe(true);
    expect(acquireSeat(ctx.services, "alice")).toBe(false);
    expect(acceptRouletteBet(ctx.services, "roulette:s1", new Map(), "alice", "red", 1_000, "op1").ok).toBe(false);
    expect(collectStakes(ctx.services, ["alice"], 1_000, "op:a", "sashi:1", "sashi").ok).toBe(false);

    releaseSeat("alice");
    expect(acceptRouletteBet(ctx.services, "roulette:s1", new Map(), "alice", "red", 1_000, "op1").ok).toBe(true);
  });

  it("blocks a solo seat and a ranked join while a roulette exposure is live", () => {
    const ctx = setup(scriptedRng([0.5]), { dailyLossLimitBps: 10_000 });
    fundHouse(ctx, 1_000_000);
    seedChips(ctx, "alice", 40_000);
    const bets = new Map();
    expect(acceptRouletteBet(ctx.services, "roulette:s1", bets, "alice", "red", 1_000, "op1").ok).toBe(true);

    expect(acquireSeat(ctx.services, "alice")).toBe(false);
    expect(collectStakes(ctx.services, ["alice"], 1_000, "op:a", "sashi:1", "sashi").ok).toBe(false);
    // 順位卓側は `isSoloSeatOccupied` フックでこれを読む
    expect(hasTransientParticipation("alice")).toBe(true);

    voidRouletteTable(ctx.services, "roulette:s1", [...bets.keys()]);
    expect(hasTransientParticipation("alice")).toBe(false);
    expect(acquireSeat(ctx.services, "alice")).toBe(true);
  });

  it("blocks a solo seat and a ranked join while a legacy PvP stake is live", () => {
    const ctx = setup(scriptedRng([0.5]), { dailyLossLimitBps: 10_000 });
    fundHouse(ctx, 1_000_000);
    seedChips(ctx, "alice", 40_000);
    expect(collectStakes(ctx.services, ["alice"], 5_000, "op:a", "sashi:1", "sashi").ok).toBe(true);

    expect(hasTransientParticipation("alice")).toBe(true);
    expect(acquireSeat(ctx.services, "alice")).toBe(false);
    expect(acceptRouletteBet(ctx.services, "roulette:s1", new Map(), "alice", "red", 1_000, "op1").ok).toBe(false);

    refundAll(ctx.services, ["alice"], 5_000, "sashi:1:refund", "sashi:1");
    expect(hasTransientParticipation("alice")).toBe(false);
    expect(acquireSeat(ctx.services, "alice")).toBe(true);
  });

  it("lets a user gamble again once the ranked table is no longer live", () => {
    const ctx = setup(scriptedRng([0.5]), { dailyLossLimitBps: 10_000 });
    fundHouse(ctx, 1_000_000);
    seedChips(ctx, "alice", 40_000);
    liveRankedTableUsers.add("alice");
    expect(acquireSeat(ctx.services, "alice")).toBe(false);

    liveRankedTableUsers.delete("alice");
    expect(acquireSeat(ctx.services, "alice")).toBe(true);
  });

  it("fails closed when the persistent ranked lookup itself is broken", () => {
    const ctx = setup();
    const broken = {
      ...ctx.services,
      persistentTables: {
        participantHasLiveTable: () => {
          throw new Error("db unavailable");
        },
      },
    } as unknown as Services;
    expect(acquireSeat(broken, "alice")).toBe(false);
    expect(acceptRouletteBet(broken, "roulette:s1", new Map(), "alice", "red", 1_000, "op1").ok).toBe(false);
  });
});

describe("solo settlement stays bound to the start taken by validateBet", () => {
  it("records the slots paid spin against the interaction's solo start, not its settlement key", () => {
    const ctx = setup(scriptedRng([0.1, 0.45, 0.9]), { dailyLossLimitBps: 10_000 });
    fundHouse(ctx, 1_000_000);
    seedChips(ctx, "alice", 40_000);
    // validateBet 相当: 開始枠は interaction.id で取る
    ctx.dailyRisk.authorizeSoloStart({ userId: "alice", operationId: "interaction-1", game: "スロット", bet: 1_000, maxPlayerLoss: 1_000 });

    // 精算の鍵は `<interaction.id>:paid`。枠の鍵と違っても同じ開始枠へ帰属する
    const spin = spinPaid(ctx.services, "alice", 1_000, "interaction-1");

    const events = riskEvents(ctx).filter((row) => row.source_kind === "solo_result");
    expect(events).toHaveLength(1);
    expect(events[0]?.event_key).toBe("solo_result:interaction-1");
    expect(events[0]?.net_signed).toBe(spin.settled?.net);
    expect(ctx.dailyRisk.dayFor("alice").netSigned).toBe(spin.settled?.net);
  });

  it("fails closed and moves no money when a solo game settles without a start", () => {
    const ctx = setup(scriptedRng([0.1, 0.2, 0.3]), { dailyLossLimitBps: 10_000 });
    fundHouse(ctx, 1_000_000);
    seedChips(ctx, "alice", 40_000);
    const before = fundsSnapshot(ctx, ["alice"]);

    expect(() => spinPaid(ctx.services, "alice", 1_000, "never-authorized")).toThrow();

    expect(fundsSnapshot(ctx, ["alice"])).toEqual(before);
    expect(riskEvents(ctx)).toEqual([]);
  });
});

describe("a live table exposure never crosses the daily boundary", () => {
  it("refuses a roulette rebet made after midnight and leaves the original bet intact", () => {
    const ctx = setup(scriptedRng([0.5]), { dailyLossLimitBps: 10_000 });
    fundHouse(ctx, 1_000_000);
    seedChips(ctx, "alice", 40_000);
    const scope = rouletteRiskScope("roulette:s1");
    const bets = new Map();
    expect(acceptRouletteBet(ctx.services, "roulette:s1", bets, "alice", "red", 1_000, "op1").ok).toBe(true);
    const acceptedDay = ctx.dailyRisk.exposureOf(scope, "alice")?.dayKey;
    const before = fundsSnapshot(ctx, ["alice"]);

    const rolled = acceptRouletteBet(ctx.tomorrowServices, "roulette:s1", bets, "alice", "black", 2_000, "op2");
    expect(rolled.ok).toBe(false);
    if (!rolled.ok) expect(rolled.reason).toBe("risk");

    expect(fundsSnapshot(ctx, ["alice"])).toEqual(before);
    expect(ctx.escrow.poolOf("roulette:s1")).toBe(1_000);
    expect(ctx.dailyRisk.exposureOf(scope, "alice")).toMatchObject({ maxPlayerLoss: 1_000, dayKey: acceptedDay });
    expect(bets.get("alice")).toEqual({ userId: "alice", type: "red", amount: 1_000 });
  });

  it("refuses a legacy PvP top-up made after midnight and leaves the first stake intact", () => {
    const ctx = setup(scriptedRng([0.5]), { dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 40_000);
    const scope = pvpRiskScope("chohan:1");
    expect(collectStakes(ctx.services, ["alice"], 3_000, "op:a", "chohan:1", "chohan-multi").ok).toBe(true);
    const before = fundsSnapshot(ctx, ["alice"]);

    const rolled = collectStakes(ctx.tomorrowServices, ["alice"], 1_000, "op:a2", "chohan:1", "chohan-multi");
    expect(rolled.ok).toBe(false);
    if (!rolled.ok) expect(rolled.reason).toBe("risk");

    expect(fundsSnapshot(ctx, ["alice"])).toEqual(before);
    expect(ctx.escrow.poolOf("chohan:1")).toBe(3_000);
    expect(ctx.dailyRisk.exposureOf(scope, "alice")?.maxPlayerLoss).toBe(3_000);
    // 預り金が残っているので席も手放していない
    expect(hasTransientParticipation("alice")).toBe(true);
  });
});
