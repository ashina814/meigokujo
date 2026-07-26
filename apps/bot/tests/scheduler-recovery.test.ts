import { describe, expect, it, vi } from "vitest";
import { processShopRoleRevocations, recoverAutoDropNoEvalGhosts } from "../src/scheduler-recovery.js";
import { sendChunkedLines } from "../src/scheduler-utils.js";

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
      entry: { listSouls: vi.fn(() => []) },
      evaluation: { threadFor: vi.fn(), demoteToMeirei: vi.fn() },
    };
    const missing = Object.assign(new Error("Unknown Member"), { code: 10007 });
    const client = {
      guilds: { fetch: vi.fn(async () => ({ members: { fetch: vi.fn(async () => { throw missing; }) } })) },
    };

    await expect(recoverAutoDropNoEvalGhosts(client as any, services as any)).resolves.toBeUndefined();
    expect(values.get("autodrop:pending_role_sync")).toBe("[]");
  });
});

describe("ショップ失効ロール剥奪", () => {
  function expiredPurchase() {
    return {
      id: 10,
      item_id: 2,
      user_id: "user1",
      status: "expired",
      item_name: "monthly role",
      item_delivery: "auto",
    };
  }

  it("剥奪失敗後は購入履歴から再発見し、成功後だけ購入IDマーカーを保存する", async () => {
    const values = new Map<string, string>([["guild:main", "guild"]]);
    let hasRole = true;
    const remove = vi.fn(async () => { throw new Error("temporary"); });
    const member = {
      roles: {
        cache: { has: vi.fn(() => hasRole) },
        remove,
      },
    };
    const makeServices = () => {
      const { settings } = makeSettings(values);
      return {
        settings,
        shop: {
          listRecentPurchases: vi.fn(() => [expiredPurchase()]),
          getItem: vi.fn(() => ({ delivery_kind: "add_role", delivery_data: JSON.stringify({ role_id: "role1" }) })),
        },
      };
    };
    const client = { guilds: { fetch: vi.fn(async () => ({ members: { fetch: vi.fn(async () => member) } })) } };

    await expect(processShopRoleRevocations(client as any, makeServices() as any)).rejects.toThrow("shop_role_revoke:failed");
    expect(values.get("shop:role_revoked:10")).toBeUndefined();

    remove.mockImplementation(async () => { hasRole = false; });
    await expect(processShopRoleRevocations(client as any, makeServices() as any)).resolves.toBeUndefined();
    expect(values.get("shop:role_revoked:10")).toBe("removed");

    await expect(processShopRoleRevocations(client as any, makeServices() as any)).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("退城済み・既にロール無しは正常完了する", async () => {
    const missingValues = new Map<string, string>([["guild:main", "guild"]]);
    const missingSettings = makeSettings(missingValues).settings;
    const services = {
      settings: missingSettings,
      shop: {
        listRecentPurchases: vi.fn(() => [expiredPurchase()]),
        getItem: vi.fn(() => ({ delivery_kind: "add_role", delivery_data: JSON.stringify({ role_id: "role1" }) })),
      },
    };
    const missing = Object.assign(new Error("Unknown Member"), { code: 10007 });
    const missingClient = {
      guilds: { fetch: vi.fn(async () => ({ members: { fetch: vi.fn(async () => { throw missing; }) } })) },
    };
    await expect(processShopRoleRevocations(missingClient as any, services as any)).resolves.toBeUndefined();
    expect(missingValues.get("shop:role_revoked:10")).toBe("member_absent");

    const absentValues = new Map<string, string>([["guild:main", "guild"]]);
    const absentServices = { ...services, settings: makeSettings(absentValues).settings };
    const absentClient = {
      guilds: { fetch: vi.fn(async () => ({ members: { fetch: vi.fn(async () => ({ roles: { cache: { has: () => false }, remove: vi.fn() } })) } })) },
    };
    await expect(processShopRoleRevocations(absentClient as any, absentServices as any)).resolves.toBeUndefined();
    expect(absentValues.get("shop:role_revoked:10")).toBe("already_absent");
  });
});

describe("分割通知の再開", () => {
  it("2チャンク目失敗後は1チャンク目を再投稿せず、ロールも再メンションしない", async () => {
    const values = new Map<string, string>();
    const { settings } = makeSettings(values);
    const firstSend = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second failed"));
    const firstChannel = { send: firstSend };
    const lines = ["a".repeat(1500), "b".repeat(1500)];
    const opts = {
      allowedRoleIds: ["staff"],
      progress: { services: { settings }, key: "chunks:test", actor: "system:test" },
    };

    await expect(sendChunkedLines(firstChannel as any, "<@&staff> header", lines, opts as any)).rejects.toThrow("second failed");
    expect(firstSend).toHaveBeenCalledTimes(2);

    const retrySend = vi.fn(async () => undefined);
    await expect(sendChunkedLines({ send: retrySend } as any, "changed header", ["changed"], opts as any)).resolves.toBeUndefined();
    expect(retrySend).toHaveBeenCalledTimes(1);
    expect(retrySend.mock.calls[0]?.[0]?.allowedMentions.roles).toEqual([]);

    await expect(sendChunkedLines({ send: retrySend } as any, "ignored", [], opts as any)).resolves.toBeUndefined();
    expect(retrySend).toHaveBeenCalledTimes(1);
  });
});
