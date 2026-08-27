import { createHash } from "node:crypto";
import { CASINO_EDITION_I_MANIFEST } from "../casino/edition-i-manifest.js";
import { TITLE_V2_CATALOG_CANDIDATES } from "./v2-catalog-candidates.js";
import { TITLE_V2_CATALOG_READINESS, type CandidateReadinessAudit } from "./v2-catalog-readiness.js";
import { CASTLE_EXPERIENCE_EDITION_I_MANIFEST } from "./v2-castle-experience-manifest.js";
import { ECONOMY_FEATURE_FAMILY_MANIFEST, ECONOMY_FEATURE_FAMILY_MANIFEST_VERSION } from "./v2-economy.js";
import {
  describeF5cCalibrationProbeContracts,
  F5C_CALIBRATION_PROBES,
  type CalibrationProbeKey,
  type PlanningCalibrationJointEvidence,
} from "./v2-calibration.js";

/** Planning-only contract. Never import from evaluator, pipeline, Bot, or the public v2 barrel. */
export const F5C_SWEEP_CONTRACT_VERSION = 6 as const;

/**
 * PR #190レビュー第3ラウンド§1: 「manifestが将来改訂されても、古いF5c sweep
 * contractは気づかず追従しない」を実際に保証するには、pinされた値と現行canonical
 * 定数を**独立に**表現し、両方が一致することを毎回再検証しなければならない。
 * 以前の実装は`economyManifestRef()`等がその場でcurrent constantを読んで
 * planへ埋め込み、auditも同じbuilderを再実行して比較していたため、manifestが
 * 変わればplan側とaudit側が同時に追従してしまい、drift検出が機能しなかった
 * （self-comparison）。
 *
 * `canonicalManifestFingerprint()`はJSON.stringifyのkey順依存を避けるための
 * 決定的serializer——object key はsort、arrayは要素順を保持する。
 */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function canonicalManifestFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

export interface F5cManifestPinEconomy {
  readonly kind: "ECONOMY_SEMANTIC_FAMILIES";
  readonly version: number;
  readonly familyKeys: readonly string[];
  readonly fingerprint: string;
}
export interface F5cManifestPinCasinoEdition {
  readonly kind: "CASINO_EDITION";
  readonly editionKey: string;
  readonly version: number;
  readonly families: readonly { readonly familyKey: string; readonly activityKeys: readonly string[] }[];
  readonly fingerprint: string;
}
export interface F5cManifestPinCastleEdition {
  readonly kind: "CASTLE_EDITION";
  readonly editionKey: string;
  readonly version: number;
  readonly families: readonly { readonly familyKey: string; readonly superDomain: string }[];
  readonly fingerprint: string;
}
export type F5cManifestPin = F5cManifestPinEconomy | F5cManifestPinCasinoEdition | F5cManifestPinCastleEdition;

function economyFingerprintPayload() {
  return { version: ECONOMY_FEATURE_FAMILY_MANIFEST_VERSION, familyKeys: [...Object.keys(ECONOMY_FEATURE_FAMILY_MANIFEST)].sort() };
}
function casinoEditionFingerprintPayload() {
  return {
    editionKey: CASINO_EDITION_I_MANIFEST.editionKey,
    version: CASINO_EDITION_I_MANIFEST.version,
    families: CASINO_EDITION_I_MANIFEST.families.map((f) => ({ familyKey: f.familyKey, activityKeys: [...f.activityKeys] })),
  };
}
function castleEditionFingerprintPayload() {
  return {
    editionKey: CASTLE_EXPERIENCE_EDITION_I_MANIFEST.editionKey,
    version: CASTLE_EXPERIENCE_EDITION_I_MANIFEST.version,
    families: CASTLE_EXPERIENCE_EDITION_I_MANIFEST.families.map((f) => ({ familyKey: f.familyKey, superDomain: f.superDomain })),
  };
}

/**
 * F5c1が最初にsweep contractへ固定した時点(contract version 3)のmanifest snapshot。
 * ここは**現行constantを呼び出して生成しない**——手で書いた/一度だけ生成して
 * 固定したliteral値であること自体が、drift guardの前提。`docs/titles-v2-design.md`
 * の`FROZEN_CATALOG_99_FINAL_SHA256`と同じ考え方——値が変わったら、このPRの
 * 生成手順を再実行して意図的に更新する。fingerprintは`canonicalManifestFingerprint()`
 * で独立に再計算し、`liveManifestFingerprint()`（現行constantを読む側）と
 * 一致するかをauditが毎回検証する。
 */
/**
 * PR #191レビュー第2ラウンド§3: F5c2はこのpinを直接参照する——family/super-domain
 * cardinality（economy=3、casino edition=8、castle edition=7 family/3 super-domain）を
 * F5c2側で再度hardcodeしない。F5c1のpinned contractが変わればF5c2も自動的に追従する
 * （F5c2側は独自のfingerprint再計算をしない——それはこのfileのaudit専用）。
 */
export const F5C1_MANIFEST_PINS: {
  readonly ECONOMY_SEMANTIC_FAMILIES: F5cManifestPinEconomy;
  readonly CASINO_EDITION: F5cManifestPinCasinoEdition;
  readonly CASTLE_EDITION: F5cManifestPinCastleEdition;
} = Object.freeze({
  ECONOMY_SEMANTIC_FAMILIES: Object.freeze({
    kind: "ECONOMY_SEMANTIC_FAMILIES",
    version: 1,
    familyKeys: Object.freeze(["peer_transfer", "shop", "tip"]),
    fingerprint: "e5c8ddef21dd8718344b1dd6f4304b533e5d2c44c4a3a972843eeed6de94cd11",
  }),
  CASINO_EDITION: Object.freeze({
    kind: "CASINO_EDITION",
    editionKey: "casino-edition-i",
    version: 1,
    families: Object.freeze([
      Object.freeze({ familyKey: "slots", activityKeys: Object.freeze(["slots"]) }),
      Object.freeze({ familyKey: "chohan", activityKeys: Object.freeze(["chohan"]) }),
      Object.freeze({ familyKey: "crash", activityKeys: Object.freeze(["crash"]) }),
      Object.freeze({ familyKey: "chinchiro", activityKeys: Object.freeze(["chinchiro"]) }),
      Object.freeze({ familyKey: "roulette", activityKeys: Object.freeze(["roulette"]) }),
      Object.freeze({ familyKey: "blackjack", activityKeys: Object.freeze(["blackjack"]) }),
      Object.freeze({ familyKey: "poker", activityKeys: Object.freeze(["poker"]) }),
      Object.freeze({ familyKey: "holdem", activityKeys: Object.freeze(["holdem"]) }),
    ]),
    fingerprint: "75c514ce7b5560e1aa315cd8234a2b2465c32c9a55c3dc4bb4f041a7eeba9ea2",
  }),
  CASTLE_EDITION: Object.freeze({
    kind: "CASTLE_EDITION",
    editionKey: "castle-experience-edition-i",
    version: 1,
    families: Object.freeze([
      Object.freeze({ familyKey: "public_vc", superDomain: "social" }),
      Object.freeze({ familyKey: "public_tc", superDomain: "social" }),
      Object.freeze({ familyKey: "public_room", superDomain: "social" }),
      Object.freeze({ familyKey: "economy", superDomain: "economy_play" }),
      Object.freeze({ familyKey: "shop", superDomain: "economy_play" }),
      Object.freeze({ familyKey: "casino", superDomain: "economy_play" }),
      Object.freeze({ familyKey: "public_event", superDomain: "castle_wide" }),
    ]),
    fingerprint: "84ca499223dc4aaf680498c0f8f50f358757a65e3109a98aa04355b01b4e0e1e",
  }),
});

/** auditだけが呼ぶ——現行constantを毎回そのまま読んで再計算する側。pin側とは独立。 */
function liveManifestFingerprint(kind: F5cManifestRef["kind"]): string {
  if (kind === "ECONOMY_SEMANTIC_FAMILIES") return canonicalManifestFingerprint(economyFingerprintPayload());
  if (kind === "CASINO_EDITION") return canonicalManifestFingerprint(casinoEditionFingerprintPayload());
  return canonicalManifestFingerprint(castleEditionFingerprintPayload());
}

export type F5cEvaluationShape =
  | "STRUCTURAL_PRESENCE"
  | "MANIFEST_CONFORMANCE"
  | "DISTRIBUTION_THRESHOLD"
  | "MULTI_METRIC_CONJUNCTION"
  | "JOINT_CORRELATION"
  | "STRUCTURAL_PLUS_DISTRIBUTION";

export type F5cSweepOperator = "AT_LEAST" | "AT_MOST";

/**
 * PR #190レビュー§6: JOINT_EVIDENCE axisはselector/operator/boundaryMethodだけでは
 * 「F5c2がそのselectorをどう subject-level scalar/qualification へ還元するか」を
 * 表現できない——selectorは複数timestamp/gap/grouped profile/graph edge/circular
 * hour/branch structureのいずれにもなり得る。有限のreducerKindだけで実際の
 * READY-76 candidateが必要とするpatternを列挙する（汎用DSLは作らない）。
 *
 * - SCALAR_METRIC: METRIC axis専用。probeが既に計算したsubject-level scalar。
 * - SCALAR_SAMPLE: joint evidence row 1件が持つ生の数値サンプル（gap ms、seconds、
 *   breadth等）をそのままrow-level filterのboundaryとしてsweepする。
 * - FILTER_THEN_COUNT: 同じrow group内で他のSCALAR_SAMPLE filterを満たした
 *   row数を数える。
 * - FILTER_THEN_DISTINCT_DAYS: 同じrow group内でfilterを満たしたrowのdistinct
 *   day数を数える。
 * - FILTER_THEN_SHARE: 同じrow group内でfilterを満たした量/件数の、groupの
 *   総量に対するshare（比率）。
 * - GROUP_FILTER_THEN_MAX: 同じrow groupをsub-groupへ分け、filter後のsub-group内
 *   最大値を取る（例: 同一counterpartとの最大反復日数）。
 * - POST_FILTER_MATCHING_SIZE: edgeをSCALAR_SAMPLE filterで絞った後、
 *   maximum bipartite matchingを絞り込み後のedge集合から再計算した
 *   matching sizeというsubject-level整数（filter前のstructuralMaxを流用しない）。
 *   edge閾値を固定すればsubjectごとに1個の整数になる正当なsample集合なので、
 *   通常のOBSERVED_NEAREST_RANK sweepの対象になる——PR #190レビュー第3ラウンド§3。
 * - CIRCULAR_HOUR_WINDOW: 24 JST hour binは循環しており、単一のAT_LEAST/AT_MOST
 *   hour boundaryでは表現できない。F5c2が後で24 binの中からbounded windowを
 *   列挙する——F5c1はどのwindowも選ばない。
 * - SET_BREADTH: 同じrow groupから導出したdistinct member集合（branch、family、
 *   reactor等）の breadth（要素数）。
 * - REPEAT_PERIOD: 同一counterpart/branch/familyに対する反復qualifying period
 *   （day等）の数。
 * - FILTER_THEN_SPAN_DAYS: 同じrow groupでfilterを満たしたrowのdayOffset集合から
 *   span（max-min+1）を求める。空集合はnull。FILTER_THEN_DISTINCT_DAYS（件数）とは
 *   別概念——PR #190レビュー第3ラウンド§4。
 */
export type F5cAxisReducerKind =
  | "SCALAR_METRIC"
  | "SCALAR_SAMPLE"
  | "FILTER_THEN_COUNT"
  | "FILTER_THEN_DISTINCT_DAYS"
  | "FILTER_THEN_SHARE"
  | "FILTER_THEN_SPAN_DAYS"
  | "GROUP_FILTER_THEN_MAX"
  | "POST_FILTER_MATCHING_SIZE"
  | "CIRCULAR_HOUR_WINDOW"
  | "SET_BREADTH"
  | "REPEAT_PERIOD";

