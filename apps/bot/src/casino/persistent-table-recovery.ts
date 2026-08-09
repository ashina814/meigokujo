import { EmbedBuilder, type Client } from "discord.js";
import { recoverCasino, type PersistentTableRestoreResult, type PersistentTableRow, type RecoverCasinoResult } from "@meigokujo/core";
import type { Services } from "../services.js";

const UNKNOWN_MESSAGE = 10008;
const UNKNOWN_CHANNEL = 10003;
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;

export async function recoverCasinoWithPersistentTables(client: Client, services: Services): Promise<RecoverCasinoResult> {
  services.casinoStatus.beginStartupCheck("system:recovery");
  let persistentTableRestore: PersistentTableRestoreResult;
  try {
    persistentTableRestore = await restorePersistentTableMessages(client, services);
  } catch (e) {
    persistentTableRestore = {
      restored: 0,
      replaced: 0,
      disputed: 0,
      failed: [{ tableId: "*", error: e instanceof Error ? e.message : String(e) }],
    };
  }
  return recoverCasino({
    db: services.db,
    status: services.casinoStatus,
    integrity: services.casinoIntegrity,
    chipTx: services.chipTx,
    escrow: services.escrow,
    reservations: services.reservations,
    registry: services.recoveryRegistry,
    events: services.events,
    chipFlow: services.chipFlow,
    persistentTableRestore,
  });
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
    if (isPermanentDiscordLookupError(e)) {
      services.persistentTables.markDisputedFromRecovery(table.tableId, table.revision, describeDiscordError(e));
      return "disputed";
    }
    throw e;
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
      if (isPermanentDiscordLookupError(e)) {
        services.persistentTables.markDisputedFromRecovery(table.tableId, table.revision, describeDiscordError(e));
        return "disputed";
      }
      throw e;
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
    if (isPermanentDiscordLookupError(e)) {
      services.persistentTables.markDisputedFromRecovery(table.tableId, table.revision, describeDiscordError(e));
      return "disputed";
    }
    throw e;
  }
}

function renderPersistentTableRecoveryMessage(table: PersistentTableRow): { embeds: EmbedBuilder[] } {
  const embed = new EmbedBuilder()
    .setTitle("Casino Table")
    .setDescription("Persistent table restored after bot startup.")
    .addFields(
      { name: "Table", value: table.tableId, inline: true },
      { name: "Game", value: table.gameKey, inline: true },
      { name: "State", value: table.state, inline: true },
    )
    .setFooter({ text: `rev ${table.revision}` })
    .setColor(table.state === "disputed" ? 0xb91c1c : 0x2563eb);
  return { embeds: [embed] };
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

function isPermanentDiscordLookupError(error: unknown): boolean {
  const code = errorCode(error);
  return code === UNKNOWN_CHANNEL || code === MISSING_ACCESS || code === MISSING_PERMISSIONS;
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

function describeDiscordError(error: unknown): string {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  return code ? `Discord ${code}: ${message}` : message;
}
