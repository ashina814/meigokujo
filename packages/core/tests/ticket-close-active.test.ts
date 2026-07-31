import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";
import { Tickets } from "../src/tickets/service.js";

describe("チケットクローズの原子性", () => {
  it("古い確認画面から複数回実行されても最初の1回だけ成功する", () => {
    const db = openDb(":memory:");
    const events = new EventLog(db);
    const tickets = new Tickets(db, events);
    const panel = tickets.getPanel("consult")!;
    tickets.create("thread1", "user1", panel.id, panel);

    const first = tickets.close("thread1", "user:staff1");
    const second = tickets.close("thread1", "user:staff2");

    expect(first?.status).toBe("closed");
    expect(second).toBeUndefined();
    expect(tickets.get("thread1")?.status).toBe("closed");

    const closedEvents = events.listByType("ticket_closed");
    expect(closedEvents).toHaveLength(1);
    expect(closedEvents[0]?.actor_id).toBe("user:staff1");
    db.close();
  });

  it("存在しないチケットや既に閉じたチケットではイベントを作らない", () => {
    const db = openDb(":memory:");
    const events = new EventLog(db);
    const tickets = new Tickets(db, events);
    const panel = tickets.getPanel("consult")!;
    tickets.create("thread1", "user1", panel.id, panel);
    tickets.close("thread1", "user:staff1");

    expect(tickets.close("missing", "user:staff2")).toBeUndefined();
    expect(tickets.close("thread1", "user:staff2")).toBeUndefined();
    expect(events.listByType("ticket_closed")).toHaveLength(1);
    db.close();
  });
});
