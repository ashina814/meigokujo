import { assertSlug, type TitleDefinition } from "./v2-contract.js";
import type { TitleV2Store } from "./v2-store.js";

/**
 * scope resolution境界。
 *
 * callerがscopeKey/start/endを自由に作れる旧設計を廃止する。definition.scope
 * （TitleScopePolicy）+ TitleV2Storeのsystem/catalog epochから、この中央resolverだけが
 * ResolvedTitleScopeを作る。scope policyの意味はreleased title semanticの一部
 * ——resolveTitleScope()のsemanticを後から変えると、同じscope.typeを使う既存titleの
 * award境界が過去に遡って変わってしまう。
 */

/**
 * 型レベルのnominal branding。TypeScriptの構造的型付けを迂回して、手書きの
 * plain objectを `ResolvedTitleScope` として直接代入できないようにする
 * （`@ts-expect-error` で証明できる）。ただし**runtimeのforgery検知の正本ではない**
 * ——`unique symbol` はobjectのown propertyとして存在する以上、
 * `Object.getOwnPropertySymbols()` で列挙してコピーできてしまう
 * （legitimateなscopeから盗んだsymbolを別objectへ移植すれば、この時点の
 * チェックだけは通ってしまう）。runtimeの正本は下の `RESOLVED_SCOPE_PROVENANCE`
 * WeakMap——object identity（参照そのもの）でしか引けないため、property単位の
 * コピーやProxyでのラップでは迂回できない。
 */
const RESOLVED_SCOPE_BRAND: unique symbol = Symbol("ResolvedTitleScope");

/** resolveTitleScope()が確定した値のcanonical snapshot。 */
interface ScopeProvenance {
  readonly titleKey: string;
  readonly scopeKey: string;
  readonly start: number;
  readonly endExclusive: number | null;
  readonly observedAt: number;
}

/**
 * runtimeのforgery検知・title provenance検証の正本。
 *
 * keyは`ResolvedTitleScope`のexact object identityそのもの——WeakMapの検索は
 * SameValueZeroによる参照比較なので、以下のいずれもここには載らない。
 * - legitimateなscopeのsymbol propertiesを別objectへコピーしたもの
 * - legitimateなscopeをラップした`Proxy`（targetへ委譲していても、Proxy自体は
 *   別のobject identityを持つ）
 * - legitimateなscopeをspreadした`{ ...scope }`のコピー
 *
 * 値は`resolveTitleScope()`が確定した時点のsnapshotで、`brand()`の中でしか
 * `.set()`しない。
 */
const RESOLVED_SCOPE_PROVENANCE = new WeakMap<object, ScopeProvenance>();

/**
 * resolveTitleScope() だけが作れる、評価に使ってよいscope。
 *
 * 返されたobjectは`Object.freeze()`済み——`scope.scopeKey = "x"`のような
 * 直接改変はstrict modeでTypeErrorになる（このリポジトリはESモジュールなので
 * 常にstrict mode）。ただしfreezeだけでは「別objectへのコピー」や「Proxyでの
 * ラップ」は防げないため、runtimeの真の防御はWeakMap identityの方にある
 * （`RESOLVED_SCOPE_PROVENANCE`参照）。
 */
export interface ResolvedTitleScope {
  readonly [RESOLVED_SCOPE_BRAND]: true;
  /** `(user_id, title_key, scope_key)` のunique制約へそのまま使う。canonical生成のみ。 */
  readonly scopeKey: string;
  /** inclusive */
  readonly start: number;
  /** exclusive。open-ended policy（catalog/global）はnull。 */
  readonly endExclusive: number | null;
  /** このscopeを評価する時刻。1 evaluation batch内では必ず同じ値を使うこと。 */
  readonly observedAt: number;
}

function brand(
  scope: {
    scopeKey: string;
    start: number;
    endExclusive: number | null;
    observedAt: number;
  },
  titleKey: string,
): ResolvedTitleScope {
  const branded = Object.freeze({ ...scope, [RESOLVED_SCOPE_BRAND]: true }) as ResolvedTitleScope;
  RESOLVED_SCOPE_PROVENANCE.set(
    branded as unknown as object,
    Object.freeze({ titleKey, scopeKey: scope.scopeKey, start: scope.start, endExclusive: scope.endExclusive, observedAt: scope.observedAt }),
  );
  return branded;
}

