import type { Client, Guild } from "discord.js";
import type { TimedAccessGrant } from "@meigokujo/core";
import type { Services } from "./services.js";

export interface TimedAccessReconcileResult {
  checked: number;
  restored: number;
  absent: number;
  failed: Array<{ userId: string; roleId: string; error: string }>;
}

const emptyResult = (): TimedAccessReconcileResult => ({ checked: 0, restored: 0, absent: 0, failed: [] });

function errorCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = Number((error as { code?: unknown }).code);
  return Number.isFinite(code) ? code : undefined;
}

/**
 * Discordへの操作は (利用者, ロール) 単位で1回でよいので、契約をそこへ畳む。
 *
 * **畳んだ結果の `purchase` は「代表」でしかない。** 同じロールを与える有効な契約が
 * 複数あると、`Map.set` の後勝ちで **id が最大の購入**だけが残る。ロールの付与は1回
 * なので、それが「どの購入の効果か」はここでは決まらない。
 *
 * したがって代表の `purchase.id` は、
 *   - Discordへ何をするか決めるため（同じロールを二度付けない）
 * には使ってよいが、
 *   - **どの購入が提供済みかの証拠**
 * には使ってはいけない。証拠を残すときは別途、帰属が一意であることを確かめる
 * （`timedAccessAttributionUnique()`）。
 */
function uniqueGrants(grants: TimedAccessGrant[]): TimedAccessGrant[] {
  const unique = new Map<string, TimedAccessGrant>();
  for (const grant of grants) unique.set(`${grant.purchase.user_id}:${grant.roleId}`, grant);
  return [...unique.values()];
}

/**
 * 有効な期限付きアクセス契約をDiscordへ収束させる。
 *
 * role addの直前と直後に契約を再確認する。期限切れ処理と競合して古い一覧からaddした場合は、
 * activeな別契約が無いことを確かめて自分で剥がし、expiredなのにロールだけ残す順序を作らない。
 */
async function reconcileTimedAccessRoles(
  guild: Guild,
  services: Pick<Services, "shop" | "events">,
  userId?: string,
): Promise<TimedAccessReconcileResult> {
  const result: TimedAccessReconcileResult = { checked: 0, restored: 0, absent: 0, failed: [] };
  for (const grant of uniqueGrants(services.shop.listActiveTimedAccess(userId))) {
    const target = grant.purchase.user_id;
    result.checked += 1;
    let member;
    try {
      member = await guild.members.fetch({ user: target, force: true });
    } catch (error) {
      if (errorCode(error) === 10007) {
        result.absent += 1;
        continue;
      }
      const message = `member_fetch_failed:${error instanceof Error ? error.message : String(error)}`;
      result.failed.push({ userId: target, roleId: grant.roleId, error: message });
      services.events.log("shop_timed_access_reconcile_failed", {
        actor: "system:shop-timed-access",
        target,
        payload: { purchaseId: grant.purchase.id, roleId: grant.roleId, error: message },
      });
      continue;
    }

    let added = false;
    try {
      if (!member.roles.cache.has(grant.roleId)) {
        // 一覧取得後に失効していたらDiscordへ触らない。
        if (!services.shop.activeTimedAccessGrantsRole(target, grant.roleId)) continue;
        await member.roles.add(grant.roleId, "有効な期限付きアクセス契約の復元");
        added = true;
        member = await guild.members.fetch({ user: target, force: true });
      }

      // addと失効が競合した場合、古い処理が付けたロールを残さない。
      if (!services.shop.activeTimedAccessGrantsRole(target, grant.roleId)) {
        if (member.roles.cache.has(grant.roleId)) {
          await member.roles.remove(grant.roleId, "期限付きアクセス契約の失効を確認");
          const settled = await guild.members.fetch({ user: target, force: true });
          if (settled.roles.cache.has(grant.roleId)) throw new Error("stale_role_remained");
        }
        continue;
      }
      if (!member.roles.cache.has(grant.roleId)) throw new Error("role_missing_after_add");

      services.shop.markDeliverySucceeded(grant.purchase.id, "system:shop-timed-access");
      // 成功印の直前に失効が割り込んだ場合も、古い巡回が権利を残さない。
      if (!services.shop.activeTimedAccessGrantsRole(target, grant.roleId)) {
        if (member.roles.cache.has(grant.roleId)) {
          await member.roles.remove(grant.roleId, "期限付きアクセス契約の失効を確認");
          const settled = await guild.members.fetch({ user: target, force: true });
          if (settled.roles.cache.has(grant.roleId)) throw new Error("stale_role_remained_after_settle");
        }
        continue;
      }
      if (added) {
        result.restored += 1;
        // **ここまで来たものだけが「外部効果の成立を確認できた」と言える。**
        //   1. 最初のforce fetchでロールが**無かった**
        //   2. 付ける直前にも契約がactiveだった
        //   3. 自分で `roles.add()` を成功させた
        //   4. force refetchで在席を**再確認**した
        //   5. 失効競合のチェックを通過した
        //
        // `added=false`（元からロールがあった）はここへ来ない。**ロールの起源を
        // 証明していない**ので、提供済みの証拠にも未提供の証拠にもしない。
        //
        // 最後に帰属を確かめる。同じロールを与える有効な契約が他にもあるなら、
        // この1回の付与が**どの購入の効果か**を証明できないので何も書かない。
        // 返金拒否に使う authority なので、曖昧なら安全側へ倒す。
        if (services.shop.timedAccessAttributionUnique(grant.purchase.id, target, grant.roleId)) {
          services.shop.recordVerifiedDeliveryEvidence({
            purchaseId: grant.purchase.id,
            source: "timed_access_role_added_and_refetched",
            writer: "system:shop-timed-access",
            effectTarget: grant.roleId,
            detail: { itemId: grant.item.id, verification: "force_refetch_role_present" },
          });
        }
        services.events.log("shop_timed_access_restored", {
          actor: "system:shop-timed-access",
          target,
          payload: { purchaseId: grant.purchase.id, itemId: grant.item.id, roleId: grant.roleId },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      services.shop.markDeliveryFailed(grant.purchase.id, `timed_access_reconcile:${message}`, "system:shop-timed-access");
      result.failed.push({ userId: target, roleId: grant.roleId, error: message });
      services.events.log("shop_timed_access_reconcile_failed", {
        actor: "system:shop-timed-access",
        target,
        payload: { purchaseId: grant.purchase.id, roleId: grant.roleId, error: message },
      });
    }
  }
  return result;
}

export async function reconcileTimedAccessForClient(
  client: Client,
  services: Pick<Services, "shop" | "settings" | "events">,
  userId?: string,
): Promise<TimedAccessReconcileResult> {
  const guildId = services.settings.getString("guild:main");
  if (!guildId) throw new Error("shop_timed_access:guild_id_missing");
  const guild = await client.guilds.fetch(guildId);
  return reconcileTimedAccessForGuild(guild, services, userId);
}

/** 起動時・再参加時とも、設定上のmain guild以外ではDiscordを一切読まない。 */
export async function reconcileTimedAccessForGuild(
  guild: Guild,
  services: Pick<Services, "shop" | "settings" | "events">,
  userId?: string,
): Promise<TimedAccessReconcileResult> {
  const guildId = services.settings.getString("guild:main");
  if (!guildId || guild.id !== guildId) return emptyResult();
  return reconcileTimedAccessRoles(guild, services, userId);
}
