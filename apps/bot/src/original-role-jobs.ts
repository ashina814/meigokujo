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
          "継続・再開・料金はBotが自動判定しません。公式ショップから同じカルテを開き、商館スタッフへご相談ください。",
          "期限後の実ロールの扱いも、本人と商館スタッフが相談して決めます。",
        ].join("\n"),
      )
      .catch(() => undefined);
    // 届かなくても記録する。届かないことを理由に毎分送り続けない
    services.originalRoles.markExpiryNotified(row.id);
  }
}

/**
 * 期限到来は「人が判断する仕事」に変わった。
 *
 * BotはここでDiscordロールを外さず、契約種別や再請求額も決めない。
 * 期限前通知を逃した行だけ一度知らせ、以後は専用カルテで商館スタッフが
 * 継続・再開・例外や実ロールの扱いを本人と決める。
 */
export async function expireOriginalRoles(client: Client, services: Services): Promise<void> {
  for (const row of services.originalRoles.listExpired()) {
    // 旧制度で既にexpiredへ移っている行は、実ロールを自動剥奪せず人の判断へ残す。
    if (row.status === "expired") continue;
    // 3日前通知済みでも、期限到来という客観事実はDBへ反映する。
    if (!row.notified_expiry_at) {
      const user = await client.users.fetch(row.user_id).catch(() => null);
      await user
        ?.send(
          [
            `⌛ オリジナルロール **${row.name}** は記録上の期限を迎えました。`,
            "Botはロールを自動で外さず、新規/継続/再開や料金も自動判定しません。",
            "公式ショップからオリジナルロールのカルテを開き、商館スタッフへご相談ください。",
          ].join("\n"),
        )
        .catch(() => undefined);
      services.originalRoles.markExpiryNotified(row.id);
    }
    // 実Discordロールは残したまま。失効後の扱いは本人+商館スタッフが決める。
    services.originalRoles.markExpired(row.id, "system:original-role-expiry", false);
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
