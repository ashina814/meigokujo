import { describe, expect, it, vi } from "vitest";
import { MessageFlags } from "discord.js";
import { ChipLedgerError } from "@meigokujo/core";
import type { Services } from "../src/services.js";
import {
  CASINO_GAME_SELECT_CUSTOM_ID,
  handleCasinoAmountModal,
  handleCasinoGameSelect,
  renderCasinoAmountPicker,
  renderCasinoGameSelect,
} from "../src/casino/amount-picker.js";
import { parseCasinoPlayButton } from "../src/casino/play-route.js";

type Phase = "pre_reset" | "formal" | "unknown";

function fakeServices(opts: {
  phase?: Phase;
  status?: string;
  free?: number;
  escrowed?: number;
  land?: number;
  maxLiability?: number;
  capacityThrows?: boolean;
  ledgerError?: boolean;
} = {}): Services {
  const phase = opts.phase ?? "formal";
  const status = opts.status ?? "open";
  const free = opts.free ?? 1_000;
  const escrowed = opts.escrowed ?? 0;
  const land = opts.land ?? 1_000;
  return {
    casinoStatus: {
      current: () => ({ status, reason: "点検中", changedBy: "boss", changedAt: 1 }),
      denyMessage: () => (status === "open" ? null : "賭場は点検中です。"),
    },
    chipTx: { openingPhase: () => phase },
    ledger: { balanceOf: () => land },
    chipAssets: {
      forUser: () => {
        if (opts.ledgerError) throw new ChipLedgerError("ERR_CORRUPT_BALANCE");
        return { userId: "u1", freeChips: free, escrowed, total: free + escrowed };
      },
      freeChips: () => free,
    },
    casino: {
      stats: () => ({ current_win_streak: 0 }),
      availableForLiability: () => {
        if (opts.capacityThrows) throw new Error("capacity unavailable");
        return opts.maxLiability ?? 1_000_000;
      },
    },
    vip: {
      isVip: () => false,
      betCapMult: () => 2,
    },
    items: {
      armedWinBonusCap: () => 0,
    },
  } as unknown as Services;
}

function buttons(payload: ReturnType<typeof renderCasinoAmountPicker>) {
  return payload.components!.flatMap((row) => row.toJSON().components);
}

function embedsDescription(payload: ReturnType<typeof renderCasinoAmountPicker>) {
  return payload.embeds![0]!.toJSON().description ?? "";
}

