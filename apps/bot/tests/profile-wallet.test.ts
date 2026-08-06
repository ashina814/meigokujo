import { describe, expect, it, vi } from "vitest";
import { ChipLedgerError } from "@meigokujo/core";

// profile.ts は permissions.js 経由で config.js（環境変数必須）を読み込むため、
// テスト環境ではimport前にモックする（既存 permissions.test.ts と同じ流儀）。
vi.mock("../src/config.js", () => ({ config: { ownerId: "owner-user" } }));

import { resolveProfileBalance } from "../src/commands/profile.js";
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

describe("/プロフィール 所持額（PR13監査: opening phase判定の統一）", () => {
  it("formal: 通常Land + 自由チップ", () => {
    expect(resolveProfileBalance(fakeServices({ land: 1_000, phase: "formal", freeChips: 9_000 }), "u")).toBe(10_000);
  });

  it("正式開業前(pre_reset): 通常Landのみ", () => {
    expect(resolveProfileBalance(fakeServices({ land: 1_000, phase: "pre_reset", freeChips: 9_000 }), "u")).toBe(1_000);
  });

  it("未知版(unknown): 通常Landのみ", () => {
    expect(resolveProfileBalance(fakeServices({ land: 1_000, phase: "unknown", freeChips: 9_000 }), "u")).toBe(1_000);
  });

  it("チップ帳簿エラー: 通常Landのみ", () => {
    expect(resolveProfileBalance(fakeServices({ land: 1_000, phase: "formal", ledgerError: true }), "u")).toBe(1_000);
  });

  it("overflow: 通常Landのみ", () => {
    expect(
      resolveProfileBalance(fakeServices({ land: Number.MAX_SAFE_INTEGER, phase: "formal", freeChips: 10 }), "u"),
    ).toBe(Number.MAX_SAFE_INTEGER);
  });
});
