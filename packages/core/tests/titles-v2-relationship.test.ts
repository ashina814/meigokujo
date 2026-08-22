import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { BumpCounter } from "../src/rank/bump.js";
import {
  TITLE_SOURCES,
  assertRestrictedUseContract,
  defineBehaviorTitle,
  type BehaviorTitleDefinition,
  type TitleDefinition,
  type TitleRestrictedUse,
  type TitleSourceDefinition,
} from "../src/titles/v2-contract.js";
import { assertSourceReaderCoverage, readTitleSource } from "../src/titles/v2-sources.js";
import { resolveTitleScope } from "../src/titles/v2-scope.js";
import {
  defineRelationshipTitleRule,
  type RelationshipCandidateSnapshot,
  type RelationshipTitleRule,
  type RelationshipTitleRuleContext,
  type RelationshipTitleRuleResult,
} from "../src/titles/v2-relationship.js";
import { defineTitleEvaluationPlan, evaluateUserPipeline } from "../src/titles/v2-pipeline.js";
import { defineTitleRule } from "../src/titles/v2-evaluator.js";
import { defineMetaTitleRule } from "../src/titles/v2-meta.js";
import { resolveRelationshipCandidates, resolveRelationshipPrivateEvidence } from "../src/titles/v2-relationship-evidence.js";
import { TitleV2Store } from "../src/titles/v2-store.js";
import * as v2Public from "../src/titles/v2.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** JST 2026-08-01 00:00:00 を基準にした、relationshipテスト用の日境界。 */
const JST_DAY0 = Math.floor(new Date("2026-08-01T00:00:00+09:00").getTime() / 1000);
const BASE = JST_DAY0 - 100_000;
const OBSERVED_AT = JST_DAY0 + 60 * 86_400;

function jstDayStart(dayOffset: number): number {
  return JST_DAY0 + dayOffset * 86_400;
}

function setup() {
  const db = openDb(":memory:");
  new BumpCounter(db);
  let clock = BASE;
  const store = new TitleV2Store(db, () => clock);
  store.applyCatalog({ catalogKey: "test", actor: "test-setup" });
  clock = OBSERVED_AT + 1_000_000;
  const setClock = (value: number) => {
    clock = value;
  };
  return { db, store, setClock };
}

function insertVcSegment(
  db: ReturnType<typeof openDb>,
  userId: string,
  channelId: string,
  startedAt: number,
  endedAt: number | null,
  endQuality: "observed" | "recovered_estimate" | null,
  startReason: "join" | "move" | "state_change" | null = "join",
) {
  db.prepare(
    `INSERT INTO vc_segments (user_id, channel_id, parent_id, started_at, ended_at, self_muted, self_deafened, end_quality, start_reason)
     VALUES (?, ?, NULL, ?, ?, 0, 0, ?, ?)`,
  ).run(userId, channelId, startedAt, endedAt, endQuality, startReason);
}

/** subjectとcounterpartが、指定日数ぶんoverlapする(1日あたりoverlapSeconds秒)VC同席を作る。 */
function insertOverlapDays(
  db: ReturnType<typeof openDb>,
  subject: string,
  counterpart: string,
  channelId: string,
  dayOffsets: readonly number[],
  overlapSecondsPerDay: number,
) {
  for (const offset of dayOffsets) {
    const start = jstDayStart(offset) + 100;
    const end = start + overlapSecondsPerDay;
    insertVcSegment(db, subject, channelId, start, end, "observed", "join");
    insertVcSegment(db, counterpart, channelId, start, end, "observed", "join");
  }
}

const COMMON_RELATIONSHIP_FIELDS = {
  catalog: "test",
  emoji: "x",
  hidden: false,
  publicAnnounce: false,
  themeKey: "test-relationship-theme",
  groupKey: "test-relationship-group",
  collectionDomainKey: "test-relationship-domain",
  scope: { type: "global" as const },
};

function relationshipRule(
  key: `v2.${string}`,
  evaluateCandidate: (ctx: RelationshipTitleRuleContext) => RelationshipTitleRuleResult,
  opts: { lifecycle?: "active" | "retired" | "disabled"; triggers?: readonly ["vc_activity"] | readonly ["daily"] } = {},
): RelationshipTitleRule {
  return defineRelationshipTitleRule(
    {
      kind: "behavior",
      key,
      name: key,
      description: "テスト用relationship fixture",
      sources: ["vc_social_safe"] as const,
      triggers: opts.triggers ?? ["vc_activity"],
      lifecycle: opts.lifecycle ?? "active",
      ...COMMON_RELATIONSHIP_FIELDS,
    },
    { awardFactsVersion: 1, evaluateCandidate },
  );
}

/** 常にmatchedになるrelationship fixture。 */
function alwaysMatchRelationship(key: `v2.${string}`, opts?: { lifecycle?: "active" | "retired" | "disabled" }): RelationshipTitleRule {
  return relationshipRule(key, () => ({ matched: true, awardFacts: {} }), opts);
}

// ─────────────────────────────────────────────────────────────

describe("TITLE_SOURCES: vc_co_presence の restrictedUse 契約（§4, §61）", () => {
  it("vc_co_presence は restrictedUse:'relationship_private_evidence' かつ titleUsable:false のまま", () => {
    expect(TITLE_SOURCES.vc_co_presence.titleUsable).toBe(false);
    expect(TITLE_SOURCES.vc_co_presence.privacy).toBe("restricted");
    expect(TITLE_SOURCES.vc_co_presence.restrictedUse).toBe("relationship_private_evidence");
  });

  it("assertRestrictedUseContract() は現行registryを通す", () => {
    expect(() => assertRestrictedUseContract()).not.toThrow();
  });

  it("restrictedUse を titleUsable:true の source へ付けるとreject（privacy:restrictedのまま）", () => {
    const broken: Record<string, TitleSourceDefinition> = {
      ...TITLE_SOURCES,
      vc_co_presence: { ...TITLE_SOURCES.vc_co_presence, titleUsable: true },
    };
    expect(() => assertRestrictedUseContract(broken)).toThrow(/requires titleUsable===false/);
  });

  it("restrictedUse を safe privacy の source へ付けるとreject", () => {
    const broken: Record<string, TitleSourceDefinition> = {
      ...TITLE_SOURCES,
      bump_events: { ...TITLE_SOURCES.bump_events, titleUsable: false, restrictedUse: "relationship_private_evidence" },
    };
    expect(() => assertRestrictedUseContract(broken)).toThrow(/requires privacy==="restricted"/);
  });

  it("generic source reader coverage に vc_co_presence は含まれない（既存契約の維持）", () => {
    expect(() => assertSourceReaderCoverage()).not.toThrow();
  });

  it("vc_co_presence を readTitleSource() 経由でruleから読めない（既存契約、C2で緩めていないことの回帰確認）", () => {
    const { db, store } = setup();
    const dummy = defineBehaviorTitle({
      kind: "behavior",
      key: "v2.test.dummy",
      name: "dummy",
      description: "scope解決用",
      sources: ["bump_events"],
      triggers: ["bump_success"],
      lifecycle: "active",
      catalog: "test",
      emoji: "x",
      hidden: false,
      publicAnnounce: false,
      themeKey: "t",
      groupKey: "g",
      collectionDomainKey: "d",
      scope: { type: "global" },
    });
    const scope = resolveTitleScope(store, dummy, OBSERVED_AT);
    expect(() => readTitleSource(db, "vc_co_presence" as never, "alice", scope)).toThrow(/not usable by titles/);
  });
});

