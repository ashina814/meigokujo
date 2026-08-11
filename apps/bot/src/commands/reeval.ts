import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type Guild,
  type GuildMember,
} from "discord.js";
import { RANK_ROLE_SETTING_KEYS } from "@meigokujo/core";
import { isAdmin } from "../permissions.js";
import type { Services } from "../services.js";

/**
 * 再評価面談（迷霊 → 亡霊の復帰）。
 *
 * ## 経路
 *
 * 「再評価チャレンジ」を買う → 再評価面談チケットを開く → 人が面談する →
 * OKなら**この操作で**亡霊へ復帰。購入しただけでは status もロールも評価期間も動かない。
 * 以前は購入時に自動で迷霊を解除していたが、面談を経ずに復帰させないため撤回した。
 *
 * ## 受付IDは `reeval` 固定
 *
 * パネル自体は運営が `/管理 → 受付パネル` から作る。**存在しなければ承認機能は動かない**
 * （fail-closed）。対応者資格もそのパネルの対応ロール（または管理者）を正とし、
 * 特定のロールをコードへ焼き付けない。
 */

/** 再評価面談の受付ID。意味論として固定する */
export const REEVAL_PANEL_ID = "reeval";
/** 面談権にあたる商品（再評価チャレンジ）の設定キー */
export const REEVAL_ITEM_SETTING_KEY = "shop:reeval_item_id";

export function reevalActionRow(disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("reeval:approve")
      .setLabel("復帰を承認")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId("reeval:reject")
      .setLabel("今回は見送る")
      .setEmoji("🚫")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}

/**
 * まだどのチケットにも消費されていない面談権を1件探す。
 *
 * 「未処理の再評価チャレンジ購入が無い人は承認できない」を成立させるための土台。
 * 商品の特定は設定値 `shop:reeval_item_id` に依り、未設定なら誰も承認できない（fail-closed）。
 */
export function findUnconsumedReevalPurchase(services: Services, userId: string): { id: number } | null {
  const itemId = Number(services.settings.getString(REEVAL_ITEM_SETTING_KEY));
  if (!Number.isInteger(itemId) || itemId <= 0) return null;
  const row = services.db
    .prepare(
      `SELECT p.id
         FROM shop_purchases p
        WHERE p.item_id = ? AND p.user_id = ? AND p.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.linked_purchase_id = p.id)
        ORDER BY p.purchased_at
        LIMIT 1`,
    )
    .get(itemId, userId) as { id: number } | undefined;
  return row ?? null;
}

/** チケット作成直後に面談権を結び付ける。無ければ結ばない（承認は後で弾かれる） */
export function linkReevalPurchase(services: Services, threadId: string, userId: string): number | null {
  const purchase = findUnconsumedReevalPurchase(services, userId);
  if (!purchase) return null;
  return services.tickets.linkPurchase(threadId, purchase.id, `user:${userId}`) ? purchase.id : null;
}

type Guard =
  | { ok: true; member: GuildMember; targetId: string; purchaseId: number }
  | { ok: false; message: string };

/**
 * 承認の前提をすべて取り直して確かめる。
 * パネル・対応者資格・DB status・在籍・面談権のどれが欠けても実行しない。
 */
async function guardApproval(interaction: ButtonInteraction, services: Services, guild: Guild): Promise<Guard> {
  const panel = services.tickets.getPanel(REEVAL_PANEL_ID);
  if (!panel || !panel.enabled || panel.archivedAt) {
    return { ok: false, message: "再評価面談の受付（`reeval`）が未作成・無効です。`/管理 → 受付パネル` で作成してください。" };
  }
  const ticket = services.tickets.get(interaction.channelId);
  if (!ticket || ticket.panel_id !== REEVAL_PANEL_ID) {
    return { ok: false, message: "この操作は再評価面談チケットの中でだけ使えます。" };
  }
  if (ticket.status === "closed") return { ok: false, message: "このチケットは既に完了しています。" };

  // 対応者資格はパネルの対応ロール（または管理者）。ロールをコードへ焼き付けない
  const actor = interaction.member as GuildMember | null;
  const staffRoleIds = panel.staffRoleIds;
  const isStaff = !!actor && staffRoleIds.some((id) => actor.roles.cache.has(id));
  if (!isStaff && !isAdmin(interaction, services)) {
    return { ok: false, message: "この操作には再評価面談の対応ロールが必要です。" };
  }

  const targetId = ticket.user_id;
  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) return { ok: false, message: `<@${targetId}> がサーバーに見つかりません。復帰処理は行いません。` };

  const soul = services.entry.getSoul(targetId);
  if (!soul) return { ok: false, message: `<@${targetId}> の魂の記録がありません。復帰処理は行いません。` };
  if (soul.status !== "meirei") {
    return { ok: false, message: `<@${targetId}> は現在 **${soul.status}** です。迷霊からの復帰だけを扱います。` };
  }

  if (ticket.linked_purchase_id === null) {
    // 開いた時点で権利が無かった、または他チケットが先に消費した。ここで拾い直す
    const claimed = linkReevalPurchase(services, interaction.channelId, targetId);
    if (claimed === null) {
      return {
        ok: false,
        message: `<@${targetId}> に未処理の再評価チャレンジの購入がありません（既に別の面談で消費済み、または未購入）。復帰処理は行いません。`,
      };
    }
    return { ok: true, member, targetId, purchaseId: claimed };
  }
  return { ok: true, member, targetId, purchaseId: ticket.linked_purchase_id };
}

