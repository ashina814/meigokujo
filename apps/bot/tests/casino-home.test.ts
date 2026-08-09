import { describe, expect, it, vi } from "vitest";
import type { Interaction } from "discord.js";
import { ChipLedgerError } from "@meigokujo/core";
import type { Services } from "../src/services.js";
import { isCasinoInteraction, denyIfCasinoClosed } from "../src/casino/gate.js";
import { isCasinoPrimaryButton } from "../src/casino/play-route.js";
import { renderCasinoHome } from "../src/commands/casino-home.js";

type Phase = "pre_reset" | "formal" | "unknown";

function fakeServices(opts: {
  phase?: Phase;
  status?: string;
  free?: number;
  escrowed?: number;
  land?: number;
  jp?: number;
  nextClaimAt?: number;
  pref?: { game: string; amount: number } | null;
  maxLiability?: number;
  jpThrows?: boolean;
  ledgerError?: boolean;
} = {}): Services {
  const phase = opts.phase ?? "formal";
  const status = opts.status ?? "open";
  const free = opts.free ?? 12_400;
  const escrowed = opts.escrowed ?? 0;
  const land = opts.land ?? 99_999;
  const jp = opts.jp ?? 8_420;
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
      jackpotPool: () => {
        if (opts.jpThrows) throw new Error("jackpot should not be read");
        return jp;
      },
      stats: () => ({ current_win_streak: 0 }),
      availableForLiability: () => opts.maxLiability ?? 1_000_000,
      homePreference: () =>
        opts.pref
          ? { user_id: "u1", last_game: opts.pref.game, last_amount: opts.pref.amount, updated_at: 1 }
          : null,
    },
    daily: {
      nextClaimAt: () => opts.nextClaimAt ?? 0,
    },
    vip: {
      isVip: () => false,
      betCapMult: () => 2,
    },
    items: {
      armedWinBonusCap: () => 0,
    },
    dailyRisk: {
      maxBetForPlayerLoss: (_userId: string, _lossPerBet: (bet: number) => number, cap: number) => cap,
    },
  } as unknown as Services;
}

function homeJson(services: Services) {
  const payload = renderCasinoHome("u1", services, "冥獄城");
  const embed = payload.embeds[0]!.toJSON();
  const rows = payload.components.map((row) => row.toJSON());
  const buttons = rows.flatMap((row) => row.components);
  return { embed, rows, buttons };
}

