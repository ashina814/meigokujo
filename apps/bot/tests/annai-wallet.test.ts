import { describe, expect, it } from "vitest";
import { renderCasinoStatusLine, renderWalletValue } from "../src/commands/annai.js";

const assets = (escrowed: number) => ({
  userId: "alice",
  freeChips: 9_000,
  escrowed,
  total: 9_000 + escrowed,
});

describe("案内所のPR9財布表示", () => {
  it("正式開業後、escrowed=0なら補助行を出さない", () => {
    const text = renderWalletValue({
      phase: "formal",
      heldLand: 1_000,
      assets: assets(0),
      assetError: false,
      isVip: false,
      vipDaysLeft: 0,
    });
    expect(text).toContain("9,000 ◈");
    expect(text).not.toContain("卓・板に預け中");
  });

  it("正式開業後、escrowed>0なら補助行を出す", () => {
    const text = renderWalletValue({
      phase: "formal",
      heldLand: 1_000,
      assets: assets(2_000),
      assetError: false,
      isVip: false,
      vipDaysLeft: 0,
    });
    expect(text).toContain("卓・板に預け中 **2,000 ◈**");
  });

  it("legacy_pre_resetでは自由チップを利用可能額として表示しない", () => {
    const text = renderWalletValue({
      phase: "legacy",
      heldLand: 1_000,
      assets: assets(2_000),
      assetError: false,
      isVip: false,
      vipDaysLeft: 0,
    });
    expect(text).toContain("正式開業準備中");
    expect(text).toContain("1,000 Ld");
    expect(text).not.toContain("9,000 ◈");
    expect(text).not.toContain("卓・板に預け中");
  });

  it("未知版では自由チップ・預け中を確認不能として表示する", () => {
    const text = renderWalletValue({
      phase: "unknown",
      heldLand: 1_000,
      assets: assets(2_000),
      assetError: false,
      isVip: false,
      vipDaysLeft: 0,
    });
    expect(text).toContain("賭場の版が異常");
    expect(text).toContain("利用可能額へ含めません");
    expect(text).not.toContain("9,000 ◈");
  });

  it("資産検算例外を0へ丸めず表示停止する", () => {
    const text = renderWalletValue({
      phase: "formal",
      heldLand: 1_000,
      assets: null,
      assetError: true,
      isVip: false,
      vipDaysLeft: 0,
    });
    expect(text).toContain("チップ帳簿を確認できません");
    expect(text).toContain("破損値を0として表示せず");
    expect(text).not.toContain("0 ◈");
  });

  it("integrity_halt / recovery_haltの停止理由を維持する", () => {
    expect(renderCasinoStatusLine("integrity_halt", "検算Cが不一致")).toContain("integrity_halt");
    expect(renderCasinoStatusLine("recovery_halt", "所有元を確認できない")).toContain("recovery_halt");
    expect(renderCasinoStatusLine("open", "正常")).toBe("");
  });
});
