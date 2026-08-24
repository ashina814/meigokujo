import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { RoleFamilyTemporal, type RoleFamilyManifest } from "../src/role-family/temporal.js";
import { TITLE_SOURCES } from "../src/titles/v2-contract.js";
import { defineTitleRule } from "../src/titles/v2-evaluator.js";
import { readTitleSource, TitleSourceCache } from "../src/titles/v2-sources.js";
import { resolveTitleScope } from "../src/titles/v2-scope.js";
import { TitleV2Store } from "../src/titles/v2-store.js";
import type {
  SocialClassContextSafePayload,
  SocialDepartmentFamilyContextSafePayload,
} from "../src/titles/v2-social-context.js";

const BASE = Math.floor(Date.UTC(2026, 7, 20, 0, 0) / 1000);
const END = BASE + 10_000;
const RULE = defineTitleRule({
  kind: "behavior",
  key: "v2.test.social-context",
  name: "test",
  description: "test",
  catalog: "test",
  emoji: "x",
  hidden: false,
  publicAnnounce: false,
  themeKey: "test-theme",
  groupKey: "test-group",
  collectionDomainKey: "test-domain",
  scope: { type: "global" },
  sources: ["social_class_context_safe"],
  triggers: ["vc_activity"],
  lifecycle: "active",
}, { awardFactsVersion: 1, evaluate: () => ({ matched: false, earnedAt: null }) });

function setup() {
  const db = openDb(":memory:");
  let now = BASE - 1000;
  const store = new TitleV2Store(db, () => now);
  store.applyCatalog({ catalogKey: "test", actor: "test" });
  now = END;
  return { db, scope: resolveTitleScope(store, RULE.definition, END) };
}

function status(db: ReturnType<typeof openDb>, userId: string, value: string, observedAt: number) {
  db.prepare(
    `INSERT INTO soul_status_history (user_id, status, observed_at, provenance)
     VALUES (?, ?, ?, 'status_transition')`,
  ).run(userId, value, observedAt);
}

function vc(
  db: ReturnType<typeof openDb>,
  userId: string,
  channelId: string,
  startedAt: number,
  endedAt: number,
  quality: "observed" | "recovered_estimate" = "observed",
) {
  db.prepare(
    `INSERT INTO vc_segments
       (user_id, channel_id, started_at, ended_at, end_quality, start_reason)
     VALUES (?, ?, ?, ?, ?, 'join')`,
  ).run(userId, channelId, startedAt, endedAt, quality);
}

function overlap(db: ReturnType<typeof openDb>, counterpart: string, channel: string, start: number, end: number,
  quality: "observed" | "recovered_estimate" = "observed") {
  vc(db, "subject", channel, start, end, "observed");
  vc(db, counterpart, channel, start, end, quality);
}

function maxMatching(profiles: readonly { touches: readonly number[] }[]): number {
  const matched = new Map<number, number>();
  const visit = (person: number, seen: Set<number>): boolean => {
    for (const category of profiles[person]!.touches) {
      if (seen.has(category)) continue;
      seen.add(category);
      const previous = matched.get(category);
      if (previous === undefined || visit(previous, seen)) {
        matched.set(category, person);
        return true;
      }
    }
    return false;
  };
  let result = 0;
  for (let person = 0; person < profiles.length; person++) if (visit(person, new Set())) result++;
  return result;
}

function classMatching(payload: SocialClassContextSafePayload): number {
  return maxMatching(payload.counterparts.map((profile) => ({
    touches: profile.classTouches.map((touch) => touch.classIndex),
  })));
}

function familyMatching(payload: SocialDepartmentFamilyContextSafePayload): number {
  return maxMatching(payload.counterparts.map((profile) => ({
    touches: profile.familyTouches.map((touch) => touch.familyIndex),
  })));
}

