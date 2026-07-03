import type Database from "better-sqlite3";
import { EventLog } from "../events/service.js";

export type TicketKind = "return" | "consult";
export type TicketStatus = "open" | "claimed" | "closed";

export interface TicketRow {
  id: number;
  thread_id: string;
  user_id: string;
  kind: TicketKind;
  status: TicketStatus;
  claimed_by: string | null;
  reminded_at: number | null;
  created_at: number;
  updated_at: number;
}

const now = () => Math.floor(Date.now() / 1000);

/** チケット（出戻り申請・個別相談）。スレッドの状態管理と24時間無応答の検知 */
export class Tickets {
  constructor(
    private readonly db: Database.Database,
    private readonly events: EventLog,
  ) {}

  create(threadId: string, userId: string, kind: TicketKind): TicketRow {
    const ts = now();
    this.db
      .prepare(
        "INSERT INTO tickets (thread_id, user_id, kind, status, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?)",
      )
      .run(threadId, userId, kind, ts, ts);
    this.events.log("ticket_opened", { target: userId, payload: { kind, threadId } });
    return this.get(threadId)!;
  }

  get(threadId: string): TicketRow | undefined {
    return this.db.prepare("SELECT * FROM tickets WHERE thread_id = ?").get(threadId) as
      | TicketRow
      | undefined;
  }

  claim(threadId: string, staffId: string): TicketRow | undefined {
    this.db
      .prepare("UPDATE tickets SET status = 'claimed', claimed_by = ?, updated_at = ? WHERE thread_id = ? AND status = 'open'")
      .run(staffId, now(), threadId);
    return this.get(threadId);
  }

  close(threadId: string, staffId: string): TicketRow | undefined {
    const ticket = this.get(threadId);
    if (!ticket) return undefined;
    this.db
      .prepare("UPDATE tickets SET status = 'closed', updated_at = ? WHERE thread_id = ?")
      .run(now(), threadId);
    this.events.log("ticket_closed", { actor: staffId, target: ticket.user_id, payload: { threadId, kind: ticket.kind } });
    return this.get(threadId);
  }

  /** 24時間（既定）誰も対応していない open チケット。リマインド済みは除く */
  staleOpen(hours = 24): TicketRow[] {
    const cutoff = now() - hours * 3600;
    return this.db
      .prepare("SELECT * FROM tickets WHERE status = 'open' AND created_at < ? AND reminded_at IS NULL")
      .all(cutoff) as TicketRow[];
  }

  markReminded(threadId: string): void {
    this.db.prepare("UPDATE tickets SET reminded_at = ? WHERE thread_id = ?").run(now(), threadId);
  }

  countOpen(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM tickets WHERE status IN ('open','claimed')")
      .get() as { c: number };
    return row.c;
  }
}
