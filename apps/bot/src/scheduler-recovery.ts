import type { Client } from "discord.js";
import type { Services } from "./services.js";

const AUTODROP_PENDING_KEY = "autodrop:pending_role_sync";

interface AutoDropPending {
  userId: string;
  demoted: boolean;
  meireiAdded: boolean;
  ghostRemoved: boolean;
}

function errorCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = Number((error as { code?: unknown }).code);
  return Number.isFinite(code) ? code : undefined;
}

function isUnknownMember(error: unknown): boolean {
  return errorCode(error) === 10007;
}

function readPending(services: Pick<Services, "settings">): AutoDropPending[] {
  const raw = services.settings.getString(AUTODROP_PENDING_KEY) as unknown;
  if (!raw) return [];
  try {
    const parsed = Array.isArray(raw) ? raw : typeof raw === "string" ? JSON.parse(raw) as unknown : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value) => {
      if (typeof value !== "object" || value === null) return [];
      const row = value as Partial<AutoDropPending>;
      if (typeof row.userId !== "string") return [];
      return [{
        userId: row.userId,
        demoted: row.demoted === true,
        meireiAdded: row.meireiAdded === true,
        ghostRemoved: row.ghostRemoved === true,
      }];
    });
  } catch {
    return [];
  }
}

function savePending(services: Pick<Services, "settings">, pending: AutoDropPending[]): void {
  services.settings.set(AUTODROP_PENDING_KEY, pending, "system:auto-drop");
}

/**
 * 自動迷霊化とDiscordロール同期を、再起動後も続けられる永続キューとして処理する。
 * 全迷霊を毎日なめず、新規対象と前回失敗分だけを扱う。
 */
