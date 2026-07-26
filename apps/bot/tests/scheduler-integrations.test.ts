import { describe, expect, it, vi } from "vitest";
import { runSchedulerTaskOnce } from "../src/scheduler-utils.js";

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";

function makeMarkerSettings() {
  const values = new Map<string, string>();
  const settings = {
    getString: vi.fn((key: string) => values.get(key)),
    set: vi.fn((key: string, value: string) => values.set(key, value)),
    getNumber: vi.fn(() => 14),
  };
  return { values, settings };
}

describe("評価実績更新タスク", () => {
  it("refreshEvalStats内のDiscord更新失敗時に日次マーカーが保存されない", async () => {
    const { values, settings } = makeMarkerSettings();
    values.set("guild:main", "guild");
    const thread = {
      isThread: () => true,
      archived: false,
      name: "old",
      setName: vi.fn(async () => { throw new Error("rename failed"); }),
      messages: { fetch: vi.fn(async () => ({ edit: vi.fn(async () => undefined) })) },
    };
    const guild = {
      client: { channels: { fetch: vi.fn(async () => thread) } },
      members: { fetch: vi.fn(async () => ({ displayName: "Ghost" })) },
    };
    const client = { guilds: { fetch: vi.fn(async () => guild) } };
    const services = {
      settings,
      entry: {
        listSouls: vi.fn(() => [{ user_id: "user1" }]),
        getSoul: vi.fn(() => ({ ghost_at: 1, eval_deadline_at: 2, eval_extension_days: 0 })),
      },
      evaluation: {
        threadFor: vi.fn(() => "thread1"),
        thresholdsFor: vi.fn(() => ({ promotionRequired: 5, demotionThreshold: 4, policyVersion: "v1", startedAt: 1 })),
      },
      vc: { presence: vi.fn(() => ({ totalSeconds: 0, daysSeen: 0 })) },
      ledger: { balanceOf: vi.fn(() => 0) },
    };
    const { refreshEvalStats } = await import("../src/eval-daily.js");

    await expect(
      runSchedulerTaskOnce({ settings } as any, "eval_stats:refreshed:test", "system:test", () =>
        refreshEvalStats(client as any, services as any),
      ),
    ).rejects.toThrow("refreshEvalStats failed");

    expect(values.get("eval_stats:refreshed:test")).toBeUndefined();
    expect(thread.messages.fetch).toHaveBeenCalledWith("thread1");
  });

  it("起点メッセージ欠落時の代替投稿は、同日再試行で重複しない", async () => {
    const { values, settings } = makeMarkerSettings();
    values.set("guild:main", "guild");
    const fallbackSend = vi.fn(async () => undefined);
    const thread1 = {
      isThread: () => true,
      archived: false,
      name: "same",
      setName: vi.fn(async () => undefined),
      send: fallbackSend,
      messages: { fetch: vi.fn(async () => { throw { code: 10008 }; }) },
    };
    const thread2 = {
      isThread: () => true,
      archived: false,
      name: "old",
      setName: vi.fn(async () => { throw new Error("rename failed"); }),
      messages: { fetch: vi.fn(async () => ({ edit: vi.fn(async () => undefined) })) },
    };
    const guild = {
      client: {
        channels: {
          fetch: vi.fn(async (id: string) => (id === "thread1" ? thread1 : thread2)),
        },
      },
      members: { fetch: vi.fn(async (id: string) => ({ displayName: id === "user1" ? "same" : "Ghost2" })) },
    };
    const client = { guilds: { fetch: vi.fn(async () => guild) } };
    const services = {
      settings,
      entry: {
        listSouls: vi.fn(() => [{ user_id: "user1" }, { user_id: "user2" }]),
        getSoul: vi.fn((userId: string) => ({
          ghost_at: 1,
          eval_deadline_at: userId === "user1" ? null : 2,
          eval_extension_days: 0,
        })),
      },
      evaluation: {
        threadFor: vi.fn((userId: string) => (userId === "user1" ? "thread1" : "thread2")),
        thresholdsFor: vi.fn(() => ({ promotionRequired: 5, demotionThreshold: 4, policyVersion: "v1", startedAt: 1 })),
      },
      vc: { presence: vi.fn(() => ({ totalSeconds: 0, daysSeen: 0 })) },
      ledger: { balanceOf: vi.fn(() => 0) },
    };
    const { refreshEvalStats } = await import("../src/eval-daily.js");

    await expect(refreshEvalStats(client as any, services as any)).rejects.toThrow("refreshEvalStats failed");
    await expect(refreshEvalStats(client as any, services as any)).rejects.toThrow("refreshEvalStats failed");

    expect(fallbackSend).toHaveBeenCalledTimes(1);
    expect([...values.keys()].some((key) => key.startsWith("eval_stats:fallback_posted:"))).toBe(true);
  });
});