interface F5cMetricAxis {
  readonly axisKey: string;
  readonly source: "METRIC";
  readonly metricKey: string;
  readonly operator: F5cSweepOperator;
  readonly boundaryMethod: "OBSERVED_NEAREST_RANK";
  readonly reducerKind: "SCALAR_METRIC";
}

/** genuinely sweepable numeric per-row/per-subject sample; nearest-rank boundary selection applies. */
type F5cJointSweepableReducerKind = Exclude<F5cAxisReducerKind, "SCALAR_METRIC" | "CIRCULAR_HOUR_WINDOW">;

interface F5cJointThresholdAxis {
  readonly axisKey: string;
  readonly source: "JOINT_EVIDENCE";
  readonly selector: string;
  /** axes（同一planの他axis含む）で同じ生row集合から導出される場合、同じ文字列を共有する。 */
  readonly rowGroupKey: string;
  readonly operator: F5cSweepOperator;
  readonly boundaryMethod: "OBSERVED_NEAREST_RANK";
  readonly reducerKind: F5cJointSweepableReducerKind;
}

/**
 * PR #191レビュー第3ラウンド§2: 同じCIRCULAR_HOUR_WINDOW axis shapeが、実際には
 * 構造的に異なる3つのcircular意味論を表していた——F5c2はselector/rowGroupKey以外に
 * 区別する型情報を持たなかったため、No.32-35の異なるdaypart target全てを同じ
 * 「母集団全体でのbest 8-hour window」へ収束させてしまい得た。以下の有限型は、
 * どのhour境界も選ばずに「どの構造パターンか」だけを宣言する。
 *
 * - `DAYPART_TARGET`: 24時間を4等分した中立的なquadrant（QUADRANT_0=[0,6)、
 *   QUADRANT_1=[6,12)、QUADRANT_2=[12,18)、QUADRANT_3=[18,24) —
 *   "morning/afternoon"等のuser-facing labelでも本番のwindow長・境界でもない、
 *   単にNo.32-35のsearch領域を互いに分離するための固定index。文字列labelにして
 *   いるのは、`auditF5cCandidateSweepPlans()`の`numericThresholdValueCount`
 *   （axes内の数値literalは production threshold の疑いとして数える既存guard）が
 *   これを誤ってthreshold値として検出しないようにするため——実際には閾値では
 *   なく、単なる分類indexである。PR #191レビュー第4ラウンド§3: F5c2はsubjectを
 *   このquadrant「ちょうど」に対して評価する（windowをquadrant境界の外まで
 *   探索しない）——ある候補が別のdaypartに明確に属する活動から代表意味を
 *   導出できないようにするため。
 * - `PERSONAL_STABILITY`: 母集団共通のwindowを選ばず、各subject自身のrowだけ
 *   から求めた「自分にとって最良のwindowの占有率」を求め、percentile軸として
 *   扱う——「母集団で人気の時間帯かどうか」ではなく「本人がどれだけ安定して
 *   いるか」を測る（No.36）。
 * - `MULTI_DAYPART_BREADTH`: 上と同じ4 quadrantのうち、subjectがqualifying row
 *   を持つdistinct quadrant数を求め、percentile軸として扱う——1つの連続windowに
 *   収まる集中（一晩の徹夜等）とは構造的に区別される（No.37）。
 */
export type F5cCircularQuadrant = "QUADRANT_0" | "QUADRANT_1" | "QUADRANT_2" | "QUADRANT_3";
export type F5cCircularIntent =
  | { readonly kind: "DAYPART_TARGET"; readonly quadrant: F5cCircularQuadrant }
  | { readonly kind: "PERSONAL_STABILITY" }
  | { readonly kind: "MULTI_DAYPART_BREADTH" };

interface F5cJointCircularHourAxis {
  readonly axisKey: string;
  readonly source: "JOINT_EVIDENCE";
  readonly selector: string;
  readonly rowGroupKey: string;
  readonly reducerKind: "CIRCULAR_HOUR_WINDOW";
  readonly boundaryMethod: "CIRCULAR_CANDIDATE_ENUMERATION";
  readonly circularIntent: F5cCircularIntent;
}

export type F5cSweepAxis = F5cMetricAxis | F5cJointThresholdAxis | F5cJointCircularHourAxis;

export interface F5cRequiredJointEvidence {
  readonly kind: PlanningCalibrationJointEvidence["kind"];
  readonly selectors: readonly string[];
}

/**
 * PR #190レビュー第3ラウンド§5: `rowGroupKey`だけでは「同じrowから導出される」
 * ことしか示さず、複数のSCALAR_SAMPLE filter axisが同じrow groupを共有する場合に
 * それらがconjunctive（同一rowが全filterを満たす必要がある、No.42のTC start）
 * なのかdisjunctive（いずれかのfilterを満たせばよい、No.32-37のTC/VC
 * multimodal social evidence）なのかをF5c2が推測してはならない。有限のcomposition
 * mode（ALL_FILTERS/ANY_FILTER）だけを許可する——汎用boolean DSLは作らない。
 */
export type F5cRowGroupCompositionMode = "ALL_FILTERS" | "ANY_FILTER";
export interface F5cRowGroupComposition {
  readonly rowGroupKey: string;
  readonly composition: F5cRowGroupCompositionMode;
}
function rowGroupComposition(rowGroupKey: string, composition: F5cRowGroupCompositionMode): F5cRowGroupComposition {
  return { rowGroupKey, composition };
}

/**
 * PR #190レビュー§2: structuralRequirementsのprose文だけでは、F5c2がre-interpretation
 * 無しに実行できない。全fixedCriteriaはANDされる——分布境界を選ばない、catalog意味論
 * そのものが固定するsemantic constantだけを表現する（§3: THRESHOLD_PENDINGの
 * distribution boundaryではない）。ANY_METRIC_POSITIVEだけが明示的なORケース
 * （例: event staff-or-organizer）。汎用expression言語は作らない。
 */
export type F5cFixedCriterion =
  | { readonly kind: "METRIC_COMPARE"; readonly metricKey: string; readonly operator: "GT" | "GTE" | "EQ"; readonly fixedValue: number }
  | { readonly kind: "METRIC_BOOLEAN_TRUE"; readonly metricKey: string }
  | { readonly kind: "ANY_METRIC_POSITIVE"; readonly metricKeys: readonly string[] }
  | { readonly kind: "JOINT_STRUCTURAL_FACT"; readonly selector: string };

/**
 * PR #190レビュー§5: MANIFEST_DEPENDENT planは「現行Castle Edition-Iマニフェスト」の
 * ようなprose参照だけに頼っていた。実際のcanonical versioned manifest定数を直接
 * 参照する（値を複製しない）——後でmanifestが改訂されても、古いF5c sweep contractを
 * 気づかず変えないようにするため。
 */
export type F5cManifestRef =
  | { readonly kind: "ECONOMY_SEMANTIC_FAMILIES"; readonly version: number }
  | { readonly kind: "CASINO_EDITION"; readonly editionKey: string; readonly version: number }
  | { readonly kind: "CASTLE_EDITION"; readonly editionKey: string; readonly version: number };

/**
 * PR #190レビュー第3ラウンド§2: manifestRefは「どの universe を見るか」だけを
 * 特定し、「その universe に対して候補が何を要求するか」は特定しない。
 * MANIFEST_DEPENDENTの6候補それぞれの意味（複数family、ALL family完了、
 * super-domain coverage、almost-all breadth等）を型で持つ。数はcatalog意味論
 * 自体が固定する場合だけ埋める（"multiple"=2等）——productionのTHRESHOLD_PENDING
 * distribution boundaryではない。"almost all"のような未決定cardinalityは
 * `MANIFEST_CARDINALITY_SWEEP`で「まだ値を選んでいない」ことを明示するだけに
 * とどめ、production numberを発明しない。
 */
export type F5cManifestCriterion =
  | { readonly kind: "ALL_MANIFEST_MEMBERS"; readonly countMetricKey: string }
  | { readonly kind: "AT_LEAST_FIXED_DISTINCT_MEMBERS"; readonly countMetricKey: string; readonly fixedValue: number }
  | { readonly kind: "ALL_REQUIRED_SUPERDOMAINS"; readonly countMetricKey: string }
  | { readonly kind: "MANIFEST_CARDINALITY_SWEEP"; readonly countMetricKey: string };

function allManifestMembers(countMetricKey: string): F5cManifestCriterion {
  return { kind: "ALL_MANIFEST_MEMBERS", countMetricKey };
}
function atLeastFixedDistinctMembers(countMetricKey: string, fixedValue: number): F5cManifestCriterion {
  return { kind: "AT_LEAST_FIXED_DISTINCT_MEMBERS", countMetricKey, fixedValue };
}
function allRequiredSuperdomains(countMetricKey: string): F5cManifestCriterion {
  return { kind: "ALL_REQUIRED_SUPERDOMAINS", countMetricKey };
}
function manifestCardinalitySweep(countMetricKey: string): F5cManifestCriterion {
  return { kind: "MANIFEST_CARDINALITY_SWEEP", countMetricKey };
}

/**
 * PR #190レビュー第3ラウンド§1: このplanへ埋め込むmanifestRefは、pinされた
 * `F5C1_MANIFEST_PINS`だけから作る——`CASINO_EDITION_I_MANIFEST`等の現行constantを
 * ここで直接読まない。現行constantを読むのは`liveManifestFingerprint()`（audit専用）
 * だけであり、この2つの経路が独立していることがdrift guardの前提。
 */
function economyManifestRef(): F5cManifestRef {
  const pin = F5C1_MANIFEST_PINS.ECONOMY_SEMANTIC_FAMILIES;
  return { kind: "ECONOMY_SEMANTIC_FAMILIES", version: pin.version };
}
function casinoEditionManifestRef(): F5cManifestRef {
  const pin = F5C1_MANIFEST_PINS.CASINO_EDITION;
  return { kind: "CASINO_EDITION", editionKey: pin.editionKey, version: pin.version };
}
function castleEditionManifestRef(): F5cManifestRef {
  const pin = F5C1_MANIFEST_PINS.CASTLE_EDITION;
  return { kind: "CASTLE_EDITION", editionKey: pin.editionKey, version: pin.version };
}

/**
 * PR #190レビュー第4ラウンド§2: `axes`配列内の全axisは、rowGroupKeyの異同に
 * 関わらず、plan全体としてconjunctive（AND）である——これはREADY-76の76 plan
 * 全てに例外なく適用される単一の不変条件（`evaluationShape`が
 * `MULTI_METRIC_CONJUNCTION`/`JOINT_CORRELATION`と名付けられているのもこの
 * ためであり、per-plan boolean fieldとしては表現しない。何も選択しない）。
 * disjunction（OR）は`rowGroupCompositions`の`ANY_FILTER`だけが表現でき、
 * それも同一rowGroupKeyを共有するSCALAR_SAMPLE filter axis同士に限定される
 * ——別々のrowGroupから導出された2つのaxis（例: No.49のtc-qualifying-days /
 * vc-qualifying-days）の間には、常にANDだけが存在し、それ以外の合成は
 * この契約に存在しない。
 */
export interface F5cCandidateSweepPlan {
  readonly candidateNo: number;
  readonly provisionalKey: string;
  readonly probeKey: CalibrationProbeKey;
  readonly thresholdCategory: CandidateReadinessAudit["thresholdCategory"];
  readonly optimizationRisk: CandidateReadinessAudit["optimizationRisk"];
  readonly measurementStatus: "MEASURED" | "MEASUREMENT_GAP";
  readonly gapReason: string | null;
  readonly evaluationShape: F5cEvaluationShape;
  readonly requiredMetrics: readonly string[];
  readonly requiredJointEvidence: F5cRequiredJointEvidence;
  readonly axes: readonly F5cSweepAxis[];
  readonly fixedCriteria: readonly F5cFixedCriterion[];
  readonly manifestRef: F5cManifestRef | null;
  readonly manifestCriteria: readonly F5cManifestCriterion[];
  readonly rowGroupCompositions: readonly F5cRowGroupComposition[];
  readonly structuralRequirements: readonly string[];
  readonly coverageNotes: readonly string[];
  readonly releaseGateNotes: readonly string[];
}

