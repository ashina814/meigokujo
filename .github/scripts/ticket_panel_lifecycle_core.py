from pathlib import Path
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)


def replace_regex(text: str, pattern: str, replacement: str, label: str, flags: int = 0) -> str:
    new_text, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 regex match, found {count}")
    return new_text


service_path = Path("packages/core/src/tickets/service.ts")
service = service_path.read_text()
service = replace_once(service, "  enabled: 0 | 1;\n  created_by: string | null;\n", "  enabled: 0 | 1;\n  archived_at: number | null;\n  archived_by: string | null;\n  created_by: string | null;\n", "TicketPanelRow archive fields")
service = replace_once(service, "  enabled: boolean;\n  createdBy: string | null;\n", "  enabled: boolean;\n  archivedAt?: number | null;\n  archivedBy?: string | null;\n  createdBy: string | null;\n", "TicketPanel archive fields")
service = replace_once(service, """export interface TicketPanelInput {
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
""", """export interface TicketPanelInput {
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

export interface TicketPanelRemovalResult {
  mode: "deleted" | "archived";
  panel: TicketPanel;
  totalTickets: number;
  activeTickets: number;
}
""", "TicketPanelRemovalResult")
service = replace_once(service, "    enabled: row.enabled === 1,\n    createdBy: row.created_by,\n", "    enabled: row.enabled === 1,\n    archivedAt: row.archived_at,\n    archivedBy: row.archived_by,\n    createdBy: row.created_by,\n", "panelFromRow archive fields")
service = replace_once(service, "        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),\n        created_by TEXT,\n", "        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),\n        archived_at INTEGER,\n        archived_by TEXT,\n        created_by TEXT,\n", "ticket_panels DDL archive fields")
service = replace_once(service, "    this.addTicketColumn(\"panel_staff_role_ids_json\", \"TEXT\");\n    const ts = now();\n", "    this.addTicketColumn(\"panel_staff_role_ids_json\", \"TEXT\");\n    this.addPanelColumn(\"archived_at\", \"INTEGER\");\n    this.addPanelColumn(\"archived_by\", \"TEXT\");\n    const ts = now();\n", "ticket panel migration columns")
service = replace_once(service, """  private addTicketColumn(name: string, decl: string): void {
    const cols = this.db.prepare("PRAGMA table_info(tickets)").all() as { name: string }[];
    if (!cols.some((c) => c.name === name)) this.db.exec(`ALTER TABLE tickets ADD COLUMN ${name} ${decl}`);
  }
""", """  private addTicketColumn(name: string, decl: string): void {
    const cols = this.db.prepare("PRAGMA table_info(tickets)").all() as { name: string }[];
    if (!cols.some((c) => c.name === name)) this.db.exec(`ALTER TABLE tickets ADD COLUMN ${name} ${decl}`);
  }

  private addPanelColumn(name: string, decl: string): void {
    const cols = this.db.prepare("PRAGMA table_info(ticket_panels)").all() as { name: string }[];
    if (!cols.some((c) => c.name === name)) this.db.exec(`ALTER TABLE ticket_panels ADD COLUMN ${name} ${decl}`);
  }
""", "addPanelColumn helper")
service = replace_once(service, "      enabled: true,\n      createdBy: \"system:legacy-default\",\n", "      enabled: true,\n      archivedAt: null,\n      archivedBy: null,\n      createdBy: \"system:legacy-default\",\n", "default panel archive fields")
service = replace_regex(service, r"  listPanels\(includeDisabled = true\): TicketPanel\[\] \{.*?\n  \}\n\n  upsertPanel", '''  listPanels(includeDisabled = true, includeArchived = false): TicketPanel[] {
    const where: string[] = [];
    if (!includeDisabled) where.push("enabled = 1");
    if (!includeArchived) where.push("archived_at IS NULL");
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM ticket_panels ${clause} ORDER BY archived_at IS NOT NULL ASC, enabled DESC, id ASC`)
      .all() as TicketPanelRow[];
    return rows.map(panelFromRow);
  }

  upsertPanel''', "listPanels lifecycle filter", flags=re.S)
