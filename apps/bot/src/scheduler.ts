import type { Client } from "discord.js";
import type { Services } from "./services.js";
import { startScheduler as startLegacyScheduler } from "./scheduler-legacy.js";

// 既存の評価以外の刻時盤ロジックはそのまま再利用する。
export * from "./scheduler-legacy.js";

/**
 * 評価フォーラムv2では、期限・アリ数・フォーラム有無をBotが制度判断へ使わない。
 *
 * 旧schedulerには次の評価自動化が残っているため、schedulerに渡す読み取り窓だけを
 * fail-closed にする。元のservicesはinteraction側では一切変更しない。
 * - カロンの昇格印集計/自動迷霊落ち候補（dueBetween / overdue）
 * - 「期限までに旧eval_threadsが無い」ことを理由にした自動迷霊落ち（threadFor）
 * - 旧自動迷霊落ちの再起動後pending queue
 *
 * これにより他の給与・部屋・賭場・説明会等のscheduler処理は旧実装をそのまま使い、
 * 評価に関する制度判断だけを止める。
 */
function withoutLegacyEvaluationAutomation(services: Services): Services {
  const evaluation = new Proxy(services.evaluation, {
    get(target, property) {
      if (property === "dueBetween" || property === "overdue") return () => [];
      // scheduler-recovery の旧「フォーラム未作成=自動迷霊」判定を常に止める。
      // 新しいサイクル別threadの正本は EvaluationForumStore 側にあり、ここで代用しない。
      if (property === "threadFor") return () => "evaluation-forum-v2";
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Services["evaluation"];

  const settings = new Proxy(services.settings, {
    get(target, property) {
      if (property === "getString") {
        return (key: string) => {
          // 旧方式で既に積まれている自動迷霊queueも、このPRでは自動執行しない。
          if (key === "autodrop:pending_role_sync") return "[]";
          return target.getString(key);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Services["settings"];

  return { ...services, evaluation, settings };
}

export function startScheduler(client: Client, services: Services, intervalMs = 60_000): NodeJS.Timeout {
  return startLegacyScheduler(client, withoutLegacyEvaluationAutomation(services), intervalMs);
}
