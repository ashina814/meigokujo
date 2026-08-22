import type Database from "better-sqlite3";
import { defineBehaviorTitle, type BehaviorTitleDefinition } from "./v2-contract.js";
import { assertValidAwardFacts, assertValidFactsVersion, type TitleAwardFacts } from "./v2-award-facts.js";
import { resolveTitleScope, toRuleScope, type TitleEventScopeProvider, type TitleMonthSelector, type TitleRuleScope } from "./v2-scope.js";
import {
  resolveRelationshipCandidates,
  resolveRelationshipPrivateEvidence,
  selectPrimaryWitness,
  type InternalRelationshipCandidate,
} from "./v2-relationship-evidence.js";
import type { TitleAwardOutcome } from "./v2-evaluator.js";
import type { TitleV2Store } from "./v2-store.js";

/**
 * Relationship title評価契約（PR C2）。
 *
 * 「特定の同じ相手との関係が積み重なった」ことを表すbehavior title（将来の再縁・深縁・
 * 腐れ縁・宿縁等）向けの、generic BehaviorTitleRuleとは別の専用契約。generic ruleへ
 * restricted pairwise data（`vc_co_presence`）を渡す設計にはしない——このファイルの
 * `RelationshipTitleRule` は、counterpart identityを一切含まない匿名candidateだけを
 * ruleへ渡す。実際のcounterpart解決・private witness選択は
 * `v2-relationship-evidence.ts`（internal）だけが行う。
 */

/**
 * ruleへ渡す、identityを完全に削った匿名candidate（§7）。
 *
 * 絶対に含めない: counterpartUserId・userA・userB・channelId・parentId・
 * jstDays[]の実日付・visit timestamp・pair index・raw overlap row。
 * ruleが知ってよいのは「匿名のある相手との関係が何日・何秒積み重なったか」まで。
 */
export interface RelationshipCandidateSnapshot {
  readonly repeatedJstDays: number;
  readonly trustedOverlapSeconds: number;
}

/**
 * meta rule contextと同じ思想（§8）——userId・counterpart ID・Database・Store・
 * source cache・全candidate一覧のいずれも持たない。1candidateずつ評価する。
 */
export interface RelationshipTitleRuleContext {
  readonly scope: TitleRuleScope;
  readonly candidate: RelationshipCandidateSnapshot;
}

/**
 * relationship titleについて、earnedAtをruleに決めさせない（§9）。
 * `vc_co_presence`は`orderable: false`であり、秒精度tie/trust境界もあるため、
 * 「N日目を達成した正確な時刻」をprocessing timeから捏造しない——
 * `evaluateRelationshipTitle()`がaward時に常に`earnedAt: null`を固定する。
 */
export type RelationshipTitleRuleResult =
  | { readonly matched: false }
  | { readonly matched: true; readonly awardFacts: TitleAwardFacts };

/**
 * relationship title 1つぶんの判定ロジック。`definition`は`BehaviorTitleDefinition`
 * ——meta titleではなく通常のbehavior titleとして扱う（progression member・
 * Collection Edition memberになれる、ownershipもbehaviorOwnershipCountへ数えられる）。
 *
 * `sources`は今回のrelationship evaluator v1ではVC co-presence専用に限定し、
 * exactly `["vc_social_safe"]` を要求する（§6）。公開semanticとしてrelationship title
 * が依存するのはsafe social source——restricted `vc_co_presence`はtitle condition author
 * へ直接見せるsourceではなく、内部のprivate witness選択にだけ使う。この宣言は
 * `defineBehaviorTitle()`の既存registry検証を再利用するための契約であり、
 * `evaluateRelationshipTitle()`自体は`vc_social_safe`を`readTitleSource()`経由で
 * 実際に読むわけではない（restricted resolverが直接`vc_co_presence`から解決する）。
 */
export interface RelationshipTitleRule {
  readonly definition: BehaviorTitleDefinition & { readonly sources: readonly ["vc_social_safe"] };
  readonly awardFactsVersion: number;
  evaluateCandidate(context: RelationshipTitleRuleContext): RelationshipTitleRuleResult;
}

