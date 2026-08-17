import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createFundedEscrow, createSpendableChipLedger } from "../src/casino/spendable-wallet.js";

function makeWalletFixture(input: {
  formal?: boolean;
  active?: boolean;
  free?: Record<string, number>;
  land?: Record<string, number>;
  settledGroups?: Set<string>;
} = {}) {
  let active = input.active ?? false;
  const free = { ...(input.free ?? {}) };
  const land = { ...(input.land ?? {}) };
  const settledGroups = input.settledGroups ?? new Set<string>();
  const txRows: Array<{
    tx_kind: string;
    from_holder: string;
    to_holder: string;
    amount: number;
    game: string;
    session_id: string;
  }> = [];

  const chipTx = {
    openingPhase: vi.fn(() => (input.formal === false ? "pre_reset" : "formal")),
    isActive: vi.fn(() => active),
    hasGroup: vi.fn((key: string) => settledGroups.has(key)),
    listByGroup: vi.fn(() => txRows),
  };
  const chips = {
    chipTx,
    balanceOf: vi.fn((holderId: string) => free[holderId] ?? 0),
    transfer: vi.fn(),
    runGroup: vi.fn((_meta: unknown, body: () => unknown) => {
      const before = active;
      active = true;
      try {
        return body();
      } finally {
        active = before;
      }
    }),
    // Proxy が非override methodをtargetへbindする契約も確認するためのダミー。
    freeChips: vi.fn((userId: string) => free[userId] ?? 0),
  } as never;
  const ledger = {
    balanceOf: vi.fn((accountId: string) => land[accountId.replace(/^user:/, "")] ?? 0),
  } as never;
  const chipFlow = {
    ensureFreeChips: vi.fn((userId: string, required: number) => {
      const before = free[userId] ?? 0;
      const deposited = Math.max(0, required - before);
      free[userId] = before + deposited;
      return { required, freeBefore: before, deposited, freeAfter: free[userId] };
    }),
  } as never;

  const makeRawEscrow = () => {
    const holderId = (sessionId: string) => `escrow:${sessionId}`;
    const record = (sessionId: string, userId: string, amount: number, game: string) => {
      txRows.push({
        tx_kind: "internal_transfer",
        from_holder: userId,
        to_holder: holderId(sessionId),
        amount,
        game,
        session_id: sessionId,
      });
    };
    return {
      holderId: vi.fn(holderId),
      hold: vi.fn((sessionId: string, userId: string, amount: number, game: string) => {
        record(sessionId, userId, amount, game);
        return true;
      }),
      holdAll: vi.fn((sessionId: string, userIds: readonly string[], amount: number, game: string) => {
        for (const userId of userIds) record(sessionId, userId, amount, game);
        return true;
      }),
    } as never;
  };

  return {
    chips,
    ledger,
    chipFlow,
    free,
    land,
    txRows,
    makeRawEscrow,
    setActive(value: boolean) {
      active = value;
    },
  };
}

