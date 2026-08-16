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
 * パネル種別の選択肢が単一の表から生成されていることを、実際の SlashCommandBuilder 出力で固定する。
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
});

describe("賭場の常設パネル", () => {
  it("設置できる種別として登録されている", () => {
    expect(installablePanelChoices().map((c) => c.value)).toContain("casino");
  });

  it("入口ボタンを押すと既存の賭場ホームを本人だけに返す", async () => {
    const { CASINO_PANEL_OPEN, handleCasinoHomeButton } = await import("../src/commands/casino-home.js");
    const { services, metricRecord } = fakeCasinoServices();
    const reply = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: CASINO_PANEL_OPEN,
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

    for (const personal of ["福分け", "所持", "残高", "JP "]) {
      expect(json, `${personal} が常設パネルに出ている`).not.toContain(personal);
    }
    expect(JSON.stringify(stopped)).toBe(json);
    expect(formal.components).toHaveLength(1);
  });
});
