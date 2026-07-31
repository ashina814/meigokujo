import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionReport, PayoutPlan, PayoutRunRow } from "@meigokujo/core";

const mocks = vi.hoisted(() => ({ safeButton: vi.fn() }));

vi.mock("../src/permissions.js", () => ({ isAdmin: () => true }));
vi.mock("../src/commands/admin-payroll-safe.js", () => ({
  handleAdminButton: mocks.safeButton,
  handleAdminCommand: vi.fn(),
  handleAdminModal: vi.fn(),
  handleAdminSelect: vi.fn(),
}));

import { handleAdminButton } from "../src/commands/admin-payroll-recovery.js";

function plan(period: string): PayoutPlan {
  return {
    period,
    items: [
      {
        userId: "user1",
        total: 180_000,
        breakdown: [
          { roleId: "role1", label: "魔族", amount: 100_000 },
          { roleId: "role2", label: "銀行員", amount: 80_000 },
        ],
      },
    ],
    totalPayout: 180_000,
  };
}

function report(failed = false): ExecutionReport {
  return {
    succeeded: failed ? 0 : 1,
    skippedAsPaid: 0,
    failed: failed ? [{ userId: "user1", code: "ERR_FROZEN", details: {} }] : [],
    totalPaid: failed ? 0 : 180_000,
  };
}

function run(period: string, status: PayoutRunRow["status"], id: number): PayoutRunRow {
  return {
    id,
    period,
    status,
    plan_json: JSON.stringify(plan(period)),
    report_json: status === "executed" ? JSON.stringify(report(true)) : null,
    created_by: "user:staff1",
    approved_by: status === "draft" ? null : "user:staff1",
    executed_at: status === "executed" ? 100 : null,
    created_at: 10,
    updated_at: 20,
  };
}

function servicesWith(runs: PayoutRunRow[]) {
  return {
    payroll: {
      listRecoverableRuns: vi.fn(() => runs),
      planOf: vi.fn((target: PayoutRunRow) => JSON.parse(target.plan_json) as PayoutPlan),
      generateDraft: vi.fn(),
      execute: vi.fn(),
    },
  };
}

function interaction(customId: string) {
  return {
    customId,
    user: { id: "staff1" },
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

describe("給与管理の月跨ぎ復旧", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T15:30:00.000Z")); // 2026-08-01 00:30 JST
    vi.clearAllMocks();
  });

  afterEach(() => vi.useRealTimers());

  it("8月1日に7月draftを現在月より優先表示する", async () => {
    const july = run("2026-07", "draft", 7);
    const august = run("2026-08", "draft", 8);
    const services = servicesWith([july, august]);
    const button = interaction("mgmt:payroll");

    await handleAdminButton(button, services as any);

    expect(mocks.safeButton).not.toHaveBeenCalled();
    const payload = button.update.mock.calls[0]![0];
    expect(payload.embeds[0].data.title).toBe("⚠️ 未完了の給与Run");
    expect(payload.embeds[0].data.description).toContain("2026-07");
    expect(componentIds(payload)).toContain("mgmt:payroll:recover:7");
  });

  it("過去月draftは現在ロールで再生成せず保存済みスナップショットを確認できる", async () => {
    const july = run("2026-07", "draft", 7);
    const services = servicesWith([july]);
    const button = interaction("mgmt:payroll:recover:7");

    await handleAdminButton(button, services as any);

    expect(services.payroll.generateDraft).not.toHaveBeenCalled();
    const payload = button.editReply.mock.calls[0]![0];
    expect(payload.embeds[0].data.title).toContain("2026-07 保存済み給与案");
    expect(payload.embeds[0].data.description).toContain("現在のロールでは再集計していません");
    expect(payload.files[0].attachment.toString("utf8")).toContain("user1\t180000");
    const hash = createHash("sha256").update(july.plan_json).digest("hex").slice(0, 12);
    expect(componentIds(payload)).toContain(`mgmt:payroll:confirm:7:${hash}`);
  });

  it("8月1日に7月approvedを管理画面から再開できる", async () => {
    const july = run("2026-07", "approved", 7);
    const services = servicesWith([july]);
    const home = interaction("mgmt:payroll");

    await handleAdminButton(home, services as any);

    expect(componentIds(home.update.mock.calls[0]![0])).toContain("mgmt:payroll:retry:7");

    const retry = interaction("mgmt:payroll:retry:7");
    await handleAdminButton(retry, services as any);
    expect(mocks.safeButton).toHaveBeenCalledWith(retry, services);
  });

  it("8月Runが存在しても7月の部分失敗を隠さず再実行ボタンを出す", async () => {
    const july = run("2026-07", "executed", 7);
    const august = run("2026-08", "draft", 8);
    const services = servicesWith([july, august]);
    const button = interaction("mgmt:payroll");

    await handleAdminButton(button, services as any);

    const payload = button.update.mock.calls[0]![0];
    expect(payload.embeds[0].data.description).toContain("2026-07");
    expect(payload.embeds[0].data.description).toContain("失敗 1件");
    expect(componentIds(payload)).toContain("mgmt:payroll:retry:7");
  });

  it("過去月の未完了がなければ既存の現在月給与画面へ委譲する", async () => {
    const services = servicesWith([run("2026-08", "draft", 8)]);
    const button = interaction("mgmt:payroll");

    await handleAdminButton(button, services as any);

    expect(mocks.safeButton).toHaveBeenCalledWith(button, services);
    expect(button.update).not.toHaveBeenCalled();
  });
});