describe("spendable casino wallet", () => {
  it("formal opening中の利用者残高は通常Land + 自由チップ", () => {
    const f = makeWalletFixture({ free: { alice: 200 }, land: { alice: 800 } });
    const wallet = createSpendableChipLedger(f.chips, f.ledger, f.chipFlow);

    expect(wallet.balanceOf("alice")).toBe(1_000);
    expect(wallet.freeChips("alice"), "freeChipsの意味まで合算に変えてはいけない").toBe(200);
  });

  it("house等のsystem holderは通常Landを混ぜずraw chip残高だけ", () => {
    const f = makeWalletFixture({ free: { house: 900 }, land: { house: 99_999 } });
    const wallet = createSpendableChipLedger(f.chips, f.ledger, f.chipFlow);

    expect(wallet.balanceOf("house")).toBe(900);
    expect(f.ledger.balanceOf).not.toHaveBeenCalled();
  });

  it("formal opening前は利用者にも通常Landを混ぜない", () => {
    const f = makeWalletFixture({ formal: false, free: { alice: 200 }, land: { alice: 800 } });
    const wallet = createSpendableChipLedger(f.chips, f.ledger, f.chipFlow);

    expect(wallet.balanceOf("alice")).toBe(200);
  });

  it("activeな資金group内の支払いは不足分だけ自動預入してからtransferする", () => {
    const f = makeWalletFixture({ active: true, free: { alice: 100 }, land: { alice: 900 } });
    const wallet = createSpendableChipLedger(f.chips, f.ledger, f.chipFlow);

    wallet.transfer("alice", "house", 600, { reason: "test" });

    expect(f.chipFlow.ensureFreeChips).toHaveBeenCalledTimes(1);
    expect(f.chipFlow.ensureFreeChips).toHaveBeenCalledWith("alice", 600, expect.stringMatching(/^walletautofund\d+$/));
    expect(f.chips.transfer).toHaveBeenCalledWith("alice", "house", 600, { reason: "test" });
  });

  it("自動預入のoperation IDは再起動で巻き戻る単純連番ではなく十分大きい一意値を使う", () => {
    const f = makeWalletFixture({ active: true, free: { alice: 0 }, land: { alice: 1_000 } });
    const wallet = createSpendableChipLedger(f.chips, f.ledger, f.chipFlow);

    wallet.transfer("alice", "house", 100, { reason: "first" });
    f.free.alice = 0;
    wallet.transfer("alice", "house", 100, { reason: "second" });

    const ids = (f.chipFlow.ensureFreeChips as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[2]));
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]?.length).toBeGreaterThan(30);
    expect(ids[1]?.length).toBeGreaterThan(30);
  });

  it("group外ではLandだけ先に預けずraw transferへ任せる", () => {
    const f = makeWalletFixture({ active: false, free: { alice: 100 }, land: { alice: 900 } });
    const wallet = createSpendableChipLedger(f.chips, f.ledger, f.chipFlow);

    wallet.transfer("alice", "house", 600, { reason: "test" });

    expect(f.chipFlow.ensureFreeChips).not.toHaveBeenCalled();
    expect(f.chips.transfer).toHaveBeenCalledTimes(1);
  });

  it("総所持額自体が足りなければ自動預入を試さない", () => {
    const f = makeWalletFixture({ active: true, free: { alice: 100 }, land: { alice: 200 } });
    const wallet = createSpendableChipLedger(f.chips, f.ledger, f.chipFlow);

    wallet.transfer("alice", "house", 600, { reason: "test" });

    expect(f.chipFlow.ensureFreeChips).not.toHaveBeenCalled();
    expect(f.chips.transfer).toHaveBeenCalledTimes(1);
  });
});