interface PlanInput {
  readonly no: number;
  readonly evaluationShape: F5cEvaluationShape;
  readonly requiredMetrics: readonly string[];
  readonly requiredJointEvidence?: F5cRequiredJointEvidence;
  readonly axes?: readonly F5cSweepAxis[];
  readonly fixedCriteria?: readonly F5cFixedCriterion[];
  readonly manifestRef?: F5cManifestRef;
  readonly manifestCriteria?: readonly F5cManifestCriterion[];
  readonly rowGroupCompositions?: readonly F5cRowGroupComposition[];
  readonly structuralRequirements?: readonly string[];
  readonly coverageNotes?: readonly string[];
  readonly releaseGateNotes?: readonly string[];
  /** measuredPlan()/gapPlan()経由でのみ設定する。呼び出し側が直接defaultへ頼ることはできない。 */
  readonly measurementStatus: F5cCandidateSweepPlan["measurementStatus"];
  readonly gapReason?: string;
}

const NONE = Object.freeze({ kind: "none", selectors: Object.freeze([]) }) satisfies F5cRequiredJointEvidence;
const COVERAGE_NOTE = "Unknown or pre-rollout source coverage must remain distinct from observed zero activity.";

function metricAxis(axisKey: string, metricKey: string, operator: F5cSweepOperator = "AT_LEAST"): F5cMetricAxis {
  return { axisKey, source: "METRIC", metricKey, operator, boundaryMethod: "OBSERVED_NEAREST_RANK", reducerKind: "SCALAR_METRIC" };
}

function jointThresholdAxis(
  axisKey: string,
  selector: string,
  reducerKind: F5cJointSweepableReducerKind,
  rowGroupKey: string,
  operator: F5cSweepOperator = "AT_LEAST",
): F5cJointThresholdAxis {
  return { axisKey, source: "JOINT_EVIDENCE", selector, rowGroupKey, operator, boundaryMethod: "OBSERVED_NEAREST_RANK", reducerKind };
}

function circularHourAxis(axisKey: string, selector: string, rowGroupKey: string, circularIntent: F5cCircularIntent): F5cJointCircularHourAxis {
  return { axisKey, source: "JOINT_EVIDENCE", selector, rowGroupKey, reducerKind: "CIRCULAR_HOUR_WINDOW", boundaryMethod: "CIRCULAR_CANDIDATE_ENUMERATION", circularIntent };
}

function metricAtLeast(metricKey: string, fixedValue: number): F5cFixedCriterion {
  return { kind: "METRIC_COMPARE", metricKey, operator: "GTE", fixedValue };
}
function metricBooleanTrue(metricKey: string): F5cFixedCriterion {
  return { kind: "METRIC_BOOLEAN_TRUE", metricKey };
}
function anyMetricPositive(...metricKeys: readonly string[]): F5cFixedCriterion {
  return { kind: "ANY_METRIC_POSITIVE", metricKeys };
}
function jointStructuralFact(selector: string): F5cFixedCriterion {
  return { kind: "JOINT_STRUCTURAL_FACT", selector };
}

function joint(kind: Exclude<PlanningCalibrationJointEvidence["kind"], "none">, ...selectors: string[]): F5cRequiredJointEvidence {
  return { kind, selectors };
}

/** internal shared constructor. Never call directly from PLAN_INPUTS — use measuredPlan()/gapPlan(). */
function plan(
  no: number,
  evaluationShape: F5cEvaluationShape,
  requiredMetrics: readonly string[],
  measurementStatus: F5cCandidateSweepPlan["measurementStatus"],
  options: Omit<PlanInput, "no" | "evaluationShape" | "requiredMetrics" | "measurementStatus"> = {},
): PlanInput {
  return { no, evaluationShape, requiredMetrics, measurementStatus, ...options };
}

/**
 * PR #190レビュー§12: measurementStatusのdefaultは廃止した——`MEASURED`は必ず
 * 明示的にここを経由する。
 */
function measuredPlan(
  no: number,
  evaluationShape: F5cEvaluationShape,
  requiredMetrics: readonly string[],
  options: Omit<PlanInput, "no" | "evaluationShape" | "requiredMetrics" | "measurementStatus" | "gapReason"> = {},
): PlanInput {
  return plan(no, evaluationShape, requiredMetrics, "MEASURED", options);
}

/**
 * PR #190レビュー§12: MEASUREMENT_GAPは`gapReason`を必須にし、sweep axisを
 * 一切持てない（実行可能に見せかけることを禁じる）。現行READY-76のどのcandidateも
 * 実際にはgapではないため、今のところ`gapPlan()`はどのPLAN_INPUTSからも呼ばれていない
 * ——mechanism自体をtestで直接演習する（このfile末尾の`__internal`経由）。
 */
function gapPlan(
  no: number,
  evaluationShape: F5cEvaluationShape,
  requiredMetrics: readonly string[],
  gapReason: string,
  options: Omit<PlanInput, "no" | "evaluationShape" | "requiredMetrics" | "measurementStatus" | "gapReason" | "axes"> = {},
): PlanInput {
  if (!gapReason.trim()) throw new Error(`gapPlan #${no}: gapReason must not be empty`);
  return plan(no, evaluationShape, requiredMetrics, "MEASUREMENT_GAP", { ...options, gapReason });
}

const vcBucketPresence = (bucket: "oneToOne" | "smallGroup" | "largeGroup") => [
  `bucketTotalSeconds.${bucket}`,
  `bucketPositiveDays.${bucket}`,
  `overallBucketShare.${bucket}`,
  `socialOnlyShare.${bucket}`,
  "totalTrustedSeconds",
  "totalSocialSeconds",
  "activeDays",
  "socialPositiveDays",
  "positiveSpanDays",
] as const;

const vcBucketStability = (bucket: "oneToOne" | "smallGroup" | "largeGroup") => [
  ...vcBucketPresence(bucket),
  `dailyBucketShareP25.${bucket}`,
  `dailyBucketShareMedian.${bucket}`,
  `dailyBucketShareIqr.${bucket}`,
  `dailySocialOnlyShareP25.${bucket}`,
  `dailySocialOnlyShareMedian.${bucket}`,
  `dailySocialOnlyShareIqr.${bucket}`,
] as const;

const vcPresenceAxes = (bucket: "oneToOne" | "smallGroup" | "largeGroup") => [
  metricAxis(`${bucket}-seconds`, `bucketTotalSeconds.${bucket}`),
  metricAxis(`${bucket}-days`, `bucketPositiveDays.${bucket}`),
] as const;

const vcStabilityAxes = (bucket: "oneToOne" | "smallGroup" | "largeGroup") => [
  metricAxis(`${bucket}-sample-seconds`, "totalTrustedSeconds"),
  metricAxis(`${bucket}-social-sample-seconds`, "totalSocialSeconds"),
  metricAxis(`${bucket}-overall-share`, `overallBucketShare.${bucket}`),
  metricAxis(`${bucket}-social-only-share`, `socialOnlyShare.${bucket}`),
  metricAxis(`${bucket}-daily-share-floor`, `dailyBucketShareP25.${bucket}`),
  metricAxis(`${bucket}-daily-social-share-floor`, `dailySocialOnlyShareP25.${bucket}`),
  metricAxis(`${bucket}-daily-share-variation`, `dailyBucketShareIqr.${bucket}`, "AT_MOST"),
  metricAxis(`${bucket}-daily-social-share-variation`, `dailySocialOnlyShareIqr.${bucket}`, "AT_MOST"),
] as const;

const activityHourMetrics = Object.freeze(Array.from({ length: 24 }, (_, hour) => [
  `hourlyVcTrustedSeconds.${hour}`,
  `hourlyVcPositiveDays.${hour}`,
  `hourlyTcGapSampleCount.${hour}`,
]).flat());

const activityMetrics = Object.freeze([
  "vcTotalTrustedSeconds",
  "vcPositiveDays",
  "vcDominantHourSeconds",
  "vcTop2HoursSeconds",
  "vcTop3HoursSeconds",
  "vcDominantHourShare",
  "vcTop2HoursShare",
  "vcTop3HoursShare",
  "tcGapSampleCount",
  ...activityHourMetrics,
]);

const activityJoint = joint(
  "activity-time-day-hour-v1",
  "rows.daypart-boundary",
  "rows.day-hour-social-evidence",
  "rows.daypart-share",
  "rows.tc-gap",
  "rows.vc-seconds",
);

/** No.32-37共通: activity-time-day-hour-v1の生rowはすべて同じ row group から導出する。 */
function activityDayHourAxes(no: number, rowGroupKey: string, quadrant: F5cCircularQuadrant) {
  return [
    circularHourAxis(`candidate-${no}-daypart-boundary`, "rows.daypart-boundary", rowGroupKey, { kind: "DAYPART_TARGET", quadrant }),
    jointThresholdAxis(`candidate-${no}-qualifying-days`, "rows.day-hour-social-evidence", "FILTER_THEN_DISTINCT_DAYS", rowGroupKey),
    jointThresholdAxis(`candidate-${no}-tc-gap-ceiling`, "rows.tc-gap", "SCALAR_SAMPLE", rowGroupKey, "AT_MOST"),
    jointThresholdAxis(`candidate-${no}-vc-seconds`, "rows.vc-seconds", "SCALAR_SAMPLE", rowGroupKey),
    jointThresholdAxis(`candidate-${no}-activity-share`, "rows.daypart-share", "FILTER_THEN_SHARE", rowGroupKey),
  ];
}

