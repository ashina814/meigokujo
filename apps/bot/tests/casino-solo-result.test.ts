import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ChipLedgerError } from "@meigokujo/core";
import type { Services } from "../src/services.js";
import { handleCasinoResultButton } from "../src/casino/result-route.js";
import {
  buildSoloResult,
  resultAmountCustomId,
  resultExitCustomId,
  resultGamesCustomId,
  resultRulesCustomId,
  retryCustomIdFor,
} from "../src/casino/solo-result.js";
import { CASINO_SOLO_GAMES, type CasinoSoloGame } from "../src/casino/games.js";

type Phase = "pre_reset" | "formal" | "unknown";

function fakeServices(opts: {
  phase?: Phase;
  status?: string;
  land?: number;
  free?: number;
  escrowed?: number;
  ledgerError?: boolean;
  capacity?: number;
  redeem?: ReturnType<typeof vi.fn>;
} = {}): Services {
  const land = opts.land ?? 1_000;
  const free = opts.free ?? 500;
  const escrowed = opts.escrowed ?? 0;
  return {
    casinoStatus: {
      current: () => ({ status: opts.status ?? "open", reason: "点検中", changedBy: "boss", changedAt: 1 }),
      denyMessage: () => null,
    },
    chipTx: { openingPhase: () => opts.phase ?? "formal" },
    ledger: { balanceOf: () => land },
    chipAssets: {
      forUser: () => {
        if (opts.ledgerError) throw new ChipLedgerError("ERR_CORRUPT_BALANCE");
        return { userId: "u1", freeChips: free, escrowed, total: free + escrowed };
      },
      freeChips: () => {
        if (opts.ledgerError) throw new ChipLedgerError("ERR_CORRUPT_BALANCE");
        return free;
      },
    },
    casino: {
      stats: () => ({ current_win_streak: 0 }),
      availableForLiability: () => opts.capacity ?? 1_000_000,
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
    chipFlow: {
      redeemFreeChips: opts.redeem ?? vi.fn(() => ({ userId: "u1", redeemed: 0, land: 0, reason: "賭場を出る" })),
    },
  } as unknown as Services;
}

function resultJson(opts: Parameters<typeof buildSoloResult>[0]) {
  const payload = buildSoloResult(opts);
  const rows = payload.components!.map((row) => row.toJSON().components);
  return {
    embed: payload.embeds![0]!.toJSON(),
    rows,
    // 段組みは「続ける/離れる」の分け方であって、押せる操作の並び自体は段をまたいで一列
    buttons: rows.flat(),
  };
}

function button(customId: string, userId = "u1") {
  return {
    customId,
    id: "interaction-1",
    user: { id: userId },
    reply: vi.fn().mockResolvedValue(undefined),
    message: { edit: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Parameters<typeof handleCasinoResultButton>[0] & {
    reply: ReturnType<typeof vi.fn>;
    message: { edit: ReturnType<typeof vi.fn> };
  };
}

describe("ソロゲーム共通結果UI", () => {
  it("勝ち/引き分け/負けのタイトル、所持=通常Land+自由チップ、預け中別枠、賭けを表示する", () => {
    const win = resultJson({
      services: fakeServices({ land: 1_000, free: 12_000, escrowed: 777 }),
      userId: "u1",
      game: "丁半",
      net: 500,
      wager: 500,
      retryBet: 500,
    });
    expect(win.embed.title).toContain("勝ち");
    expect(win.embed.title).toContain("+500 Ld");
    // 所持は本文に出す。フッターの極小灰文字だと肝心の数字が読めない
    expect(win.embed.description).toContain("所持 **13,000** Ld");
    expect(win.embed.footer?.text).toContain("預け中 777 Ld");
    expect(win.embed.footer?.text).toContain("賭け 500 Ld");
    // 預け中は所持へ混ぜない
    expect(win.embed.description).not.toContain("13,777");
    expect(win.embed.footer?.text).not.toContain("13,777 Ld");

    expect(resultJson({ services: fakeServices(), userId: "u1", game: "丁半", net: 0, wager: 500, retryBet: 500 }).embed.title).toContain("引き分け");
    expect(resultJson({ services: fakeServices(), userId: "u1", game: "丁半", net: -500, wager: 500, retryBet: 500 }).embed.title).toContain("負け");
    expect(resultJson({ services: fakeServices(), userId: "u1", game: "スロット", net: 500, wager: "無料", retryBet: 100 }).embed.footer?.text).toContain("賭け 無料");
  });

  it("wallet異常は0扱いせず、結果そのものを残して所持だけ確認停止にする", () => {
    for (const services of [
      fakeServices({ ledgerError: true, land: 12_000, free: 500 }),
      fakeServices({ land: Number.MAX_SAFE_INTEGER, free: 10 }),
      fakeServices({ phase: "unknown", land: 12_000, free: 500 }),
    ]) {
      const { embed } = resultJson({ services, userId: "u1", game: "丁半", net: 500, wager: 500, retryBet: 500 });
      expect(embed.title).toContain("+500 Ld");
      // 帳簿が読めていないときに通常Landの額を「所持」として断定しない
      expect(embed.description).toContain("所持 **確認停止**");
      expect(embed.description).toContain("通常Land");
      expect(embed.description).not.toContain("12,500 Ld");
      expect(embed.description).not.toMatch(/所持 \*\*[\d,]/);
    }
  });

  it("結果後アクションは5個・指定順で、retryBetとcustomIdへ反映する", () => {
    const { buttons, rows } = resultJson({
      services: fakeServices({ land: 1_000, free: 0 }),
      userId: "123456789012345678",
      game: "ブラックジャック",
      net: 500,
      wager: 1_000,
      retryBet: 500,
    });
    expect(buttons.map((b) => b.label)).toEqual(["もう一度 500 Ld", "金額を変える", "別の遊び", "ルール", "賭場を出る"]);
    // 「この卓を続ける」と「この卓から離れる」を段で分ける。
    // 5つを1行に詰めると折り返し位置がクライアント幅任せになり、
    // 「別の遊び」の隣に「賭場を出る」が来て誤爆する
    expect(rows.map((row) => row.length)).toEqual([2, 3]);
    expect(buttons[0]!.custom_id).toBe(retryCustomIdFor("ブラックジャック", 500, "123456789012345678"));
    expect(buttons[1]!.custom_id).toBe(resultAmountCustomId("ブラックジャック", "123456789012345678"));
    expect(buttons[2]!.custom_id).toBe(resultGamesCustomId("123456789012345678"));
    expect(buttons[3]!.custom_id).toBe(resultRulesCustomId("ブラックジャック", "123456789012345678"));
    expect(buttons[4]!.custom_id).toBe(resultExitCustomId("123456789012345678"));
    expect(buttons[0]!.disabled).toBe(false);
  });

  it("effectiveMaxBet超過ならretryをdisabledにする", () => {
    const { buttons } = resultJson({
      services: fakeServices({ land: 10_000, free: 0, capacity: 469 }),
      userId: "u1",
      game: "丁半",
      net: 500,
      wager: 500,
      retryBet: 500,
    });
    expect(buttons[0]!.disabled).toBe(true);
  });
});

describe("結果後navigationと退場", () => {
  it("ownerは金額変更・別の遊び・7ゲームのルールを開ける", async () => {
    const services = fakeServices();

    const amount = button(resultAmountCustomId("丁半", "u1"));
    await handleCasinoResultButton(amount, services);
    expect(amount.reply.mock.calls[0]![0].embeds[0].toJSON().author.name).toContain("金額を選ぶ");

    const games = button(resultGamesCustomId("u1"));
    await handleCasinoResultButton(games, services);
    expect(games.reply.mock.calls[0]![0].embeds[0].toJSON().author.name).toContain("遊びを選ぶ");

    for (const game of CASINO_SOLO_GAMES) {
      const rules = button(resultRulesCustomId(game, "u1"));
      await handleCasinoResultButton(rules, services);
      const title = String(rules.reply.mock.calls[0]![0].embeds[0].toJSON().title ?? "");
      expect(title.includes("ルール") || title.includes("配当表")).toBe(true);
    }
  });

  it("非ownerはamount/games/rules/exitを操作できず、redeemも呼ばない", async () => {
    const redeem = vi.fn();
    const services = fakeServices({ redeem });
    for (const id of [
      resultAmountCustomId("丁半", "u1"),
      resultGamesCustomId("u1"),
      resultRulesCustomId("丁半", "u1"),
      resultExitCustomId("u1"),
    ]) {
      const other = button(id, "other");
      await handleCasinoResultButton(other, services);
      expect(other.reply.mock.calls[0]![0].content).toContain("他人");
      expect(other.message.edit).not.toHaveBeenCalled();
    }
    expect(redeem).not.toHaveBeenCalled();
  });

  it("賭場を出るはredeemFreeChipsを既存経路で呼び、成功時だけcomponentsを消す", async () => {
    const redeem = vi.fn(() => ({ userId: "u1", redeemed: 500, land: 500, reason: "賭場を出る" }));
    const interaction = button(resultExitCustomId("u1"));
    await handleCasinoResultButton(interaction, fakeServices({ redeem }));

    expect(redeem).toHaveBeenCalledWith("u1", "interaction-1", "賭場を出る");
    expect(interaction.message.edit).toHaveBeenCalledWith({ components: [] });
    expect(interaction.reply.mock.calls[0]![0].content).toContain("500 LdをLandへ戻して");
  });

  it("redeemFreeChipsがthrowしたらcomponentsを残し、資金返還エラーとして返す", async () => {
    const redeem = vi.fn(() => {
      throw new Error("redeem failed");
    });
    const interaction = button(resultExitCustomId("u1"));

    await handleCasinoResultButton(interaction, fakeServices({ redeem }));

    expect(redeem).toHaveBeenCalledOnce();
    expect(interaction.message.edit).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledOnce();
    expect(interaction.reply.mock.calls[0]![0].content).toContain("自由チップの返還処理でエラー");
    expect(interaction.reply.mock.calls[0]![0].content).not.toContain("資金は動かしていません");
  });

  it("redeem成功後にreplyが失敗しても資金結果をfailureへ再分類せず、二重通知しない", async () => {
    const redeem = vi.fn(() => ({ userId: "u1", redeemed: 500, land: 500, reason: "賭場を出る" }));
    const interaction = button(resultExitCustomId("u1"));
    interaction.reply.mockRejectedValueOnce(new Error("discord reply failed"));

    await handleCasinoResultButton(interaction, fakeServices({ redeem }));

    expect(redeem).toHaveBeenCalledOnce();
    expect(interaction.reply).toHaveBeenCalledOnce();
    expect(interaction.reply.mock.calls[0]![0].content).toContain("500 LdをLandへ戻して");
    expect(interaction.reply.mock.calls[0]![0].content).not.toContain("資金は動かしていません");
    expect(interaction.message.edit).toHaveBeenCalledWith({ components: [] });
  });

  it("自由チップ0は正常退場、active_ownership skipはcomponentsを維持する", async () => {
    const zero = button(resultExitCustomId("u1"));
    await handleCasinoResultButton(zero, fakeServices({
      redeem: vi.fn(() => ({ userId: "u1", redeemed: 0, land: 0, reason: "賭場を出る" })),
    }));
    expect(zero.message.edit).toHaveBeenCalledWith({ components: [] });
    expect(zero.reply.mock.calls[0]![0].content).toContain("戻す自由チップはありません");

    const active = button(resultExitCustomId("u1"));
    await handleCasinoResultButton(active, fakeServices({
      redeem: vi.fn(() => ({ userId: "u1", redeemed: 0, land: 0, reason: "賭場を出る", skipped: "active_ownership" })),
    }));
    expect(active.message.edit).not.toHaveBeenCalled();
    expect(active.reply.mock.calls[0]![0].content).toContain("進行中");
  });
});

describe("PR18境界", () => {
  it("7ゲームの最終結果は共通builderを参照し、retry collectorは持たない", () => {
    for (const file of ["slots", "chohan", "crash", "chinchiro", "blackjack", "poker", "holdem"]) {
      const source = readFileSync(join(process.cwd(), "src", "casino", `${file}.ts`), "utf8");
      expect(source).toContain("buildSoloResult");
      expect(source).not.toContain("handleRetryPress");
      expect(source).not.toMatch(/(?:slots|chohan|crash|chinchiro|bj|poker|holdem):retry:/);
      expect(source).not.toContain("casino:play:");
    }
  });

  it("進行中操作のcollector用customIdは各ゲームに残す", () => {
    const expected = {
      chohan: ["chohan:cho", "chohan:han"],
      crash: ["crash:out"],
      chinchiro: ["chinchiro:stop", "chinchiro:reroll"],
      blackjack: ["bj:hit", "bj:stand", "bj:double"],
      poker: ["poker:hold:", "poker:draw"],
      holdem: ["holdem:call", "holdem:check", "holdem:fold"],
    } as const;
    for (const [file, ids] of Object.entries(expected)) {
      const source = readFileSync(join(process.cwd(), "src", "casino", `${file}.ts`), "utf8");
      for (const id of ids) expect(source).toContain(id);
    }
  });

  it("スロットのpending free spin中間結果には共通5ボタンを出さない", () => {
    const source = readFileSync(join(process.cwd(), "src", "casino", "slots.ts"), "utf8");
    const pending = source.indexOf("if (record.pendingFreeSpin)");
    const noComponents = source.indexOf("components: []", pending);
    const recursiveSpin = source.indexOf("await renderSpin(interaction, services, bet, free, true", pending);
    expect(pending).toBeGreaterThan(-1);
    expect(noComponents).toBeGreaterThan(pending);
    expect(noComponents).toBeLessThan(recursiveSpin);
  });
});
