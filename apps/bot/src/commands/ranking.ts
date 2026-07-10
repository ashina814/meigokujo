import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
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
        { name: "発言（テキストXP）", value: "text" },
        { name: "浮上（ボイスXP）", value: "voice" },
        { name: "招待", value: "invite" },
        { name: "Bump", value: "bump" },
        { name: "自分のランク（4軸まとめて）", value: "me" },
      ),
  );

const LIMIT = 10;

interface TopEntry { userId: string; primary: string; secondary?: string }

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

function renderTop(title: string, entries: TopEntry[]): EmbedBuilder {
  const lines =
    entries.length > 0
      ? entries.map((e, i) => {
          const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `**${i + 1}.**`;
          const sub = e.secondary ? `\n　　　　${e.secondary}` : "";
          return `${medal} <@${e.userId}> — ${e.primary}${sub}`;
        })
      : ["まだ誰もいません。"];
  return new EmbedBuilder().setTitle(title).setColor(0x6b21a8).setDescription(lines.join("\n"));
}

/** 自分のランクを4軸まとめて表示 */
function renderMe(services: Services, userId: string): EmbedBuilder {
  const t = services.ranks.getText(userId);
  const v = services.ranks.getVoice(userId);
  const tp = textProgress(t.xp);
  const vp = voiceProgress(v.xp);
  const tt = tierFor(tp.level, TEXT_TIERS).name;
  const vt = tierFor(vp.level, VOICE_TIERS).name;
  const pop = services.ranks.populationCount();
  const posText = services.ranks.positionByText(userId);
  const posVoice = services.ranks.positionByVoice(userId);
  const bumpCnt = services.bumps.get(userId);
  const bumpPos = bumpCnt > 0 ? services.bumps.position(userId) : null;
  const bumpPop = services.bumps.population();

  // 招待
  const inviteRow = services.db
    .prepare("SELECT COUNT(*) AS c FROM souls WHERE inviter_user_id = ?")
    .get(userId) as { c: number };
  const inviteCnt = inviteRow.c;
  const invitePosRow =
    inviteCnt > 0
      ? (services.db
          .prepare(
            `SELECT COUNT(*) AS c FROM (
               SELECT inviter_user_id, COUNT(*) AS n FROM souls
               WHERE inviter_user_id IS NOT NULL
               GROUP BY inviter_user_id HAVING n > ?
             )`,
          )
          .get(inviteCnt) as { c: number })
      : null;
  const invitePop = (services.db.prepare("SELECT COUNT(DISTINCT inviter_user_id) AS c FROM souls WHERE inviter_user_id IS NOT NULL").get() as { c: number }).c;

  const total = tp.level + vp.level;
  const gauge = (cur: number, max: number, width = 12): string => {
    const filled = Math.min(width, Math.max(0, Math.round((cur / max) * width)));
    return "█".repeat(filled) + "░".repeat(width - filled);
  };

  return new EmbedBuilder()
    .setTitle("🎖 あなたのランク")
    .setColor(0x6b21a8)
    .setDescription(`**総合 Lv.${total}**（発言 Lv.${tp.level} + 浮上 Lv.${vp.level}）`)
    .addFields(
      {
        name: `💬 発言 — ${tt}`,
        value: [
          `Lv.${tp.level} (${tp.inLevel}/${tp.toNext} XP)`,
          `\`${gauge(tp.inLevel, tp.toNext)}\``,
          `順位: **${posText}/${pop}位** ／ 累計 ${t.messages}発言 ${t.xp}XP`,
        ].join("\n"),
        inline: false,
      },
      {
        name: `🎙 浮上 — ${vt}`,
        value: [
          `Lv.${vp.level} (${vp.inLevel}/${vp.toNext} XP)`,
          `\`${gauge(vp.inLevel, vp.toNext)}\``,
          `順位: **${posVoice}/${pop}位** ／ 累計 ${v.minutes}分 ${v.xp}XP`,
        ].join("\n"),
        inline: false,
      },
      {
        name: "🎟 招待",
        value:
          inviteCnt > 0
            ? `**${inviteCnt}人** 招待 ／ 順位 **${(invitePosRow?.c ?? 0) + 1}/${invitePop}位**`
            : "まだ招待実績なし",
        inline: true,
      },
      {
        name: "📣 Bump",
        value: bumpCnt > 0 ? `**${bumpCnt}回** ／ 順位 **${bumpPos}/${bumpPop}位**` : "まだBump実績なし",
        inline: true,
      },
    );
}

export async function handleRankingCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  const kind = interaction.options.getString("種別", true);
  if (kind === "me") {
    await interaction.reply({ embeds: [renderMe(services, interaction.user.id)], flags: MessageFlags.Ephemeral });
    return;
  }
  const embed =
    kind === "text"
      ? renderTop("💬 発言ランキング Top10", topText(services))
      : kind === "voice"
        ? renderTop("🎙 浮上ランキング Top10", topVoice(services))
        : kind === "invite"
          ? renderTop("🎟 招待ランキング Top10", topInvite(services))
          : renderTop("📣 Bumpランキング Top10", topBump(services));
  await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}
