import type { ActionRowBuilder, ButtonBuilder, TextChannel } from "discord.js";
import type { Services } from "./services.js";

const schedulerInFlightMarkers = new Set<string>();

export async function runSchedulerTaskOnce(
  services: Pick<Services, "settings">,
  marker: string,
  actor: string,
  task: () => Promise<void> | void,
): Promise<boolean> {
  if (services.settings.getString(marker)) return false;
  if (schedulerInFlightMarkers.has(marker)) return false;

  schedulerInFlightMarkers.add(marker);
  try {
    await task();
    services.settings.set(marker, "1", actor);
    return true;
  } finally {
    schedulerInFlightMarkers.delete(marker);
  }
}

/** Discordの1メッセージあたりの content 上限 */
const DISCORD_CONTENT_MAX = 2000;

interface ChunkProgressState {
  chunks: string[];
  sent: number[];
}

function parseChunkProgress(raw: string | undefined): ChunkProgressState | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<ChunkProgressState>;
    if (!Array.isArray(parsed.chunks) || !parsed.chunks.every((value) => typeof value === "string")) return undefined;
    if (!Array.isArray(parsed.sent) || !parsed.sent.every((value) => Number.isInteger(value) && value >= 0)) return undefined;
    return { chunks: parsed.chunks, sent: parsed.sent };
  } catch {
    return undefined;
  }
}

function buildChunks(header: string, lines: string[]): string[] {
  const chunks: string[] = [];
  let cur = header;
  for (const raw of lines) {
    const line = raw.length > DISCORD_CONTENT_MAX ? `${raw.slice(0, DISCORD_CONTENT_MAX - 1)}…` : raw;
    if (`${cur}\n${line}`.length > DISCORD_CONTENT_MAX) {
      chunks.push(cur);
      cur = line;
    } else {
      cur = cur ? `${cur}\n${line}` : line;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * 見出し＋行リストを 2000 文字以内へ分割して送る。
 *
 * progressを指定した場合、最初に確定したチャンク列と送信済み番号をsettingsへ保存する。
 * 途中のDiscord送信失敗やBot再起動後は未送信チャンクだけを再開するため、
 * 先頭チャンクの再投稿やスタッフロールの重複メンションを防げる。
 */
export async function sendChunkedLines(
  channel: TextChannel,
  header: string,
  lines: string[],
  opts: {
    components?: ActionRowBuilder<ButtonBuilder>[];
    allowedRoleIds?: string[];
    progress?: {
      services: Pick<Services, "settings">;
      key: string;
      actor: string;
    };
  } = {},
): Promise<void> {
  if (opts.progress && opts.components) {
    throw new Error("sendChunkedLines:progress_with_components_not_supported");
  }

  const generatedChunks = buildChunks(header, lines);
  const stored = opts.progress
    ? parseChunkProgress(opts.progress.services.settings.getString(opts.progress.key))
    : undefined;
  const chunks = stored?.chunks.length ? stored.chunks : generatedChunks;
  const sent = new Set(stored?.sent ?? []);

  if (opts.progress && !stored) {
    opts.progress.services.settings.set(
      opts.progress.key,
      { chunks, sent: [] },
      opts.progress.actor,
    );
  }

  for (let i = 0; i < chunks.length; i++) {
    if (sent.has(i)) continue;
    await channel.send({
      content: chunks[i]!,
      allowedMentions: { parse: [], roles: i === 0 ? (opts.allowedRoleIds ?? []) : [] },
      ...(i === chunks.length - 1 && opts.components ? { components: opts.components } : {}),
    });
    sent.add(i);
    if (opts.progress) {
      opts.progress.services.settings.set(
        opts.progress.key,
        { chunks, sent: [...sent].sort((a, b) => a - b) },
        opts.progress.actor,
      );
    }
  }
}
