import {
  AttachmentBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type GuildMember,
  type User,
} from "discord.js";
import {
  TEXT_TIERS,
  VOICE_TIERS,
  tierFor,
  textLevel,
  textProgress,
  voiceLevel,
  voiceProgress,
} from "@meigokujo/core";
import { renderRankCard } from "../render/rank-card.js";
import type { Services } from "../services.js";

export const rankingCommand = new SlashCommandBuilder()
  .setName("ランキング")
  .setDescription("冥獄城のランキング（発言・浮上・招待・Bump）")
  .setDMPermission(false)
  .addStringOption((o) =>
    o
      .setName("種別")
      .setDescription("見るランキング")
      .setRequired(true)
      .addChoices(
        { name: "自分のランク（4軸まとめて）", value: "me" },
        { name: "発言（テキストXP）", value: "text" },
        { name: "浮上（ボイスXP）", value: "voice" },
        { name: "招待", value: "invite" },
        { name: "Bump", value: "bump" },
      ),
  );

const LIMIT = 10;

interface TopEntry {
  userId: string;
  primary: string;
  secondary?: string;
}

function topText(services: Services): TopEntry[] {
  return services.ranks.topByText(LIMIT).map((r) => {
    const lv = textLevel(r.xp);
    const tier = tierFor(lv, TEXT_TIERS).name;
    return { userId: r.user_id, primary: `Lv.${lv} ${tier}`, secondary: `${r.messages}発言 / ${r.xp}XP` };
  });
}
function topVoice(services: Services): TopEntry[] {
  return services.ranks.topByVoice(LIMIT).map((r) => {
    const lv = voiceLevel(r.xp);
    const tier = tierFor(lv, VOICE_TIERS).name;
    return { userId: r.user_id, primary: `Lv.${lv} ${tier}`, secondary: `${r.minutes}分 / ${r.xp}XP` };
  });
}
function topBump(services: Services): TopEntry[] {
  return services.bumps.top(LIMIT).map((r) => ({ userId: r.user_id, primary: `${r.count}回` }));
}
function topInvite(services: Services): TopEntry[] {
  const rows = services.db
    .prepare(
      `SELECT inviter_user_id AS inviter, COUNT(*) AS cnt FROM souls
       WHERE inviter_user_id IS NOT NULL
       GROUP BY inviter_user_id ORDER BY cnt DESC LIMIT ?`,
    )
    .all(LIMIT) as Array<{ inviter: string; cnt: number }>;
  return rows.map((r) => ({ userId: r.inviter, primary: `${r.cnt}人` }));
}

async function renderTopEmbed(
  interaction: ChatInputCommandInteraction,
  title: string,
  entries: TopEntry[],
): Promise<EmbedBuilder> {
  const embed = new EmbedBuilder().setTitle(title).setColor(0x6b21a8);
  if (entries.length === 0) {
    embed.setDescription("まだ誰もいません。");
    return embed;
  }
  // 1位のアバターをサムネイルに、サーバーアイコンをauthor iconに
  const firstUser = await interaction.client.users.fetch(entries[0]!.userId).catch(() => null);
  if (firstUser) embed.setThumbnail(firstUser.displayAvatarURL({ extension: "png", size: 128 }));
  const serverIcon = interaction.guild?.iconURL({ extension: "png", size: 128 });
  if (interaction.guild)
    embed.setAuthor({ name: interaction.guild.name, iconURL: serverIcon ?? undefined });

  const lines = entries.map((e, i) => {
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `**${i + 1}.**`;
    const sub = e.secondary ? `\n　　　　${e.secondary}` : "";
    return `${medal} <@${e.userId}> — ${e.primary}${sub}`;
  });
  embed.setDescription(lines.join("\n"));
  return embed;
}

async function renderMeCard(interaction: ChatInputCommandInteraction, services: Services): Promise<AttachmentBuilder> {
  const userId = interaction.user.id;
  const t = services.ranks.getText(userId);
  const v = services.ranks.getVoice(userId);
  const tp = textProgress(t.xp);
  const vp = voiceProgress(v.xp);
  const pop = services.ranks.populationCount();

  const bumpCnt = services.bumps.get(userId);
  const bumpPos = bumpCnt > 0 ? services.bumps.position(userId) : null;
  const bumpPop = services.bumps.population();

  const inviteCnt = (services.db
    .prepare("SELECT COUNT(*) AS c FROM souls WHERE inviter_user_id = ?")
    .get(userId) as { c: number }).c;
  const invitePos =
    inviteCnt > 0
      ? (services.db
          .prepare(
            `SELECT COUNT(*) AS c FROM (
               SELECT inviter_user_id, COUNT(*) AS n FROM souls
               WHERE inviter_user_id IS NOT NULL
               GROUP BY inviter_user_id HAVING n > ?
             )`,
          )
          .get(inviteCnt) as { c: number }).c + 1
      : null;
  const invitePop = (services.db
    .prepare("SELECT COUNT(DISTINCT inviter_user_id) AS c FROM souls WHERE inviter_user_id IS NOT NULL")
    .get() as { c: number }).c;

  // 表示名・アバターは鯖のメンバー情報から
  const member = (await interaction.guild?.members.fetch(userId).catch(() => null)) as GuildMember | null;
  const user = interaction.user as User;
  const displayName = member?.displayName ?? user.globalName ?? user.username;
  const avatarUrl = (member ?? user).displayAvatarURL({ extension: "png", size: 256 });

  const png = await renderRankCard({
    displayName,
    avatarUrl,
    serverName: interaction.guild?.name,
    serverIconUrl: interaction.guild?.iconURL({ extension: "png", size: 128 }) ?? null,
    totalLevel: tp.level + vp.level,
    text: {
      level: tp.level,
      title: tierFor(tp.level, TEXT_TIERS).name,
      inLevel: tp.inLevel,
      toNext: tp.toNext,
      messages: t.messages,
      position: services.ranks.positionByText(userId),
      population: pop,
    },
    voice: {
      level: vp.level,
      title: tierFor(vp.level, VOICE_TIERS).name,
      inLevel: vp.inLevel,
      toNext: vp.toNext,
      minutes: v.minutes,
      position: services.ranks.positionByVoice(userId),
      population: pop,
    },
    invite: { count: inviteCnt, position: invitePos, population: invitePop },
    bump: { count: bumpCnt, position: bumpPos, population: bumpPop },
  });
  return new AttachmentBuilder(png, { name: "rank-card.png" });
}

export async function handleRankingCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  const kind = interaction.options.getString("種別", true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (kind === "me") {
    const card = await renderMeCard(interaction, services);
    await interaction.editReply({ files: [card] });
    return;
  }
  const [title, entries] =
    kind === "text"
      ? ["💬 発言ランキング Top10", topText(services)]
      : kind === "voice"
        ? ["🎙 浮上ランキング Top10", topVoice(services)]
        : kind === "invite"
          ? ["🎟 招待ランキング Top10", topInvite(services)]
          : ["📣 Bumpランキング Top10", topBump(services)];
  const embed = await renderTopEmbed(interaction, title as string, entries as TopEntry[]);
  await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