/**
 * scopeが本当にresolveTitleScope()の産物かをruntimeで確認する。
 * sourceを読む前・awardする前、resolvedScopeを受け取る全ての境界で呼ぶこと。
 *
 * 正本はWeakMap identity——`scope`という**まさにそのobject参照**が
 * `RESOLVED_SCOPE_PROVENANCE`に登録されていなければforgeryとして拒否する。
 * 登録が見つかった場合も、objectのfield値がsnapshot時点のcanonical値と
 * 一致することを二重に確認する（freezeされているため通常は不変のはずだが、
 * 念のための構造チェック）。
 *
 * title provenanceまでは見ない——読み込み境界（v2-sources.ts）はtitleごとの
 * cacheを持たず `(userId, sourceKey, scopeKey, start, endExclusive, observedAt)`
 * で共有するため、ここでtitle provenanceを強制すると意図的なcache共有が壊れる。
 * title取り違えの防止はaward境界（`assertResolvedTitleScopeForTitle()`）でだけ行う。
 */
export function assertResolvedTitleScope(scope: ResolvedTitleScope): void {
  if (scope === null || typeof scope !== "object") {
    throw new Error("scope was not produced by resolveTitleScope() (forged or hand-built ResolvedTitleScope)");
  }
  const provenance = RESOLVED_SCOPE_PROVENANCE.get(scope as unknown as object);
  if (!provenance) {
    throw new Error(
      "scope was not produced by resolveTitleScope() (forged, hand-built, cloned, or proxied ResolvedTitleScope)",
    );
  }
  if (
    scope.scopeKey !== provenance.scopeKey ||
    scope.start !== provenance.start ||
    scope.endExclusive !== provenance.endExclusive ||
    scope.observedAt !== provenance.observedAt
  ) {
    throw new Error("resolved title scope fields do not match the canonical snapshot recorded at resolution time");
  }
  if (typeof scope.scopeKey !== "string" || !scope.scopeKey.trim()) {
    throw new Error("resolved title scope has an empty scopeKey");
  }
  if (!Number.isInteger(scope.start)) {
    throw new Error("resolved title scope has a non-integer start");
  }
  if (scope.endExclusive !== null && (!Number.isInteger(scope.endExclusive) || scope.endExclusive <= scope.start)) {
    throw new Error(`resolved title scope has an invalid endExclusive: [${scope.start}, ${scope.endExclusive})`);
  }
  if (!Number.isInteger(scope.observedAt)) {
    throw new Error("resolved title scope has a non-integer observedAt");
  }
}

/**
 * award境界専用。brandに加えて、そのscopeが**指定したtitleKeyのために**
 * resolveTitleScope()を通ったことまで検証する。`global` のようなscopeKeyは
 * policyを共有する全titleで同一文字列になり得るため、「title Aのために正規
 * resolveしたscopeをtitle Bへ渡す」substitutionはscopeKeyの一致だけでは
 * 検出できない——このprovenance検査がその隙間を塞ぐ。
 *
 * callerへscopeKey/start/endの構築権限を戻すものではない（provenanceは
 * このモジュール外からは読めないWeakMapのまま）。呼び出し側（Store.award()）は
 * 戻り値のcanonical snapshotをそのままpersistに使うこと——`scope`オブジェクト
 * 自身のfieldを直接読まない（belt-and-suspenders: freezeが何らかの形で
 * 迂回されたとしても、実際にpersistされる値は常にWeakMap登録時点の値になる）。
 */
export function assertResolvedTitleScopeForTitle(scope: ResolvedTitleScope, titleKey: string): ScopeProvenance {
  assertResolvedTitleScope(scope);
  const provenance = RESOLVED_SCOPE_PROVENANCE.get(scope as unknown as object)!;
  if (provenance.titleKey !== titleKey) {
    throw new Error(
      `resolved title scope was resolved for a different title (expected ${titleKey}, got ${provenance.titleKey}); ` +
        `scopeKey=${scope.scopeKey}`,
    );
  }
  return provenance;
}

