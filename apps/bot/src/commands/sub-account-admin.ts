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
import { deactivateSubAccount } from "../sub-account-deactivation.js";
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
const ACTIVE_LIST_LIMIT = 4;
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
    new ButtonBuilder()
      .setCustomId("shokan:sub-active")
      .setLabel(`有効なサブ垢 ${services.subAccounts.countByStatus("active")}`)
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [...rows.slice(0, MAX_ACTION_ROWS - 1), backRow], content: "" };
}

/** 有効契約の一覧。1件1行＋戻る1行でActionRow上限5を守る。 */
export function activeSubAccountPanel(services: Services) {
  const active = services.subAccounts.listByStatus("active", ACTIVE_LIST_LIMIT);
  const total = services.subAccounts.countByStatus("active");
  const embed = new EmbedBuilder()
    .setTitle("👥 有効なサブ垢")
    .setColor(total > 0 ? 0x2563eb : 0x64748b)
    .setDescription(
      [
        total > 0
          ? `**有効 ${total}件**${total > ACTIVE_LIST_LIMIT ? `（古い順に ${ACTIVE_LIST_LIMIT}件だけ操作できます）` : ""}`
          : "有効なサブ垢はありません。",
        "",
        ...active.map(
          (row) =>
            `**#${row.id}** 本体 <@${row.main_user_id}>（階級 ${mainRank(services, row.main_user_id) ?? "不明"}）\nサブ垢 <@${row.alt_user_id}>`,
        ),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  const rows = active.map((row) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`shokan:sub-active-view:${row.id}`)
        .setLabel(`#${row.id} 解除を確認`)
        .setStyle(ButtonStyle.Secondary),
    ),
  );
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("shokan:sub").setLabel("← サブ垢管理").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [...rows.slice(0, MAX_ACTION_ROWS - 1), backRow], content: "" };
}

/** 解除の最終確認。表示時にもactiveを再確認し、本体・サブ垢・本体階級を明示する。 */
export function subAccountDeactivationConfirm(services: Services, id: number, content = "") {
  const row = services.subAccounts.get(id);
  if (!row || row.status !== "active") {
    return {
      content: "⚠️ この契約は既に解除済みか、現在は解除できません。",
      embeds: [],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("shokan:sub-active").setLabel("← 有効なサブ垢").setStyle(ButtonStyle.Secondary),
        ),
      ],
    };
  }
  const embed = new EmbedBuilder()
    .setTitle(`サブ垢 #${id} の解除確認`)
    .setColor(0xdc2626)
    .addFields(
      { name: "本体", value: `<@${row.main_user_id}>`, inline: true },
      { name: "サブ垢", value: `<@${row.alt_user_id}>`, inline: true },
      { name: "現在の本体階級", value: mainRank(services, row.main_user_id) ?? "不明", inline: true },
    )
    .setDescription("サブ垢の階級ロールをすべて回収し、Discord実状態で0件を確認してから契約を解除します。返金は行いません。");
  const rowButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`shokan:sub-deactivate:${id}`).setLabel("解除する").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("shokan:sub-active").setLabel("戻る").setStyle(ButtonStyle.Secondary),
  );
  return { content, embeds: [embed], components: [rowButtons] };
}

export async function handleSubAccountDeactivation(
  interaction: ButtonInteraction,
  services: Services,
  id: number,
): Promise<void> {
  // stale button対策。Discordへ触る前にactiveを再確認する。
  if (services.subAccounts.get(id)?.status !== "active") {
    await interaction.update(subAccountDeactivationConfirm(services, id));
    return;
  }
  await interaction.deferUpdate();
  const result = await deactivateSubAccount(services, interaction.guild, id, `user:${interaction.user.id}`);
  if (result.ok) {
    await interaction.editReply({ ...activeSubAccountPanel(services), content: `✅ サブ垢 #${id} を解除しました。返金は行っていません。` });
    return;
  }
  const message =
    result.reason === "not_active"
      ? "この契約は既に解除済みです。"
      : result.reason === "busy"
        ? "別の階級同期が進行中です。少し待ってから再度確認してください。"
        : `解除できませんでした。契約はactiveのままです。${result.detail ? `\n${result.detail}` : ""}`;
  await interaction.editReply(subAccountDeactivationConfirm(services, id, `⚠️ ${message}`));
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
