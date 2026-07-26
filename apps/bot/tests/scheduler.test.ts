import { describe, expect, it, vi } from "vitest";
import { runSchedulerTaskOnce, sendChunkedLines } from "../src/scheduler-utils.js";

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";

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

describe("説明会通知タスク", () => {
  it("説明会チャンネル取得失敗時にマーカーが保存されない", async () => {
    const { values, settings } = makeSettings();
    values.set("channel:entry_guide", "guide");
    const { sendSessionNotification } = await import("../src/scheduler.js");
    const client = { channels: { fetch: vi.fn(async () => { throw new Error("temporary"); }) } };

    await expect(
      runSchedulerTaskOnce({ settings } as any, "session:notify:test", "system:test", () =>
        sendSessionNotification(client as any, { settings } as any, 21, "30m"),
      ),
    ).rejects.toThrow("session_notify:channel_fetch_failed");

    expect(values.get("session:notify:test")).toBeUndefined();
  });

  it("説明会送信成功後にだけマーカーが保存される", async () => {
    const { values, settings } = makeSettings();
    values.set("channel:entry_guide", "guide");
    values.set("role:queue_wait", "wait_role");
    const send = vi.fn(async () => undefined);
    const { sendSessionNotification } = await import("../src/scheduler.js");
    const client = {
      channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, send })) },
    };

    await expect(
      runSchedulerTaskOnce({ settings } as any, "session:notify:test", "system:test", () =>
        sendSessionNotification(client as any, { settings } as any, 21, "5m"),
      ),
    ).resolves.toBe(true);

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ allowedMentions: { roles: ["wait_role"] } }));
    expect(values.get("session:notify:test")).toBe("1");
  });
});

describe("カロン分割タスク", () => {
  function deadlineRow(userId: string) {
    return { user_id: userId, eval_deadline_at: Math.floor(Date.now() / 1000) + 3600 };
  }

  function charonServices(values = new Map<string, string>()) {
    values.set("channel:keikiban", "keikiban");
    values.set("channel:kessai", "kessai");
    const settings = {
      getString: vi.fn((key: string) => values.get(key)),
      set: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    const row = deadlineRow("user1");
    return {
      values,
      settings,
      services: {
        settings,
        evaluation: {
          dueBetween: vi.fn(() => [row]),
          overdue: vi.fn(() => [row]),
          promotionScore: vi.fn(() => ({ total: 1 })),
          demotionCount: vi.fn(() => 0),
          thresholdsFor: vi.fn(() => ({ promotionRequired: 5, demotionThreshold: 4 })),
          evaluationCount: vi.fn(() => 1),
          threadFor: vi.fn(() => "thread1"),
        },
      },
    };
  }

  it("カロンの一部処理失敗後、失敗部分だけ再試行され、期限一覧・承認パネルが重複投稿されない", async () => {
    const { values, services, settings } = charonServices();
    const dueSend = vi.fn(async () => { throw new Error("due failed"); });
    const panelSend = vi.fn(async () => undefined);
    const fetch = vi.fn(async (id: string) => {
      if (id === "keikiban") return { isTextBased: () => true, send: dueSend };
      if (id === "kessai") return { isTextBased: () => true, send: panelSend };
      return null;
    });
    const client = { channels: { fetch } };
    const { postCharonDueList, postCharonOverduePanel } = await import("../src/scheduler.js");

    await expect(
      runSchedulerTaskOnce({ settings } as any, "charon:due_list:test", "system:test", () =>
        postCharonDueList(client as any, services as any),
      ),
    ).rejects.toThrow("due failed");
    await expect(
      runSchedulerTaskOnce({ settings } as any, "charon:overdue_panel:test", "system:test", () =>
        postCharonOverduePanel(client as any, services as any),
      ),
    ).resolves.toBe(true);

    expect(values.get("charon:due_list:test")).toBeUndefined();
    expect(values.get("charon:overdue_panel:test")).toBe("1");
    expect(panelSend).toHaveBeenCalledTimes(1);

    dueSend.mockImplementation(async () => undefined);
    await expect(
      runSchedulerTaskOnce({ settings } as any, "charon:due_list:test", "system:test", () =>
        postCharonDueList(client as any, services as any),
      ),
    ).resolves.toBe(true);
    await expect(
      runSchedulerTaskOnce({ settings } as any, "charon:overdue_panel:test", "system:test", () =>
        postCharonOverduePanel(client as any, services as any),
      ),
    ).resolves.toBe(false);

    expect(values.get("charon:due_list:test")).toBe("1");
    expect(panelSend).toHaveBeenCalledTimes(1);
  });

  it("個人通知失敗時に通知済み扱いにならず、再試行で二重通知しない", async () => {
    const values = new Map<string, string>();
    const row = deadlineRow("user1");
    const settings = {
      getString: vi.fn((key: string) => values.get(key)),
      set: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    const services = {
      settings,
      evaluation: { dueBetween: vi.fn(() => [row]) },
    };
    const dmSend = vi.fn(async () => { throw new Error("dm closed"); });
    const client = { users: { fetch: vi.fn(async () => ({ send: dmSend })) }, channels: { fetch: vi.fn() } };
    const { sendCharonNotifications } = await import("../src/scheduler.js");

    await expect(sendCharonNotifications(client as any, services as any)).rejects.toThrow("charon_notifications_failed");
    expect([...values.keys()].some((key) => key.startsWith("charon:notified:dm:user1"))).toBe(false);

    dmSend.mockImplementation(async () => undefined);
    await expect(sendCharonNotifications(client as any, services as any)).resolves.toBeUndefined();
    expect([...values.keys()].filter((key) => key.startsWith("charon:notified:dm:user1"))).toHaveLength(1);
    await expect(sendCharonNotifications(client as any, services as any)).resolves.toBeUndefined();
    expect(dmSend).toHaveBeenCalledTimes(2);
  });
});
