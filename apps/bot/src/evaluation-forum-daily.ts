import type { Client } from "discord.js";
import { EvaluationForumStore } from "@meigokujo/core/evaluation/forum";
import { refreshEvaluationForumForUser } from "./commands/evaluation.js";
import type { Services } from "./services.js";

/**
 * 評価フォーラムv2の日次refresh。
 * 既に作成済みの現在サイクルthreadだけを、客観情報で更新する。
 * フォーラム生成・アリ数・昇降格判断は行わない。
 */
export async function refreshEvaluationForums(client: Client, services: Services): Promise<void> {
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
  if (failures.length > 0) throw new Error(`refreshEvaluationForums failed: ${failures.join(", ")}`);
}
