import type { Client } from "discord.js";
import { describeRankSyncFailure, reconcileAltRank } from "./sub-account-rank.js";
import type { Services } from "./services.js";

/**
 * サブ垢の巡回。
 *
 * - 支払われないまま残った承認を畳む
 * - **サブ垢の階級を本体に追従させる**
 *
 * 追従の正本は本体の `souls.status`。Discord のロールを正本にすると、剥がし忘れた
 * ロールがそのまま資格になってしまう（旧商品#4で実際に資格外購入が成立した）。
 */

const ACTOR = "system:sub-account";

/** 承認から7日で支払いが無い申請を畳む */
export async function cancelUnpaidSubAccounts(client: Client, services: Services): Promise<void> {
  for (const row of services.subAccounts.listUnpaidApprovals()) {
    if (!services.subAccounts.cancelUnpaid(row.id, ACTOR)) continue;
    const user = await client.users.fetch(row.main_user_id).catch(() => null);
    await user
      ?.send(
        `⌛ サブ垢 <@${row.alt_user_id}> の申請は、承認から一定期間お支払いが無かったため取り消しました。改めて申請できます。`,
      )
      .catch(() => undefined);
  }
}

/**
 * サブ垢の階級を本体に合わせる。**成功判定は Discord の実状態で行う。**
 *
 * 剥奪に失敗したまま別の階級を足すと、サブ垢だけが2つの階級を持つ状態が固定される。
 * 剥がせなければそこで止め、失敗として残して次の巡回で再試行する。
 */
export async function syncSubAccountRanks(client: Client, services: Services): Promise<void> {
  const rows = services.subAccounts.listActive();
  if (rows.length === 0) return;
  const guildId = services.settings.getString("guild:main");
  const guild = guildId ? await client.guilds.fetch(guildId).catch(() => null) : null;
  if (!guild) return;

  for (const row of rows) {
    const alt = await guild.members.fetch(row.alt_user_id).catch(() => null);
    if (!alt) continue; // 抜けている。記録は触らず人の判断に残す
    const result = await reconcileAltRank(services, guild, alt, row.main_user_id);
    if (!result.ok) {
      // **合わせられていないものを「同期済み」にしない**
      services.events.log("sub_account_rank_sync_failed", {
        actor: ACTOR,
        target: row.main_user_id,
        payload: {
          id: row.id,
          altUserId: row.alt_user_id,
          wanted: result.wanted,
          detail: describeRankSyncFailure(result),
        },
      });
      continue;
    }
    if (!result.changed) continue;
    services.events.log("sub_account_rank_synced", {
      actor: ACTOR,
      target: row.main_user_id,
      payload: { id: row.id, altUserId: row.alt_user_id, wanted: result.wanted },
    });
  }
}
