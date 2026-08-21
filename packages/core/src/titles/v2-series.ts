import { canonicalHash } from "../casino/opening-canonical.js";
import { assertSlug, type BehaviorTitleDefinition } from "./v2-contract.js";

/**
 * 連番progressionを持つtitle群を束ねる、immutableなmanifest契約。
 *
 * **released（一度公開した）seriesのmembersは永久にfreezeする。** `members` の並びと
 * 内容そのものが《一門皆伝》条件の一部であり、後からstageを追加すると、過去に
 * 「一門皆伝」を達成した人の条件が事後的に変わってしまう。title definitionsを
 * 自動走査して「現在存在するstage全部」を一門皆伝（mastery）対象にする方式は禁止。
 *
 * released seriesへ後からstageを追加しない。新しいladder（例: stage4を持つ版）が
 * 欲しい場合は、**同じ (catalog, seriesKey) を使い回さず**、新しいseriesKey + 新しい
 * title key群を作ること。既存の (catalog, seriesKey) を持つmanifestオブジェクトを
 * 「新しい内容へ置き換える」ことは正当な拡張手段ではない——
 * `assertNoOverlappingSeriesMembership()` が同一 (catalog, seriesKey) の複数manifest
 * 存在そのものを拒否するため、そもそもruntime上も許されない。
 *
 * DB persistence（`title_series_manifests` / `title_series_members`）は
 * `v2-series-store.ts`（PR B2）が担う——`registerSeriesManifests()` がこの検証を
 * 通した上でatomicに保存し、`computeSeriesManifestHash()` が「後から書き換えられて
 * いないか」を検出するsemantic hashを提供する。
 */
export interface TitleSeriesManifest {
  readonly catalog: string;
  readonly seriesKey: string;
  readonly label: string;
  /** 一門皆伝のようなmastery meta titleの対象になり得るか。 */
  readonly masteryEligible: boolean;
  readonly members: readonly `v2.${string}`[];
}

/**
 * seriesを構成するtitle定義の実体を渡して検証する。
 *
 * - members >= 2
 * - member titleが実在する（memberDefinitionsに含まれる）
 * - 全memberが同じcatalog
 * - 全memberが同じgroupKey（原則同じgroup）
 * - 全memberがprogressionを持ち、seriesKeyが一致する
 * - stageは重複禁止・1始まりの連番（欠番禁止）
 * - manifest内でのmember重複禁止
 *
 * `themeKey` はここでは検証しない——themeはeditorial/browsing/display専用の
 * カテゴリであり（`v2-contract.ts` の `TitleDefinitionCommon.themeKey` 参照）、series
 * logicに使わない。member同士のthemeKeyが異なっていても、released seriesの意味は
 * 変わらない（theme変更で既存seriesが事後的にinvalidになるのは設計として不適切）。
 * seriesのsemantic一致条件は catalog / groupKey / seriesKey / stage の連番性で十分。
 */
export function assertValidSeriesManifest(
  manifest: TitleSeriesManifest,
  memberDefinitions: readonly BehaviorTitleDefinition[],
): void {
  assertSlug(manifest.seriesKey, `series manifest seriesKey`);
  assertSlug(manifest.catalog, `series ${manifest.seriesKey}: catalog`);
  if (manifest.members.length < 2) {
    throw new Error(`series ${manifest.seriesKey}: must have at least 2 members`);
  }

  const seenMembers = new Set<string>();
  for (const key of manifest.members) {
    if (seenMembers.has(key)) throw new Error(`series ${manifest.seriesKey}: duplicate member ${key}`);
    seenMembers.add(key);
  }

  const byKey = new Map(memberDefinitions.map((d) => [d.key, d]));
  const seenStages = new Set<number>();
  let expectedGroup: string | null = null;

  for (const memberKey of manifest.members) {
    const def = byKey.get(memberKey);
    if (!def) throw new Error(`series ${manifest.seriesKey}: member title not found: ${memberKey}`);
    if (def.catalog !== manifest.catalog) {
      throw new Error(
        `series ${manifest.seriesKey}: member ${memberKey} belongs to a different catalog (${def.catalog} != ${manifest.catalog})`,
      );
    }
    if (expectedGroup === null) expectedGroup = def.groupKey;
    else if (def.groupKey !== expectedGroup) {
      throw new Error(
        `series ${manifest.seriesKey}: member ${memberKey} has a different groupKey (${def.groupKey} != ${expectedGroup})`,
      );
    }
    if (!def.progression || def.progression.seriesKey !== manifest.seriesKey) {
      throw new Error(`series ${manifest.seriesKey}: member ${memberKey} does not declare progression for this series`);
    }
    if (seenStages.has(def.progression.stage)) {
      throw new Error(`series ${manifest.seriesKey}: duplicate stage ${def.progression.stage} (member ${memberKey})`);
    }
    seenStages.add(def.progression.stage);
  }

  const sortedStages = [...seenStages].sort((a, b) => a - b);
  for (let i = 0; i < sortedStages.length; i++) {
    if (sortedStages[i] !== i + 1) {
      throw new Error(
        `series ${manifest.seriesKey}: stages must be a contiguous sequence starting at 1 (got ${sortedStages.join(",")})`,
      );
    }
  }
}

