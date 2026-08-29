import type { Client, Guild } from "discord.js";
import { ShopError, type PurchaseRow } from "@meigokujo/core";
import { refreshShopAdminPanels } from "./commands/shokan.js";
import {
  deliverPurchaseUnlocked,
  withNicknameSerialization,
  withPurchaseLock,
  type DeliveryOutcome,
} from "./shop-delivery.js";
import type { Services } from "./services.js";

/**
 * 返金の結末。
 *
 * - `refunded` … 返した（既に返金済みだった場合も含む）
 * - `already_delivered` … サービスは提供済みだった。**返さないのが正しい**
 * - `withheld`          … **提供できたか確認できていないので、返金を試していない**
 * - `escalated`         … 返金を試したが完了できなかった
 *
 * `withheld` と `escalated` は利用者への説明がまったく違う。前者は「確認中」、
 * 後者は「変更できず、返金も完了していない」。混ぜると事実と食い違う。
 */
export type RefundOutcome = "refunded" | "already_delivered" | "withheld" | "escalated";

/** 配送の結果と、失敗したときの後始末。`refund` は配送が失敗したときだけ付く */
export interface Settlement {
  outcome: DeliveryOutcome;
  refund?: RefundOutcome;
}

/**
 * 配って、駄目なら返す。**ここまでを1つの区間として直列化する。**
 *
 * 配送だけを直列化しても足りない。失敗した1本目が返金を書き込むより先に2本目が
 * 走ると、2本目は「まだ有効な購入」を見てサービスを提供してしまい、直後に1本目の
 * 返金が通る——**変えたうえで返した**が成立する。返金までロックの中に入れると、
 * 2本目は必ず「返金済み」を見て何もしない。
 */
export function deliverOrRefund(
  client: Client,
  services: Services,
  guild: Guild | null,
  purchase: PurchaseRow,
  actor: string,
): Promise<Settlement> {
  return withNicknameSerialization(purchase, () =>
    withPurchaseLock(purchase.id, async () => {
      // **返金まで面倒を見るので、claim は解放させずに受け取る。**
      const outcome = await deliverPurchaseUnlocked(services, guild, purchase, actor, {
        deferReleaseForRefund: true,
      });
      if (outcome.state !== "failed") return { outcome };
      if (outcome.refundable === false) {
        // Discord側の副作用を戻せたか確認できていない。**返金しないで人へ渡す**
        services.events.log("shop_refund_withheld", {
          actor,
          target: purchase.user_id,
          payload: { purchaseId: purchase.id, reason: outcome.error ?? "delivery_failed" },
        });
        await refreshShopAdminPanels(client, services).catch(() => undefined);
        // **「返金に失敗しました」ではない。** この経路は返金を試していない。
        // 事実は「提供できたか確認できないので、自動返金していない」
        await notifyUncertainDelivery(client, services, purchase.id).catch(() => undefined);
        return { outcome, refund: "withheld" as const };
      }
      const refund = await refundOrEscalate(
        client,
        services,
        purchase,
        outcome.error ?? "delivery_failed",
        actor,
        outcome.refundClaimToken ?? null,
      );
      return { outcome, refund };
    }),
  );
}

/**
 * 配送できなかった課金を返す。**返金まで失敗したときだけ**運営へ上げる。
 *
 * 利用者から見た約束は「変わらなかったなら払っていない」なので、返金が通る限り
 * スタッフの仕事を作らない。通らなかったときは、放っておくと利用者が払っただけに
 * なるので、管理パネルを更新したうえで**ボタンの無い**通知を出す。
 * 操作は管理パネル（正本）に集約し、通知メッセージを業務の入口にしない。
 */
/**
 * 決着が「いまの claim のもの」でなかったことを示すコード。
 *
 * 何も書けていないので、利用者へも運営へも「返金に失敗した」と言ってはいけない。
 */
const CLAIM_AUTHORITY_CODES = new Set(["ERR_CLAIM_UNKNOWN", "ERR_CLAIM_CONFLICT", "ERR_CLAIM_SUPERSEDED", "ERR_CLAIM_STALE"]);

export async function refundOrEscalate(
  client: Client,
  services: Services,
  purchase: { id: number; user_id: string },
  reason: string,
  actor: string,
  claimToken: string | null = null,
): Promise<RefundOutcome> {
  let outcome: ReturnType<typeof services.shop.settleVerifiedFailure>;
  try {
    // **claim の解放・配送失敗の確定・返金（または義務の記録）を1つの transaction で。**
    // 別々にすると、その隙に別プロセスの失効が割り込み、復旧不能な状態が作れる
    outcome = services.shop.settleVerifiedFailure({
      purchaseId: purchase.id,
      claimToken,
      reason,
      actor,
    });
  } catch (error) {
    if (error instanceof ShopError && error.code === "ERR_ALREADY_DELIVERED") {
      // 配送が先に確定していた。返さないのが正しいので、人も呼ばない
      services.events.log("shop_refund_skipped_delivered", {
        actor,
        target: purchase.user_id,
        payload: { purchaseId: purchase.id, reason },
      });
      return "already_delivered";
    }
    if (error instanceof ShopError && CLAIM_AUTHORITY_CODES.has(error.code)) {
      // **この決着は、いまの claim のものではない。** 何も書けていないので
      // 「返金に失敗しました」ではなく「確認できていない」として人へ渡す
      services.events.log("shop_refund_withheld", {
        actor,
        target: purchase.user_id,
        payload: { purchaseId: purchase.id, reason, error: error.code },
      });
      await refreshShopAdminPanels(client, services).catch(() => undefined);
      await notifyUncertainDelivery(client, services, purchase.id).catch(() => undefined);
      return "withheld";
    }
    throw error;
  }
  if (!("failed" in outcome)) return "refunded";
  services.events.log("shop_refund_failed", {
    actor,
    target: purchase.user_id,
    payload: { purchaseId: purchase.id, reason, error: outcome.message },
  });
  await refreshShopAdminPanels(client, services).catch(() => undefined);
  await notifyRefundFailure(client, services, purchase.id).catch(() => undefined);
  return "escalated";
}

/**
 * 提供できたか確認できないまま止まった案件を、スタッフへ知らせる。
 *
 * **「返金に失敗しました」と言わない。** この経路は返金を試していない。
 * 仕事の正本は管理パネルなので、ここではボタンを置かず場所だけ示す。
 */
async function notifyUncertainDelivery(client: Client, services: Services, purchaseId: number): Promise<void> {
  const channelId = services.settings.getString("channel:shokan") ?? services.settings.getString("channel:kessai");
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) return;
  await channel
    .send({
      content: `🛰 **提供状態を確認できないため、自動返金していません**（購入 #${purchaseId}）。商館の管理パネル →「対応が必要」→「提供状況を確認する」から進めてください。`,
      allowedMentions: { parse: [] },
    })
    .catch(() => undefined);
}

async function notifyRefundFailure(client: Client, services: Services, purchaseId: number): Promise<void> {
  const channelId = services.settings.getString("channel:shokan") ?? services.settings.getString("channel:kessai");
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) return;
  await channel
    .send({
      content: `⚠️ **返金に失敗しました**（購入 #${purchaseId}）。商館の管理パネル →「対応が必要」→「返金をやり直す」から進めてください。`,
      allowedMentions: { parse: [] },
    })
    .catch(() => undefined);
}