const PLAN_INPUTS: readonly PlanInput[] = [
  measuredPlan(2, "MULTI_METRIC_CONJUNCTION", ["occurrenceCount", "distinctOccurrenceDays", "occurrenceSpanDays"], {
    axes: [metricAxis("welcoming-days", "distinctOccurrenceDays"), metricAxis("welcoming-span", "occurrenceSpanDays")],
  }),
  measuredPlan(7, "MULTI_METRIC_CONJUNCTION", ["occurrenceCount", "distinctOccurrenceDays", "occurrenceSpanDays"], {
    axes: [metricAxis("closer-days", "distinctOccurrenceDays"), metricAxis("closer-occurrences", "occurrenceCount")],
  }),
  measuredPlan(9, "MULTI_METRIC_CONJUNCTION", ["occurrenceCount", "distinctOccurrenceDays", "distinctChannels", "occurrenceSpanDays"], {
    axes: [
      metricAxis("lockup-days", "distinctOccurrenceDays"),
      metricAxis("lockup-span", "occurrenceSpanDays"),
      metricAxis("lockup-place-breadth", "distinctChannels"),
    ],
  }),

  measuredPlan(10, "MULTI_METRIC_CONJUNCTION", vcBucketPresence("oneToOne"), { axes: vcPresenceAxes("oneToOne") }),
  measuredPlan(11, "MULTI_METRIC_CONJUNCTION", vcBucketStability("oneToOne"), { axes: vcStabilityAxes("oneToOne") }),
  measuredPlan(12, "MULTI_METRIC_CONJUNCTION", vcBucketStability("oneToOne"), {
    axes: [...vcStabilityAxes("oneToOne"), metricAxis("duo-long-active-days", "activeDays"), metricAxis("duo-long-span", "positiveSpanDays")],
  }),
  measuredPlan(13, "MULTI_METRIC_CONJUNCTION", vcBucketPresence("smallGroup"), { axes: vcPresenceAxes("smallGroup") }),
  measuredPlan(14, "MULTI_METRIC_CONJUNCTION", vcBucketStability("smallGroup"), { axes: vcStabilityAxes("smallGroup") }),
  measuredPlan(15, "MULTI_METRIC_CONJUNCTION", vcBucketStability("smallGroup"), {
    axes: [...vcStabilityAxes("smallGroup"), metricAxis("small-long-active-days", "activeDays"), metricAxis("small-long-span", "positiveSpanDays")],
  }),
  measuredPlan(16, "MULTI_METRIC_CONJUNCTION", vcBucketPresence("largeGroup"), { axes: vcPresenceAxes("largeGroup") }),
  measuredPlan(17, "MULTI_METRIC_CONJUNCTION", vcBucketStability("largeGroup"), { axes: vcStabilityAxes("largeGroup") }),
  measuredPlan(18, "MULTI_METRIC_CONJUNCTION", vcBucketStability("largeGroup"), {
    axes: [...vcStabilityAxes("largeGroup"), metricAxis("large-long-active-days", "activeDays"), metricAxis("large-long-span", "positiveSpanDays")],
  }),
  measuredPlan(19, "MULTI_METRIC_CONJUNCTION", [
    ...vcBucketPresence("oneToOne"), ...vcBucketPresence("largeGroup"),
  ], {
    axes: [...vcPresenceAxes("oneToOne"), ...vcPresenceAxes("largeGroup")],
  }),
  measuredPlan(20, "MULTI_METRIC_CONJUNCTION", [
    ...vcBucketPresence("oneToOne"), ...vcBucketPresence("smallGroup"), ...vcBucketPresence("largeGroup"), "positiveSocialBucketCount",
  ], {
    axes: [
      ...vcPresenceAxes("oneToOne"), ...vcPresenceAxes("smallGroup"), ...vcPresenceAxes("largeGroup"),
      metricAxis("social-bucket-breadth", "positiveSocialBucketCount"),
    ],
  }),
  measuredPlan(21, "MULTI_METRIC_CONJUNCTION", [
    ...vcBucketStability("oneToOne"), ...vcBucketStability("smallGroup"), ...vcBucketStability("largeGroup"), "positiveSocialBucketCount",
  ], {
    axes: [
      metricAxis("all-seat-breadth", "positiveSocialBucketCount"),
      metricAxis("all-seat-active-days", "socialPositiveDays"),
      metricAxis("all-seat-span", "positiveSpanDays"),
      metricAxis("duo-share-floor", "socialOnlyShare.oneToOne"),
      metricAxis("small-share-floor", "socialOnlyShare.smallGroup"),
      metricAxis("large-share-floor", "socialOnlyShare.largeGroup"),
      metricAxis("duo-share-ceiling", "socialOnlyShare.oneToOne", "AT_MOST"),
      metricAxis("small-share-ceiling", "socialOnlyShare.smallGroup", "AT_MOST"),
      metricAxis("large-share-ceiling", "socialOnlyShare.largeGroup", "AT_MOST"),
    ],
  }),

  measuredPlan(23, "MULTI_METRIC_CONJUNCTION", ["distinctCoPresentUsers", "trustedOverlapSeconds", "breadthPositiveDays", "breadthSpanDays", "dailyBreadthMedian", "dailyBreadthP90"], {
    axes: [metricAxis("circle-breadth", "distinctCoPresentUsers"), metricAxis("circle-days", "breadthPositiveDays"), metricAxis("circle-daily-breadth", "dailyBreadthMedian")],
  }),
  measuredPlan(24, "MULTI_METRIC_CONJUNCTION", ["distinctCoPresentUsers", "trustedOverlapSeconds", "breadthPositiveDays", "breadthSpanDays", "dailyBreadthP25", "dailyBreadthMedian"], {
    axes: [metricAxis("known-face-breadth", "distinctCoPresentUsers"), metricAxis("known-face-days", "breadthPositiveDays"), metricAxis("known-face-span", "breadthSpanDays"), metricAxis("known-face-daily-floor", "dailyBreadthP25")],
  }),
  measuredPlan(25, "MULTI_METRIC_CONJUNCTION", ["distinctCoPresentUsers", "trustedOverlapSeconds", "breadthPositiveDays", "breadthSpanDays", "dailyBreadthP75", "dailyBreadthP90"], {
    axes: [metricAxis("very-wide-breadth", "distinctCoPresentUsers"), metricAxis("very-wide-days", "breadthPositiveDays"), metricAxis("very-wide-span", "breadthSpanDays"), metricAxis("very-wide-daily-breadth", "dailyBreadthP75")],
  }),
  measuredPlan(26, "JOINT_CORRELATION", ["counterpartProfileCount", "distinctClassIndexCount", "touchEdgeCount", "totalTrustedSeconds", "unionTouchDays", "structuralMaxPersonClassMatching"], {
    requiredJointEvidence: joint("social-context-graph-v1", "counterparts.semantic-touch-days-seconds", "counterparts.maximum-matching"),
    axes: [
      jointThresholdAxis("class-edge-trusted-seconds", "counterparts.semantic-touch-days-seconds", "SCALAR_SAMPLE", "class-edges"),
      jointThresholdAxis("class-person-matching", "counterparts.maximum-matching", "POST_FILTER_MATCHING_SIZE", "class-edges"),
    ],
  }),
  measuredPlan(27, "JOINT_CORRELATION", ["counterpartProfileCount", "distinctFamilyIndexCount", "touchEdgeCount", "totalTrustedSeconds", "unionTouchDays", "structuralMaxPersonFamilyMatching"], {
    requiredJointEvidence: joint("social-context-graph-v1", "counterparts.semantic-touch-days-seconds", "counterparts.maximum-matching"),
    axes: [
      jointThresholdAxis("department-edge-trusted-seconds", "counterparts.semantic-touch-days-seconds", "SCALAR_SAMPLE", "family-edges"),
      jointThresholdAxis("department-person-matching", "counterparts.maximum-matching", "POST_FILTER_MATCHING_SIZE", "family-edges"),
    ],
  }),
  measuredPlan(28, "DISTRIBUTION_THRESHOLD", ["maxRepeatedDaysWithOneCounterpart", "distinctCoPresentUsers", "trustedOverlapSeconds"], {
    axes: [metricAxis("same-person-repeat-days", "maxRepeatedDaysWithOneCounterpart"), metricAxis("relationship-sample-seconds", "trustedOverlapSeconds")],
  }),

  // PR #191レビュー第3ラウンド§2: No.32=朝番/33=昼下がり/34=宵っ張り/35=深夜営業は、
  // 24時間を4等分した互いに素なquadrantへ1:1で対応させる——実際の本番hour境界は
  // 依然として選ばない(quadrantは単なる中立的なsearch領域分離)。
  // PR #191レビュー第4ラウンド§2: quadrant=[0,6)/[6,12)/[12,18)/[18,24)はJST時計の
  // 深夜/朝/昼/夕方に対応する——No.32(朝番/morning)はQUADRANT_1、No.33(昼下がり/
  // afternoon)はQUADRANT_2、No.34(宵っ張り/evening~日付変更前)はQUADRANT_3、
  // No.35(深夜営業/日付変更後~早朝)はQUADRANT_0。旧mapping(32→Q0等)はcatalogの
  // displayName/semanticSpecと噛み合っていなかった。
  ...([[32, "QUADRANT_1"], [33, "QUADRANT_2"], [34, "QUADRANT_3"], [35, "QUADRANT_0"]] as const).map(([no, quadrant]) => measuredPlan(no, "JOINT_CORRELATION", activityMetrics, {
    requiredJointEvidence: activityJoint,
    axes: activityDayHourAxes(no, `candidate-${no}-activity-day-hour-rows`, quadrant),
    // TC/VCどちらか一方のmodalityが十分であれば行が対象になる(片方だけの必須化を避ける、§5-B)。
    rowGroupCompositions: [rowGroupComposition(`candidate-${no}-activity-day-hour-rows`, "ANY_FILTER")],
    coverageNotes: ["JST hour bins are measurement resolution; F5c1 fixes no daypart boundary."],
  })),
  measuredPlan(36, "JOINT_CORRELATION", activityMetrics, {
    requiredJointEvidence: joint("activity-time-day-hour-v1", "rows.activity-start-hour", "rows.day-hour-social-evidence", "rows.tc-gap", "rows.vc-seconds"),
    axes: [
      circularHourAxis("usual-time-start-hour-stability", "rows.activity-start-hour", "usual-time-rows", { kind: "PERSONAL_STABILITY" }),
      jointThresholdAxis("usual-time-qualifying-days", "rows.day-hour-social-evidence", "FILTER_THEN_DISTINCT_DAYS", "usual-time-rows"),
      metricAxis("usual-time-concentration", "vcTop3HoursShare"),
      metricAxis("usual-time-sample-seconds", "vcTotalTrustedSeconds"),
    ],
    coverageNotes: ["JST hour bins are measurement resolution; F5c1 fixes no stability band or daypart boundary."],
  }),
  measuredPlan(37, "JOINT_CORRELATION", activityMetrics, {
    requiredJointEvidence: activityJoint,
    axes: [
      circularHourAxis("multi-daypart-boundaries", "rows.daypart-boundary", "multi-daypart-rows", { kind: "MULTI_DAYPART_BREADTH" }),
      jointThresholdAxis("multi-daypart-distributed-days", "rows.day-hour-social-evidence", "FILTER_THEN_DISTINCT_DAYS", "multi-daypart-rows"),
      jointThresholdAxis("multi-daypart-tc-gap-ceiling", "rows.tc-gap", "SCALAR_SAMPLE", "multi-daypart-rows", "AT_MOST"),
      jointThresholdAxis("multi-daypart-vc-seconds", "rows.vc-seconds", "SCALAR_SAMPLE", "multi-daypart-rows"),
    ],
    rowGroupCompositions: [rowGroupComposition("multi-daypart-rows", "ANY_FILTER")],
    coverageNotes: ["JST hour bins are measurement resolution; F5c1 fixes no daypart boundary and does not reward a single all-night session."],
  }),

  measuredPlan(38, "STRUCTURAL_PRESENCE", ["eventCount"], {
    structuralRequirements: ["At least one canonical eligible BUMP success after the catalog boundary."],
    fixedCriteria: [metricAtLeast("eventCount", 1)],
  }),
  measuredPlan(39, "MULTI_METRIC_CONJUNCTION", ["eventCount", "distinctActiveDays", "activeSpanDays"], {
    axes: [metricAxis("bump-days", "distinctActiveDays"), metricAxis("bump-events", "eventCount")],
  }),
  measuredPlan(40, "JOINT_CORRELATION", ["eventCount", "distinctActiveDays", "activeSpanDays", "sameDayExcessCount", "maxEventsPerDay"], {
    requiredJointEvidence: joint("day-occurrences-v1", "dayOffsets.calendar-periods"),
    axes: [
      jointThresholdAxis("bump-calendar-period-breadth", "dayOffsets.calendar-periods", "SET_BREADTH", "bump-day-rows"),
      metricAxis("bump-period-span", "activeSpanDays"),
    ],
  }),
  measuredPlan(41, "JOINT_CORRELATION", ["eventCount", "distinctActiveDays", "activeSpanDays", "sameDayExcessCount", "maxEventsPerDay"], {
    requiredJointEvidence: joint("day-occurrences-v1", "dayOffsets.calendar-periods"),
    axes: [
      jointThresholdAxis("stable-bump-periods", "dayOffsets.calendar-periods", "SET_BREADTH", "bump-day-rows"),
      metricAxis("stable-bump-days", "distinctActiveDays"),
      metricAxis("stable-bump-span", "activeSpanDays"),
    ],
  }),

  measuredPlan(42, "JOINT_CORRELATION", ["startCount", "startDistinctDays", "quietBeforeMsMedian", "nextOtherGapMsMedian", "nextOtherGapMissingCount"], {
    requiredJointEvidence: joint("tc-conversation-v1", "starts.quiet-before", "starts.next-other-gap", "starts.explicit-continuation", "starts.day-offset"),
    axes: [
      jointThresholdAxis("start-quiet-before", "starts.quiet-before", "SCALAR_SAMPLE", "tc-start-rows"),
      jointThresholdAxis("start-continuation-gap", "starts.next-other-gap", "SCALAR_SAMPLE", "tc-start-rows", "AT_MOST"),
      jointThresholdAxis("start-days", "starts.day-offset", "FILTER_THEN_DISTINCT_DAYS", "tc-start-rows"),
    ],
    // quiet-beforeとcontinuation-gapは同じstart rowが両方を満たす必要がある(§5-A)。
    rowGroupCompositions: [rowGroupComposition("tc-start-rows", "ALL_FILTERS")],
  }),
  measuredPlan(43, "JOINT_CORRELATION", ["revivalConversationCount", "revivalOccurrenceCount", "revivalDistinctDays", "dormantBeforeMsMedian", "continuationGapMsMedian"], {
    requiredJointEvidence: joint("tc-conversation-v1", "revivals.conversation-group", "revivals.dormant-before", "revivals.continuation-gap"),
    axes: [
      jointThresholdAxis("revival-dormancy", "revivals.dormant-before", "SCALAR_SAMPLE", "tc-revival-rows"),
      jointThresholdAxis("revival-continuation-gap", "revivals.continuation-gap", "SCALAR_SAMPLE", "tc-revival-rows", "AT_MOST"),
      jointThresholdAxis("revival-qualifying-conversation-breadth", "revivals.conversation-group", "SET_BREADTH", "tc-revival-rows"),
    ],
    // dormancy floorとcontinuation-gap ceilingの両方を満たすrevivalだけが対象(conjunctive)。
    rowGroupCompositions: [rowGroupComposition("tc-revival-rows", "ALL_FILTERS")],
  }),
  measuredPlan(44, "JOINT_CORRELATION", ["revivalConversationCount", "revivalOccurrenceCount", "revivalDistinctDays", "maxRevivalsPerConversation"], {
    requiredJointEvidence: joint("tc-conversation-v1", "revivals.conversation-group", "revivals.day-offset"),
    axes: [
      jointThresholdAxis("revival-conversation-breadth", "revivals.conversation-group", "SET_BREADTH", "tc-revival-breadth-rows"),
      jointThresholdAxis("revival-day-breadth", "revivals.day-offset", "FILTER_THEN_DISTINCT_DAYS", "tc-revival-breadth-rows"),
    ],
  }),
  measuredPlan(45, "JOINT_CORRELATION", ["socialAreaCount", "socialAreaUnionDays", "maxSocialDaysPerArea", "socialAreaSpanDays"], {
    requiredJointEvidence: joint("tc-conversation-v1", "areas.surface-local-social-days", "areas.best-other-gap"),
    axes: [
      jointThresholdAxis("tc-area-breadth", "areas.surface-local-social-days", "SET_BREADTH", "tc-area-rows"),
      jointThresholdAxis("tc-area-gap-ceiling", "areas.best-other-gap", "SCALAR_SAMPLE", "tc-area-rows", "AT_MOST"),
    ],
  }),
  // PR #191レビュー§2: posts.reactor-breadth(SET_BREADTH)はcross-post reactor identityを
  // safe joint evidenceが持たないため、実際には単一postの最大distinctReactorsしか表現
  // できない不正確なproxyだった。probeが既に計算しているsubject-level exact metric
  // `distinctReactors`（cross-post distinct reactor数そのもの）をMETRIC axisとして直接
  // 使う——joint selectorへ迂回する理由が無い。
  measuredPlan(46, "JOINT_CORRELATION", ["distinctReactors", "postCount", "reactionPositiveDays", "totalPostDayTouches", "perPostDistinctReactorsMedian", "perPostReactionDayCountMedian"], {
    requiredJointEvidence: joint("tc-reaction-posts-v1", "posts.post-breadth", "posts.day-breadth"),
    axes: [
      jointThresholdAxis("reaction-post-breadth", "posts.post-breadth", "SET_BREADTH", "reaction-post-rows"),
      jointThresholdAxis("reaction-day-breadth", "posts.day-breadth", "FILTER_THEN_DISTINCT_DAYS", "reaction-post-rows"),
      metricAxis("reaction-person-breadth", "distinctReactors"),
    ],
  }),
  measuredPlan(47, "JOINT_CORRELATION", ["thirdPartyJoinCount", "thirdPartyJoinDistinctDays", "priorDistinctOtherCountMedian", "thirdPartyNextOtherGapMsMedian", "priorSelfGapMsMedian"], {
    requiredJointEvidence: joint("tc-conversation-v1", "third-party.prior-distinct-others", "third-party.next-other-gap", "third-party.prior-self-gap", "third-party.day-offset"),
    axes: [
      jointThresholdAxis("prior-other-breadth", "third-party.prior-distinct-others", "SCALAR_SAMPLE", "tc-third-party-rows"),
      jointThresholdAxis("join-continuation-gap", "third-party.next-other-gap", "SCALAR_SAMPLE", "tc-third-party-rows", "AT_MOST"),
      jointThresholdAxis("join-day-breadth", "third-party.day-offset", "FILTER_THEN_DISTINCT_DAYS", "tc-third-party-rows"),
    ],
    // 十分なprior distinct othersとcontinuation-gap ceilingの両方を満たすjoinだけが対象。
    rowGroupCompositions: [rowGroupComposition("tc-third-party-rows", "ALL_FILTERS")],
  }),
  // §2(round4): 「TCとVC双方で複数日」はunionでは表現できない
  // （TC=1日・VC=多数日でもunionは大きくなる反例）。tc/vc双方を別rowGroupで
  // 独立にqualifying distinct daysへ還元し、plan.axes全体のconjunction
  // （このcontractの全plan共通の不変条件——下記コメント参照）で両方を要求する。
  // unionModalityDays/overlappingCalendarDaysはrequiredMetricsのdiagnosticとして
  // 残すが、どちらもaxisにはしない。
  measuredPlan(49, "JOINT_CORRELATION", ["tcCandidateSocialDays", "vcSocialDays", "unionModalityDays", "overlappingCalendarDays", "tcSpanDays", "vcSpanDays"], {
    requiredJointEvidence: joint("cross-modal-days-v1", "tc-days.gap", "tc-days.day-offset", "vc-days.breadth", "vc-days.day-offset"),
    axes: [
      jointThresholdAxis("tc-meaningful-gap", "tc-days.gap", "SCALAR_SAMPLE", "tc-days-rows", "AT_MOST"),
      jointThresholdAxis("tc-qualifying-days", "tc-days.day-offset", "FILTER_THEN_DISTINCT_DAYS", "tc-days-rows"),
      jointThresholdAxis("vc-breadth", "vc-days.breadth", "SCALAR_SAMPLE", "vc-days-rows"),
      jointThresholdAxis("vc-qualifying-days", "vc-days.day-offset", "FILTER_THEN_DISTINCT_DAYS", "vc-days-rows"),
    ],
  }),

  measuredPlan(50, "STRUCTURAL_PRESENCE", ["hostedSessionCount", "hostedDistinctGuests"], {
    structuralRequirements: ["A canonical eligible hosted-room session contains at least one valid guest visit."],
    fixedCriteria: [metricAtLeast("hostedDistinctGuests", 1)],
  }),
  measuredPlan(51, "DISTRIBUTION_THRESHOLD", ["hostedMaxConcurrentGuests", "hostedDistinctGuests", "hostedSessionCount"], { axes: [metricAxis("room-concurrent-guests", "hostedMaxConcurrentGuests"), metricAxis("room-hosted-sessions", "hostedSessionCount")] }),
  measuredPlan(52, "MULTI_METRIC_CONJUNCTION", ["hostedSessionCount", "hostedDistinctGuests", "hostedActiveDays", "hostedActiveSpanDays", "hostedDailyDistinctGuestsMedian", "hostedDailySessionsMedian"], {
    axes: [metricAxis("popular-room-days", "hostedActiveDays"), metricAxis("popular-room-sessions", "hostedSessionCount"), metricAxis("popular-room-guests", "hostedDistinctGuests")],
  }),
  measuredPlan(53, "DISTRIBUTION_THRESHOLD", ["hostedMaxRepeatGuestDepth", "hostedSessionCount", "hostedActiveDays"], { axes: [metricAxis("repeat-guest-depth", "hostedMaxRepeatGuestDepth")] }),
  measuredPlan(54, "MULTI_METRIC_CONJUNCTION", ["guestDistinctOwners", "guestSessionCount", "guestActiveDays", "guestActiveSpanDays", "guestDailyDistinctOwnersMedian"], {
    axes: [metricAxis("guest-owner-breadth", "guestDistinctOwners"), metricAxis("guest-days", "guestActiveDays"), metricAxis("guest-sessions", "guestSessionCount")],
  }),
  measuredPlan(55, "MULTI_METRIC_CONJUNCTION", ["hostedSessionCount", "hostedActiveDays", "guestSessionCount", "guestActiveDays", "activeSpanDays"], {
    axes: [metricAxis("host-side-sessions", "hostedSessionCount"), metricAxis("guest-side-sessions", "guestSessionCount"), metricAxis("room-two-sided-span", "activeSpanDays")],
  }),
  measuredPlan(56, "JOINT_CORRELATION", ["domainSemanticBreadth", "domainDayTouches", "domainActiveDays", "domainActiveSpanDays", "socialActiveDays", "socialTcGapSampleCount", "socialVcTrustedSeconds"], {
    // §3(round4): own-room-use-daysとown-room-use-spanは同じ制限済みselector
    // (domainDays.public-room-own-use)から導出する——汎用のdomainDays.day-offset
    // （hosted/guest行も含み得る）を使うと、F5c2がspanをown-use rowだけへ絞る
    // ことをprose頼みで推測することになる。row group base predicateをselector
    // 自体に埋め込む（Approach A）。
    requiredJointEvidence: joint("domain-social-time-v1", "domainDays.public-room-own-use"),
    axes: [
      jointThresholdAxis("own-room-use-days", "domainDays.public-room-own-use", "FILTER_THEN_DISTINCT_DAYS", "domain-day-rows"),
      jointThresholdAxis("own-room-use-span", "domainDays.public-room-own-use", "FILTER_THEN_SPAN_DAYS", "domain-day-rows"),
    ],
  }),

  measuredPlan(58, "STRUCTURAL_PRESENCE", ["tipCount", "tipActiveDays"], {
    structuralRequirements: ["The first snapshot-valid normal tip to another user exists."],
    fixedCriteria: [metricAtLeast("tipCount", 1)],
    releaseGateNotes: ["Post-award reversal handling remains unresolved; SOURCE READY does not make this releasable."],
  }),
  measuredPlan(59, "MULTI_METRIC_CONJUNCTION", ["outgoingTipDistinctRecipients", "outgoingTipActiveDays", "outgoingTipActiveSpanDays", "dailyOutgoingTipDistinctRecipientsMedian"], {
    axes: [metricAxis("tip-recipient-breadth", "outgoingTipDistinctRecipients"), metricAxis("tip-day-breadth", "outgoingTipActiveDays")],
  }),
  measuredPlan(61, "MULTI_METRIC_CONJUNCTION", ["distinctFamilies", "distinctHumanCounterparts", "hasNaturalInflow", "hasNaturalOutflow", "economyActiveDays", "economyActiveSpanDays", "dailyDistinctHumanCounterpartsMedian"], {
    axes: [metricAxis("economy-family-breadth", "distinctFamilies"), metricAxis("economy-counterpart-breadth", "distinctHumanCounterparts"), metricAxis("economy-day-breadth", "economyActiveDays")],
    structuralRequirements: ["Natural inflow and natural outflow are both present; excluded reward/admin/casino/reversal flows remain absent."],
    fixedCriteria: [metricBooleanTrue("hasNaturalInflow"), metricBooleanTrue("hasNaturalOutflow")],
  }),
  measuredPlan(62, "MULTI_METRIC_CONJUNCTION", ["distinctEligibleProducts", "purchaseActiveDays", "purchaseActiveSpanDays", "dailyDistinctEligibleProductsMedian"], {
    axes: [metricAxis("eligible-product-breadth", "distinctEligibleProducts"), metricAxis("purchase-day-breadth", "purchaseActiveDays")],
  }),
  measuredPlan(63, "MANIFEST_CONFORMANCE", ["distinctSubjectUsedFamilies", "familySubjectUsed.peer_transfer", "familySubjectUsed.tip", "familySubjectUsed.shop"], {
    structuralRequirements: ["Breadth is evaluated only against the current explicit economy semantic-family manifest and subject-initiated outflow use, requiring multiple distinct families."],
    manifestRef: economyManifestRef(),
    manifestCriteria: [atLeastFixedDistinctMembers("distinctSubjectUsedFamilies", 2)],
  }),
  measuredPlan(65, "STRUCTURAL_PRESENCE", ["shopRoleEligiblePurchaseCount", "shopRolePurchaseActiveDays"], {
    structuralRequirements: ["An eligible storefront purchase occurs inside a trusted canonical shop-role interval."],
    fixedCriteria: [metricAtLeast("shopRoleEligiblePurchaseCount", 1)],
  }),

  measuredPlan(66, "STRUCTURAL_PRESENCE", ["completedActivityCount", "completedActivityDistinctFamilies", "completedActivityDays"], {
    structuralRequirements: ["At least one Edition-I target game reaches canonical successful financial completion."],
    fixedCriteria: [metricAtLeast("completedActivityCount", 1)],
  }),
  measuredPlan(67, "DISTRIBUTION_THRESHOLD", ["completedActivityCount", "completedActivityDistinctFamilies", "completedActivityDays", "completedActivitySpanDays"], { axes: [metricAxis("completed-game-family-breadth", "completedActivityDistinctFamilies"), metricAxis("completed-game-count", "completedActivityCount")] }),
  measuredPlan(68, "MULTI_METRIC_CONJUNCTION", ["activityCount", "activityDistinctFamilies", "activityDays", "activitySpanDays"], { axes: [metricAxis("casino-use-family-breadth", "activityDistinctFamilies"), metricAxis("casino-use-days", "activityDays")] }),
  measuredPlan(69, "MANIFEST_CONFORMANCE", ["distinctCompletedFamilies", "allFamiliesCompleted", "totalFamilyCompletionDays"], {
    structuralRequirements: ["Every family in the current Casino Edition-I manifest has canonical completion evidence."],
    manifestRef: casinoEditionManifestRef(),
    // §1(round4): countMetricKeyはcardinality-compatibleなfamily countで統一する
    // （booleanのallFamiliesCompletedとNo.89のactiveFamilyCountのような実数countを
    // ALL_MANIFEST_MEMBERSへ混在させない）。allFamiliesCompletedはdiagnostic用として
    // requiredMetricsに残す。
    manifestCriteria: [allManifestMembers("distinctCompletedFamilies")],
  }),
  measuredPlan(70, "STRUCTURAL_PRESENCE", ["tableCount", "guestProfileCount", "guestStayRowCount", "guestActiveDays", "totalTrustedGuestSeconds"], {
    structuralRequirements: ["A subject-hosted official table has at least one valid non-owner human guest interval."],
    fixedCriteria: [metricAtLeast("guestStayRowCount", 1)],
  }),
  measuredPlan(71, "MULTI_METRIC_CONJUNCTION", ["guestProfileCount", "stayRowCount", "distinctHostedTableProfilesWithGuests", "hostedGuestTrustedSeconds", "busyTableActiveDays", "busyTableActiveSpanDays", "dailyHostedGuestTrustedSecondsMedian", "trustedSecondsPerGuestProfileMedian"], {
    axes: [metricAxis("busy-hosted-table-breadth", "distinctHostedTableProfilesWithGuests"), metricAxis("busy-table-day-breadth", "busyTableActiveDays"), metricAxis("busy-table-guest-breadth", "guestProfileCount"), metricAxis("busy-table-trusted-seconds", "hostedGuestTrustedSeconds")],
  }),
  measuredPlan(72, "MULTI_METRIC_CONJUNCTION", ["distinctOtherStandardBoards", "sumDailyDistinctOtherStandardBoards", "marketActiveDays", "marketActiveSpanDays", "dailyDistinctOtherStandardBoardsMedian"], {
    axes: [metricAxis("other-standard-board-breadth", "distinctOtherStandardBoards"), metricAxis("market-participation-days", "marketActiveDays"), metricAxis("market-participation-count", "sumDailyDistinctOtherStandardBoards")],
  }),

  measuredPlan(74, "STRUCTURAL_PRESENCE", ["confirmedInviteCount", "confirmationActiveDays"], {
    structuralRequirements: ["The first canonical confirmed direct-invite relation reaches immutable entry."],
    fixedCriteria: [metricAtLeast("confirmedInviteCount", 1)],
  }),
  measuredPlan(75, "DISTRIBUTION_THRESHOLD", ["confirmedInviteCount", "confirmationActiveDays", "confirmationActiveSpanDays"], { axes: [metricAxis("confirmed-direct-invite-count", "confirmedInviteCount")] }),
  measuredPlan(76, "JOINT_CORRELATION", ["directBranchProfileCount", "branchActivityDayCount", "branchActivityVcTrustedSocialSeconds", "branchActivityTcGapSampleCount", "activityDaysPerBranchMedian", "unknownEntryAnchorCount"], {
    requiredJointEvidence: joint("invite-rooted-v1", "profiles.branch-activity-days", "profiles.branch-social-evidence"),
    axes: [
      jointThresholdAxis("rooted-branch-activity-days", "profiles.branch-activity-days", "FILTER_THEN_DISTINCT_DAYS", "invite-branch-rows"),
      jointThresholdAxis("rooted-branch-social-evidence", "profiles.branch-social-evidence", "SCALAR_SAMPLE", "invite-branch-rows"),
    ],
  }),
  measuredPlan(77, "STRUCTURAL_PLUS_DISTRIBUTION", ["directBranchProfileCount", "branchActivityDayCount", "nextGenerationOccurrenceCount", "nextGenerationSameDayVcTrustedSocialSeconds", "nextGenerationSameDayTcGapSampleCount", "unknownNextGenerationEntryAnchorCount"], {
    requiredJointEvidence: joint(
      "invite-rooted-v1",
      "profiles.root-before-child",
      "profiles.same-day-before-entry",
      "profiles.next-generation-occurrence",
      "profiles.next-generation-same-day-gap",
      "profiles.next-generation-same-day-seconds",
    ),
    axes: [
      jointThresholdAxis("next-generation-same-day-gap-ceiling", "profiles.next-generation-same-day-gap", "SCALAR_SAMPLE", "next-gen-rows", "AT_MOST"),
      jointThresholdAxis("next-generation-same-day-seconds", "profiles.next-generation-same-day-seconds", "SCALAR_SAMPLE", "next-gen-rows"),
      jointThresholdAxis("next-generation-qualifying-count", "profiles.next-generation-occurrence", "FILTER_THEN_COUNT", "next-gen-rows"),
    ],
    // TC/VCどちらか一方のsame-day evidenceが十分であれば対象になる(§5-B、32-37と同じ考え方)。
    rowGroupCompositions: [rowGroupComposition("next-gen-rows", "ANY_FILTER")],
    fixedCriteria: [
      jointStructuralFact("profiles.root-before-child"),
      jointStructuralFact("profiles.same-day-before-entry"),
      metricAtLeast("nextGenerationOccurrenceCount", 1),
    ],
    structuralRequirements: ["A canonical next-generation occurrence belongs to the same direct branch and is anchored to immutable child entry chronology."],
  }),
  measuredPlan(78, "JOINT_CORRELATION", ["directBranchProfileCount", "nextGenerationOccurrenceCount", "nextGenerationOccurrencesPerBranchMedian", "unknownNextGenerationEntryAnchorCount"], {
    requiredJointEvidence: joint("invite-rooted-v1", "profiles.independent-rooted-branches", "profiles.root-before-child", "profiles.same-day-before-entry"),
    axes: [jointThresholdAxis("independent-rooted-branch-count", "profiles.independent-rooted-branches", "SET_BREADTH", "invite-forest-rows")],
    fixedCriteria: [jointStructuralFact("profiles.root-before-child"), jointStructuralFact("profiles.same-day-before-entry")],
    structuralRequirements: ["Every counted next-generation occurrence is anchored to the same-branch root-before-child immutable entry chronology."],
  }),
  measuredPlan(79, "JOINT_CORRELATION", ["directBranchProfileCount", "reunionDayCount", "reunionVcTrustedPairSeconds", "reunionTcGapSampleCount", "reunionDaysPerBranchMedian"], {
    requiredJointEvidence: joint("invite-rooted-v1", "profiles.reunion-days", "profiles.reunion-pair-social-evidence"),
    axes: [
      jointThresholdAxis("reunion-day-breadth", "profiles.reunion-days", "FILTER_THEN_DISTINCT_DAYS", "invite-reunion-rows"),
      jointThresholdAxis("reunion-social-evidence", "profiles.reunion-pair-social-evidence", "SCALAR_SAMPLE", "invite-reunion-rows"),
    ],
  }),

  measuredPlan(80, "STRUCTURAL_PRESENCE", ["completedParticipationCount", "completionActiveDays"], {
    structuralRequirements: ["A canonical completed event contains the subject as a confirmed general participant."],
    fixedCriteria: [metricAtLeast("completedParticipationCount", 1)],
  }),
  measuredPlan(81, "DISTRIBUTION_THRESHOLD", ["completedParticipationCount", "completionActiveDays", "completionActiveSpanDays"], { axes: [metricAxis("completed-event-participation-count", "completedParticipationCount")] }),
  measuredPlan(82, "MULTI_METRIC_CONJUNCTION", ["totalEventInvolvementCount", "eventDays", "eventSpanDays"], { axes: [metricAxis("event-calendar-days", "eventDays"), metricAxis("event-calendar-span", "eventSpanDays")] }),
  measuredPlan(83, "STRUCTURAL_PRESENCE", ["generalParticipantCount", "staffCount", "organizerCount", "participantOnlyCount", "totalEventInvolvementCount"], {
    structuralRequirements: ["A participant-only completed event and a distinct staff-or-organizer completed event both exist."],
    fixedCriteria: [metricAtLeast("participantOnlyCount", 1), anyMetricPositive("staffCount", "organizerCount")],
  }),
  measuredPlan(84, "STRUCTURAL_PRESENCE", ["primaryOrganizerCount", "totalEventInvolvementCount"], {
    structuralRequirements: ["A canonical completed event names the subject as its exactly-one primary organizer."],
    fixedCriteria: [metricAtLeast("primaryOrganizerCount", 1)],
  }),

  measuredPlan(85, "STRUCTURAL_PRESENCE", ["activeFamilyCount", "castleActiveDays"], {
    structuralRequirements: ["Meaningful use exists in two distinct families of the current Castle Edition-I manifest."],
    fixedCriteria: [metricAtLeast("activeFamilyCount", 2)],
  }),
  measuredPlan(86, "MANIFEST_CONFORMANCE", ["activeFamilyCount", "sumFamilyActiveDays", "castleActiveDays", "familiesPerActiveDayMedian"], {
    structuralRequirements: ["Breadth is interpreted only against the current Castle Edition-I family manifest, requiring multiple distinct families."],
    manifestRef: castleEditionManifestRef(),
    manifestCriteria: [atLeastFixedDistinctMembers("activeFamilyCount", 2)],
  }),
  measuredPlan(87, "MANIFEST_CONFORMANCE", ["domainSemanticBreadth", "domainDayTouches", "domainActiveDays", "socialActiveDays", "socialTcGapSampleCount", "socialVcTrustedSeconds", "coveredSuperDomainCount"], {
    requiredJointEvidence: joint("domain-social-time-v1", "domainDays.castle-family-superdomain", "socialHours.day-hour-evidence"),
    structuralRequirements: ["The current Castle Edition-I family-to-super-domain manifest supplies social, economy/play, and castle-wide domain coverage, with a sufficient family-breadth boundary left unselected."],
    manifestRef: castleEditionManifestRef(),
    manifestCriteria: [allRequiredSuperdomains("coveredSuperDomainCount"), manifestCardinalitySweep("domainSemanticBreadth")],
  }),
  measuredPlan(88, "MANIFEST_CONFORMANCE", ["domainSemanticBreadth", "domainDayTouches", "domainActiveDays", "domainActiveSpanDays"], {
    requiredJointEvidence: joint("domain-social-time-v1", "domainDays.castle-family-breadth"),
    structuralRequirements: ["Almost-all breadth is interpreted only against the current Castle Edition-I family manifest, as an unselected manifest-relative cardinality sweep."],
    manifestRef: castleEditionManifestRef(),
    manifestCriteria: [manifestCardinalitySweep("domainSemanticBreadth")],
  }),
  measuredPlan(89, "MANIFEST_CONFORMANCE", ["activeFamilyCount", "sumFamilyActiveDays", "castleActiveDays"], {
    structuralRequirements: ["Every family in the current Castle Edition-I manifest has meaningful-use evidence."],
    manifestRef: castleEditionManifestRef(),
    manifestCriteria: [allManifestMembers("activeFamilyCount")],
  }),
  measuredPlan(90, "JOINT_CORRELATION", ["roleHeldFamilyCount", "insideActiveFamilyCount", "outsideActiveFamilyCount", "insideDayUnion", "outsideDayUnion", "insideOccurrenceCount", "outsideOccurrenceCount", "insideTrustedSeconds", "outsideTrustedSeconds"], {
    requiredJointEvidence: joint("castle-role-context-v1", "families.role-held-days", "families.inside-days", "families.outside-days"),
    axes: [
      jointThresholdAxis("role-held-family-breadth", "families.role-held-days", "SET_BREADTH", "castle-role-family-rows"),
      jointThresholdAxis("inside-domain-breadth", "families.inside-days", "SET_BREADTH", "castle-role-family-rows"),
      jointThresholdAxis("outside-domain-breadth", "families.outside-days", "SET_BREADTH", "castle-role-family-rows"),
    ],
  }),
  measuredPlan(91, "JOINT_CORRELATION", ["roleHeldFamilyCount", "outsideActiveFamilyCount", "outsideDayUnion", "outsideDaysCount", "outsideOccurrenceCount", "outsideTrustedSeconds"], {
    requiredJointEvidence: joint("castle-role-context-v1", "families.role-held-days", "families.outside-days", "families.outside-repeat-days"),
    axes: [
      jointThresholdAxis("outside-repeat-days", "families.outside-repeat-days", "REPEAT_PERIOD", "castle-outside-rows"),
      jointThresholdAxis("outside-activity-evidence", "families.outside-days", "SCALAR_SAMPLE", "castle-outside-rows"),
    ],
  }),
];

