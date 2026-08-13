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
import { ORIGINAL_ROLE_PAYMENT_GRACE_DAYS } from "@meigokujo/core";
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
  const total = services.originalRoles.countByStatus("pending");
  const embed = new EmbedBuilder()
    .setTitle("🎨 オリジナルロールの申請")
    .setColor(total > 0 ? 0xdc2626 : 0x64748b)
    .setDescription(
      [
        total > 0 ? `**承認待ち ${total}件**` : "承認待ちはありません。",
        "",
        ...pending.map(
          (r) =>
            `**#${r.id}** <@${r.user_id}> ／ ロール名 **${r.name}**${r.color === null ? "" : ` ／ 色 #${r.color.toString(16).padStart(6, "0").toUpperCase()}`}`,
        ),
        approved.length > 0
          ? [
              "",
              `**支払い待ち ${services.originalRoles.countByStatus("approved")}件**（承認から ${ORIGINAL_ROLE_PAYMENT_GRACE_DAYS}日で自動取消）`,
              ...approved.map((r) => `・#${r.id} <@${r.user_id}> **${r.name}**`),
            ].join("\n")
          : "",
        "",
        "-# 承認しても課金はしません。支払いは本人が公式ショップから行います。",
      ]
        .filter((line) => line !== "")
        .join("\n"),
    );
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (const r of pending) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`shokan:orole-approve:${r.id}`).setLabel(`#${r.id} 承認`).setStyle(ButtonStyle.Success),
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
  try {
    const row = services.originalRoles.approve(id, `user:${interaction.user.id}`);
    await interaction.update(originalRoleReviewPanel(services));
    const user = await interaction.client.users.fetch(row.user_id).catch(() => null);
    await user
      ?.send(
        [
          `✅ オリジナルロール **${row.name}** の申請が承認されました。`,
          `公式ショップの「オリジナルロール新規作成」からお支払いいただくと、Botがロールを作成してお付けします。`,
          `-# 承認から **${ORIGINAL_ROLE_PAYMENT_GRACE_DAYS}日** を過ぎると申請は取り消されます。`,
        ].join("\n"),
      )
      .catch(() => undefined);
  } catch {
    await interaction.update({
      content: "⚠️ この申請はいま承認できません（既に処理されています）。",
      embeds: [],
      components: [],
    });
  }
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
