import type Database from "better-sqlite3";
import { computeCoPresenceOverlaps } from "../vc/derived.js";
import {
  assertResolvedTitleScope,
  assertResolvedTitleScopeForTitle,
  resolvedScopeEffectiveEnd,
  type ResolvedTitleScope,
} from "./v2-scope.js";

/**
 * Relationship titleのprivate witness resolution境界（PR C2）。
 *
 * このファイルだけが `computeCoPresenceOverlaps()`（restricted、counterpart identityを
 * 含む生pairwise data）を呼んでよい。generic TitleRule/MetaTitleRuleへ渡すsafe source
 * 境界（`v2-sources.ts` の `readTitleSource()`/`TitleSourceCache`）とは完全に別の経路
 * ——`vc_co_presence` は `TITLE_SOURCES` で `titleUsable: false` のまま維持し、
 * generic source reader coverage（`SOURCE_READERS`）にも追加しない。ここは
 * `RelationshipTitleRule` の評価（`v2-relationship.ts`）専用の内部resolver。
 *
 * `v2.ts`（`@meigokujo/core/titles/v2`）からはこのファイルの何もexportしない——
 * `resolveRelationshipCandidates()`/`resolveRelationshipPrivateEvidence()`は
 * counterpart identityへ到達できるraw経路であり、公開APIにしない。
 */

/** 文字列を単純なUTF-16 code unit順で比較する、locale/ICUに依存しない決定的なorder。 */
function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * internal専用。counterpart identityを含む匿名化前のcandidate。
 * `RelationshipCandidateSnapshot`（`v2-relationship.ts`、公開型）とは別——
 * こちらは内部のprimary witness選択・private evidence永続化にだけ使う。
 */
export interface InternalRelationshipCandidate {
  readonly counterpartUserId: string;
  readonly repeatedJstDays: number;
  readonly trustedOverlapSeconds: number;
}

/**
 * restricted `vc_co_presence`からsubjectの匿名candidate一覧を解決する（internal）。
 *
 * scopeは`ResolvedTitleScope`（`resolveTitleScope()`の産物）だけを受け取り、手書き
 * windowをcallerから受け付けない——`assertResolvedTitleScope()`でforgeryを拒否する。
 * zero-width window（`effectiveEnd <= start`）はcandidate 0件を返す
 * （`v2-sources.ts`のVC readerと同じ扱い）。
 *
 * `computeCoPresenceOverlaps()`が返す`{userA, userB}`のcanonical pairから、
 * subject自身をcounterpartにしないようsubject→counterpart変換を行う。
 * candidateはcounterpartUserIdのcode-unit ASCで決定的にsortしてから返す
 * （§17: rule evaluate呼び出し順もdeterministicにする）。
 */
export function resolveRelationshipCandidates(
  db: Database.Database,
  subjectUserId: string,
  scope: ResolvedTitleScope,
): readonly InternalRelationshipCandidate[] {
  assertResolvedTitleScope(scope);
  const effectiveEnd = resolvedScopeEffectiveEnd(scope);
  if (effectiveEnd <= scope.start) return [];

  const overlaps = computeCoPresenceOverlaps(
    db,
    { start: scope.start, end: effectiveEnd, observedAt: scope.observedAt },
    [subjectUserId],
  );

  const candidates: InternalRelationshipCandidate[] = [];
  for (const o of overlaps) {
    let counterpartUserId: string;
    if (o.userA === subjectUserId) counterpartUserId = o.userB;
    else if (o.userB === subjectUserId) counterpartUserId = o.userA;
    else continue; // 防御的: userIds:[subjectUserId]指定なので通常起こらない
    if (counterpartUserId === subjectUserId) continue; // 防御的: subject自身をcounterpartにしない

    candidates.push({
      counterpartUserId,
      repeatedJstDays: o.jstDays.length,
      trustedOverlapSeconds: o.overlapSeconds,
    });
  }

  candidates.sort((a, b) => compareCodeUnit(a.counterpartUserId, b.counterpartUserId));
  for (const candidate of candidates) ISSUED_CANDIDATES.add(candidate as unknown as object);
  return candidates;
}

