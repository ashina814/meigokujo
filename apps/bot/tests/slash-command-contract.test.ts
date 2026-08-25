import { describe, expect, it, vi } from "vitest";
import { STOCKS_PAUSE_REASON, replyStocksPaused } from "../src/casino/stocks-pause.js";
import { ACTIVE_SLASH_COMMAND_ROUTES } from "../src/commands/active-slash-command-routes.js";
import { CASINO_STOCKS_PAUSED_GUIDANCE } from "../src/commands/casino-home.js";
import { handleHelpCommand } from "../src/commands/help.js";
import {
  LEGACY_COMPAT_SLASH_NAMES,
  LEGACY_COMPAT_SLASH_ROUTES,
  getLegacyCompatSlashCommandRoute,
} from "../src/commands/legacy-compat-slash-command-routes.js";
import { ACTIVE_SLASH_COMMAND_BUILDERS } from "../src/commands/slash-command-builders.js";
import {
  ACTIVE_SLASH_COMMAND_NAMES,
  RETIRED_SLASH_COMMAND_NAMES,
} from "../src/commands/slash-command-kinds.js";
import { buildRegistrationPayload, resolveRegistrationTarget } from "../src/commands/slash-command-registration.js";

const RETIRED_CASINO_NAMES = [
  "遊ぶ",
  "福分け",
  "賭場番付",
  "賭場商店",
  "競馬",
  "案内",
  "vip",
  "流れ星",
  "勝負",
  "株",
] as const;

const payloadNames = () => buildRegistrationPayload().map(({ name }) => name);

describe("slash command classification SSOT", () => {
  it("A/B: ACTIVEとRETIREDの各nameにduplicateがない", () => {
    expect(new Set(ACTIVE_SLASH_COMMAND_NAMES).size).toBe(ACTIVE_SLASH_COMMAND_NAMES.length);
    expect(new Set(RETIRED_SLASH_COMMAND_NAMES).size).toBe(RETIRED_SLASH_COMMAND_NAMES.length);
  });

  it("C: ACTIVEとRETIREDは排他的", () => {
    const active = new Set<string>(ACTIVE_SLASH_COMMAND_NAMES);
    expect(RETIRED_SLASH_COMMAND_NAMES.filter((name) => active.has(name))).toEqual([]);
  });

  it("D/E/F: casino retired 10件を正確なcommand nameで固定する", () => {
    expect(RETIRED_SLASH_COMMAND_NAMES).toEqual(RETIRED_CASINO_NAMES);
    expect(RETIRED_SLASH_COMMAND_NAMES).toContain("賭場番付");
    expect(RETIRED_SLASH_COMMAND_NAMES as readonly string[]).not.toContain("番付");
  });
});

describe("ACTIVE builder / registration completeness", () => {
  it("G/J: builder mapは全ACTIVEだけを完全に持つ", () => {
    expect(Object.keys(ACTIVE_SLASH_COMMAND_BUILDERS)).toEqual(ACTIVE_SLASH_COMMAND_NAMES);
  });

  it("H: builder JSON nameはSSOT keyと一致する", () => {
    for (const name of ACTIVE_SLASH_COMMAND_NAMES) {
      expect(ACTIVE_SLASH_COMMAND_BUILDERS[name].toJSON().name).toBe(name);
    }
  });

  it("I: RETIREDはbuilder mapにもregistration payloadにも存在しない", () => {
    const builders = new Set(Object.keys(ACTIVE_SLASH_COMMAND_BUILDERS));
    const payload = new Set(payloadNames());
    for (const name of RETIRED_SLASH_COMMAND_NAMES) {
      expect(builders.has(name)).toBe(false);
      expect(payload.has(name)).toBe(false);
    }
  });

  it("payloadはACTIVEの従来順だけでdeterministicに構築される", () => {
    expect(payloadNames()).toEqual(ACTIVE_SLASH_COMMAND_NAMES);
    expect(payloadNames()).toEqual(payloadNames());
    expect(buildRegistrationPayload().find(({ name }) => name === "管理")?.default_member_permissions).toBeNull();
  });
});