describe("assertRestrictedUseContract(): unknown restrictedUse値のfail-closed検証（PR #161レビュー）", () => {
  const RESTRICTED_BASE = { privacy: "restricted" as const, titleUsable: false as const };

  it("A. relationship_private_evidence + restricted + titleUsable:false → pass", () => {
    const sources: Record<string, TitleSourceDefinition> = {
      probe: { ...TITLE_SOURCES.vc_co_presence, ...RESTRICTED_BASE, restrictedUse: "relationship_private_evidence" },
    };
    expect(() => assertRestrictedUseContract(sources)).not.toThrow();
  });

  it("B. economy_safe_classification + restricted + titleUsable:false → pass", () => {
    const sources: Record<string, TitleSourceDefinition> = {
      probe: { ...TITLE_SOURCES.ledger_transactions, ...RESTRICTED_BASE, restrictedUse: "economy_safe_classification" },
    };
    expect(() => assertRestrictedUseContract(sources)).not.toThrow();
  });

  it("C. 未知のrestrictedUse値（'future_unknown_use' as any）+ restricted + titleUsable:false → reject（privacy/titleUsableが正しくてもunknown値だけでreject）", () => {
    const sources: Record<string, TitleSourceDefinition> = {
      probe: {
        ...TITLE_SOURCES.vc_co_presence,
        ...RESTRICTED_BASE,
        restrictedUse: "future_unknown_use" as unknown as TitleRestrictedUse,
      },
    };
    expect(() => assertRestrictedUseContract(sources)).toThrow(/unknown restrictedUse/);
  });

  it("D. known value + privacy:safe → reject（既存contractの回帰確認）", () => {
    const sources: Record<string, TitleSourceDefinition> = {
      probe: { ...TITLE_SOURCES.vc_co_presence, privacy: "safe", titleUsable: false, restrictedUse: "relationship_private_evidence" },
    };
    expect(() => assertRestrictedUseContract(sources)).toThrow(/requires privacy==="restricted"/);
  });

  it("E. known value + titleUsable:true → reject（既存contractの回帰確認）", () => {
    const sources: Record<string, TitleSourceDefinition> = {
      probe: { ...TITLE_SOURCES.vc_co_presence, ...RESTRICTED_BASE, titleUsable: true, restrictedUse: "relationship_private_evidence" },
    };
    expect(() => assertRestrictedUseContract(sources)).toThrow(/requires titleUsable===false/);
  });

  it("既存registry（vc_co_presence・ledger_transactions含む）は変わらずpassする", () => {
    expect(() => assertRestrictedUseContract()).not.toThrow();
  });
});

describe("defineRelationshipTitleRule() のsource契約（§6, §43）", () => {
  it("sources: [\"vc_social_safe\"] は正常に通る", () => {
    const rule = alwaysMatchRelationship("v2.test.rel.ok");
    expect(rule.definition.sources).toEqual(["vc_social_safe"]);
  });

  it("sources に vc_social_safe 以外を混ぜるとreject", () => {
    expect(() =>
      defineRelationshipTitleRule(
        {
          kind: "behavior",
          key: "v2.test.rel.bad-source",
          name: "bad",
          description: "テスト",
          sources: ["vc_social_safe", "bump_events"] as unknown as readonly ["vc_social_safe"],
          triggers: ["vc_activity"],
          lifecycle: "active",
          ...COMMON_RELATIONSHIP_FIELDS,
        },
        { awardFactsVersion: 1, evaluateCandidate: () => ({ matched: false }) },
      ),
    ).toThrow(/sources must be exactly \["vc_social_safe"\]/);
  });

  it("sources が空だとreject", () => {
    expect(() =>
      defineRelationshipTitleRule(
        {
          kind: "behavior",
          key: "v2.test.rel.empty-source",
          name: "bad",
          description: "テスト",
          sources: [] as unknown as readonly ["vc_social_safe"],
          triggers: ["vc_activity"],
          lifecycle: "active",
          ...COMMON_RELATIONSHIP_FIELDS,
        },
        { awardFactsVersion: 1, evaluateCandidate: () => ({ matched: false }) },
      ),
    ).toThrow();
  });

  it("vc_co_presence をsourcesへ直接指定してもreject（defineBehaviorTitle()のtitleUsable検証が先に弾く）", () => {
    expect(() =>
      defineRelationshipTitleRule(
        {
          kind: "behavior",
          key: "v2.test.rel.restricted-direct",
          name: "bad",
          description: "テスト",
          sources: ["vc_co_presence"] as unknown as readonly ["vc_social_safe"],
          triggers: ["vc_activity"],
          lifecycle: "active",
          ...COMMON_RELATIONSHIP_FIELDS,
        },
        { awardFactsVersion: 1, evaluateCandidate: () => ({ matched: false }) },
      ),
    ).toThrow(/not usable by titles/);
  });
});

describe("RelationshipTitleRuleResult runtime guard（§10）", () => {
  it("matched:'false'（文字列）はfail-closed", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc1", [0], 100);
    const rule = relationshipRule("v2.test.guard.string-false", () => ({ matched: "false" as never }));
    const plan = defineTitleEvaluationPlan([], [], [rule]);
    expect(() => evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity")).toThrow(/non-boolean matched value/);
  });

  it("matched:false + awardFactsはreject", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc1", [0], 100);
    const rule = relationshipRule("v2.test.guard.false-facts", () => ({ matched: false, awardFacts: {} } as never));
    const plan = defineTitleEvaluationPlan([], [], [rule]);
    expect(() => evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity")).toThrow(/awardFacts set/);
  });

  it("matched:true + awardFacts欠落はreject", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc1", [0], 100);
    const rule = relationshipRule("v2.test.guard.true-missing", () => ({ matched: true } as never));
    const plan = defineTitleEvaluationPlan([], [], [rule]);
    expect(() => evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity")).toThrow();
  });

  it("awardFactsへforbidden key（counterpartId等）を入れるとreject", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc1", [0], 100);
    const rule = relationshipRule("v2.test.guard.bad-facts", () => ({ matched: true, awardFacts: { userId: "alice" } }));
    const plan = defineTitleEvaluationPlan([], [], [rule]);
    expect(() => evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity")).toThrow(/forbidden key/);
  });
});

describe("Relationship rule context leak test（§8, §50）", () => {
  it("evaluateCandidateへ渡るcontext object treeにuserId/counterpart/userA/userB/channelId/jstDays/Database/Storeが存在しない", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc1", [0, 1], 500);

    let observedContext: unknown;
    const rule = relationshipRule("v2.test.leak.context", (ctx) => {
      observedContext = ctx;
      return { matched: false };
    });
    const plan = defineTitleEvaluationPlan([], [], [rule]);
    evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");

    expect(observedContext).toBeDefined();
    const json = JSON.stringify(observedContext);
    for (const forbidden of ["userId", "counterpart", "userA", "userB", "channelId", "jstDays", "alice", "bob"]) {
      expect(json).not.toContain(forbidden);
    }
    const flatKeys = new Set<string>();
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      for (const key of Object.keys(node as Record<string, unknown>)) {
        flatKeys.add(key);
        walk((node as Record<string, unknown>)[key]);
      }
    };
    walk(observedContext);
    expect(flatKeys.has("Database")).toBe(false);
    expect(flatKeys.has("Store")).toBe(false);
    expect(flatKeys.has("db")).toBe(false);
    expect(flatKeys.has("store")).toBe(false);
  });

  it("candidateはrepeatedJstDays/trustedOverlapSecondsだけを持つ", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc1", [0, 1, 2], 1000);

    let observedCandidate: RelationshipCandidateSnapshot | undefined;
    const rule = relationshipRule("v2.test.leak.candidate-shape", (ctx) => {
      observedCandidate = ctx.candidate;
      return { matched: false };
    });
    const plan = defineTitleEvaluationPlan([], [], [rule]);
    evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");

    expect(observedCandidate).toEqual({ repeatedJstDays: 3, trustedOverlapSeconds: 3000 });
    expect(Object.keys(observedCandidate!).sort()).toEqual(["repeatedJstDays", "trustedOverlapSeconds"]);
  });
});

