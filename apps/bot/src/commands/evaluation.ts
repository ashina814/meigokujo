import {
  ActionRowBuilder,
  ButtonInteraction,
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
  type AnyThreadChannel,
  type ForumChannel,
  type GuildMember,
} from "discord.js";
import type { Conclusion, EvalScores } from "@meigokujo/core";
import { isAdmin } from "../permissions.js";
import type { Services } from "../services.js";

const AXES = [
  ["voice", "声の良さ"],
  ["communication", "コミュニケーション力"],
  ["presence", "浮上率"],
  ["understanding", "鯖理解度"],
] as const;

const CONCLUSIONS: Array<[Conclusion, string]> = [
  ["none", "印なし（様子見）"],
  ["promotion", "昇格印を付ける"],
  ["demotion", "低評価印を付ける"],
];

// ---- 権限 ----

export function isSwordsman(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  services: Services,
): boolean {
  if (isAdmin(interaction, services)) return true;
  const roleId = services.settings.getString("role:swordsman");
  if (!roleId) return false;
  const member = interaction.member as GuildMember | null;
  return member?.roles.cache.has(roleId) ?? false;
}

// ---- /評価 ----

export const evaluationCommand = new SlashCommandBuilder()
  .setName("評価")
  .setDescription("評価を投稿する（魔剣士専用）")
  .setDMPermission(false)
  .addUserOption((o) => o.setName("対象").setDescription("評価する相手").setRequired(true));

interface PendingEval {
  targetId: string;
  scores: Partial<Record<(typeof AXES)[number][0], number>>;
  conclusion?: Conclusion;
}

/** 評価員ごとの入力途中状態（送信までスレッドには何も出ない） */
const pendingEvals = new Map<string, PendingEval>();

