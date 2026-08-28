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
import { controlMessageOf, finalizeTicketDiscordState, ticketActionRow } from "./ticket-display.js";
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

/**
 * 再評価**面談受付**が今すぐ使える状態か。使えないなら理由(内部用)を返す。
 *
 * 500,000Ld / 招待5件の商品なので、「買ったのに受け付ける場所が無い」を作らない。
 * DB上の受付panelだけで判断する——Discord APIへ問い合わせないので、購入transactionの
 * 中から同期的に呼べる（charge直前の再確認に使う）。
 */
export function reevaluationIntakeUnavailableReason(
  services: Pick<Services, "tickets">,
): "panel_missing" | "panel_disabled" | "panel_archived" | "panel_not_posted" | null {
  const panel = services.tickets.getPanel(REEVAL_PANEL_ID);
  if (!panel) return "panel_missing";
  if (panel.archivedAt) return "panel_archived";
  if (!panel.enabled) return "panel_disabled";
  if (!panel.channelId || !panel.messageId) return "panel_not_posted";
  return null;
}

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
 *
 * 商品の特定に現在の `shop:reeval_item_id` は**使わない**——利用者が買ったのは商品IDではなく
 * 「面談を1回受ける権利」なので、運営が商品を作り直しても設定を外しても権利は生き続ける。
 * 判定はShopのsemantic API（購入時に確定した不変記録が正本）へ委譲する。Bot側でprovenance
 * SQLを複製しない。
 */
