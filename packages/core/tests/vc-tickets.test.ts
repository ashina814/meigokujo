import { describe, expect, it, vi, afterEach } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { VcTracker } from "../src/vc/service.js";
import { Tickets } from "../src/tickets/service.js";
import { EventLog } from "../src/events/service.js";

afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const db = openDb(":memory:");
  return { db, vc: new VcTracker(db), tickets: new Tickets(db, new EventLog(db)) };
}

describe("VC計測", () => {
  it("入室→退出でセグメントが閉じ、浮上実績に集計される", () => {
    vi.useFakeTimers();
    const { vc } = setup();
    vi.setSystemTime(new Date("2026-07-04T12:00:00Z"));
    vc.open("alice", "vc1", null, false, false);
    vi.setSystemTime(new Date("2026-07-04T13:30:00Z"));
    vc.close("alice");

    const p = vc.presence("alice", 14);
    expect(p.totalSeconds).toBe(90 * 60);
    expect(p.daysSeen).toBe(1);
    expect(p.perChannel).toEqual([{ channelId: "vc1", seconds: 5400 }]);
  });

  it("チャンネル移動・ミュート変化は別セグメントになり、対象VC絞り込みが効く", () => {
    vi.useFakeTimers();
    const { vc } = setup();
    vi.setSystemTime(new Date("2026-07-04T12:00:00Z"));
    vc.open("alice", "vc1", null, false, false);
    vi.setSystemTime(new Date("2026-07-04T12:10:00Z"));
    vc.open("alice", "vc2", null, false, false); // 移動: vc1を閉じてvc2を開く
    vi.setSystemTime(new Date("2026-07-04T12:40:00Z"));
    vc.close("alice");

    const all = vc.presence("alice", 14);
    expect(all.totalSeconds).toBe(40 * 60);
    const whitelisted = vc.presence("alice", 14, ["vc1"]);
    expect(whitelisted.totalSeconds).toBe(10 * 60);
  });

  it("閉じ損ね（クラッシュ）は起動時に上限つきで閉じられる", () => {
    vi.useFakeTimers();
    const { vc } = setup();
    vi.setSystemTime(new Date("2026-07-04T00:00:00Z"));
    vc.open("alice", "vc1", null, false, false);
    // 2日後に再起動した想定 → 6時間で打ち切り
    vi.setSystemTime(new Date("2026-07-06T00:00:00Z"));
    expect(vc.closeAllDangling()).toBe(1);
    expect(vc.presence("alice", 14).totalSeconds).toBe(6 * 3600);
  });

  it("totalsByUser: 全ユーザーの累計VC時間を全VC対象で集計（位階判定用）", () => {
    vi.useFakeTimers();
    const { vc } = setup();
    vi.setSystemTime(new Date("2026-07-04T12:00:00Z"));
    vc.open("alice", "vc1", null, false, false);
    vc.open("bob", "vc2", null, false, false);
    vi.setSystemTime(new Date("2026-07-04T12:30:00Z"));
    vc.close("bob"); // 30分
    vi.setSystemTime(new Date("2026-07-04T13:00:00Z"));
    vc.close("alice"); // 60分

    const totals = vc.totalsByUser(30);
    expect(totals.find((t) => t.userId === "alice")?.seconds).toBe(60 * 60);
    expect(totals.find((t) => t.userId === "bob")?.seconds).toBe(30 * 60);
    expect(totals[0]?.userId).toBe("alice"); // 多い順
  });

  it("lastSeen が最終浮上時刻を返す（死亡判定の材料）", () => {
    vi.useFakeTimers();
    const { vc } = setup();
    expect(vc.lastSeen("alice")).toBeNull();
    vi.setSystemTime(new Date("2026-07-04T12:00:00Z"));
    vc.open("alice", "vc1", null, false, false);
    vi.setSystemTime(new Date("2026-07-04T12:30:00Z"));
    vc.close("alice");
    expect(vc.lastSeen("alice")).toBe(Math.floor(new Date("2026-07-04T12:30:00Z").getTime() / 1000));
  });
});

