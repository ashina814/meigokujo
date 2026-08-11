import type { Guild } from "discord.js";
import { AUTO_DELIVERABLE_KINDS, parseDeliverySnapshot, type PurchaseRow } from "@meigokujo/core";
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

/**
 * 購入に記録された配送内容。**商品の現在定義へフォールバックしない。**
 *
 * 再配送は「その購入で何を売ったか」だけを再実行する約束なので、スナップショットが
 * 無い・壊れている・知らない種別なら何もしない（legacy unknown）。ここでフォールバックすると、
 * 商品定義を後から変えただけで過去の購入の配送内容が変わってしまう。
 */
export async function deliverPurchase(
  services: Services,
  guild: Guild | null,
  purchase: PurchaseRow,
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

  const snapshot = parseDeliverySnapshot(purchase.delivery_snapshot_json);
  if (!snapshot) {
    // 購入時の配送内容が読めない。商品の現在設定で代用せず、何もせず failed にする
    return fail(
      purchase.delivery_snapshot_json ? "snapshot_unreadable" : "snapshot_missing",
      "この購入には配送内容の記録がないため自動配送できません。運営にお問い合わせください。",
    );
  }
  if (!AUTO_DELIVERABLE_KINDS.has(snapshot.delivery_kind)) {
    // 撤回された配送種別（再評価チャレンジの revoke_meirei）。
    // 面談を経ずに status とロールを動かさない。過去の購入も自動では実行しない
    return fail(
      `auto_delivery_withdrawn:${snapshot.delivery_kind}`,
      "この商品は自動での適用を行いません。**再評価面談チケット**を開いてください。",
    );
  }
  const kind = snapshot.delivery_kind;
  const data = snapshot.delivery_data as { role_id?: string; days?: number };
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

    return fail(`unsupported_delivery_kind:${kind ?? "null"}`, "自動配送は未対応の種類です。運営にお問い合わせください。");
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return fail(`unexpected:${reason}`, "配送処理でエラーが発生しました。運営にお問い合わせください。");
  }
}

/**
 * 運営の回収導線: purchase ID を指定して再配送する。
 *
 * **任意の商品効果を撃てる汎用口にはしない。** 対象は
 * 「実在する購入」「status=active」「購入時に自動配送として売られた記録がある」に限り、
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
  // 可否は**購入時スナップショット**で決める。商品の現在設定を根拠にすると、
  // 買った後に商品を自動配送へ変えただけで過去の購入が再配送できてしまう
  const snapshot = parseDeliverySnapshot(purchase.delivery_snapshot_json);
  if (!snapshot) {
    return {
      state: "failed",
      message: "この購入には自動配送の記録がありません（手動配送・または記録以前の購入）。再配送の対象外です。",
      error: purchase.delivery_snapshot_json ? "snapshot_unreadable" : "snapshot_missing",
    };
  }
  if (!AUTO_DELIVERABLE_KINDS.has(snapshot.delivery_kind)) {
    return {
      state: "failed",
      message: "この配送種別は自動実行を取りやめています（再評価チャレンジは面談を経て復帰します）。再配送できません。",
      error: `auto_delivery_withdrawn:${snapshot.delivery_kind}`,
    };
  }
  services.events.log("shop_redelivery_requested", {
    actor,
    target: purchase.user_id,
    payload: {
      purchaseId,
      itemId: purchase.item_id,
      deliveryKind: snapshot.delivery_kind,
      previousState: purchase.delivery_state,
      attempts: purchase.delivery_attempts,
    },
  });
  return deliverPurchase(services, guild, purchase, actor);
}
