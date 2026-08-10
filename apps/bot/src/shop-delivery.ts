import type { Guild } from "discord.js";
import type { PurchaseRow, ShopItemRow } from "@meigokujo/core";
import { refreshEvalStatsForUser } from "./eval-daily.js";
import type { Services } from "./services.js";

/**
 * 自動配送の実行。**購入（課金）とは独立した工程**として扱う。
 *
 * ## なぜ分けるか
 *
 * 以前は `purchaseOnce()` が課金と operation の completed を確定した後に配送していた。
 * つまり**配送が失敗しても課金だけ成立**し、同じ operation の再実行は `replayed=true` で
 * 配送そのものを飛ばすので、二度と配れなかった。実際に「再評価チャレンジ」で
 * 500,000Ld を払ったのに迷霊ロールが外れないまま、という事故が起きている。
 *
 * ここでは配送状態（pending / delivered / failed）を購入行に持たせ、
 * **成功するまで何度でも同じ購入を配送できる**ようにする。二重配送は
 * `beginDelivery()` の `delivered` 判定と、各配送種別の冪等性で防ぐ。
 *
 * ## interaction を受け取らない
 *
 * 購入直後の配送も、運営の回収導線からの再配送も同じ経路を通す必要がある。
 * そのため Discord の interaction ではなく `Guild` だけを受け取る。
 */

export interface DeliveryOutcome {
  state: "delivered" | "failed" | "already_delivered";
  /** 利用者へ見せる文言。**失敗時に「配送しました」と読める文言を返さない** */
  message: string;
  /** 失敗理由（記録用） */
  error?: string;
}

/** 購入に記録された配送内容。商品の現在値ではなく**売った時点のスナップショット**を使う */
function deliveryOf(purchase: PurchaseRow, item: ShopItemRow): { kind: string | null; data: { role_id?: string; days?: number } } {
  const raw = purchase.delivery_snapshot_json;
  if (raw) {
    try {
      const snapshot = JSON.parse(raw) as { delivery_kind?: string; delivery_data?: string | null };
      const data = snapshot.delivery_data ? (JSON.parse(snapshot.delivery_data) as { role_id?: string; days?: number }) : {};
      return { kind: snapshot.delivery_kind ?? null, data };
    } catch {
      /* 壊れていたら商品定義へフォールバック */
    }
  }
  return {
    kind: item.delivery_kind,
    data: item.delivery_data ? (JSON.parse(item.delivery_data) as { role_id?: string; days?: number }) : {},
  };
}

export async function deliverPurchase(
  services: Services,
  guild: Guild | null,
  purchase: PurchaseRow,
  item: ShopItemRow,
  actor: string,
): Promise<DeliveryOutcome> {
  const begin = services.shop.beginDelivery(purchase.id);
  if (!begin.proceed) {
    // 二度押し・再起動・再配送要求。副作用を一切走らせない
    return { state: "already_delivered", message: "この購入は配送済みです。" };
  }

  const fail = (reason: string, userMessage: string): DeliveryOutcome => {
    services.shop.markDeliveryFailed(purchase.id, reason, actor);
    return { state: "failed", message: userMessage, error: reason };
  };

  const { kind, data } = deliveryOf(purchase, item);
  const userId = purchase.user_id;

  try {
    if (kind === "add_role") {
      const roleId = data.role_id;
      if (!roleId) return fail("role_id_missing", "配送設定が不完全です（ロールID未設定）。運営にお問い合わせください。");
      if (!guild) return fail("guild_unavailable", "サーバー情報が取れず配送できませんでした。運営にお問い合わせください。");
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) return fail("member_fetch_failed", "メンバー情報の取得に失敗し配送できませんでした。運営にお問い合わせください。");
      if (!member.roles.cache.has(roleId)) {
        // 付与済みなら何もしない（冪等）
        const added = await member.roles.add(roleId).then(() => true).catch((e: Error) => e.message);
        if (added !== true) return fail(`role_add_failed:${added}`, "ロールの付与に失敗しました。運営にお問い合わせください。");
      }
      services.shop.markDeliverySucceeded(purchase.id, actor);
      return { state: "delivered", message: `ロールを付与しました: <@&${roleId}>` };
    }

    if (kind === "extend_deadline") {
      const days = data.days ?? 1;
      const soul = services.entry.getSoul(userId);
      if (!soul || !soul.eval_deadline_at) {
        return fail("no_eval_deadline", "評価期限を持っていないため延長できませんでした。運営にお問い合わせください。");
      }
      // 冪等でない配送なので、効果と完了マークを同じトランザクションで確定する。
      // 途中で落ちても「延ばしたのに未配送のまま」にはならない＝再試行で二重延長しない
      services.shop.completeDeliveryWith(purchase.id, actor, () => {
        services.db
          .prepare("UPDATE souls SET eval_deadline_at = eval_deadline_at + ?, updated_at = ? WHERE user_id = ?")
          .run(days * 86_400, Math.floor(Date.now() / 1_000), userId);
      });
      if (guild) await refreshEvalStatsForUser(guild, services, userId).catch(() => undefined);
      return { state: "delivered", message: `評価期限を **+${days}日** 延長しました。` };
    }

    if (kind === "revoke_meirei") {
      return await deliverRevokeMeirei(services, guild, purchase, actor, fail);
    }

    return fail(`unsupported_delivery_kind:${kind ?? "null"}`, "自動配送は未対応の種類です。運営にお問い合わせください。");
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return fail(`unexpected:${reason}`, "配送処理でエラーが発生しました。運営にお問い合わせください。");
  }
}