/** defineRelationshipTitleRule()の第2引数。 */
export interface RelationshipTitleRuleImplementation {
  readonly awardFactsVersion: number;
  evaluateCandidate(context: RelationshipTitleRuleContext): RelationshipTitleRuleResult;
}

/**
 * `defineBehaviorTitle()`のruntime検証に加えて、`sources`が exactly `["vc_social_safe"]`
 * であることを検証したRelationshipTitleRuleを組み立てる。
 */
export function defineRelationshipTitleRule(
  definition: BehaviorTitleDefinition & { readonly sources: readonly ["vc_social_safe"] },
  impl: RelationshipTitleRuleImplementation,
): RelationshipTitleRule {
  const validated = defineBehaviorTitle({
    ...definition,
    sources: [...definition.sources],
    triggers: [...definition.triggers],
  });
  if (validated.sources.length !== 1 || validated.sources[0] !== "vc_social_safe") {
    throw new Error(
      `relationship title ${definition.key}: sources must be exactly ["vc_social_safe"] (got ${JSON.stringify(validated.sources)})`,
    );
  }
  assertValidFactsVersion(impl.awardFactsVersion, `relationship title ${definition.key}: awardFactsVersion`);
  return {
    definition: validated as unknown as BehaviorTitleDefinition & { readonly sources: readonly ["vc_social_safe"] },
    awardFactsVersion: impl.awardFactsVersion,
    evaluateCandidate: impl.evaluateCandidate,
  };
}

/**
 * behavior/meta evaluation resultと形を揃えつつ、counterpart identityを一切含まない
 * （§48）。`privateEvidence`のようなfieldも一切無い——private evidenceはDBだけに残る。
 */
export interface RelationshipTitleEvaluationResult {
  readonly titleKey: string;
  /** disabled titleはscopeを解決しないためnull。 */
  readonly scopeKey: string | null;
  readonly outcome: TitleAwardOutcome;
  readonly matched: boolean;
  /** relationship titleのearnedAtは常にnull（§9, §27）。 */
  readonly earnedAt: null;
  readonly awardFacts?: TitleAwardFacts;
  readonly ownershipCreated?: boolean;
}

export interface RelationshipTitleEvaluationOptions {
  readonly eventProvider?: TitleEventScopeProvider;
  readonly monthSelector?: TitleMonthSelector;
}

/**
 * 1つのrelationship rule × 1人を評価する（internal——`v2.ts`/rootからはexportしない）。
 *
 * - lifecycle:disabled はscopeを解決せず、restricted sourceも読まず、
 *   ruleの`evaluateCandidate()`も呼ばない（§39, §40）。
 * - lifecycle:retired は新規awardしない。既存awardの有無を安全なStore APIだけで確認し
 *   （`store.hasRelationshipAward()`）、**restricted candidateを解決しに行かない**
 *   （§40: privacy minimization——新規awardしない以上、counterpartを新たに知る必要がない）。
 * - lifecycle:active は`resolveRelationshipCandidates()`で匿名candidate一覧を解決し、
 *   counterpartUserId code-unit ASCで決定的な順にruleへ1件ずつ渡す（§15, §17）。
 *   1件でもmatchedなcandidateがあればtitleはmatched。
 * - 複数candidateがmatchedした場合、matchedしたcandidateの中からprimary witnessを
 *   決定的に1人選ぶ（§16、`selectPrimaryWitness()`）。そのwitnessが返したresultの
 *   awardFactsを、award時のsafe awardFactsとして使う。
 * - awardFacts/matched-boolean/lifecycleの検証はbehavior/meta evaluatorと同じ強度で
 *   fail-closedする（§10）。
 */
