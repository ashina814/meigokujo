import { createHash } from "node:crypto";
import { Collection } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionReport, PayoutPlan, PayoutRunRow } from "@meigokujo/core";

const mocks = vi.hoisted(() => ({
  baseButton: vi.fn(),
}));

vi.mock("../src/permissions.js", () => ({ isAdmin: () => true }));
vi.mock("../src/commands/admin-hub.js", () => ({
  handleAdminButton: mocks.baseButton,
  handleAdminCommand: vi.fn(),
  handleAdminModal: vi.fn(),
  handleAdminSelect: vi.fn(),
}));

import { handleAdminButton } from "../src/commands/admin-payroll-safe.js";

const plan: PayoutPlan = {
  period: "2026-08",
  totalPayout: 180_000,
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
};

function run(status: PayoutRunRow["status"] = "draft", overrides: Partial<PayoutRunRow> = {}): PayoutRunRow {
  return {
    id: 7,
    period: "2026-08",
    status,
    plan_json: JSON.stringify(plan),
    report_json: null,
    created_by: "user:staff1",
    approved_by: status === "draft" ? null : "user:staff1",
    executed_at: status === "executed" ? 100 : null,
    created_at: 10,
    updated_at: 20,
    ...overrides,
  };
}

function report(overrides: Partial<ExecutionReport> = {}): ExecutionReport {
  return {
    succeeded: 1,
    skippedAsPaid: 0,
    failed: [],
    totalPaid: 180_000,
    ...overrides,
  };
}

function harness(customId: string, options: {
  existing?: PayoutRunRow;
  getRuns?: PayoutRunRow[];
  execution?: ExecutionReport;
} = {}) {
  const member = {
    id: "user1",
    displayName: "利用者一",
    user: { bot: false },
    roles: { cache: new Collection([["role1", { id: "role1" }], ["role2", { id: "role2" }]]) },
  };
  const members = new Collection([[member.id, member]]);
  const generated = run();
  const approved = run("approved");
  const executed = run("executed", { report_json: JSON.stringify(options.execution ?? report()) });
  const getRun = vi.fn();
  for (const item of options.getRuns ?? [generated, executed]) getRun.mockReturnValueOnce(item);
  getRun.mockReturnValue(executed);

  const services = {
    payroll: {
      listSalaries: vi.fn(() => [
        { role_id: "role1", label: "魔族", amount: 100_000, updated_at: 1 },
        { role_id: "role2", label: "銀行員", amount: 80_000, updated_at: 1 },
      ]),
      getRunByPeriod: vi.fn(() => options.existing),
      generateDraft: vi.fn(() => generated),
      planOf: vi.fn((target: PayoutRunRow) => JSON.parse(target.plan_json) as PayoutPlan),
      getRun,
      approve: vi.fn(() => approved),
      execute: vi.fn(() => options.execution ?? report()),
    },
    ledger: { moneySupply: vi.fn(() => 9_999_999) },
  };

  const interaction: any = {
    customId,
    user: { id: "staff1" },
    guild: { members: { fetch: vi.fn(async () => members) } },
    deferred: false,
    replied: false,
    deferUpdate: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async (payload) => payload),
    update: vi.fn(async (payload) => payload),
    reply: vi.fn(async (payload) => {
      interaction.replied = true;
      return payload;
    }),
  };
  return { interaction, services, generated, approved, executed };
}

function componentIds(payload: any): string[] {
  return (payload.components ?? []).flatMap((row: any) =>
    row.toJSON().components.map((component: { custom_id?: string }) => component.custom_id).filter(Boolean),
  );
}

