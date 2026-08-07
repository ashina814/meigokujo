import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { ButtonInteraction, ModalSubmitInteraction } from "discord.js";
import type { Services } from "../src/services.js";

vi.mock("../src/permissions.js", () => ({ isAdmin: () => true }));

import { exchangePanelMessage, handleEtherButton, handleEtherModal } from "../src/commands/exchange-panel.js";
import { handleAdminButton, handleAdminModal } from "../src/commands/admin-hub.js";
import { describeChipLedgerError, openingBadge, openingNotice, operatingLabel } from "../src/casino/opening.js";
import { ChipLedgerError } from "@meigokujo/core";

/**
 * PR8監査・項目8: 正式開業前・opening_v1・未知版で、UI が実態と一致していること。
 *
 * 一番危ないのは「稼働状態が `open` なので営業中と出す」ケース。PR8 の時点では
 * 版が `legacy_pre_reset` のままなので、預入・返還・賭け・資金投入・売上精算はどれも
 * 動かない。営業中と出したうえで押せるボタンを並べると、押しても必ず失敗する。
 */

type Phase = "pre_reset" | "formal" | "unknown";

function fakeServices(phase: Phase, status = "open") {
  return {
    casinoStatus: {
      current: () => ({ status, reason: "テスト", changedBy: "boss", changedAt: 1 }),
      denyMessage: () => (status === "open" ? null : "賭場は改装中だ。"),
      haltForIntegrity: vi.fn(() => false),
      reopenFromManualHalt: vi.fn(() => ({ ok: true })),
      reopenAfterIntegrity: vi.fn(() => ({ ok: true })),
      endMaintenance: vi.fn(() => ({ ok: true })),
    },
    chipTx: { openingPhase: () => phase, openingLandBaseline: () => ({ poolLand: 0 }), currentVersion: () => "legacy_pre_reset" },
    chips: {
      // 未知版では pool() が例外になる。UI がそれを踏まないことも含めて検証する
      pool: () => {
        if (phase === "unknown") throw new ChipLedgerError("ERR_UNKNOWN_OPENING_VERSION", { version: "opening_v9" });
        return 700_000;
      },
      outstanding: () => 700_000,
      balanceOf: () => 12_345,
      settleableBalance: () => 12_345,
      quoteDeposit: (n: number) => ({ input: n, output: n, burned: 0 }),
      quoteRedeem: (n: number) => ({ input: n, output: n, burned: 0 }),
      deposit: vi.fn(),
      redeem: vi.fn(),
      fundFromAccount: vi.fn(),
      redeemFairToAccount: vi.fn(),
    },
    ether: {
      pool: () => {
        if (phase === "unknown") throw new ChipLedgerError("ERR_UNKNOWN_OPENING_VERSION", { version: "opening_v9" });
        return 700_000;
      },
      outstanding: () => 700_000,
    },
    ledger: { balanceOf: () => 500_000, lastTransactionId: () => 42 },
    casino: { houseBalance: () => 100_000, jackpotPool: () => 30_000 },
    casinoIntegrity: {
      runFull: () => ({
        ok: true,
        ledger: { ok: true, detail: "Land台帳は正常" },
        checks: [{ id: "A", name: "記録と残高", ok: true, detail: "一致", mismatches: [] }],
        failed: [],
        checkedAt: 0,
      }),
    },
    departments: { get: () => ({ name: "賭博場" }), balanceOf: () => 1_000_000 },
    // PR13: 運営卓の運転資金目安（capacityWorksheetLine）は開業設定をSELECTのみで読む。
    // 未設定（settings行なし）を模して getString は常に undefined を返す
    settings: { getString: () => undefined },
  } as unknown as Services;
}

function button(customId: string) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const update = vi.fn().mockResolvedValue(undefined);
  const showModal = vi.fn().mockResolvedValue(undefined);
  return {
    i: { customId, user: { id: "u1" }, replied: false, deferred: false, reply, update, showModal, id: "int-1" } as unknown as ButtonInteraction,
    reply,
    update,
    showModal,
  };
}

function modal(customId: string, amount: string) {
  const reply = vi.fn().mockResolvedValue(undefined);
  return {
    i: {
      customId,
      user: { id: "u1" },
      replied: false,
      deferred: false,
      reply,
      id: "int-2",
      fields: { getTextInputValue: () => amount },
    } as unknown as ModalSubmitInteraction,
    reply,
  };
}

const text = (fn: ReturnType<typeof vi.fn>): string => {
  const arg = fn.mock.calls[0]![0] as { content?: string };
  return arg.content ?? "";
};