const JOINT_SELECTOR_ALLOWLIST = Object.freeze({
  "none": [],
  "activity-time-day-hour-v1": ["rows.daypart-boundary", "rows.day-hour-social-evidence", "rows.daypart-share", "rows.tc-gap", "rows.vc-seconds", "rows.activity-start-hour"],
  "day-occurrences-v1": ["dayOffsets.calendar-periods"],
  "social-breadth-days-v1": [],
  "social-context-graph-v1": ["counterparts.semantic-touch-days-seconds", "counterparts.maximum-matching"],
  "tc-conversation-v1": [
    "starts.quiet-before", "starts.next-other-gap", "starts.explicit-continuation", "starts.day-offset",
    "revivals.conversation-group", "revivals.dormant-before", "revivals.continuation-gap", "revivals.day-offset",
    "areas.surface-local-social-days", "areas.best-other-gap",
    "third-party.prior-distinct-others", "third-party.next-other-gap", "third-party.prior-self-gap", "third-party.day-offset",
  ],
  "tc-reaction-posts-v1": ["posts.post-breadth", "posts.day-breadth"],
  "cross-modal-days-v1": ["tc-days.gap", "tc-days.day-offset", "vc-days.breadth", "vc-days.day-offset"],
  "domain-social-time-v1": [
    "domainDays.public-room-own-use", "domainDays.castle-family-superdomain",
    "domainDays.castle-family-breadth", "socialHours.day-hour-evidence",
  ],
  "economy-actions-v1": [],
  "invite-rooted-v1": [
    "profiles.branch-activity-days", "profiles.branch-social-evidence", "profiles.root-before-child",
    "profiles.same-day-before-entry", "profiles.next-generation-occurrence", "profiles.independent-rooted-branches",
    "profiles.reunion-days", "profiles.reunion-pair-social-evidence",
    "profiles.next-generation-same-day-gap", "profiles.next-generation-same-day-seconds",
  ],
  "castle-role-context-v1": ["families.role-held-days", "families.inside-days", "families.outside-days", "families.outside-repeat-days"],
} satisfies Record<PlanningCalibrationJointEvidence["kind"], readonly string[]>);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