function component(customId: string): Interaction & { reply: ReturnType<typeof vi.fn> } {
  return {
    isChatInputCommand: () => false,
    customId,
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Interaction & { reply: ReturnType<typeof vi.fn> };
}

describe("/賭場 ホーム", () => {
  it("ホームを生成し、6ボタン・2行以内に収める", () => {
    const { embed, rows, buttons } = homeJson(fakeServices());
    expect(embed.author?.name).toContain("冥獄城 · マモンの賭場");
    expect(rows).toHaveLength(2);
    expect(buttons).toHaveLength(6);
  });

  it("legacy_pre_reset では正式開業準備中を表示し、操作ボタンを押せる見た目にしない", async () => {
    const services = fakeServices({ phase: "pre_reset", land: 50_000, ledgerError: true });
    const { embed, buttons } = homeJson(services);
    expect(embed.description).toContain("正式開業準備中");
    expect(embed.description).toContain("通常Land 50,000 Ld");
    expect(embed.description).toContain("自由チップは正式開業まで利用できません");
    expect(embed.description).toContain("資金操作");
    expect(embed.description).toContain("福分けは正式開業後に利用できます");
    expect(buttons.find((b) => b.custom_id === "casino:primary:スロット:100")?.disabled).toBe(true);

    const stale = component("casino:primary:スロット:100");
    expect(await denyIfCasinoClosed(stale, services)).toBe(true);
    expect((stale.reply.mock.calls[0]![0] as { content: string }).content).toContain("正式開業準備中");
  });

  it("unknown opening version では通常Landだけを残してfail-closed表示になり、操作を通さない", async () => {
    const services = fakeServices({ phase: "unknown", land: 50_000, free: 12_400, jpThrows: true });
    const { embed } = homeJson(services);
    expect(embed.description).toContain("版が異常");
    expect(embed.description).toContain("所持 50,000 Ld（通常Landのみ）");
    expect(embed.description).toContain("自由チップ・預け中資金は確認できません");
    expect(embed.description).not.toContain("62,400 Ld");
    expect(embed.description).toContain("福分け 確認停止");
    expect(embed.description).toContain("JP 確認停止");
    expect(embed.description).not.toContain("JP 8,420 Ld");

    const stale = component("casino:daily:claim");
    expect(await denyIfCasinoClosed(stale, services)).toBe(true);
    expect((stale.reply.mock.calls[0]![0] as { content: string }).content).toContain("版が異常");
  });

  it("formal opening では通常Land + 自由チップを所持として表示し、escrowedは別行にする", () => {
    const { embed } = homeJson(fakeServices({ phase: "formal", land: 50_000, free: 12_400, escrowed: 500 }));
    // ホームで真っ先に読みたい額なので見出しへ上げる（内訳と同じ字送りだと探す手間が生まれる）
    expect(embed.description).toContain("## 所持 62,400 Ld");
    expect(embed.description).toContain("預け中 500 Ld");
    expect(embed.description).not.toContain("62,900 Ld");
    expect(embed.footer?.text).toBe("通常Land 50,000 Ld · 自由チップ 12,400 Ld · 預け中 500 Ld");
  });

  it("formalでチップ帳簿を読めない場合は破損値を0扱いせず通常Landだけを表示する", () => {
    const { embed } = homeJson(fakeServices({ phase: "formal", land: 50_000, free: 12_400, ledgerError: true }));
    expect(embed.description).toContain("所持 50,000 Ld（通常Landのみ）");
    expect(embed.description).toContain("チップ帳簿を確認できません");
    expect(embed.description).not.toContain("62,400 Ld");
    expect(embed.footer?.text).toBe("チップ帳簿エラー");
  });

  it("safe integer overflowは正常な所持額として表示せず通常Landだけにfail-closedする", () => {
    const { embed } = homeJson(fakeServices({
      phase: "formal",
      land: Number.MAX_SAFE_INTEGER,
      free: 10,
      escrowed: 500,
    }));
    expect(embed.description).toContain("所持 9,007,199,254,740,991 Ld（通常Landのみ）");
    expect(embed.description).toContain("残高の合算に失敗しました");
    expect(embed.description).not.toContain("預け中 500 Ld");
    expect(embed.footer?.text).toBe("残高合算エラー");
  });

  it("JP実残高とDaily受取可能/不可を表示する", () => {
    expect(homeJson(fakeServices({ jp: 8_420, nextClaimAt: 0 })).embed.description).toContain("JP 8,420 Ld");
    expect(homeJson(fakeServices({ nextClaimAt: Math.floor(Date.now() / 1000) + 3600 })).embed.description).toContain("まだ");
  });

  it("初回利用者のprimary actionは既存スロット100Ld開始routeへ向く", () => {
    const { buttons } = homeJson(fakeServices({ pref: null }));
    const primary = buttons[0]!;
    expect(primary.label).toBe("100 Ldで遊ぶ");
    expect(primary.custom_id).toBe("casino:primary:スロット:100");
    expect(isCasinoPrimaryButton(primary.custom_id!)).toBe(true);
  });

  it("再訪者のlast game/amountが実行可能ならprimary actionへ反映する", () => {
    const { buttons } = homeJson(fakeServices({ pref: { game: "丁半", amount: 500 }, free: 1_000 }));
    const primary = buttons[0]!;
    expect(primary.label).toContain("丁半 500 Ldでもう一度");
    expect(primary.custom_id).toBe("casino:primary:丁半:500");
  });

  it("古いlast amountが現在実行不能なら安全確認なしに開始せず、初期ボタンへfallbackする", () => {
    const { buttons } = homeJson(fakeServices({ pref: { game: "丁半", amount: 900_000 }, free: 1_000 }));
    expect(buttons[0]!.custom_id).toBe("casino:primary:スロット:100");
  });

  it("casino statusが停止中でもホームは読めるが、資金操作は突破できない", async () => {
    const services = fakeServices({ status: "maintenance" });
    const { embed, buttons } = homeJson(services);
    expect(embed.description).toContain("maintenance");
    expect(embed.description).toContain("福分けは現在停止中");
    expect(buttons[0]!.disabled).toBe(true);

    const stale = component("casino:primary:スロット:100");
    expect(await denyIfCasinoClosed(stale, services)).toBe(true);
    expect((stale.reply.mock.calls[0]![0] as { content: string }).content).toContain("点検中");
  });

  it("既存イベントLand板はホーム追加後も賭場gateへ巻き込まれない", () => {
    expect(isCasinoInteraction(component("itaevt:bet:1"))).toBe(false);
    expect(isCasinoInteraction(component("casino:daily:claim"))).toBe(true);
  });
});
