import { describe, expect, it, vi } from "vitest";
import { openDb } from "@meigokujo/core";
import { recoverAutoDropNoEvalGhosts } from "../src/scheduler-recovery.js";
import { finalizeChunkBatch, sendChunkedLinesResumable } from "../src/scheduler-utils.js";

function makeSettings(values = new Map<string, string>()) {
  return {
    values,
    settings: {
      getString: vi.fn((key: string) => values.get(key)),
      set: vi.fn((key: string, value: unknown) => {
        values.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
      }),
    },
  };
}

describe("自動迷霊の永続ロール同期", () => {
  it("既存の退城済み迷霊を毎日の同期対象へ入れない", async () => {
    const { settings } = makeSettings();
    const memberFetch = vi.fn();
    const services = {
      settings,
      entry: {
        listSouls: vi.fn((status: string) => status === "meirei" ? [{ user_id: "departed" }] : []),
        getSoul: vi.fn(() => ({ user_id: "departed", status: "meirei" })),
      },
      evaluation: { threadFor: vi.fn(), demoteToMeirei: vi.fn() },
    };
    const client = { guilds: { fetch: vi.fn(async () => ({ members: { fetch: memberFetch } })) } };

    await expect(recoverAutoDropNoEvalGhosts(client as any, services as any)).resolves.toBeUndefined();
    expect(memberFetch).not.toHaveBeenCalled();
  });

  it("API失敗後は再起動相当でもロール同期だけを再試行し、DB降格を重複しない", async () => {
    const values = new Map<string, string>([
      ["guild:main", "guild"],
      ["role:ghost", "ghost_role"],
      ["role:meirei", "meirei_role"],
    ]);
    let status: "ghost" | "meirei" = "ghost";
    let hasMeirei = false;
    let hasGhost = true;
    const demote = vi.fn(() => { status = "meirei"; });
    const add = vi.fn(async () => { throw new Error("temporary"); });
    const remove = vi.fn(async () => { hasGhost = false; });
    const member = {
      roles: {
        cache: { has: vi.fn((roleId: string) => roleId === "meirei_role" ? hasMeirei : hasGhost) },
        add,
        remove,
      },
    };
    const makeServices = () => {
      const { settings } = makeSettings(values);
      return {
        settings,
        entry: {
          getSoul: vi.fn((userId: string) => ({ user_id: userId, status })),
          listSouls: vi.fn((requested: string) => {
            if (requested === "ghost") return status === "ghost" ? [{ user_id: "user1", eval_deadline_at: 1 }] : [];
            if (requested === "meirei") return status === "meirei" ? [{ user_id: "user1" }] : [];
            return [];
          }),
        },
        evaluation: { threadFor: vi.fn(() => undefined), demoteToMeirei: demote },
      };
    };
    const client = { guilds: { fetch: vi.fn(async () => ({ members: { fetch: vi.fn(async () => member) } })) } };

    await expect(recoverAutoDropNoEvalGhosts(client as any, makeServices() as any)).rejects.toThrow("autodrop:role_sync_failed");
    expect(demote).toHaveBeenCalledTimes(1);
    expect(values.get("autodrop:pending_role_sync")).toContain("user1");

    add.mockImplementation(async () => { hasMeirei = true; });
    await expect(recoverAutoDropNoEvalGhosts(client as any, makeServices() as any)).resolves.toBeUndefined();
    expect(demote).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith("ghost_role");
    expect(values.get("autodrop:pending_role_sync")).toBe("[]");
  });

  it("サーバーに存在しない対象はpendingから除外する", async () => {
    const values = new Map<string, string>([
      ["guild:main", "guild"],
      ["role:ghost", "ghost_role"],
      ["role:meirei", "meirei_role"],
      ["autodrop:pending_role_sync", JSON.stringify([{ userId: "gone", demoted: true, meireiAdded: false, ghostRemoved: false }])],
    ]);
    const { settings } = makeSettings(values);
    const services = {
      settings,
      entry: { listSouls: vi.fn(() => []), getSoul: vi.fn(() => ({ user_id: "gone", status: "meirei" })) },
      evaluation: { threadFor: vi.fn(), demoteToMeirei: vi.fn() },
    };
    const missing = Object.assign(new Error("Unknown Member"), { code: 10007 });
    const client = {
      guilds: { fetch: vi.fn(async () => ({ members: { fetch: vi.fn(async () => { throw missing; }) } })) },
    };

    await expect(recoverAutoDropNoEvalGhosts(client as any, services as any)).resolves.toBeUndefined();
    expect(values.get("autodrop:pending_role_sync")).toBe("[]");
  });

  it("メンバー取得中に運営が魔人へ変更した場合は迷霊ロールを追加しない", async () => {
    const values = new Map<string, string>([
      ["guild:main", "guild"],
      ["role:ghost", "ghost_role"],
      ["role:meirei", "meirei_role"],
      ["autodrop:pending_role_sync", JSON.stringify([{ userId: "user1", demoted: true, meireiAdded: false, ghostRemoved: false }])],
    ]);
    const { settings } = makeSettings(values);
    let status: "meirei" | "majin" = "meirei";
    const add = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const member = {
      roles: {
        cache: { has: vi.fn((roleId: string) => roleId === "ghost_role") },
        add,
        remove,
      },
    };
    const services = {
      settings,
      entry: {
        listSouls: vi.fn((requested: string) => requested === "meirei" ? [{ user_id: "user1" }] : []),
        getSoul: vi.fn(() => ({ user_id: "user1", status })),
      },
      evaluation: { threadFor: vi.fn(), demoteToMeirei: vi.fn() },
    };
    const client = {
      guilds: {
        fetch: vi.fn(async () => ({
          members: {
            fetch: vi.fn(async () => {
              status = "majin";
              return member;
            }),
          },
        })),
      },
    };

    await expect(recoverAutoDropNoEvalGhosts(client as any, services as any)).resolves.toBeUndefined();
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalledWith("ghost_role");
    expect(values.get("autodrop:pending_role_sync")).toBe("[]");
  });

  it("亡霊ロール解除中に亡霊へ戻された場合は迷霊ロールを外して亡霊ロールを復元する", async () => {
    const values = new Map<string, string>([
      ["guild:main", "guild"],
      ["role:ghost", "ghost_role"],
      ["role:meirei", "meirei_role"],
      ["autodrop:pending_role_sync", JSON.stringify([{ userId: "user1", demoted: true, meireiAdded: true, ghostRemoved: false }])],
    ]);
    const { settings } = makeSettings(values);
    let status: "meirei" | "ghost" = "meirei";
    let hasMeirei = true;
    let hasGhost = true;
    const add = vi.fn(async (roleId: string) => {
      if (roleId === "ghost_role") hasGhost = true;
    });
    const remove = vi.fn(async (roleId: string) => {
      if (roleId === "ghost_role") {
        hasGhost = false;
        status = "ghost";
      }
      if (roleId === "meirei_role") hasMeirei = false;
    });
    const member = {
      roles: {
        cache: { has: vi.fn((roleId: string) => roleId === "meirei_role" ? hasMeirei : hasGhost) },
        add,
        remove,
      },
    };
    const services = {
      settings,
      entry: {
        listSouls: vi.fn((requested: string) => requested === "meirei" ? [{ user_id: "user1" }] : []),
        getSoul: vi.fn(() => ({ user_id: "user1", status })),
      },
      evaluation: { threadFor: vi.fn(), demoteToMeirei: vi.fn() },
    };
    const client = { guilds: { fetch: vi.fn(async () => ({ members: { fetch: vi.fn(async () => member) } })) } };

    await expect(recoverAutoDropNoEvalGhosts(client as any, services as any)).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledWith("ghost_role");
    expect(remove).toHaveBeenCalledWith("meirei_role");
    expect(add).toHaveBeenCalledWith("ghost_role");
    expect(values.get("autodrop:pending_role_sync")).toBe("[]");
  });
});

