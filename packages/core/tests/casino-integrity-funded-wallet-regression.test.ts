import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { ChipLedger, HOUSE_HOLDER } from "../src/casino/exchange.js";
import { Escrow } from "../src/casino/escrow.js";
import { ChipTx } from "../src/casino/chip-tx.js";
import { CasinoChipFlow } from "../src/casino/chip-flow.js";
import { CasinoIntegrity } from "../src/casino/integrity.js";
import { openFormally } from "./helpers/chip-ctx.js";

registerDefaultTxTypes();

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  const escrow = new Escrow(db, chips, events);
  const integrity = new CasinoIntegrity(db, ledger, chips, escrow);
  const chipFlow = new CasinoChipFlow(db, chips, events);
  openFormally(chipTx, ledger);
  return { db, ledger, events, chipTx, chips, escrow, integrity, chipFlow };
}

type Ctx = ReturnType<typeof setup>;

function fundUser(ctx: Ctx, userId: string, land: number): void {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  ctx.ledger.transfer({
    from: TREASURY,
    to: `user:${userId}`,
    amount: land,
    type: "adjust",
    actor: "test",
    approvedBy: "test",
    idempotencyKey: `seed:${userId}:${land}`,
  });
}

function fundSystem(ctx: Ctx, accountId: string, land: number, key: string): void {
  ctx.ledger.ensureAccount(accountId, "system");
  ctx.ledger.transfer({
    from: TREASURY,
    to: accountId,
    amount: land,
    type: "adjust",
    actor: "test",
    approvedBy: "test",
    idempotencyKey: key,
  });
}

const checkB = (ctx: Ctx) => ctx.integrity.checkB();
const notes = (ctx: Ctx) => checkB(ctx).mismatches.map((m) => m.note);

describe("CasinoIntegrity funded wallet regression", () => {
  it("VIP と通常板の outer group 内で起きる自動預入を説明できる", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 30_000);
    fundUser(ctx, "bob", 2_000);

    ctx.chips.runGroup({ groupKey: "vip:alice:op1", kind: "vip", actorId: "alice" }, () => {
      ctx.chipFlow.ensureFreeChips("alice", 27_120, "vipautofund1");
      ctx.chips.transfer("alice", HOUSE_HOLDER, 27_120, { reason: "VIP加入" });
    });

    ctx.chips.runGroup({ groupKey: "market:bet:1:bob:op1", kind: "market_bet", actorId: "bob" }, () => {
      ctx.chipFlow.ensureFreeChips("bob", 620, "marketautofund1");
      ctx.chips.transfer("bob", "escrow:market:1", 620, {
        reason: "板への賭け",
        game: "market",
        sessionId: "market:1",
      });
    });

    expect(checkB(ctx).ok).toBe(true);
    ctx.db.close();
  });

  it("funded holdAll の system:escrow wrapper は参加者の正規預託明細があれば説明できる", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 2_000);
    fundUser(ctx, "bob", 2_000);

    const groupKey = "wallet:escrow:hold_all:pvpopen:test-session:collect";
    ctx.chips.runGroup({ groupKey, kind: "table_hold", actorId: "system:escrow" }, () => {
      ctx.chipFlow.ensureFreeChips("alice", 2_000, "walletautofund1001");
      ctx.chipFlow.ensureFreeChips("bob", 2_000, "walletautofund1002");
      expect(ctx.escrow.holdAll("pvpopen:test-session", ["alice", "bob"], 2_000, "pvp", "collect")).toBe(true);
    });

    expect(checkB(ctx).ok).toBe(true);
    ctx.db.close();
  });

  it("system:escrow を名乗るだけの table_hold wrapper は許可しない", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 2_000);

    ctx.chips.runGroup({ groupKey: "forged:hold_all:pvpopen:test-session:collect", kind: "table_hold", actorId: "system:escrow" }, () => {
      ctx.chipFlow.ensureFreeChips("alice", 2_000, "walletautofund2001");
      ctx.chips.transfer("alice", "escrow:session:pvpopen:test-session", 2_000, {
        reason: "卓への預託",
        game: "pvp",
        sessionId: "pvpopen:test-session",
      });
    });

    expect(notes(ctx)).toContain("group_actor_mismatch");
    ctx.db.close();
  });

  it("正しい holdAll prefix でも参加者の預託明細が無ければ許可しない", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 2_000);

    ctx.chips.runGroup(
      { groupKey: "wallet:escrow:hold_all:pvpopen:test-session:collect", kind: "table_hold", actorId: "system:escrow" },
      () => {
        ctx.chipFlow.ensureFreeChips("alice", 2_000, "walletautofund3001");
      },
    );

    expect(notes(ctx)).toContain("group_actor_mismatch");
    ctx.db.close();
  });

  it("holdAll wrapper の session と預託明細の session が違えば許可しない", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 2_000);

    ctx.chips.runGroup(
      { groupKey: "wallet:escrow:hold_all:pvpopen:session-a:collect", kind: "table_hold", actorId: "system:escrow" },
      () => {
        ctx.chipFlow.ensureFreeChips("alice", 2_000, "walletautofund4001");
        ctx.chips.transfer("alice", "escrow:session:pvpopen:session-b", 2_000, {
          reason: "卓への預託",
          game: "pvp",
          sessionId: "pvpopen:session-b",
        });
      },
    );

    expect(notes(ctx)).toContain("group_actor_mismatch");
    ctx.db.close();
  });

  it("VIP の nested 自動預入でも outer actor が別人なら止める", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 2_000);

    ctx.chips.runGroup({ groupKey: "vip:alice:forged", kind: "vip", actorId: "mallory" }, () => {
      ctx.chipFlow.ensureFreeChips("alice", 1_000, "vipautofund-forged");
    });

    expect(notes(ctx)).toContain("group_actor_mismatch");
    ctx.db.close();
  });

  it("VIP / market_bet は user chip_deposit 以外の Land 経路を nested 許可しない", () => {
    const ctx = setup();
    fundSystem(ctx, "sys:test:casino", 2_000, "seed:sys:test:casino");

    ctx.chips.runGroup({ groupKey: "vip:alice:system-fund", kind: "vip", actorId: "alice" }, () => {
      ctx.chips.fundFromAccount("sys:test:casino", 1_000, HOUSE_HOLDER, "nested:vip:fund");
    });
    expect(notes(ctx)).toContain("group_kind_not_nestable:vip");

    // market_bet でも system settlement を混ぜれば同様に拒否する。
    ctx.chips.runGroup({ groupKey: "market:bet:1:bob:system-settle", kind: "market_bet", actorId: "bob" }, () => {
      ctx.chips.redeemToAccount(HOUSE_HOLDER, 500, "sys:test:casino", "system:ether", "nested:market:settle");
    });
    expect(notes(ctx)).toContain("group_kind_not_nestable:market_bet");

    ctx.db.close();
  });
});