import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MessageFlags, type ButtonInteraction, type SlashCommandBuilder } from "discord.js";
import {
  installablePanelChoices,
  removablePanelChoices,
  retiredPanelChoices,
} from "../src/commands/panel-kinds.js";

let panelCommand: SlashCommandBuilder;
let panelRemoveCommand: SlashCommandBuilder;

beforeAll(async () => {
  // bank-panel.ts は shokan -> permissions -> config を経由する。
  // CI には本番用 Discord credentials が無いので、module load 前にテスト値を入れる。
  vi.stubEnv("DISCORD_TOKEN", "test-token");
  vi.stubEnv("CLIENT_ID", "test-client");
  vi.stubEnv("OWNER_ID", "test-owner");
  ({ panelCommand, panelRemoveCommand } = await import("../src/commands/bank-panel.js"));
});

afterAll(() => {
  vi.unstubAllEnvs();
});

function choiceValues(cmd: SlashCommandBuilder): string[] {
  const json = cmd.toJSON();
  const opt = json.options?.find((o) => o.name === "種別") as { choices?: Array<{ value: string }> } | undefined;
  return (opt?.choices ?? []).map((c) => c.value);
}

function fakeCasinoServices(opts: { phase?: "pre_reset" | "formal" | "unknown"; status?: string } = {}) {
  const phase = opts.phase ?? "formal";
  const status = opts.status ?? "open";
  const metricRecord = vi.fn();
  return {
    services: {
      casinoStatus: {
        current: () => ({ status, reason: "点検中", changedBy: "test", changedAt: 1 }),
      },
      chipTx: { openingPhase: () => phase },
      ledger: { balanceOf: () => 10_000 },
      chipAssets: {
        forUser: () => ({ userId: "u1", freeChips: 0, escrowed: 0, total: 0 }),
        freeChips: () => 0,
      },
      casino: {
        jackpotPool: () => 0,
        stats: () => ({ current_win_streak: 0 }),
        availableForLiability: () => 1_000_000,
        homePreference: () => null,
      },
      daily: { nextClaimAt: () => 0 },
      vip: { isVip: () => false, betCapMult: () => 2 },
      items: { armedWinBonusCap: () => 0 },
      dailyRisk: {
        maxBetForPlayerLoss: (_userId: string, _lossPerBet: (bet: number) => number, cap: number) => cap,
      },
      casinoMetrics: { record: metricRecord },
    } as never,
    metricRecord,
  };
}

/**
 * パネル種別の選択肢が単一の表から生成されることを、実際の SlashCommandBuilder 出力で固定する。
 * `Record<PanelKind, ...>` の描画網羅は TypeScript の typecheck が担う。
 */
describe("パネル種別は単一の表から生成される", () => {
  it("/パネル設置 の選択肢が installable と一致する", () => {
    expect(choiceValues(panelCommand)).toEqual(installablePanelChoices().map((c) => c.value));
  });

  it("/パネル撤去 の選択肢が installable + 廃止済み と一致する", () => {
    expect(choiceValues(panelRemoveCommand)).toEqual(removablePanelChoices().map((c) => c.value));
  });

  it("かつて落ちていた種別が設置経路に載っている", () => {
    const installable = installablePanelChoices().map((c) => c.value);
    expect(installable).toContain("confession");
    expect(installable).toContain("shop_admin");
  });

  it("廃止済み種別は設置できず撤去だけできる", () => {
    const installable = installablePanelChoices().map((c) => c.value);
    const removable = removablePanelChoices().map((c) => c.value);
    for (const { value } of retiredPanelChoices()) {
      expect(installable, `${value} が設置できてしまう`).not.toContain(value);
      expect(removable, `${value} が撤去できない`).toContain(value);
    }
    expect(retiredPanelChoices().map((c) => c.value)).toEqual(["entry_flex"]);
  });

  it("stale な外部設置経路でも廃止済み種別を新規設置できない", async () => {
    const { panelMessageForExternal } = await import("../src/commands/bank-panel.js");
    expect(() => panelMessageForExternal("entry_flex", {} as never, "channel-1")).toThrow(
      "panel kind is not installable: entry_flex",
    );
  });

  it("部署依存パネルは部署選択済みでなければ外部設置できない", async () => {
    const { panelMessageForExternal } = await import("../src/commands/bank-panel.js");
    const services = { settings: { getString: () => null } } as never;
    expect(() => panelMessageForExternal("dept", services, "channel-1")).toThrow(
      "panel kind requires department selection: dept",
    );
  });
});

