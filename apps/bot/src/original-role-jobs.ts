import type { Client } from "discord.js";
import { ORIGINAL_ROLE_NOTICE_DAYS, ORIGINAL_ROLE_TERM_DAYS } from "@meigokujo/core";
import { fmtLd } from "./format.js";
import type { Services } from "./services.js";

/**
 * オリジナルロールの期限まわり（毎分の巡回から呼ぶ）。
 *
 * 通知は**知らせるだけ**で、業務の正本は `original_roles` の状態。
 * 通知が届かなくても、期限切れの剥奪は状態から必ず実行される。
 */

/** 期限3日前に本人へ知らせる。**一度だけ** */
export async function notifyExpiringOriginalRoles(client: Client, services: Services): Promise<void> {
  for (const row of services.originalRoles.listExpiringSoon(ORIGINAL_ROLE_NOTICE_DAYS)) {
    const user = await client.users.fetch(row.user_id).catch(() => null);
    await user
      ?.send(
        [
          `⏳ オリジナルロール **${row.name}** の期限が近づいています（<t:${row.expires_at ?? 0}:D>）。`,
          `公式ショップから **${fmtLd(services.settings.getNumber("original_role_renew_price"))}** で ${ORIGINAL_ROLE_TERM_DAYS}日 延長できます。`,
          "期限を過ぎるとロールは外れます（同じ名前で作り直すことはできます）。",
        ].join("\n"),
      )
      .catch(() => undefined);
    // 届かなくても記録する。届かないことを理由に毎分送り続けない
    services.originalRoles.markExpiryNotified(row.id);
  }
}

/**
 * 期限が切れた契約のロールを外す。
 * 外せなかったものは記録を残さず、次の巡回で拾い直す。
 */
export async function expireOriginalRoles(client: Client, services: Services): Promise<void> {
  const targets = services.originalRoles.listExpired();
  if (targets.length === 0) return;
  const guildId = services.settings.getString("guild:main");
  const guild = guildId ? await client.guilds.fetch(guildId).catch(() => null) : null;
  for (const row of targets) {
    let removed = false;
    if (guild && row.role_id) {
      const member = await guild.members.fetch(row.user_id).catch(() => null);
      if (!member) {
        // 退出済み。剥奪する相手が居ないので、これ以上追いかけない
        removed = true;
      } else {
        removed = await member.roles
          .remove(row.role_id, "公式ショップ: オリジナルロールの期限切れ")
          .then(() => true)
          .catch(() => false);
      }
    }
    services.originalRoles.markExpired(row.id, "system:original-role", removed);
    if (removed && row.status === "active") {
      const user = await client.users.fetch(row.user_id).catch(() => null);
      await user
        ?.send(`⌛ オリジナルロール **${row.name}** の期限が切れたため、ロールを外しました。`)
        .catch(() => undefined);
    }
  }
}

/** 承認したまま支払われない申請を畳む（承認待ちを永久に残さない） */
export async function cancelUnpaidOriginalRoles(client: Client, services: Services): Promise<void> {
  for (const row of services.originalRoles.listUnpaidApprovals()) {
    if (!services.originalRoles.cancelUnpaid(row.id, "system:original-role")) continue;
    const user = await client.users.fetch(row.user_id).catch(() => null);
    await user
      ?.send(
        `🗒 オリジナルロール **${row.name}** の申請は、承認からお支払いがないまま期限が過ぎたため取り消しました。改めて申請いただけます。`,
      )
      .catch(() => undefined);
  }
}
