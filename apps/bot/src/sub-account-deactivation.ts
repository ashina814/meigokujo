import { randomUUID } from "node:crypto";
import type { Guild } from "discord.js";
import { clearAltRankRoles, type RankClearResult } from "./sub-account-rank.js";
import type { Services } from "./services.js";

export type SubAccountDeactivationResult =
  | { ok: true; id: number }
  | {
      ok: false;
      reason: "not_active" | "busy" | "guild_unavailable" | "discord_failed" | "db_conflict";
      detail?: string;
    };

function describeClearFailure(result: Extract<RankClearResult, { ok: false }>): string {
  switch (result.reason) {
    case "config_missing":
      return `階級ロール設定が不足しています: ${result.missingKeys.join(", ")}`;
    case "member_unavailable":
      return "サブ垢をDiscordから取得できませんでした";
    case "remove_failed":
      return `階級ロールの削除に失敗しました: ${(result.failed ?? []).join(", ")}`;
    case "final_unverifiable":
      return "削除後のDiscord実状態を確認できませんでした";
    case "roles_remaining":
      return `階級ロールが残っています: ${(result.remaining ?? []).join(", ")}`;
    case "config_changed":
      return "処理中に階級ロール設定が変わりました";
    case "operation_lost":
      return "別の階級処理へ実行権が移ったため停止しました";
  }
}

function logFailure(services: Services, id: number, actor: string, detail: string): void {
  const row = services.subAccounts.get(id);
  services.events.log("sub_account_deactivation_failed", {
    actor,
    target: row?.main_user_id,
    payload: { id, altUserId: row?.alt_user_id, status: row?.status, detail },
  });
}

/** Discord階級0件を実状態で確認してから、契約だけをcancelする。返金・購入変更は行わない。 */
export async function deactivateSubAccount(
  services: Services,
  guild: Guild | null,
  id: number,
  actor: string,
): Promise<SubAccountDeactivationResult> {
  const row = services.subAccounts.get(id);
  if (!row || row.status !== "active") return { ok: false, reason: "not_active" };
  if (!guild) {
    const detail = "解除先のDiscordサーバーを取得できませんでした";
    logFailure(services, id, actor, detail);
    return { ok: false, reason: "guild_unavailable", detail };
  }

  const operationToken = randomUUID();
  if (!services.subAccounts.claimRankOperation(id, "deactivate", operationToken)) {
    return services.subAccounts.get(id)?.status === "active"
      ? { ok: false, reason: "busy", detail: "別の階級処理が進行中です" }
      : { ok: false, reason: "not_active" };
  }

  try {
    const cleared = await clearAltRankRoles(services, guild, row.alt_user_id, () =>
      services.subAccounts.renewRankOperation(id, operationToken),
    );
    if (!cleared.ok) {
      const detail = describeClearFailure(cleared);
      logFailure(services, id, actor, detail);
      return { ok: false, reason: "discord_failed", detail };
    }
    if (!services.subAccounts.deactivate(id, actor, "運営による解除", operationToken)) {
      const detail = "Discord回収後にDB解除を確定できませんでした";
      logFailure(services, id, actor, detail);
      return { ok: false, reason: "db_conflict", detail };
    }
    return { ok: true, id };
  } finally {
    // 成功時はdeactivate()と同じtransactionですでに消えている。失敗時だけここで解放する。
    services.subAccounts.releaseRankOperation(id, operationToken);
  }
}
