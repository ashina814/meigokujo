import type { Client } from "discord.js";
import { RANK_ROLE_SETTING_KEYS, roleToRestoreForStatus, type LadderRank } from "@meigokujo/core";
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

/** 本体の階級に対応するロールID（対象外なら null） */
export function rankRoleIdForStatus(services: Services, mainUserId: string): string | null {
  const rank = roleToRestoreForStatus(services.entry.getSoul(mainUserId)?.status ?? null);
  if (!rank) return null;
  const key = RANK_ROLE_SETTING_KEYS[rank as LadderRank];
  return key ? (services.settings.getString(key) ?? null) : null;
}

/**
 * サブ垢の階級を本体に合わせる。
 *
 * 本体が昇格すればサブ垢も上がり、降格すれば下がる。本体が迷霊・離脱になったら
 * **階級ロールをすべて外す**（サブ垢だけが特権を持ち続けるのを防ぐ）。
 * ここは毎回の巡回で同じ結果に収束するように書く（差分だけを当てる）。
 */
export async function syncSubAccountRanks(client: Client, services: Services): Promise<void> {
  const rows = services.subAccounts.listActive();
  if (rows.length === 0) return;
  const guildId = services.settings.getString("guild:main");
  const guild = guildId ? await client.guilds.fetch(guildId).catch(() => null) : null;
  if (!guild) return;
  const ladderRoleIds = Object.values(RANK_ROLE_SETTING_KEYS)
    .map((key) => services.settings.getString(key))
    .filter((id): id is string => !!id);

  for (const row of rows) {
    const alt = await guild.members.fetch(row.alt_user_id).catch(() => null);
    if (!alt) continue; // 抜けている。ここでは記録を触らない（人の判断に残す）
    const wanted = rankRoleIdForStatus(services, row.main_user_id);
    const toRemove = ladderRoleIds.filter((id) => id !== wanted && alt.roles.cache.has(id));
    for (const id of toRemove) {
      await alt.roles.remove(id, "サブ垢: 本体の階級に合わせる").catch(() => undefined);
    }
    if (wanted && !alt.roles.cache.has(wanted)) {
      await alt.roles.add(wanted, "サブ垢: 本体の階級に合わせる").catch(() => undefined);
    }
    if (toRemove.length > 0 || (wanted && !alt.roles.cache.has(wanted))) {
      services.events.log("sub_account_rank_synced", {
        actor: ACTOR,
        target: row.main_user_id,
        payload: { id: row.id, altUserId: row.alt_user_id, wanted, removed: toRemove },
      });
    }
  }
}