/**
 * 再評価チャレンジ（迷霊 → 案内待ち）。
 *
 * DB と Discord ロールの**片方だけ済んでいる状態から再開できる**必要がある。
 * 実際に「DBはwaitingに戻ったが迷霊ロールが残ったまま」が本番で発生している。
 *
 * - DB=meirei … `resetToWaiting()` してからロール修復へ進む
 * - DB=waiting … 既にreset済み。**再resetせず**ロール修復だけ続行する
 * - それ以外 … 触らない（亡霊や魔人へ勝手に効かせない）
 *
 * ロールが既に正しければ何もせず成功（冪等）。
 */
async function deliverRevokeMeirei(
  services: Services,
  guild: Guild | null,
  purchase: PurchaseRow,
  actor: string,
  fail: (reason: string, userMessage: string) => DeliveryOutcome,
): Promise<DeliveryOutcome> {
  const userId = purchase.user_id;
  const soul = services.entry.getSoul(userId);
  if (!soul) return fail("no_soul_row", "魂の記録がないため適用できませんでした。運営にお問い合わせください。");

  if (soul.status === "meirei") {
    services.entry.resetToWaiting(userId, actor);
  } else if (soul.status !== "waiting") {
    // 亡霊・魔人などへ再評価チャレンジを効かせない
    return fail(`unexpected_status:${soul.status}`, `現在の状態（${soul.status}）では適用できませんでした。運営にお問い合わせください。`);
  }

  // ここから先はロール修復。DBが既に waiting でも、ロールが残っていれば直す
  if (!guild) return fail("guild_unavailable", "サーバー情報が取れずロールを直せませんでした。運営にお問い合わせください。");
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return fail("member_fetch_failed", "メンバー情報の取得に失敗しロールを直せませんでした。運営にお問い合わせください。");

  const meireiRoleId = services.settings.getString("role:meirei");
  const waitRoleId = services.settings.getString("role:queue_wait");

  if (meireiRoleId && member.roles.cache.has(meireiRoleId)) {
    const removed = await member.roles.remove(meireiRoleId).then(() => true).catch((e: Error) => e.message);
    if (removed !== true) {
      return fail(`meirei_role_remove_failed:${removed}`, "迷霊ロールの解除に失敗しました。運営にお問い合わせください（再配送で復旧できます）。");
    }
  }
  if (waitRoleId && !member.roles.cache.has(waitRoleId)) {
    const added = await member.roles.add(waitRoleId).then(() => true).catch((e: Error) => e.message);
    if (added !== true) {
      return fail(`queue_wait_role_add_failed:${added}`, "案内待ちロールの付与に失敗しました。運営にお問い合わせください（再配送で復旧できます）。");
    }
  }

  services.shop.markDeliverySucceeded(purchase.id, actor);
  return { state: "delivered", message: "迷霊から案内待ちに戻しました（再評価チャレンジ発動）。" };
}

/**
 * 運営の回収導線: purchase ID を指定して再配送する。
 *
 * **任意の商品効果を撃てる汎用口にはしない。** 対象は
 * 「実在する購入」「status=active」「自動配送の商品」「配送が未完了」に限り、
 * 実行する内容もその購入に記録された配送スナップショットだけ。
 */
export async function redeliverPurchase(
  services: Services,
  guild: Guild | null,
  purchaseId: number,
  actor: string,
): Promise<DeliveryOutcome> {
  const purchase = services.shop.getPurchase(purchaseId);
  if (!purchase) return { state: "failed", message: "その購入が見つかりません。", error: "purchase_not_found" };
  if (purchase.status !== "active") {
    return { state: "failed", message: `この購入は ${purchase.status} のため再配送できません。`, error: "purchase_not_active" };
  }
  const item = services.shop.getItem(purchase.item_id);
  if (!item) return { state: "failed", message: "商品定義が見つかりません。", error: "item_not_found" };
  if (item.delivery !== "auto") {
    return { state: "failed", message: "手動配送の商品は再配送の対象外です。", error: "not_auto_delivery" };
  }
  services.events.log("shop_redelivery_requested", {
    actor,
    target: purchase.user_id,
    payload: { purchaseId, itemId: item.id, previousState: purchase.delivery_state, attempts: purchase.delivery_attempts },
  });
  return deliverPurchase(services, guild, purchase, item, actor);
}