const ownerByCandidate = new Map<number, CalibrationProbeKey>();
for (const probe of F5C_CALIBRATION_PROBES) {
  for (const no of probe.candidateNos) {
    if (ownerByCandidate.has(no)) throw new Error(`duplicate F5c probe ownership for candidate #${no}`);
    ownerByCandidate.set(no, probe.probeKey);
  }
}

function materializePlan(input: PlanInput): F5cCandidateSweepPlan {
  const candidate = TITLE_V2_CATALOG_CANDIDATES.find(({ no }) => no === input.no);
  const readiness = TITLE_V2_CATALOG_READINESS.find(({ no }) => no === input.no);
  const probeKey = ownerByCandidate.get(input.no);
  if (!candidate || !readiness || !probeKey) throw new Error(`unknown F5c sweep candidate #${input.no}`);
  const probe = F5C_CALIBRATION_PROBES.find((entry) => entry.probeKey === probeKey)!;
  // PR #190レビュー§12: measurementStatusはPlanInputで既にrequired fieldだが、
  // 実行時にも「未設定のまま素通りしない」ことを二重に保証する（防御的defense-in-depth）。
  if (input.measurementStatus !== "MEASURED" && input.measurementStatus !== "MEASUREMENT_GAP") {
    throw new Error(`#${input.no}: measurementStatus must be explicit (MEASURED or MEASUREMENT_GAP), got ${String(input.measurementStatus)}`);
  }
  if (input.measurementStatus === "MEASUREMENT_GAP") {
    if (!input.gapReason?.trim()) throw new Error(`#${input.no}: MEASUREMENT_GAP requires a non-empty gapReason`);
    if ((input.axes?.length ?? 0) > 0) throw new Error(`#${input.no}: MEASUREMENT_GAP must not declare sweep axes`);
  }
  const structuralRequirements = [...(input.structuralRequirements ?? [])].sort();
  const fixedCriteria = [...(input.fixedCriteria ?? [])];
  const manifestRef = input.manifestRef ?? null;
  const manifestCriteria = [...(input.manifestCriteria ?? [])];
  if (structuralRequirements.length > 0 && fixedCriteria.length === 0 && manifestCriteria.length === 0) {
    throw new Error(`#${input.no}: structuralRequirements is prose-only — a typed fixedCriteria or manifestCriteria is required`);
  }
  // PR #190レビュー第3ラウンド§2: manifestRefだけでは「universeに対して何を要求するか」を
  // 特定しない——manifestRefを持つplanは必ずmanifestCriteriaも持つ。
  if (manifestRef !== null && manifestCriteria.length === 0) {
    throw new Error(`#${input.no}: manifestRef alone does not specify executable semantics — manifestCriteria is required`);
  }
  if (manifestCriteria.length > 0 && manifestRef === null) {
    throw new Error(`#${input.no}: manifestCriteria requires a manifestRef`);
  }
  return {
    candidateNo: input.no,
    provisionalKey: candidate.provisionalKey,
    probeKey,
    thresholdCategory: readiness.thresholdCategory,
    optimizationRisk: readiness.optimizationRisk,
    measurementStatus: input.measurementStatus,
    gapReason: input.measurementStatus === "MEASUREMENT_GAP" ? input.gapReason!.trim() : null,
    evaluationShape: input.evaluationShape,
    requiredMetrics: [...new Set(input.requiredMetrics)].sort(),
    requiredJointEvidence: input.requiredJointEvidence ?? NONE,
    axes: [...(input.axes ?? [])].sort((a, b) => a.axisKey.localeCompare(b.axisKey)),
    fixedCriteria,
    manifestRef,
    manifestCriteria,
    rowGroupCompositions: [...(input.rowGroupCompositions ?? [])].sort((a, b) => a.rowGroupKey.localeCompare(b.rowGroupKey)),
    structuralRequirements,
    coverageNotes: [...new Set([...probe.coverageLimitations, COVERAGE_NOTE, ...(input.coverageNotes ?? [])])].sort(),
    releaseGateNotes: [...(input.releaseGateNotes ?? [])].sort(),
  };
}

