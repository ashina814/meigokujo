import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type MessageCreateOptions,
} from "discord.js";
import type { Services } from "../services.js";
import {
  TEXT_TIERS,
  VOICE_TIERS,
  tierFor,
  textLevel,
  voiceLevel,
} from "@meigokujo/core";
import { renderMeCard } from "./ranking.js";

/** ランク確認の常設パネル（/パネル設置 種別:ランク確認） */
export function rankPanelMessage(): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setTitle("🎖 冥獄城 ランク確認")
    .setColor(0x6b21a8)
    .setDescription(
      [
        "**発言・浮上・招待・Bump** の4軸で、あなたのレベル・称号・順位を確認できます。",
        "",
        "・発言XP は発言で加算（30秒クールダウン）",
        "・浮上XP は説明会以外の**複数人がいるVC**の滞在で加算（5分ごと集計）",
        "・招待は招待リンク経由の入城で加算、Bumpは DISBOARD/ディス速 の bump 成功で加算",
      ].join("\n"),
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("rank:me").setLabel("自分のランク").setEmoji("🎖").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("rank:text").setLabel("発言").setEmoji("💬").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rank:voice").setLabel("浮上").setEmoji("🎙").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rank:invite").setLabel("招待").setEmoji("🎟").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("rank:bump").setLabel("Bump").setEmoji("📣").setStyle(ButtonStyle.Success),
  );
  return { embeds: [embed], components: [row] };
}

const LIMIT = 10;

function renderTop(services: Services, kind: "text" | "voice" | "invite" | "bump"): EmbedBuilder {
  if (kind === "text") {
    const rows = services.ranks.topByText(LIMIT);
    const lines = rows.length
      ? rows.map((r, i) => {
          const lv = textLevel(r.xp);
          const tier = tierFor(lv, TEXT_TIERS).name;
          const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `**${i + 1}.**`;
          return `${medal} <@${r.user_id}> — Lv.${lv} **${tier}**（${r.messages}発言 / ${r.xp}XP）`;
        })
      : ["まだ発言が集計されていません。"];
    return new EmbedBuilder().setTitle("💬 発言ランキング Top10").setColor(0x6b21a8).setDescription(lines.join("\n"));
  }
  if (kind === "voice") {
    const rows = services.ranks.topByVoice(LIMIT);
    const lines = rows.length
      ? rows.map((r, i) => {
          const lv = voiceLevel(r.xp);
          const tier = tierFor(lv, VOICE_TIERS).name;
          const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `**${i + 1}.**`;
          return `${medal} <@${r.user_id}> — Lv.${lv} **${tier}**（${r.minutes}分 / ${r.xp}XP）`;
        })
      : ["まだ浮上が集計されていません。"];
    return new EmbedBuilder().setTitle("🎙 浮上ランキング Top10").setColor(0x6b21a8).setDescription(lines.join("\n"));
  }
  if (kind === "invite") {
    const rows = services.db
      .prepare(
        `SELECT inviter_user_id AS inviter, COUNT(*) AS cnt FROM souls
         WHERE inviter_user_id IS NOT NULL
         GROUP BY inviter_user_id ORDER BY cnt DESC LIMIT ?`,
      )
      .all(LIMIT) as Array<{ inviter: string; cnt: number }>;
    const lines = rows.length
      ? rows.map((r, i) => {
          const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `**${i + 1}.**`;
          return `${medal} <@${r.inviter}> — **${r.cnt}人**`;
        })
      : ["まだ招待実績がありません。"];
    return new EmbedBuilder().setTitle("🎟 招待ランキング Top10").setColor(0x6b21a8).setDescription(lines.join("\n"));
  }
  const rows = services.bumps.top(LIMIT);
  const lines = rows.length
    ? rows.map((r, i) => {
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `**${i + 1}.**`;
        return `${medal} <@${r.user_id}> — **${r.count}回**`;
      })
    : ["まだBump実績がありません。"];
  return new EmbedBuilder().setTitle("📣 Bumpランキング Top10").setColor(0x6b21a8).setDescription(lines.join("\n"));
}

export async function handleRankPanelButton(
  interaction: ButtonInteraction,
  services: Services,
): Promise<void> {
  const id = interaction.customId;
  if (id === "rank:me") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const card = await renderMeCard(interaction, services);
    await interaction.editReply({ files: [card] });
    return;
  }
  const kind = id.split(":")[1] as "text" | "voice" | "invite" | "bump";
  await interaction.reply({
    embeds: [renderTop(services, kind)],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}