describe("ACTIVE runtime route completeness", () => {
  it("K/L/M: ACTIVE registrationとchat-input runtime routeの集合が一致する", () => {
    const routeNames = Object.keys(ACTIVE_SLASH_COMMAND_ROUTES);
    expect(routeNames).toEqual(ACTIVE_SLASH_COMMAND_NAMES);
    expect(new Set(routeNames)).toEqual(new Set(payloadNames()));
  });
});

describe("retired legacy compatibility boundary", () => {
  it("N/O/P/Q: legacyはACTIVE registrationと交差せず、retired shortcut・勝負・株を登録しない", () => {
    const active = new Set(payloadNames());
    expect(LEGACY_COMPAT_SLASH_NAMES).toEqual(RETIRED_CASINO_NAMES);
    for (const name of LEGACY_COMPAT_SLASH_NAMES) expect(active.has(name)).toBe(false);
    expect(active.has("勝負")).toBe(false);
    expect(active.has("株")).toBe(false);
  });

  it("legacy route mapはlegacy compatibility nameだけを完全に持つ", () => {
    expect(Object.keys(LEGACY_COMPAT_SLASH_ROUTES)).toEqual(LEGACY_COMPAT_SLASH_NAMES);
  });

  it("R: legacy /株はreplyStocksPausedへ到達する", async () => {
    expect(LEGACY_COMPAT_SLASH_ROUTES.株).toBe(replyStocksPaused);
    const reply = vi.fn(async () => undefined);
    const route = getLegacyCompatSlashCommandRoute("株")!;
    await route({ isRepliable: () => true, replied: false, deferred: false, reply } as never, {} as never);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]![0].content).toBe(STOCKS_PAUSE_REASON);
  });

  it("S: legacy /案内は正規入口 /賭場を案内する", async () => {
    const reply = vi.fn(async () => undefined);
    const route = getLegacyCompatSlashCommandRoute("案内")!;
    await route({ reply } as never, {} as never);
    const response = reply.mock.calls[0]![0];
    expect(response.embeds[0].toJSON().description).toContain("`/賭場`");
  });
});

describe("casino user copy", () => {
  it("T/U: dead /株 guidanceを消し、停止・売買不可・保有維持をその場で説明する", () => {
    expect(CASINO_STOCKS_PAUSED_GUIDANCE).not.toContain("`/株` で詳細");
    expect(CASINO_STOCKS_PAUSED_GUIDANCE).toContain("停止中");
    expect(CASINO_STOCKS_PAUSED_GUIDANCE).toContain("新規購入も売却もできません");
    expect(CASINO_STOCKS_PAUSED_GUIDANCE).toContain("持っている株はそのまま");
  });

  it("V: helpはマモンの賭場入口として /賭場を案内する", async () => {
    const reply = vi.fn(async () => undefined);
    await handleHelpCommand(
      { reply } as never,
      { settings: { getNumber: () => 0 } } as never,
    );
    const fields = reply.mock.calls[0]![0].embeds[0].toJSON().fields ?? [];
    expect(fields.map(({ value }) => value).join("\n")).toContain("マモンの賭場全体は `/賭場` から");
  });
});

describe("registration scope", () => {
  it("W: REGISTER_GLOBAL=1ならGUILD_IDがあってもglobal", () => {
    expect(resolveRegistrationTarget({ guildId: "guild", registerGlobal: "1" })).toEqual({ kind: "global" });
  });

  it("X: REGISTER_GLOBAL未指定でGUILD_IDがあればguild", () => {
    expect(resolveRegistrationTarget({ guildId: "guild" })).toEqual({ kind: "guild", guildId: "guild" });
  });

  it("Y: GUILD_IDがなければglobal", () => {
    expect(resolveRegistrationTarget({})).toEqual({ kind: "global" });
  });
});
