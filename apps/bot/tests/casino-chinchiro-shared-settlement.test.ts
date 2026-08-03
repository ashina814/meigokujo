import { describe, expect, it } from "vitest";
import {
  Casino,
  ChipTx,
  Escrow,
  EtherExchange,
  EventLog,
  HOUSE_HOLDER,
  HouseReservations,
  Items,
  Ledger,
  openDb,
  registerDefaultTxTypes,
  scriptedRng,
} from "@meigokujo/core";
import type { Services } from "../src/services.js";
import { settleChinchiroRound } from "../src/casino/chinchiro.js";

registerDefaultTxTypes();

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const ether = new EtherExchange(db, ledger, events, { baseRate: 1, chipTx });
  const items = new Items(db);
  const reservations = new HouseReservations(db, ether, events);
  const casino = new Casino(db, ether, events, { items, reservations, fukuScale: 10 });
  const escrow = new Escrow(db, ether, events);
  const services = {
    db,
    ledger,
    events,
    chipTx,
    ether,
    chips: ether,
    items,
    reservations,
    casino,
    escrow,
    rng: scriptedRng([0.5]),
  } as unknown as Services;
  return { db, chipTx, ether, items, reservations, casino, escrow, services };
}

function seedBalance(ctx: ReturnType<typeof setup>, holder: string, amount: number): void {
  ctx.db.prepare(
    "INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET amount=excluded.amount",
  ).run(holder, amount);
}

function prehold(ctx: ReturnType<typeof setup>, operationId: string, amount: number): string {
  const sessionId = `chinchiro:prehold:u1:${operationId}`;
  expect(ctx.escrow.hold(sessionId, "u1", amount, "チンチロ", `hold:${operationId}`)).toBe(true);
  ctx.db.prepare(
    `INSERT INTO casino_chinchiro_preholds
     (session_id,user_id,bet,amount,status,created_at)
     VALUES (?, 'u1', 1000, ?, 'preheld', 1)`,
  ).run(sessionId, amount);
  return sessionId;
}

describe("PR11 チンチロ事前預託と共通精算", () => {
  it("勝利時も連鎖・福の重み・戦績を共通精算どおり適用し、再実行で二重精算しない", () => {
    const ctx = setup();
    seedBalance(ctx, HOUSE_HOLDER, 1_000_000);
    seedBalance(ctx, "u1", 250_000);
    ctx.db.prepare(
      `INSERT INTO casino_stats
       (user_id,current_win_streak,best_win_streak,updated_at)
       VALUES ('u1',1,1,1)`,
    ).run();
    const session = prehold(ctx, "win", 2_000);

    const first = settleChinchiroRound(ctx.services, "u1", 1_000, 1, "win");
    expect(first.branch).toBe("win");
    expect(first.settled.chainStreak).toBe(2);
    expect(first.settled.chainBonus).toBeGreaterThan(0);
    expect(first.settled.fukuTax).toBeGreaterThan(0);
    expect(ctx.escrow.poolOf(session)).toBe(0);
    expect(ctx.ether.balanceOf(ctx.escrow.holderId(session))).toBe(0);
    expect(ctx.casino.stats("u1")).toMatchObject({ games: 1, wins: 1, current_win_streak: 2 });

    const balance = ctx.ether.balanceOf("u1");
    const second = settleChinchiroRound(ctx.services, "u1", 1_000, 1, "win");
    expect(second).toEqual(first);
    expect(ctx.ether.balanceOf("u1")).toBe(balance);
    expect(ctx.casino.stats("u1").games).toBe(1);
    expect(ctx.chipTx.listByGroup("chinchiro:round:u1:win").map((row) => row.reason)).toEqual(
      expect.arrayContaining(["賭け金", "事前預託残額返還", "配当", "連鎖ボーナス"]),
    );
    ctx.db.close();
  });

  it("倍付け負けでもお守りを共通経路で消費し、実損失を2倍徴収額から計算する", () => {
    const ctx = setup();
    seedBalance(ctx, HOUSE_HOLDER, 1_000_000);
    seedBalance(ctx, "u1", 2_000);
    ctx.items.grant("u1", "hoken");
    expect(ctx.items.arm("u1", "hoken")).toEqual({ ok: true });
    const session = prehold(ctx, "double-loss", 2_000);

    const result = settleChinchiroRound(ctx.services, "u1", 1_000, -2, "double-loss");
    expect(result.branch).toBe("double_loss");
    expect(result.amuletNote).toContain("保険符");
    expect(result.settled.payout).toBe(500);
    expect(result.settled.net).toBe(-1_500);
    expect(ctx.items.isArmed("u1", "hoken")).toBe(false);
    expect(ctx.casino.stats("u1")).toMatchObject({ games: 1, losses: 1, total_wagered: 1_000, total_lost: 1_500 });
    expect(ctx.escrow.poolOf(session)).toBe(0);
    expect(ctx.ether.balanceOf("u1")).toBe(500);
    ctx.db.close();
  });

  it("帳簿不一致時はお守り・予約・預託を一切変えない", () => {
    const ctx = setup();
    seedBalance(ctx, HOUSE_HOLDER, 1_000_000);
    seedBalance(ctx, "u1", 2_001);
    ctx.items.grant("u1", "hoken");
    expect(ctx.items.arm("u1", "hoken")).toEqual({ ok: true });
    const session = prehold(ctx, "broken", 2_000);
    ctx.ether.runGroup({ groupKey: "damage", kind: "test", actorId: "test" }, () => {
      ctx.ether.transfer("u1", ctx.escrow.holderId(session), 1, { reason: "破損を模す" });
    });

    expect(() => settleChinchiroRound(ctx.services, "u1", 1_000, -2, "broken")).toThrow("帳簿不一致");
    expect(ctx.items.isArmed("u1", "hoken")).toBe(true);
    expect(ctx.escrow.poolOf(session)).toBe(2_000);
    expect(ctx.ether.balanceOf(ctx.escrow.holderId(session))).toBe(2_001);
    expect(ctx.casino.stats("u1").games).toBe(0);
    ctx.db.close();
  });
});
