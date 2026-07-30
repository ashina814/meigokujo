import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type GuildMember,
} from "discord.js";
import { fmtLd, fmtLdCompact } from "../format.js";
import { renderProfileCard } from "../render/profile-card.js";
import { isAdmin } from "../permissions.js";
import { resolveSpecialProfile } from "../special-profile.js";
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

  // 特別プロフィール（魔王など）。Discordロールを見て、最も優先度の高い有効エントリを主要役職にする（§9-§13）
  const special = resolveSpecialProfile(member, services);

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
    specialRole: special
      ? { name: special.primary.name, desc: special.primary.desc, style: special.primary.style }
      : undefined,
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

  // 通帳ボタンは本人のみ（他人の取引履歴は運営でも1クリックでは開かない・誤爆防止）
  const components = isSelf
    ? [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`prof:tsucho:${target.id}`).setLabel("📜 通帳（直近の取引）").setStyle(ButtonStyle.Secondary),
        ),
      ]
    : [];

  await interaction.editReply({
    content: lines.length > 0 ? lines.join("\n") : undefined,
    files: [card],
    components,
  });
}

/** 取引種別の日本語ラベル（主要なもののみ。未知の型はそのまま出す） */
const TX_LABEL: Record<string, string> = {
  transfer: "送金",
  tip: "投げ銭",
  tip_burn: "投げ銭（焼却）",
  salary: "給与",
  tax: "冥府税",
  pension: "年金",
  reward_bump: "bump/up報酬",
  reward_vc: "浮上報酬",
  ether_buy: "エテル購入",
  ether_sell: "エテル換金",
  ether_burn: "退場奉納",
  shop: "ショップ購入",
  dept_in: "部署へ預入",
  dept_out: "部署から引出",
  bet: "賭け",
  prize: "配当",
  adjust: "運営調整",
  migration: "残高移行",
};

function accountLabel(account: string, selfId: string): string {
  if (account === `user:${selfId}`) return "自分";
  if (account.startsWith("user:")) return `<@${account.slice(5)}>`;
  if (account === "sys:treasury") return "国庫";
  if (account === "sys:escrow:ether") return "両替所";
  if (account.startsWith("dept:")) return `部署「${account.slice(5)}」`;
  if (account.startsWith("sys:")) return account.slice(4);
  return account;
}

/** /プロフィール の「📜 通帳」ボタン: Land 台帳の直近15件を ephemeral で出す */
export async function handleProfileButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  const parts = interaction.customId.split(":"); // prof:tsucho:userId
  if (parts[1] !== "tsucho") return;
  const targetId = parts[2]!;
  // ボタンは本人の返信にしか付かないが、公開表示から他人が押すケースを弾く
  if (interaction.user.id !== targetId) {
    await interaction.reply({ content: "通帳は本人だけが開ける。", flags: MessageFlags.Ephemeral });
    return;
  }
  const accountId = `user:${targetId}`;
  const rows = services.ledger.history(accountId, { limit: 15 });
  if (rows.length === 0) {
    await interaction.reply({ content: "まだ取引記録がない。", flags: MessageFlags.Ephemeral });
    return;
  }
  const lines = rows.map((tx) => {
    const incoming = tx.to_account === accountId;
    const sign = incoming ? "＋" : "−";
    const other = incoming ? tx.from_account : tx.to_account;
    const label = TX_LABEL[tx.type] ?? tx.type;
    const reason = tx.reason && tx.reason !== label ? `・${tx.reason}` : "";
    return `<t:${tx.created_at}:d> <t:${tx.created_at}:t>  **${sign}${fmtLd(tx.amount)}**  ${label}${reason}  ⇄ ${accountLabel(other, targetId)}`;
  });
  const balance = services.ledger.balanceOf(accountId);
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("📜 通帳 — 直近の取引")
        .setColor(0x1e1b4b)
        .setDescription(lines.join("\n"))
        .setFooter({ text: `現在残高 ${fmtLd(balance)} · 直近${rows.length}件 · 賭場内の勝敗は /通行証 で` }),
    ],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}
