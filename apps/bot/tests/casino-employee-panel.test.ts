import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// 実行時設定（DISCORD_TOKEN 等）はテストでは持たない。既存の permissions.test.ts と
// 同じやり方で config だけ差し替える。src/config.ts の必須env検査は本番のまま触らない
vi.mock("../src/config.js", () => ({ config: { ownerId: "owner-user" } }));

import type { ButtonInteraction, ChatInputCommandInteraction, Interaction, ModalSubmitInteraction } from "discord.js";
import type { Services } from "../src/services.js";
import { isAdmin, isCasinoEmployee } from "../src/permissions.js";
import { ROLE_SLOT_META, ROLE_SLOT_ORDER } from "../src/church-roles.js";
import {
  handleCasinoEmployeeCommand,
  handleCasinoEmployeeInteraction,
  isCasinoEmployeeInteraction,
  registerTrustedRankedProfile,
} from "../src/commands/casino-employee.js";

/**
 * PR24: 賭博場従業員パネルの権限境界と、金銭操作が存在しないこと。
 *
 * 「UIに出していない」ではなく「入口で毎回断る」ことを見る。
 */

const EMPLOYEE_ROLE = "role-employee";
const ADMIN_ROLE = "role-admin";

function servicesWith(overrides: Record<string, unknown> = {}): Services {
  return {
    settings: {
      getJson: (key: string) => {
        if (key === "roles:casino_employee") return [EMPLOYEE_ROLE];
        if (key === "roles:admin") return [ADMIN_ROLE];
        return [];
      },
      getString: () => undefined,
    },
    ...overrides,
  } as unknown as Services;
}

function interactionFor(roleIds: string[], extra: Record<string, unknown> = {}) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const update = vi.fn().mockResolvedValue(undefined);
  const showModal = vi.fn().mockResolvedValue(undefined);
  const followUp = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    id: "interaction-1",
    user: { id: "user-1" },
    guildId: "guild-1",
    replied: false,
    deferred: false,
    member: { roles: { cache: { has: (id: string) => roleIds.includes(id) } } },
    reply,
    update,
    showModal,
    followUp,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isButton: () => true,
    ...extra,
  };
  return interaction as unknown as ButtonInteraction & {
    reply: typeof reply;
    update: typeof update;
    showModal: typeof showModal;
  };
}

const employeeSource = readFileSync(new URL("../src/commands/casino-employee.ts", import.meta.url), "utf8");

describe("casino employee role slot", () => {
  it("is configurable from the admin board and is not the admin slot", () => {
    expect(ROLE_SLOT_ORDER).toContain("casino_employee");
    expect(ROLE_SLOT_META.casino_employee.label).toContain("賭博場従業員");
    expect(ROLE_SLOT_ORDER).toContain("admin");
    expect("casino_employee").not.toBe("admin");
  });
});

describe("permission boundary", () => {
  it("lets the employee role use the panel", () => {
    expect(isCasinoEmployee(interactionFor([EMPLOYEE_ROLE]) as unknown as Interaction, servicesWith())).toBe(true);
  });

  it("lets an admin use the panel as a higher authority", () => {
    expect(isCasinoEmployee(interactionFor([ADMIN_ROLE]) as unknown as Interaction, servicesWith())).toBe(true);
  });

  it("does NOT make an employee an admin", () => {
    const employee = interactionFor([EMPLOYEE_ROLE]) as unknown as Interaction;
    expect(isCasinoEmployee(employee, servicesWith())).toBe(true);
    expect(isAdmin(employee, servicesWith())).toBe(false);
  });

  it("rejects a plain user", () => {
    expect(isCasinoEmployee(interactionFor(["role-nobody"]) as unknown as Interaction, servicesWith())).toBe(false);
  });

  it("rejects a user with no member object (DM / cache miss)", () => {
    const bare = { user: { id: "user-1" }, member: null } as unknown as Interaction;
    expect(isCasinoEmployee(bare, servicesWith())).toBe(false);
  });
});

