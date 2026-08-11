import type { Client } from "discord.js";
import { parseDeliverySnapshot } from "@meigokujo/core";
import type { Services } from "./services.js";

const AUTODROP_PENDING_KEY = "autodrop:pending_role_sync";
let shopRoleRevocationInFlight = false;

interface AutoDropPending {
  userId: string;
  demoted: boolean;
  meireiAdded: boolean;
  ghostRemoved: boolean;
}

interface ExpiredRolePurchaseRow {
  purchase_id: number;
  user_id: string;
  delivery_snapshot_json: string | null;
  item_delivery: string;
  item_delivery_kind: string | null;
  item_delivery_data: string | null;
}

interface RoleMutableMember {
  roles: {
    cache: { has(roleId: string): boolean };
    add(roleId: string): Promise<unknown>;
    remove(roleId: string): Promise<unknown>;
  };
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

async function reconcileCancelledAutoDrop(
  member: RoleMutableMember,
  currentStatus: string | undefined,
  ghostRoleId: string,
  meireiRoleId: string,
): Promise<void> {
  if (member.roles.cache.has(meireiRoleId)) await member.roles.remove(meireiRoleId);
  if (currentStatus === "ghost" && !member.roles.cache.has(ghostRoleId)) await member.roles.add(ghostRoleId);
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

    let member: RoleMutableMember;
    try {
      member = await guild.members.fetch(row.userId);
    } catch (error) {
      if (isUnknownMember(error)) {
        row.meireiAdded = true;
        row.ghostRemoved = true;
        savePending(services, pending);
        continue;
      }
      failures.push(`member_fetch:${row.userId}:${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const statusAfterFetch = services.entry.getSoul(row.userId)?.status;
    if (statusAfterFetch !== "meirei") {
      try {
        await reconcileCancelledAutoDrop(member, statusAfterFetch, ghostRoleId, meireiRoleId);
        row.meireiAdded = true;
        row.ghostRemoved = true;
        savePending(services, pending);
      } catch (error) {
        failures.push(`rollback_cancelled:${row.userId}:${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }

    if (!row.meireiAdded) {
      const statusBeforeAdd = services.entry.getSoul(row.userId)?.status;
      if (statusBeforeAdd !== "meirei") {
        try {
          await reconcileCancelledAutoDrop(member, statusBeforeAdd, ghostRoleId, meireiRoleId);
          row.meireiAdded = true;
          row.ghostRemoved = true;
          savePending(services, pending);
        } catch (error) {
          failures.push(`rollback_before_add:${row.userId}:${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }

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

      const statusAfterAdd = services.entry.getSoul(row.userId)?.status;
      if (statusAfterAdd !== "meirei") {
        try {
          await reconcileCancelledAutoDrop(member, statusAfterAdd, ghostRoleId, meireiRoleId);
          row.meireiAdded = true;
          row.ghostRemoved = true;
          savePending(services, pending);
        } catch (error) {
          row.ghostRemoved = false;
          savePending(services, pending);
          failures.push(`rollback_after_add:${row.userId}:${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
    }

    const statusBeforeGhostRemoval = services.entry.getSoul(row.userId)?.status;
    if (statusBeforeGhostRemoval !== "meirei") {
      try {
        await reconcileCancelledAutoDrop(member, statusBeforeGhostRemoval, ghostRoleId, meireiRoleId);
        row.meireiAdded = true;
        row.ghostRemoved = true;
        savePending(services, pending);
      } catch (error) {
        row.ghostRemoved = false;
        savePending(services, pending);
        failures.push(`rollback_before_ghost_remove:${row.userId}:${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
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
          continue;
        }
      }

      const statusAfterGhostRemoval = services.entry.getSoul(row.userId)?.status;
      if (statusAfterGhostRemoval !== "meirei") {
        try {
          await reconcileCancelledAutoDrop(member, statusAfterGhostRemoval, ghostRoleId, meireiRoleId);
          row.meireiAdded = true;
          row.ghostRemoved = true;
          savePending(services, pending);
        } catch (error) {
          row.ghostRemoved = false;
          savePending(services, pending);
          failures.push(`rollback_after_ghost_remove:${row.userId}:${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  const remaining = pending.filter((row) => !(row.demoted && row.meireiAdded && row.ghostRemoved));
  savePending(services, remaining);
  if (dropped > 0) console.log(`[自動迷霊] ${dropped}名を落としました（フォーラム未作成・期限超過）`);
  if (failures.length > 0) throw new Error(`autodrop:role_sync_failed:${failures.join(",")}`);
}

function roleIdFromSnapshotOrItem(row: ExpiredRolePurchaseRow): { roleId?: string; error?: string; applicable: boolean } {
  const raw = row.delivery_snapshot_json;
  try {
    if (raw) {
      const snapshot = JSON.parse(raw) as { delivery_kind?: unknown; delivery_data?: unknown };
      if (snapshot.delivery_kind !== "add_role") return { applicable: false };
      if (typeof snapshot.delivery_data !== "string" || !snapshot.delivery_data) {
        return { applicable: true, error: "delivery_data_missing" };
      }
      const data = JSON.parse(snapshot.delivery_data) as { role_id?: unknown };
      return typeof data.role_id === "string" && data.role_id.trim()
        ? { applicable: true, roleId: data.role_id.trim() }
        : { applicable: true, error: "role_id_missing" };
    }

    if (row.item_delivery !== "auto" || row.item_delivery_kind !== "add_role") return { applicable: false };
    if (!row.item_delivery_data) return { applicable: true, error: "legacy_delivery_data_missing" };
    const data = JSON.parse(row.item_delivery_data) as { role_id?: unknown };
    return typeof data.role_id === "string" && data.role_id.trim()
      ? { applicable: true, roleId: data.role_id.trim() }
      : { applicable: true, error: "legacy_role_id_missing" };
  } catch (error) {
    return { applicable: true, error: error instanceof Error ? error.message : String(error) };
  }
}

export function backfillShopRoleRevocations(services: Pick<Services, "db">): void {
  const rows = services.db
    .prepare(
      `SELECT p.id AS purchase_id, p.user_id, p.delivery_snapshot_json,
              i.delivery AS item_delivery, i.delivery_kind AS item_delivery_kind, i.delivery_data AS item_delivery_data
       FROM shop_purchases p
       JOIN shop_items i ON i.id = p.item_id
       LEFT JOIN shop_role_revocations r ON r.purchase_id = p.id
       WHERE p.status = 'expired' AND r.purchase_id IS NULL`,
    )
    .all() as ExpiredRolePurchaseRow[];
  if (rows.length === 0) return;

  const insert = services.db.prepare(
    `INSERT OR IGNORE INTO shop_role_revocations
     (purchase_id, user_id, role_id, status, attempts, last_error, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const ts = Math.floor(Date.now() / 1000);
  services.db.transaction(() => {
    for (const row of rows) {
      const parsed = roleIdFromSnapshotOrItem(row);
      const status = !parsed.applicable ? "done" : parsed.roleId ? "pending" : "failed";
      const lastError = !parsed.applicable
        ? "backfill_not_applicable"
        : parsed.roleId
          ? null
          : `backfill_invalid_delivery:${parsed.error ?? "unknown"}`;
      insert.run(
        row.purchase_id,
        row.user_id,
        parsed.roleId ?? null,
        status,
        status === "failed" ? 1 : 0,
        lastError,
        ts,
        ts,
        status === "pending" ? null : ts,
      );
    }
  })();
}

/**
 * 期限切れの失効を巡回する。**自動課金は行わない**（月額の一括請求は廃止した）。
 *
 * `Shop.expireOverdue` が1件ずつ確定させるので、ここは呼ぶだけにしておく。
 * 外側でまとめてトランザクションを張ると、1件の失敗で全件が巻き戻る。
 */
export function expireOverduePurchases(services: Pick<Services, "shop">, actor: string) {
  return services.shop.expireOverdue(actor);
}

/**
 * 課金済みなのに終わっていない名前変更を収束させる。
 *
 * 課金と購入行は1トランザクションなので「払ったのに記録が無い」は起きない。
 * 起こりうるのは**課金後・変更前にBotが落ちる**ケースで、そのまま放置すると
 * 利用者は払っただけになる。ここで毎分、次のどれかへ必ず倒す:
 *
 * - 既に希望どおりの名前 … 完了にする（**返金しない**）
 * - まだ変わっていない … 変更をやり直す
 * - 変更できない … 返金する
 * - 返金もできない … `処理失敗` に残す（ここだけ人の出番）
 */
export async function convergePendingNicknameChanges(client: Client, services: Services): Promise<void> {
  const targets = services.shop.listUndeliveredAuto(20).filter((p) => {
    const snapshot = parseDeliverySnapshot(p.delivery_snapshot_json);
    return snapshot?.delivery_kind === "set_nickname";
  });
  if (targets.length === 0) return;
  // **静的importにしない。** `shop-delivery` の依存の先で `config.ts` が
  // 環境変数を検証して `process.exit(1)` するため、このモジュールを読むだけで
  // 落ちる環境（CIのユニットテスト）ができてしまう
  const { deliverPurchase } = await import("./shop-delivery.js");
  const guildId = services.settings.getString("guild:main");
  const guild = guildId ? await client.guilds.fetch(guildId).catch(() => null) : null;
  for (const purchase of targets) {
    const outcome = await deliverPurchase(services, guild, purchase, "system:shop-nickname");
    if (outcome.state !== "failed") continue;
    try {
      services.shop.refund(purchase.id, outcome.error ?? "delivery_failed", "system:shop-nickname");
      const user = await client.users.fetch(purchase.user_id).catch(() => null);
      await user
        ?.send(`🛒 名前の変更ができなかったため、**${(purchase.paid_land ?? 0).toLocaleString()} Ld** を返金しました。`)
        .catch(() => undefined);
    } catch (error) {
      services.events.log("shop_refund_failed", {
        actor: "system:shop-nickname",
        target: purchase.user_id,
        payload: { purchaseId: purchase.id, error: (error as Error).message },
      });
    }
  }
}

function markRoleRevocationDoneOnce(services: Services, purchaseId: number, reason: string): void {
  const ts = Math.floor(Date.now() / 1000);
  const updated = services.db
    .prepare(
      `UPDATE shop_role_revocations
       SET status='done', last_error=NULL, updated_at=?, completed_at=COALESCE(completed_at, ?)
       WHERE purchase_id=? AND status='pending'`,
    )
    .run(ts, ts, purchaseId);
  if (updated.changes === 1) {
    services.events.log("shop_role_revocation_done", {
      actor: "system:shop-role-revoke",
      payload: { purchaseId, reason },
    });
  }
}

function markRoleRevocationRetryOnce(services: Services, purchaseId: number, error: string): void {
  const ts = Math.floor(Date.now() / 1000);
  const normalized = error.slice(0, 500);
  const updated = services.db
    .prepare(
      `UPDATE shop_role_revocations
       SET attempts=attempts+1, last_error=?, updated_at=?
       WHERE purchase_id=? AND status='pending'`,
    )
    .run(normalized, ts, purchaseId);
  if (updated.changes === 1) {
    services.events.log("shop_role_revocation_retry", {
      actor: "system:shop-role-revoke",
      payload: { purchaseId, error: normalized },
    });
  }
}

/**
 * 失効済みadd_role商品のロール剥奪を、購入ID単位のDB pendingキューから再試行する。
 * 現在の商品設定ではなく購入時スナップショット由来のrole_idを使い、
 * 同じロールを正当に付与するactive購入があれば剥奪せず完了扱いにする。
 */
export async function processShopRoleRevocations(client: Client, services: Services): Promise<void> {
  if (shopRoleRevocationInFlight) return;
  shopRoleRevocationInFlight = true;
  try {
    backfillShopRoleRevocations(services);
    const pending = services.shop.pendingRoleRevocations();
    if (pending.length === 0) return;
    const guildId = services.settings.getString("guild:main");
    if (!guildId) throw new Error("shop_role_revoke:guild_id_missing");
    const guild = await client.guilds.fetch(guildId).catch((error) => {
      throw new Error(`shop_role_revoke:guild_fetch_failed:${error instanceof Error ? error.message : String(error)}`);
    });

    const failures: string[] = [];
    for (const candidate of pending) {
      if (!candidate.role_id) {
        markRoleRevocationRetryOnce(services, candidate.purchase_id, "role_id_missing");
        failures.push(`role_id_missing:${candidate.purchase_id}`);
        continue;
      }
      if (services.shop.activePurchaseGrantsRole(candidate.user_id, candidate.role_id, candidate.purchase_id)) {
        markRoleRevocationDoneOnce(services, candidate.purchase_id, "active_purchase_still_grants_role");
        continue;
      }

      let member;
      try {
        member = await guild.members.fetch(candidate.user_id);
      } catch (error) {
        if (isUnknownMember(error)) {
          markRoleRevocationDoneOnce(services, candidate.purchase_id, "member_absent");
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        markRoleRevocationRetryOnce(services, candidate.purchase_id, message);
        failures.push(`member_fetch:${candidate.purchase_id}:${message}`);
        continue;
      }

      if (!member.roles.cache.has(candidate.role_id)) {
        markRoleRevocationDoneOnce(services, candidate.purchase_id, "already_absent");
        continue;
      }

      try {
        await member.roles.remove(candidate.role_id);
        markRoleRevocationDoneOnce(services, candidate.purchase_id, "removed");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        markRoleRevocationRetryOnce(services, candidate.purchase_id, message);
        failures.push(`role_remove:${candidate.purchase_id}:${message}`);
      }
    }

    if (failures.length > 0) throw new Error(`shop_role_revocation_failed:${failures.join(",")}`);
  } finally {
    shopRoleRevocationInFlight = false;
  }
}