/**
 * `resolveRelationshipCandidates()`が実際に発行したcandidate objectだけを認識する
 * WeakSet（round 2レビュー §3、candidate issuer hardening）。手書きの
 * `{counterpartUserId:"bob", repeatedJstDays:999, trustedOverlapSeconds:999999}`の
 * ようなstructural objectを`resolveRelationshipPrivateEvidence()`へ直接渡しても、
 * ここで弾かれてbrandを発行できない——`InternalRelationshipCandidate`は単なる
 * structural interfaceであり、WeakMap/WeakSetのidentity check無しには
 * 「本当にresolverが返したcandidateか」を区別できないため。
 */
const ISSUED_CANDIDATES = new WeakSet<object>();

/**
 * matchedしたcandidateの中から、private evidenceとして保存するprimary witnessを
 * 決定的に1人選ぶ（§16）。
 *
 * 優先順:
 * 1. repeatedJstDays DESC
 * 2. trustedOverlapSeconds DESC
 * 3. counterpartUserId code-unit ASC（内部tie-breakのみ。localeCompareは使わない）
 */
export function selectPrimaryWitness(
  candidates: readonly InternalRelationshipCandidate[],
): InternalRelationshipCandidate | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    if (a.repeatedJstDays !== b.repeatedJstDays) return b.repeatedJstDays - a.repeatedJstDays;
    if (a.trustedOverlapSeconds !== b.trustedOverlapSeconds) return b.trustedOverlapSeconds - a.trustedOverlapSeconds;
    return compareCodeUnit(a.counterpartUserId, b.counterpartUserId);
  })[0]!;
}

// ─────────────────────────────────────────────────────────────
// Private evidence provenance（PR #153 scope provenance・PR #156 plan provenanceと同じ思想）
// ─────────────────────────────────────────────────────────────

/**
 * 型レベルのnominal branding。`v2-scope.ts`の`RESOLVED_SCOPE_BRAND`と同じ理由——
 * runtimeのforgery検知の正本ではなく、TypeScript上のnominal typingのためだけに使う。
 */
const EVIDENCE_BRAND: unique symbol = Symbol("ResolvedRelationshipPrivateEvidence");

/**
 * `resolveRelationshipPrivateEvidence()`が確定した値のcanonical snapshot。counterpartを含む。
 *
 * `scope`は文字列化した`scopeKey`/`observedAt`ではなく、**exact `ResolvedTitleScope`
 * object reference**をそのまま保持する（round 2レビュー §1）。同じ`scopeKey`
 * （例えば`global`）でも、`observedAt`が異なれば別のevaluation windowを表す
 * ——scopeKey/observedAtを別々の文字列/数値として比較すると、「T2以降のデータまで
 * 見て作ったevidence」を「T1までしか見ていない古いResolvedTitleScope」へ
 * substituteできてしまう（scopeKey/subjectUserId/titleKeyだけが一致していれば
 * 通ってしまうため）。exact object identityで比較することで、scopeKey
 * substitution・observedAt substitution・title scope substitutionをまとめて閉じる。
 */
interface RelationshipEvidenceProvenance {
  readonly subjectUserId: string;
  readonly titleKey: string;
  readonly scope: ResolvedTitleScope;
  readonly counterpartUserId: string;
  readonly repeatedJstDays: number;
  readonly trustedOverlapSeconds: number;
}

/**
 * runtimeのforgery検知の正本。keyは`ResolvedRelationshipPrivateEvidence`のexact object
 * identityそのもの——`v2-scope.ts`の`RESOLVED_SCOPE_PROVENANCE`と同じ理由で、
 * `{ ...evidence }`のようなshallow copyやProxyでのラップはここに載らない。
 * counterpartUserIdはこのWeakMapの中にしか存在しない——`ResolvedRelationshipPrivateEvidence`
 * 自身のfieldとしては公開しない（object treeをJSON.stringify()してもcounterpartは出ない）。
 */
const EVIDENCE_PROVENANCE = new WeakMap<object, RelationshipEvidenceProvenance>();

/**
 * `resolveRelationshipPrivateEvidence()`だけが作れる、award()に渡してよいprivate evidence。
 *
 * counterpartUserIdをfieldとして持たない——safeなmetrics（repeatedJstDays/
 * trustedOverlapSeconds）だけを読み取り可能にし、identityはWeakMap経由でしか
 * 取り出せない（`requireRelationshipEvidenceProvenance()`、award境界専用）。
 */
export interface ResolvedRelationshipPrivateEvidence {
  readonly [EVIDENCE_BRAND]: true;
  readonly repeatedJstDays: number;
  readonly trustedOverlapSeconds: number;
}