describe("旧両替所パネル（PR13で無効化）", () => {
  it.each(["pre_reset", "formal", "unknown"] as const)(
    "%s でも同じ無効化パネルを返し、コンポーネントを持たない",
    (phase) => {
      const msg = exchangePanelMessage(fakeServices(phase));
      const embed = msg.embeds[0]!.toJSON();
      expect(embed.description).toContain("旧パネルは無効です");
      expect(msg.components).toEqual([]);
      expect(JSON.stringify(embed)).not.toContain("エテル");
      expect(JSON.stringify(embed)).not.toContain("ether:");
    },
  );

  it.each(["pre_reset", "formal", "unknown"] as const)(
    "%s でも旧ボタン（入場・退場・財布・更新）を押すと資金を動かさず無効の旨だけ返す",
    async (phase) => {
      for (const id of ["ether:buy", "ether:sell", "ether:balance", "ether:refresh"]) {
        const services = fakeServices(phase);
        const b = button(id);
        await handleEtherButton(b.i, services);
        expect(text(b.reply)).toContain("この旧ボタンは無効です");
        expect(services.chips.deposit).not.toHaveBeenCalled();
        expect(services.chips.redeem).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["pre_reset", "formal", "unknown"] as const)(
    "%s でも旧フォーム送信は資金を動かさず無効の旨だけ返す",
    async (phase) => {
      const services = fakeServices(phase);
      const m = modal("ether:modal:buy", "10000");
      await handleEtherModal(m.i, services);
      expect(text(m.reply)).toContain("この旧フォームは無効です");
      expect(services.chips.deposit).not.toHaveBeenCalled();
      expect(services.chips.redeem).not.toHaveBeenCalled();
    },
  );
});

describe("運営卓の賭場ホーム（項目8）", () => {
  async function casinoHomeText(phase: Phase, status = "open"): Promise<{ description: string; buttons: Array<{ custom_id: string; disabled?: boolean }> }> {
    const b = button("mgmt:casino");
    await handleAdminButton(b.i, fakeServices(phase, status));
    const payload = b.update.mock.calls[0]![0] as {
      embeds: Array<{ toJSON(): { description?: string } }>;
      components: Array<{ toJSON(): { components: Array<{ custom_id: string; disabled?: boolean }> } }>;
    };
    return { description: payload.embeds[0]!.toJSON().description ?? "", buttons: payload.components[0]!.toJSON().components };
  }

  it("稼働状態が open でも、開業前は『営業中』だけで済ませない", async () => {
    const { description, buttons } = await casinoHomeText("pre_reset");
    expect(description).toContain("正式開業準備中");
    expect(description).toContain("預入・返還・賭け・資金投入・売上精算は停止中");
    expect(description).toContain("チップ比率**: 停止中");
    expect(description).not.toMatch(/チップ比率\*\*: 1 チップ = 1 Ld/);
    // 資金投入・売上精算は押せない
    expect(buttons.find((b) => b.custom_id === "mgmt:casino:fund")?.disabled).toBe(true);
    expect(buttons.find((b) => b.custom_id === "mgmt:casino:settle")?.disabled).toBe(true);
  });

  it("opening_v1 では 1 チップ = 1 Ld を出し、資金投入・売上精算を開放する", async () => {
    const { description, buttons } = await casinoHomeText("formal");
    expect(description).toContain("チップ比率**: 1 チップ = 1 Ld");
    expect(description).not.toContain("正式開業準備中");
    expect(buttons.find((b) => b.custom_id === "mgmt:casino:fund")?.disabled).toBeFalsy();
    expect(buttons.find((b) => b.custom_id === "mgmt:casino:settle")?.disabled).toBeFalsy();
  });

  it("未知版では異常表示にして、準備プールの読み取りで落ちない", async () => {
    const { description, buttons } = await casinoHomeText("unknown");
    expect(description).toContain("版が異常");
    expect(description).toContain("準備プール**: 読み取り不可");
    expect(buttons.find((b) => b.custom_id === "mgmt:casino:fund")?.disabled).toBe(true);
    expect(buttons.find((b) => b.custom_id === "mgmt:casino:settle")?.disabled).toBe(true);
  });

  it.each(["pre_reset", "unknown"] as const)("%s では資金投入・売上精算の stale ボタンが modal を開かない", async (phase) => {
    for (const id of ["mgmt:casino:fund", "mgmt:casino:settle"]) {
      const b = button(id);
      await handleAdminButton(b.i, fakeServices(phase));
      expect(b.showModal).not.toHaveBeenCalled();
      expect(text(b.reply)).toContain(phase === "unknown" ? "版が異常" : "正式開業準備中");
    }
  });

  it.each(["pre_reset", "unknown"] as const)("%s では資金投入・売上精算の stale modal も専用文面で断る", async (phase) => {
    for (const id of ["mgmt:casino:fund", "mgmt:casino:settle"]) {
      const services = fakeServices(phase);
      const m = modal(id, "10000");
      await handleAdminModal(m.i, services);
      expect(text(m.reply)).toContain(phase === "unknown" ? "版が異常" : "正式開業準備中");
      expect(services.chips.fundFromAccount).not.toHaveBeenCalled();
      expect(services.chips.redeemFairToAccount).not.toHaveBeenCalled();
    }
  });
});

describe("表示語彙（項目8・項目9）", () => {
  it("稼働状態が open でも、開業が終わっていなければ『営業中』と言わない", () => {
    expect(operatingLabel(fakeServices("pre_reset"))).toContain("正式開業準備中");
    expect(operatingLabel(fakeServices("unknown"))).toContain("版が異常");
    expect(operatingLabel(fakeServices("formal"))).toContain("正式開業");
    // 停止中は停止理由が優先される
    expect(operatingLabel(fakeServices("formal", "maintenance"))).toContain("maintenance");
  });

  it("案内文は版ごとに定型で、開業前に 1:1 を約束しない", () => {
    expect(openingNotice(fakeServices("pre_reset"))).toContain("既存残高は保持されています");
    expect(openingNotice(fakeServices("pre_reset"))).not.toMatch(/1 Ld ＝ 1|1 Ld = 1 chip/);
    expect(openingNotice(fakeServices("formal"))).toContain("1 Ld ＝ 1 chip（固定）");
    expect(openingBadge(fakeServices("pre_reset"))).toContain("資金操作は停止中");
  });
});

describe("エラー文言の変換（項目11）", () => {
  const services = fakeServices("formal");
  const CODES = [
    "ERR_BAD_AMOUNT",
    "ERR_BAD_IDENTIFIER",
    "ERR_INSUFFICIENT_CHIPS",
    "ERR_DUPLICATE",
    "ERR_RESERVED_FUNDS",
    "ERR_SELF_TRANSFER",
    "ERR_CASINO_OPENING_NOT_COMPLETE",
    "ERR_UNKNOWN_OPENING_VERSION",
    "ERR_CORRUPT_BALANCE",
  ] as const;

  it("全エラーコードに固有の利用者向け文言があり、generic に潰れない", () => {
    const messages = CODES.map((code) => describeChipLedgerError(new ChipLedgerError(code), services, "u1"));
    for (const m of messages) {
      expect(m).toBeTruthy();
      expect(m).not.toContain("処理に失敗");
      expect(m).not.toMatch(/^ERR_/); // コードをそのまま見せない
    }
    // 全部が別の文言（＝どれかが取りこぼされて同じ文になっていない）
    expect(new Set(messages).size).toBe(CODES.length);
  });

  it("正式開業前のエラーは専用の案内文へ変換される", () => {
    const msg = describeChipLedgerError(new ChipLedgerError("ERR_CASINO_OPENING_NOT_COMPLETE"), services, "u1");
    expect(msg).toContain("正式開業準備中");
    expect(msg).toContain("既存残高は保持されています");
  });
});

/**
 * PR8監査・項目12: 資金を動かす経路は `services.chips` に一本化する。
 *
 * `services.ether` は読み取り専用の窓として残してあるが、型を狭めただけだと
 * 「新しい production コードが `services.ether.transfer(...)` を書いてしまい、
 * 型エラーに気づかず `as never` で潰す」道が残る。実ファイルを走査して固定する。
 */
describe("services.ether は読み取り専用（項目12）", () => {
  const SRC = fileURLToPath(new URL("../src/", import.meta.url));

  function allSources(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) allSources(full, out);
      else if (name.endsWith(".ts")) out.push(full);
    }
    return out;
  }

  it("production から services.ether 経由で資金を動かす呼び出しが 0 件", () => {
    const banned = /services\.ether\.(deposit|redeem|redeemToAccount|redeemFairToAccount|fundFromAccount|transfer|runGroup|buy|sell|quoteBuy|quoteSell|setReservedProvider|ensureHolder)\b/;
    const offenders = allSources(SRC).filter((f) => banned.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("production に旧 buy / sell / quoteBuy / quoteSell の呼び出しが 0 件", () => {
    const banned = /\.(buy|sell|quoteBuy|quoteSell)\(/;
    const offenders = allSources(SRC).filter((f) => banned.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("production から services.ether を読む箇所も 0 件（読み取りも chips へ一本化）", () => {
    const offenders = allSources(SRC)
      .filter((f) => !f.endsWith(`${join("src", "services.ts")}`))
      .filter((f) => /services\.ether\b/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("services.ether の型は読み取り専用の窓に絞られている", () => {
    const src = readFileSync(join(SRC, "services.ts"), "utf8");
    const view = src.slice(src.indexOf("export interface ChipReadonlyView"), src.indexOf("export function buildServices"));
    // 読める操作だけを持ち、資金を動かす操作は宣言そのものが無い
    for (const allowed of ["balanceOf", "pool", "outstanding", "settleableBalance", "reserveHolder"]) {
      expect(view).toContain(`${allowed}(`);
    }
    for (const denied of ["deposit(", "redeem(", "redeemToAccount(", "fundFromAccount(", "transfer(", "runGroup(", "buy(", "sell("]) {
      expect(view).not.toContain(denied);
    }
    expect(src).toContain("ether: chips as ChipReadonlyView");
  });
});