describe("V-AC No.26 class-at-interaction safe relation", () => {
  it("V/W/Y. same Aliceのghost→majin touchesは1 counterpart profileのままでmatching=1", () => {
    const { db, scope } = setup();
    status(db, "alice", "ghost", BASE - 100);
    status(db, "alice", "majin", BASE + 100);
    overlap(db, "alice", "vc-a1", BASE, BASE + 50);
    overlap(db, "alice", "vc-a2", BASE + 200, BASE + 250);
    const payload = readTitleSource(db, "social_class_context_safe", "subject", scope);
    expect(payload.counterparts).toHaveLength(1);
    expect(payload.counterparts[0]!.classTouches).toHaveLength(2);
    expect(classMatching(payload)).toBe(1);
  });

  it("X. Alice ghost + Bob majinはdistinct person×class matching=2を表現する", () => {
    const { db, scope } = setup();
    status(db, "alice", "ghost", BASE - 100);
    status(db, "bob", "majin", BASE - 100);
    overlap(db, "alice", "vc-a", BASE, BASE + 50);
    overlap(db, "bob", "vc-b", BASE + 100, BASE + 150);
    const payload = readTitleSource(db, "social_class_context_safe", "subject", scope);
    expect(payload.counterparts).toHaveLength(2);
    expect(classMatching(payload)).toBe(2);
  });

  it("E/F. later status transitionはearlier interactionを現在classへrewriteしない", () => {
    const { db, scope } = setup();
    status(db, "alice", "ghost", BASE - 100);
    overlap(db, "alice", "vc-a", BASE, BASE + 50);
    status(db, "alice", "majin", BASE + 100);
    const payload = readTitleSource(db, "social_class_context_safe", "subject", scope);
    expect(payload.counterparts[0]!.classTouches).toHaveLength(1);
  });

  it("G/Z. transitionとinteractionが同一秒だけ重なるambiguous sliceはclassへ採用しない", () => {
    const { db, scope } = setup();
    status(db, "alice", "ghost", BASE - 100);
    status(db, "alice", "majin", BASE + 10);
    overlap(db, "alice", "vc-a", BASE + 10, BASE + 11);
    expect(readTitleSource(db, "social_class_context_safe", "subject", scope)).toEqual({ counterparts: [] });
  });

  it("H/I/AB. baseline以前・waiting/departed・current stateだけからpast classを作らない", () => {
    const { db, scope } = setup();
    overlap(db, "alice", "vc-a", BASE, BASE + 20);
    overlap(db, "waiter", "vc-w", BASE, BASE + 20);
    overlap(db, "departed", "vc-d", BASE, BASE + 20);
    status(db, "alice", "majin", BASE + 30);
    status(db, "waiter", "waiting", BASE - 100);
    status(db, "departed", "departed", BASE - 100);
    expect(readTitleSource(db, "social_class_context_safe", "subject", scope)).toEqual({ counterparts: [] });
  });

  it("AA. recovered_estimateを含むuntrusted VC overlapは0", () => {
    const { db, scope } = setup();
    status(db, "alice", "ghost", BASE - 100);
    overlap(db, "alice", "vc-a", BASE, BASE + 20, "recovered_estimate");
    expect(readTitleSource(db, "social_class_context_safe", "subject", scope)).toEqual({ counterparts: [] });
  });
});

describe("AD-AK No.27 role-family-at-interaction safe relation", () => {
  const manifest: RoleFamilyManifest = {
    provenance: "explicit_manifest",
    families: [
      { familyKey: "family-a", roleIds: ["a1", "a2"], tags: ["public_department"] },
      { familyKey: "family-b", roleIds: ["b"], tags: ["public_department"] },
      { familyKey: "private-family", roleIds: ["private"], tags: ["shop"] },
    ],
  };

  it("AD/AE/AJ. Alice A→Bは1 profile、same-family role X/Yは1 family、person breadthは1", () => {
    const { db, scope } = setup();
    const temporal = new RoleFamilyTemporal(db);
    temporal.startObservationSession("main", manifest, [{ userId: "alice", roleIds: ["a1", "a2"], bot: false }], BASE - 100);
    overlap(db, "alice", "vc-a1", BASE, BASE + 50);
    temporal.observeMemberSnapshot("main", { userId: "alice", roleIds: ["b"], bot: false }, BASE + 100);
    overlap(db, "alice", "vc-a2", BASE + 200, BASE + 250);
    temporal.checkpoint("main", END);
    const payload = readTitleSource(db, "social_department_family_context_safe", "subject", scope);
    expect(payload.counterparts).toHaveLength(1);
    expect(payload.counterparts[0]!.familyTouches).toHaveLength(2);
    expect(familyMatching(payload)).toBe(1);
  });

  it("AF. Alice family A + Bob family Bはmatching=2", () => {
    const { db, scope } = setup();
    const temporal = new RoleFamilyTemporal(db);
    temporal.startObservationSession("main", manifest, [
      { userId: "alice", roleIds: ["a1"], bot: false },
      { userId: "bob", roleIds: ["b"], bot: false },
    ], BASE - 100);
    overlap(db, "alice", "vc-a", BASE, BASE + 50);
    overlap(db, "bob", "vc-b", BASE + 100, BASE + 150);
    temporal.checkpoint("main", END);
    const payload = readTitleSource(db, "social_department_family_context_safe", "subject", scope);
    expect(familyMatching(payload)).toBe(2);
  });

  it("AG. same JST dayでもinteraction時間とfamily intervalが重ならなければ0", () => {
    const { db, scope } = setup();
    const temporal = new RoleFamilyTemporal(db);
    temporal.startObservationSession("main", manifest, [{ userId: "alice", roleIds: [], bot: false }], BASE - 100);
    overlap(db, "alice", "vc-a", BASE, BASE + 50);
    temporal.observeMemberSnapshot("main", { userId: "alice", roleIds: ["a1"], bot: false }, BASE + 100);
    temporal.checkpoint("main", END);
    expect(readTitleSource(db, "social_department_family_context_safe", "subject", scope)).toEqual({ counterparts: [] });
  });

  it("role transitionとinteractionが同一秒だけ重なるambiguous sliceはfamilyへ採用しない", () => {
    const { db, scope } = setup();
    const temporal = new RoleFamilyTemporal(db);
    temporal.startObservationSession("main", manifest, [{ userId: "alice", roleIds: [], bot: false }], BASE - 100);
    temporal.observeMemberSnapshot("main", { userId: "alice", roleIds: ["a1"], bot: false }, BASE + 10);
    overlap(db, "alice", "vc-a", BASE + 10, BASE + 11);
    temporal.checkpoint("main", END);
    expect(readTitleSource(db, "social_department_family_context_safe", "subject", scope)).toEqual({ counterparts: [] });
  });

  it("AH. restart UNKNOWN gapだけのinteractionをknown-positiveへ変換しない", () => {
    const { db, scope } = setup();
    const temporal = new RoleFamilyTemporal(db);
    temporal.startObservationSession("main", manifest, [{ userId: "alice", roleIds: ["a1"], bot: false }], BASE - 100);
    temporal.checkpoint("main", BASE);
    temporal.recoverDangling("main");
    overlap(db, "alice", "vc-gap", BASE + 10, BASE + 20);
    temporal.startObservationSession("main", manifest, [{ userId: "alice", roleIds: ["a1"], bot: false }], BASE + 30);
    temporal.checkpoint("main", END);
    expect(readTitleSource(db, "social_department_family_context_safe", "subject", scope)).toEqual({ counterparts: [] });
  });

  it("AI. public_department tagのないfamilyはNo.27 evidenceへ入れない", () => {
    const { db, scope } = setup();
    const temporal = new RoleFamilyTemporal(db);
    temporal.startObservationSession("main", manifest, [{ userId: "alice", roleIds: ["private"], bot: false }], BASE - 100);
    temporal.checkpoint("main", END);
    overlap(db, "alice", "vc-a", BASE, BASE + 50);
    expect(readTitleSource(db, "social_department_family_context_safe", "subject", scope)).toEqual({ counterparts: [] });
  });
});

