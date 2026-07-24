import type Database from "better-sqlite3";
import { EventLog } from "../events/service.js";

export type TicketKind = string;
export type TicketStatus = "open" | "claimed" | "closed";

export interface TicketRow {
  id: number;
  thread_id: string;
  user_id: string;
  kind: TicketKind;
  status: TicketStatus;
  claimed_by: string | null;
  reminded_at: number | null;
  panel_id: string | null;
  panel_name: string | null;
  panel_notify_role_ids_json: string | null;
  panel_staff_role_ids_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface TicketPanelRow {
  id: string;
  name: string;
  channel_id: string | null;
  message_id: string | null;
  title: string;
  description: string;
  button_label: string;
  button_emoji: string | null;
  notify_role_ids_json: string;
  staff_role_ids_json: string;
  enabled: 0 | 1;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface TicketPanel {
  id: string;
  name: string;
  channelId: string | null;
  messageId: string | null;
  title: string;
  description: string;
  buttonLabel: string;
  buttonEmoji: string | null;
  notifyRoleIds: string[];
  staffRoleIds: string[];
  enabled: boolean;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TicketPanelInput {
  id: string;
  name: string;
  title: string;
  description: string;
  buttonLabel: string;
  buttonEmoji?: string | null;
  notifyRoleIds?: string[];
  staffRoleIds?: string[];
  enabled?: boolean;
}

const now = () => Math.floor(Date.now() / 1000);

const LEGACY_PANELS: TicketPanelInput[] = [
  {
    id: "return",
    name: "出戻り申請",
    title: "🔄 出戻り申請 受付",
    description: [
      "以前いた方の再入城はこちらから。",
      "ボタンを押すと、あなたとスタッフだけのプライベートスレッドが開きます。",
    ].join("\n"),
    buttonLabel: "出戻り申請",
    buttonEmoji: "🔄",
  },
  {
    id: "consult",
    name: "個別相談",
    title: "❓ 個別相談 受付",
    description: [
      "運営への相談・問い合わせはこちらから。",
      "ボタンを押すと、あなたとスタッフだけのプライベートスレッドが開きます。",
    ].join("\n"),
    buttonLabel: "個別相談",
    buttonEmoji: "❓",
  },
];

const PANEL_ID_RE = /^[a-z0-9][a-z0-9_-]{1,48}$/;

function uniq(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((v) => v.trim()).filter(Boolean))];
}

function parseRoleIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? uniq(parsed.filter((v): v is string => typeof v === "string")) : [];
  } catch {
    return [];
  }
}