/**
 * sourceの読み込み境界（v2-sources.ts）で使う実効的な終端。open-endedなscopeは
 * observedAtまでしか見ていないため、そこが上限になる。
 *
 * CATALOG_EPOCH===observedAt（施行直後の瞬間評価）のように、start===effectiveEndの
 * zero-width windowは正常に起こり得る——その場合は「まだ何も観測していない」という
 * 意味で、呼び出し側（v2-sources.ts）は0件のpayloadを返すこと。resolveTitleScope()
 * がobservedAt<startをfail-closedしているため、effectiveEnd<startにはならない。
 */
export function resolvedScopeEffectiveEnd(scope: { readonly endExclusive: number | null; readonly observedAt: number }): number {
  return scope.endExclusive === null ? scope.observedAt : Math.min(scope.endExclusive, scope.observedAt);
}

/**
 * Planning/operator calibration専用の固定window resolver。
 *
 * production titleのscope policyを迂回する入口ではない。このscopeのprovenance title keyは
 * 実在しないplanning sentinelへ固定するため、`assertResolvedTitleScopeForTitle()`を通る
 * awardには絶対に使えない。一方、safe source read境界は通常どおりWeakMap provenanceを
 * 検証できるので、calibration側がhand-built scopeやraw SQLへ逃げる必要もない。
 * public v2 barrelからはexportしないこと。
 */
export function resolvePlanningCalibrationScope(window: {
  readonly start: number;
  readonly end: number;
  readonly observedAt: number;
}): ResolvedTitleScope {
  if (![window.start, window.end, window.observedAt].every(Number.isInteger)) {
    throw new RangeError("planning calibration window fields must be integer unix timestamps");
  }
  if (window.start >= window.end) {
    throw new RangeError(`invalid planning calibration window: [${window.start}, ${window.end})`);
  }
  if (window.observedAt < window.start) {
    throw new RangeError("planning calibration observedAt must be at or after window start");
  }
  return brand(
    {
      scopeKey: `planning-calibration:${window.start}:${window.end}:${window.observedAt}`,
      start: window.start,
      endExclusive: window.end,
      observedAt: window.observedAt,
    },
    "__planning_calibration_only__",
  );
}

/** ruleのcontextへ渡す、brand無しの公開scope形。ruleはbrand付き実体を直接受け取らない。 */
export interface TitleRuleScope {
  readonly scopeKey: string;
  readonly start: number;
  readonly endExclusive: number | null;
  readonly observedAt: number;
}

/** ResolvedTitleScopeからbrandを除いた、ruleへ渡してよい値だけのcopyを作る。 */
export function toRuleScope(scope: ResolvedTitleScope): TitleRuleScope {
  return { scopeKey: scope.scopeKey, start: scope.start, endExclusive: scope.endExclusive, observedAt: scope.observedAt };
}

/**
 * event scopeのcanonical windowを提供する差し込みポイント。canonical event
 * infrastructureはまだ存在しない（このPRでは作らない）ため、provider無しでevent scopeを
 * 解決しようとした場合はfail-closedする。
 */
export interface TitleEventScopeProvider {
  /**
   * catalogKey/eventKeyに対応するcanonicalなevent windowを返す。
   * 存在しないevent（未登録・打ち切り前等）はnullを返すこと——推測で埋めない。
   */
  resolveEvent(catalogKey: string, eventKey: string): { readonly start: number; readonly completedAt: number } | null;
}

/**
 * `scope.type==="month"` を解決するとき、どの暦月を対象にするかを指定する。
 *
 * デフォルト（省略時）は `{ type: "current" }`——observedAtが属する暦月をそのまま使う、
 * これまでの挙動。`{ type: "specific"; month }` は日次reconcile等が「9月になってから
 * 8月分を修復する」ような historical reconcile を行うための入口——observedAtの意味
 * （実際の観測上限）自体は変えない。callerが渡せるのは対象月のlabelだけで、
 * scopeKey/start/endExclusiveそのものは相変わらずresolverだけが計算する。
 */
