import { describe, expect, it } from "vitest";
import { renderCasinoStatusLine, renderWalletValue } from "../src/commands/annai.js";
import type { AvailableWalletSnapshot } from "../src/casino/wallet.js";

const formalWallet = (escrowed: number): AvailableWalletSnapshot => ({
  status: "formal",
  available: 1_000 + 9_000,
  land: 1_000,
  freeChips: 9_000,
  escrowed,
});

describe("案内所のPR13財布表示（所持 = 通常Land + 自由チップ）", () => {
  it("正式開業後、escrowed=0なら通常Land+自由チップの合算だけを出し、補助行を出さない", () => {
    const text = renderWalletValue({
      wallet: formalWallet(0),
      isVip: false,
      vipDaysLeft: 0,
    });
    expect(text).toContain("所持 **10,000 Ld**");
    expect(text).not.toContain("卓・板に預け中");
  });

  it("正式開業後、escrowed>0なら合算額に加えて預け中の補助行を出す（二重加算しない）", () => {
    const text = renderWalletValue({
      wallet: formalWallet(2_000),
      isVip: false,
      vipDaysLeft: 0,
    });
    expect(text).toContain("所持 **10,000 Ld**");
    expect(text).toContain("卓・板に預け中 2,000 Ld");
  });

  it("正式開業前(pre_opening)では自由チップを利用可能額として表示しない", () => {
    const text = renderWalletValue({
      wallet: { status: "pre_opening", available: 1_000, land: 1_000, freeChips: null, escrowed: null },
      isVip: false,
      vipDaysLeft: 0,
    });
    expect(text).toContain("正式開業準備中");
    expect(text).toContain("1,000 Ld");
    expect(text).not.toContain("10,000 Ld");
    expect(text).not.toContain("卓・板に預け中");
  });

  it("未知版では自由チップ・預け中を確認不能として表示する", () => {
    const text = renderWalletValue({
      wallet: { status: "unknown", available: 1_000, land: 1_000, freeChips: null, escrowed: null },
      isVip: false,
      vipDaysLeft: 0,
    });
    expect(text).toContain("賭場の版が異常");
    expect(text).toContain("利用可能額へ含めません");
    expect(text).not.toContain("10,000 Ld");
  });

  it("資産検算例外を0へ丸めず表示停止する（ledger_error）", () => {
    const text = renderWalletValue({
      wallet: { status: "ledger_error", available: 1_000, land: 1_000, freeChips: null, escrowed: null },
      isVip: false,
      vipDaysLeft: 0,
    });
    expect(text).toContain("チップ帳簿を確認できません");
    expect(text).toContain("破損値を0として表示せず");
    // 合算できないので、通常Landだけを出し「合算した所持額」を捏造しない
    expect(text).not.toContain("10,000 Ld");
  });

  it("合算がsafe integerを超える場合は破損値を出さない（overflow）", () => {
    const text = renderWalletValue({
      wallet: { status: "overflow", available: 1_000, land: 1_000, freeChips: null, escrowed: null },
      isVip: false,
      vipDaysLeft: 0,
    });
    expect(text).toContain("残高の合算に失敗しました");
    expect(text).toContain("1,000 Ld");
  });

  it("integrity_halt / recovery_haltの停止理由を維持する", () => {
    expect(renderCasinoStatusLine("integrity_halt", "検算Cが不一致")).toContain("integrity_halt");
    expect(renderCasinoStatusLine("recovery_halt", "所有元を確認できない")).toContain("recovery_halt");
    expect(renderCasinoStatusLine("open", "正常")).toBe("");
  });
});
