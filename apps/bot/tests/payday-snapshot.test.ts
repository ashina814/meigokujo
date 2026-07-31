import { createHash } from "node:crypto";
import { Collection } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PayoutPlan, PayoutRunRow } from "@meigokujo/core";

vi.mock("../src/permissions.js", () => ({ isAdmin: () => true }));

import { createAndPostDraft, handlePaydayButton } from "../src/payday.js";

const plan: PayoutPlan = {
  period: "2026-07",
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

function run(status: PayoutRunRow["status"] = "draft"): PayoutRunRow {
  return {
    id: 7,
    period: "2026-07",
    status,
    plan_json: JSON.stringify(plan),
    report_json: null,
    created_by: "system:scheduler",
    approved_by: status === "draft" ? null : "user:staff1",
    executed_at: status === "executed" ? 100 : null,
    created_at: 10,
    updated_at: 20,
  };
}

function componentIds(payload: any): string[] {
  return payload.components.flatMap((row: any) =>
    row.toJSON().components.map((component: { custom_id?: string }) => component.custom_id).filter(Boolean),
  );
}

function buttonHarness(customId: string, current = run()) {
  const approved = run("approved");
  const services = {
    payroll: {
      getRun: vi.fn(() => current),
      approve: vi.fn(() => approved),
      cancel: vi.fn(),
      execute: vi.fn(() => ({ succeeded: 1, skippedAsPaid: 0, failed: [], totalPaid: 180_000 })),
    },
    ledger: { moneySupply: vi.fn(() => 9_999_999) },
  };
  const interaction: any = {
    customId,
    user: { id: "staff1" },
    message: { embeds: [] },
    deferUpdate: vi.fn(),
    editReply: vi.fn(),
    reply: vi.fn(),
  };
  return { interaction, services };
}

describe("#決裁の給与スナップショット", () => {
  beforeEach(() => vi.clearAllMocks());

  it("投稿する承認・見送りボタンへ支給案ハッシュを埋め込む", async () => {
    const sent = vi.fn();
    const member = {
      id: "user1",
      user: { bot: false },
      roles: { cache: new Collection([["role1", { id: "role1" }]]) },
    };
    const guild = { members: { fetch: vi.fn(async () => new Collection([[member.id, member]])) } };
    const channel = { isTextBased: () => true, send: sent };
    const client: any = {
      guilds: { fetch: vi.fn(async () => guild) },
      channels: { fetch: vi.fn(async () => channel) },
    };
    const current = run();
    const services: any = {
      settings: {
        getString: vi.fn((key: string) => (key === "guild:main" ? "guild1" : key === "channel:kessai" ? "channel1" : undefined)),
      },
      payroll: {
        generateDraft: vi.fn(() => current),
        planOf: vi.fn(() => plan),
      },
    };

    await createAndPostDraft(client, services, "2026-07", "system:scheduler");

    const hash = createHash("sha256").update(current.plan_json).digest("hex").slice(0, 12);
    const payload = sent.mock.calls[0]![0];
    expect(componentIds(payload)).toEqual([`pay:ok:7:${hash}`, `pay:no:7:${hash}`]);
    expect(payload.embeds[0].data.description.length).toBeLessThanOrEqual(3_900);
  });

  it("古いハッシュの承認ボタンでは承認も支給もしない", async () => {
    const h = buttonHarness("pay:ok:7:000000000000");

    await handlePaydayButton(h.interaction, h.services as any);

    expect(h.interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(h.services.payroll.approve).not.toHaveBeenCalled();
    expect(h.services.payroll.execute).not.toHaveBeenCalled();
    expect(h.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("作成後に再集計または更新") }),
    );
  });

  it("ハッシュのない旧パネルは安全に拒否する", async () => {
    const h = buttonHarness("pay:ok:7");

    await handlePaydayButton(h.interaction, h.services as any);

    expect(h.interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("作成後に再集計または更新") }),
    );
    expect(h.interaction.deferUpdate).not.toHaveBeenCalled();
    expect(h.services.payroll.getRun).not.toHaveBeenCalled();
    expect(h.services.payroll.execute).not.toHaveBeenCalled();
  });

  it("同じスナップショットだけを承認して支給する", async () => {
    const current = run();
    const hash = createHash("sha256").update(current.plan_json).digest("hex").slice(0, 12);
    const h = buttonHarness(`pay:ok:7:${hash}`, current);

    await handlePaydayButton(h.interaction, h.services as any);

    expect(h.services.payroll.approve).toHaveBeenCalledWith(7, "user:staff1");
    expect(h.services.payroll.execute).toHaveBeenCalledWith(7, "user:staff1");
    expect(h.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("支給完了") }),
    );
  });
});
