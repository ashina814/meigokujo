import {
  ChannelType,
  EmbedBuilder,
  type Client,
  type GuildBasedChannel,
  type GuildMember,
  type PartialGuildMember,
} from "discord.js";
import type { Services } from "./services.js";
import type { InviteDetection } from "./invite-tracker.js";

type SendableGuildChannel = Extract<
  GuildBasedChannel,
  { type: ChannelType.GuildText | ChannelType.GuildAnnouncement | ChannelType.PublicThread | ChannelType.PrivateThread | ChannelType.AnnouncementThread }
>;

/**
 * 入退室ログ。GuildMemberAdd/Remove を受けて channel:member_log に embed を投稿する。
 * 未設定なら投稿しない（他機能のフォールバック無し）。
 * Bot ユーザーの参加/退室は対象外。
 *
 * casino-bot 系ではなく CommunityCore 入退室ログ相当の詳細版。
 * 招待リンク検出は InviteTracker.detectInvite() が返す InviteDetection を使う。
 */

const C_JOIN = 0x22c55e; // green
const C_LEAVE = 0x991b1b; // deep red

function fmtDateJa(d: Date | null | undefined): string {
  if (!d) return "不明";
  const s = d.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return s;
}

function fmtElapsed(from: Date | null | undefined, to = new Date()): string {
  if (!from) return "不明";
  const ms = to.getTime() - from.getTime();
  if (ms < 0) return "0分";
  const min = Math.floor(ms / 60_000);
  const days = Math.floor(min / 1440);
  const hours = Math.floor((min % 1440) / 60);
  const mins = min % 60;
  if (days > 0) {
    const years = Math.floor(days / 365);
    if (years >= 1) return `${years}年${days % 365 > 0 ? ` (${days}日)` : ""}`;
    return `${days}日 ${hours}時間`;
  }
  if (hours > 0) return `${hours}時間 ${mins}分`;
  return `${mins}分`;
}

async function resolveLogChannel(client: Client, services: Services): Promise<SendableGuildChannel | null> {
  const chId = services.settings.getString("channel:member_log");
  if (!chId) return null;
  const ch = await client.channels.fetch(chId).catch(() => null);
  if (!ch) return null;
  if (
    ch.type === ChannelType.GuildText ||
    ch.type === ChannelType.GuildAnnouncement ||
    ch.type === ChannelType.PublicThread ||
    ch.type === ChannelType.PrivateThread ||
    ch.type === ChannelType.AnnouncementThread
  ) {
    return ch as SendableGuildChannel;
  }
  return null;
}

/**
 * 入城ログ。参加時に呼ぶ。invite は検出できなかった場合 null。
 * memberCount は投稿時点のギルド人数を渡す（bot を含む）。
 */