export const F5C_CANDIDATE_SWEEP_PLANS: readonly F5cCandidateSweepPlan[] = deepFreeze(
  PLAN_INPUTS.map(materializePlan).sort((a, b) => a.candidateNo - b.candidateNo),
);

export interface F5cCandidateSweepPlanAudit {
  readonly contractVersion: typeof F5C_SWEEP_CONTRACT_VERSION;
  readonly probeCount: number;
  readonly measurementCandidateCount: number;
  readonly readyCandidateCount: number;
  readonly plannedCandidateCount: number;
  readonly thresholdCategoryCounts: Readonly<Record<CandidateReadinessAudit["thresholdCategory"], number>>;
  readonly optimizationRiskCounts: Readonly<Record<CandidateReadinessAudit["optimizationRisk"], number>>;
  readonly declaredMeasurementGapCount: number;
  readonly unexecutablePlanCount: number;
  readonly unexecutablePlanCandidateNos: readonly number[];
  readonly duplicateCount: number;
  readonly nonReadyCandidateCount: number;
  readonly missingReadyCandidateNos: readonly number[];
  readonly unexpectedPlanCandidateNos: readonly number[];
  readonly candidateProbeOwnershipMismatches: readonly number[];
  readonly thresholdCategoryMismatches: readonly number[];
  readonly optimizationRiskMismatches: readonly number[];
  readonly unknownMetricSelectors: readonly string[];
  readonly unknownJointEvidenceSelectors: readonly string[];
  readonly manifestRefMismatches: readonly number[];
  readonly manifestFingerprintDrift: readonly F5cManifestRef["kind"][];
  readonly rowGroupsMissingComposition: readonly string[];
  readonly unusedRequiredJointSelectors: readonly string[];
  readonly numericThresholdValueCount: number;
  readonly exactReadySet: boolean;
}

function countNumbers(value: unknown): number {
  if (typeof value === "number") return 1;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countNumbers(item), 0);
  if (value !== null && typeof value === "object") return Object.values(value).reduce((sum, item) => sum + countNumbers(item), 0);
  return 0;
}

const CANONICAL_MANIFEST_REF_BUILDERS: Readonly<Record<F5cManifestRef["kind"], () => F5cManifestRef>> = {
  ECONOMY_SEMANTIC_FAMILIES: economyManifestRef,
  CASINO_EDITION: casinoEditionManifestRef,
  CASTLE_EDITION: castleEditionManifestRef,
};

