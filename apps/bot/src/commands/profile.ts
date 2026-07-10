import {
  AttachmentBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
  type GuildMember,
} from "discord.js";
import { fmtLdCompact } from "../format.js";
import { renderProfileCard } from "../render/profile-card.js";
import { isAdmin } from "../permissions.js";
import {
  TEXT_TIERS,
  VOICE_TIERS,
  textProgress,
  voiceProgress,
  tierFor,
} from "@meigokujo/core";
import type { Services } from "../services.js";

const RANK_LABEL: Record<string, string> = {
  waiting: "入城案内待ち",
  ghost: "亡霊",
  majin: "魔人",
  mazoku: "魔族",
  meirei: "迷霊",
  departed: "去りし魂",
};

export const profileCommand = new SlashCommandBuilder()
  .setName("プロフィール")
  .setDescription("魂の記録カードを表示する")
  .setDMPermission(false)
  .addUserOption((o) => o.setName("対象").setDescription("他の人の記録を見る（省略で自分）"))
  .addBooleanOption((o) => o.setName("公開").setDescription("true でみんなに見える形で表示（称号自慢用）"));

export async function handleProfile(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  const target = interaction.options.getUser("対象") ?? interaction.user;
  const isSelf = target.id === interaction.user.id;

  // 他人のプロフィール（残高・階級など）は運営（管理ロール）のみ閲覧可
  if (!isSelf && !isAdmin(interaction, services)) {
    await interaction.reply({
      content: "他の人のプロフィールは運営（管理ロール）のみ閲覧できます。自分のプロフィールは `/プロフィール` で見られます。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // 画像生成＋アバター取得で時間がかかるので先に defer（既定は本人だけ・公開:true で全員に見える）
  const isPublic = interaction.options.getBoolean("公開") ?? false;
  await interaction.deferReply(isPublic ? {} : { flags: MessageFlags.Ephemeral });

  // 開いたときに称号を評価（新規獲得があれば付与）。他人のプロフィールでも遅れて拾える
  const newlyGranted = services.titles.evaluate(target.id);

  const soul = services.entry.getSoul(target.id);
  const balance = services.ledger.balanceOf(`user:${target.id}`);

  // 鯖のニックネーム・アバター・参加日を確実に読むため cache ではなく fetch する
  const member = (await interaction.guild?.members.fetch(target.id).catch(() => null)) as
    | GuildMember
    | null;

  // 在城日数はサーバー参加日から逆算（無ければ亡霊化時刻）
  const joinedSec = member?.joinedTimestamp ? Math.floor(member.joinedTimestamp / 1000) : null;
  const anchorSec = joinedSec ?? soul?.ghost_at ?? null;
  const daysInCastle = anchorSec ? Math.floor((Date.now() / 1000 - anchorSec) / 86_400) : 0;
  const presence = services.vc.presence(target.id, 36_500);
  const vcHours = Math.floor(presence.totalSeconds / 3600);
  const titles = services.titles.list(target.id);

  const rank = soul ? (RANK_LABEL[soul.status] ?? soul.status) : "記録なし";
  const displayName = member?.displayName ?? target.globalName ?? target.username;

  // ランク（発言・浮上・総合）
  const textData = services.ranks.getText(target.id);
  const voiceData = services.ranks.getVoice(target.id);
  const tp = textProgress(textData.xp);
  const vp = voiceProgress(voiceData.xp);
  const ranks = {
    totalLevel: tp.level + vp.level,
    text: { level: tp.level, inLevel: tp.inLevel, toNext: tp.toNext, title: tierFor(tp.level, TEXT_TIERS).name },
    voice: { level: vp.level, inLevel: vp.inLevel, toNext: vp.toNext, title: tierFor(vp.level, VOICE_TIERS).name },
  };

  const png = await renderProfileCard({
    displayName,
    avatarUrl: (member ?? target).displayAvatarURL({ extension: "png", size: 256 }),
    rank,
    balanceText: fmtLdCompact(balance),
    daysInCastle,
    vcHours,
    daysSeen: presence.daysSeen,
    titles: titles.map((t) => ({ name: t.name, desc: t.desc })),
    ranks,
  });
  const card = new AttachmentBuilder(png, { name: "record-card.png" });

  const lines: string[] = [];
  if (newlyGranted.length > 0 && isSelf) {
    lines.push(`🎉 新たな称号を獲得: ${newlyGranted.map((t) => `${t.emoji}${t.name}`).join(" / ")}`);
  }
  if (soul?.status === "ghost" && soul.eval_deadline_at) {
    lines.push(`⏳ 審判の刻限: <t:${soul.eval_deadline_at}:R>`);
  }
  if (soul && soul.eval_extension_days > 0) {
    lines.push(`🎟 招待による評価期限の延長: **+${soul.eval_extension_days}日**`);
  }

  await interaction.editReply({
    content: lines.length > 0 ? lines.join("\n") : undefined,
    files: [card],
  });
}
