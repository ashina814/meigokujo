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

function isRecoverable(target: PayoutRunRow): boolean {
  if (target.status === "draft" || target.status === "approved") return true;
  if (target.status !== "executed" || !target.report_json) return false;
  try {
    return (JSON.parse(target.report_json) as ExecutionReport).failed.length > 0;
  } catch {
    return true;
  }
}

function servicesWith(initialRuns: PayoutRunRow[]) {
  const runs = initialRuns.map((item) => ({ ...item }));
  const payroll = {
    listRecoverableRuns: vi.fn(() => runs.filter(isRecoverable).sort((a, b) => a.period.localeCompare(b.period) || a.id - b.id)),
    planOf: vi.fn((target: PayoutRunRow) => JSON.parse(target.plan_json) as PayoutPlan),
    getRun: vi.fn((id: number) => {
      const target = runs.find((item) => item.id === id);
      if (!target) throw new Error("not found");
      return target;
    }),
    cancel: vi.fn((id: number) => {
      const target = runs.find((item) => item.id === id);
      if (!target) throw new Error("not found");
      target.status = "cancelled";
      return target;
    }),
    generateDraft: vi.fn(),
    execute: vi.fn(),
  };
  return { services: { payroll }, runs };
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
    const { services } = servicesWith([run("2026-07", "draft", 7), run("2026-08", "draft", 8)]);
    const button = interaction("mgmt:payroll");

    await handleAdminButton(button, services as any);

    expect(mocks.safeButton).not.toHaveBeenCalled();
    const payload = button.update.mock.calls[0]![0];
    expect(payload.embeds[0].data.title).toBe("⚠️ 未完了の給与Run");
    expect(payload.embeds[0].data.description).toContain("2026-07");
    expect(componentIds(payload)).toContain("mgmt:payroll:recover:7");
  });

  it("過去月draftは再生成せず、支給とハッシュ付き見送りを選べる", async () => {
    const july = run("2026-07", "draft", 7);
    const { services } = servicesWith([july]);
    const button = interaction("mgmt:payroll:recover:7");

    await handleAdminButton(button, services as any);

    expect(services.payroll.generateDraft).not.toHaveBeenCalled();
    const payload = button.editReply.mock.calls[0]![0];
    expect(payload.embeds[0].data.title).toContain("2026-07 保存済み給与案");
    expect(payload.embeds[0].data.description).toContain("現在のロールでは再集計していません");
    expect(payload.files[0].attachment.toString("utf8")).toContain("user1\t180000");
    const hash = createHash("sha256").update(july.plan_json).digest("hex").slice(0, 12);
    expect(componentIds(payload)).toContain(`mgmt:payroll:confirm:7:${hash}`);
    expect(componentIds(payload)).toContain(`mgmt:payroll:cancel:7:${hash}`);
  });

  it("過去draftを見送ると次の未完了Runへ進む", async () => {
    const june = run("2026-06", "draft", 6);
    const july = run("2026-07", "approved", 7);
    const { services } = servicesWith([june, july]);
    const hash = createHash("sha256").update(june.plan_json).digest("hex").slice(0, 12);
    const button = interaction(`mgmt:payroll:cancel:6:${hash}`);

    await handleAdminButton(button, services as any);

    expect(services.payroll.cancel).toHaveBeenCalledWith(6, "user:staff1");
    const payload = button.editReply.mock.calls.at(-1)![0];
    expect(payload.embeds[0].data.description).toContain("2026-07");
    expect(componentIds(payload)).toContain("mgmt:payroll:retry:7");
  });

  it("古いハッシュの見送りボタンではキャンセルしない", async () => {
    const { services } = servicesWith([run("2026-07", "draft", 7)]);
    const button = interaction("mgmt:payroll:cancel:7:000000000000");

    await handleAdminButton(button, services as any);

    expect(services.payroll.cancel).not.toHaveBeenCalled();
    expect(button.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("古くなっています") }));
  });

  it("7月未完了中は古い8月画面の支給案生成を拒否する", async () => {
    const { services } = servicesWith([run("2026-07", "approved", 7), run("2026-08", "draft", 8)]);
    const button = interaction("mgmt:payroll:pay");

    await handleAdminButton(button, services as any);

    expect(mocks.safeButton).not.toHaveBeenCalled();
    const payload = button.update.mock.calls[0]![0];
    expect(payload.content).toContain("2026-07");
    expect(payload.content).toContain("行っていません");
  });

  it.each([
    ["mgmt:payroll:confirm:8:aaaaaaaaaaaa", "confirm"],
    ["mgmt:payroll:retry:8", "retry"],
  ])("7月未完了中は8月の%s操作を拒否する", async (customId) => {
    const { services } = servicesWith([run("2026-07", "approved", 7), run("2026-08", "draft", 8)]);
    const button = interaction(customId);

    await handleAdminButton(button, services as any);

    expect(mocks.safeButton).not.toHaveBeenCalled();
    expect(button.update.mock.calls[0]![0].content).toContain("2026-07");
  });

  it("最古の7月Run自身の確認・再実行は既存安全処理へ通す", async () => {
    const julyDraft = run("2026-07", "draft", 7);
    const first = servicesWith([julyDraft, run("2026-08", "draft", 8)]);
    const hash = createHash("sha256").update(julyDraft.plan_json).digest("hex").slice(0, 12);
    const confirm = interaction(`mgmt:payroll:confirm:7:${hash}`);

    await handleAdminButton(confirm, first.services as any);
    expect(mocks.safeButton).toHaveBeenCalledWith(confirm, first.services);

    mocks.safeButton.mockClear();
    const second = servicesWith([run("2026-07", "approved", 7), run("2026-08", "draft", 8)]);
    const retry = interaction("mgmt:payroll:retry:7");
    await handleAdminButton(retry, second.services as any);
    expect(mocks.safeButton).toHaveBeenCalledWith(retry, second.services);
  });

  it("8月Runが存在しても7月の部分失敗を隠さず再実行ボタンを出す", async () => {
    const { services } = servicesWith([run("2026-07", "executed", 7), run("2026-08", "draft", 8)]);
    const button = interaction("mgmt:payroll");

    await handleAdminButton(button, services as any);

    const payload = button.update.mock.calls[0]![0];
    expect(payload.embeds[0].data.description).toContain("2026-07");
    expect(payload.embeds[0].data.description).toContain("失敗 1件");
    expect(componentIds(payload)).toContain("mgmt:payroll:retry:7");
  });

  it("過去月の未完了がなければ既存の現在月給与画面へ委譲する", async () => {
    const { services } = servicesWith([run("2026-08", "draft", 8)]);
    const button = interaction("mgmt:payroll");

    await handleAdminButton(button, services as any);

    expect(mocks.safeButton).toHaveBeenCalledWith(button, services);
    expect(button.update).not.toHaveBeenCalled();
  });
});