describe("チケット", () => {
  it("作成→対応→クローズのライフサイクル", () => {
    const { tickets } = setup();
    tickets.create("th1", "alice", "return");
    expect(tickets.get("th1")!.status).toBe("open");
    tickets.claim("th1", "staff1");
    expect(tickets.get("th1")!.claimed_by).toBe("staff1");
    tickets.close("th1", "staff1");
    expect(tickets.get("th1")!.status).toBe("closed");
  });

  it("24時間無応答の open チケットだけが staleOpen に出る（claimed・リマインド済みは除外）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T00:00:00Z"));
    const { tickets } = setup();
    tickets.create("old_open", "a", "consult");
    tickets.create("old_claimed", "b", "consult");
    tickets.claim("old_claimed", "staff");
    vi.setSystemTime(new Date("2026-07-05T01:00:00Z")); // 25時間後
    tickets.create("fresh", "c", "return");

    const stale = tickets.staleOpen(24);
    expect(stale.map((t) => t.thread_id)).toEqual(["old_open"]);

    tickets.markReminded("old_open");
    expect(tickets.staleOpen(24)).toEqual([]);
  });

  it("既存の出戻り・個別相談パネルを互換シードする", () => {
    const { tickets } = setup();
    const panels = tickets.listPanels();
    expect(panels.map((p) => p.id)).toContain("return");
    expect(panels.map((p) => p.id)).toContain("consult");
    expect(tickets.getPanel("return")!.buttonLabel).toBe("出戻り申請");
  });

  it("複数ロールを持つ汎用チケットパネルを作成・設置できる", () => {
    const { tickets } = setup();
    const panel = tickets.upsertPanel(
      {
        id: "finance_help",
        name: "会計相談",
        title: "会計相談 受付",
        description: "会計の相談はこちら。",
        buttonLabel: "相談する",
        notifyRoleIds: ["role_notify_a", "role_notify_b", "role_notify_a"],
        staffRoleIds: ["role_staff_a", "role_staff_b"],
      },
      "user:admin",
    );
    expect(panel.notifyRoleIds).toEqual(["role_notify_a", "role_notify_b"]);
    expect(panel.staffRoleIds).toEqual(["role_staff_a", "role_staff_b"]);

    const installed = tickets.setPanelMessage(panel.id, "channel1", "message1", "user:admin")!;
    expect(installed.channelId).toBe("channel1");
    expect(installed.messageId).toBe("message1");

    const clearedNotify = tickets.setPanelRoles(panel.id, "notify", [], "user:admin")!;
    const clearedStaff = tickets.setPanelRoles(panel.id, "staff", [], "user:admin")!;
    expect(clearedNotify.notifyRoleIds).toEqual([]);
    expect(clearedStaff.staffRoleIds).toEqual([]);
  });

  it("表示文の更新だけでは既存の通知・対応ロールを消さない", () => {
    const { tickets } = setup();
    tickets.upsertPanel(
      {
        id: "finance_help",
        name: "会計相談",
        title: "会計相談 受付",
        description: "会計の相談はこちら。",
        buttonLabel: "相談する",
        notifyRoleIds: ["role_notify"],
        staffRoleIds: ["role_staff"],
      },
      "user:admin",
    );
    const updated = tickets.upsertPanel(
      {
        id: "finance_help",
        name: "会計相談 改",
        title: "会計相談 改",
        description: "表示文だけ変更。",
        buttonLabel: "相談する",
      },
      "user:admin2",
    );
    expect(updated.notifyRoleIds).toEqual(["role_notify"]);
    expect(updated.staffRoleIds).toEqual(["role_staff"]);
  });

  it("パネル設定変更後も既存チケットの出所とロールスナップショットが残る", () => {
    const { tickets } = setup();
    const panel = tickets.upsertPanel(
      {
        id: "appeal",
        name: "異議申立",
        title: "異議申立 受付",
        description: "異議申立はこちら。",
        buttonLabel: "申立する",
        notifyRoleIds: ["role_notify_old"],
        staffRoleIds: ["role_staff_old"],
      },
      "user:admin",
    );
    tickets.create("thread_appeal", "alice", panel.id, panel);

    tickets.upsertPanel(
      {
        id: "appeal",
        name: "異議申立 改名後",
        title: "異議申立 改名後",
        description: "変更後。",
        buttonLabel: "送る",
        notifyRoleIds: ["role_notify_new"],
        staffRoleIds: ["role_staff_new"],
      },
      "user:admin2",
    );

    const ticket = tickets.get("thread_appeal")!;
    expect(ticket.panel_id).toBe("appeal");
    expect(ticket.panel_name).toBe("異議申立");
    expect(JSON.parse(ticket.panel_notify_role_ids_json!)).toEqual(["role_notify_old"]);
    expect(JSON.parse(ticket.panel_staff_role_ids_json!)).toEqual(["role_staff_old"]);
  });

  it("無効パネルと旧ticket_staffフォールバック用の空ロール設定を扱える", () => {
    const { tickets } = setup();
    tickets.upsertPanel(
      {
        id: "closed_panel",
        name: "閉鎖受付",
        title: "閉鎖受付",
        description: "いまは閉鎖。",
        buttonLabel: "送る",
        notifyRoleIds: [],
        staffRoleIds: [],
      },
      "user:admin",
    );
    const disabled = tickets.disablePanel("closed_panel", "user:admin")!;
    expect(disabled.enabled).toBe(false);
    expect(disabled.staffRoleIds).toEqual([]);

    tickets.create("legacy_thread", "bob", "consult");
    const legacy = tickets.get("legacy_thread")!;
    expect(legacy.panel_id).toBeNull();
    expect(legacy.panel_staff_role_ids_json).toBeNull();
  });

  it("同じ利用者・同じパネルの未完了チケットを検出できる", () => {
    const { tickets } = setup();
    const panel = tickets.getPanel("consult")!;
    tickets.create("thread1", "alice", "consult", panel);
    expect(tickets.openByUserPanel("alice", "consult")!.thread_id).toBe("thread1");
    tickets.close("thread1", "staff");
    expect(tickets.openByUserPanel("alice", "consult")).toBeUndefined();
  });
});


