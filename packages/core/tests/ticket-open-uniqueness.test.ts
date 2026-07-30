import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";
import { Tickets } from "../src/tickets/service.js";

function panel(id: string) {
  return {
    id,
    name: id,
    notifyRoleIds: [],
    staffRoleIds: [],
  };
}

function setup() {
  const db = openDb(":memory:");
  const tickets = new Tickets(db, new EventLog(db));
  return { db, tickets };
}

function insertRawTicket(
  db: Database.Database,
  input: {
    threadId: string;
    userId: string;
    panelId?: string | null;
    status?: "open" | "claimed" | "closed";
  },
): void {
  db.prepare(
    `INSERT INTO tickets
      (thread_id, user_id, kind, status, panel_id, created_at, updated_at)
     VALUES (?, ?, 'consult', ?, ?, 100, 100)`,
  ).run(input.threadId, input.userId, input.status ?? "open", input.panelId ?? null);
}

describe("チケット未完了数のDB制約", () => {
  it("Ticketsを生成するだけで同じ利用者・同じ受付パネルの未完了チケットが1件に制限される", () => {
    const { db, tickets } = setup();

    tickets.create("thread-a", "user-a", "consult", panel("consult"));

    expect(() =>
      tickets.create("thread-b", "user-a", "consult", panel("consult")),
    ).toThrow(/UNIQUE constraint failed: tickets\.user_id, tickets\.panel_id/);

    expect(tickets.openByUserPanel("user-a", "consult")?.thread_id).toBe("thread-a");
    db.close();
  });

  it("同じ利用者でも別の受付パネルなら同時に作成できる", () => {
    const { db, tickets } = setup();

    tickets.create("thread-consult", "user-a", "consult", panel("consult"));
    tickets.create("thread-return", "user-a", "return", panel("return"));

    expect(tickets.openByUserPanel("user-a", "consult")?.thread_id).toBe("thread-consult");
    expect(tickets.openByUserPanel("user-a", "return")?.thread_id).toBe("thread-return");
    db.close();
  });

  it("クローズ後は同じ受付パネルから再作成できる", () => {
    const { db, tickets } = setup();

    tickets.create("thread-old", "user-a", "consult", panel("consult"));
    tickets.close("thread-old", "staff-a");
    tickets.create("thread-new", "user-a", "consult", panel("consult"));

    expect(tickets.openByUserPanel("user-a", "consult")?.thread_id).toBe("thread-new");
    db.close();
  });

  it("同じ受付パネルでも利用者が違えば同時に作成できる", () => {
    const { db, tickets } = setup();

    tickets.create("thread-a", "user-a", "consult", panel("consult"));
    tickets.create("thread-b", "user-b", "consult", panel("consult"));

    expect(tickets.countOpen()).toBe(2);
    db.close();
  });

  it("既存DBに重複した現行チケットがあればTickets生成時に詳細付きで停止する", () => {
    const db = openDb(":memory:");
    insertRawTicket(db, { threadId: "thread-a", userId: "user-a", panelId: "consult" });
    insertRawTicket(db, { threadId: "thread-b", userId: "user-a", panelId: "consult" });

    expect(() => new Tickets(db, new EventLog(db))).toThrowError(
      /ticket active uniqueness migration blocked: duplicate active tickets exist: user=user-a panel=consult count=2 threads=\[(?=[^\]]*thread-a)(?=[^\]]*thread-b)[^\]]+\]/,
    );
    db.close();
  });

  it("旧式チケットだけを削除し、受付パネル設定は保持する", () => {
    const db = openDb(":memory:");
    db.prepare(
      `INSERT INTO ticket_panels
        (id, name, title, description, button_label, button_emoji, notify_role_ids_json, staff_role_ids_json, enabled, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "legacy-panel",
      "残す受付",
      "残す受付タイトル",
      "この受付パネル設定は削除しない",
      "受付する",
      "📮",
      '["notify-role"]',
      '["staff-role"]',
      0,
      "tester",
      "tester",
      100,
      100,
    );
    insertRawTicket(db, { threadId: "legacy-a", userId: "user-a" });
    insertRawTicket(db, { threadId: "legacy-b", userId: "user-a" });

    const tickets = new Tickets(db, new EventLog(db));

    expect(tickets.migrationResult.deletedLegacyTickets).toBe(2);
    expect(tickets.get("legacy-a")).toBeUndefined();
    expect(tickets.get("legacy-b")).toBeUndefined();
    expect(tickets.getPanel("legacy-panel")).toMatchObject({
      id: "legacy-panel",
      name: "残す受付",
      title: "残す受付タイトル",
      description: "この受付パネル設定は削除しない",
      buttonLabel: "受付する",
      buttonEmoji: "📮",
      notifyRoleIds: ["notify-role"],
      staffRoleIds: ["staff-role"],
      enabled: false,
    });
    db.close();
  });

  it("現行チケット重複で初期化停止した場合は旧式チケット削除も巻き戻す", () => {
    const db = openDb(":memory:");
    insertRawTicket(db, { threadId: "legacy-a", userId: "user-legacy" });
    insertRawTicket(db, { threadId: "thread-a", userId: "user-a", panelId: "consult" });
    insertRawTicket(db, { threadId: "thread-b", userId: "user-a", panelId: "consult" });

    expect(() => new Tickets(db, new EventLog(db))).toThrow(
      /ticket active uniqueness migration blocked/,
    );
    expect(
      db.prepare("SELECT panel_id FROM tickets WHERE thread_id = ?").get("legacy-a"),
    ).toEqual({ panel_id: null });
    db.close();
  });

  it("Ticketsを再生成しても制約適用は冪等", () => {
    const db = openDb(":memory:");
    const events = new EventLog(db);
    const first = new Tickets(db, events);
    const second = new Tickets(db, events);

    expect(first.migrationResult.deletedLegacyTickets).toBe(0);
    expect(second.migrationResult.deletedLegacyTickets).toBe(0);
    second.create("thread-a", "user-a", "consult", panel("consult"));
    expect(() => second.create("thread-b", "user-a", "consult", panel("consult"))).toThrow(
      /UNIQUE constraint failed/,
    );
    db.close();
  });
});
