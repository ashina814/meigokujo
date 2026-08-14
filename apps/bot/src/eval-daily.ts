import type { Client, Guild } from "discord.js";
import { EvaluationForumStore } from "@meigokujo/core/evaluation/forum";
import { refreshEvaluationForumForUser } from "./commands/evaluation.js";
import type { Services } from "./services.js";

/**
 * 対象1人の現在評価サイクルのフォーラムを更新する。
 * フォーラムがまだ無い場合は何も作らない（B方式: 魔剣士が対象を選んだ時だけ作る）。
 */
export async function refreshEvalStatsForUser(guild: Guild, services: Services, userId: string): Promise<void> {
  await refreshEvaluationForumForUser(guild, services, userId);
}

/**
 * 毎日05:30の軽いrefresh。
 * Botが更新するのは期限・冥獣の巣活動・魔剣士同席・招待などの客観情報だけ。
 * アリ数、点数、昇格条件、残高等の制度判断は表示しない。
 */
export async function refreshEvalStats(client: Client, services: Services): Promise<void> {
  const guildId = services.settings.getString("guild:main");
  const guild = guildId ? await client.guilds.fetch(guildId).catch(() => null) : null;
  if (!guild) throw new Error("guild_fetch_failed");

  const store = new EvaluationForumStore(services.db);
  const failures: string[] = [];
  for (const cycle of store.listCurrentCycles()) {
    try {
      await refreshEvaluationForumForUser(guild, services, cycle.userId);
    } catch (error) {
      failures.push(`${cycle.userId}:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(`refreshEvalStats failed: ${failures.join(", ")}`);
}
