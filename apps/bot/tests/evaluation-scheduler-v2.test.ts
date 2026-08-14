import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schedulerUrl = new URL("../src/scheduler.ts", import.meta.url);
const scheduler = readFileSync(schedulerUrl, "utf-8");
const start = scheduler.indexOf("export function startScheduler");
const end = scheduler.indexOf("/** VC浮上報酬の日次支給", start);
const normalScheduler = scheduler.slice(start, end);

describe("評価フォーラムv2 scheduler境界", () => {
  it("scheduler.tsが正本で、wrapper/Proxy/legacy退避を使わない", () => {
    expect(existsSync(new URL("../src/scheduler-legacy.ts", import.meta.url))).toBe(false);
    expect(scheduler).not.toContain("withoutLegacyEvaluationAutomation");
    expect(scheduler).not.toContain("startLegacyScheduler");
    expect(scheduler).not.toContain("new Proxy(");
  });

  it("通常schedulerは客観情報refreshだけを実行し、旧評価自動判断を呼ばない", () => {
    expect(normalScheduler).toContain("refreshEvaluationForums(client, services)");
    expect(normalScheduler).not.toContain("runCharonDaily(client, services)");
    expect(normalScheduler).not.toContain("postCharonDueList(client, services)");
    expect(normalScheduler).not.toContain("sendCharonNotifications(client, services)");
    expect(normalScheduler).not.toContain("postCharonOverduePanel(client, services)");
    expect(normalScheduler).not.toContain("syncCharonThreadTitles(client, services)");
    expect(normalScheduler).not.toContain("autoDropNoEvalGhosts(client, services)");
    expect(normalScheduler).not.toContain("recoverAutoDropNoEvalGhosts(client, services)");
  });
});