describe("候補の全件評価とdeterministic witness選択（§15, §16, §17, §51, §52）", () => {
  it("bob(10日/10000秒)・charlie(10日/20000秒)・dave(9日/99999秒)が全員matchするfixtureで、witnessはcharlieになる", () => {
    const { db, store } = setup();
    const tenDays = Array.from({ length: 10 }, (_, i) => i);
    const nineDays = Array.from({ length: 9 }, (_, i) => i);
    insertOverlapDays(db, "alice", "bob", "vc-bob", tenDays, 1000); // 10日 * 1000秒 = 10000秒
    insertOverlapDays(db, "alice", "charlie", "vc-charlie", tenDays, 2000); // 10日 * 2000秒 = 20000秒
    insertOverlapDays(db, "alice", "dave", "vc-dave", nineDays, 11111); // 9日 * 11111秒 = 99999秒

    const seenCounterparts: string[] = [];
    const rule = relationshipRule("v2.test.witness.deterministic", (ctx) => {
      seenCounterparts.push(`${ctx.candidate.repeatedJstDays}/${ctx.candidate.trustedOverlapSeconds}`);
      return { matched: true, awardFacts: {} };
    });
    const plan = defineTitleEvaluationPlan([], [], [rule]);
    const result = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");

    expect(result.relationship[0]!.outcome).toBe("awarded");
    // 全員がevaluateされた（3件のcandidateすべてに到達した）。
    expect(seenCounterparts.sort()).toEqual(["10/10000", "10/20000", "9/99999"].sort());

    // public APIにはcharlieもbobもdaveも一切出ない。
    const json = JSON.stringify(result.relationship[0]);
    for (const name of ["bob", "charlie", "dave"]) expect(json).not.toContain(name);

    // private DB tableだけに、実際にcharlieが記録されていることを直接確認する。
    const evidenceRow = db
      .prepare(
        `SELECT counterpart_user_id, repeated_jst_days, trusted_overlap_seconds
           FROM title_relationship_private_evidence WHERE user_id = ? AND title_key = ?`,
      )
      .get("alice", "v2.test.witness.deterministic") as
      | { counterpart_user_id: string; repeated_jst_days: number; trusted_overlap_seconds: number }
      | undefined;
    expect(evidenceRow?.counterpart_user_id).toBe("charlie");
    expect(evidenceRow?.repeated_jst_days).toBe(10);
    expect(evidenceRow?.trusted_overlap_seconds).toBe(20000);
  });

  it("metricsが完全同値の2candidateは、counterpart ID code-unit ASCで内部tie-breakする（localeに依存しない）", () => {
    const { db, store } = setup();
    const days = [0, 1, 2];
    // "aaa" と "zzz" は同じ日数・同じ秒数（完全tie）。code-unit ASCなら"aaa"が勝つ。
    insertOverlapDays(db, "alice", "aaa", "vc-a", days, 500);
    insertOverlapDays(db, "alice", "zzz", "vc-z", days, 500);

    const rule = alwaysMatchRelationship("v2.test.witness.tie");
    const plan = defineTitleEvaluationPlan([], [], [rule]);
    evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");

    const row = db
      .prepare(`SELECT counterpart_user_id FROM title_relationship_private_evidence WHERE user_id = ? AND title_key = ?`)
      .get("alice", "v2.test.witness.tie") as { counterpart_user_id: string } | undefined;
    expect(row?.counterpart_user_id).toBe("aaa");
  });

  it("rule evaluate呼び出し順はcounterpart ID code-unit ASCで決定的——各counterpartに別metricsを持たせてexact orderを直接証明する（round 2レビュー §4）", () => {
    const { db, store } = setup();
    // aaa/mmm/zzzへそれぞれ異なるrepeatedJstDaysを持たせ、observed順から
    // どのcounterpart由来かを一意に特定できるようにする（1日=aaa, 2日=mmm, 3日=zzz）。
    insertOverlapDays(db, "alice", "zzz", "vc-z", [0, 1, 2], 100);
    insertOverlapDays(db, "alice", "aaa", "vc-a", [0], 100);
    insertOverlapDays(db, "alice", "mmm", "vc-m", [0, 1], 100);

    const observedDays: number[] = [];
    const rule = relationshipRule("v2.test.order.deterministic", (ctx) => {
      observedDays.push(ctx.candidate.repeatedJstDays);
      return { matched: false };
    });
    const plan = defineTitleEvaluationPlan([], [], [rule]);
    evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");

    // aaa(1日) → mmm(2日) → zzz(3日) の順（code-unit ASC）で呼ばれたことを直接確認する。
    expect(observedDays).toEqual([1, 2, 3]);
  });

  it("resolveRelationshipCandidates()はcounterpartUserIdをcode-unit ASCでsortして返す（internal importで直接確認）", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "zzz", "vc-z", [0], 100);
    insertOverlapDays(db, "alice", "aaa", "vc-a", [0], 100);
    insertOverlapDays(db, "alice", "mmm", "vc-m", [0], 100);

    const scope = resolveTitleScope(store, alwaysMatchRelationship("v2.test.order.sort-check").definition, OBSERVED_AT);
    const candidates = resolveRelationshipCandidates(db, "alice", scope);
    // candidateにcounterpart identityは公開されていないため、内部importで直接確認する
    // （このテストファイルはcore package内なのでinternal moduleへ直接アクセスできる）。
    expect(candidates.map((c) => c.counterpartUserId)).toEqual(["aaa", "mmm", "zzz"]);
  });

  it("1件でもmatchedならtitleはmatched（複数candidate中1件だけmatch）", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc-bob", [0], 100);
    insertOverlapDays(db, "alice", "charlie", "vc-charlie", [0, 1, 2, 3, 4], 5000);

    const rule = relationshipRule("v2.test.partial-match", (ctx) =>
      ctx.candidate.repeatedJstDays >= 5 ? { matched: true, awardFacts: {} } : { matched: false },
    );
    const plan = defineTitleEvaluationPlan([], [], [rule]);
    const result = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");
    expect(result.relationship[0]!.outcome).toBe("awarded");

    const row = db
      .prepare(`SELECT counterpart_user_id FROM title_relationship_private_evidence WHERE user_id = ? AND title_key = ?`)
      .get("alice", "v2.test.partial-match") as { counterpart_user_id: string } | undefined;
    expect(row?.counterpart_user_id).toBe("charlie");
  });

  it("誰ともmatchしなければnot_matched（evidenceも作られない）", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc1", [0], 100);
    const rule = relationshipRule("v2.test.no-match", () => ({ matched: false }));
    const plan = defineTitleEvaluationPlan([], [], [rule]);
    const result = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");
    expect(result.relationship[0]!.outcome).toBe("not_matched");
    const row = db
      .prepare(`SELECT 1 FROM title_relationship_private_evidence WHERE user_id = ? AND title_key = ?`)
      .get("alice", "v2.test.no-match");
    expect(row).toBeUndefined();
  });

  it("誰とも重ならなければcandidate 0件でnot_matched", () => {
    const { db, store } = setup();
    const rule = alwaysMatchRelationship("v2.test.empty-candidates");
    const plan = defineTitleEvaluationPlan([], [], [rule]);
    const result = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");
    expect(result.relationship[0]!.outcome).toBe("not_matched");
  });
});

