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
