import type { Client } from "discord.js";
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

/**
 * 失効済みでキュー行が無い購入へ、剥奪キューを後から作る。
 *
 * **剥奪対象はCoreの `roleGrantTarget()` が唯一のauthority。** 以前はここで
 * 購入時スナップショットが無い行について現在の `shop_items.delivery_data` へ
 * fallback していた。それだと運営が商品のロール設定を R1 から R2 へ変えただけで、
 * 過去の購入から **与えた証拠の無い R2** を剥がすキューが生える。
 *
 * 対象を証明できない行・提供した証拠が無い行はキューに載せない。消えるわけではなく、
 * `listUnresolvedExpiryRevocations()` で運営に見える。
 */
export function backfillShopRoleRevocations(services: Pick<Services, "db" | "shop">): void {
  const rows = services.db
    .prepare(
      `SELECT p.id
         FROM shop_purchases p
         LEFT JOIN shop_role_revocations r ON r.purchase_id = p.id
        WHERE p.status = 'expired' AND r.purchase_id IS NULL`,
    )
    .all() as Array<{ id: number }>;
  if (rows.length === 0) return;

  const insert = services.db.prepare(
    `INSERT OR IGNORE INTO shop_role_revocations
     (purchase_id, user_id, role_id, status, attempts, last_error, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const ts = Math.floor(Date.now() / 1000);
  services.db.transaction(() => {
    for (const row of rows) {
      const purchase = services.shop.getPurchase(row.id);
      if (!purchase) continue;
      const target = services.shop.roleGrantTarget(purchase);
      if (target.kind === "proven_non_role") {
        // ロールを与える契約ではなかった。剥がす物が無いので完了として畳む。
        insert.run(row.id, purchase.user_id, null, "done", 0, "backfill_not_applicable", ts, ts, ts);
        continue;
      }
      if (target.kind !== "proven" || !services.shop.roleRevocationTargetProven(row.id, target.roleId)) {
        // 対象を証明できない、あるいは提供した証拠が無い。**キューへ載せない。**
        continue;
      }
      insert.run(row.id, purchase.user_id, target.roleId, "pending", 0, null, ts, ts, null);
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
  // **絞り込みを DB 側へ渡す。** 上限20件を取ってから種別で filter すると、
  // 他種別の失敗が20件溜まっただけで名前変更が1件も拾えなくなり、
  // 「払ったのに変わらない」が巡回では二度と解けなくなる
  const targets = services.shop.listUndeliveredAuto(20, { kinds: ["set_nickname"] });
  if (targets.length === 0) return;
  // **静的importにしない。** `shop-refund` の依存の先で `config.ts` が
  // 環境変数を検証して `process.exit(1)` するため、このモジュールを読むだけで
  // 落ちる環境（CIのユニットテスト）ができてしまう
  const { deliverOrRefund } = await import("./shop-refund.js");
  const guildId = services.settings.getString("guild:main");
  const guild = guildId ? await client.guilds.fetch(guildId).catch(() => null) : null;
  for (const purchase of targets) {
    // 配送→駄目なら返金まで。返金も失敗したら管理パネルを更新してスタッフへ知らせる
    const { refund } = await deliverOrRefund(client, services, guild, purchase, "system:shop-nickname");
    if (refund !== "refunded") continue;
    // 知らせに失敗しても収束は済んでいる。次の購入の処理まで巻き込まない
    try {
      const user = await client.users.fetch(purchase.user_id).catch(() => null);
      await user?.send(
        `🛒 名前の変更ができなかったため、**${(purchase.paid_land ?? 0).toLocaleString()} Ld** を返金しました。`,
      );
    } catch {
      /* DMが閉じている・届かない。返金は済んでいるので、ここで止めない */
    }
  }
}

/**
 * 剥奪対象を購入時の事実で裏付けられない行を、安全側へ畳む。
 *
 * `pending` のまま残すと毎分Discordへ触ろうとし続ける。かといって `done` にすると
 * 「対応済み」に見えてしまう。`failed` へ置いて理由を残し、運営の確認待ちにする。
 * **Discordには一切触らない。**
 */
/**
 * 判断を次の巡回へ持ち越す。**status は変えない。**
 *
 * 同じロールを与える新しい購入が「まだ提供されたか分からない」状態のとき、
 * ロールは剥がさない。かといって古い失効を done にもしない——その購入が後で
 * 返金されると、有効な契約が無いのにロールだけ残る。決着がつくまで待つ。
 */
function markRoleRevocationDeferred(services: Services, purchaseId: number, reason: string): void {
  const ts = Math.floor(Date.now() / 1000);
  services.db
    .prepare(
      "UPDATE shop_role_revocations SET last_error=?, updated_at=? WHERE purchase_id=? AND status='pending'",
    )
    .run(`deferred:${reason}`, ts, purchaseId);
}

function markRoleRevocationBlocked(services: Services, purchaseId: number, reason: string): void {
  const ts = Math.floor(Date.now() / 1000);
  const updated = services.db
    .prepare(
      `UPDATE shop_role_revocations
       SET status='failed', last_error=?, updated_at=?, completed_at=COALESCE(completed_at, ?)
       WHERE purchase_id=? AND status='pending'`,
    )
    .run(`blocked:${reason}`, ts, ts, purchaseId);
  if (updated.changes === 1) {
    services.events.log("shop_role_revocation_blocked", {
      actor: "system:shop-role-revocation",
      payload: { purchaseId, reason },
    });
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
let externalDeliveryRecoveryInFlight = false;

/**
 * 決着していない外部配送を収束させる。
 *
 * 再起動を跨いで残った claim（`in_flight` / `uncertain`）は、「Discordへ投げたが
 * 結果が分からない」購入そのもの。**推測で返金も剥奪もしない。** Discordの実状態を
 * force fetch で確かめ、利用者が契約した目的状態が成立しているなら配送済みへ収束させ、
 * 成立していないなら claim だけ解放して通常の再試行へ戻す。
 *
 * **ロールは1つも剥がさない。** ここは「与えたかもしれないものを確認する」処理であって、
 * 取り上げる処理ではない。別契約で同じロールを持っている場合もあるので、
 * この購入が付けたと証明できないロールに触れてはいけない。
 */
export async function convergeExternalDeliveries(client: Client, services: Services): Promise<void> {
  if (externalDeliveryRecoveryInFlight) return;
  externalDeliveryRecoveryInFlight = true;
  try {
    const open = services.shop.listUnresolvedExternalDeliveries();
    if (open.length === 0) return;
    const guildId = services.settings.getString("guild:main");
    if (!guildId) return;
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;

    for (const claim of open) {
      // 収束できるのは add_role だけ。ほかの種別は「何が目的状態か」を外から
      // 確かめる手段が無いので、運営が見る対象として残す。
      if (claim.delivery_kind !== "add_role") continue;
      const purchase = services.shop.getPurchase(claim.purchase_id);
      if (!purchase) continue;

      // **購入時の対象ロールだけを使う。** 現在の商品設定は見ない（Phase E）。
      const target = services.shop.roleGrantTarget(purchase);
      if (target.kind !== "proven") continue;
      const roleId = target.roleId;

      const member = await guild.members.fetch({ user: purchase.user_id, force: true }).catch(() => null);
      if (!member) continue; // 確かめられない。claim は残したまま人へ

      if (member.roles.cache.has(roleId)) {
        // 利用者が契約した目的状態は成立している。配送済みへ収束させる。
        // status が動いていれば settle は false を返す——その場合も claim は
        // uncertain のまま残り、自動返金はされない。
        if (
          !services.shop.settleExternalDelivery({
            purchaseId: claim.purchase_id,
            token: claim.attempt_token,
            actor: "system:shop-external-delivery",
          })
        ) {
          services.shop.markExternalDeliveryUncertain({
            purchaseId: claim.purchase_id,
            token: claim.attempt_token,
            reason: "role_present_but_purchase_not_active",
            actor: "system:shop-external-delivery",
          });
        }
        continue;
      }

      // ロールが無いことを確かめられた＝副作用は残っていない。
      // まだ active なら claim を解放して通常の再試行へ戻す。**返金はしない。**
      if (purchase.status === "active") {
        services.shop.releaseExternalDelivery({
          purchaseId: claim.purchase_id,
          token: claim.attempt_token,
          reason: "verified_no_effect",
          actor: "system:shop-external-delivery",
        });
        continue;
      }
      // active でないのにロールも無い。剥がすものも与えるものも無いので解放してよい。
      services.shop.releaseExternalDelivery({
        purchaseId: claim.purchase_id,
        token: claim.attempt_token,
        reason: `verified_no_effect:${purchase.status}`,
        actor: "system:shop-external-delivery",
      });
    }
  } finally {
    externalDeliveryRecoveryInFlight = false;
  }
}

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
      const roleId = candidate.role_id;

      // **Discordへ触る前に、保存済みの対象が購入時の事実として裏付くかを毎回確かめる。**
      // 古いキュー行は現在の商品設定から作られている可能性がある（Phase E以前）。
      // 証明できないものは実行しない。毎分retryし続けないよう blocked として畳む。
      if (!services.shop.roleRevocationTargetProven(candidate.purchase_id, roleId)) {
        markRoleRevocationBlocked(services, candidate.purchase_id, "target_unproven");
        continue;
      }

      // 前回このworkerが roles.remove() を呼びにいったかもしれない行かどうか。
      // **立っていれば、有効な契約があっても Discord の実体を見るまで done にしない。**
      const mayHaveRemoved = services.shop.roleRevocationRemoveAttempted(candidate.purchase_id);
      const entitlement = () =>
        services.shop.activeRoleEntitlementState(candidate.user_id, roleId, candidate.purchase_id);

      // 同じロールを与える有効な別契約があるなら剥がさない。判断は購入時の事実だけで行う。
      if (!mayHaveRemoved) {
        const state = entitlement();
        if (state === "delivered") {
          markRoleRevocationDoneOnce(services, candidate.purchase_id, "active_purchase_still_grants_role");
          continue;
        }
        if (state === "unsettled") {
          // 新しい購入が提供されたか未確定。剥がさないし、完了にもしない。
          markRoleRevocationDeferred(services, candidate.purchase_id, "active_purchase_unsettled");
          continue;
        }
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

      /**
       * 有効な契約があるのに role が無い状態を残さない。**戻し切れたかどうかだけを返す。**
       * done にするか持ち越すかは、戻す理由（`delivered` / `unsettled`）で呼び側が決める。
       */
      const restoreRole = async (): Promise<boolean> => {
        if (member.roles.cache.has(roleId)) return true;
        try {
          await member.roles.add(roleId);
          const confirmed = await guild.members.fetch({ user: candidate.user_id, force: true });
          if (!confirmed.roles.cache.has(roleId)) throw new Error("rollback_not_confirmed");
          services.events.log("shop_role_revocation_rolled_back", {
            actor: "system:shop-role-revocation",
            target: candidate.user_id,
            payload: { purchaseId: candidate.purchase_id },
          });
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          markRoleRevocationRetryOnce(services, candidate.purchase_id, `rollback_failed:${message}`);
          failures.push(`rollback:${candidate.purchase_id}:${message}`);
          return false;
        }
      };

      /**
       * ロールを戻してから、守っている契約の強さで決着をつける。
       *
       * - `delivered` … 提供済みの契約が守っている。この失効はもう役目を終えた → done
       * - `unsettled` … 提供されたか未確定。**戻すが done にはしない**。Bが提供されれば
       *   次の巡回で done、Bが返金されれば次の巡回で改めて剥がす
       *
       * **戻し切れなければどちらでも done にしない。** 次の巡回でやり直す。
       */
      const restoreThenSettle = async (state: "delivered" | "unsettled"): Promise<void> => {
        if (!(await restoreRole())) return;
        if (state === "delivered") {
          markRoleRevocationDoneOnce(services, candidate.purchase_id, "active_purchase_still_grants_role");
          return;
        }
        markRoleRevocationDeferred(services, candidate.purchase_id, "active_purchase_unsettled");
      };

      // 再起動やrollback失敗で持ち越した行。有効な契約があるなら、まず実体を収束させる。
      // **ここも3状態で見る。** `unsettled` を素通りさせると、下の `already_absent` が
      // 「自分が外したロール」を戻さないまま done にしてしまう（remove直後に落ちた場合）。
      if (mayHaveRemoved) {
        const carried = entitlement();
        if (carried !== "none") {
          await restoreThenSettle(carried);
          continue;
        }
      }

      if (!member.roles.cache.has(roleId)) {
        markRoleRevocationDoneOnce(services, candidate.purchase_id, "already_absent");
        continue;
      }

      // **剥がす直前にもう一度確かめる。** ここまでの間（member fetchのawait中）に
      // 新しい契約が成立していると、新しい権利のロールを古い失効が剥がしてしまう。
      const beforeRemove = entitlement();
      if (beforeRemove === "delivered") {
        markRoleRevocationDoneOnce(services, candidate.purchase_id, "active_purchase_still_grants_role");
        continue;
      }
      if (beforeRemove === "unsettled") {
        markRoleRevocationDeferred(services, candidate.purchase_id, "active_purchase_unsettled");
        continue;
      }

      // **呼ぶ前にDBへ残す。** 呼んだ直後に落ちても、次回「自分が外したかもしれない」
      // と分かるようにする（メモリ上のフラグでは落ちた瞬間に消える）。
      services.shop.markRoleRevocationRemoveAttempt(candidate.purchase_id);
      try {
        await member.roles.remove(roleId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        markRoleRevocationRetryOnce(services, candidate.purchase_id, message);
        failures.push(`role_remove:${candidate.purchase_id}:${message}`);
        continue;
      }

      // **剥がした直後にも確かめる。** 剥がしている最中に新しい契約が生えていたら、
      // 自分が消したロールを戻す。戻し切れるまでこの失効を done にしない。
      // **`delivered` だけを見てはいけない。** `roles.remove()` のawait中に生えた
      // 未配送の契約（`unsettled`）を無視すると、race のときだけ
      // 「剥がさない / done にしない」という契約を破る。
      const afterRemove = entitlement();
      if (afterRemove !== "none") {
        await restoreThenSettle(afterRemove);
        continue;
      }

      markRoleRevocationDoneOnce(services, candidate.purchase_id, "removed");
    }

    if (failures.length > 0) throw new Error(`shop_role_revocation_failed:${failures.join(",")}`);
  } finally {
    shopRoleRevocationInFlight = false;
  }
}

/**
 * 課金済みなのに始まっていないオリジナルロールを収束させる。
 *
 * 名前変更と同じ形。**課金 → Discordロール作成 → 契約開始** の途中で落ちると、
 * 利用者は払っただけになる。ここで毎分、作れるなら作りきり、作れないなら返す。
 * 作りかけのロールを見失わない仕組みは `resolveOriginalRole`（配送側）が持つ。
 */
export async function convergePendingOriginalRoles(client: Client, services: Services): Promise<void> {
  // 絞り込みは limit より先に効かせる（他種別の失敗で埋まると収束が止まる）
  const targets = services.shop.listUndeliveredAuto(20, { kinds: ["create_original_role"] });
  if (targets.length === 0) return;
  const { deliverOrRefund } = await import("./shop-refund.js");
  const guildId = services.settings.getString("guild:main");
  const guild = guildId ? await client.guilds.fetch(guildId).catch(() => null) : null;
  for (const purchase of targets) {
    const { refund } = await deliverOrRefund(client, services, guild, purchase, "system:shop-original-role");
    if (refund !== "refunded") continue;
    try {
      const user = await client.users.fetch(purchase.user_id).catch(() => null);
      await user?.send(
        `🛒 オリジナルロールを作成できなかったため、**${(purchase.paid_land ?? 0).toLocaleString()} Ld** を返金しました。`,
      );
    } catch {
      /* DMが閉じている。返金は済んでいるので、ここで止めない */
    }
  }
}

/**
 * 課金済みなのに有効化されていないサブ垢を収束させる。
 * 有効化できるならやりきり、できないなら返金する（返金も駄目なときだけ人へ）。
 */
export async function convergePendingSubAccounts(client: Client, services: Services): Promise<void> {
  const targets = services.shop.listUndeliveredAuto(20, { kinds: ["activate_sub_account"] });
  if (targets.length === 0) return;
  const { deliverOrRefund } = await import("./shop-refund.js");
  const guildId = services.settings.getString("guild:main");
  const guild = guildId ? await client.guilds.fetch(guildId).catch(() => null) : null;
  for (const purchase of targets) {
    const { refund } = await deliverOrRefund(client, services, guild, purchase, "system:shop-sub-account");
    if (refund !== "refunded") continue;
    try {
      const user = await client.users.fetch(purchase.user_id).catch(() => null);
      await user?.send(
        `🛒 サブ垢を有効化できなかったため、**${(purchase.paid_land ?? 0).toLocaleString()} Ld** を返金しました。`,
      );
    } catch {
      /* DMが閉じている。返金は済んでいるので、ここで止めない */
    }
  }
}