describe("チケット受付パネルのライフサイクル", () => {
  it("無効化後に再有効化でき、撤去は登録内容を残す", () => {
    const { tickets } = setup();
    const panel = tickets.upsertPanel({ id: "lifecycle", name: "ライフサイクル受付", title: "受付", description: "説明", buttonLabel: "送る", notifyRoleIds: ["notify"], staffRoleIds: ["staff"] }, "user:admin");
    tickets.setPanelMessage(panel.id, "channel", "message", "user:admin");
    expect(tickets.disablePanel(panel.id, "user:admin")!.enabled).toBe(false);
    expect(tickets.enablePanel(panel.id, "user:admin")!.enabled).toBe(true);
    const cleared = tickets.clearPanelMessage(panel.id, "user:admin", "test uninstall")!;
    expect(cleared.channelId).toBeNull();
    expect(cleared.messageId).toBeNull();
    expect(cleared.name).toBe("ライフサイクル受付");
    expect(cleared.staffRoleIds).toEqual(["staff"]);
  });

  it("利用履歴のない独自受付は完全削除する", () => {
    const { tickets } = setup();
    tickets.upsertPanel({ id: "unused_panel", name: "未使用", title: "未使用", description: "未使用", buttonLabel: "送る" }, "user:admin");
    const result = tickets.removePanelRegistration("unused_panel", "user:admin")!;
    expect(result.mode).toBe("deleted");
    expect(result.totalTickets).toBe(0);
    expect(tickets.getPanel("unused_panel")).toBeUndefined();
  });

  it("利用履歴のある受付はアーカイブし、未完了チケットを変更しない", () => {
    const { tickets } = setup();
    const panel = tickets.upsertPanel({ id: "used_panel", name: "使用済み", title: "使用済み", description: "使用済み", buttonLabel: "送る" }, "user:admin");
    tickets.setPanelMessage(panel.id, "channel", "message", "user:admin");
    tickets.create("thread_used", "alice", panel.id, panel);
    const result = tickets.removePanelRegistration(panel.id, "user:admin")!;
    expect(result.mode).toBe("archived");
    expect(result.totalTickets).toBe(1);
    expect(result.activeTickets).toBe(1);
    expect(tickets.get("thread_used")!.status).toBe("open");
    expect(tickets.getPanel(panel.id)!.archivedAt).not.toBeNull();
    expect(tickets.getPanel(panel.id)!.enabled).toBe(false);
    expect(tickets.getPanel(panel.id)!.channelId).toBeNull();
    expect(tickets.listPanels().map((item) => item.id)).not.toContain(panel.id);
    expect(tickets.listPanels(true, true).map((item) => item.id)).toContain(panel.id);
    expect(tickets.setPanelRoles(panel.id, "staff", ["new"], "user:admin")).toBeUndefined();
    expect(tickets.setPanelMessage(panel.id, "new-channel", "new-message", "user:admin")).toBeUndefined();
    expect(tickets.enablePanel(panel.id, "user:admin")).toBeUndefined();
  });

  it("旧来受付は履歴がなくても再シードを避けるためアーカイブする", () => {
    const { tickets } = setup();
    const result = tickets.removePanelRegistration("return", "user:admin")!;
    expect(result.mode).toBe("archived");
    expect(tickets.getPanel("return")!.archivedAt).not.toBeNull();
  });

  it("撤去失敗用の強制無効化を同一操作で記録する", () => {
    const { db, tickets } = setup();
    tickets.upsertPanel({ id: "unsafe_orphan", name: "残存対策", title: "残存対策", description: "残存対策", buttonLabel: "送る" }, "user:admin");
    tickets.setPanelMessage("unsafe_orphan", "channel", "message", "user:admin");
    const panel = tickets.clearPanelMessage("unsafe_orphan", "user:admin", "delete failed", true)!;
    expect(panel.enabled).toBe(false);
    expect(panel.channelId).toBeNull();
    const event = db.prepare("SELECT payload_json FROM events WHERE type = 'ticket_panel_uninstalled' ORDER BY id DESC LIMIT 1").get() as { payload_json: string };
    expect(JSON.parse(event.payload_json).forceDisabled).toBe(true);
  });
});