describe("funded escrow", () => {
  it("holdAllは全員の総所持額を先に確認してから全員をfundし、1回だけraw holdAllへ渡す", () => {
    const f = makeWalletFixture({
      free: { alice: 0, bob: 50 },
      land: { alice: 1_000, bob: 950 },
    });
    const rawEscrow = f.makeRawEscrow();
    const escrow = createFundedEscrow(rawEscrow, f.chips, f.ledger, f.chipFlow);

    expect(escrow.holdAll("s1", ["alice", "bob"], 500, "pvp", "op1")).toBe(true);

    expect(f.chipFlow.ensureFreeChips).toHaveBeenCalledTimes(2);
    expect(rawEscrow.holdAll).toHaveBeenCalledTimes(1);
    expect(rawEscrow.holdAll).toHaveBeenCalledWith("s1", ["alice", "bob"], 500, "pvp", "op1");
    expect(f.chips.runGroup).toHaveBeenCalledTimes(1);
    expect(f.txRows).toHaveLength(2);
  });

  it("holdAllで1人でも総所持額不足なら誰のLandも動かさない", () => {
    const f = makeWalletFixture({
      free: { alice: 0, bob: 0 },
      land: { alice: 1_000, bob: 100 },
    });
    const rawEscrow = f.makeRawEscrow();
    const escrow = createFundedEscrow(rawEscrow, f.chips, f.ledger, f.chipFlow);

    expect(escrow.holdAll("s2", ["alice", "bob"], 500, "pvp", "op2")).toBe(false);

    expect(f.chipFlow.ensureFreeChips, "1人目だけ預入されている").not.toHaveBeenCalled();
    expect(rawEscrow.holdAll).not.toHaveBeenCalled();
  });

  it("nestedの競馬/ルーレット型でも外側transactionの中でfundしてraw escrowへ渡す", () => {
    const f = makeWalletFixture({ active: true, free: { alice: 0 }, land: { alice: 1_000 } });
    const rawEscrow = f.makeRawEscrow();
    const escrow = createFundedEscrow(rawEscrow, f.chips, f.ledger, f.chipFlow);

    expect(escrow.hold("race1", "alice", 500, "keiba", "op3")).toBe(true);
    expect(f.chipFlow.ensureFreeChips).toHaveBeenCalledTimes(1);
    expect(rawEscrow.hold).toHaveBeenCalledWith("race1", "alice", 500, "keiba", "op3");
    expect(f.chips.runGroup, "既にある外側groupの上に別groupを作っている").not.toHaveBeenCalled();
  });

  it("旧raw escrow groupが確定済みなら新wrapperで再徴収せずraw replayへ委譲する", () => {
    const legacy = new Set(["escrow:hold_all:old:op4"]);
    const f = makeWalletFixture({ settledGroups: legacy, land: { alice: 1_000, bob: 1_000 } });
    const rawEscrow = f.makeRawEscrow();
    const escrow = createFundedEscrow(rawEscrow, f.chips, f.ledger, f.chipFlow);

    expect(escrow.holdAll("old", ["alice", "bob"], 500, "pvp", "op4")).toBe(true);
    expect(rawEscrow.holdAll).toHaveBeenCalledTimes(1);
    expect(f.chipFlow.ensureFreeChips).not.toHaveBeenCalled();
    expect(f.chips.runGroup).not.toHaveBeenCalled();
  });

  it("holdAllの重複参加者は資金へ触る前に拒否する", () => {
    const f = makeWalletFixture({ land: { alice: 1_000 } });
    const rawEscrow = f.makeRawEscrow();
    const escrow = createFundedEscrow(rawEscrow, f.chips, f.ledger, f.chipFlow);

    expect(() => escrow.holdAll("s5", ["alice", "alice"], 500, "pvp", "op5")).toThrow("duplicate userId");
    expect(f.chipFlow.ensureFreeChips).not.toHaveBeenCalled();
    expect(rawEscrow.holdAll).not.toHaveBeenCalled();
  });

  it("wrapper groupのreplay内容が違えば取り違えとしてfail-closedする", () => {
    const f = makeWalletFixture({ land: { alice: 1_000 } });
    (f.chips.runGroup as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      kind: "hold",
      sessionId: "different",
      userId: "alice",
      amount: 500,
      game: "pvp",
      ok: true,
    }));
    const rawEscrow = f.makeRawEscrow();
    const escrow = createFundedEscrow(rawEscrow, f.chips, f.ledger, f.chipFlow);

    expect(() => escrow.hold("s6", "alice", 500, "pvp", "op6")).toThrow("funded escrow operation conflict");
    expect(rawEscrow.hold).not.toHaveBeenCalled();
  });

  it("wrapper ledgerのinternal_transferが要求と違えばcommit前にfail-closedする", () => {
    const f = makeWalletFixture({ land: { alice: 1_000 } });
    const rawEscrow = f.makeRawEscrow();
    (rawEscrow.hold as ReturnType<typeof vi.fn>).mockImplementation(
      (sessionId: string, userId: string, amount: number, game: string) => {
        f.txRows.push({
          tx_kind: "internal_transfer",
          from_holder: userId,
          to_holder: `escrow:${sessionId}`,
          amount: amount + 1,
          game,
          session_id: sessionId,
        });
        return true;
      },
    );
    const escrow = createFundedEscrow(rawEscrow, f.chips, f.ledger, f.chipFlow);

    expect(() => escrow.hold("audit", "alice", 500, "pvp", "audit-op")).toThrow("funded escrow ledger mismatch");
  });
});

describe("production wiring", () => {
  it("利用者支払い系だけspendable view、監査系はraw帳簿へ分離している", () => {
    const source = readFileSync(new URL("../src/services.ts", import.meta.url), "utf8");

    expect(source).toContain("createSpendableChipLedger(chips, ledger, chipFlow)");
    for (const service of ["Casino", "Daily", "Stocks", "Vip", "Markets"]) {
      expect(source, `${service} がraw chipsのまま`).toContain(`new ${service}(db, spendableChips`);
    }
    expect(source).toContain("createFundedEscrow(escrowCore, chips, ledger, chipFlow)");
    expect(source).toContain("new CasinoIntegrity(db, ledger, chips, escrowCore, chipAssets)");
    expect(source).toContain("chips: spendableChips");
    expect(source).toContain("ether: chips as ChipReadonlyView");
  });
});