/**
 * `resolveRelationshipCandidates()`が返したcandidateから、
 * `(subjectUserId, titleKey, scope)`へbindしたcanonical private evidenceを作る
 * （internal——`v2.ts`からはexportしない）。
 *
 * - `candidate`は`ISSUED_CANDIDATES`（`resolveRelationshipCandidates()`が発行した
 *   candidateだけを認識するWeakSet）に含まれることを要求する——手書きcandidateから
 *   evidenceを発行できない（round 2レビュー §3）。
 * - `scope`は`ResolvedTitleScope`そのものを受け取り、`assertResolvedTitleScopeForTitle()`
 *   をここでも通す（round 2レビュー §1）——`titleKey`向けに正規resolveされたscopeで
 *   あることをresolver側でも確認してから、そのexact object referenceをprovenanceへbindする。
 */
export function resolveRelationshipPrivateEvidence(
  candidate: InternalRelationshipCandidate,
  subjectUserId: string,
  titleKey: string,
  scope: ResolvedTitleScope,
): ResolvedRelationshipPrivateEvidence {
  if (!ISSUED_CANDIDATES.has(candidate as unknown as object)) {
    throw new Error(
      "relationship candidate was not produced by resolveRelationshipCandidates() (forged or hand-built InternalRelationshipCandidate)",
    );
  }
  assertResolvedTitleScopeForTitle(scope, titleKey);

  const branded = Object.freeze({
    [EVIDENCE_BRAND]: true,
    repeatedJstDays: candidate.repeatedJstDays,
    trustedOverlapSeconds: candidate.trustedOverlapSeconds,
  }) as ResolvedRelationshipPrivateEvidence;
  EVIDENCE_PROVENANCE.set(
    branded as unknown as object,
    Object.freeze({
      subjectUserId,
      titleKey,
      scope,
      counterpartUserId: candidate.counterpartUserId,
      repeatedJstDays: candidate.repeatedJstDays,
      trustedOverlapSeconds: candidate.trustedOverlapSeconds,
    }),
  );
  return branded;
}

/**
 * `evidence`が本当に`resolveRelationshipPrivateEvidence()`の産物で、指定した
 * `(subjectUserId, titleKey, scope)`向けに作られたことを検証し、counterpartUserIdを
 * 含むcanonical provenanceを返す。`TitleV2Store.awardRelationship()`の入口専用
 * ——callerが手書きの`{counterpartUserId:"...", repeatedJstDays:999}`のようなobjectを
 * 渡してもここでreject（§18）。
 *
 * `scope`は`awardRelationship()`へ渡された**まさにそのResolvedTitleScope object**を
 * 受け取り、evidence解決時に使われたscopeとexact object identityで比較する
 * （round 2レビュー §1）。これにより:
 * - title Aのために解決したevidenceをtitle Bへsubstitute
 * - 別userへsubstitute
 * - 同じscopeKeyだが別observedAt（例: T2まで見て作ったevidenceをT1までしか見ていない
 *   古いscopeへsubstitute）
 * のいずれも一括して拒否できる——scopeKeyを文字列として比較するだけでは
 * observedAtの違いを検出できないため、exact object identityを正本にする。
 */
export function requireRelationshipEvidenceProvenance(
  evidence: ResolvedRelationshipPrivateEvidence,
  subjectUserId: string,
  titleKey: string,
  scope: ResolvedTitleScope,
): RelationshipEvidenceProvenance {
  if (evidence === null || typeof evidence !== "object") {
    throw new Error(
      "relationship private evidence was not produced by the internal candidate resolver (forged or hand-built)",
    );
  }
  const provenance = EVIDENCE_PROVENANCE.get(evidence as unknown as object);
  if (!provenance) {
    throw new Error(
      "relationship private evidence was not produced by the internal candidate resolver (forged, hand-built, cloned, or proxied)",
    );
  }
  if (
    evidence.repeatedJstDays !== provenance.repeatedJstDays ||
    evidence.trustedOverlapSeconds !== provenance.trustedOverlapSeconds
  ) {
    throw new Error("relationship private evidence fields do not match the canonical snapshot recorded at resolution time");
  }
  if (provenance.subjectUserId !== subjectUserId || provenance.titleKey !== titleKey || provenance.scope !== scope) {
    throw new Error(
      `relationship private evidence was resolved for a different (user, title, scope) binding ` +
        `(expected ${subjectUserId}/${titleKey}, exact scope identity mismatch)`,
    );
  }
  return provenance;
}