export type TitleMonthSelector = { readonly type: "current" } | { readonly type: "specific"; readonly month: string };

const MONTH_LABEL_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function assertMonthLabel(value: string, label: string): void {
  if (typeof value !== "string" || !MONTH_LABEL_PATTERN.test(value)) {
    throw new Error(`${label} must be a "YYYY-MM" month label: ${JSON.stringify(value)}`);
  }
}

export interface TitleScopeResolutionOptions {
  /** event scope policyを使うruleを評価する場合に必須。無ければfail-closedする。 */
  readonly eventProvider?: TitleEventScopeProvider;
  /** month scope policyの対象月。省略時は`{type:"current"}`（observedAtが属する月）。 */
  readonly monthSelector?: TitleMonthSelector;
}

const JST_OFFSET_SEC = 9 * 3600;

/** 与えたunix秒が属するJST暦月の "YYYY-MM" ラベル。 */
function jstMonthLabelOf(ts: number): string {
  const jst = new Date((ts + JST_OFFSET_SEC) * 1000);
  const year = jst.getUTCFullYear();
  const month = jst.getUTCMonth(); // 0-11, JST-local
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

/** "YYYY-MM" labelが指すJST暦月の [開始, 翌月開始) を返す。labelは事前にvalidate済みであること。 */
function jstMonthBoundsForLabel(label: string): { monthStart: number; nextMonthStart: number } {
  const [yearStr, monthStr] = label.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr); // 1-12
  const monthStart = Math.floor(new Date(`${label}-01T00:00:00+09:00`).getTime() / 1000);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextLabel = `${nextYear}-${String(nextMonth).padStart(2, "0")}`;
  const nextMonthStart = Math.floor(new Date(`${nextLabel}-01T00:00:00+09:00`).getTime() / 1000);
  return { monthStart, nextMonthStart };
}

function requireCatalogEpoch(store: TitleV2Store, catalogKey: string): number {
  const row = store.catalogEpoch(catalogKey);
  if (!row) throw new Error(`cannot resolve title scope: catalog epoch not applied yet: ${catalogKey}`);
  return row.epoch;
}

function requireSystemEpoch(store: TitleV2Store): number {
  const epoch = store.systemEpoch();
  if (epoch === null) throw new Error("cannot resolve title scope: SYSTEM_EPOCH is not established yet");
  return epoch;
}

interface ScopeCandidate {
  readonly scopeKey: string;
  readonly start: number;
  readonly endExclusive: number | null;
}

/**
 * 全branch共通のfail-closedチェックを通してからbrandする。
 * observedAtがscope.startより前になることは正常には起こり得ない
 * （historical repairでも、修復対象の月は必ず既に始まっている）。これを許すと
 * 「まだ始まっていない未来のscopeを今評価する」という無意味な状態を作れてしまう。
 */
function finalize(definitionKey: string, observedAt: number, candidate: ScopeCandidate): ResolvedTitleScope {
  if (observedAt < candidate.start) {
    throw new Error(
      `title ${definitionKey}: observedAt (${observedAt}) is before the resolved scope start (${candidate.start}); scope=${candidate.scopeKey}`,
    );
  }
  return brand({ ...candidate, observedAt }, definitionKey);
}

/**
 * definition.scope + store（system/catalog epoch）+ observedAt からResolvedTitleScopeを
 * 作る唯一のAPI。callerはobservedAtだけを渡す——scopeKey・window境界はここでしか作らない。
 *
 * behavior titleはdefinition.catalogを使ってcatalog/month/eventを解決できる。meta title
 * はcatalogを持たないため、scope.type==="global"以外は届いた時点でfail-closedする
 * （defineMetaTitle()で既に弾いているはずだが、ここでも二重に守る）。
 */
