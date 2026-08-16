import { beforeEach, describe, expect, it } from "vitest";
import {
  Casino,
  CasinoChipAssets,
  CasinoChipFlow,
  ChipLedger,
  ChipTx,
  CHIP_ESCROW,
  DailyRisk,
  Escrow,
  EventLog,
  FORMAL_OPENING_VERSION,
  HOUSE_HOLDER,
  HouseReservations,
  Items,
  JACKPOT_HOLDER,
  KEIBA_HOUSE_RATE,
  Ledger,
  TREASURY,
  openDb,
  registerDefaultTxTypes,
  scriptedRng,
} from "@meigokujo/core";
import type { Services } from "../src/services.js";
import { acceptKeibaBet, keibaRiskScope, settleKeibaRace, voidKeibaRace, type Bet } from "../src/casino/keiba.js";
import { acquireSeat } from "../src/casino/common.js";
import { hasTransientParticipation, resetTransientParticipationForTesting } from "../src/casino/participation.js";

registerDefaultTxTypes();

/**
 * PR23 追補ブロッカー: `/競馬` も現役のマモン賭博入口なので、正本 §15 の安全上限を通す。
 *
 * 見るのは接続だけで、**配当・場代率・JPの行き先・出走馬・レースルール・受付時間は
 * 一切変えていない**（このファイルでも既存の配当計算をそのまま再現して照合する）。
 */


/** 当日枠の基準時刻。種まき取引より後の日を「今日」にする */
const TEST_NOW = Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60;

function setup(options: { dailyLossLimitBps?: number } = {}) {
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
    rng: scriptedRng([0.5]),
  } as unknown as Services;
  // 翌日から同じ卓を触りにいくための窓（日界跨ぎの確認用）
  const tomorrowRisk = new DailyRisk(db, ledger, chipAssets, {
    now: () => TEST_NOW + 86_400,
    openingPhase: () => chipTx.openingPhase(),
    dailyLossLimitBps: () => options.dailyLossLimitBps ?? 3_000,
  });
  const tomorrowServices = { ...services, dailyRisk: tomorrowRisk } as unknown as Services;
  return { db, ledger, chips, chipAssets, dailyRisk, casino, escrow, services, tomorrowServices };
}

type Ctx = ReturnType<typeof setup>;

function seedChips(ctx: Ctx, userId: string, amount: number): void {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  ctx.ledger.transfer({ from: TREASURY, to: `user:${userId}`, amount, type: "initial", actor: "test", idempotencyKey: `seed:${userId}:${amount}` });
  ctx.chips.deposit(userId, amount, `deposit:${userId}:${amount}`);
}