describe("private evidence provenance（§18, §19, §29, §49）", () => {
  it("store.awardRelationship()へ手書きevidence objectを渡すとreject", () => {
    const { store } = setup();
    const rule = alwaysMatchRelationship("v2.test.forged.evidence");
    const scope = resolveTitleScope(store, rule.definition, OBSERVED_AT);
    const forged = { repeatedJstDays: 999, trustedOverlapSeconds: 999999 } as never;
    expect(() =>
      store.awardRelationship({
        userId: "alice",
        titleKey: rule.definition.key,
        scope,
        evidence: forged,
        awardFacts: { version: 1, data: {} },
      }),
    ).toThrow(/not produced by the internal candidate resolver/);
  });

  it("title A用に解決したevidenceをtitle Bへsubstituteするとreject", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc1", [0, 1], 1000);
    const ruleA = alwaysMatchRelationship("v2.test.evidence.title-a");
    const ruleB = alwaysMatchRelationship("v2.test.evidence.title-b");

    const scopeA = resolveTitleScope(store, ruleA.definition, OBSERVED_AT);
    const scopeB = resolveTitleScope(store, ruleB.definition, OBSERVED_AT);
    const candidates = resolveRelationshipCandidates(db, "alice", scopeA);
    const evidenceForA = resolveRelationshipPrivateEvidence(candidates[0]!, "alice", ruleA.definition.key, scopeA);

    // titleA向けに解決したevidenceを、titleBのaward()へそのまま渡そうとする。
    expect(() =>
      store.awardRelationship({
        userId: "alice",
        titleKey: ruleB.definition.key,
        scope: scopeB,
        evidence: evidenceForA,
        awardFacts: { version: 1, data: {} },
      }),
    ).toThrow(/different \(user, title, scope\) binding/);
  });

  it("evidenceを別userへsubstituteするとreject", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc1", [0, 1], 1000);
    const rule = alwaysMatchRelationship("v2.test.evidence.user-substitution");
    const scope = resolveTitleScope(store, rule.definition, OBSERVED_AT);
    const candidates = resolveRelationshipCandidates(db, "alice", scope);
    const evidenceForAlice = resolveRelationshipPrivateEvidence(candidates[0]!, "alice", rule.definition.key, scope);

    expect(() =>
      store.awardRelationship({
        userId: "mallory",
        titleKey: rule.definition.key,
        scope,
        evidence: evidenceForAlice,
        awardFacts: { version: 1, data: {} },
      }),
    ).toThrow(/different \(user, title, scope\) binding/);
  });

  it("directのimportで、正しいbindingならawardRelationship()は成立する（陽性経路の確認）", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc1", [0, 1], 1000);
    const rule = alwaysMatchRelationship("v2.test.evidence.positive-path");
    const scope = resolveTitleScope(store, rule.definition, OBSERVED_AT);
    const candidates = resolveRelationshipCandidates(db, "alice", scope);
    const evidence = resolveRelationshipPrivateEvidence(candidates[0]!, "alice", rule.definition.key, scope);

    const result = store.awardRelationship({
      userId: "alice",
      titleKey: rule.definition.key,
      scope,
      evidence,
      awardFacts: { version: 1, data: {} },
    });
    expect(result.status).toBe("awarded");
  });
});

describe("temporal substitution: 同じscopeKeyでもobservedAtが異なる別scopeへのevidence substitutionはreject（round 2レビュー §1 BLOCKER）", () => {
  it("A/B: observedAt=200のscopeで解決したevidence と observedAt=100の別scope は、scopeKeyが同じでも別object", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc-early", [0], 100);
    const rule = alwaysMatchRelationship("v2.test.temporal.identity");

    const earlyObservedAt = jstDayStart(0) + 50_000;
    const lateObservedAt = jstDayStart(10);
    const scopeEarly = resolveTitleScope(store, rule.definition, earlyObservedAt);
    const scopeLate = resolveTitleScope(store, rule.definition, lateObservedAt);

    // globalスコープなのでscopeKeyは同じ文字列だが、object identityは別。
    expect(scopeEarly.scopeKey).toBe(scopeLate.scopeKey);
    expect(scopeEarly).not.toBe(scopeLate);
  });

  it("C: T2まで見て作ったevidenceを、T1<T2の古いscopeへsubstituteするとreject", () => {
    const { db, store, setClock } = setup();
    insertOverlapDays(db, "alice", "bob", "vc-early", [0], 100);
    const rule = alwaysMatchRelationship("v2.test.temporal.late-to-early");

    const earlyObservedAt = jstDayStart(0) + 50_000;
    const scopeEarly = resolveTitleScope(store, rule.definition, earlyObservedAt);

    // T2時点でcharlieとの新しい関係が育っている——T2までのcandidateを見て作ったevidence。
    insertOverlapDays(db, "alice", "charlie", "vc-late", [5, 6], 500);
    const lateObservedAt = jstDayStart(10);
    const scopeLate = resolveTitleScope(store, rule.definition, lateObservedAt);
    const lateCandidates = resolveRelationshipCandidates(db, "alice", scopeLate);
    const lateEvidence = resolveRelationshipPrivateEvidence(lateCandidates[0]!, "alice", rule.definition.key, scopeLate);

    // T2 evidenceを、T1（observedAt=earlyObservedAt）までしか見ていない古いscopeへ
    // substituteしようとする——「T1までしか観測していない評価へfuture evidenceを
    // 混入させる」攻撃で、rejectされなければならない。
    setClock(lateObservedAt + 1000);
    expect(() =>
      store.awardRelationship({
        userId: "alice",
        titleKey: rule.definition.key,
        scope: scopeEarly,
        evidence: lateEvidence,
        awardFacts: { version: 1, data: {} },
      }),
    ).toThrow(/different \(user, title, scope\) binding/);
  });

  it("逆方向: T1までのevidenceをT2の新しいscopeへ渡すのも別object identityなのでreject", () => {
    const { db, store, setClock } = setup();
    insertOverlapDays(db, "alice", "bob", "vc-early", [0], 100);
    const rule = alwaysMatchRelationship("v2.test.temporal.early-to-late");

    const earlyObservedAt = jstDayStart(0) + 50_000;
    const scopeEarly = resolveTitleScope(store, rule.definition, earlyObservedAt);
    const earlyCandidates = resolveRelationshipCandidates(db, "alice", scopeEarly);
    const earlyEvidence = resolveRelationshipPrivateEvidence(earlyCandidates[0]!, "alice", rule.definition.key, scopeEarly);

    const lateObservedAt = jstDayStart(10);
    const scopeLate = resolveTitleScope(store, rule.definition, lateObservedAt);

    setClock(lateObservedAt + 1000);
    expect(() =>
      store.awardRelationship({
        userId: "alice",
        titleKey: rule.definition.key,
        scope: scopeLate,
        evidence: earlyEvidence,
        awardFacts: { version: 1, data: {} },
      }),
    ).toThrow(/different \(user, title, scope\) binding/);
  });

  it("同じexact scope objectを使えば正常award（陽性経路）", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc1", [0, 1], 1000);
    const rule = alwaysMatchRelationship("v2.test.temporal.exact-match");
    const scope = resolveTitleScope(store, rule.definition, OBSERVED_AT);
    const candidates = resolveRelationshipCandidates(db, "alice", scope);
    const evidence = resolveRelationshipPrivateEvidence(candidates[0]!, "alice", rule.definition.key, scope);

    const result = store.awardRelationship({
      userId: "alice",
      titleKey: rule.definition.key,
      scope,
      evidence,
      awardFacts: { version: 1, data: {} },
    });
    expect(result.status).toBe("awarded");
  });
});

