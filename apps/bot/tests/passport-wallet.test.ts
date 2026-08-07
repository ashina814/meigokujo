import { describe, expect, it } from "vitest";
import { ChipLedgerError } from "@meigokujo/core";
import { resolvePassportBalances } from "../src/commands/passport.js";
import type { Services } from "../src/services.js";

function fakeServices(opts: {
  land: number;
  phase: "formal" | "pre_reset" | "unknown";
  freeChips?: number;
  ledgerError?: boolean;
}): Services {
  return {
    ledger: { balanceOf: () => opts.land },
    chipTx: { openingPhase: () => opts.phase },
    chipAssets: {
      forUser: () => {
        if (opts.ledgerError) throw new ChipLedgerError("ERR_CORRUPT_BALANCE");
        return { userId: "u", freeChips: opts.freeChips ?? 0, escrowed: 0, total: opts.freeChips ?? 0 };
      },
    },
  } as unknown as Services;
}

describe("/通行証 所持額（PR13監査: opening phase判定の統一・escrow二重加算なし）", () => {
  it("formal: 通常Land + 自由チップ", () => {
    const r = resolvePassportBalances(fakeServices({ land: 1_000, phase: "formal", freeChips: 9_000 }), "u");
    expect(r).toEqual({ availableBalance: 10_000, landBalance: 1_000 });
  });

  it("正式開業前(pre_reset): 通常Landのみ", () => {
    const r = resolvePassportBalances(fakeServices({ land: 1_000, phase: "pre_reset", freeChips: 9_000 }), "u");
    expect(r).toEqual({ availableBalance: 1_000, landBalance: 1_000 });
  });

  it("未知版(unknown): 通常Landのみ", () => {
    const r = resolvePassportBalances(fakeServices({ land: 1_000, phase: "unknown", freeChips: 9_000 }), "u");
    expect(r).toEqual({ availableBalance: 1_000, landBalance: 1_000 });
  });

  it("チップ帳簿エラー: 通常Landのみ", () => {
    const r = resolvePassportBalances(fakeServices({ land: 1_000, phase: "formal", ledgerError: true }), "u");
    expect(r).toEqual({ availableBalance: 1_000, landBalance: 1_000 });
  });

  it("overflow: 通常Landのみ", () => {
    const r = resolvePassportBalances(
      fakeServices({ land: Number.MAX_SAFE_INTEGER, phase: "formal", freeChips: 10 }),
      "u",
    );
    expect(r).toEqual({ availableBalance: Number.MAX_SAFE_INTEGER, landBalance: Number.MAX_SAFE_INTEGER });
  });
});