service = replace_once(service, "    const existing = this.getPanel(id);\n    const ts = now();\n", "    const existing = this.getPanel(id);\n    if (existing?.archivedAt) throw new Error(\"ERR_PANEL_ARCHIVED\");\n    const ts = now();\n", "upsert archived guard")
service = replace_regex(service, r"  setPanelRoles\(id: string, type: \"notify\" \| \"staff\", roleIds: string\[\], actor = \"system\"\): TicketPanel \| undefined \{.*?\n  \}\n\n  setPanelMessage", '''  setPanelRoles(id: string, type: "notify" | "staff", roleIds: string[], actor = "system"): TicketPanel | undefined {
    const panel = this.getPanel(id);
    if (!panel || panel.archivedAt) return undefined;
    const column = type === "notify" ? "notify_role_ids_json" : "staff_role_ids_json";
    const normalized = uniq(roleIds);
    const changed = this.db
      .prepare(`UPDATE ticket_panels SET ${column} = ?, updated_by = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL`)
      .run(JSON.stringify(normalized), actor, now(), id);
    if (changed.changes === 0) return undefined;
    this.events.log("ticket_panel_roles_set", {
      actor,
      payload: { id, type, before: type === "notify" ? panel.notifyRoleIds : panel.staffRoleIds, after: normalized },
    });
    return this.getPanel(id);
  }

  setPanelMessage''', "setPanelRoles lifecycle guard", flags=re.S)
service = replace_regex(service, r"  setPanelMessage\(id: string, channelId: string, messageId: string, actor = \"system\"\): TicketPanel \| undefined \{.*?\n  disablePanel\(id: string, actor = \"system\"\): TicketPanel \| undefined \{.*?\n  \}\n\n  create\(", '''  setPanelMessage(id: string, channelId: string, messageId: string, actor = "system"): TicketPanel | undefined {
    const before = this.getPanel(id);
    if (!before || before.archivedAt) return undefined;
    const savePanelMessage = this.db.transaction(() => {
      const changed = this.db.prepare("UPDATE ticket_panels SET channel_id = ?, message_id = ?, updated_by = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL").run(channelId, messageId, actor, now(), id);
      if (changed.changes === 0) return undefined;
      this.events.log("ticket_panel_installed", { actor, payload: { id, before: { channelId: before.channelId, messageId: before.messageId }, after: { channelId, messageId } } });
      return this.getPanel(id);
    });
    return savePanelMessage();
  }

  setPanelEnabled(id: string, enabled: boolean, actor = "system"): TicketPanel | undefined {
    const before = this.getPanel(id);
    if (!before || before.archivedAt) return undefined;
    const changed = this.db.prepare("UPDATE ticket_panels SET enabled = ?, updated_by = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL").run(enabled ? 1 : 0, actor, now(), id);
    if (changed.changes === 0) return undefined;
    this.events.log(enabled ? "ticket_panel_enabled" : "ticket_panel_disabled", { actor, payload: { id, before: { enabled: before.enabled }, after: { enabled } } });
    return this.getPanel(id);
  }

  disablePanel(id: string, actor = "system"): TicketPanel | undefined { return this.setPanelEnabled(id, false, actor); }
  enablePanel(id: string, actor = "system"): TicketPanel | undefined { return this.setPanelEnabled(id, true, actor); }

  clearPanelMessage(id: string, actor = "system", reason = "manual", forceDisable = false): TicketPanel | undefined {
    const before = this.getPanel(id);
    if (!before) return undefined;
    const clear = this.db.transaction(() => {
      const changed = this.db.prepare(`UPDATE ticket_panels SET channel_id = NULL, message_id = NULL, enabled = CASE WHEN ? = 1 THEN 0 ELSE enabled END, updated_by = ?, updated_at = ? WHERE id = ?`).run(forceDisable ? 1 : 0, actor, now(), id);
      if (changed.changes === 0) return undefined;
      const after = this.getPanel(id);
      this.events.log("ticket_panel_uninstalled", { actor, payload: { id, reason, forceDisabled: forceDisable, before: { channelId: before.channelId, messageId: before.messageId, enabled: before.enabled }, after: { channelId: null, messageId: null, enabled: after?.enabled ?? false } } });
      return after;
    });
    return clear();
  }

  panelTicketCounts(id: string): { total: number; active: number } {
    const row = this.db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status IN ('open','claimed') THEN 1 ELSE 0 END) AS active FROM tickets WHERE panel_id = ?`).get(id) as { total: number; active: number | null };
    return { total: Number(row.total ?? 0), active: Number(row.active ?? 0) };
  }

  removePanelRegistration(id: string, actor = "system"): TicketPanelRemovalResult | undefined {
    const panel = this.getPanel(id);
    if (!panel) return undefined;
    const counts = this.panelTicketCounts(id);
    const isLegacy = LEGACY_PANELS.some((legacy) => legacy.id === id);
    const mode: TicketPanelRemovalResult["mode"] = counts.total === 0 && !isLegacy ? "deleted" : "archived";
    const remove = this.db.transaction(() => {
      if (mode === "deleted") {
        this.db.prepare("DELETE FROM ticket_panels WHERE id = ?").run(id);
        this.events.log("ticket_panel_deleted", { actor, payload: { id, before: panel, after: null, totalTickets: counts.total, activeTickets: counts.active } });
      } else {
        const ts = now();
        this.db.prepare(`UPDATE ticket_panels SET enabled = 0, channel_id = NULL, message_id = NULL, archived_at = ?, archived_by = ?, updated_by = ?, updated_at = ? WHERE id = ?`).run(ts, actor, actor, ts, id);
        this.events.log("ticket_panel_archived", { actor, payload: { id, before: panel, after: { enabled: false, channelId: null, messageId: null, archivedAt: ts, archivedBy: actor }, totalTickets: counts.total, activeTickets: counts.active } });
      }
    });
    remove();
    return { mode, panel, totalTickets: counts.total, activeTickets: counts.active };
  }

  create(''', "ticket panel lifecycle methods", flags=re.S)
