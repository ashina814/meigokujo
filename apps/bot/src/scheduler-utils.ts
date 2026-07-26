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

/**
 * 見出し＋行リストを 2000 文字以内へ分割して送る。
 *
 * 対象者が増えると単一 content が上限を超え、DiscordAPIError[50035] で
 * 「送信そのものが失敗」する。定期ジョブの中で throw すると後続処理まで巻き添えになるため、
 * 一覧を投げる箇所は必ずこれを通す。components はボタンの二重表示を避けて最後のチャンクにだけ付ける。
 */
export async function sendChunkedLines(
  channel: TextChannel,
  header: string,
  lines: string[],
  opts: { components?: ActionRowBuilder<ButtonBuilder>[]; allowedRoleIds?: string[] } = {},
): Promise<void> {
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
  for (let i = 0; i < chunks.length; i++) {
    await channel.send({
      content: chunks[i]!,
      allowedMentions: { parse: [], roles: opts.allowedRoleIds ?? [] },
      ...(i === chunks.length - 1 && opts.components ? { components: opts.components } : {}),
    });
  }
}