describe("分割通知の再開", () => {
  it("2チャンク目失敗後は1チャンク目を再投稿せず、送信済み状態から明示確定する", async () => {
    const db = openDb(":memory:");
    const firstSend = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second failed"));
    const firstChannel = { send: firstSend };
    const lines = ["a".repeat(1500), "b".repeat(1500)];
    const snapshot = {
      batchKey: "chunks:test",
      kind: "test",
      header: "<@&staff> header",
      lines,
      targetIds: ["target"],
      roleIds: ["staff"],
    };

    await expect(sendChunkedLinesResumable({ db } as any, firstChannel as any, snapshot)).rejects.toThrow("second failed");
    expect(firstSend).toHaveBeenCalledTimes(2);

    const retrySend = vi.fn(async () => undefined);
    await expect(sendChunkedLinesResumable({ db } as any, { send: retrySend } as any, { ...snapshot, header: "changed", lines: ["changed"] })).resolves.toBeDefined();
    expect(retrySend).toHaveBeenCalledTimes(1);
    expect(retrySend.mock.calls[0]?.[0]?.allowedMentions.roles).toEqual([]);

    await expect(sendChunkedLinesResumable({ db } as any, { send: retrySend } as any, snapshot)).resolves.toBeDefined();
    expect(retrySend).toHaveBeenCalledTimes(1);
    const sentRow = db
      .prepare("SELECT status, sent_at, chunks_json FROM scheduler_chunk_batches WHERE batch_key='chunks:test'")
      .get() as { status: string; sent_at: number | null; chunks_json: string | null };
    expect(sentRow.status).toBe("pending");
    expect(sentRow.sent_at).not.toBeNull();
    expect(sentRow.chunks_json).not.toBeNull();

    expect(finalizeChunkBatch({ db } as any, "chunks:test")).toBe(true);
    const completedRow = db
      .prepare("SELECT status, chunks_json FROM scheduler_chunk_batches WHERE batch_key='chunks:test'")
      .get() as { status: string; chunks_json: string | null };
    expect(completedRow.status).toBe("completed");
    expect(completedRow.chunks_json).toBeNull();
    db.close();
  });
});
