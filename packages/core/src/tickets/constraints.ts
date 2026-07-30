import type Database from "better-sqlite3";

const ACTIVE_TICKET_UNIQUE_INDEX = "idx_tickets_user_panel_active_unique";

interface DuplicateActiveTicketGroup {
  user_id: string;
  panel_id: string;
  ticket_count: number;
  threads: string;
}

/**
 * 同じ利用者・同じ受付パネルでは、未完了チケットを1件だけにする。
 *
 * - 別の受付パネルなら同じ利用者でも同時に作成可能
 * - closed は対象外なので、クローズ後は同じ受付から再作成可能
 * - panel_id がない旧チケットは移行互換のため対象外
 */
export function ensureTicketOpenUniqueness(db: Database.Database): void {
  const duplicates = db
    .prepare(
      `SELECT
         user_id,
         panel_id,
         COUNT(*) AS ticket_count,
         GROUP_CONCAT(thread_id, ', ') AS threads
       FROM tickets
       WHERE panel_id IS NOT NULL
         AND status IN ('open', 'claimed')
       GROUP BY user_id, panel_id
       HAVING COUNT(*) > 1
       ORDER BY user_id, panel_id`,
    )
    .all() as DuplicateActiveTicketGroup[];

  if (duplicates.length > 0) {
    const details = duplicates
      .map(
        (row) =>
          `user=${row.user_id} panel=${row.panel_id} count=${row.ticket_count} threads=[${row.threads}]`,
      )
      .join("; ");
    throw new Error(
      `ticket active uniqueness migration blocked: duplicate active tickets exist: ${details}`,
    );
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${ACTIVE_TICKET_UNIQUE_INDEX}
      ON tickets(user_id, panel_id)
      WHERE panel_id IS NOT NULL
        AND status IN ('open', 'claimed');
  `);
}