export function evaluateRelationshipTitle(
  db: Database.Database,
  store: TitleV2Store,
  rule: RelationshipTitleRule,
  userId: string,
  observedAt: number,
  options: RelationshipTitleEvaluationOptions = {},
): RelationshipTitleEvaluationResult {
  // evaluateTitle()/evaluateMetaTitle()と同じ理由——definitionの独立copyをここで作り、
  // rule実装が評価中に自分のdefinitionを書き換えても以降の判定へ影響しないようにする。
  const definition = defineBehaviorTitle({
    ...rule.definition,
    sources: [...rule.definition.sources],
    triggers: [...rule.definition.triggers],
  }) as unknown as BehaviorTitleDefinition & { readonly sources: readonly ["vc_social_safe"] };
  if (definition.sources.length !== 1 || definition.sources[0] !== "vc_social_safe") {
    throw new Error(`relationship title ${definition.key}: sources must be exactly ["vc_social_safe"]`);
  }
  assertValidFactsVersion(rule.awardFactsVersion, `relationship title ${definition.key}: awardFactsVersion`);

  if (definition.lifecycle === "disabled") {
    return { titleKey: definition.key, scopeKey: null, outcome: "skipped", matched: false, earnedAt: null };
  }

  const resolvedScope = resolveTitleScope(store, definition, observedAt, {
    eventProvider: options.eventProvider,
    monthSelector: options.monthSelector,
  });

  if (definition.lifecycle === "retired") {
    const outcome: TitleAwardOutcome = store.hasRelationshipAward(userId, definition.key, resolvedScope.scopeKey)
      ? "already_awarded"
      : "skipped";
    return { titleKey: definition.key, scopeKey: resolvedScope.scopeKey, outcome, matched: false, earnedAt: null };
  }

  const candidates = resolveRelationshipCandidates(db, userId, resolvedScope);
  const ruleScope = toRuleScope(resolvedScope);

  const matchedEntries: Array<{ candidate: InternalRelationshipCandidate; awardFacts: TitleAwardFacts }> = [];
  for (const candidate of candidates) {
    const safeCandidate: RelationshipCandidateSnapshot = Object.freeze({
      repeatedJstDays: candidate.repeatedJstDays,
      trustedOverlapSeconds: candidate.trustedOverlapSeconds,
    });
    const result = rule.evaluateCandidate({ scope: ruleScope, candidate: safeCandidate });

    if (result.matched !== true && result.matched !== false) {
      throw new Error(
        `relationship title rule ${definition.key} returned a non-boolean matched value (contract violation): ${JSON.stringify((result as { matched: unknown }).matched)}`,
      );
    }
    if (!result.matched) {
      if ((result as { awardFacts?: unknown }).awardFacts !== undefined) {
        throw new Error(`relationship title rule ${definition.key} returned matched:false with awardFacts set (contract violation)`);
      }
      continue;
    }
    assertValidAwardFacts(result.awardFacts, `relationship title ${definition.key} awardFacts`);
    matchedEntries.push({ candidate, awardFacts: result.awardFacts });
  }

  if (matchedEntries.length === 0) {
    return { titleKey: definition.key, scopeKey: resolvedScope.scopeKey, outcome: "not_matched", matched: false, earnedAt: null };
  }

  const primary = selectPrimaryWitness(matchedEntries.map((e) => e.candidate))!;
  const primaryEntry = matchedEntries.find((e) => e.candidate.counterpartUserId === primary.counterpartUserId)!;

  const evidence = resolveRelationshipPrivateEvidence(primaryEntry.candidate, userId, definition.key, resolvedScope);

  const awardResult = store.awardRelationship({
    userId,
    titleKey: definition.key,
    scope: resolvedScope,
    evidence,
    awardFacts: { version: rule.awardFactsVersion, data: primaryEntry.awardFacts },
  });

  return {
    titleKey: definition.key,
    scopeKey: resolvedScope.scopeKey,
    outcome: awardResult.status,
    matched: true,
    earnedAt: null,
    awardFacts: primaryEntry.awardFacts,
    ownershipCreated: awardResult.ownershipCreated,
  };
}
