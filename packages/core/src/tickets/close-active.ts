import type Database from "better-sqlite3";
import { EventLog } from "../events/service.js";
import { Tickets as BaseTickets, type TicketRow } from "./service.js";

/**
 * 未完了チケットを最初の1回だけクローズする。
 *
 * 古い確認画面が複数残っていても、status が open / claimed の行を
 * 最初に更新できた呼び出しだけが成功し、完了イベントも1件だけ記録する。
 */
export function closeActiveTicket(
  db: Database.Database,
  events: EventLog,
  threadId: string,
  staffId: string,
): TicketRow | undefined {
  const close = db.transaction(() => {
    const ticket = db.prepare("SELECT * FROM tickets WHERE thread_id = ?").get(threadId) as TicketRow | undefined;
    if (!ticket) return undefined;

    const changed = db
      .prepare(
        "UPDATE tickets SET status = 'closed', updated_at = ? WHERE thread_id = ? AND status IN ('open','claimed')",
      )
      .run(Math.floor(Date.now() / 1000), threadId);
    if (changed.changes !== 1) return undefined;

    events.log("ticket_closed", {
      actor: staffId,
      target: ticket.user_id,
      payload: { threadId, kind: ticket.kind },
    });
    return db.prepare("SELECT * FROM tickets WHERE thread_id = ?").get(threadId) as TicketRow;
  });

  return close();
}

/**
 * 公開API用のチケットサービス。
 * close() 自体が原子的なので、Bot以外の利用経路でも二重クローズを起こさない。
 */
export class Tickets extends BaseTickets {
  constructor(
    private readonly closeDb: Database.Database,
    private readonly closeEvents: EventLog,
  ) {
    super(closeDb, closeEvents);
  }

  override close(threadId: string, staffId: string): TicketRow | undefined {
    return closeActiveTicket(this.closeDb, this.closeEvents, threadId, staffId);
  }
}
