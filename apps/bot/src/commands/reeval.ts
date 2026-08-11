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
          -- まだ面談サービスを提供していない購入だけ（消費済みは delivered で表す）
          AND p.delivered_at IS NULL
          AND COALESCE(p.delivery_state, 'pending') <> 'delivered'
          -- 他のチケットが予約中でない
          AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.linked_purchase_id = p.id)
        ORDER BY p.purchased_at
        LIMIT 1`,
    )
    .get(itemId, userId) as { id: number } | undefined;
  return row ?? null;
}

/**
 * チケット作成直後に面談権を**予約**する。無ければ結ばない（承認は後で弾かれる）。
 *
 * ここでの紐付けは予約でしかない。消費されるのは面談結果を出したときだけで、
 * 結果を出さずに閉じたチケットの予約は `Tickets.close()` が戻す。
 */
export function linkReevalPurchase(services: Services, threadId: string, userId: string): number | null {
  const purchase = findUnconsumedReevalPurchase(services, userId);
  if (!purchase) return null;
  return services.tickets.linkPurchase(threadId, purchase.id, `user:${userId}`) ? purchase.id : null;
}

/** 確定を中止する理由。投げてトランザクションごと巻き戻す */
class SettleAbort extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "SettleAbort";
  }
}

export type SettleResult =
  | { ok: true; reinstated: ReturnType<Services["evaluation"]["reinstateFromMeirei"]> }
  | { ok: false; reason: string };

/**
 * 面談結果の確定。結果の記録・購入の消費・チケットのcloseを1トランザクションで行う。
 *
 * ## 確定直前にもう一度確かめる
 *
 * `guardApproval()` を通ってからここへ来るまでに、購入が返金される・階級が動く・
 * 別のスタッフがチケットを閉じる、といった変化が挟まりうる（TOCTOU）。
 * **IMMEDIATE トランザクションの中で正本をすべて取り直し**、1つでも崩れていれば
 * 何も書かずに巻き戻す。購入の消費も条件付き UPDATE で1行動いたことを確かめる。
 *
 * 通常の close と競合しても、どちらか一方だけが成立する。
 * - close が先 … チケットが closed になり、ここは `ticket_closed` で中止する
 * - 確定が先 … 購入を消費してから close するので、後続の close は権利を戻さない
 */
export function settleInterview(
  services: Services,
  input: { threadId: string; targetId: string; purchaseId: number; actor: string; approve: boolean; evidence: Record<string, unknown> },
): SettleResult {
  const run = services.db.transaction((): SettleResult => {
    // ---- 正本の再確認（ここから下は同じトランザクション内） ----
    const ticket = services.tickets.get(input.threadId);
    if (!ticket || ticket.panel_id !== REEVAL_PANEL_ID) throw new SettleAbort("ticket_missing_or_wrong_panel");
    if (ticket.user_id !== input.targetId) throw new SettleAbort("ticket_user_mismatch");
    if (ticket.status !== "open" && ticket.status !== "claimed") throw new SettleAbort(`ticket_${ticket.status}`);
    if (ticket.linked_purchase_id !== input.purchaseId) throw new SettleAbort("purchase_link_changed");

    const itemId = Number(services.settings.getString(REEVAL_ITEM_SETTING_KEY));
    if (!Number.isInteger(itemId) || itemId <= 0) throw new SettleAbort("reeval_item_setting_missing");
    const purchase = services.shop.getPurchase(input.purchaseId);
    if (!purchase) throw new SettleAbort("purchase_not_found");
    if (purchase.user_id !== input.targetId) throw new SettleAbort("purchase_user_mismatch");
    if (purchase.item_id !== itemId) throw new SettleAbort("purchase_item_mismatch");
    if (purchase.status !== "active") throw new SettleAbort(`purchase_${purchase.status}`);
    if (purchase.delivered_at !== null) throw new SettleAbort("purchase_already_delivered");
    if (purchase.delivery_state === "delivered") throw new SettleAbort("purchase_already_consumed");

    const soul = services.entry.getSoul(input.targetId);
    if (!soul) throw new SettleAbort("no_soul_row");
    if (soul.status !== "meirei") throw new SettleAbort(`not_meirei:${soul.status}`);

    // ---- 書き込み ----
    let reinstated: ReturnType<Services["evaluation"]["reinstateFromMeirei"]> = null;
    if (input.approve) {
      reinstated = services.evaluation.reinstateFromMeirei(input.targetId, input.actor, input.evidence);
      if (!reinstated) throw new SettleAbort("reinstate_precondition_lost");
    } else {
      services.evaluation.recordReevalRejection(input.targetId, input.actor, input.evidence);
    }
    // 面談を提供したので購入権を消費する（手動配送の完了と同じ意味）。
    // **close より先に消費する**。順序が逆だと close が予約を戻してしまう
    if (!services.shop.consumePurchaseForService(input.purchaseId, input.actor, { via: "reeval", threadId: input.threadId })) {
      throw new SettleAbort("purchase_consume_failed");
    }
    if (!services.tickets.close(input.threadId, input.actor)) throw new SettleAbort("ticket_close_failed");
    return { ok: true, reinstated };
  });
  try {
    return run.immediate();
  } catch (e) {
    if (e instanceof SettleAbort) return { ok: false, reason: e.reason };
    throw e;
  }
}

type Guard =
  | { ok: true; member: GuildMember; targetId: string; purchaseId: number }
  | { ok: false; message: string };

/**
 * 面談権として使ってよい購入かを**その場で取り直して**確かめる。
 *
 * `linked_purchase_id` を信用しない。予約した後に返金・取消されている、
 * 別人・別商品の購入が誤って結ばれている、といった状態で承認させないため。
 */
function verifyPurchase(services: Services, purchaseId: number, ticketUserId: string): string | null {
  const itemId = Number(services.settings.getString(REEVAL_ITEM_SETTING_KEY));
  if (!Number.isInteger(itemId) || itemId <= 0) return "再評価チャレンジの商品ID（`shop:reeval_item_id`）が未設定です。";
  const purchase = services.shop.getPurchase(purchaseId);
  if (!purchase) return `面談権の購入 #${purchaseId} が見つかりません。`;
  if (purchase.user_id !== ticketUserId) return `購入 #${purchaseId} は別の利用者のものです。`;
  if (purchase.item_id !== itemId) return `購入 #${purchaseId} は再評価チャレンジではありません。`;
  if (purchase.status !== "active") return `購入 #${purchaseId} は ${purchase.status} のため面談権として使えません。`;
  if (purchase.delivered_at !== null || purchase.delivery_state === "delivered") {
    return `購入 #${purchaseId} は既に面談で消費済みです。`;
  }
  return null;
}

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
  // 予約済みでも、いまも面談権として有効かを取り直して確かめる
  const invalid = verifyPurchase(services, ticket.linked_purchase_id, targetId);
  if (invalid) return { ok: false, message: `${invalid} 復帰処理は行いません。` };
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

  const settled = settleInterview(services, {
    threadId: interaction.channelId,
    targetId: guard.targetId,
    purchaseId: guard.purchaseId,
    actor,
    approve: true,
    evidence: {
      ticketThreadId: interaction.channelId,
      purchaseId: guard.purchaseId,
      approver: interaction.user.id,
      panelId: REEVAL_PANEL_ID,
    },
  });
  if (!settled.ok) {
    return void (await interaction.editReply(
      `⚠️ 直前に状態が変わったため中止しました（\`${settled.reason}\`）。階級・購入・チケットのいずれも変更していません。`,
    ));
  }
  const result = settled.reinstated!;

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
      `面談権: 購入 #${guard.purchaseId} を消費（チケットは完了）。`,
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
  const settled = settleInterview(services, {
    threadId: interaction.channelId,
    targetId: guard.targetId,
    purchaseId: guard.purchaseId,
    actor: `user:${interaction.user.id}`,
    approve: false,
    evidence: {
      ticketThreadId: interaction.channelId,
      purchaseId: guard.purchaseId,
      approver: interaction.user.id,
      panelId: REEVAL_PANEL_ID,
    },
  });
  if (!settled.ok) {
    return void (await interaction.editReply(
      `⚠️ 直前に状態が変わったため中止しました（\`${settled.reason}\`）。階級・購入・チケットのいずれも変更していません。`,
    ));
  }
  await interaction.editReply({
    content: [
      `🚫 <@${guard.targetId}> の復帰は今回見送りとしました。チケットは完了にしました。`,
      "階級・ロール・評価印はいずれも変更していません。",
      "-# 購入代は面談を受ける権利に対するものなので、返金は行いません。",
    ].join("\n"),
    allowedMentions: { parse: [] },
  });
}