describe("自動迷霊タスク", () => {
  it("ロール同期失敗時は完了にせず、再試行でDB降格を二重実行せずにロールだけ修復する", async () => {
    const { values, settings } = makeMarkerSettings();
    values.set("guild:main", "guild");
    values.set("role:ghost", "ghost_role");
    values.set("role:meirei", "meirei_role");
    let phase: "ghost" | "meirei" = "ghost";
    const demoteToMeirei = vi.fn(() => { phase = "meirei"; });
    const add = vi.fn(async () => { throw new Error("add failed"); });
    const remove = vi.fn(async () => undefined);
    const member = {
      roles: {
        cache: { has: vi.fn((roleId: string) => roleId === "ghost_role") },
        add,
        remove,
      },
    };
    const client = {
      guilds: { fetch: vi.fn(async () => ({ members: { fetch: vi.fn(async () => member) } })) },
    };
    const services = {
      settings,
      entry: {
        getSoul: vi.fn(() => (phase === "meirei" ? { user_id: "user1", status: "meirei" } : { user_id: "user1", status: "ghost" })),
        listSouls: vi.fn((status: string) => {
          if (status === "ghost") {
            return phase === "ghost" ? [{ user_id: "user1", eval_deadline_at: 1 }] : [];
          }
          if (status === "meirei") {
            return phase === "meirei" ? [{ user_id: "user1", eval_deadline_at: 1 }] : [];
          }
          return [];
        }),
      },
      evaluation: { threadFor: vi.fn(() => undefined), demoteToMeirei },
    };
    const { autoDropNoEvalGhosts } = await import("../src/scheduler.js");

    await expect(
      runSchedulerTaskOnce({ settings } as any, "autodrop:noeval:test", "system:test", () =>
        autoDropNoEvalGhosts(client as any, services as any),
      ),
    ).rejects.toThrow("autodrop:role_sync_failed");
    expect(values.get("autodrop:noeval:test")).toBeUndefined();
    expect(demoteToMeirei).toHaveBeenCalledTimes(1);

    add.mockImplementation(async () => undefined);
    await expect(
      runSchedulerTaskOnce({ settings } as any, "autodrop:noeval:test", "system:test", () =>
        autoDropNoEvalGhosts(client as any, services as any),
      ),
    ).resolves.toBe(true);

    expect(demoteToMeirei).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith("ghost_role");
    expect(values.get("autodrop:noeval:test")).toBe("1");
  });

  it.each(["ghost", "majin", "mazoku", "waiting", "departed"] as const)(
    "未完了同期の再試行時、現在statusが%sなら迷霊ロールを付けない",
    async (status) => {
      const { values, settings } = makeMarkerSettings();
      values.set("guild:main", "guild");
      values.set("role:ghost", "ghost_role");
      values.set("role:meirei", "meirei_role");
      const add = vi.fn(async () => undefined);
      const remove = vi.fn(async () => undefined);
      const member = {
        roles: {
          cache: { has: vi.fn((roleId: string) => roleId === "ghost_role") },
          add,
          remove,
        },
      };
      const client = {
        guilds: { fetch: vi.fn(async () => ({ members: { fetch: vi.fn(async () => member) } })) },
      };
      const services = {
        settings,
        entry: {
          listSouls: vi.fn((requested: string) => requested === "meirei" ? [{ user_id: "user1", eval_deadline_at: 1 }] : []),
          getSoul: vi.fn(() => ({ user_id: "user1", status })),
        },
        evaluation: { threadFor: vi.fn(() => undefined), demoteToMeirei: vi.fn() },
      };
      const { autoDropNoEvalGhosts } = await import("../src/scheduler.js");

      await expect(autoDropNoEvalGhosts(client as any, services as any)).resolves.toBeUndefined();

      expect(add).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(services.evaluation.demoteToMeirei).not.toHaveBeenCalled();
    },
  );
});
