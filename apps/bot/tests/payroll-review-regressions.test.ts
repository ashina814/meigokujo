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

import { handleAdminButton } from "../src/commands/admin-payroll-safe.js";
import { createAndPostDraft } from "../src/payday.js";

function makePlan(itemCount: number): PayoutPlan {
  return {
    period: "2026-07",
    items: Array.from({ length: itemCount }, (_, index) => ({
      userId: `user${index}`,
      total: 100_000,
      breakdown: [
        {
          roleId: `role${index}`,
          label: `役職${index}`,
          amount: 100_000,
        },
      ],
    })),
    totalPayout: itemCount * 100_000,
  };
}

function run(plan: PayoutPlan): PayoutRunRow {
  return {
    id: 7,
    period: plan.period,
    status: "draft",
    plan_json: JSON.stringify(plan),
    report_json: null,
    created_by: "user:staff1",
    approved_by: null,
    executed_at: null,
    created_at: 10,
    updated_at: 20,
  };
}

function members(count: number): Collection<string, any> {
  return new Collection(
    Array.from({ length: count }, (_, index) => {
      const member = {
        id: `user${index}`,
        displayName: `利用者${index}`,
        user: { bot: false },
        roles: { cache: new Collection([[`role${index}`, { id: `role${index}` }]]) },
      };
      return [member.id, member];
    }),
  );
}

describe("給与レビュー指摘の回帰", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T06:00:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => vi.useRealTimers());

  it("40人の短い内訳でも管理プレビューに他25名を必ず表示する", async () => {
    const plan = makePlan(40);
    const draft = run(plan);
    const services: any = {
      payroll: {
        getRunByPeriod: vi.fn(() => undefined),
        generateDraft: vi.fn(() => draft),
        planOf: vi.fn(() => plan),
      },
    };
    const interaction: any = {
      customId: "mgmt:payroll:pay",
      user: { id: "staff1" },
      guild: { members: { fetch: vi.fn(async () => members(40)) } },
      deferUpdate: vi.fn(),
      editReply: vi.fn(),
      update: vi.fn(),
      reply: vi.fn(),
    };

    await handleAdminButton(interaction, services);

    const payload = interaction.editReply.mock.calls[0]![0];
    expect(payload.embeds[0].data.description).toContain("…他 25名（添付を確認）");
    expect(payload.files[0].attachment.toString("utf8")).toContain("user39");
  });

  it("#決裁の給与案に全対象者の明細ファイルを添付する", async () => {
    const plan = makePlan(30);
    const draft = run(plan);
    const sent = vi.fn();
    const guild = { members: { fetch: vi.fn(async () => members(30)) } };
    const channel = { isTextBased: () => true, send: sent };
    const client: any = {
      guilds: { fetch: vi.fn(async () => guild) },
      channels: { fetch: vi.fn(async () => channel) },
    };
    const services: any = {
      settings: {
        getString: vi.fn((key: string) =>
          key === "guild:main" ? "guild1" : key === "channel:kessai" ? "channel1" : undefined,
        ),
      },
      payroll: {
        listRecoverableRuns: vi.fn(() => []),
        generateDraft: vi.fn(() => draft),
        planOf: vi.fn(() => plan),
      },
    };

    await createAndPostDraft(client, services, "2026-07", "system:scheduler");

    const payload = sent.mock.calls[0]![0];
    expect(payload.files[0].name).toBe("salary-draft-2026-07-run-7.txt");
    const text = payload.files[0].attachment.toString("utf8");
    expect(text).toContain("user29\t100000\t役職29[role29]=100000");
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });
});