describe("candidate issuer hardening（round 2レビュー §3）", () => {
  it("手書きcandidate objectをresolveRelationshipPrivateEvidence()へ渡すとreject", () => {
    const { store } = setup();
    const rule = alwaysMatchRelationship("v2.test.forged.candidate");
    const scope = resolveTitleScope(store, rule.definition, OBSERVED_AT);
    const forgedCandidate = { counterpartUserId: "bob", repeatedJstDays: 999, trustedOverlapSeconds: 999_999 };
    expect(() => resolveRelationshipPrivateEvidence(forgedCandidate, "alice", rule.definition.key, scope)).toThrow(
      /was not produced by resolveRelationshipCandidates/,
    );
  });

  it("resolveRelationshipCandidates()が返したcandidateはそのまま使える（陽性経路）", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc1", [0, 1], 1000);
    const rule = alwaysMatchRelationship("v2.test.legit.candidate");
    const scope = resolveTitleScope(store, rule.definition, OBSERVED_AT);
    const candidates = resolveRelationshipCandidates(db, "alice", scope);
    expect(() => resolveRelationshipPrivateEvidence(candidates[0]!, "alice", rule.definition.key, scope)).not.toThrow();
  });
});

describe("Award atomicity（4-way, §25, §55, §56）", () => {
  it("evidence INSERTだけ失敗させると、award/facts/ownership/rarity/evidence すべてrollbackされる", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc1", [0, 1], 1000);
    db.exec(`
      CREATE TRIGGER sabotage_evidence_insert
      BEFORE INSERT ON title_relationship_private_evidence
      BEGIN
        SELECT RAISE(ABORT, 'sabotage: evidence insert');
      END;
    `);

    const rule = alwaysMatchRelationship("v2.test.atomic.evidence-fail");
    const plan = defineTitleEvaluationPlan([], [], [rule]);
    expect(() => evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity")).toThrow(/sabotage/);

    expect(db.prepare(`SELECT COUNT(*) AS n FROM title_awards WHERE title_key = ?`).get(rule.definition.key)).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM title_award_facts WHERE title_key = ?`).get(rule.definition.key)).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM title_ownerships WHERE title_key = ?`).get(rule.definition.key)).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM title_rarity_sequences WHERE title_key = ?`).get(rule.definition.key)).toEqual({
      n: 0,
    });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM title_relationship_private_evidence WHERE title_key = ?`).get(rule.definition.key),
    ).toEqual({ n: 0 });

    db.exec(`DROP TRIGGER sabotage_evidence_insert;`);
  });

  it("ownership INSERTだけ失敗させると、private evidenceも含めてrollbackされる", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc1", [0, 1], 1000);
    db.exec(`
      CREATE TRIGGER sabotage_ownership_insert
      BEFORE INSERT ON title_ownerships
      BEGIN
        SELECT RAISE(ABORT, 'sabotage: ownership insert');
      END;
    `);

    const rule = alwaysMatchRelationship("v2.test.atomic.ownership-fail");
    const plan = defineTitleEvaluationPlan([], [], [rule]);
    expect(() => evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity")).toThrow(/sabotage/);

    expect(db.prepare(`SELECT COUNT(*) AS n FROM title_awards WHERE title_key = ?`).get(rule.definition.key)).toEqual({ n: 0 });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM title_relationship_private_evidence WHERE title_key = ?`).get(rule.definition.key),
    ).toEqual({ n: 0 });

    db.exec(`DROP TRIGGER sabotage_ownership_insert;`);
  });
});

describe("idempotency（§32, §57）", () => {
  it("first evaluationでbobがwitness→award。後からcharlieの方が強くなってもsecond evaluationはalready_awarded、DBのevidenceはbobのまま", () => {
    const { db, store, setClock } = setup();
    insertOverlapDays(db, "alice", "bob", "vc-bob", [0], 100);

    const rule = alwaysMatchRelationship("v2.test.idempotent.witness");
    const plan = defineTitleEvaluationPlan([], [], [rule]);

    setClock(OBSERVED_AT + 100);
    const first = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");
    expect(first.relationship[0]!.outcome).toBe("awarded");
    const rowAfterFirst = db
      .prepare(`SELECT counterpart_user_id, captured_at FROM title_relationship_private_evidence WHERE user_id = ? AND title_key = ?`)
      .get("alice", "v2.test.idempotent.witness") as { counterpart_user_id: string; captured_at: number };
    expect(rowAfterFirst.counterpart_user_id).toBe("bob");

    // charlieの方がずっと強い関係になった状態で再評価する。
    insertOverlapDays(db, "alice", "charlie", "vc-charlie", [10, 11, 12, 13, 14], 50_000);
    setClock(OBSERVED_AT + 6000);
    const second = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT + 5000, "vc_activity");
    expect(second.relationship[0]!.outcome).toBe("already_awarded");

    const rowAfterSecond = db
      .prepare(`SELECT counterpart_user_id, captured_at FROM title_relationship_private_evidence WHERE user_id = ? AND title_key = ?`)
      .get("alice", "v2.test.idempotent.witness") as { counterpart_user_id: string; captured_at: number };
    expect(rowAfterSecond.counterpart_user_id).toBe("bob");
    expect(rowAfterSecond.captured_at).toBe(rowAfterFirst.captured_at);
  });
});

describe("missing evidence fail-closed（§33, §35, §58）", () => {
  it("award成立後にprivate evidenceだけout-of-bandで削除すると、再評価でfail-closed（自動backfillしない）", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc-bob", [0], 100);
    const rule = alwaysMatchRelationship("v2.test.corruption.missing-evidence");
    const plan = defineTitleEvaluationPlan([], [], [rule]);
    evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");

    db.prepare(`DELETE FROM title_relationship_private_evidence WHERE user_id = ? AND title_key = ?`).run(
      "alice",
      "v2.test.corruption.missing-evidence",
    );

    expect(() => evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT + 100, "vc_activity")).toThrow(
      /without private evidence/,
    );
  });

  it("hasRelationshipAward()もevidence欠損をfail-closedする", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc-bob", [0], 100);
    const rule = alwaysMatchRelationship("v2.test.corruption.has-award-check");
    const plan = defineTitleEvaluationPlan([], [], [rule]);
    evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");

    db.prepare(`DELETE FROM title_relationship_private_evidence WHERE user_id = ? AND title_key = ?`).run(
      "alice",
      "v2.test.corruption.has-award-check",
    );

    expect(() => store.hasRelationshipAward("alice", "v2.test.corruption.has-award-check", "global")).toThrow(
      /without private evidence/,
    );
  });
});

describe("既存evidenceのsemantic re-validation（idempotent re-award時、round 2レビュー §2）", () => {
  it("captured_atをtamperした状態で同じactive ruleを再評価すると、Store再構築なしでもawardRelationship()経路でfail-closed", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc-bob", [0], 100);
    const rule = alwaysMatchRelationship("v2.test.reaward.captured-at-tamper");
    const plan = defineTitleEvaluationPlan([], [], [rule]);
    evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");

    // Storeを再構築せず、DBだけを直接tamperする（construction-time integrityは経由しない）。
    db.prepare(`UPDATE title_relationship_private_evidence SET captured_at = captured_at + 1 WHERE user_id = ? AND title_key = ?`).run(
      "alice",
      "v2.test.reaward.captured-at-tamper",
    );

    // candidateは引き続きmatchする状態のまま、同じruleを再評価する
    // （awardRelationship()のisNewAward=false分岐を通る）。
    expect(() => evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT + 100, "vc_activity")).toThrow(
      /does not match.*awarded_at|captured_at/,
    );
  });

  it("counterpart_user_idを空白のみへtamperした状態で再評価するとfail-closed", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc-bob", [0], 100);
    const rule = alwaysMatchRelationship("v2.test.reaward.whitespace-counterpart");
    const plan = defineTitleEvaluationPlan([], [], [rule]);
    evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");

    db.prepare(`UPDATE title_relationship_private_evidence SET counterpart_user_id = '   ' WHERE user_id = ? AND title_key = ?`).run(
      "alice",
      "v2.test.reaward.whitespace-counterpart",
    );

    expect(() => evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT + 100, "vc_activity")).toThrow(/empty counterpart/);
  });

  it("正常な既存evidenceに対する再評価はalready_awardedのまま成功する（回帰確認）", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc-bob", [0], 100);
    const rule = alwaysMatchRelationship("v2.test.reaward.healthy");
    const plan = defineTitleEvaluationPlan([], [], [rule]);
    evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");

    const result = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT + 100, "vc_activity");
    expect(result.relationship[0]!.outcome).toBe("already_awarded");
  });
});

describe("relationship evidence integrity（§34, §59, §60）", () => {
  it("captured_atがaward.awarded_atと食い違うとStore construction時にfail-closed", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc-bob", [0], 100);
    const rule = alwaysMatchRelationship("v2.test.corruption.captured-at");
    const plan = defineTitleEvaluationPlan([], [], [rule]);
    evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");

    db.prepare(`UPDATE title_relationship_private_evidence SET captured_at = captured_at + 999 WHERE user_id = ?`).run("alice");

    expect(() => new TitleV2Store(db)).toThrow(/captured_at.*does not match/);
  });

  it("user_id === counterpart_user_id の不正rowはDB CHECKでreject", () => {
    const { db } = setup();
    // CHECK単体を確認したいのでevaluatorを経由せず、直接fake award行を用意する。
    db.prepare(`INSERT INTO title_awards (user_id, title_key, scope_key, earned_at, awarded_at) VALUES (?, ?, ?, NULL, ?)`).run(
      "selfuser",
      "v2.test.corruption.self-fixture",
      "global",
      OBSERVED_AT,
    );
    expect(() =>
      db
        .prepare(
          `INSERT INTO title_relationship_private_evidence
             (user_id, title_key, scope_key, evidence_version, counterpart_user_id, repeated_jst_days, trusted_overlap_seconds, captured_at)
           VALUES (?, ?, ?, 1, ?, 1, 1, ?)`,
        )
        .run("selfuser", "v2.test.corruption.self-fixture", "global", "selfuser", OBSERVED_AT),
    ).toThrow(/CHECK/);
  });

  it("counterpartが後にguildを抜けても（membership外部table相当が無くても）evidence自体は壊れない——users table相当へFKしていない", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc-bob", [0], 100);
    const rule = alwaysMatchRelationship("v2.test.no-users-fk");
    const plan = defineTitleEvaluationPlan([], [], [rule]);
    evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");
    // bobがどこにも「存在する」ことを示すレコードが無くても、evidence行はそのまま読める
    // （users相当のテーブルへのFKが無いことの間接確認——他に検証手段が無いため、
    // 単にconstruction integrity/読み取りが例外なく通ることを確認する）。
    expect(() => new TitleV2Store(db)).not.toThrow();
    expect(store.hasRelationshipAward("alice", "v2.test.no-users-fk", "global")).toBe(true);
  });
});

describe("Relationship evaluator lifecycle（§39, §40, §68）", () => {
  it("active: candidate matchでaward", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc1", [0], 100);
    const rule = alwaysMatchRelationship("v2.test.lifecycle.active");
    const plan = defineTitleEvaluationPlan([], [], [rule]);
    const result = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");
    expect(result.relationship[0]!.outcome).toBe("awarded");
  });

  it("retired: 既存awardが無ければskipped、restricted sourceを読みに行かない", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc1", [0], 100);
    const rule = relationshipRule(
      "v2.test.lifecycle.retired-none",
      () => {
        throw new Error("retired titleでcandidateを解決してはいけない");
      },
      { lifecycle: "retired" },
    );
    const plan = defineTitleEvaluationPlan([], [], [rule]);

    const prepareSpy = vi.spyOn(db, "prepare");
    const before = prepareSpy.mock.calls.filter((c) => String(c[0]).includes("FROM vc_segments")).length;
    const result = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");
    const after = prepareSpy.mock.calls.filter((c) => String(c[0]).includes("FROM vc_segments")).length;

    expect(result.relationship[0]!.outcome).toBe("skipped");
    expect(after).toBe(before); // vc_segmentsを一切読みに行っていない
  });

  it("retired: 既存awardがあればalready_awarded（safe existence checkだけ）", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc1", [0], 100);
    const activeVersion = alwaysMatchRelationship("v2.test.lifecycle.retired-existing");
    const plan1 = defineTitleEvaluationPlan([], [], [activeVersion]);
    evaluateUserPipeline(db, store, plan1, "alice", OBSERVED_AT, "vc_activity");

    const retiredVersion = relationshipRule("v2.test.lifecycle.retired-existing", () => ({ matched: true, awardFacts: {} }), {
      lifecycle: "retired",
    });
    const plan2 = defineTitleEvaluationPlan([], [], [retiredVersion]);
    const result = evaluateUserPipeline(db, store, plan2, "alice", OBSERVED_AT + 10, "vc_activity");
    expect(result.relationship[0]!.outcome).toBe("already_awarded");
  });

  it("disabled: evaluateCandidate()自体を呼ばず、restricted sourceも読まない", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc1", [0], 100);
    const rule = relationshipRule(
      "v2.test.lifecycle.disabled",
      () => {
        throw new Error("disabled titleのevaluateCandidate()は呼ばれてはいけない");
      },
      { lifecycle: "disabled" },
    );
    const plan = defineTitleEvaluationPlan([], [], [rule]);

    const prepareSpy = vi.spyOn(db, "prepare");
    const before = prepareSpy.mock.calls.filter((c) => String(c[0]).includes("FROM vc_segments")).length;
    const result = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");
    const after = prepareSpy.mock.calls.filter((c) => String(c[0]).includes("FROM vc_segments")).length;

    expect(result.relationship[0]!.outcome).toBe("skipped");
    expect(result.relationship[0]!.scopeKey).toBeNull();
    expect(after).toBe(before);
  });
});

describe("privacy-oriented read minimization（§68）", () => {
  it("trigger対象外のrelationship ruleはrestricted sourceを読まない", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc1", [0], 100);
    const rule = relationshipRule(
      "v2.test.readmin.wrong-trigger",
      () => {
        throw new Error("trigger対象外のruleでcandidateを解決してはいけない");
      },
      { triggers: ["daily"] },
    );
    const plan = defineTitleEvaluationPlan([], [], [rule]);

    const prepareSpy = vi.spyOn(db, "prepare");
    const before = prepareSpy.mock.calls.filter((c) => String(c[0]).includes("FROM vc_segments")).length;
    evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");
    const after = prepareSpy.mock.calls.filter((c) => String(c[0]).includes("FROM vc_segments")).length;
    expect(after).toBe(before);
  });

  it("generic behavior評価・Meta評価だけのpipeline passでは vc_segments を読まない", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc1", [0], 100);
    const genericRule = defineTitleRule(
      {
        kind: "behavior",
        key: "v2.test.readmin.generic",
        name: "generic",
        description: "テスト",
        sources: ["bump_events"] as const,
        triggers: ["bump_success"],
        lifecycle: "active",
        ...COMMON_RELATIONSHIP_FIELDS,
      },
      { awardFactsVersion: 1, evaluate: () => ({ matched: false, earnedAt: null }) },
    );
    const plan = defineTitleEvaluationPlan([genericRule], []);

    const prepareSpy = vi.spyOn(db, "prepare");
    const before = prepareSpy.mock.calls.filter((c) => String(c[0]).includes("FROM vc_segments")).length;
    evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "bump_success");
    const after = prepareSpy.mock.calls.filter((c) => String(c[0]).includes("FROM vc_segments")).length;
    expect(after).toBe(before);
  });
});

describe("Evaluation Plan integration（§42-47）", () => {
  it("defineTitleEvaluationPlan()は3引数目（relationshipRules）を省略でき、既存2引数呼び出しはそのまま動く", () => {
    const behavior = defineTitleRule(
      {
        kind: "behavior",
        key: "v2.test.plan.two-arg",
        name: "x",
        description: "テスト",
        sources: ["bump_events"] as const,
        triggers: ["bump_success"],
        lifecycle: "active",
        ...COMMON_RELATIONSHIP_FIELDS,
      },
      { awardFactsVersion: 1, evaluate: () => ({ matched: false, earnedAt: null }) },
    );
    const plan = defineTitleEvaluationPlan([behavior], []);
    expect(plan.relationshipRules).toEqual([]);
  });

  it("generic behavior / relationship behavior / meta 全横断でkey重複はreject", () => {
    const generic = defineTitleRule(
      {
        kind: "behavior",
        key: "v2.test.plan.collision",
        name: "x",
        description: "テスト",
        sources: ["bump_events"] as const,
        triggers: ["bump_success"],
        lifecycle: "active",
        ...COMMON_RELATIONSHIP_FIELDS,
      },
      { awardFactsVersion: 1, evaluate: () => ({ matched: false, earnedAt: null }) },
    );
    const relationship = alwaysMatchRelationship("v2.test.plan.collision");
    expect(() => defineTitleEvaluationPlan([generic], [], [relationship])).toThrow(/duplicate title key/);
  });

  it("relationship rule配列にkind spoofされたruleが混入していたらreject", () => {
    const forged: RelationshipTitleRule = {
      definition: { kind: "meta", key: "v2.test.plan.spoofed" } as never,
      awardFactsVersion: 1,
      evaluateCandidate: () => ({ matched: false }),
    };
    expect(() => defineTitleEvaluationPlan([], [], [forged])).toThrow(/must have kind:"behavior"/);
  });

  it("relationship rule配列にsources契約を満たさないruleが混入していたらreject", () => {
    const forged: RelationshipTitleRule = {
      definition: {
        kind: "behavior",
        key: "v2.test.plan.bad-source",
        name: "x",
        description: "テスト",
        sources: ["bump_events"],
        triggers: ["vc_activity"],
        lifecycle: "active",
        ...COMMON_RELATIONSHIP_FIELDS,
      } as never,
      awardFactsVersion: 1,
      evaluateCandidate: () => ({ matched: false }),
    };
    expect(() => defineTitleEvaluationPlan([], [], [forged])).toThrow(/sources must be exactly \["vc_social_safe"\]/);
  });
});

describe("Pipeline order: generic behavior → relationship behavior → series → meta（§45, §46, §47, §48）", () => {
  it("順序どおりに実行され、relationship ownershipもbehaviorOwnershipCountへ数えられる", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc1", [0, 1], 500);

    const relationship = alwaysMatchRelationship("v2.test.order.relationship");
    const meta = defineRelationshipMetaFixture();
    const plan = defineTitleEvaluationPlan([], [meta], [relationship]);

    const result = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");

    expect(result.relationship[0]!.outcome).toBe("awarded");
    // 同一passでmeta側がbehaviorOwnershipCount>=1を見てmatchしている
    // （relationship ownershipがbehaviorOwnershipCountへ数えられている証拠）。
    expect(result.meta[0]!.outcome).toBe("awarded");
  });

  it("TitleUserPipelineResultにrelationshipフィールドが存在し、counterpartを含まない", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc1", [0], 100);
    const rule = alwaysMatchRelationship("v2.test.order.result-shape");
    const plan = defineTitleEvaluationPlan([], [], [rule]);
    const result = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");

    expect(result.relationship).toHaveLength(1);
    const json = JSON.stringify(result);
    expect(json).not.toContain("bob");
  });
});

describe("Plan provenance: relationshipRulesも既存防御を維持する（§44, §69）", () => {
  it("plan構築後に元relationship ruleのtriggers/keyを書き換えても、pipeline semanticsは変化しない", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc1", [0], 100);
    const rule = relationshipRule("v2.test.provenance.rel-triggers", () => ({ matched: true, awardFacts: {} }), {
      triggers: ["vc_activity"],
    });
    const plan = defineTitleEvaluationPlan([], [], [rule]);

    (rule.definition as unknown as { triggers: string[] }).triggers = ["daily"];
    (rule.definition as unknown as { key: string }).key = "v2.test.provenance.rel-hacked";

    const result = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");
    expect(result.relationship[0]!.titleKey).toBe("v2.test.provenance.rel-triggers");
    expect(result.relationship[0]!.outcome).toBe("awarded");
  });

  it("正規plan copyはrelationshipRulesを含めてrejectされる", () => {
    const { db, store } = setup();
    const rule = alwaysMatchRelationship("v2.test.provenance.rel-copy");
    const real = defineTitleEvaluationPlan([], [], [rule]);
    const copied = { ...real };
    expect(() => evaluateUserPipeline(db, store, copied, "alice", OBSERVED_AT, "vc_activity")).toThrow(
      /not produced by defineTitleEvaluationPlan/,
    );
  });
});

describe("no public raw evidence API（§30, §62, §63、round 3レビュー）", () => {
  it("v2.ts はrelationship counterpart raw read APIを一切exportしない", () => {
    const forbidden = [
      "readRelationshipEvidence",
      "relationshipCounterpart",
      "listRelationshipEvidence",
      "buildRelationshipPrivateEvidence",
      "resolveRelationshipCandidates",
      "resolveRelationshipPrivateEvidence",
      "requireRelationshipEvidenceProvenance",
      "evaluateRelationshipTitle",
      "selectPrimaryWitness",
      // computeCoPresenceOverlaps()はuserA/userBを含む生pairwise relationship dataを
      // 返すため、relationship raw resolver APIを非公開にしても、この別経路で
      // counterpart identityへ到達できてしまう（round 3レビューで指摘）。
      "computeCoPresenceOverlaps",
    ];
    for (const name of forbidden) {
      expect((v2Public as Record<string, unknown>)[name]).toBeUndefined();
    }
  });

  it("v2.ts はdefineRelationshipTitleRuleをexportする（公開契約）", () => {
    expect(typeof (v2Public as Record<string, unknown>).defineRelationshipTitleRule).toBe("function");
  });

  it("v2.ts はcomputeSafeSocialAggregates（counterpart identityを含まないsafe aggregate）は引き続きexportする", () => {
    expect(typeof (v2Public as Record<string, unknown>).computeSafeSocialAggregates).toBe("function");
  });

  it("root packages/core/src/index.ts からもrelationship内部APIは未export", async () => {
    const core = await import("../src/index.js");
    expect((core as Record<string, unknown>).evaluateRelationshipTitle).toBeUndefined();
    expect((core as Record<string, unknown>).resolveRelationshipCandidates).toBeUndefined();
  });

  it("root packages/core/src/index.ts からもcomputeCoPresenceOverlapsは未export（package public API全体から到達不能）", async () => {
    const core = await import("../src/index.js");
    expect((core as Record<string, unknown>).computeCoPresenceOverlaps).toBeUndefined();
    expect((core as Record<string, unknown>).CoPresenceOverlap).toBeUndefined();
  });

  it("root packages/core/src/index.ts はcomputeSafeSocialAggregatesは引き続きexportする", async () => {
    const core = await import("../src/index.js");
    expect(typeof (core as Record<string, unknown>).computeSafeSocialAggregates).toBe("function");
  });
});

describe("awardFacts validatorはrelationship titleでも弱めない（§64）", () => {
  it("counterpartId/counterpart_user_id等をawardFactsへ入れるとreject", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc1", [0], 100);
    for (const forbiddenKey of ["counterpartUserId", "counterpart_user_id", "userId", "channelId"]) {
      const rule = relationshipRule(`v2.test.facts-guard.${forbiddenKey}`, () => ({
        matched: true,
        awardFacts: { [forbiddenKey]: "x" },
      }));
      const plan = defineTitleEvaluationPlan([], [], [rule]);
      expect(() => evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity")).toThrow(/forbidden key/);
    }
  });
});

describe("既存VC derived layerのtrust boundaryを迂回しない（§53, §54）", () => {
  it("recovered_estimateの終了はtrustedとして数えない（trust boundaryを維持）", () => {
    const { db, store } = setup();
    const start = jstDayStart(0) + 100;
    // aliceはobserved、bobはrecovered_estimateで終了——co-presence overlapとして
    // 計上されないはず（computeCoPresenceOverlapsは両者ともtrusted end quality を要求する）。
    insertVcSegment(db, "alice", "vc1", start, start + 1000, "observed", "join");
    insertVcSegment(db, "bob", "vc1", start, start + 1000, "recovered_estimate", "join");

    const rule = alwaysMatchRelationship("v2.test.trust.recovered-estimate");
    const plan = defineTitleEvaluationPlan([], [], [rule]);
    const result = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");
    expect(result.relationship[0]!.outcome).toBe("not_matched");
  });

  it("同一秒tie等のsame-second安全側contractをrelationship経路でも独自に迂回しない", () => {
    const { db, store } = setup();
    const t = jstDayStart(0) + 100;
    // 0秒segment（同一秒での入室即退出）は overlap を作らない（end<=startなので除外される）。
    insertVcSegment(db, "alice", "vc1", t, t, "observed", "join");
    insertVcSegment(db, "bob", "vc1", t, t, "observed", "join");

    const rule = alwaysMatchRelationship("v2.test.trust.same-second");
    const plan = defineTitleEvaluationPlan([], [], [rule]);
    const result = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");
    expect(result.relationship[0]!.outcome).toBe("not_matched");
  });
});

describe("Series/Collectionとの関係（§66）", () => {
  it("relationship titleは通常のbehavior titleとしてSeries memberになれる", () => {
    const { db, store } = setup();
    insertOverlapDays(db, "alice", "bob", "vc1", [0, 1], 500);

    const relStage1 = relationshipRule(
      "v2.test.series.rel-stage1",
      () => ({ matched: true, awardFacts: {} }),
    );
    // progressionはBehaviorTitleDefinitionのfieldなので、relationship rule定義にも足せる。
    const relStage1WithProgression = defineRelationshipTitleRule(
      { ...relStage1.definition, progression: { seriesKey: "rel-ignite", stage: 1 } },
      { awardFactsVersion: 1, evaluateCandidate: () => ({ matched: true, awardFacts: {} }) },
    );
    const behaviorStage2 = defineTitleRule(
      {
        kind: "behavior",
        key: "v2.test.series.stage2",
        name: "x",
        description: "テスト",
        sources: ["bump_events"] as const,
        triggers: ["bump_success"],
        lifecycle: "active",
        progression: { seriesKey: "rel-ignite", stage: 2 },
        ...COMMON_RELATIONSHIP_FIELDS,
      },
      { awardFactsVersion: 1, evaluate: () => ({ matched: true, earnedAt: null, awardFacts: {} }) },
    );

    store.registerSeriesManifests(
      [
        {
          catalog: "test",
          seriesKey: "rel-ignite",
          label: "test series",
          masteryEligible: true,
          members: [relStage1WithProgression.definition.key, behaviorStage2.definition.key],
        },
      ],
      [relStage1WithProgression.definition, behaviorStage2.definition],
    );

    const plan = defineTitleEvaluationPlan([behaviorStage2], [], [relStage1WithProgression]);
    const result = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");
    // vc_activity triggerではbehaviorStage2(triggers:bump_success)は評価されないため、
    // relationshipだけがawardされ、まだmasteryは成立しない。
    expect(result.relationship[0]!.outcome).toBe("awarded");
    expect(result.series.newlyMastered).toEqual([]);

    const result2 = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT + 10, "bump_success");
    expect(result2.behavior[0]!.outcome).toBe("awarded");
    expect(result2.series.newlyMastered).toHaveLength(1);
  });
});

describe("historical repairの非主張（§9, §27, §67）", () => {
  it("relationship awardは常にearnedAt=NULL——closed Collection Editionでpost-close awardされてもcreditされない", () => {
    const { db, store, setClock } = setup();
    insertOverlapDays(db, "alice", "bob", "vc1", [0, 1], 500);

    const relTitle = relationshipRule("v2.test.historical.rel", () => ({ matched: true, awardFacts: {} }));
    const definitionsMap = new Map<string, TitleDefinition>([[relTitle.definition.key, relTitle.definition]]);
    const dummyMember = defineTitleRule(
      {
        kind: "behavior",
        key: "v2.test.historical.dummy",
        name: "dummy",
        description: "テスト",
        sources: ["bump_events"] as const,
        triggers: ["bump_success"],
        lifecycle: "active",
        ...COMMON_RELATIONSHIP_FIELDS,
      },
      { awardFactsVersion: 1, evaluate: () => ({ matched: true, earnedAt: null, awardFacts: {} }) },
    );
    definitionsMap.set(dummyMember.definition.key, dummyMember.definition);
    const dummyMember2 = defineTitleRule(
      {
        kind: "behavior",
        key: "v2.test.historical.dummy2",
        name: "dummy2",
        description: "テスト",
        sources: ["bump_events"] as const,
        triggers: ["bump_success"],
        lifecycle: "active",
        ...COMMON_RELATIONSHIP_FIELDS,
      },
      { awardFactsVersion: 1, evaluate: () => ({ matched: true, earnedAt: null, awardFacts: {} }) },
    );
    definitionsMap.set(dummyMember2.definition.key, dummyMember2.definition);

    const edition = {
      editionKey: "rel-closed-edition",
      members: [
        { titleKey: relTitle.definition.key, collectionDomainKey: "test-relationship-domain", collectionCredit: true, fullClearRequired: true },
        { titleKey: dummyMember.definition.key, collectionDomainKey: "test-relationship-domain", collectionCredit: true, fullClearRequired: true },
        { titleKey: dummyMember2.definition.key, collectionDomainKey: "test-relationship-domain", collectionCredit: true, fullClearRequired: false },
      ],
      milestones: { startedCollecting: 1, collectorHabit: 2, stillCollecting: 3, thousandMarks: { count: 3, domains: 1 }, almostComplete: { remaining: 1 } },
    };

    setClock(BASE + 500);
    store.activateCollectionEdition(edition, definitionsMap, "admin");
    setClock(BASE + 1000);
    store.closeCollectionEdition("rel-closed-edition", "admin");
    const closedAt = store.collectionEdition("rel-closed-edition")!.closedAt!;

    // close後にrelationship titleをaward（earnedAt常にNULLなので、close以前の証明にはなり得ない）。
    setClock(closedAt + 100);
    const plan = defineTitleEvaluationPlan([], [], [relTitle]);
    evaluateUserPipeline(db, store, plan, "alice", closedAt + 100, "vc_activity");

    const progress = store.collectionEditionProgress("alice", "rel-closed-edition");
    expect(progress.collectionOwnedCount).toBe(0); // relationship titleはcreditされない
  });
});

function defineRelationshipMetaFixture() {
  return defineMetaTitleRule(
    {
      kind: "meta",
      key: "v2.test.order.meta",
      name: "meta",
      description: "テスト",
      lifecycle: "active",
      emoji: "x",
      hidden: false,
      publicAnnounce: false,
      themeKey: "test-meta-theme",
      groupKey: "test-meta-group",
      scope: { type: "global" },
    },
    {
      awardFactsVersion: 1,
      evaluate: (ctx) => (ctx.snapshot.behaviorOwnershipCount >= 1 ? { matched: true, awardFacts: {} } : { matched: false }),
    },
  );
}
