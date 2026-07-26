import { describe, expect, it, vi } from "vitest";
import { openDb } from "@meigokujo/core";
import { processShopRoleRevocations, recoverAutoDropNoEvalGhosts } from "../src/scheduler-recovery.js";
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

function emptyBackfillDb() {
  return {
    prepare: vi.fn(() => ({ all: vi.fn(() => []) })),
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
        shop: {},
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
});

describe("ショップ失効ロール剥奪", () => {
  function pendingRevocation() {
    return {
      purchase_id: 10,
      user_id: "user1",
      role_id: "role1",
      status: "pending",
      attempts: 0,
      last_error: null,
      created_at: 1,
      updated_at: 1,
      completed_at: null,
    };
  }

  it("剥奪失敗後はpendingから再試行し、成功後だけ購入ID単位で完了する", async () => {
    const values = new Map<string, string>([["guild:main", "guild"]]);
    let hasRole = true;
    const remove = vi.fn(async () => { throw new Error("temporary"); });
    const done = vi.fn();
    const retry = vi.fn();
    const member = {
      roles: {
        cache: { has: vi.fn(() => hasRole) },
        remove,
      },
    };
    const makeServices = () => {
      const { settings } = makeSettings(values);
      return {
        db: emptyBackfillDb(),
        settings,
        shop: {
          pendingRoleRevocations: vi.fn(() => done.mock.calls.length > 0 ? [] : [pendingRevocation()]),
          activePurchaseGrantsRole: vi.fn(() => false),
          markRoleRevocationDone: done,
          markRoleRevocationRetry: retry,
        },
      };
    };
    const client = { guilds: { fetch: vi.fn(async () => ({ members: { fetch: vi.fn(async () => member) } })) } };

    await expect(processShopRoleRevocations(client as any, makeServices() as any)).rejects.toThrow("shop_role_revocation_failed");
    expect(done).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith(10, "system:shop-role-revoke", "temporary");

    remove.mockImplementation(async () => { hasRole = false; });
    await expect(processShopRoleRevocations(client as any, makeServices() as any)).resolves.toBeUndefined();
    expect(done).toHaveBeenCalledWith(10, "system:shop-role-revoke", "removed");

    await expect(processShopRoleRevocations(client as any, makeServices() as any)).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("退城済み・既にロール無しは正常完了する", async () => {
    const missingValues = new Map<string, string>([["guild:main", "guild"]]);
    const missingSettings = makeSettings(missingValues).settings;
    const services = {
      db: emptyBackfillDb(),
      settings: missingSettings,
      shop: {
        pendingRoleRevocations: vi.fn(() => [pendingRevocation()]),
        activePurchaseGrantsRole: vi.fn(() => false),
        markRoleRevocationDone: vi.fn(),
        markRoleRevocationRetry: vi.fn(),
      },
    };
    const missing = Object.assign(new Error("Unknown Member"), { code: 10007 });
    const missingClient = {
      guilds: { fetch: vi.fn(async () => ({ members: { fetch: vi.fn(async () => { throw missing; }) } })) },
    };
    await expect(processShopRoleRevocations(missingClient as any, services as any)).resolves.toBeUndefined();
    expect(services.shop.markRoleRevocationDone).toHaveBeenCalledWith(10, "system:shop-role-revoke", "member_absent");

    const absentValues = new Map<string, string>([["guild:main", "guild"]]);
    const absentServices = {
      ...services,
      db: emptyBackfillDb(),
      settings: makeSettings(absentValues).settings,
      shop: { ...services.shop, markRoleRevocationDone: vi.fn() },
    };
    const absentClient = {
      guilds: { fetch: vi.fn(async () => ({ members: { fetch: vi.fn(async () => ({ roles: { cache: { has: () => false }, remove: vi.fn() } })) } })) },
    };
    await expect(processShopRoleRevocations(absentClient as any, absentServices as any)).resolves.toBeUndefined();
    expect(absentServices.shop.markRoleRevocationDone).toHaveBeenCalledWith(10, "system:shop-role-revoke", "already_absent");
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
