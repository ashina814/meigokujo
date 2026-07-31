import { createHash } from "node:crypto";
import { Collection } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionReport, PayoutPlan, PayoutRunRow } from "@meigokujo/core";

const mocks = vi.hoisted(() => ({ baseButton: vi.fn() }));

vi.mock("../src/permissions.js", () => ({ isAdmin: () => true }));
vi.mock("../src/commands/admin-hub.js", () => ({
  handleAdminButton: mocks.baseButton,
  handleAdminCommand: vi.fn(),
  handleAdminModal: vi.fn(),
  handleAdminSelect: vi.fn(),
}));

import { handleAdminButton } from "../src/commands/admin-payroll-safe.js";

function makePlan(itemCount = 1, labelLength = 10): PayoutPlan {
  return {
    period: "2026-07",
    items: Array.from({ length: itemCount }, (_, index) => ({
      userId: `user${index}`,
      total: 100_000,
      breakdown: [
        {
          roleId: `role${index}`,
          label: `役職${index}-${"長".repeat(labelLength)}`,
          amount: 100_000,
        },
      ],
    })),
    totalPayout: itemCount * 100_000,
  };
}

function run(plan: PayoutPlan, status: PayoutRunRow["status"] = "draft", report?: ExecutionReport): PayoutRunRow {
  return {
    id: 7,
    period: plan.period,
    status,
    plan_json: JSON.stringify(plan),
    report_json: report ? JSON.stringify(report) : null,
    created_by: "user:staff1",
    approved_by: status === "draft" ? null : "user:staff1",
    executed_at: status === "executed" ? 100 : null,
    created_at: 10,
    updated_at: 20,
  };
}

function interaction(customId: string, memberCount = 1): any {
  const members = new Collection(
    Array.from({ length: memberCount }, (_, index) => {
      const member = {
        id: `user${index}`,
        displayName: `利用者${index}`,
        user: { bot: false },
        roles: { cache: new Collection([[`role${index}`, { id: `role${index}` }]]) },
      };
      return [member.id, member];
    }),
  );
  const value: any = {
    customId,
    user: { id: "staff1" },
    guild: { members: { fetch: vi.fn(async () => members) } },
    deferUpdate: vi.fn(),
    editReply: vi.fn(),
    update: vi.fn(),
    reply: vi.fn(),
  };
  return value;
}

function componentIds(payload: any): string[] {
  return (payload.components ?? []).flatMap((row: any) =>
    row.toJSON().components.map((component: { custom_id?: string }) => component.custom_id).filter(Boolean),
  );
}

describe("給与管理画面の競合・表示上限", () => {
  beforeEach(() => vi.clearAllMocks());

  it("承認済みRunでも古い確認ハッシュからは支給しない", async () => {
    const plan = makePlan();
    const approved = run(plan, "approved");
    const services: any = {
      payroll: {
        getRun: vi.fn(() => approved),
        execute: vi.fn(),
        planOf: vi.fn(() => plan),
      },
      ledger: { moneySupply: vi.fn(() => 1) },
    };
    const i = interaction("mgmt:payroll:confirm:7:000000000000");

    await handleAdminButton(i, services);

    expect(services.payroll.execute).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("支給案が別操作で更新") }),
    );
  });

  it("長い給与内訳でもプレビューEmbedを上限内に収め、全件明細を添付する", async () => {
    const plan = makePlan(40, 1_000);
    const draft = run(plan);
    const services: any = {
      payroll: {
        getRunByPeriod: vi.fn(() => undefined),
        generateDraft: vi.fn(() => draft),
        planOf: vi.fn(() => plan),
      },
    };
    const i = interaction("mgmt:payroll:pay", 40);

    await handleAdminButton(i, services);

    const payload = i.editReply.mock.calls[0]![0];
    expect(payload.embeds[0].data.description.length).toBeLessThanOrEqual(3_900);
    expect(payload.embeds[0].data.description).toContain("添付を確認");
    expect(payload.files[0].attachment.toString("utf8")).toContain("user39");
    expect(componentIds(payload)).toContainEqual(expect.stringMatching(/^mgmt:payroll:confirm:7:[0-9a-f]{12}$/));
  });

  it("失敗者が多くても結果Embedを上限内に収め、全失敗を添付する", async () => {
    const plan = makePlan();
    const draft = run(plan);
    const failures: ExecutionReport = {
      succeeded: 0,
      skippedAsPaid: 0,
      totalPaid: 0,
      failed: Array.from({ length: 80 }, (_, index) => ({
        userId: `failed${index}`,
        code: "ERR_FROZEN",
        details: { accountId: `user:failed${index}`, reason: "詳".repeat(500) },
      })),
    };
    const executed = run(plan, "executed", failures);
    const hash = createHash("sha256").update(draft.plan_json).digest("hex").slice(0, 12);
    const getRun = vi.fn().mockReturnValueOnce(draft).mockReturnValue(executed);
    const services: any = {
      payroll: {
        getRun,
        approve: vi.fn(() => run(plan, "approved")),
        execute: vi.fn(() => failures),
      },
      ledger: { moneySupply: vi.fn(() => 1) },
    };
    const i = interaction(`mgmt:payroll:confirm:7:${hash}`);

    await handleAdminButton(i, services);

    const payload = i.editReply.mock.calls.at(-1)![0];
    expect(payload.embeds[0].data.description.length).toBeLessThanOrEqual(3_900);
    expect(payload.embeds[0].data.description).toContain("添付を確認");
    expect(payload.files[0].name).toBe("salary-failures-2026-07-run-7.txt");
    expect(payload.files[0].attachment.toString("utf8")).toContain("failed79");
    expect(componentIds(payload)).toContain("mgmt:payroll:retry:7");
  });
});