describe("賭場の常設パネル", () => {
  it("設置できる種別として登録されている", () => {
    expect(installablePanelChoices().map((c) => c.value)).toContain("casino");
  });

  it("実際の入口ボタンを押すと既存の賭場ホームを本人だけに返す", async () => {
    const { CASINO_PANEL_OPEN, casinoPanelMessage, handleCasinoHomeButton } = await import("../src/commands/casino-home.js");
    const { services, metricRecord } = fakeCasinoServices();
    const panel = casinoPanelMessage(services);
    const row = panel.components?.[0];
    if (!row || !("toJSON" in row)) throw new Error("casino panel action row is missing");
    const rowJson = row.toJSON() as { components?: Array<{ custom_id?: string }> };
    const actualCustomId = rowJson.components?.[0]?.custom_id;
    expect(actualCustomId).toBe(CASINO_PANEL_OPEN);

    const reply = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: actualCustomId!,
      id: "panel-open-1",
      user: { id: "u1" },
      guild: { name: "冥獄城" },
      reply,
      update,
    } as unknown as ButtonInteraction;

    await handleCasinoHomeButton(interaction, services);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    const payload = reply.mock.calls[0]![0] as {
      flags?: number;
      embeds?: Array<{ toJSON(): { author?: { name?: string } } }>;
    };
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.embeds?.[0]?.toJSON().author?.name).toContain("マモンの賭場");
    expect(metricRecord).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "home_open",
      payload: { source: "panel" },
    }));
  });

  it("全員が見る1枚なので個人情報を出さず、営業状態が変わっても看板本文は変わらない", async () => {
    const { casinoPanelMessage } = await import("../src/commands/casino-home.js");
    const formal = casinoPanelMessage(fakeCasinoServices({ phase: "formal", status: "open" }).services);
    const stopped = casinoPanelMessage(fakeCasinoServices({ phase: "pre_reset", status: "maintenance" }).services);
    const json = JSON.stringify(formal);

    // 「福分け」は静的な機能名なので公開看板へ書いてよい。利用者ごとの可否・残高だけを出さない。
    expect(json).toContain("福分け");
    for (const personal of ["所持", "残高", "JP "]) {
      expect(json, `${personal} が常設パネルに出ている`).not.toContain(personal);
    }
    expect(JSON.stringify(stopped)).toBe(json);
    expect(formal.components).toHaveLength(1);
  });
});

describe("ゲームパネルと施設パネル", () => {
  it("どちらも設置できる種別として登録されている", () => {
    const installable = installablePanelChoices().map((c) => c.value);
    expect(installable).toContain("casino_games");
    expect(installable).toContain("casino_facility");
  });

  it("営業状態が変わっても看板本文は変わらない", async () => {
    const { casinoFacilityPanelMessage } = await import("../src/commands/casino-home.js");
    const { casinoSoloPanelMessage } = await import("../src/commands/casino-dedicated-panels.js");
    for (const render of [casinoSoloPanelMessage, casinoFacilityPanelMessage]) {
      const formal = render(fakeCasinoServices({ phase: "formal", status: "open" }).services);
      const stopped = render(fakeCasinoServices({ phase: "pre_reset", status: "maintenance" }).services);
      expect(JSON.stringify(stopped)).toBe(JSON.stringify(formal));
    }
  });

  it("全員が見る1枚なので個人情報を出さない", async () => {
    const { casinoFacilityPanelMessage } = await import("../src/commands/casino-home.js");
    const { casinoSoloPanelMessage } = await import("../src/commands/casino-dedicated-panels.js");
    const { services } = fakeCasinoServices();
    for (const render of [casinoSoloPanelMessage, casinoFacilityPanelMessage]) {
      const json = JSON.stringify(render(services));
      for (const personal of ["所持", "残高", "JP "]) {
        expect(json, personal + " が常設パネルに出ている").not.toContain(personal);
      }
    }
  });

  it("ボタンはすべて賭場ハブへ流れる接頭辞を使う", async () => {
    const { casinoFacilityPanelMessage } = await import("../src/commands/casino-home.js");
    const { casinoSoloPanelMessage } = await import("../src/commands/casino-dedicated-panels.js");
    const { services } = fakeCasinoServices();
    const ids: string[] = [];
    for (const render of [casinoSoloPanelMessage, casinoFacilityPanelMessage]) {
      for (const row of render(services).components ?? []) {
        const json = (row as { toJSON(): { components?: Array<{ custom_id?: string }> } }).toJSON();
        for (const c of json.components ?? []) if (c.custom_id) ids.push(c.custom_id);
      }
    }
    expect(ids.length).toBeGreaterThan(0);
    // index.ts は casino:home: / casino:daily: だけを賭場ハブへ流す。
    // ここを外すとボタンが無反応になる
    for (const id of ids) {
      expect(id.startsWith("casino:home:") || id.startsWith("casino:daily:"), id + " がハブ経路から外れている").toBe(true);
    }
  });

  it("競馬・板・VIP・流れ星がコマンドへ突き返す行き止まりに戻っていない", () => {
    const source = readFileSync(new URL("../src/commands/casino-home.ts", import.meta.url), "utf8");
    // かつては SIDE_GAME_GUIDE が「チャンネルで /競馬 を実行してください」と返すだけだった
    expect(source).not.toContain("SIDE_GAME_GUIDE");
    for (const nudge of ["チャンネルで `/競馬`", "チャンネルで `/板", "`/vip` で条件", "`/流れ星` で引けます"]) {
      expect(source, nudge + " という案内が復活している").not.toContain(nudge);
    }
    // 実処理へ繋がっていること
    expect(source).toContain("await playKeiba(interaction, services)");
    expect(source).toContain("await interaction.showModal(itaCreateModal())");
    expect(source).toContain("renderVipStatus(interaction.user.id, services)");
    expect(source).toContain("await handleNagareboshiCommand(interaction, services)");
  });

  it("板の作成はコマンドとモーダルが同じ経路を通る", () => {
    const source = readFileSync(new URL("../src/commands/ita.ts", import.meta.url), "utf8");
    const calls = source.split("await createMarket(").length - 1;
    expect(calls, "createMarket の呼び出しが2経路そろっていない").toBe(2);
    expect(source).toContain("ITA_CREATE_MODAL");
  });
});

