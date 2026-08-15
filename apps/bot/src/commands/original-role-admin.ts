import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import { ORIGINAL_ROLE_TICKET_PANEL_ID } from "@meigokujo/core";
import type { Services } from "../services.js";

/**
 * オリジナルロールの審査（運営）。
 *
 * **通知は変化のお知らせで、仕事の一覧はここから開ける。** 承認しても課金はせず、
 * 支払いは本人の操作に残す（通らないものに先に払わせない）。
 */

const LIST_LIMIT = 5;

export function originalRoleReviewPanel(services: Services) {
  const pending = services.originalRoles.listByStatus("pending", LIST_LIMIT);
  const approved = services.originalRoles.listByStatus("approved", LIST_LIMIT);
  const totalPending = services.originalRoles.countByStatus("pending");
  const totalApproved = services.originalRoles.countByStatus("approved");
  const embed = new EmbedBuilder()
    .setTitle("🎨 旧方式オリジナルロール申請（移行用）")
    .setColor(totalPending + totalApproved > 0 ? 0xd97706 : 0x64748b)
    .setDescription(
      [
        "この一覧は**制度変更前の未完了申請を見失わないための互換表示**です。",
        "ここから旧方式の新規承認・自動作成には進めません。本人へ公式ショップ → オリジナルロール相談を案内し、専用カルテで続けてください。",
        "",
        totalPending > 0 ? `**旧・承認待ち ${totalPending}件**` : "旧・承認待ちはありません。",
        ...pending.map((r) => `・#${r.id} <@${r.user_id}> **${r.name}**`),
        totalApproved > 0 ? `**旧・支払い前 ${totalApproved}件**` : "",
        ...approved.map((r) => `・#${r.id} <@${r.user_id}> **${r.name}** — 旧支払いUIでは課金しません`),
        "",
        "-# 支払済み create_original_role purchase の復旧互換は別経路で残しています。ここで扱うのは未払いの旧申請だけです。",
      ].filter(Boolean).join("\n"),
    );
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (const r of pending) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`shokan:orole-approve:${r.id}`).setLabel(`#${r.id} カルテ移行を案内`).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`shokan:orole-return:${r.id}`).setLabel("差し戻し").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`shokan:orole-reject:${r.id}`).setLabel("却下").setStyle(ButtonStyle.Danger),
      ),
    );
  }
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("shokan:hub").setLabel("← 管理へ").setStyle(ButtonStyle.Secondary),
    ),
  );
  return { embeds: [embed], components: rows };
}

export function decisionModal(decision: "returned" | "rejected", id: number) {
  return new ModalBuilder()
    .setCustomId(`shokan:orole-decide:${decision}:${id}`)
    .setTitle(decision === "returned" ? `#${id} を差し戻す` : `#${id} を却下する`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("reason")
          .setLabel("理由（本人へそのまま伝えます）")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(300),
      ),
    );
}

export async function handleOriginalRoleApprove(
  interaction: ButtonInteraction,
  services: Services,
  id: number,
): Promise<void> {
  const row = services.originalRoles.get(id);
  if (!row || row.status !== "pending") {
    await interaction.update({
      content: "⚠️ この旧申請は既に処理済みです。",
      embeds: [],
      components: [],
    });
    return;
  }

  // 旧「承認→本人セルフ支払い→Bot自動作成」へは戻さない。
  // レコードはpendingのまま保持し、本人が新しい専用カルテを開始してから人が引き継ぐ。
  services.events.log("original_role_legacy_migration_requested", {
    actor: `user:${interaction.user.id}`,
    target: row.user_id,
    payload: { applicationId: row.id, panelId: ORIGINAL_ROLE_TICKET_PANEL_ID },
  });
  await interaction.update(originalRoleReviewPanel(services));
  const user = await interaction.client.users.fetch(row.user_id).catch(() => null);
  await user
    ?.send(
      [
        `🎨 旧方式のオリジナルロール申請 **${row.name}** について、手続き方式が変わりました。`,
        "**料金は発生していません。** 旧申請を新しく承認してBotがロールを作る方式には進みません。",
        "公式ショップのオリジナルロールから専用の相談カルテを開き、商館スタッフと続きを相談してください。",
      ].join("\n"),
    )
    .catch(() => undefined);
}

export async function handleOriginalRoleDecision(
  interaction: ModalSubmitInteraction,
  services: Services,
): Promise<void> {
  const parts = interaction.customId.split(":");
  const decision = parts[2] === "returned" ? "returned" : "rejected";
  const id = Number(parts[3]);
  const reason = interaction.fields.getTextInputValue("reason").trim();
  try {
    const row = services.originalRoles.decide(id, decision, reason, `user:${interaction.user.id}`);
    await interaction.reply({
      content: `${decision === "returned" ? "↩️ 差し戻し" : "🚫 却下"}ました（申請 #${id}）。`,
      flags: MessageFlags.Ephemeral,
    });
    const user = await interaction.client.users.fetch(row.user_id).catch(() => null);
    await user
      ?.send(
        decision === "returned"
          ? [`↩️ オリジナルロール **${row.name}** の申請を差し戻しました。`, `理由: ${reason}`, "内容を直して、改めて申請してください。"].join("\n")
          : [`🚫 オリジナルロール **${row.name}** の申請は見送りとなりました。`, `理由: ${reason}`].join("\n"),
      )
      .catch(() => undefined);
  } catch {
    await interaction.reply({ content: "⚠️ この申請はいま処理できません。", flags: MessageFlags.Ephemeral });
  }
}