export async function handleEvaluationCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  if (!isSwordsman(interaction, services)) {
    await interaction.reply({ content: "評価の投稿は魔剣士のみ可能です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const target = interaction.options.getUser("対象", true);
  if (target.bot || target.id === interaction.user.id) {
    await interaction.reply({ content: "その相手は評価できません。", flags: MessageFlags.Ephemeral });
    return;
  }

  pendingEvals.set(interaction.user.id, { targetId: target.id, scores: {} });

  const rows = AXES.map(([key, label]) =>
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`eval:s:${key}`)
        .setPlaceholder(`${label}（1〜5点）`)
        .addOptions([1, 2, 3, 4, 5].map((n) => ({ label: `${label}: ${n}点`, value: String(n) }))),
    ),
  );
  rows.push(
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("eval:s:conclusion")
        .setPlaceholder("結論（最後に選ぶとコメント入力へ進みます）")
        .addOptions(CONCLUSIONS.map(([value, label]) => ({ label, value }))),
    ),
  );

  await interaction.reply({
    content: `📝 <@${target.id}> の評価。4項目の点数を選び、最後に結論を選んでください。`,
    components: rows,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

export async function handleEvaluationSelect(
  interaction: StringSelectMenuInteraction,
  services: Services,
): Promise<void> {
  const pending = pendingEvals.get(interaction.user.id);
  if (!pending) {
    await interaction.update({ content: "⌛ 期限切れです。もう一度 `/評価` からどうぞ。", components: [] });
    return;
  }
  const key = interaction.customId.split(":")[2];
  const value = interaction.values[0];
  if (!key || !value) return;

  if (key !== "conclusion") {
    pending.scores[key as (typeof AXES)[number][0]] = Number(value);
    await interaction.deferUpdate();
    return;
  }

  // 結論が選ばれた → 4項目そろっていればモーダルへ
  const missing = AXES.filter(([k]) => pending.scores[k] === undefined).map(([, label]) => label);
  if (missing.length > 0) {
    await interaction.reply({
      content: `先に点数を選んでください: ${missing.join("・")}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  pending.conclusion = value as Conclusion;

  const modal = new ModalBuilder()
    .setCustomId("eval:modal")
    .setTitle("評価コメント")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("detail").setLabel("詳細（声・コミュ力・浮上率・鯖理解度）").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("merit").setLabel("鯖メリット").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("concern").setLabel("不安点").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("feedback").setLabel("フィードバック").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("others").setLabel("評価高い人・低い人").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200),
      ),
    );
  await interaction.showModal(modal);
}

// ---- 送信（モーダル）→ フォーラム投稿・印台帳・閾値アクション ----

function fmtDeadline(ts: number | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit" }).format(d);
}

export function threadTitleFor(displayName: string, deadlineTs: number | null | undefined): string {
  return `${displayName}【期限: ${fmtDeadline(deadlineTs)}】`.slice(0, 95);
}

async function ensureEvalThread(
  interaction: ModalSubmitInteraction,
  services: Services,
  targetId: string,
): Promise<AnyThreadChannel | null> {
  const forumId = services.settings.getString("channel:eval_forum");
  if (!forumId) return null;
  const forum = (await interaction.client.channels.fetch(forumId).catch(() => null)) as ForumChannel | null;
  if (!forum || forum.type !== ChannelType.GuildForum) return null;

  const existingId = services.evaluation.threadFor(targetId);
  if (existingId) {
    const thread = (await interaction.client.channels.fetch(existingId).catch(() => null)) as AnyThreadChannel | null;
    if (thread?.isThread()) {
      if (thread.archived) await thread.setArchived(false).catch(() => undefined);
      return thread;
    }
  }

  const member = await interaction.guild?.members.fetch(targetId).catch(() => null);
  const soul = services.entry.getSoul(targetId);
  const whitelist = services.settings.getJson<string[]>("vc_whitelist", []);
  const presence = services.vc.presence(targetId, 14, whitelist.length > 0 ? whitelist : undefined);
  const hours = Math.floor(presence.totalSeconds / 3600);
  const mins = Math.floor((presence.totalSeconds % 3600) / 60);

  const thread = await forum.threads.create({
    name: threadTitleFor(member?.displayName ?? targetId, soul?.eval_deadline_at),
    message: {
      content: [
        `📄 対象者: <@${targetId}>`,
        `入城: ${soul?.ghost_at ? `<t:${soul.ghost_at}:D>` : "—"} / 審判期限: ${soul?.eval_deadline_at ? `<t:${soul.eval_deadline_at}:D>` : "—"}`,
        `浮上実績（直近14日・評価対象VC）: **${hours}時間${mins}分 / 出現${presence.daysSeen}日**`,
      ].join("\n"),
    },
  });
  services.evaluation.setThread(targetId, thread.id);
  return thread;
}

export async function handleEvaluationModal(
  interaction: ModalSubmitInteraction,
  services: Services,
): Promise<void> {
  const pending = pendingEvals.get(interaction.user.id);
  if (!pending?.conclusion) {
    await interaction.reply({ content: "⌛ 期限切れです。もう一度 `/評価` からどうぞ。", flags: MessageFlags.Ephemeral });
    return;
  }
  pendingEvals.delete(interaction.user.id);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const texts = {
    detail: interaction.fields.getTextInputValue("detail"),
    merit: interaction.fields.getTextInputValue("merit") || undefined,
    concern: interaction.fields.getTextInputValue("concern") || undefined,
    feedback: interaction.fields.getTextInputValue("feedback") || undefined,
    others: interaction.fields.getTextInputValue("others") || undefined,
  };
  const scores = pending.scores as EvalScores;
  const total = scores.voice + scores.communication + scores.presence + scores.understanding;

  const thread = await ensureEvalThread(interaction, services, pending.targetId);
  const result = services.evaluation.submitEvaluation({
    targetId: pending.targetId,
    evaluatorId: interaction.user.id,
    scores,
    texts,
    conclusion: pending.conclusion,
    threadId: thread?.id,
  });

  // フォーラムに評価を掲示（本人不可視はフォーラム自体の権限設定で担保）
  if (thread) {
    const whitelist = services.settings.getJson<string[]>("vc_whitelist", []);
    const presence = services.vc.presence(pending.targetId, 14, whitelist.length > 0 ? whitelist : undefined);
    const embed = new EmbedBuilder()
      .setTitle(`評価員: ${interaction.member && "displayName" in interaction.member ? interaction.member.displayName : interaction.user.username}`)
      .setDescription(
        [
          `声: **${scores.voice}** / コミュ力: **${scores.communication}** / 浮上率: **${scores.presence}** / 鯖理解度: **${scores.understanding}** — 合計 **${total}/20**`,
          "",
          `**詳細** ${texts.detail}`,
          texts.merit ? `**鯖メリット** ${texts.merit}` : "",
          texts.concern ? `**不安点** ${texts.concern}` : "",
          texts.feedback ? `**フィードバック** ${texts.feedback}` : "",
          texts.others ? `**評価高い人・低い人** ${texts.others}` : "",
          "",
          `**結論**: ${CONCLUSIONS.find(([v]) => v === pending.conclusion)?.[1]}`,
          `現在 — 昇格印 **${result.promotion.total}/5**（うち招待 ${result.promotion.inviteScore}）・低評価印 **${result.demotionCount}/4**・評価 ${services.evaluation.evaluationCount(pending.targetId)}件`,
          `浮上実績（直近14日）: ${Math.floor(presence.totalSeconds / 3600)}時間${Math.floor((presence.totalSeconds % 3600) / 60)}分 / 出現${presence.daysSeen}日`,
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .setColor(pending.conclusion === "demotion" ? 0xdc2626 : pending.conclusion === "promotion" ? 0x16a34a : 0x6b21a8);
    await thread.send({ embeds: [embed] });
  }

  // 閾値アクション
  const guild = interaction.guild!;
  const notes: string[] = [];
  if (result.demotionReached) {
    await executeDemotion(services, guild, pending.targetId, "低評価印4個到達（即落ちルール）");
    notes.push("⚠️ 低評価印4個に到達 → **迷霊落ちを執行しました**");
  } else if (result.promotionReached) {
    const mendanRoleId = services.settings.getString("role:mendan");
    const member = await guild.members.fetch(pending.targetId).catch(() => null);
    if (mendanRoleId && member) await member.roles.add(mendanRoleId).catch(() => undefined);
    const shureiId = services.settings.getString("channel:shurei");
    const shinRoleId = services.settings.getString("role:shin");
    if (shureiId) {
      const channel = await guild.client.channels.fetch(shureiId).catch(() => null);
      if (channel?.isTextBased() && "send" in channel) {
        await channel.send(
          `⚔️ ${shinRoleId ? `<@&${shinRoleId}> ` : ""}<@${pending.targetId}> の昇格印が **5個** に到達しました。昇格面談をお願いします。`,
        );
      }
    }
    notes.push("🎉 昇格印5個に到達 → 面談待ちロールを付与し、集令に通知しました");
  }

  await interaction.editReply({
    content: [
      `✅ 評価を投稿しました${thread ? `: ${thread.toString()}` : "（評価フォーラム未設定のため記録のみ）"}`,
      `昇格印 **${result.promotion.total}/5** ・ 低評価印 **${result.demotionCount}/4**`,
      ...notes,
    ].join("\n"),
  });
}

/** 迷霊落ちの執行（印4個の即落ち・カロンの期限切れ承認、両方から使う） */
export async function executeDemotion(
  services: Services,
  guild: import("discord.js").Guild,
  targetId: string,
  reason: string,
): Promise<void> {
  services.evaluation.demoteToMeirei(targetId, "system:marks", reason);
  const ghostRoleId = services.settings.getString("role:ghost");
  const meireiRoleId = services.settings.getString("role:meirei");
  const member = await guild.members.fetch(targetId).catch(() => null);
  if (member) {
    if (ghostRoleId) await member.roles.remove(ghostRoleId).catch(() => undefined);
    if (meireiRoleId) await member.roles.add(meireiRoleId).catch(() => undefined);
    await member
      .send(`⚖️ 冥獄城の審判が下りました。汝は**迷霊**となった（理由: ${reason}）。贖罪の道は運営に相談を。`)
      .catch(() => undefined);
  }
}

// ---- カロンの迷霊落ち承認ボタン ----

export async function handleCharonButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  if (!isAdmin(interaction, services)) {
    await interaction.reply({ content: "承認は運営のみ可能です。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.customId === "charon:cancel") {
    await interaction.update({ content: "見送りました（対象は明日のカロンに再掲されます）。", components: [], embeds: [] });
    return;
  }
  if (interaction.customId !== "charon:drop") return;

  await interaction.update({ content: "⏳ 執行中…", components: [], embeds: [] });
  const overdue = services.evaluation.overdue();
  const done: string[] = [];
  for (const row of overdue) {
    await executeDemotion(services, interaction.guild!, row.user_id, "評価期限到達・昇格印不足");
    done.push(row.user_id);
  }
  await interaction.editReply({
    content:
      done.length > 0
        ? `⚖️ **${done.length}名** を迷霊に落としました: ${done.map((id) => `<@${id}>`).join(", ")}`
        : "対象はいませんでした（期限内に変動があった模様）。",
  });
}