export async function postJoinLog(
  client: Client,
  services: Services,
  member: GuildMember,
  invite: InviteDetection | null,
): Promise<void> {
  if (member.user.bot) return;
  const ch = await resolveLogChannel(client, services);
  if (!ch) return;

  const user = member.user;
  const displayName = member.displayName;
  const avatarUrl = member.displayAvatarURL({ size: 256 });
  const guildMemberCount = member.guild.memberCount;

  const mentionLines = [
    `参加した人: <@${user.id}>`,
    invite?.inviterId ? `招待した人: <@${invite.inviterId}>` : "招待した人: **検出できず**",
  ].join("\n");

  const userLines = [`${displayName}`, `ユーザーID: \`${user.id}\``].join("\n");

  const inviteBlock = invite
    ? [
        `招待URL: ${invite.url}`,
        `招待コード: \`${invite.code}\``,
        invite.inviterId ? `招待した人: <@${invite.inviterId}>` : "招待した人: —",
        invite.channelId ? `招待先チャンネル: <#${invite.channelId}>` : "招待先チャンネル: —",
        `使用回数: **${invite.uses}回**`,
      ].join("\n")
    : "招待リンクは特定できなかった（Vanity URL 経由・キャッシュずれ 等）。";

  const roles = member.roles.cache.filter((r) => r.id !== member.guild.id);
  const roleLines =
    roles.size === 0 ? "なし" : roles.map((r) => `<@&${r.id}>`).join(" ");

  const createdAt = user.createdAt;
  const joinedAt = member.joinedAt ?? new Date();

  const embed = new EmbedBuilder()
    .setAuthor({ name: "📥 入城", iconURL: avatarUrl })
    .setColor(C_JOIN)
    .setTitle(`✅ 新しい住人が城に降り立った`)
    .setThumbnail(avatarUrl)
    .addFields(
      { name: "📢 メンション", value: mentionLines, inline: false },
      { name: "👤 ユーザー", value: userLines, inline: false },
      { name: "🔗 使用された招待リンク", value: inviteBlock, inline: false },
      {
        name: "🆕 アカウント作成",
        value: `${fmtDateJa(createdAt)}\n経過: ${fmtElapsed(createdAt)}`,
        inline: true,
      },
      {
        name: "📌 入城",
        value: `${fmtDateJa(joinedAt)}\n<t:${Math.floor(joinedAt.getTime() / 1000)}:R>`,
        inline: true,
      },
      {
        name: "📊 サーバー情報",
        value: `現在の人数: **${guildMemberCount}人**\nBot: ${user.bot ? "はい" : "いいえ"}`,
        inline: true,
      },
      {
        name: `🎭 所持ロール (${roles.size}件)`,
        value: roleLines,
        inline: false,
      },
    )
    .setFooter({ text: "冥獄城 入退室ログ" })
    .setTimestamp(new Date());

  await ch.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => undefined);
}

/**
 * 退城ログ。GuildMemberRemove で呼ぶ（partial 可）。
 * 退城時は招待情報は再現できないので在籍期間 + 所持ロールを主軸に表示。
 */
export async function postLeaveLog(
  client: Client,
  services: Services,
  member: GuildMember | PartialGuildMember,
): Promise<void> {
  const user = member.user;
  if (user?.bot) return;
  const ch = await resolveLogChannel(client, services);
  if (!ch) return;

  const displayName = member.displayName ?? user?.username ?? "不明";
  const avatarUrl = member.displayAvatarURL?.({ size: 256 }) ?? user?.displayAvatarURL({ size: 256 }) ?? null;
  const guildMemberCount = member.guild.memberCount;
  const joinedAt = member.joinedAt ?? null;
  const now = new Date();

  const roles = member.roles?.cache?.filter((r) => r.id !== member.guild.id);
  const roleCount = roles?.size ?? 0;
  const roleLines =
    !roles || roleCount === 0 ? "なし" : roles.map((r) => `<@&${r.id}>`).join(" ");

  const embed = new EmbedBuilder()
    .setAuthor({ name: "📤 退城", iconURL: avatarUrl ?? undefined })
    .setColor(C_LEAVE)
    .setTitle(`💀 住人が城を去った`)
    .setThumbnail(avatarUrl ?? null)
    .addFields(
      {
        name: "👤 ユーザー",
        value: [
          `${displayName}`,
          user ? `<@${user.id}>` : "—",
          user ? `ユーザーID: \`${user.id}\`` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        inline: false,
      },
      {
        name: "📌 入城していた期間",
        value: joinedAt
          ? `${fmtDateJa(joinedAt)} 〜 現在\n在籍: **${fmtElapsed(joinedAt, now)}**`
          : "入城時刻を追跡できていない",
        inline: false,
      },
      {
        name: "📊 サーバー情報",
        value: `現在の人数: **${guildMemberCount}人**（1人減）`,
        inline: true,
      },
      {
        name: `🎭 退城時の所持ロール (${roleCount}件)`,
        value: roleLines,
        inline: false,
      },
    )
    .setFooter({ text: "冥獄城 入退室ログ" })
    .setTimestamp(now);

  await ch.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => undefined);
}
