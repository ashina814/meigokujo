import { Collection } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PayoutPlan, PayoutRunRow } from "@meigokujo/core";

const mocks = vi.hoisted(() => ({ baseButton: vi.fn() }));

vi.mock("../src/permissions.js", () => ({ isAdmin: () => true }));
vi.mock("../src/commands/admin-hub.js", () => ({
  handleAdminButton: mocks.baseButton,
  handleAdminCommand: vi.fn(),
  handleAdminModal: vi.fn(),
  handleAdminSelect: vi.fn(),
}));

import { handleAdminButton as handleSafeButton } from "../src/commands/admin-payroll-safe.js";
import { handleAdminButton as handleRecoveryButton } from "../src/commands/admin-payroll-recovery.js";
import { parseExecutionReport } from "../src/payroll-ui-utils.js";

function plan(period: string): PayoutPlan {
  return {
    period,
    items: [
      {
        userId: "user1",
        total: 100_000,
        breakdown: [{ roleId: "role1", label: "魔族", amount: 100_000 }],
      },
    ],
    totalPayout: 100_000,
  };
}

function run(period: string, status: PayoutRunRow["status"], reportJson: string | null = null): PayoutRunRow {
  return {
    id: period === "2026-07" ? 7 : 8,
    period,
    status,
    plan_json: JSON.stringify(plan(period)),
    report_json: reportJson,
    created_by: "user:staff1",
    approved_by: status === "draft" ? null : "user:staff1",
    executed_at: status === "executed" ? 100 : null,
    created_at: 10,
    updated_at: 20,
  };
}

function interaction(customId: string, withGuild = false) {
  const member = {
    id: "user1",
    displayName: "利用者一",
    user: { bot: false },
    roles: { cache: new Collection([["role1", { id: "role1" }]]) },
  };
  return {
    customId,
    user: { id: "staff1" },
    guild: withGuild ? { members: { fetch: vi.fn(async () => new Collection([[member.id, member]])) } } : null,
    update: vi.fn(),
    deferUpdate: vi.fn(),
    editReply: vi.fn(),
    reply: vi.fn(),
  } as any;
}

function componentIds(payload: any): string[] {
  return (payload.components ?? []).flatMap((row: any) =>
    row.toJSON().components.map((component: { custom_id?: string }) => component.custom_id).filter(Boolean),
  );
}

describe("給与の前月生成と実行レポート復旧", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T15:30:00.000Z")); // 2026-08-01 00:30 JST
    vi.clearAllMocks();
  });

  afterEach(() => vi.useRealTimers());

  it("8月1日に7月Runがなくても現在月と前月の支給案ボタンを表示する", async () => {
    const services: any = {
      payroll: {
        listSalaries: vi.fn(() => [{ role_id: "role1", label: "魔族", amount: 100_000, updated_at: 1 }]),
        getRunByPeriod: vi.fn(() => undefined),
      },
    };
    const button = interaction("mgmt:payroll");

    await handleSafeButton(button, services);

    const payload = button.update.mock.calls[0]![0];
    expect(componentIds(payload)).toContain("mgmt:payroll:pay-period:2026-08");
    expect(componentIds(payload)).toContain("mgmt:payroll:pay-period:2026-07");
    expect(payload.embeds[0].data.description).toContain("**前月:** `2026-07` / 未作成");
  });

  it("前月ボタンは8月1日でも7月の支給案を生成し、再集計でも対象月を維持する", async () => {
    const generated = run("2026-07", "draft");
    const services: any = {
      payroll: {
        getRunByPeriod: vi.fn(() => undefined),
        generateDraft: vi.fn(() => generated),
        planOf: vi.fn(() => plan("2026-07")),
      },
    };
    const button = interaction("mgmt:payroll:pay-period:2026-07", true);

    await handleSafeButton(button, services);

    expect(services.payroll.generateDraft).toHaveBeenCalledWith(
      "2026-07",
      [{ userId: "user1", roleIds: ["role1"] }],
      "user:staff1",
    );
    const payload = button.editReply.mock.calls[0]![0];
    expect(payload.embeds[0].data.title).toContain("2026-07 給与支給案");
    expect(componentIds(payload)).toContain("mgmt:payroll:pay-period:2026-07");
  });

  it("未来月や前々月を手作りしたボタンでは生成しない", async () => {
    const services: any = { payroll: { generateDraft: vi.fn() } };
    const future = interaction("mgmt:payroll:pay-period:2026-09", true);
    const tooOld = interaction("mgmt:payroll:pay-period:2026-06", true);

    await handleSafeButton(future, services);
    await handleSafeButton(tooOld, services);

    expect(services.payroll.generateDraft).not.toHaveBeenCalled();
    expect(future.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("現在月または前月") }));
    expect(tooOld.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("現在月または前月") }));
  });

  it.each(["{}", '{"failed":null}', '{"succeeded":"1","skippedAsPaid":0,"failed":[],"totalPaid":0}'])(
    "構造不正な実行レポートを解析成功扱いにしない: %s",
    (raw) => {
      expect(parseExecutionReport(raw)).toBeUndefined();
    },
  );

  it("現在月の実行済みRunが壊れたレポートでも給与画面を開き安全再実行を出す", async () => {
    const current = run("2026-08", "executed", "{}");
    const services: any = {
      payroll: {
        listSalaries: vi.fn(() => [{ role_id: "role1", label: "魔族", amount: 100_000, updated_at: 1 }]),
        getRunByPeriod: vi.fn((period: string) => (period === "2026-08" ? current : undefined)),
      },
    };
    const button = interaction("mgmt:payroll");

    await handleSafeButton(button, services);

    const payload = button.update.mock.calls[0]![0];
    expect(payload.embeds[0].data.description).toContain("実行結果を安全に読み取れません");
    expect(componentIds(payload)).toContain("mgmt:payroll:retry:8");
  });

  it("過去月の実行済みRunが壊れたレポートでも回収画面を開き安全再実行を出す", async () => {
    const july = run("2026-07", "executed", '{"failed":null}');
    const services: any = {
      payroll: {
        listRecoverableRuns: vi.fn(() => [july]),
        planOf: vi.fn(() => plan("2026-07")),
      },
    };
    const button = interaction("mgmt:payroll");

    await handleRecoveryButton(button, services);

    const payload = button.update.mock.calls[0]![0];
    expect(payload.embeds[0].data.description).toContain("結果を読み取れないため");
    expect(componentIds(payload)).toContain("mgmt:payroll:retry:7");
  });
});
