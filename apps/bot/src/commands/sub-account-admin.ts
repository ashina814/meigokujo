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
import { SUB_ACCOUNT_PAYMENT_GRACE_DAYS } from "@meigokujo/core";
import { RANK_REQUIRED_MESSAGE, eligible, mainRank } from "./sub-account.js";
import type { Services } from "../services.js";

/**
 * サブ垢の審査（運営）。
 *
 * ここでやるのは**本人確認**で、課金ではない。承認しても Land は動かず、
 * 支払いは本人の操作に残る（通らなかったものに先に払わせない）。
 */

/**
 * 1画面に出す申請の件数。
 *
 * **Discord の ActionRow は1メッセージ5行まで。** 申請1件につき1行使い、最後に
 * 「← 管理へ」で1行使うので、申請は4件までしか置けない。5件置くと6行になり、
 * 描画そのものが落ちて運営が何も操作できなくなる。
 */
const LIST_LIMIT = 4;
/** Discord の上限。ここを超える components は作らない */
export const MAX_ACTION_ROWS = 5;

export function subAccountReviewPanel(services: Services) {
  const pending = services.subAccounts.listByStatus("pending", LIST_LIMIT);
  const approved = services.subAccounts.listByStatus("approved", LIST_LIMIT);
  const total = services.subAccounts.countByStatus("pending");
  const embed = new EmbedBuilder()
    .setTitle("👥 サブ垢の申請")
    .setColor(total > 0 ? 0xdc2626 : 0x64748b)
    .setDescription(
      [
        total > 0 ? `**承認待ち ${total}件**${total > LIST_LIMIT ? `（古い順に ${LIST_LIMIT}件だけ操作できます）` : ""}` : "承認待ちはありません。",
        "",
        ...pending.map((r) => {
          const rank = mainRank(services, r.main_user_id);
          const ok = eligible(services, r.main_user_id);
          return `**#${r.id}** 本体 <@${r.main_user_id}>（階級 ${rank ?? "不明"}${ok ? "" : " ⚠️ **魔人未満**"}）\nサブ垢 <@${r.alt_user_id}>`;
        }),
        approved.length > 0
          ? [
              "",
              `**支払い待ち ${services.subAccounts.countByStatus("approved")}件**（承認から ${SUB_ACCOUNT_PAYMENT_GRACE_DAYS}日で自動取消）`,
              ...approved.map((r) => `・#${r.id} <@${r.main_user_id}> → <@${r.alt_user_id}>`),
            ].join("\n")
          : "",
        "",
        "-# 承認しても課金はしません。支払いは本人が公式ショップから行います。",
        "-# 階級は台帳（`souls.status`）で見ています。Discordのロールが残っていても、魔人未満なら承認できません。",
      ]
        .filter((line) => line !== "")
        .join("\n"),
    );
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (const r of pending) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`shokan:sub-approve:${r.id}`)
          .setLabel(`#${r.id} 承認`)
          .setStyle(ButtonStyle.Success)
          .setDisabled(!eligible(services, r.main_user_id)),
        new ButtonBuilder().setCustomId(`shokan:sub-return:${r.id}`).setLabel("差し戻し").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`shokan:sub-reject:${r.id}`).setLabel("却下").setStyle(ButtonStyle.Danger),
      ),
    );
  }
  // 戻る行のぶんを必ず残す。**上限を超えたら申請行のほうを削る**
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("shokan:hub").setLabel("← 管理へ").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [...rows.slice(0, MAX_ACTION_ROWS - 1), backRow], content: "" };
}

export function decisionModal(decision: "returned" | "rejected", id: number) {
  return new ModalBuilder()
    .setCustomId(`shokan:sub-decide:${decision}:${id}`)
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

export async function handleSubAccountApprove(
  interaction: ButtonInteraction,
  services: Services,
  id: number,
): Promise<void> {
  const application = services.subAccounts.get(id);
  if (!application) {
    await interaction.update({ content: "⚠️ この申請は見つかりません。", embeds: [], components: [] });
    return;
  }
  try {
    // **承認時にも今の階級を見る。** 申請から時間が経って降格していることがある
    const row = services.subAccounts.approve(id, `user:${interaction.user.id}`, mainRank(services, application.main_user_id));
    await interaction.update(subAccountReviewPanel(services));
    const user = await interaction.client.users.fetch(row.main_user_id).catch(() => null);
    await user
      ?.send(
        [
          `✅ サブ垢 <@${row.alt_user_id}> の申請が承認されました。`,
          "公式ショップの「サブ垢追加」からお支払いいただくと、サブ垢に本体と同じ階級が付きます。",
          `-# 承認から **${SUB_ACCOUNT_PAYMENT_GRACE_DAYS}日** を過ぎると申請は取り消されます。`,
        ].join("\n"),
      )
      .catch(() => undefined);
  } catch {
    const ok = eligible(services, application.main_user_id);
    await interaction.update({
      content: ok
        ? "⚠️ この申請はいま承認できません（既に処理されています）。"
        : `⚠️ 承認できません。${RANK_REQUIRED_MESSAGE}`,
      embeds: [],
      components: [],
    });
  }
}

export async function handleSubAccountDecision(
  interaction: ModalSubmitInteraction,
  services: Services,
): Promise<void> {
  const parts = interaction.customId.split(":");
  const decision = parts[2] === "returned" ? "returned" : "rejected";
  const id = Number(parts[3]);
  const reason = interaction.fields.getTextInputValue("reason").trim();
  try {
    const row = services.subAccounts.decide(id, decision, reason, `user:${interaction.user.id}`);
    await interaction.reply({
      content: `${decision === "returned" ? "↩️ 差し戻し" : "🚫 却下"}ました（申請 #${id}）。`,
      flags: MessageFlags.Ephemeral,
    });
    const user = await interaction.client.users.fetch(row.main_user_id).catch(() => null);
    await user
      ?.send(
        decision === "returned"
          ? [`↩️ サブ垢 <@${row.alt_user_id}> の申請を差し戻しました。`, `理由: ${reason}`, "内容を直して、改めて申請してください。"].join("\n")
          : [`🚫 サブ垢 <@${row.alt_user_id}> の申請は見送りとなりました。`, `理由: ${reason}`].join("\n"),
      )
      .catch(() => undefined);
  } catch {
    await interaction.reply({ content: "⚠️ この申請はいま処理できません。", flags: MessageFlags.Ephemeral });
  }
}
