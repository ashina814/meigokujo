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

const JST_OFFSET_SEC = 9 * 3600;

/** 与えたunix秒が属するJST暦月の [開始, 翌月開始) と "YYYY-MM" ラベルを返す。 */
function jstMonthBounds(ts: number): { monthStart: number; nextMonthStart: number; label: string } {
  const jst = new Date((ts + JST_OFFSET_SEC) * 1000);
  const year = jst.getUTCFullYear();
  const month = jst.getUTCMonth(); // 0-11, JST-local
  const label = `${year}-${String(month + 1).padStart(2, "0")}`;
  const monthStart = Math.floor(new Date(`${label}-01T00:00:00+09:00`).getTime() / 1000);
  const nextYear = month === 11 ? year + 1 : year;
  const nextMonth = month === 11 ? 1 : month + 2;
  const nextLabel = `${nextYear}-${String(nextMonth).padStart(2, "0")}`;
  const nextMonthStart = Math.floor(new Date(`${nextLabel}-01T00:00:00+09:00`).getTime() / 1000);
  return { monthStart, nextMonthStart, label };
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
  eventProvider?: TitleEventScopeProvider,
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
      return brand({ scopeKey: "global", start, endExclusive: null, observedAt });
    }
    case "catalog": {
      const start = requireCatalogEpoch(store, catalogKey!);
      return brand({ scopeKey: `catalog:${catalogKey}`, start, endExclusive: null, observedAt });
    }
    case "month": {
      const epoch = requireCatalogEpoch(store, catalogKey!);
      const { monthStart, nextMonthStart, label } = jstMonthBounds(observedAt);
      const start = Math.max(monthStart, epoch);
      return brand({ scopeKey: `month:${catalogKey}:${label}`, start, endExclusive: nextMonthStart, observedAt });
    }
    case "event": {
      assertSlug(policy.eventKey, `title ${definition.key}: scope.eventKey`);
      if (!eventProvider) {
        throw new Error(
          `title ${definition.key}: scope.type="event" requires a TitleEventScopeProvider (catalog=${catalogKey}, eventKey=${policy.eventKey})`,
        );
      }
      const epoch = requireCatalogEpoch(store, catalogKey!);
      const canonical = eventProvider.resolveEvent(catalogKey!, policy.eventKey);
      if (!canonical) {
        throw new Error(`title ${definition.key}: unknown event ${catalogKey}/${policy.eventKey}`);
      }
      const start = Math.max(canonical.start, epoch);
      return brand({
        scopeKey: `event:${catalogKey}:${policy.eventKey}`,
        start,
        endExclusive: canonical.completedAt,
        observedAt,
      });
    }
    default:
      // defineBehaviorTitle()/defineMetaTitle()がscope.typeを検証しているはずだが、
      // resolveTitleScope()はそれらを経由せず直接呼ばれる可能性もあるため、ここでも
      // 型を迂回した不正なscope.typeをfail-closedする。
      throw new Error(`title ${definition.key}: unknown scope.type ${String((policy as { type: string }).type)}`);
  }
}