describe("管理画面の給与安全操作", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 2026-08-01 00:30 JST。UTC文字列ではまだ7月なので、JST判定の回帰点になる。
    vi.setSystemTime(new Date("2026-07-31T15:30:00.000Z"));
    mocks.baseButton.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("手動支給ボタンは送金せず、JST対象月の支給案と全件明細を表示する", async () => {
    const h = harness("mgmt:payroll:pay");

    await handleAdminButton(h.interaction, h.services as any);

    expect(h.services.payroll.generateDraft).toHaveBeenCalledWith(
      "2026-08",
      [{ userId: "user1", roleIds: ["role1", "role2"] }],
      "user:staff1",
    );
    expect(h.services.payroll.approve).not.toHaveBeenCalled();
    expect(h.services.payroll.execute).not.toHaveBeenCalled();
    expect(h.interaction.deferUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      h.services.payroll.generateDraft.mock.invocationCallOrder[0]!,
    );

    const payload = h.interaction.editReply.mock.calls[0]![0];
    expect(payload.embeds[0].data.title).toContain("2026-08 給与支給案");
    expect(payload.files[0].name).toBe("salary-preview-2026-08-run-7.txt");
    expect(payload.files[0].attachment.toString("utf8")).toContain("user1\t利用者一\t180000");
    expect(componentIds(payload)).toContainEqual(expect.stringMatching(/^mgmt:payroll:confirm:7:[0-9a-f]{12}$/));
  });

  it("確認時に支給案が更新されていたら承認・送金しない", async () => {
    const expected = createHash("sha256").update(JSON.stringify({ ...plan, totalPayout: 1 })).digest("hex").slice(0, 12);
    const h = harness(`mgmt:payroll:confirm:7:${expected}`, { getRuns: [run()] });

    await handleAdminButton(h.interaction, h.services as any);

    expect(h.services.payroll.approve).not.toHaveBeenCalled();
    expect(h.services.payroll.execute).not.toHaveBeenCalled();
    expect(h.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("支給案が別操作で更新") }),
    );
  });

  it("確認済みの同一スナップショットだけを承認して支給する", async () => {
    const draft = run();
    const hash = createHash("sha256").update(draft.plan_json).digest("hex").slice(0, 12);
    const h = harness(`mgmt:payroll:confirm:7:${hash}`, {
      getRuns: [draft, run("executed")],
    });

    await handleAdminButton(h.interaction, h.services as any);

    expect(h.services.payroll.approve).toHaveBeenCalledWith(7, "user:staff1");
    expect(h.services.payroll.execute).toHaveBeenCalledWith(7, "user:staff1");
    expect(h.interaction.deferUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      h.services.payroll.approve.mock.invocationCallOrder[0]!,
    );
    const payload = h.interaction.editReply.mock.calls.at(-1)![0];
    expect(payload.embeds[0].data.title).toBe("✅ 給与支給完了");
    expect(payload.attachments).toEqual([]);
  });

  it("部分失敗は利用者・理由を表示し、同じRunの再実行ボタンを残す", async () => {
    const draft = run();
    const hash = createHash("sha256").update(draft.plan_json).digest("hex").slice(0, 12);
    const failed = report({
      succeeded: 0,
      totalPaid: 0,
      failed: [{ userId: "user1", code: "ERR_FROZEN", details: { accountId: "user:user1" } }],
    });
    const h = harness(`mgmt:payroll:confirm:7:${hash}`, {
      getRuns: [draft, run("executed", { report_json: JSON.stringify(failed) })],
      execution: failed,
    });

    await handleAdminButton(h.interaction, h.services as any);

    const payload = h.interaction.editReply.mock.calls.at(-1)![0];
    expect(payload.embeds[0].data.description).toContain("ERR_FROZEN");
    expect(payload.embeds[0].data.description).toContain("accountId=user:user1");
    expect(componentIds(payload)).toContain("mgmt:payroll:retry:7");
  });

  it("再実行では承認を繰り返さず、支給済みを冪等スキップして未払いだけ処理する", async () => {
    const retryReport = report({ succeeded: 1, skippedAsPaid: 3, totalPaid: 180_000 });
    const h = harness("mgmt:payroll:retry:7", {
      getRuns: [run("executed"), run("executed", { report_json: JSON.stringify(retryReport) })],
      execution: retryReport,
    });

    await handleAdminButton(h.interaction, h.services as any);

    expect(h.services.payroll.approve).not.toHaveBeenCalled();
    expect(h.services.payroll.execute).toHaveBeenCalledWith(7, "user:staff1");
    const payload = h.interaction.editReply.mock.calls.at(-1)![0];
    expect(payload.embeds[0].data.description).toContain("支給済みスキップ **3件**");
  });

  it("給与以外の管理ボタンは既存実装へ委譲する", async () => {
    const h = harness("mgmt:dashboard");

    await handleAdminButton(h.interaction, h.services as any);

    expect(mocks.baseButton).toHaveBeenCalledWith(h.interaction, h.services);
  });
});
