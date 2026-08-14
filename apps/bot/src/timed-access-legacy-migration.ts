import type { Guild } from "discord.js";
import type { Shop, TimedAccessLegacyMigrationExpectation } from "@meigokujo/core";
import { timedAccessConfig } from "@meigokujo/core";

export interface TimedAccessLegacyExpectedItem {
  itemId: number;
  expectedCount: number;
}

/** main guildの現在member一覧を正本に、role保有者だけを移行候補入力へ変換する。 */
export async function collectTimedAccessLegacyExpectations(
  guild: Guild,
  shop: Shop,
  expectedItems: readonly TimedAccessLegacyExpectedItem[],
): Promise<TimedAccessLegacyMigrationExpectation[]> {
  const members = await guild.members.fetch();
  return expectedItems.map(({ itemId, expectedCount }) => {
    const item = shop.getItem(itemId);
    const access = item ? timedAccessConfig(item) : null;
    if (!item || !access) throw new Error(`timed_access_legacy:item_config_invalid:${itemId}`);
    const roleHolderIds = [...members.values()]
      .filter((member) => member.roles.cache.has(access.roleId))
      .map((member) => member.id)
      .sort();
    return { itemId, roleId: access.roleId, expectedCount, roleHolderIds };
  });
}