function gameSelectInteraction(value: string) {
  return {
    values: [value],
    user: { id: "u1" },
    customId: CASINO_GAME_SELECT_CUSTOM_ID,
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Parameters<typeof handleCasinoGameSelect>[0] & { reply: ReturnType<typeof vi.fn> };
}

function modalInteraction(game: string, value: string) {
  return {
    customId: `casino:amount:modal:${game}`,
    user: { id: "u1" },
    fields: { getTextInputValue: vi.fn().mockReturnValue(value) },
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Parameters<typeof handleCasinoAmountModal>[0] & { reply: ReturnType<typeof vi.fn> };
}

describe("賭場ホームの遊び・金額選択", () => {
  it("遊び選択は7ゲームだけを表示し、ルーレットを含めない", () => {
    const payload = renderCasinoGameSelect();
    const options = payload.components![0]!.toJSON().components[0]!.options;
    expect(options.map((o) => o.value)).toEqual([
      "スロット",
      "丁半",
      "クラッシュ",
      "チンチロ",
      "ブラックジャック",
      "ポーカー",
      "ホールデム",
    ]);
    expect(options.map((o) => o.value)).not.toContain("ルーレット");
  });

  it("pre-openingでも遊び選択は読めるが、金額操作は全てdisabledになる", async () => {
    const services = fakeServices({ phase: "pre_reset", land: 50_000, ledgerError: true });
    const interaction = gameSelectInteraction("スロット");
    await handleCasinoGameSelect(interaction, services);
    const reply = interaction.reply.mock.calls[0]![0] as Parameters<typeof interaction.reply>[0];
    const actionButtons = reply.components!.flatMap((row) => row.toJSON().components);
    expect(actionButtons).toHaveLength(5);
    expect(actionButtons.every((b) => b.disabled === true)).toBe(true);
    expect((reply.embeds![0]!.toJSON().description ?? "")).toContain("正式開業準備中");
  });

  it("固定金額は常に表示し、利用可能額は通常Land + 自由チップで預け中を含めない", () => {
    const payload = renderCasinoAmountPicker("u1", "丁半", fakeServices({ land: 300, free: 300, escrowed: 10_000 }));
    const actionButtons = buttons(payload);
    expect(actionButtons.map((b) => b.label)).toEqual(["100", "500", "2,000", "10,000", "自由入力"]);
    expect(actionButtons.find((b) => b.custom_id === "casino:play:丁半:500")?.disabled).toBe(false);
    expect(actionButtons.find((b) => b.custom_id === "casino:play:丁半:2000")?.disabled).toBe(true);
    expect(embedsDescription(payload)).toContain("所持 600 Ld");
    expect(embedsDescription(payload)).toContain("預け中 10,000 Ld");
    expect(embedsDescription(payload)).not.toContain("10,600 Ld");
  });

  it("胴元上限を超える固定金額はdisabledになり、上限確認失敗時はfail-closedになる", () => {
    const capped = renderCasinoAmountPicker("u1", "丁半", fakeServices({ land: 10_000, free: 10_000, maxLiability: 469 }));
    expect(buttons(capped).find((b) => b.custom_id === "casino:play:丁半:100")?.disabled).toBe(false);
    expect(buttons(capped).find((b) => b.custom_id === "casino:play:丁半:500")?.disabled).toBe(true);

    const closed = renderCasinoAmountPicker("u1", "丁半", fakeServices({ capacityThrows: true }));
    expect(buttons(closed).every((b) => b.disabled === true)).toBe(true);
    expect(embedsDescription(closed)).toContain("上限確認停止");
  });

  it("チンチロはcoreの最大損失2倍で所持額を判定する", () => {
    const short = renderCasinoAmountPicker("u1", "チンチロ", fakeServices({ land: 999, free: 0 }));
    expect(buttons(short).find((b) => b.custom_id === "casino:play:チンチロ:500")?.disabled).toBe(true);
    expect(buttons(short).find((b) => b.custom_id === "casino:play:チンチロ:500")?.label).toContain("最大1,000");

    const exact = renderCasinoAmountPicker("u1", "チンチロ", fakeServices({ land: 1_000, free: 0 }));
    expect(buttons(exact).find((b) => b.custom_id === "casino:play:チンチロ:500")?.disabled).toBe(false);
  });

  it("停止中・未知版・帳簿異常は正常な金額操作として表示しない", () => {
    for (const services of [
      fakeServices({ status: "maintenance" }),
      fakeServices({ phase: "unknown" }),
      fakeServices({ ledgerError: true }),
    ]) {
      const payload = renderCasinoAmountPicker("u1", "スロット", services);
      expect(buttons(payload).every((b) => b.disabled === true)).toBe(true);
    }
  });

  it("カスタム入力は厳格な整数だけを受け、確認ボタンを返してゲーム本体は呼ばない", async () => {
    const services = fakeServices({ land: 10_000, free: 0, maxLiability: 10_000 });
    const ok = modalInteraction("丁半", " 500 ");
    await handleCasinoAmountModal(ok, services);
    const reply = ok.reply.mock.calls[0]![0] as Parameters<typeof ok.reply>[0];
    expect(reply.flags).toBe(MessageFlags.Ephemeral);
    expect(reply.components![0]!.toJSON().components[0]!.custom_id).toBe("casino:play:丁半:500");

    for (const value of ["", "0", "-1", "100.9", "1e3", "Infinity", "9007199254740992", "4"]) {
      const invalid = modalInteraction("丁半", value);
      await handleCasinoAmountModal(invalid, services);
      const invalidReply = invalid.reply.mock.calls[0]![0] as Parameters<typeof invalid.reply>[0];
      expect(invalidReply.components ?? []).toEqual([]);
      expect(invalidReply.content).toContain("❌");
    }
  });

  it("カスタム入力は所持額・胴元上限・チンチロ最大損失を超える額を拒否する", async () => {
    const tooMuchWallet = modalInteraction("丁半", "2001");
    await handleCasinoAmountModal(tooMuchWallet, fakeServices({ land: 2_000, free: 0, maxLiability: 10_000 }));
    expect((tooMuchWallet.reply.mock.calls[0]![0] as { content: string }).content).toContain("所持額");

    const tooMuchHouse = modalInteraction("丁半", "501");
    await handleCasinoAmountModal(tooMuchHouse, fakeServices({ land: 10_000, free: 0, maxLiability: 469 }));
    expect((tooMuchHouse.reply.mock.calls[0]![0] as { content: string }).content).toContain("上限");

    const tooMuchChinchiro = modalInteraction("チンチロ", "501");
    await handleCasinoAmountModal(tooMuchChinchiro, fakeServices({ land: 1_000, free: 0, maxLiability: 10_000 }));
    expect((tooMuchChinchiro.reply.mock.calls[0]![0] as { content: string }).content).toContain("最大損失");
  });

  it("casino:play は既存の正常形だけを厳格にパースする", () => {
    expect(parseCasinoPlayButton("casino:play:スロット:100")).toEqual({ ok: true, game: "スロット", amount: 100 });
    for (const id of [
      "casino:play:ルーレット:100",
      "casino:play:スロット:100.9",
      "casino:play:スロット:1e3",
      "casino:play:スロット:-100",
      "casino:play:スロット:Infinity",
      "casino:play:スロット:9007199254740992",
      "casino:play:スロット:100:extra",
    ]) {
      expect(parseCasinoPlayButton(id)).toEqual({ ok: false });
    }
  });
});
