import { describe, expect, it, vi } from "vitest";
import type { TicketPanel, TicketRow } from "@meigokujo/core";

vi.mock("../src/permissions.js", () => ({ isAdmin: () => false }));

import {
  memberHasAnyRole,
  panelIdFromTicketButton,
  panelNotifyRoleIds,
  panelStaffRoleIds,
  ticketOpenCustomId,
  ticketPanelMessageForPanel,
  ticketStaffRoleIds,
} from "../src/commands/tickets.js";

const panel = (overrides: Partial<TicketPanel> = {}): TicketPanel => ({
  id: "appeal",
  name: "異議申立",
  channelId: null,
  messageId: null,
  title: "異議申立 受付",
  description: "異議申立はこちら。",
  buttonLabel: "申立する",
  buttonEmoji: "🎫",
  notifyRoleIds: [],
  staffRoleIds: [],
  enabled: true,
  createdBy: null,
  updatedBy: null,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const ticket = (overrides: Partial<TicketRow> = {}): TicketRow => ({
  id: 1,
  thread_id: "thread1",
  user_id: "user1",
  kind: "appeal",
  status: "open",
  claimed_by: null,
  reminded_at: null,
  panel_id: "appeal",
  panel_name: "異議申立",
  panel_notify_role_ids_json: null,
  panel_staff_role_ids_json: null,
  created_at: 1,
  updated_at: 1,
  ...overrides,
});

describe("汎用チケット受付パネル", () => {
  it("パネルIDを持つ共通ボタンを生成し、旧ボタンも解決できる", () => {
    expect(ticketOpenCustomId("appeal")).toBe("ticket:open:appeal");
    expect(panelIdFromTicketButton("ticket:open:appeal")).toBe("appeal");
    expect(panelIdFromTicketButton("ticket:return")).toBe("return");
    expect(panelIdFromTicketButton("ticket:consult")).toBe("consult");

    const msg = ticketPanelMessageForPanel(panel());
    const row = msg.components![0]!.toJSON() as { components: Array<{ custom_id: string; label: string }> };
    expect(row.components[0]!.custom_id).toBe("ticket:open:appeal");
    expect(row.components[0]!.label).toBe("申立する");
  });

  it("通知ロールと対応ロールを分離し、未設定時は旧ticket_staffへフォールバックする", () => {
    const services = { settings: { getString: (key: string) => (key === "role:ticket_staff" ? "legacy_staff" : undefined) } } as any;
    expect(panelStaffRoleIds(panel({ staffRoleIds: ["staff_a", "staff_b"] }), services)).toEqual(["staff_a", "staff_b"]);
    expect(panelStaffRoleIds(panel(), services)).toEqual(["legacy_staff"]);
    expect(panelNotifyRoleIds(panel({ notifyRoleIds: ["notify_a"] }), ["staff_a"])).toEqual(["notify_a"]);
    expect(panelNotifyRoleIds(panel(), ["staff_a"])).toEqual(["staff_a"]);
  });

  it("対応権限はチケット作成時のスナップショットを優先し、なければ現行パネル・旧設定へ落ちる", () => {
    const services = {
      settings: { getString: () => "legacy_staff" },
      tickets: { getPanel: () => panel({ staffRoleIds: ["current_staff"] }) },
    } as any;
    expect(ticketStaffRoleIds(ticket({ panel_staff_role_ids_json: JSON.stringify(["snapshot_staff"]) }), services)).toEqual([
      "snapshot_staff",
    ]);
    expect(ticketStaffRoleIds(ticket({ panel_staff_role_ids_json: "[]" }), services)).toEqual(["current_staff"]);
    expect(ticketStaffRoleIds(ticket({ panel_id: null }), services)).toEqual(["legacy_staff"]);
  });

  it("無権限者は対応・クローズ権限を満たさない", () => {
    const member = { roles: { cache: { has: (id: string) => id === "staff_a" } } } as any;
    expect(memberHasAnyRole(member, ["staff_a", "staff_b"])).toBe(true);
    expect(memberHasAnyRole(member, ["other"])).toBe(false);
    expect(memberHasAnyRole(null, ["staff_a"])).toBe(false);
  });
});
