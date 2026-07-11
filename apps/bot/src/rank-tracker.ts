import type { Client, Message, VoiceChannel } from "discord.js";
import { ChannelType } from "discord.js";
import type { Services } from "./services.js";

/**
 * 発言XP・ボイスXPの獲得ロジックと称号アップの通知。
 * - 発言: MessageCreate ごとに 30秒クールダウン・8〜15XPをランダム付与
 * - ボイス: 5分tickで、複数人がいるVCに滞在中の人間へ 30XP（= 6XP/分相当）付与
 * - 除外: 設定 xp_excluded_channels に入っているチャンネル/親カテゴリはXP対象外
 */
const TEXT_COOLDOWN_SEC = 30;
const TEXT_XP_MIN = 8;
const TEXT_XP_MAX = 15;
const VOICE_TICK_MINUTES = 5;
const VOICE_XP_PER_TICK = 30;

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** 除外チャンネル/カテゴリの判定 */
function isExcluded(services: Services, channelId: string, parentId: string | null): boolean {
  const list = services.settings.getJson<string[]>("xp_excluded_channels", []);
  if (list.includes(channelId)) return true;
  if (parentId && list.includes(parentId)) return true;
  return false;
}

/** 発言XPの獲得＋称号変化の通知。DMや#集令は本文外で処理 */
export async function handleMessageXp(message: Message, services: Services): Promise<void> {
  if (message.author.bot) return;
  if (!message.inGuild()) return;
  if (!message.content && message.attachments.size === 0) return; // 空メッセージは無視
  const ch = message.channel;
  const parentId = "parentId" in ch ? (ch.parentId ?? null) : null;
  if (isExcluded(services, message.channelId, parentId)) return;

  const xp = rand(TEXT_XP_MIN, TEXT_XP_MAX);
  const award = services.ranks.awardText(message.author.id, xp, TEXT_COOLDOWN_SEC);
  if (!award) return; // クールダウン中
  if (award.tierUp) {
    await notifyRankUp(message.client, services, {
      userId: message.author.id,
      kind: "text",
      oldTier: award.before.tier.name,
      newTier: award.after.tier.name,
      level: award.after.level,
    });
  }
}

/** 5分tick: 各VCの人間を数え、2人以上いれば全員にボイスXPを与える */
export async function tickVoiceXp(client: Client, services: Services): Promise<void> {
  const guildId = services.settings.getString("guild:main");
  const guild = guildId ? await client.guilds.fetch(guildId).catch(() => null) : null;
  if (!guild) return;
  const channels = guild.channels.cache.filter((c) => c.type === ChannelType.GuildVoice);
  for (const [, ch] of channels) {
    const vc = ch as VoiceChannel;
    if (isExcluded(services, vc.id, vc.parentId ?? null)) continue;
    const humans = vc.members.filter((m) => !m.user.bot);
    if (humans.size < 2) continue; // 1人だけのVCは加算しない
    for (const [, m] of humans) {
      const award = services.ranks.awardVoice(m.id, VOICE_XP_PER_TICK, VOICE_TICK_MINUTES);
      if (award.tierUp) {
        await notifyRankUp(client, services, {
          userId: m.id,
          kind: "voice",
          oldTier: award.before.tier.name,
          newTier: award.after.tier.name,
          level: award.after.level,
        });
      }
    }
  }
}

async function notifyRankUp(
  client: Client,
  services: Services,
  info: { userId: string; kind: "text" | "voice"; oldTier: string; newTier: string; level: number },
): Promise<void> {
  const label = info.kind === "text" ? "発言" : "浮上";
  // 本人にDM
  const user = await client.users.fetch(info.userId).catch(() => null);
  await user
    ?.send(
      `🎖 **${label}の称号が変わりました**\nLv ${info.level} 到達 → **${info.newTier}**（旧: ${info.oldTier}）`,
    )
    .catch(() => undefined);
  // 称号レベルアップ通知: channel:rank_notify（未設定なら channel:shurei にフォールバック）
  const notifyId =
    services.settings.getString("channel:rank_notify") ?? services.settings.getString("channel:shurei");
  if (notifyId) {
    const ch = await client.channels.fetch(notifyId).catch(() => null);
    if (ch?.isTextBased() && "send" in ch) {
      await ch
        .send({
          content: `🎖 <@${info.userId}> の **${label}称号** が **${info.newTier}**（Lv ${info.level}）に到達。`,
          allowedMentions: { users: [info.userId] },
        })
        .catch(() => undefined);
    }
  }
}
