import { afterEach, describe, expect, it } from "vitest";
import {
  PVP_NOTIFY_COOLDOWN_MS,
  PVP_NOTIFY_MAX_ROLES,
  resetPvpNotifyThrottleForTesting,
  takePvpNotifyRoleIds,
} from "../src/casino/pvp-notify-throttle.js";

afterEach(() => {
  resetPvpNotifyThrottleForTesting();
});

describe("公開1v1の募集通知CD", () => {
  it("同一ユーザーは3募集連続まで通知し、4募集目から5分CDに入る", () => {
    const t0 = 1_000_000;
    expect(takePvpNotifyRoleIds("alice", ["role-a"], t0)).toEqual(["role-a"]);
    expect(takePvpNotifyRoleIds("alice", ["role-a"], t0 + 1)).toEqual(["role-a"]);
    expect(takePvpNotifyRoleIds("alice", ["role-a"], t0 + 2)).toEqual(["role-a"]);
    expect(takePvpNotifyRoleIds("alice", ["role-a"], t0 + 3)).toEqual([]);
    expect(takePvpNotifyRoleIds("alice", ["role-a"], t0 + PVP_NOTIFY_COOLDOWN_MS - 1)).toEqual([]);
    expect(takePvpNotifyRoleIds("alice", ["role-a"], t0 + PVP_NOTIFY_COOLDOWN_MS + 2)).toEqual(["role-a"]);
  });

  it("通知間隔が5分以上空けば連続回数をリセットする", () => {
    const t0 = 1_500_000;
    expect(takePvpNotifyRoleIds("alice", ["role-a"], t0)).toEqual(["role-a"]);
    expect(takePvpNotifyRoleIds("alice", ["role-a"], t0 + 1)).toEqual(["role-a"]);
    expect(takePvpNotifyRoleIds("alice", ["role-a"], t0 + PVP_NOTIFY_COOLDOWN_MS + 1)).toEqual(["role-a"]);
    expect(takePvpNotifyRoleIds("alice", ["role-a"], t0 + PVP_NOTIFY_COOLDOWN_MS + 2)).toEqual(["role-a"]);
  });

  it("別ユーザーの募集通知は互いにCDへ巻き込まない", () => {
    const t0 = 2_000_000;
    for (let i = 0; i < 3; i += 1) {
      expect(takePvpNotifyRoleIds("alice", ["role-a", "role-b"], t0 + i)).toEqual(["role-a", "role-b"]);
    }

    expect(takePvpNotifyRoleIds("alice", ["role-a", "role-b"], t0 + 10)).toEqual([]);
    expect(takePvpNotifyRoleIds("bob", ["role-a", "role-b"], t0 + 10)).toEqual(["role-a", "role-b"]);
  });

  it("同一ユーザーなら通知先ロール構成が変わっても同じ3回枠を使う", () => {
    const t0 = 2_500_000;
    expect(takePvpNotifyRoleIds("alice", ["role-a"], t0)).toEqual(["role-a"]);
    expect(takePvpNotifyRoleIds("alice", ["role-b"], t0 + 1)).toEqual(["role-b"]);
    expect(takePvpNotifyRoleIds("alice", ["role-c"], t0 + 2)).toEqual(["role-c"]);
    expect(takePvpNotifyRoleIds("alice", ["role-d"], t0 + 3)).toEqual([]);
  });

  it("重複を除き、1募集あたり最大10ロールまでに制限する", () => {
    const roles = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "a"];
    expect(takePvpNotifyRoleIds("alice", roles, 3_000_000)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]);
    expect(PVP_NOTIFY_MAX_ROLES).toBe(10);
  });
});