describe("公開パネルのボタンは公開メッセージを壊さない", () => {
  /** 公開（=非ephemeral）メッセージ上のボタンとして押された状況を作る */
  function publicButton(customId: string, reply: unknown, update: unknown) {
    return {
      customId,
      id: "op-1",
      user: { id: "u1" },
      guild: { name: "冥獄城" },
      message: { flags: { has: () => false } },
      reply,
      update,
    } as never;
  }

  it("施設パネルのLand引き出しは看板を書き換えず、本人にだけ返す", async () => {
    const { handleCasinoHomeButton } = await import("../src/commands/casino-home.js");
    const { services } = fakeCasinoServices();
    const reply = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);

    await handleCasinoHomeButton(publicButton("casino:home:leave", reply, update), {
      ...services,
      chipFlow: { leaveCasino: () => ({ skipped: null, redeemed: 0, land: 0 }) },
    } as never);

    // update() は元メッセージ（=公開看板）を書き換えるので、公開経路では絶対に呼ばない
    expect(update, "公開パネルを書き換えている").not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    expect((reply.mock.calls[0]![0] as { flags?: number }).flags).toBe(MessageFlags.Ephemeral);
  });

  it("本人だけのホーム上では従来どおり差し替える", async () => {
    const { handleCasinoHomeButton } = await import("../src/commands/casino-home.js");
    const { services } = fakeCasinoServices();
    const reply = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const ephemeral = { ...publicButton("casino:home:leave", reply, update), message: { flags: { has: () => true } } } as never;

    await handleCasinoHomeButton(ephemeral, {
      ...services,
      chipFlow: { leaveCasino: () => ({ skipped: null, redeemed: 0, land: 0 }) },
    } as never);

    expect(update).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
  });
});

describe("停止ガードは資金操作と読み取りを取り違えない", () => {
  const asButton = (customId: string) => ({ customId, isChatInputCommand: () => false }) as never;

  it("実処理へ繋がった casino:home:* は停止ガードの対象", async () => {
    const { isCasinoInteraction } = await import("../src/casino/gate.js");
    for (const id of ["casino:home:keiba", "casino:home:ita", "casino:home:hoshi", "casino:home:leave"]) {
      expect(isCasinoInteraction(asButton(id)), id + " がガードされていない").toBe(true);
    }
  });

  it("読み取り専用の casino:home:* は停止中も通す", async () => {
    const { isCasinoInteraction } = await import("../src/casino/gate.js");
    // casino:home: を接頭辞で丸ごとガードすると、停止中に通行証も番付も開けなくなる
    for (const id of [
      "casino:home:panel-open",
      "casino:home:passport",
      "casino:home:banzuke",
      "casino:home:vip",
      "casino:home:first",
      "casino:home:back",
    ]) {
      expect(isCasinoInteraction(asButton(id)), id + " まで閉じている").toBe(false);
    }
  });
});