service_path.write_text(service)

bootstrap_path = Path("packages/core/src/db/bootstrap.ts")
bootstrap = bootstrap_path.read_text()
bootstrap = replace_once(bootstrap, "  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),\n  created_by TEXT,\n", "  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),\n  archived_at INTEGER,\n  archived_by TEXT,\n  created_by TEXT,\n", "bootstrap ticket panel archive fields")
bootstrap_path.write_text(bootstrap)

tickets_path = Path("apps/bot/src/commands/tickets.ts")
tickets = tickets_path.read_text()
tickets = replace_once(tickets, """export function ticketPanelMessageForPanel(panel: TicketPanel): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setTitle(panel.title)
    .setDescription(panel.description)
    .setColor(panel.enabled ? 0x0ea5e9 : 0x64748b)
    .setFooter({ text: `受付ID: ${panel.id}${panel.enabled ? "" : " / 無効"}` });
  const button = new ButtonBuilder()
    .setCustomId(ticketOpenCustomId(panel.id))
    .setLabel(panel.buttonLabel)
    .setStyle(panel.enabled ? ButtonStyle.Primary : ButtonStyle.Secondary)
    .setDisabled(!panel.enabled);
""", """export function ticketPanelMessageForPanel(panel: TicketPanel): MessageCreateOptions {
  const available = panel.enabled && !panel.archivedAt;
  const stateLabel = panel.archivedAt ? " / アーカイブ済み" : available ? "" : " / 無効";
  const embed = new EmbedBuilder()
    .setTitle(panel.title)
    .setDescription(panel.description)
    .setColor(available ? 0x0ea5e9 : 0x64748b)
    .setFooter({ text: `受付ID: ${panel.id}${stateLabel}` });
  const button = new ButtonBuilder()
    .setCustomId(ticketOpenCustomId(panel.id))
    .setLabel(panel.buttonLabel)
    .setStyle(available ? ButtonStyle.Primary : ButtonStyle.Secondary)
    .setDisabled(!available);
""", "ticket panel archived rendering")
tickets = replace_once(tickets, "  if (!panel.enabled) {\n    await interaction.reply({ content: `「${panel.name}」は現在受付停止中です。`, flags: MessageFlags.Ephemeral });\n    return;\n  }\n", "  if (panel.archivedAt) {\n    await interaction.reply({ content: `「${panel.name}」は終了した受付です。`, flags: MessageFlags.Ephemeral });\n    return;\n  }\n  if (!panel.enabled) {\n    await interaction.reply({ content: `「${panel.name}」は現在受付停止中です。`, flags: MessageFlags.Ephemeral });\n    return;\n  }\n", "openTicket archived guard")
tickets_path.write_text(tickets)