/**
 * 複数manifestを横断して以下を検証する。
 *
 * - 「1 titleが複数seriesへ所属していないか」（単一manifest内の重複は
 *   assertValidSeriesManifest() が既に見ているので、これは別seriesどうしの重複だけを見る）
 * - 同一 (catalog, seriesKey) を名乗るmanifestが複数存在しないか——released series
 *   のmembersは永久にfreezeする契約（上のTitleSeriesManifestのdoc comment参照）なので、
 *   同じidentityを持つmanifestを「新しい内容へ置き換える」ことは正当な拡張手段ではない。
 *   新しいladderが欲しい場合は必ず新しい (catalog, seriesKey) を使うこと——このチェックは
 *   その契約が破られていないことをruntimeでも確認する。
 */
export function assertNoOverlappingSeriesMembership(manifests: readonly TitleSeriesManifest[]): void {
  const identitySeen = new Set<string>();
  for (const manifest of manifests) {
    const identity = `${manifest.catalog} ${manifest.seriesKey}`;
    if (identitySeen.has(identity)) {
      throw new Error(
        `series identity (catalog, seriesKey) is used by multiple manifests: ${manifest.catalog}/${manifest.seriesKey}`,
      );
    }
    identitySeen.add(identity);
  }

  // ownerのidentityはseriesKey単体ではなく (catalog, seriesKey) の組で持つ——
  // 異なるcatalogが同じseriesKey文字列を使い回すケース（catalog-a/foo と
  // catalog-b/foo）で、seriesKeyだけを比較すると別catalogのseriesを同一視して
  // overlapを見逃してしまう（"foo" !== "foo" が常にfalseになるバグ）。
  const owner = new Map<string, { catalog: string; seriesKey: string }>();
  for (const manifest of manifests) {
    for (const key of manifest.members) {
      const existing = owner.get(key);
      if (existing && (existing.catalog !== manifest.catalog || existing.seriesKey !== manifest.seriesKey)) {
        throw new Error(
          `title ${key} belongs to multiple series: ${existing.catalog}/${existing.seriesKey}, ${manifest.catalog}/${manifest.seriesKey}`,
        );
      }
      owner.set(key, { catalog: manifest.catalog, seriesKey: manifest.seriesKey });
    }
  }
}

/** `computeSeriesManifestHash()` の入力。DB永続化されたmemberスナップショットから直接再構成できる形。 */
export interface SeriesManifestHashInput {
  readonly catalog: string;
  readonly seriesKey: string;
  readonly masteryEligible: boolean;
  readonly members: readonly { readonly titleKey: string; readonly stage: number }[];
}

/**
 * released seriesのmeaningが後から変わっていないことを検出するための、決定的な
 * semantic hash（PR B2）。
 *
 * hash対象は catalog / seriesKey / masteryEligible / member (titleKey, stage) のみ——
 * `label` はpresentation扱いなのでhashに含めない（label文言を後から調整しても
 * semanticは変わらない）。member arrayは**入力順ではなくstage順へcanonicalize**
 * してからhashする——DBからの読み取り順やcaller側の配列順に依存させないため。
 *
 * `members` は `{titleKey, stage}` のペアだけで構成する——DB上の `title_series_members`
 * テーブルから直接再構成できる形にすることで、runtimeの `BehaviorTitleDefinition` map
 * が無いconstruction-time integrity checkでも、DB snapshotだけからこの関数を
 * 再計算できる（`v2-series-store.ts` の `assertSeriesPersistenceIntegrity()` 参照）。
 */
export function computeSeriesManifestHash(input: SeriesManifestHashInput): string {
  const canonicalMembers = [...input.members]
    .sort((a, b) => a.stage - b.stage)
    .map((m) => [m.titleKey, m.stage] as const);
  return canonicalHash({
    catalog: input.catalog,
    seriesKey: input.seriesKey,
    masteryEligible: input.masteryEligible,
    members: canonicalMembers,
  });
}
