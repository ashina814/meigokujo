import { describe, expect, it, vi } from "vitest";
import { runSchedulerTaskOnce, sendChunkedLines } from "../src/scheduler-utils.js";

function makeSettings() {
  const values = new Map<string, string>();
  return {
    values,
    settings: {
      getString: vi.fn((key: string) => values.get(key)),
      set: vi.fn((key: string, value: string) => values.set(key, value)),
    },
  };
}

describe("Scheduler実行済みマーカー", () => {
  it("失敗時はcompletedを保存せず、次回成功時に保存する", async () => {
    const { values, settings } = makeSettings();

    await expect(
      runSchedulerTaskOnce({ settings } as any, "daily:task", "system:test", async () => {
        throw new Error("temporary");
      }),
    ).rejects.toThrow("temporary");
    expect(values.has("daily:task")).toBe(false);

    const ran = await runSchedulerTaskOnce({ settings } as any, "daily:task", "system:test", async () => undefined);
    expect(ran).toBe(true);
    expect(values.get("daily:task")).toBe("1");
    expect(settings.set).toHaveBeenLastCalledWith("daily:task", "1", "system:test");
  });

  it("completed済み・in-flight中は同じ処理を二重実行しない", async () => {
    const { values, settings } = makeSettings();
    let release!: () => void;
    const first = runSchedulerTaskOnce(
      { settings } as any,
      "daily:task",
      "system:test",
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    const secondTask = vi.fn(async () => undefined);
    await expect(runSchedulerTaskOnce({ settings } as any, "daily:task", "system:test", secondTask)).resolves.toBe(false);
    expect(secondTask).not.toHaveBeenCalled();

    release();
    await expect(first).resolves.toBe(true);
    expect(values.get("daily:task")).toBe("1");

    const afterCompleted = vi.fn(async () => undefined);
    await expect(runSchedulerTaskOnce({ settings } as any, "daily:task", "system:test", afterCompleted)).resolves.toBe(false);
    expect(afterCompleted).not.toHaveBeenCalled();
  });
});

describe("sendChunkedLines", () => {
  it("指定されたロールだけをallowedMentionsに通し、ユーザーメンションは通知許可しない", async () => {
    const send = vi.fn(async () => undefined);
    const channel = { send } as any;

    await sendChunkedLines(channel, "header <@&staff_role>", ["line <@user_id>"], {
      allowedRoleIds: ["staff_role"],
    });

    expect(send).toHaveBeenCalledWith({
      content: "header <@&staff_role>\nline <@user_id>",
      allowedMentions: { parse: [], roles: ["staff_role"] },
    });
  });
});
