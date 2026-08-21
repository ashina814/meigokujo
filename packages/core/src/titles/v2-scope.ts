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

const RESOLVED_SCOPE_BRAND: unique symbol = Symbol("ResolvedTitleScope");

/**
 * resolveTitleScope() だけが作れる、評価に使ってよいscope。
 *
 * `[RESOLVED_SCOPE_BRAND]` はこのモジュール外からは参照できないsymbolなので、
 * 他コードが手書きで `{ scopeKey: "...", start: ... }` を作ってもこの型には
 * 構造的に合致しない（TypeScript）。`as unknown as ResolvedTitleScope` で型を
 * 迂回されても、実際のsymbol propertyは存在しないため、`assertResolvedTitleScope()`
 * のruntimechekで検出できる——型だけでなくruntimeでもforgeryをfail-closedにする。
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

function brand(scope: {
  scopeKey: string;
  start: number;
  endExclusive: number | null;
  observedAt: number;
}): ResolvedTitleScope {
  return { ...scope, [RESOLVED_SCOPE_BRAND]: true };
}

/**
 * scopeが本当にresolveTitleScope()の産物かをruntimeで確認する。
 * sourceを読む前・awardする前、resolvedScopeを受け取る全ての境界で呼ぶこと。
 */
export function assertResolvedTitleScope(scope: ResolvedTitleScope): void {
  if (
    scope === null ||
    typeof scope !== "object" ||
    (scope as unknown as Record<symbol, unknown>)[RESOLVED_SCOPE_BRAND] !== true
  ) {
    throw new Error("scope was not produced by resolveTitleScope() (forged or hand-built ResolvedTitleScope)");
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
 * sourceの読み込み境界（v2-sources.ts）で使う実効的な終端。open-endedなscopeは
 * observedAtまでしか見ていないため、そこが上限になる。
 *
 * CATALOG_EPOCH===observedAt（施行直後の瞬間評価）のように、start===effectiveEndの
 * zero-width windowは正常に起こり得る——その場合は「まだ何も観測していない」という
 * 意味で、呼び出し側（v2-sources.ts）は0件のpayloadを返すこと。resolveTitleScope()
 * がobservedAt<startをfail-closedしているため、effectiveEnd<startにはならない。
 */
export function resolvedScopeEffectiveEnd(scope: ResolvedTitleScope): number {
  return scope.endExclusive === null ? scope.observedAt : Math.min(scope.endExclusive, scope.observedAt);
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
  return brand({ ...candidate, observedAt });
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
