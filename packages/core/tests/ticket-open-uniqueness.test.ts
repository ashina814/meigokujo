import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";
import { Tickets } from "../src/tickets/service.js";
import { ensureTicketOpenUniqueness } from "../src/tickets/constraints.js";

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

describe("チケット未完了数のDB制約", () => {
  it("同じ利用者・同じ受付パネルの未完了チケットは1件まで", () => {
    const { db, tickets } = setup();
    ensureTicketOpenUniqueness(db);

    tickets.create("thread-a", "user-a", "consult", panel("consult"));

    expect(() =>
      tickets.create("thread-b", "user-a", "consult", panel("consult")),
    ).toThrow(/UNIQUE constraint failed: tickets\.user_id, tickets\.panel_id/);

    expect(tickets.openByUserPanel("user-a", "consult")?.thread_id).toBe("thread-a");
    db.close();
  });

  it("同じ利用者でも別の受付パネルなら同時に作成できる", () => {
    const { db, tickets } = setup();
    ensureTicketOpenUniqueness(db);

    tickets.create("thread-consult", "user-a", "consult", panel("consult"));
    tickets.create("thread-return", "user-a", "return", panel("return"));

    expect(tickets.openByUserPanel("user-a", "consult")?.thread_id).toBe("thread-consult");
    expect(tickets.openByUserPanel("user-a", "return")?.thread_id).toBe("thread-return");
    db.close();
  });

  it("クローズ後は同じ受付パネルから再作成できる", () => {
    const { db, tickets } = setup();
    ensureTicketOpenUniqueness(db);

    tickets.create("thread-old", "user-a", "consult", panel("consult"));
    tickets.close("thread-old", "staff-a");
    tickets.create("thread-new", "user-a", "consult", panel("consult"));

    expect(tickets.openByUserPanel("user-a", "consult")?.thread_id).toBe("thread-new");
    db.close();
  });

  it("同じ受付パネルでも利用者が違えば同時に作成できる", () => {
    const { db, tickets } = setup();
    ensureTicketOpenUniqueness(db);

    tickets.create("thread-a", "user-a", "consult", panel("consult"));
    tickets.create("thread-b", "user-b", "consult", panel("consult"));

    expect(tickets.countOpen()).toBe(2);
    db.close();
  });

  it("既存DBに重複した現行チケットがあれば詳細付きで移行を止める", () => {
    const { db, tickets } = setup();

    tickets.create("thread-a", "user-a", "consult", panel("consult"));
    tickets.create("thread-b", "user-a", "consult", panel("consult"));

    expect(() => ensureTicketOpenUniqueness(db)).toThrowError(
      /ticket active uniqueness migration blocked: duplicate active tickets exist: user=user-a panel=consult count=2 threads=\[(?=[^\]]*thread-a)(?=[^\]]*thread-b)[^\]]+\]/,
    );
    db.close();
  });

  it("旧式チケットだけを削除し、受付パネル設定は保持する", () => {
    const { db, tickets } = setup();
    tickets.upsertPanel({
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
    tickets.create("legacy-a", "user-a", "consult");
    tickets.create("legacy-b", "user-a", "consult");

    const result = ensureTicketOpenUniqueness(db);

    expect(result.deletedLegacyTickets).toBe(2);
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

  it("現行チケット重複で移行停止した場合は旧式チケット削除も巻き戻す", () => {
    const { db, tickets } = setup();
    tickets.create("legacy-a", "user-legacy", "consult");
    tickets.create("thread-a", "user-a", "consult", panel("consult"));
    tickets.create("thread-b", "user-a", "consult", panel("consult"));

    expect(() => ensureTicketOpenUniqueness(db)).toThrow(
      /ticket active uniqueness migration blocked/,
    );
    expect(tickets.get("legacy-a")?.panel_id).toBeNull();
    db.close();
  });
});