export async function handleReevalApprove(interaction: ButtonInteraction, services: Services): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    return void (await interaction.reply({ content: "サーバー内で実行してください。", flags: MessageFlags.Ephemeral }));
  }
  const guard = await guardApproval(interaction, services, guild);
  if (!guard.ok) {
    return void (await interaction.reply({ content: `⚠️ ${guard.message}`, flags: MessageFlags.Ephemeral }));
  }
  await interaction.deferReply();
  const actor = `user:${interaction.user.id}`;

  const result = services.evaluation.reinstateFromMeirei(guard.targetId, actor, {
    ticketThreadId: interaction.channelId,
    purchaseId: guard.purchaseId,
    approver: interaction.user.id,
    panelId: REEVAL_PANEL_ID,
  });
  if (!result) {
    return void (await interaction.editReply(
      "⚠️ 直前に階級が変わったため中止しました（迷霊ではなくなっています）。何も変更していません。",
    ));
  }

  // ロール入れ替え。**失敗を握り潰さない**（台帳だけ進んでロールが残る事故を再発させない）
  const meireiRoleId = services.settings.getString("role:meirei");
  const ghostRoleId = services.settings.getString(RANK_ROLE_SETTING_KEYS.ghost);
  const roleErrors: string[] = [];
  if (meireiRoleId && guard.member.roles.cache.has(meireiRoleId)) {
    const removed = await guard.member.roles.remove(meireiRoleId).then(() => true).catch((e: Error) => e.message);
    if (removed !== true) roleErrors.push(`迷霊ロールの解除に失敗: ${removed}`);
  }
  if (ghostRoleId) {
    if (!guard.member.roles.cache.has(ghostRoleId)) {
      const added = await guard.member.roles.add(ghostRoleId).then(() => true).catch((e: Error) => e.message);
      if (added !== true) roleErrors.push(`亡霊ロールの付与に失敗: ${added}`);
    }
  } else {
    roleErrors.push("亡霊ロールが未設定");
  }
  if (roleErrors.length > 0) {
    services.events.log("reeval_role_repair_failed", {
      actor,
      target: guard.targetId,
      payload: { errors: roleErrors, threadId: interaction.channelId },
    });
  }

  const deadline = `<t:${result.deadline}:D>`;
  await interaction.editReply({
    content: [
      `✅ <@${guard.targetId}> の復帰を承認しました（**迷霊 → 亡霊**）。`,
      `新しい評価期間の締切: ${deadline}${result.revokedMarks > 0 ? ` / 以前の印 ${result.revokedMarks}件を取り消し（履歴は保持）` : ""}`,
      `面談権: 購入 #${guard.purchaseId}`,
      roleErrors.length > 0
        ? `⚠️ **ロールの入れ替えに失敗しました**（台帳は復帰済み）:\n${roleErrors.map((e) => `・${e}`).join("\n")}\n手動で迷霊を外し亡霊を付けてください。`
        : "",
      "-# 初期Landの再発行・招待実績の再計上・招待者の期限延長は行っていません。",
    ]
      .filter(Boolean)
      .join("\n"),
    allowedMentions: { parse: [] },
  });
}

export async function handleReevalReject(interaction: ButtonInteraction, services: Services): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    return void (await interaction.reply({ content: "サーバー内で実行してください。", flags: MessageFlags.Ephemeral }));
  }
  const guard = await guardApproval(interaction, services, guild);
  if (!guard.ok) {
    return void (await interaction.reply({ content: `⚠️ ${guard.message}`, flags: MessageFlags.Ephemeral }));
  }
  await interaction.deferReply();
  services.evaluation.recordReevalRejection(guard.targetId, `user:${interaction.user.id}`, {
    ticketThreadId: interaction.channelId,
    purchaseId: guard.purchaseId,
    approver: interaction.user.id,
    panelId: REEVAL_PANEL_ID,
  });
  await interaction.editReply({
    content: [
      `🚫 <@${guard.targetId}> の復帰は今回見送りとしました。`,
      "階級・ロール・評価印はいずれも変更していません。",
      "-# 購入代は面談を受ける権利に対するものなので、返金は行いません。",
    ].join("\n"),
    allowedMentions: { parse: [] },
  });
}
