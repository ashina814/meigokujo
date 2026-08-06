import { describe, expect, it } from "vitest";
import { ChipLedgerError } from "@meigokujo/core";
import { readAvailableWallet } from "../src/casino/wallet.js";
import type { Services } from "../src/services.js";

function fakeServices(opts: {
  land: number;
  phase: "formal" | "pre_reset" | "unknown";
  freeChips?: number;
  escrowed?: number;
  ledgerError?: boolean;
}): Services {
  return {
    ledger: { balanceOf: () => opts.land },
    chipTx: { openingPhase: () => opts.phase },
    chipAssets: {
      forUser: () => {
        if (opts.ledgerError) throw new ChipLedgerError("ERR_CORRUPT_BALANCE");
        return { userId: "u", freeChips: opts.freeChips ?? 0, escrowed: opts.escrowed ?? 0, total: (opts.freeChips ?? 0) + (opts.escrowed ?? 0) };
      },
    },
  } as unknown as Services;
}

describe("readAvailableWallet — 財布判定の一本化（PR13監査）", () => {
  it("formal: 利用可能額 = 通常Land + 自由チップ。escrowedは別枠で返す", () => {
    const snap = readAvailableWallet(fakeServices({ land: 1_000, phase: "formal", freeChips: 9_000, escrowed: 2_000 }), "u");
    expect(snap).toEqual({ status: "formal", available: 10_000, land: 1_000, freeChips: 9_000, escrowed: 2_000 });
  });

  it("pre_reset: 利用可能額は通常Landのみ。自由チップを合算しない", () => {
    const snap = readAvailableWallet(fakeServices({ land: 1_000, phase: "pre_reset", freeChips: 9_000 }), "u");
    expect(snap).toEqual({ status: "pre_opening", available: 1_000, land: 1_000, freeChips: null, escrowed: null });
  });

  it("unknown: 利用可能額は通常Landのみ。推測で合算しない", () => {
    const snap = readAvailableWallet(fakeServices({ land: 1_000, phase: "unknown", freeChips: 9_000 }), "u");
    expect(snap).toEqual({ status: "unknown", available: 1_000, land: 1_000, freeChips: null, escrowed: null });
  });

  it("チップ帳簿の読み取り失敗: 利用可能額は通常Landのみ。エラーを0として合算しない", () => {
    const snap = readAvailableWallet(fakeServices({ land: 1_000, phase: "formal", ledgerError: true }), "u");
    expect(snap).toEqual({ status: "ledger_error", available: 1_000, land: 1_000, freeChips: null, escrowed: null });
  });

  it("合算がsafe integerを超える: 利用可能額は通常Landのみ。壊れた合算値を返さない", () => {
    const snap = readAvailableWallet(
      fakeServices({ land: Number.MAX_SAFE_INTEGER, phase: "formal", freeChips: 10 }),
      "u",
    );
    expect(snap.status).toBe("overflow");
    expect(snap.available).toBe(Number.MAX_SAFE_INTEGER);
    expect(snap.freeChips).toBeNull();
    expect(snap.escrowed).toBeNull();
  });

  it("ChipLedgerError以外の例外はそのまま投げる（握り潰さない）", () => {
    const services = {
      ledger: { balanceOf: () => 1_000 },
      chipTx: { openingPhase: () => "formal" as const },
      chipAssets: {
        forUser: () => {
          throw new Error("unexpected");
        },
      },
    } as unknown as Services;
    expect(() => readAvailableWallet(services, "u")).toThrow("unexpected");
  });
});
