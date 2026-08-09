import { EmbedBuilder, type Client } from "discord.js";
import { recoverCasinoAsync, type PersistentTableRestoreResult, type PersistentTableRow, type RecoverCasinoResult } from "@meigokujo/core";
import type { Services } from "../services.js";

const UNKNOWN_MESSAGE = 10008;

export async function recoverCasinoWithPersistentTables(client: Client, services: Services): Promise<RecoverCasinoResult> {
  const result = await recoverCasinoAsync({
    db: services.db,
    status: services.casinoStatus,
    integrity: services.casinoIntegrity,
    chipTx: services.chipTx,
    escrow: services.escrow,
    reservations: services.reservations,
    registry: services.recoveryRegistry,
    events: services.events,
    chipFlow: services.chipFlow,
    persistentTableRestore: () => restorePersistentTableMessages(client, services),
  });
  logCasinoRecovery(result);
  return result;
}

export async function restorePersistentTableMessages(
  client: Client,
  services: Services,
): Promise<PersistentTableRestoreResult> {
  const result: PersistentTableRestoreResult = { restored: 0, replaced: 0, disputed: 0, failed: [] };
  const tables = services.persistentTables.listLiveTables();
  for (const table of tables) {
    try {
      const outcome = await restoreOnePersistentTableMessage(client, services, table);
      result.restored += outcome === "restored" ? 1 : 0;
      result.replaced += outcome === "replaced" ? 1 : 0;
      result.disputed += outcome === "disputed" ? 1 : 0;
    } catch (e) {
      result.failed.push({ tableId: table.tableId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

async function restoreOnePersistentTableMessage(
  client: Client,
  services: Services,
  table: PersistentTableRow,
): Promise<"restored" | "replaced" | "disputed"> {
  if (!table.guildId || !table.channelId || !table.messageId) {
    services.persistentTables.markDisputedFromRecovery(table.tableId, table.revision, "missing Discord message binding");
    return "disputed";
  }

  let channel: unknown;
  try {
    channel = await fetchChannel(client, table.channelId);
  } catch (e) {
    return markDisputed(services, table, describeDiscordError(e));
  }

  if (!isUsableTextChannel(channel) || channel.guildId !== table.guildId) {
    services.persistentTables.markDisputedFromRecovery(table.tableId, table.revision, "Discord channel is missing, non-text, or belongs to a different guild");
    return "disputed";
  }

  const payload = renderPersistentTableRecoveryMessage(table);
  try {
    const message = await channel.messages.fetch(table.messageId);
    await message.edit(payload);
    services.events.log("casino_table_message_restored", {
      actor: "system:recovery",
      target: table.tableId,
      payload: { channelId: table.channelId, messageId: table.messageId },
    });
    return "restored";
  } catch (e) {
    if (errorCode(e) !== UNKNOWN_MESSAGE) {
      return markDisputed(services, table, describeDiscordError(e));
    }
  }

  try {
    const replacement = await channel.send(payload);
    services.persistentTables.bindMessage(
      table.tableId,
      { guildId: table.guildId, channelId: table.channelId, messageId: replacement.id },
      table.revision,
    );
    return "replaced";
  } catch (e) {
    return markDisputed(services, table, describeDiscordError(e));
  }
}

function renderPersistentTableRecoveryMessage(table: PersistentTableRow): { embeds: EmbedBuilder[] } {
  const tableId = boundField(table.tableId);
  const gameKey = boundField(table.gameKey);
  const state = boundField(table.state, 64);
  const embed = new EmbedBuilder()
    .setTitle("Casino Table")
    .setDescription("Persistent table restored after bot startup.")
    .addFields(
      { name: "Table", value: tableId, inline: true },
      { name: "Game", value: gameKey, inline: true },
      { name: "State", value: state, inline: true },
    )
    .setFooter({ text: `rev ${table.revision}` })
    .setColor(table.state === "disputed" ? 0xb91c1c : 0x2563eb);
  return { embeds: [embed] };
}

function markDisputed(services: Services, table: PersistentTableRow, reason: string): "disputed" {
  services.persistentTables.markDisputedFromRecovery(table.tableId, table.revision, boundField(reason, 500));
  return "disputed";
}

function boundField(value: string, maxLength = 256): string {
  const trimmed = value.trim() || "(empty)";
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 3)}...`;
}

async function fetchChannel(client: Client, channelId: string): Promise<unknown> {
  const cached = client.channels.cache.get(channelId);
  if (cached) return cached;
  return client.channels.fetch(channelId);
}

function isUsableTextChannel(channel: unknown): channel is {
  guildId: string;
  messages: { fetch(id: string): Promise<{ edit(payload: unknown): Promise<unknown> }> };
  send(payload: unknown): Promise<{ id: string }>;
} {
  const candidate = channel as {
    guildId?: unknown;
    isTextBased?: () => boolean;
    messages?: { fetch?: unknown };
    send?: unknown;
  } | null;
  return (
    !!candidate &&
    typeof candidate.guildId === "string" &&
    (typeof candidate.isTextBased !== "function" || candidate.isTextBased()) &&
    typeof candidate.messages?.fetch === "function" &&
    typeof candidate.send === "function"
  );
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

function describeDiscordError(error: unknown): string {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  return code ? `Discord ${code}: ${message}` : message;
}

export function logCasinoRecovery(r: RecoverCasinoResult): void {
  const reservations = r.releasedReservations.released
    ? `reservations released ${r.releasedReservations.count}`
    : "reservations not released";
  const summary =
    `kept ${r.keptHolders} / refunded ${r.refundedSessions}(${r.refundedTotal.toLocaleString("ja-JP")}Ld) / ` +
    `quarantined ${r.quarantined} / mismatched ${r.mismatched.length} / refund failed ${r.failedSessions.length} / ${reservations}`;
  switch (r.outcome) {
    case "opened":
      console.log(`[casino] startup recovery completed and opened: ${summary}`);
      break;
    case "held":
    case "manual":
      console.warn(`[casino] startup recovery held: ${r.reason} / ${summary}`);
      break;
    default:
      console.error(`[casino] startup recovery stopped (${r.outcome}): ${r.reason} / ${summary}`);
      break;
  }
}