function fundsSnapshot(ctx: Ctx, userIds: string[]) {
  return {
    chips: Object.fromEntries(userIds.map((u) => [u, ctx.chips.balanceOf(u)])),
    land: Object.fromEntries(userIds.map((u) => [u, ctx.ledger.balanceOf(`user:${u}`)])),
    free: Object.fromEntries(userIds.map((u) => [u, ctx.chipAssets.freeChips(u)])),
    jackpot: ctx.chips.balanceOf(JACKPOT_HOLDER),
    house: ctx.chips.balanceOf(HOUSE_HOLDER),
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

function exhaustDailyBudget(ctx: Ctx, userId: string): void {
  const remaining = ctx.dailyRisk.remainingLossBudget(userId);
  ctx.dailyRisk.authorizeSoloStart({ userId, operationId: `drain:${userId}`, game: "slots", bet: remaining, maxPlayerLoss: remaining });
  ctx.dailyRisk.recordSoloResult({ userId, operationId: `drain:${userId}`, netSigned: -remaining });
}

/**
 * 本番 `runRaceAndSettle()` の分配計算をそのまま再現する（配当・場代の回帰確認用）。
 * ここを本番と同じ式に保つことで、「リスク接続で配当が変わっていない」ことを直接見られる。
 */
function keibaDistributions(allBets: Bet[], winnerId: number, placeIds: Set<number>) {
  const winBets = allBets.filter((b) => b.type === "win");
  const placeBets = allBets.filter((b) => b.type === "place");
  const winPool = winBets.reduce((s, b) => s + b.amount, 0);
  const placePool = placeBets.reduce((s, b) => s + b.amount, 0);
  const winHit = winBets.filter((b) => b.horseId === winnerId);
  const placeHit = placeBets.filter((b) => placeIds.has(b.horseId));
  const winHitTotal = winHit.reduce((s, b) => s + b.amount, 0);
  const placeHitTotal = placeHit.reduce((s, b) => s + b.amount, 0);
  const winCut = Math.floor(winPool * KEIBA_HOUSE_RATE);
  const placeCut = Math.floor(placePool * KEIBA_HOUSE_RATE);
  const winDistributable = winPool - winCut;
  const placeDistributable = placePool - placeCut;

  const distributions: Array<{ to: string; amount: number; reason: string }> = [];
  if (winCut > 0) distributions.push({ to: JACKPOT_HOLDER, amount: winCut, reason: "単勝場代" });
  if (placeCut > 0) distributions.push({ to: JACKPOT_HOLDER, amount: placeCut, reason: "複勝場代" });
  if (winHit.length > 0 && winHitTotal > 0) {
    let remaining = winDistributable;
    for (let i = 0; i < winHit.length; i++) {
      const b = winHit[i]!;
      const payout = i === winHit.length - 1 ? remaining : Math.floor((winDistributable * b.amount) / winHitTotal);
      if (payout > 0) distributions.push({ to: b.userId, amount: payout, reason: "単勝配当" });
      remaining -= payout;
    }
  } else if (winDistributable > 0) {
    distributions.push({ to: JACKPOT_HOLDER, amount: winDistributable, reason: "単勝キャリーオーバー" });
  }
  if (placeHit.length > 0 && placeHitTotal > 0) {
    let remaining = placeDistributable;
    for (let i = 0; i < placeHit.length; i++) {
      const b = placeHit[i]!;
      const payout = i === placeHit.length - 1 ? remaining : Math.floor((placeDistributable * b.amount) / placeHitTotal);
      if (payout > 0) distributions.push({ to: b.userId, amount: payout, reason: "複勝配当" });
      remaining -= payout;
    }
  } else if (placeDistributable > 0) {
    distributions.push({ to: JACKPOT_HOLDER, amount: placeDistributable, reason: "複勝キャリーオーバー" });
  }
  return { distributions, winCut, placeCut, winDistributable, placeDistributable };
}

function allBetsOf(bets: Map<string, Bet[]>): Bet[] {
  return [...bets.values()].flat();
}

beforeEach(() => {
  resetTransientParticipationForTesting();
});

describe("keiba bets go through the PR23 risk gates", () => {
  it("rejects the first bet once the daily cap is reached and moves no funds at all", () => {
    const ctx = setup();
    seedChips(ctx, "alice", 10_000);
    exhaustDailyBudget(ctx, "alice");
    const before = fundsSnapshot(ctx, ["alice"]);

    const r = acceptKeibaBet(ctx.services, "keiba:s1", new Map(), "alice", 1, "win", 100, "op1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("risk");

    expect(fundsSnapshot(ctx, ["alice"])).toEqual(before);
    expect(ctx.escrow.poolOf("keiba:s1")).toBe(0);
    expect(exposureRows(ctx)).toEqual([]);
    expect(hasTransientParticipation("alice")).toBe(false);
  });

  it("evaluates the 50% holdings gate on the cumulative race stake, not per bet", () => {
    const ctx = setup({ dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 10_000);
    const bets = new Map<string, Bet[]>();
    const scope = keibaRiskScope("keiba:s1");

    expect(acceptKeibaBet(ctx.services, "keiba:s1", bets, "alice", 1, "win", 3_000, "op1").ok).toBe(true);
    // 3,000 + 2,000 = 5,000 はちょうど50%なので通る
    expect(acceptKeibaBet(ctx.services, "keiba:s1", bets, "alice", 2, "place", 2_000, "op2").ok).toBe(true);
    expect(ctx.dailyRisk.exposureOf(scope, "alice")?.maxPlayerLoss).toBe(5_000);

    const before = fundsSnapshot(ctx, ["alice"]);
    // さらに 1 Ld 上乗せすると 5,001 になり、単体では小さくても合計で断られる
    const over = acceptKeibaBet(ctx.services, "keiba:s1", bets, "alice", 3, "win", 1, "op3");
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe("risk");

    expect(fundsSnapshot(ctx, ["alice"])).toEqual(before);
    expect(ctx.dailyRisk.exposureOf(scope, "alice")?.maxPlayerLoss).toBe(5_000);
    expect(ctx.escrow.poolOf("keiba:s1")).toBe(5_000);
    expect(allBetsOf(bets)).toHaveLength(2);
    // 既に成立した口があるので席は手放さない
    expect(hasTransientParticipation("alice")).toBe(true);
  });

  it("accumulates several bets into a single exposure row", () => {
    const ctx = setup({ dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 40_000);
    const bets = new Map<string, Bet[]>();
    for (const [i, amount] of [1_000, 2_000, 500].entries()) {
      expect(acceptKeibaBet(ctx.services, "keiba:s1", bets, "alice", 1, "win", amount, `op${i}`).ok).toBe(true);
    }
    expect(exposureRows(ctx)).toEqual([{ scope_key: keibaRiskScope("keiba:s1"), user_id: "alice", max_player_loss: 3_500 }]);
    expect(ctx.escrow.poolOf("keiba:s1")).toBe(3_500);
  });

  it("does not double-count a replayed bet operation in money, risk or the in-memory bet list", () => {
    const ctx = setup({ dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 40_000);
    const bets = new Map<string, Bet[]>();
    const scope = keibaRiskScope("keiba:s1");

    expect(acceptKeibaBet(ctx.services, "keiba:s1", bets, "alice", 1, "win", 1_000, "op1").ok).toBe(true);
    expect(allBetsOf(bets)).toHaveLength(1);
    expect(ctx.escrow.poolOf("keiba:s1")).toBe(1_000);
    expect(ctx.dailyRisk.exposureOf(scope, "alice")?.maxPlayerLoss).toBe(1_000);

    // 同じ操作の replay: 資金・露出はもちろん、賭け一覧も増やさない。
    // 増やすと配当プールが実際の預り金を上回り、精算が合わなくなる
    expect(acceptKeibaBet(ctx.services, "keiba:s1", bets, "alice", 1, "win", 1_000, "op1").ok).toBe(true);
    expect(allBetsOf(bets)).toHaveLength(1);
    expect(ctx.escrow.poolOf("keiba:s1")).toBe(1_000);
    expect(ctx.dailyRisk.exposureOf(scope, "alice")?.maxPlayerLoss).toBe(1_000);

    // 同じ操作を別の内容で呼ぶ取り違えは conflict。どれも変わらない
    const conflict = acceptKeibaBet(ctx.services, "keiba:s1", bets, "alice", 4, "place", 9_000, "op1");
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.reason).toBe("conflict");
    expect(allBetsOf(bets)).toHaveLength(1);
    expect(allBetsOf(bets)[0]).toMatchObject({ horseId: 1, type: "win", amount: 1_000 });
    expect(ctx.escrow.poolOf("keiba:s1")).toBe(1_000);
    expect(ctx.dailyRisk.exposureOf(scope, "alice")?.maxPlayerLoss).toBe(1_000);

    // この状態から精算しても、分配合計と預り金が一致する（＝プールが水増しされていない）
    const plan = keibaDistributions(allBetsOf(bets), 1, new Set([1, 2, 3]));
    expect(plan.distributions.reduce((sum, d) => sum + d.amount, 0)).toBe(ctx.escrow.poolOf("keiba:s1"));
    expect(() => settleKeibaRace(ctx.services, "keiba:s1", plan.distributions)).not.toThrow();
    expect(ctx.escrow.poolOf("keiba:s1")).toBe(0);
  });

  it("refuses to carry a race exposure across the daily boundary", () => {
    const ctx = setup({ dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 40_000);
    const bets = new Map<string, Bet[]>();
    expect(acceptKeibaBet(ctx.services, "keiba:s1", bets, "alice", 1, "win", 3_000, "op1").ok).toBe(true);
    const before = fundsSnapshot(ctx, ["alice"]);

    // 日付が変わったあとの追加の口は断る（前日に取った枠ごと翌日へ移せてしまうため）
    const rolled = acceptKeibaBet(ctx.tomorrowServices, "keiba:s1", bets, "alice", 2, "place", 1_000, "op2");
    expect(rolled.ok).toBe(false);
    if (!rolled.ok) expect(rolled.reason).toBe("risk");

    expect(fundsSnapshot(ctx, ["alice"])).toEqual(before);
    expect(allBetsOf(bets)).toHaveLength(1);
    expect(ctx.escrow.poolOf("keiba:s1")).toBe(3_000);
    expect(exposureRows(ctx)).toEqual([{ scope_key: keibaRiskScope("keiba:s1"), user_id: "alice", max_player_loss: 3_000 }]);
  });

  it("records the winner and loser aggregate nets exactly once, with payouts unchanged", () => {
    const ctx = setup({ dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 40_000);
    seedChips(ctx, "bob", 40_000);
    const bets = new Map<string, Bet[]>();
    // alice は1番の単勝、bob は2番の単勝
    expect(acceptKeibaBet(ctx.services, "keiba:s1", bets, "alice", 1, "win", 5_000, "op1").ok).toBe(true);
    expect(acceptKeibaBet(ctx.services, "keiba:s1", bets, "bob", 2, "win", 5_000, "op2").ok).toBe(true);

    const aliceBefore = ctx.chips.balanceOf("alice");
    const bobBefore = ctx.chips.balanceOf("bob");
    const jackpotBefore = ctx.chips.balanceOf(JACKPOT_HOLDER);
    const plan = keibaDistributions(allBetsOf(bets), 1, new Set([1, 2, 3]));
    settleKeibaRace(ctx.services, "keiba:s1", plan.distributions);

    // 経済仕様は不変: 場代10%はJPプールへ、残りが的中者へ
    expect(plan.winCut).toBe(Math.floor(10_000 * KEIBA_HOUSE_RATE));
    expect(ctx.chips.balanceOf(JACKPOT_HOLDER)).toBe(jackpotBefore + plan.winCut);
    expect(ctx.chips.balanceOf("alice")).toBe(aliceBefore + plan.winDistributable);

    const events = riskEvents(ctx).filter((row) => row.source_kind === "exposure_result");
    expect(events).toHaveLength(2);
    // 実残高変動と一致（場代は「受取が出した額を下回る」形で既に入っている）
    expect(events.find((row) => row.user_id === "alice")?.net_signed).toBe(plan.winDistributable - 5_000);
    expect(events.find((row) => row.user_id === "bob")?.net_signed).toBe(-5_000);
    expect(ctx.chips.balanceOf("bob")).toBe(bobBefore);
    expect(ctx.dailyRisk.dayFor("bob").netSigned).toBe(-5_000);
    expect(exposureRows(ctx)).toEqual([]);
    expect(hasTransientParticipation("alice")).toBe(false);
    expect(hasTransientParticipation("bob")).toBe(false);
  });

  it("aggregates mixed win and place bets of one user into a single exact net", () => {
    const ctx = setup({ dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 40_000);
    seedChips(ctx, "bob", 40_000);
    const bets = new Map<string, Bet[]>();
    // alice: 外れの単勝 + 的中の複勝 / bob: 的中の単勝
    expect(acceptKeibaBet(ctx.services, "keiba:s1", bets, "alice", 5, "win", 2_000, "op1").ok).toBe(true);
    expect(acceptKeibaBet(ctx.services, "keiba:s1", bets, "alice", 2, "place", 3_000, "op2").ok).toBe(true);
    expect(acceptKeibaBet(ctx.services, "keiba:s1", bets, "bob", 1, "win", 4_000, "op3").ok).toBe(true);

    const aliceBefore = ctx.chips.balanceOf("alice");
    const plan = keibaDistributions(allBetsOf(bets), 1, new Set([1, 2, 3]));
    settleKeibaRace(ctx.services, "keiba:s1", plan.distributions);

    const aliceNet = ctx.chips.balanceOf("alice") - aliceBefore - 5_000;
    const events = riskEvents(ctx).filter((row) => row.source_kind === "exposure_result");
    expect(events.find((row) => row.user_id === "alice")?.net_signed).toBe(aliceNet);
    expect(ctx.dailyRisk.dayFor("alice").netSigned).toBe(aliceNet);
    // 複勝的中ぶんを受け取りつつ単勝を落としているので、合計は「受取 − 出した5,000」
    expect(aliceNet).toBe(plan.placeDistributable - 5_000);
  });

  it("keeps a full refund at a daily net of zero and releases everything", () => {
    const ctx = setup({ dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 40_000);
    seedChips(ctx, "bob", 40_000);
    const bets = new Map<string, Bet[]>();
    acceptKeibaBet(ctx.services, "keiba:s1", bets, "alice", 1, "win", 3_000, "op1");
    acceptKeibaBet(ctx.services, "keiba:s1", bets, "bob", 2, "place", 2_000, "op2");

    voidKeibaRace(ctx.services, "keiba:s1");

    expect(ctx.chips.balanceOf("alice")).toBe(40_000);
    expect(ctx.chips.balanceOf("bob")).toBe(40_000);
    expect(ctx.dailyRisk.dayFor("alice").netSigned).toBe(0);
    expect(ctx.dailyRisk.dayFor("bob").netSigned).toBe(0);
    expect(riskEvents(ctx)).toEqual([]);
    expect(exposureRows(ctx)).toEqual([]);
    expect(hasTransientParticipation("alice")).toBe(false);
    expect(hasTransientParticipation("bob")).toBe(false);
  });

  it("rolls the race settlement back when the risk record cannot be written", () => {
    const ctx = setup({ dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 40_000);
    const bets = new Map<string, Bet[]>();
    acceptKeibaBet(ctx.services, "keiba:s1", bets, "alice", 1, "win", 5_000, "op1");
    // 露出が消えた状態（＝枠の裏付けがない）で精算しにいく
    ctx.dailyRisk.releaseExposureScope(keibaRiskScope("keiba:s1"));
    const before = fundsSnapshot(ctx, ["alice"]);
    const plan = keibaDistributions(allBetsOf(bets), 1, new Set([1, 2, 3]));

    expect(() => settleKeibaRace(ctx.services, "keiba:s1", plan.distributions)).toThrow();

    // 精算も場代も巻き戻り、預り金はエスクローに残っている
    expect(fundsSnapshot(ctx, ["alice"])).toEqual(before);
    expect(ctx.escrow.poolOf("keiba:s1")).toBe(5_000);
    expect(riskEvents(ctx)).toEqual([]);
  });

  it("attributes a race settled within one lobby to the day the bets were accepted", () => {
    // 受付は60秒なので、実運用では1レースの全ベットが同じ日に収まる前提を固定する
    const ctx = setup({ dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 40_000);
    const bets = new Map<string, Bet[]>();
    acceptKeibaBet(ctx.services, "keiba:s1", bets, "alice", 1, "win", 2_000, "op1");
    acceptKeibaBet(ctx.services, "keiba:s1", bets, "alice", 2, "place", 1_000, "op2");
    const acceptedDay = ctx.dailyRisk.dayFor("alice").dayKey;

    const plan = keibaDistributions(allBetsOf(bets), 1, new Set([1, 2, 3]));
    settleKeibaRace(ctx.services, "keiba:s1", plan.distributions);

    const events = riskEvents(ctx).filter((row) => row.source_kind === "exposure_result");
    expect(events).toHaveLength(1);
    expect(events[0]?.day_key).toBe(acceptedDay);
  });
});

describe("keiba participates in the unified exclusion model", () => {
  it("rejects a keiba bet while a solo seat is held, and the reverse", () => {
    const ctx = setup({ dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 40_000);

    expect(acquireSeat("alice")).toBe(true);
    expect(acceptKeibaBet(ctx.services, "keiba:s1", new Map(), "alice", 1, "win", 1_000, "op1").ok).toBe(false);

    resetTransientParticipationForTesting();
    const bets = new Map<string, Bet[]>();
    expect(acceptKeibaBet(ctx.services, "keiba:s1", bets, "alice", 1, "win", 1_000, "op1").ok).toBe(true);
    // 競馬に着いている間はソロ席も順位卓（isSoloSeatOccupied 経由）も取れない
    expect(acquireSeat("alice")).toBe(false);
    expect(hasTransientParticipation("alice")).toBe(true);

    voidKeibaRace(ctx.services, "keiba:s1");
    expect(hasTransientParticipation("alice")).toBe(false);
    expect(acquireSeat("alice")).toBe(true);
  });

  it("fails closed when the persistent ranked lookup is broken", () => {
    const ctx = setup();
    const broken = {
      ...ctx.services,
      persistentTables: {
        participantHasLiveTable: () => {
          throw new Error("db unavailable");
        },
      },
    } as unknown as Services;
    expect(acceptKeibaBet(broken, "keiba:s1", new Map(), "alice", 1, "win", 1_000, "op1").ok).toBe(false);
  });
});