describe("every entry point re-checks the permission", () => {
  it("refuses the slash command for a plain user", async () => {
    const interaction = interactionFor(["role-nobody"]);
    await handleCasinoEmployeeCommand(interaction as unknown as ChatInputCommandInteraction, servicesWith());
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("賭博場従業員専用") }));
  });

  it("refuses a directly-crafted customId from a plain user and touches no service", async () => {
    const rankedTables = { create: vi.fn(), cancelBeforeStart: vi.fn(), snapshot: vi.fn(), rankedTierAvailability: vi.fn() };
    const persistentTables = { listLiveTables: vi.fn(), listRecentTables: vi.fn(), get: vi.fn(), bindMessage: vi.fn() };
    const events = { log: vi.fn() };
    const services = servicesWith({ rankedTables, persistentTables, events });

    for (const customId of ["cemp:open", "cemp:close", "cemp:post", "cemp:report", "cemp:history", "cemp:guide"]) {
      const interaction = interactionFor(["role-nobody"], { customId });
      await handleCasinoEmployeeInteraction(interaction, services);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("賭博場従業員専用") }));
    }

    for (const fn of [...Object.values(rankedTables), ...Object.values(persistentTables), events.log]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("refuses a directly-crafted modal submit from a plain user", async () => {
    const events = { log: vi.fn() };
    const services = servicesWith({ events, persistentTables: { get: vi.fn() } });
    const interaction = interactionFor(["role-nobody"], {
      customId: "cemp:report-modal:t1",
      isModalSubmit: () => true,
      isButton: () => false,
      fields: { getTextInputValue: () => "問題があります" },
    });
    await handleCasinoEmployeeInteraction(interaction as unknown as ModalSubmitInteraction, services);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("賭博場従業員専用") }));
    expect(events.log).not.toHaveBeenCalled();
  });

  it("routes only its own prefix", () => {
    expect(isCasinoEmployeeInteraction("cemp:open")).toBe(true);
    expect(isCasinoEmployeeInteraction("mgmt:casino:fund")).toBe(false);
    expect(isCasinoEmployeeInteraction("rtbl:join:t1:1")).toBe(false);
  });
});

describe("the employee surface has no money operations", () => {
  const forbidden = [
    "services.chips",
    "services.ledger",
    "services.escrow",
    "services.casino.",
    "chipFlow",
    "createRefundSaga",
    "executeRefundSaga",
    "refundMany",
    "refundOne",
    "refundAll",
    "settle(",
    "submitResult",
    "approve(",
    "resolve(",
    "rankedDisputes.resolve",
    "seizeJackpot",
    "recordGameNet",
    "transfer(",
    "deposit(",
    "redeem(",
  ];

  it("never references a fund-moving API", () => {
    for (const needle of forbidden) {
      expect(employeeSource, needle).not.toContain(needle);
    }
  });

  it("only reaches ranked tables through create / cancelBeforeStart / snapshot", () => {
    const calls = [...employeeSource.matchAll(/services\.rankedTables\.(\w+)/g)].map((m) => m[1]);
    expect([...new Set(calls)].sort()).toEqual(["cancelBeforeStart", "create", "rankedTierAvailability", "snapshot"]);
  });

  it("only reaches persistent tables through read + message binding", () => {
    const calls = [...employeeSource.matchAll(/services\.persistentTables\.(\w+)/g)].map((m) => m[1]);
    expect([...new Set(calls)].sort()).toEqual(["bindMessage", "get", "listLiveTables", "listRecentTables"]);
  });

  it("asks core for the openable tiers instead of hardcoding the gate", () => {
    expect(employeeSource).toContain("rankedTierAvailability(\"employee\")");
    expect(employeeSource).toContain('authority: "employee"');
  });
});

describe("history never leaks private material", () => {
  it("does not render dispute reasons, failure reasons, recovery errors or per-user amounts", () => {
    for (const needle of ["disputeReason", "failureReason", "recoveryError", "evidence", "publicSummary", "refundAmounts"]) {
      expect(employeeSource, needle).not.toContain(needle);
    }
  });

  it("reads history through the read-only query", () => {
    expect(employeeSource).toContain("listRecentTables(HISTORY_LIMIT, interaction.guildId)");
  });
});