export function resolveTitleScope(
  store: TitleV2Store,
  definition: TitleDefinition,
  observedAt: number,
  options: TitleScopeResolutionOptions = {},
): ResolvedTitleScope {
  if (!Number.isInteger(observedAt)) {
    throw new RangeError("resolveTitleScope: observedAt must be an integer unix timestamp");
  }
  const policy = definition.scope;
  const catalogKey = definition.kind === "behavior" ? definition.catalog : null;

  if (policy.type !== "global" && catalogKey === null) {
    throw new Error(
      `title ${definition.key}: scope.type="${policy.type}" requires a catalog reference, but this title has none (meta titles only support global scope)`,
    );
  }

  switch (policy.type) {
    case "global": {
      const start = requireSystemEpoch(store);
      return finalize(definition.key, observedAt, { scopeKey: "global", start, endExclusive: null });
    }
    case "catalog": {
      const start = requireCatalogEpoch(store, catalogKey!);
      return finalize(definition.key, observedAt, { scopeKey: `catalog:${catalogKey}`, start, endExclusive: null });
    }
    case "month": {
      const epoch = requireCatalogEpoch(store, catalogKey!);
      const selector = options.monthSelector ?? { type: "current" as const };
      const label =
        selector.type === "current"
          ? jstMonthLabelOf(observedAt)
          : (assertMonthLabel(selector.month, `title ${definition.key}: monthSelector.month`), selector.month);
      const { monthStart, nextMonthStart } = jstMonthBoundsForLabel(label);
      if (nextMonthStart <= epoch) {
        throw new Error(
          `title ${definition.key}: target month ${label} entirely precedes CATALOG_EPOCH (catalog=${catalogKey})`,
        );
      }
      const start = Math.max(monthStart, epoch);
      return finalize(definition.key, observedAt, { scopeKey: `month:${catalogKey}:${label}`, start, endExclusive: nextMonthStart });
    }
    case "event": {
      assertSlug(policy.eventKey, `title ${definition.key}: scope.eventKey`);
      if (!options.eventProvider) {
        throw new Error(
          `title ${definition.key}: scope.type="event" requires a TitleEventScopeProvider (catalog=${catalogKey}, eventKey=${policy.eventKey})`,
        );
      }
      const epoch = requireCatalogEpoch(store, catalogKey!);
      const canonical = options.eventProvider.resolveEvent(catalogKey!, policy.eventKey);
      if (!canonical) {
        throw new Error(`title ${definition.key}: unknown event ${catalogKey}/${policy.eventKey}`);
      }
      if (!Number.isInteger(canonical.start) || !Number.isInteger(canonical.completedAt)) {
        throw new Error(`title ${definition.key}: event provider returned non-integer timestamps for ${catalogKey}/${policy.eventKey}`);
      }
      if (canonical.start >= canonical.completedAt) {
        throw new Error(
          `title ${definition.key}: event provider returned start >= completedAt for ${catalogKey}/${policy.eventKey}`,
        );
      }
      const start = Math.max(canonical.start, epoch);
      if (start >= canonical.completedAt) {
        throw new Error(
          `title ${definition.key}: event window is empty after CATALOG_EPOCH clip (start=${start} >= completedAt=${canonical.completedAt})`,
        );
      }
      // 未完了のeventを部分windowでawardしない——completedAtが確定していない
      // （＝まだobservedAtの時点で終わっていない）eventは、評価そのものをfail-closedする。
      if (canonical.completedAt > observedAt) {
        throw new Error(
          `title ${definition.key}: event ${catalogKey}/${policy.eventKey} has not completed as of observedAt ` +
            `(completedAt=${canonical.completedAt} > observedAt=${observedAt})`,
        );
      }
      return finalize(definition.key, observedAt, {
        scopeKey: `event:${catalogKey}:${policy.eventKey}`,
        start,
        endExclusive: canonical.completedAt,
      });
    }
    default:
      // defineBehaviorTitle()/defineMetaTitle()がscope.typeを検証しているはずだが、
      // resolveTitleScope()はそれらを経由せず直接呼ばれる可能性もあるため、ここでも
      // 型を迂回した不正なscope.typeをfail-closedする。
      throw new Error(`title ${definition.key}: unknown scope.type ${String((policy as { type: string }).type)}`);
  }
}
