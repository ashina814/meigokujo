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
  it("同一ロールは3回連続まで通知し、4回目から5分CDに入る", () => {
    const t0 = 1_000_000;
    expect(takePvpNotifyRoleIds(["role-a"], t0)).toEqual(["role-a"]);
    expect(takePvpNotifyRoleIds(["role-a"], t0 + 1)).toEqual(["role-a"]);
    expect(takePvpNotifyRoleIds(["role-a"], t0 + 2)).toEqual(["role-a"]);
    expect(takePvpNotifyRoleIds(["role-a"], t0 + 3)).toEqual([]);
    expect(takePvpNotifyRoleIds(["role-a"], t0 + PVP_NOTIFY_COOLDOWN_MS - 1)).toEqual([]);
    expect(takePvpNotifyRoleIds(["role-a"], t0 + PVP_NOTIFY_COOLDOWN_MS + 2)).toEqual(["role-a"]);
  });

  it("CDはロールごとに独立して数える", () => {
    const t0 = 2_000_000;
    for (let i = 0; i < 3; i += 1) expect(takePvpNotifyRoleIds(["role-a"], t0 + i)).toEqual(["role-a"]);

    expect(takePvpNotifyRoleIds(["role-a", "role-b"], t0 + 10)).toEqual(["role-b"]);
  });

  it("重複を除き、1募集あたり最大5ロールまでに制限する", () => {
    const roles = ["a", "b", "c", "d", "e", "f", "a"];
    expect(takePvpNotifyRoleIds(roles, 3_000_000)).toEqual(["a", "b", "c", "d", "e"]);
    expect(PVP_NOTIFY_MAX_ROLES).toBe(5);
  });
});
