import { afterEach, describe, expect, it } from "vitest";
import {
  PVP_NOTIFY_COOLDOWN_MS,
  PVP_NOTIFY_MAX_ROLES,
  preparePvpNotify,
  resetPvpNotifyThrottleForTesting,
} from "../src/casino/pvp-notify-throttle.js";

afterEach(() => {
  resetPvpNotifyThrottleForTesting();
});

function sent(userId: string, roleIds: string[], now: number) {
  const reservation = preparePvpNotify(userId, roleIds, now);
  reservation.commit();
  return reservation;
}

describe("公開1v1の募集通知CD", () => {
  it("同一ユーザーは3募集連続まで通知し、4募集目から5分CDに入る", () => {
    const t0 = 1_000_000;
    expect(sent("alice", ["role-a"], t0)).toMatchObject({ roleIds: ["role-a"], status: "sent" });
    expect(sent("alice", ["role-a"], t0 + 1)).toMatchObject({ roleIds: ["role-a"], status: "sent" });
    expect(sent("alice", ["role-a"], t0 + 2)).toMatchObject({ roleIds: ["role-a"], status: "sent" });
    expect(preparePvpNotify("alice", ["role-a"], t0 + 3)).toMatchObject({ roleIds: [], status: "cooldown" });
    expect(preparePvpNotify("alice", ["role-a"], t0 + PVP_NOTIFY_COOLDOWN_MS - 1)).toMatchObject({
      roleIds: [],
      status: "cooldown",
    });
    expect(preparePvpNotify("alice", ["role-a"], t0 + PVP_NOTIFY_COOLDOWN_MS + 2)).toMatchObject({
      roleIds: ["role-a"],
      status: "sent",
    });
  });

  it("通知間隔が5分以上空けば連続回数をリセットする", () => {
    const t0 = 1_500_000;
    expect(sent("alice", ["role-a"], t0).status).toBe("sent");
    expect(sent("alice", ["role-a"], t0 + 1).status).toBe("sent");
    expect(sent("alice", ["role-a"], t0 + PVP_NOTIFY_COOLDOWN_MS + 1).status).toBe("sent");
    expect(sent("alice", ["role-a"], t0 + PVP_NOTIFY_COOLDOWN_MS + 2).status).toBe("sent");
  });

  it("別ユーザーの募集通知は互いにCDへ巻き込まない", () => {
    const t0 = 2_000_000;
    for (let i = 0; i < 3; i += 1) {
      expect(sent("alice", ["role-a", "role-b"], t0 + i)).toMatchObject({
        roleIds: ["role-a", "role-b"],
        status: "sent",
      });
    }

    expect(preparePvpNotify("alice", ["role-a", "role-b"], t0 + 10).status).toBe("cooldown");
    expect(preparePvpNotify("bob", ["role-a", "role-b"], t0 + 10)).toMatchObject({
      roleIds: ["role-a", "role-b"],
      status: "sent",
    });
  });

  it("同一ユーザーなら通知先ロール構成が変わっても同じ3回枠を使う", () => {
    const t0 = 2_500_000;
    expect(sent("alice", ["role-a"], t0).roleIds).toEqual(["role-a"]);
    expect(sent("alice", ["role-b"], t0 + 1).roleIds).toEqual(["role-b"]);
    expect(sent("alice", ["role-c"], t0 + 2).roleIds).toEqual(["role-c"]);
    expect(preparePvpNotify("alice", ["role-d"], t0 + 3).status).toBe("cooldown");
  });

  it("重複を除き、1募集あたり最大10ロールまでに制限する", () => {
    const roles = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "a"];
    expect(preparePvpNotify("alice", roles, 3_000_000).roleIds).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
      "j",
    ]);
    expect(PVP_NOTIFY_MAX_ROLES).toBe(10);
  });

  it("送信されなかった予約は通知回数を消費しない", () => {
    const t0 = 3_500_000;
    const abandoned = preparePvpNotify("alice", ["role-a"], t0);
    expect(abandoned.status).toBe("sent");
    // commit しない = Discord への送信失敗相当

    expect(sent("alice", ["role-a"], t0 + 1).status).toBe("sent");
    expect(sent("alice", ["role-a"], t0 + 2).status).toBe("sent");
    expect(sent("alice", ["role-a"], t0 + 3).status).toBe("sent");
    expect(preparePvpNotify("alice", ["role-a"], t0 + 4).status).toBe("cooldown");
  });

  it("通知ロール未設定は枠を消費しない", () => {
    const t0 = 4_000_000;
    expect(preparePvpNotify("alice", [], t0)).toMatchObject({ roleIds: [], status: "unconfigured" });
    expect(sent("alice", ["role-a"], t0 + 1).status).toBe("sent");
  });
});
