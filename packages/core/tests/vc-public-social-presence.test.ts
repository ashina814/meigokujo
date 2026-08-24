import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { computePublicSocialPresenceIntervals } from "../src/vc/public-social-derived.js";
import { VcPublicSocialPresence } from "../src/vc/public-social-presence.js";

function rows(db: ReturnType<typeof openDb>) {
  return db
    .prepare(
      `SELECT user_id, guild_id, channel_id, started_at, ended_at, end_quality
         FROM vc_public_social_presence ORDER BY id`,
    )
    .all() as Array<Record<string, unknown>>;
}

describe("VcPublicSocialPresence canonical writer", () => {
  it("alone→2 humansで双方を同時openし、1人へ戻ると双方を同時closeする", () => {
    const db = openDb(":memory:");
    const source = new VcPublicSocialPresence(db);
    expect(source.reconcileChannel({ guildId: "main", channelId: "public", eligible: true, humanUserIds: ["alice"], observedAt: 100 })).toEqual({ opened: 0, closed: 0 });
    expect(source.reconcileChannel({ guildId: "main", channelId: "public", eligible: true, humanUserIds: ["alice", "bob"], observedAt: 110 })).toEqual({ opened: 2, closed: 0 });
    expect(source.reconcileChannel({ guildId: "main", channelId: "public", eligible: true, humanUserIds: ["alice"], observedAt: 120 })).toEqual({ opened: 0, closed: 2 });
    expect(rows(db)).toEqual([
      { user_id: "alice", guild_id: "main", channel_id: "public", started_at: 110, ended_at: 120, end_quality: "observed" },
      { user_id: "bob", guild_id: "main", channel_id: "public", started_at: 110, ended_at: 120, end_quality: "observed" },
    ]);
  });

  it("3 humansをpairへ展開せず各user 1 intervalにする", () => {
    const db = openDb(":memory:");
    const source = new VcPublicSocialPresence(db);
    source.reconcileChannel({ guildId: "main", channelId: "public", eligible: true, humanUserIds: ["alice", "bob", "carol"], observedAt: 100 });
    source.reconcileChannel({ guildId: "main", channelId: "public", eligible: false, humanUserIds: ["alice", "bob", "carol"], observedAt: 110 });
    expect(rows(db)).toHaveLength(3);
    expect(computePublicSocialPresenceIntervals(db, { start: 0, end: 200, observedAt: 200 }, ["alice"])[0]!.intervals).toEqual([{ start: 100, end: 110 }]);
  });

  it("public→private→public transitionを別intervalとして収束する", () => {
    const db = openDb(":memory:");
    const source = new VcPublicSocialPresence(db);
    const humans = ["alice", "bob"];
    source.reconcileChannel({ guildId: "main", channelId: "vc", eligible: true, humanUserIds: humans, observedAt: 10 });
    source.reconcileChannel({ guildId: "main", channelId: "vc", eligible: false, humanUserIds: humans, observedAt: 20 });
    source.reconcileChannel({ guildId: "main", channelId: "vc", eligible: true, humanUserIds: humans, observedAt: 30 });
    source.reconcileChannel({ guildId: "main", channelId: "vc", eligible: false, humanUserIds: humans, observedAt: 40 });
    expect(computePublicSocialPresenceIntervals(db, { start: 0, end: 100, observedAt: 100 }, ["alice"])[0]!.intervals).toEqual([{ start: 10, end: 20 }, { start: 30, end: 40 }]);
  });

  it("restart danglingはrecovered_estimateでuntrusted、startup後の新観測だけを採用する", () => {
    const db = openDb(":memory:");
    const beforeCrash = new VcPublicSocialPresence(db);
    beforeCrash.reconcileChannel({ guildId: "main", channelId: "vc", eligible: true, humanUserIds: ["alice", "bob"], observedAt: 10 });
    expect(new VcPublicSocialPresence(db).recoverDangling(100)).toBe(2);
    const afterRestart = new VcPublicSocialPresence(db);
    afterRestart.reconcileChannel({ guildId: "main", channelId: "vc", eligible: true, humanUserIds: ["alice", "bob"], observedAt: 110 });
    afterRestart.reconcileChannel({ guildId: "main", channelId: "vc", eligible: false, humanUserIds: ["alice", "bob"], observedAt: 120 });
    expect(computePublicSocialPresenceIntervals(db, { start: 0, end: 200, observedAt: 200 }, ["alice"])[0]!.intervals).toEqual([{ start: 110, end: 120 }]);
    expect(rows(db).filter((row) => row.end_quality === "recovered_estimate")).toHaveLength(2);
  });

  it("fixed snapshotでは後発recovery mutationに影響されず、当時openだった範囲だけをclipする", () => {
    const db = openDb(":memory:");
    const source = new VcPublicSocialPresence(db);
    source.reconcileChannel({ guildId: "main", channelId: "vc", eligible: true, humanUserIds: ["alice", "bob"], observedAt: 10 });
    const fixed = { start: 0, end: 200, observedAt: 50 };
    const before = computePublicSocialPresenceIntervals(db, fixed, ["alice"]);
    source.recoverDangling(100);
    expect(computePublicSocialPresenceIntervals(db, fixed, ["alice"])).toEqual(before);
    expect(before[0]!.intervals).toEqual([{ start: 10, end: 50 }]);
  });

  it("writer transaction失敗直後もin-process fenceでpersisted open rowを失敗時刻までにclipする", () => {
    const db = openDb(":memory:");
    const source = new VcPublicSocialPresence(db);
    const humans = ["alice", "bob"];
    source.reconcileChannel({ guildId: "main", channelId: "vc", eligible: true, humanUserIds: humans, observedAt: 10 });
    vi.spyOn(db, "transaction").mockImplementationOnce(() => (() => { throw new Error("write failed"); }) as never);
    expect(() => source.reconcileChannel({ guildId: "main", channelId: "vc", eligible: false, humanUserIds: humans, observedAt: 20 }))
      .toThrow("write failed");
    expect(rows(db).filter((row) => row.user_id === "alice")[0]!.ended_at).toBeNull();
    expect(computePublicSocialPresenceIntervals(db, { start: 0, end: 30, observedAt: 30 }, ["alice"])[0]!.intervals)
      .toEqual([{ start: 10, end: 20 }]);
  });
});