export function findUnconsumedReevalPurchase(services: Services, userId: string): { id: number } | null {
  // ticketへ新しく予約するための探索なので、既に他のticketが予約中のものは除く。
  return services.shop.findUnreservedReevaluationRight(userId);
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

    const purchase = services.shop.getPurchase(input.purchaseId);
    if (!purchase) throw new SettleAbort("purchase_not_found");
    if (purchase.user_id !== input.targetId) throw new SettleAbort("purchase_user_mismatch");
    // 現在の商品設定は見ない。購入時に確定した意味だけで判断する——A→B差し替え後も、
    // 設定が消えていても、既に成立した面談権は確定できる。
    if (!services.shop.isReevaluationPurchase(purchase.id)) throw new SettleAbort("purchase_not_reevaluation");
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

/**
 * 復帰後のロール入れ替え。**順序そのものを fail-safe にする。**
 *
 * ## なぜ順序が効くか
 *
 * 階級同期は「迷霊ロールがあれば通常階級より優先」かつ「`ghost → meirei` は
 * 自動同期してよい」ルールで動く（どちらも通常の降格反映として必要なので変えない）。
 * そのため **迷霊ロールを外し損ねたまま亡霊ロールを付ける**と、Discord が
 * 「迷霊 + 亡霊」になり、その付与イベントで走った同期が
 * **台帳を ghost から meirei へ戻してしまう**。承認した復帰が消える。
 *
 * 抑止フラグで防ぐのではなく、そういう状態を**作らない**ことで防ぐ。
 *
 * - 迷霊ロールがあるなら、まず外す。外せなければ**亡霊ロールを付けない**
 *   （付けなければ付与イベント自体が起きず、同期も走らない）
 * - 外せたことを force fetch で確かめてから亡霊ロールへ進む
 * - 亡霊ロールの付与に失敗しても「DB=ghost・階級ロール無し」で済む。
 *   この構成は同期側で `no_rank_role` の ambiguous になり、台帳は書き換わらない
 * - もともと迷霊ロールが無いならそのまま亡霊ロールを付けてよい
 */
export async function applyReinstateRoles(
  services: Services,
  guild: Guild,
  member: GuildMember,
  targetId: string,
  actor: string,
): Promise<{ errors: string[] }> {
  const meireiRoleId = services.settings.getString("role:meirei");
  const ghostRoleId = services.settings.getString(RANK_ROLE_SETTING_KEYS.ghost);
  const errors: string[] = [];
  let current = member;

  if (meireiRoleId && current.roles.cache.has(meireiRoleId)) {
    const removed = await current.roles.remove(meireiRoleId).then(() => true).catch((e: Error) => e.message);
    if (removed !== true) {
      // ここで亡霊ロールを付けると「迷霊+亡霊」になり、同期が台帳を迷霊へ戻す
      errors.push(`迷霊ロールの解除に失敗: ${removed}（台帳は亡霊。迷霊ロールを手で外してください）`);
      return { errors };
    }
    // 実際に消えたかを取り直して確かめる（remove が通っても反映を待つ場合がある）
    const refetched = await guild.members.fetch({ user: targetId, force: true }).catch(() => null);
    if (!refetched) {
      errors.push("迷霊ロール解除後の再取得に失敗（亡霊ロールは付けていません。手で確認してください）");
      return { errors };
    }
    if (meireiRoleId && refetched.roles.cache.has(meireiRoleId)) {
      errors.push("迷霊ロールが解除後も残っています（亡霊ロールは付けていません。手で外してください）");
      return { errors };
    }
    current = refetched;
  }

  if (!ghostRoleId) {
    errors.push("亡霊ロールが未設定");
    return { errors };
  }
  if (!current.roles.cache.has(ghostRoleId)) {
    const added = await current.roles.add(ghostRoleId).then(() => true).catch((e: Error) => e.message);
    // 失敗しても「階級ロール無し」で止まる。同期は no_rank_role で台帳を触らない
    if (added !== true) errors.push(`亡霊ロールの付与に失敗: ${added}（迷霊ロールは外れています）`);
  }
  return { errors };
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
  // 現在の販売設定に依存しない。設定が未設定でも、商品がA→Bへ差し替わっていても、
  // 既に購入済みの面談権は有効。
  const purchase = services.shop.getPurchase(purchaseId);
  if (!purchase) return `面談権の購入 #${purchaseId} が見つかりません。`;
  if (purchase.user_id !== ticketUserId) return `購入 #${purchaseId} は別の利用者のものです。`;
  if (!services.shop.isReevaluationPurchase(purchase.id)) return `購入 #${purchaseId} は再評価チャレンジではありません。`;
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

  const { errors: roleErrors } = await applyReinstateRoles(services, guild, guard.member, guard.targetId, actor);
  if (roleErrors.length > 0) {
    services.events.log("reeval_role_repair_failed", {
      actor,
      target: guard.targetId,
      payload: { errors: roleErrors, threadId: interaction.channelId },
    });
  }

  // 台帳は確定済み。Discord側の表示も完了状態へ揃える（失敗しても巻き戻さない）
  const displayProblems = await finalizeTicketDiscordState(
    services,
    interaction.channel as never,
    services.tickets.get(interaction.channelId),
    { controlMessage: controlMessageOf(interaction), components: [ticketActionRow("closed"), reevalActionRow(true)], actor, reason: "再評価面談の対応完了" },
  ).catch(() => ["表示の完了処理に失敗しました"]);

  const deadline = `<t:${result.deadline}:D>`;
  await interaction.editReply({
    content: [
      `✅ <@${guard.targetId}> の復帰を承認しました（**迷霊 → 亡霊**）。`,
      `新しい評価期間の締切: ${deadline}${result.revokedMarks > 0 ? ` / 以前の印 ${result.revokedMarks}件を取り消し（履歴は保持）` : ""}`,
      `面談権: 購入 #${guard.purchaseId} を消費（チケットは完了）。`,
      roleErrors.length > 0
        ? `⚠️ **ロールの入れ替えに失敗しました**（台帳は亡霊で確定済み）:\n${roleErrors.map((e) => `・${e}`).join("\n")}\n-# 迷霊ロールが残っている場合、亡霊ロールは**わざと付けていません**（両方付くと階級同期が台帳を迷霊へ戻すため）。先に迷霊ロールを外してください。`
        : "",
      displayProblems.length > 0
        ? `⚠️ 表示の完了処理に失敗しました（台帳は確定済み）: ${displayProblems.join(" / ")}
-# チケットの「表示を修復」を押すと、表示だけやり直せます。`
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
  await finalizeTicketDiscordState(
    services,
    interaction.channel as never,
    services.tickets.get(interaction.channelId),
    { controlMessage: controlMessageOf(interaction), components: [ticketActionRow("closed"), reevalActionRow(true)], actor: `user:${interaction.user.id}`, reason: "再評価面談の対応完了（見送り）" },
  ).catch(() => undefined);
  await interaction.editReply({
    content: [
      `🚫 <@${guard.targetId}> の復帰は今回見送りとしました。チケットは完了にしました。`,
      "階級・ロール・評価印はいずれも変更していません。",
      "-# 購入代は面談を受ける権利に対するものなので、返金は行いません。",
    ].join("\n"),
    allowedMentions: { parse: [] },
  });
}
