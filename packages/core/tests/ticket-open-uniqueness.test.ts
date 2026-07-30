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

  it("既存DBに重複した未完了チケットがあれば詳細付きで移行を止める", () => {
    const { db, tickets } = setup();

    tickets.create("thread-a", "user-a", "consult", panel("consult"));
    tickets.create("thread-b", "user-a", "consult", panel("consult"));

    expect(() => ensureTicketOpenUniqueness(db)).toThrowError(
      /ticket active uniqueness migration blocked: duplicate active tickets exist: user=user-a panel=consult count=2 threads=\[(?=[^\]]*thread-a)(?=[^\]]*thread-b)[^\]]+\]/,
    );
    db.close();
  });

  it("旧式のpanel_idなしチケットは互換のため制約対象外", () => {
    const { db, tickets } = setup();
    ensureTicketOpenUniqueness(db);

    tickets.create("legacy-a", "user-a", "consult");
    tickets.create("legacy-b", "user-a", "consult");

    expect(tickets.countOpen()).toBe(2);
    db.close();
  });
});