function panelFromRow(row: TicketPanelRow): TicketPanel {
  return {
    id: row.id,
    name: row.name,
    channelId: row.channel_id,
    messageId: row.message_id,
    title: row.title,
    description: row.description,
    buttonLabel: row.button_label,
    buttonEmoji: row.button_emoji,
    notifyRoleIds: parseRoleIds(row.notify_role_ids_json),
    staffRoleIds: parseRoleIds(row.staff_role_ids_json),
    enabled: row.enabled === 1,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** チケット（出戻り申請・個別相談）。スレッドの状態管理と24時間無応答の検知 */
export class Tickets {
  constructor(
    private readonly db: Database.Database,
    private readonly events: EventLog,
  ) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ticket_panels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        channel_id TEXT,
        message_id TEXT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        button_label TEXT NOT NULL,
        button_emoji TEXT,
        notify_role_ids_json TEXT NOT NULL DEFAULT '[]',
        staff_role_ids_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        created_by TEXT,
        updated_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.addTicketColumn("panel_id", "TEXT");
    this.addTicketColumn("panel_name", "TEXT");
    this.addTicketColumn("panel_notify_role_ids_json", "TEXT");
    this.addTicketColumn("panel_staff_role_ids_json", "TEXT");
    const ts = now();
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO ticket_panels
        (id, name, title, description, button_label, button_emoji, notify_role_ids_json, staff_role_ids_json, enabled, created_by, updated_by, created_at, updated_at)
      VALUES
        (@id, @name, @title, @description, @buttonLabel, @buttonEmoji, '[]', '[]', 1, 'system:legacy-seed', 'system:legacy-seed', @ts, @ts)
    `);
    for (const panel of LEGACY_PANELS) insert.run({ ...panel, buttonEmoji: panel.buttonEmoji ?? null, ts });
  }

  private addTicketColumn(name: string, decl: string): void {
    const cols = this.db.prepare("PRAGMA table_info(tickets)").all() as { name: string }[];
    if (!cols.some((c) => c.name === name)) this.db.exec(`ALTER TABLE tickets ADD COLUMN ${name} ${decl}`);
  }

  defaultPanel(id: string): TicketPanel | undefined {
    const found = LEGACY_PANELS.find((p) => p.id === id);
    if (!found) return undefined;
    const ts = now();
    return {
      id: found.id,
      name: found.name,
      channelId: null,
      messageId: null,
      title: found.title,
      description: found.description,
      buttonLabel: found.buttonLabel,
      buttonEmoji: found.buttonEmoji ?? null,
      notifyRoleIds: [],
      staffRoleIds: [],
      enabled: true,
      createdBy: "system:legacy-default",
      updatedBy: "system:legacy-default",
      createdAt: ts,
      updatedAt: ts,
    };
  }

  getPanel(id: string): TicketPanel | undefined {
    const row = this.db.prepare("SELECT * FROM ticket_panels WHERE id = ?").get(id) as TicketPanelRow | undefined;
    return row ? panelFromRow(row) : this.defaultPanel(id);
  }

  listPanels(includeDisabled = true): TicketPanel[] {
    const rows = this.db
      .prepare(`SELECT * FROM ticket_panels ${includeDisabled ? "" : "WHERE enabled = 1"} ORDER BY enabled DESC, id ASC`)
      .all() as TicketPanelRow[];
    return rows.map(panelFromRow);
  }

  upsertPanel(input: TicketPanelInput, actor = "system"): TicketPanel {
    const id = input.id.trim().toLowerCase();
    if (!PANEL_ID_RE.test(id)) throw new Error("ERR_INVALID_PANEL_ID");
    if (!input.name.trim() || !input.title.trim() || !input.description.trim() || !input.buttonLabel.trim()) {
      throw new Error("ERR_INVALID_PANEL");
    }
    const existing = this.getPanel(id);
    const ts = now();
    const notify = JSON.stringify(input.notifyRoleIds === undefined ? (existing?.notifyRoleIds ?? []) : uniq(input.notifyRoleIds));
    const staff = JSON.stringify(input.staffRoleIds === undefined ? (existing?.staffRoleIds ?? []) : uniq(input.staffRoleIds));
    this.db
      .prepare(
        `INSERT INTO ticket_panels
          (id, name, title, description, button_label, button_emoji, notify_role_ids_json, staff_role_ids_json, enabled, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          name=excluded.name,
          title=excluded.title,
          description=excluded.description,
          button_label=excluded.button_label,
          button_emoji=excluded.button_emoji,
          notify_role_ids_json=excluded.notify_role_ids_json,
          staff_role_ids_json=excluded.staff_role_ids_json,
          enabled=excluded.enabled,
          updated_by=excluded.updated_by,
          updated_at=excluded.updated_at`,
      )
      .run(
        id,
        input.name.trim(),
        input.title.trim(),
        input.description.trim(),
        input.buttonLabel.trim(),
        input.buttonEmoji?.trim() || null,
        notify,
        staff,
        input.enabled === false ? 0 : 1,
        actor,
        actor,
        ts,
        ts,
      );
    this.events.log("ticket_panel_saved", { actor, payload: { id } });
    return this.getPanel(id)!;
  }

  setPanelRoles(id: string, type: "notify" | "staff", roleIds: string[], actor = "system"): TicketPanel | undefined {
    const panel = this.getPanel(id);
    if (!panel) return undefined;
    const column = type === "notify" ? "notify_role_ids_json" : "staff_role_ids_json";
    this.db
      .prepare(`UPDATE ticket_panels SET ${column} = ?, updated_by = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(uniq(roleIds)), actor, now(), id);
    this.events.log("ticket_panel_roles_set", { actor, payload: { id, type, roleIds: uniq(roleIds) } });
    return this.getPanel(id);
  }

  setPanelMessage(id: string, channelId: string, messageId: string, actor = "system"): TicketPanel | undefined {
    const savePanelMessage = this.db.transaction(() => {
      this.db
        .prepare("UPDATE ticket_panels SET channel_id = ?, message_id = ?, updated_by = ?, updated_at = ? WHERE id = ?")
        .run(channelId, messageId, actor, now(), id);
      this.events.log("ticket_panel_installed", { actor, payload: { id, channelId, messageId } });
      return this.getPanel(id);
    });
    return savePanelMessage();
  }

  disablePanel(id: string, actor = "system"): TicketPanel | undefined {
    this.db.prepare("UPDATE ticket_panels SET enabled = 0, updated_by = ?, updated_at = ? WHERE id = ?").run(actor, now(), id);
    this.events.log("ticket_panel_disabled", { actor, payload: { id } });
    return this.getPanel(id);
  }

  create(
    threadId: string,
    userId: string,
    kind: TicketKind,
    panel?: Pick<TicketPanel, "id" | "name" | "notifyRoleIds" | "staffRoleIds">,
  ): TicketRow {
    const ts = now();
    const createTicket = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO tickets
            (thread_id, user_id, kind, status, panel_id, panel_name, panel_notify_role_ids_json, panel_staff_role_ids_json, created_at, updated_at)
           VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          threadId,
          userId,
          kind,
          panel?.id ?? null,
          panel?.name ?? null,
          panel ? JSON.stringify(uniq(panel.notifyRoleIds)) : null,
          panel ? JSON.stringify(uniq(panel.staffRoleIds)) : null,
          ts,
          ts,
        );
      this.events.log("ticket_opened", { target: userId, payload: { kind, threadId, panelId: panel?.id ?? null } });
      return this.get(threadId)!;
    });
    return createTicket();
  }

  rollbackCreate(threadId: string, actor = "system", reason = "ticket initialization failed"): TicketRow | undefined {
    const ticket = this.get(threadId);
    if (!ticket) return undefined;
    this.db.prepare("DELETE FROM tickets WHERE thread_id = ?").run(threadId);
    this.events.log("ticket_open_rolled_back", {
      actor,
      target: ticket.user_id,
      payload: { threadId, kind: ticket.kind, panelId: ticket.panel_id, reason },
    });
    return ticket;
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

  openByUserPanel(userId: string, panelId: string): TicketRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM tickets WHERE user_id = ? AND panel_id = ? AND status IN ('open','claimed') ORDER BY id DESC LIMIT 1",
      )
      .get(userId, panelId) as TicketRow | undefined;
  }

  countOpen(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM tickets WHERE status IN ('open','claimed')")
      .get() as { c: number };
    return row.c;
  }
}