export async function recoverAutoDropNoEvalGhosts(client: Client, services: Services): Promise<void> {
  const nowTs = Math.floor(Date.now() / 1000);
  const ghosts = services.entry.listSouls("ghost");
  const meireiIds = new Set(services.entry.listSouls("meirei").map((s) => s.user_id));
  const ghostIds = new Set(ghosts.map((s) => s.user_id));
  const pending = readPending(services);
  const byUser = new Map(pending.map((row) => [row.userId, row]));

  for (const soul of ghosts) {
    if (!soul.eval_deadline_at || soul.eval_deadline_at > nowTs) continue;
    if (services.evaluation.threadFor(soul.user_id)) continue;
    if (!byUser.has(soul.user_id)) {
      const row: AutoDropPending = {
        userId: soul.user_id,
        demoted: false,
        meireiAdded: false,
        ghostRemoved: false,
      };
      pending.push(row);
      byUser.set(row.userId, row);
    }
  }

  if (pending.length === 0) return;

  const ghostRoleId = services.settings.getString("role:ghost");
  const meireiRoleId = services.settings.getString("role:meirei");
  if (!ghostRoleId || !meireiRoleId) {
    savePending(services, pending);
    throw new Error("autodrop:required_roles_missing");
  }

  savePending(services, pending);
  let dropped = 0;

  for (const row of pending) {
    if (row.demoted) continue;
    if (meireiIds.has(row.userId)) {
      row.demoted = true;
      savePending(services, pending);
      continue;
    }
    if (!ghostIds.has(row.userId)) {
      // 魂台帳から消えた、または別状態へ移った対象は同期不要として除去する。
      row.demoted = true;
      row.meireiAdded = true;
      row.ghostRemoved = true;
      savePending(services, pending);
      continue;
    }
    services.evaluation.demoteToMeirei(
      row.userId,
      "system:auto-drop",
      "14日以内に評価が付かなかった（フォーラム未作成）",
    );
    row.demoted = true;
    meireiIds.add(row.userId);
    ghostIds.delete(row.userId);
    dropped++;
    savePending(services, pending);
  }

  const guildId = services.settings.getString("guild:main");
  if (!guildId) throw new Error("autodrop:guild_id_missing");
  const guild = await client.guilds.fetch(guildId).catch((error) => {
    throw new Error(`autodrop:guild_fetch_failed:${error instanceof Error ? error.message : String(error)}`);
  });

  const failures: string[] = [];
  for (const row of [...pending]) {
    if (!row.demoted || (row.meireiAdded && row.ghostRemoved)) continue;

    let member;
    try {
      member = await guild.members.fetch(row.userId);
    } catch (error) {
      if (isUnknownMember(error)) {
        // 退城済みならDiscord側で剥がすロールがないため完了。
        row.meireiAdded = true;
        row.ghostRemoved = true;
        savePending(services, pending);
        continue;
      }
      failures.push(`member_fetch:${row.userId}:${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    if (!row.meireiAdded) {
      if (member.roles.cache.has(meireiRoleId)) {
        row.meireiAdded = true;
        savePending(services, pending);
      } else {
        try {
          await member.roles.add(meireiRoleId);
          row.meireiAdded = true;
          savePending(services, pending);
        } catch (error) {
          failures.push(`add_meirei:${row.userId}:${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
      }
    }

    if (!row.ghostRemoved) {
      if (!member.roles.cache.has(ghostRoleId)) {
        row.ghostRemoved = true;
        savePending(services, pending);
      } else {
        try {
          await member.roles.remove(ghostRoleId);
          row.ghostRemoved = true;
          savePending(services, pending);
        } catch (error) {
          failures.push(`remove_ghost:${row.userId}:${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  const remaining = pending.filter((row) => !(row.demoted && row.meireiAdded && row.ghostRemoved));
  savePending(services, remaining);
  if (dropped > 0) console.log(`[自動迷霊] ${dropped}名を落としました（フォーラム未作成・期限超過）`);
  if (failures.length > 0) throw new Error(`autodrop:role_sync_failed:${failures.join(",")}`);
}

/**
 * 失効済みのadd_role商品を購入履歴から再発見し、購入ID単位でロール剥奪を完了させる。
 * 月次請求とDiscord操作を分離するため、Bot再起動後でも回収できる。
 */
export async function processShopRoleRevocations(client: Client, services: Services): Promise<void> {
  const candidates: Array<{ purchaseId: number; userId: string; roleId: string }> = [];
  const pageSize = 100;

  for (let offset = 0; ; offset += pageSize) {
    const purchases = services.shop.listRecentPurchases(pageSize, offset);
    for (const purchase of purchases) {
      if (purchase.status !== "expired") continue;
      if (services.settings.getString(`shop:role_revoked:${purchase.id}`)) continue;
      const item = services.shop.getItem(purchase.item_id);
      if (!item || item.delivery_kind !== "add_role" || !item.delivery_data) continue;
      let roleId: string | undefined;
      try {
        const data = JSON.parse(item.delivery_data) as { role_id?: unknown };
        if (typeof data.role_id === "string" && data.role_id.length > 0) roleId = data.role_id;
      } catch {
        throw new Error(`shop_role_revoke:invalid_delivery_data:${purchase.id}`);
      }
      if (!roleId) throw new Error(`shop_role_revoke:role_id_missing:${purchase.id}`);
      candidates.push({ purchaseId: purchase.id, userId: purchase.user_id, roleId });
    }
    if (purchases.length < pageSize) break;
  }

  if (candidates.length === 0) return;
  const guildId = services.settings.getString("guild:main");
  if (!guildId) throw new Error("shop_role_revoke:guild_id_missing");
  const guild = await client.guilds.fetch(guildId).catch((error) => {
    throw new Error(`shop_role_revoke:guild_fetch_failed:${error instanceof Error ? error.message : String(error)}`);
  });

  const failures: string[] = [];
  for (const candidate of candidates) {
    const marker = `shop:role_revoked:${candidate.purchaseId}`;
    if (services.settings.getString(marker)) continue;

    let member;
    try {
      member = await guild.members.fetch(candidate.userId);
    } catch (error) {
      if (isUnknownMember(error)) {
        services.settings.set(marker, "member_absent", "system:shop-role-revoke");
        continue;
      }
      failures.push(`member_fetch:${candidate.purchaseId}:${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    if (!member.roles.cache.has(candidate.roleId)) {
      services.settings.set(marker, "already_absent", "system:shop-role-revoke");
      continue;
    }

    try {
      await member.roles.remove(candidate.roleId);
      services.settings.set(marker, "removed", "system:shop-role-revoke");
    } catch (error) {
      failures.push(`role_remove:${candidate.purchaseId}:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) throw new Error(`shop_role_revoke:failed:${failures.join(",")}`);
}
