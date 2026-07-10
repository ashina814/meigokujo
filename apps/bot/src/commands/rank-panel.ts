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
import { EmbedBuilder as _EB } from "discord.js";
import {
  TEXT_TIERS,
  VOICE_TIERS,
  tierFor,
  textLevel,
  textProgress,
  voiceLevel,
  voiceProgress,
} from "@meigokujo/core";
void _EB;

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

function gauge(cur: number, max: number, width = 12): string {
  const filled = Math.min(width, Math.max(0, Math.round((cur / Math.max(1, max)) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function renderMe(services: Services, userId: string): EmbedBuilder {
  const t = services.ranks.getText(userId);
  const v = services.ranks.getVoice(userId);
  const tp = textProgress(t.xp);
  const vp = voiceProgress(v.xp);
  const pop = services.ranks.populationCount();
  const posT = services.ranks.positionByText(userId);
  const posV = services.ranks.positionByVoice(userId);

  const bumpCnt = services.bumps.get(userId);
  const bumpPos = bumpCnt > 0 ? services.bumps.position(userId) : null;
  const bumpPop = services.bumps.population();

  const inviteRow = services.db
    .prepare("SELECT COUNT(*) AS c FROM souls WHERE inviter_user_id = ?")
    .get(userId) as { c: number };
  const inviteCnt = inviteRow.c;
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

  const total = tp.level + vp.level;
  return new EmbedBuilder()
    .setTitle("🎖 あなたのランク")
    .setColor(0x6b21a8)
    .setDescription(`**総合 Lv.${total}**（発言 Lv.${tp.level} + 浮上 Lv.${vp.level}）`)
    .addFields(
      {
        name: `💬 発言 — ${tierFor(tp.level, TEXT_TIERS).name}`,
        value: [
          `Lv.${tp.level} (${tp.inLevel}/${tp.toNext} XP)`,
          `\`${gauge(tp.inLevel, tp.toNext)}\``,
          `順位: **${posT}/${pop}位** ／ ${t.messages}発言・累計 ${t.xp}XP`,
        ].join("\n"),
        inline: false,
      },
      {
        name: `🎙 浮上 — ${tierFor(vp.level, VOICE_TIERS).name}`,
        value: [
          `Lv.${vp.level} (${vp.inLevel}/${vp.toNext} XP)`,
          `\`${gauge(vp.inLevel, vp.toNext)}\``,
          `順位: **${posV}/${pop}位** ／ ${v.minutes}分・累計 ${v.xp}XP`,
        ].join("\n"),
        inline: false,
      },
      {
        name: "🎟 招待",
        value: inviteCnt > 0 ? `**${inviteCnt}人** ／ 順位 **${invitePos}/${invitePop}位**` : "まだ実績なし",
        inline: true,
      },
      {
        name: "📣 Bump",
        value: bumpCnt > 0 ? `**${bumpCnt}回** ／ 順位 **${bumpPos}/${bumpPop}位**` : "まだ実績なし",
        inline: true,
      },
    );
}

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
    await interaction.reply({ embeds: [renderMe(services, interaction.user.id)], flags: MessageFlags.Ephemeral });
    return;
  }
  const kind = id.split(":")[1] as "text" | "voice" | "invite" | "bump";
  await interaction.reply({
    embeds: [renderTop(services, kind)],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}