describe("problem reporting", () => {
  it("records the report and moves no funds", async () => {
    const events = { log: vi.fn() };
    const persistentTables = { get: vi.fn(() => ({ tableId: "t1", guildId: "guild-1", state: "playing" })) };
    const rankedTables = { snapshot: () => ({ table: { tableId: "t1" }, config: { baseAmount: 5_000 }, participants: [], result: null }) };
    const services = servicesWith({ events, persistentTables, rankedTables });
    const interaction = interactionFor([EMPLOYEE_ROLE], {
      customId: "cemp:report-modal:t1",
      isModalSubmit: () => true,
      isButton: () => false,
      fields: { getTextInputValue: () => "参加者が来ない" },
      client: { channels: { cache: { get: () => undefined }, fetch: vi.fn() } },
    });

    await handleCasinoEmployeeInteraction(interaction as unknown as ModalSubmitInteraction, services);

    expect(events.log).toHaveBeenCalledWith("casino_employee_report", expect.objectContaining({ actor: "user-1", target: "t1" }));
    // 卓は読むだけ。状態遷移も資金移動も呼ばない
    expect(persistentTables.get).toHaveBeenCalledWith("t1");
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("記録") }));
  });
});

describe("employee target authorization (guild + tier)", () => {
  /** 卓レジストリの最小スタブ。tableId ごとに guild と基準額を持つ */
  function tableWorld(rows: Array<{ tableId: string; guildId: string | null; baseAmount: number; state?: string }>) {
    const cancelBeforeStart = vi.fn(() => ({ table: { state: "cancelled", tableId: "x", revision: 1 }, config: {}, participants: [], result: null }));
    const send = vi.fn().mockResolvedValue({ id: "msg-1", channelId: "chan-1" });
    const bindMessage = vi.fn();
    const services = servicesWith({
      persistentTables: {
        listLiveTables: () => rows.map((r) => ({ tableId: r.tableId, guildId: r.guildId, gameKey: "gf", state: r.state ?? "recruiting" })),
        get: (tableId: string) => rows.find((r) => r.tableId === tableId) ?? null,
        listRecentTables: vi.fn(() => []),
        bindMessage,
      },
      rankedTables: {
        cancelBeforeStart,
        snapshot: (tableId: string) => {
          const row = rows.find((r) => r.tableId === tableId);
          if (!row) throw new Error("no table");
          return { table: { tableId, state: row.state ?? "recruiting", revision: 1 }, config: { baseAmount: row.baseAmount }, participants: [], result: null };
        },
      },
      rankedDisputes: { publicStatus: () => null },
    });
    return { services, cancelBeforeStart, bindMessage, send };
  }

  function selectFor(customId: string, value: string, guildId: string | null, extra: Record<string, unknown> = {}) {
    return interactionFor([EMPLOYEE_ROLE], {
      customId,
      values: [value],
      guildId,
      isButton: () => false,
      isStringSelectMenu: () => true,
      ...extra,
    });
  }

  it("only offers same-guild employee-tier tables as close/post/report candidates", async () => {
    const { services } = tableWorld([
      { tableId: "ok-high", guildId: "guild-1", baseAmount: 10_000 },
      { tableId: "ok-super", guildId: "guild-1", baseAmount: 30_000 },
      { tableId: "too-big", guildId: "guild-1", baseAmount: 50_000 },
      { tableId: "other-guild", guildId: "guild-2", baseAmount: 5_000 },
      { tableId: "no-guild", guildId: null, baseAmount: 5_000 },
    ]);
    const interaction = interactionFor([EMPLOYEE_ROLE], { customId: "cemp:close", guildId: "guild-1" });

    await handleCasinoEmployeeInteraction(interaction, services);

    const payload = interaction.reply.mock.calls[0]![0] as {
      components: Array<{ components: Array<{ options: Array<{ data: { value: string } }> }> }>;
    };
    const offered = payload.components[0]!.components[0]!.options.map((o) => o.data.value);
    // 超高卓(30,000)までが従業員の担当。極卓(50,000)以上は候補に出さない
    expect(offered).toEqual(["ok-high", "ok-super"]);
  });

  it("refuses a stale/crafted select value pointing at another guild's table", async () => {
    const { services, cancelBeforeStart } = tableWorld([{ tableId: "other-guild", guildId: "guild-2", baseAmount: 5_000 }]);
    const interaction = selectFor("cemp:close:pick", "other-guild", "guild-1");

    await handleCasinoEmployeeInteraction(interaction, services);

    expect(cancelBeforeStart).not.toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("このサーバーの卓ではありません") }));
  });

  it("refuses a stale/crafted select value pointing at a manager-only tier", async () => {
    for (const baseAmount of [50_000, 100_000]) {
      const { services, cancelBeforeStart } = tableWorld([{ tableId: "big", guildId: "guild-1", baseAmount }]);
      const interaction = selectFor("cemp:close:pick", "big", "guild-1");

      await handleCasinoEmployeeInteraction(interaction, services);

      expect(cancelBeforeStart).not.toHaveBeenCalled();
      expect(interaction.update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("卓ランクを超えています") }));
    }
  });

  it("passes the employee authority and the guild down to core when it does close", async () => {
    const { services, cancelBeforeStart } = tableWorld([{ tableId: "ok-high", guildId: "guild-1", baseAmount: 10_000 }]);
    const interaction = selectFor("cemp:close:pick", "ok-high", "guild-1");

    await handleCasinoEmployeeInteraction(interaction, services);

    expect(cancelBeforeStart).toHaveBeenCalledWith(
      expect.objectContaining({ tableId: "ok-high", authority: "employee", expectedGuildId: "guild-1" }),
    );
  });

  it("refuses to post a recruitment message for an out-of-bounds table", async () => {
    const { services, bindMessage, send } = tableWorld([{ tableId: "big", guildId: "guild-1", baseAmount: 50_000 }]);
    const interaction = selectFor("cemp:post:pick", "big", "guild-1", { channel: { send } });

    await handleCasinoEmployeeInteraction(interaction, services);

    expect(send).not.toHaveBeenCalled();
    expect(bindMessage).not.toHaveBeenCalled();
  });

  it("refuses to report an out-of-bounds table and logs nothing", async () => {
    const events = { log: vi.fn() };
    const { services } = tableWorld([{ tableId: "other-guild", guildId: "guild-2", baseAmount: 5_000 }]);
    const scoped = { ...services, events } as unknown as Services;
    const interaction = interactionFor([EMPLOYEE_ROLE], {
      customId: "cemp:report-modal:other-guild",
      guildId: "guild-1",
      isButton: () => false,
      isModalSubmit: () => true,
      fields: { getTextInputValue: () => "報告" },
    });

    await handleCasinoEmployeeInteraction(interaction as unknown as ModalSubmitInteraction, scoped);

    expect(events.log).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("このサーバーの卓ではありません") }));
  });

  it("scopes history to the caller's guild", async () => {
    const { services } = tableWorld([]);
    const interaction = interactionFor([EMPLOYEE_ROLE], { customId: "cemp:history", guildId: "guild-1" });

    await handleCasinoEmployeeInteraction(interaction, services);

    expect(services.persistentTables.listRecentTables).toHaveBeenCalledWith(expect.any(Number), "guild-1");
  });
});

describe("trusted rank profile registration is operator-only", () => {
  it("refuses an employee and accepts an admin", () => {
    const register = vi.fn();
    const services = servicesWith({ rankedProfiles: { register } });

    const employee = interactionFor([EMPLOYEE_ROLE]) as unknown as ButtonInteraction;
    const denied = registerTrustedRankedProfile(employee, services, {
      profileKey: "duel",
      label: "決",
      participantCount: 2,
      rankDeltaBps: [10_000, -10_000],
    });
    expect(denied).toEqual({ ok: false, reason: expect.stringContaining("運営のみ") });
    expect(register).not.toHaveBeenCalled();

    const admin = interactionFor([ADMIN_ROLE]) as unknown as ButtonInteraction;
    const allowed = registerTrustedRankedProfile(admin, services, {
      profileKey: "duel",
      label: "決",
      participantCount: 2,
      rankDeltaBps: [10_000, -10_000],
    });
    expect(allowed).toEqual({ ok: true });
    expect(register).toHaveBeenCalledTimes(1);
  });
});