export function auditF5cCandidateSweepPlans(): F5cCandidateSweepPlanAudit {
  // PR #190レビュー第3ラウンド§1: pin(F5C1_MANIFEST_PINS、hardcoded literal)と
  // 現行constant(liveManifestFingerprint、CASINO_EDITION_I_MANIFEST等を直接読む)を
  // 完全に独立な経路で比較する。plan.manifestRefがbuilder経由でpinから複製されている
  // ことも別途確認する(手編集での値ズレを検出する二重チェック)。
  const manifestFingerprintDrift = (Object.keys(F5C1_MANIFEST_PINS) as (keyof typeof F5C1_MANIFEST_PINS)[]).filter(
    (kind) => F5C1_MANIFEST_PINS[kind].fingerprint !== liveManifestFingerprint(kind),
  );
  const ready = TITLE_V2_CATALOG_READINESS.filter(({ status }) => status === "READY").sort((a, b) => a.no - b.no);
  const readySet = new Set(ready.map(({ no }) => no));
  const planNos = F5C_CANDIDATE_SWEEP_PLANS.map(({ candidateNo }) => candidateNo);
  const planSet = new Set(planNos);
  const measurementNos = F5C_CALIBRATION_PROBES.flatMap(({ candidateNos }) => candidateNos);
  const contracts = new Map(describeF5cCalibrationProbeContracts().map((contract) => [contract.probeKey, contract]));
  const unknownMetricSelectors: string[] = [];
  const unknownJointEvidenceSelectors: string[] = [];
  const candidateProbeOwnershipMismatches: number[] = [];
  const thresholdCategoryMismatches: number[] = [];
  const optimizationRiskMismatches: number[] = [];
  const manifestRefMismatches: number[] = [];
  const unexecutablePlanCandidateNos: number[] = [];
  const rowGroupsMissingComposition: string[] = [];
  const unusedRequiredJointSelectors: string[] = [];

  for (const candidatePlan of F5C_CANDIDATE_SWEEP_PLANS) {
    const contract = contracts.get(candidatePlan.probeKey);
    const readiness = TITLE_V2_CATALOG_READINESS.find(({ no }) => no === candidatePlan.candidateNo)!;
    if (!contract?.candidateNos.includes(candidatePlan.candidateNo)) candidateProbeOwnershipMismatches.push(candidatePlan.candidateNo);
    if (candidatePlan.thresholdCategory !== readiness.thresholdCategory) thresholdCategoryMismatches.push(candidatePlan.candidateNo);
    if (candidatePlan.optimizationRisk !== readiness.optimizationRisk) optimizationRiskMismatches.push(candidatePlan.candidateNo);
    const knownMetrics = new Set(contract?.metricKeys ?? []);
    for (const metricKey of candidatePlan.requiredMetrics) {
      if (!knownMetrics.has(metricKey)) unknownMetricSelectors.push(`#${candidatePlan.candidateNo}:${metricKey}`);
    }
    for (const axis of candidatePlan.axes) {
      if (axis.source === "METRIC" && !knownMetrics.has(axis.metricKey)) unknownMetricSelectors.push(`#${candidatePlan.candidateNo}:${axis.metricKey}`);
    }
    for (const criterion of candidatePlan.fixedCriteria) {
      if (criterion.kind === "METRIC_COMPARE" || criterion.kind === "METRIC_BOOLEAN_TRUE") {
        if (!knownMetrics.has(criterion.metricKey)) unknownMetricSelectors.push(`#${candidatePlan.candidateNo}:${criterion.metricKey}`);
      }
      if (criterion.kind === "ANY_METRIC_POSITIVE") {
        for (const metricKey of criterion.metricKeys) {
          if (!knownMetrics.has(metricKey)) unknownMetricSelectors.push(`#${candidatePlan.candidateNo}:${metricKey}`);
        }
      }
    }
    for (const criterion of candidatePlan.manifestCriteria) {
      if (!knownMetrics.has(criterion.countMetricKey)) unknownMetricSelectors.push(`#${candidatePlan.candidateNo}:${criterion.countMetricKey}`);
    }
    const requiredJoint = candidatePlan.requiredJointEvidence;
    if (requiredJoint.kind !== "none" && contract?.jointEvidenceKind !== requiredJoint.kind) {
      unknownJointEvidenceSelectors.push(`#${candidatePlan.candidateNo}:kind:${requiredJoint.kind}`);
    }
    const allowed = new Set(JOINT_SELECTOR_ALLOWLIST[requiredJoint.kind]);
    for (const selector of requiredJoint.selectors) {
      if (!allowed.has(selector)) unknownJointEvidenceSelectors.push(`#${candidatePlan.candidateNo}:${requiredJoint.kind}:${selector}`);
    }
    for (const axis of candidatePlan.axes) {
      if (axis.source === "JOINT_EVIDENCE" && !allowed.has(axis.selector)) {
        unknownJointEvidenceSelectors.push(`#${candidatePlan.candidateNo}:${requiredJoint.kind}:${axis.selector}`);
      }
    }
    for (const criterion of candidatePlan.fixedCriteria) {
      if (criterion.kind === "JOINT_STRUCTURAL_FACT" && (requiredJoint.kind === "none" || !allowed.has(criterion.selector))) {
        unknownJointEvidenceSelectors.push(`#${candidatePlan.candidateNo}:${requiredJoint.kind}:${criterion.selector}`);
      }
    }
    // PR #190レビュー第3ラウンド§3 mutation D: social-context-graph-v1（No.26/27）は
    // maximum-matching selectorをrequiredJointEvidenceへ宣言する以上、必ずそれを
    // 消費するPOST_FILTER_MATCHING_SIZE axisを持たなければならない——edge filter axis
    // だけが残ってmatching size boundary axisが消えた状態をfail-closedで検出する
    // （kind単位の一般化はしない——他のjoint kindでは「宣言されているが未使用」の
    // 具体的な設計判断が候補ごとに異なるため、汎用の「全selector必須使用」ruleは
    // 既存の正しい候補まで誤検出させてしまう）。
    if (requiredJoint.kind === "social-context-graph-v1" && requiredJoint.selectors.includes("counterparts.maximum-matching")) {
      const hasMatchingAxis = candidatePlan.axes.some((axis) => axis.source === "JOINT_EVIDENCE" && axis.reducerKind === "POST_FILTER_MATCHING_SIZE");
      if (!hasMatchingAxis) {
        unusedRequiredJointSelectors.push(`#${candidatePlan.candidateNo}:${requiredJoint.kind}:counterparts.maximum-matching`);
      }
    }

    let unexecutable = false;
    if (candidatePlan.thresholdCategory === "STRUCTURAL_FIXED" && candidatePlan.fixedCriteria.length === 0) unexecutable = true;
    if (candidatePlan.thresholdCategory === "MANIFEST_DEPENDENT" && (candidatePlan.manifestRef === null || candidatePlan.manifestCriteria.length === 0)) unexecutable = true;
    if (candidatePlan.manifestRef !== null && candidatePlan.manifestCriteria.length === 0) unexecutable = true;
    if (candidatePlan.thresholdCategory === "STRUCTURAL_PLUS_DISTRIBUTION" && (candidatePlan.fixedCriteria.length === 0 || candidatePlan.axes.length === 0)) unexecutable = true;
    if (candidatePlan.structuralRequirements.length > 0 && candidatePlan.fixedCriteria.length === 0 && candidatePlan.manifestCriteria.length === 0) unexecutable = true;
    if (candidatePlan.evaluationShape === "JOINT_CORRELATION" && (candidatePlan.requiredJointEvidence.kind === "none" || candidatePlan.axes.length === 0)) unexecutable = true;
    if (candidatePlan.thresholdCategory === "THRESHOLD_PENDING" && candidatePlan.axes.length === 0 && candidatePlan.fixedCriteria.length === 0) unexecutable = true;
    if (candidatePlan.measurementStatus === "MEASUREMENT_GAP" && (candidatePlan.axes.length > 0 || !candidatePlan.gapReason)) unexecutable = true;
    if (candidatePlan.manifestRef) {
      // plan.manifestRefが実際にpinから複製されていることの整合性チェック(手編集検出)。
      const pinned = CANONICAL_MANIFEST_REF_BUILDERS[candidatePlan.manifestRef.kind]();
      if (JSON.stringify(pinned) !== JSON.stringify(candidatePlan.manifestRef)) {
        manifestRefMismatches.push(candidatePlan.candidateNo);
        unexecutable = true;
      }
      // pin自体が現行canonical manifestからdriftしていないかの独立チェック
      // (§1のcore fix——builderの自己参照ではなく、pin vs liveの別経路比較)。
      if (manifestFingerprintDrift.includes(candidatePlan.manifestRef.kind)) {
        manifestRefMismatches.push(candidatePlan.candidateNo);
        unexecutable = true;
      }
    }
    // PR #190レビュー第3ラウンド§5: 同じrowGroupKeyを共有するSCALAR_SAMPLE filter axisが
    // 2件以上あるのに、composition mode(ALL_FILTERS/ANY_FILTER)が宣言されていなければ、
    // F5c2はrow predicateの合成方法を推測することになる——fail-closedでunexecutable。
    const filterCountByRowGroup = new Map<string, number>();
    for (const axis of candidatePlan.axes) {
      if (axis.source === "JOINT_EVIDENCE" && axis.reducerKind === "SCALAR_SAMPLE") {
        filterCountByRowGroup.set(axis.rowGroupKey, (filterCountByRowGroup.get(axis.rowGroupKey) ?? 0) + 1);
      }
    }
    const declaredCompositionRowGroups = new Set(candidatePlan.rowGroupCompositions.map((c) => c.rowGroupKey));
    for (const [rowGroupKey, filterCount] of filterCountByRowGroup) {
      if (filterCount >= 2 && !declaredCompositionRowGroups.has(rowGroupKey)) {
        rowGroupsMissingComposition.push(`#${candidatePlan.candidateNo}:${rowGroupKey}`);
        unexecutable = true;
      }
    }
    if (unusedRequiredJointSelectors.some((entry) => entry.startsWith(`#${candidatePlan.candidateNo}:`))) unexecutable = true;
    if (unexecutable) unexecutablePlanCandidateNos.push(candidatePlan.candidateNo);
  }

  const thresholdCategoryCounts = Object.fromEntries([
    "STRUCTURAL_FIXED", "THRESHOLD_PENDING", "MANIFEST_DEPENDENT", "STRUCTURAL_PLUS_DISTRIBUTION",
  ].map((category) => [category, F5C_CANDIDATE_SWEEP_PLANS.filter((entry) => entry.thresholdCategory === category).length])) as Record<CandidateReadinessAudit["thresholdCategory"], number>;
  const optimizationRiskCounts = Object.fromEntries(["LOW", "MANAGED", "HIGH"].map((risk) => [
    risk, F5C_CANDIDATE_SWEEP_PLANS.filter((entry) => entry.optimizationRisk === risk).length,
  ])) as Record<CandidateReadinessAudit["optimizationRisk"], number>;
  const missingReadyCandidateNos = ready.filter(({ no }) => !planSet.has(no)).map(({ no }) => no);
  const unexpectedPlanCandidateNos = planNos.filter((no) => !readySet.has(no));
  const duplicateCount = planNos.length - planSet.size + measurementNos.length - new Set(measurementNos).size;
  const numericThresholdValueCount = F5C_CANDIDATE_SWEEP_PLANS.reduce((sum, entry) => sum + countNumbers(entry.axes), 0);
  return deepFreeze({
    contractVersion: F5C_SWEEP_CONTRACT_VERSION,
    probeCount: F5C_CALIBRATION_PROBES.length,
    measurementCandidateCount: new Set(measurementNos).size,
    readyCandidateCount: ready.length,
    plannedCandidateCount: planNos.length,
    thresholdCategoryCounts,
    optimizationRiskCounts,
    declaredMeasurementGapCount: F5C_CANDIDATE_SWEEP_PLANS.filter(({ measurementStatus }) => measurementStatus === "MEASUREMENT_GAP").length,
    unexecutablePlanCount: unexecutablePlanCandidateNos.length,
    unexecutablePlanCandidateNos: [...new Set(unexecutablePlanCandidateNos)].sort((a, b) => a - b),
    duplicateCount,
    nonReadyCandidateCount: unexpectedPlanCandidateNos.length,
    missingReadyCandidateNos,
    unexpectedPlanCandidateNos,
    candidateProbeOwnershipMismatches,
    thresholdCategoryMismatches,
    optimizationRiskMismatches,
    unknownMetricSelectors: [...new Set(unknownMetricSelectors)].sort(),
    unknownJointEvidenceSelectors: [...new Set(unknownJointEvidenceSelectors)].sort(),
    manifestRefMismatches: [...new Set(manifestRefMismatches)].sort((a, b) => a - b),
    manifestFingerprintDrift,
    rowGroupsMissingComposition: [...new Set(rowGroupsMissingComposition)].sort(),
    unusedRequiredJointSelectors: [...new Set(unusedRequiredJointSelectors)].sort(),
    numericThresholdValueCount,
    exactReadySet: missingReadyCandidateNos.length === 0 && unexpectedPlanCandidateNos.length === 0,
  });
}

/**
 * テスト専用: measuredPlan()/gapPlan()のno-silent-default機構自体を直接演習するための
 * 内部builder。production plan set（`F5C_CANDIDATE_SWEEP_PLANS`）には一切影響しない。
 */
export const __internal = { plan, measuredPlan, gapPlan, materializePlan };