describe("AC/AK/AL-AO privacy and bulk contract", () => {
  it("restricted temporal sourcesとsafe derived sourcesをcontractへ分離する", () => {
    for (const key of [
      "vc_temporal_co_presence_slices", "soul_status_history", "role_family_manifest_history",
      "role_observation_sessions", "role_family_member_presence",
    ] as const) {
      expect(TITLE_SOURCES[key]).toMatchObject({
        privacy: "restricted",
        titleUsable: false,
        restrictedUse: "social_context_safe_classification",
      });
    }
    for (const key of ["social_class_context_safe", "social_department_family_context_safe"] as const) {
      expect(TITLE_SOURCES[key]).toMatchObject({ privacy: "safe", titleUsable: true });
    }
  });

  it("AO. safe JSON exact keysにidentity/role/timestamp/channel/status名を含めない", () => {
    const { db, scope } = setup();
    status(db, "alice-secret", "ghost", BASE - 100);
    overlap(db, "alice-secret", "secret-channel", BASE, BASE + 20);
    const payload = readTitleSource(db, "social_class_context_safe", "subject", scope);
    expect(Object.keys(payload)).toEqual(["counterparts"]);
    expect(Object.keys(payload.counterparts[0]!)).toEqual(["classTouches"]);
    expect(Object.keys(payload.counterparts[0]!.classTouches[0]!)).toEqual(["classIndex", "days"]);
    expect(Object.keys(payload.counterparts[0]!.classTouches[0]!.days[0]!)).toEqual(["date", "trustedSeconds"]);
    const json = JSON.stringify(payload);
    for (const secret of ["alice", "subject", "secret-channel", "ghost", String(BASE)]) expect(json).not.toContain(secret);
  });

  it("AL/AM. each sourceは601 subjectsを300/300/1の3 logical readsでprefetchしsingleと一致する", () => {
    const { db, scope } = setup();
    const users = Array.from({ length: 601 }, (_, index) => `user-${index}`);
    for (const key of ["social_class_context_safe", "social_department_family_context_safe"] as const) {
      const cache = new TitleSourceCache();
      expect(cache.prefetch(db, key, users, scope)).toEqual({ loaded: 601, readCalls: 3 });
      for (const userId of [users[0]!, users[300]!, users[600]!]) {
        expect(cache.get(db, key, userId, scope)).toEqual(readTitleSource(db, key, userId, scope));
      }
    }
  });

  it("AN. counterpart数が増えてもcounterpart単位SQLを発行しない", () => {
    const { db, scope } = setup();
    for (let index = 0; index < 30; index++) {
      const id = `counterpart-${index}`;
      status(db, id, index % 2 ? "ghost" : "majin", BASE - 100);
      overlap(db, id, `vc-${index}`, BASE + index * 10, BASE + index * 10 + 5);
    }
    const spy = vi.spyOn(db, "prepare");
    readTitleSource(db, "social_class_context_safe", "subject", scope);
    const historyReads = spy.mock.calls.filter(([sql]) => String(sql).includes("FROM soul_status_history"));
    expect(historyReads).toHaveLength(1);
    expect(spy.mock.calls.length).toBeLessThan(10);
  });
});
