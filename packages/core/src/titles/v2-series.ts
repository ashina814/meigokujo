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
 * runtimeで時系列immutabilityそのものを証明するDB（例: manifestのバージョン履歴を
 * 保存するテーブル）はこのPRの範囲外——ここでは契約の意味とtestだけを固定する。DB
 * persistenceは後続PR。
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
 * - 全memberが同じthemeKey
 * - 全memberが同じgroupKey（原則同じgroup）
 * - 全memberがprogressionを持ち、seriesKeyが一致する
 * - stageは重複禁止・1始まりの連番（欠番禁止）
 * - manifest内でのmember重複禁止
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
  let expectedTheme: string | null = null;
  let expectedGroup: string | null = null;

  for (const memberKey of manifest.members) {
    const def = byKey.get(memberKey);
    if (!def) throw new Error(`series ${manifest.seriesKey}: member title not found: ${memberKey}`);
    if (def.catalog !== manifest.catalog) {
      throw new Error(
        `series ${manifest.seriesKey}: member ${memberKey} belongs to a different catalog (${def.catalog} != ${manifest.catalog})`,
      );
    }
    if (expectedTheme === null) expectedTheme = def.themeKey;
    else if (def.themeKey !== expectedTheme) {
      throw new Error(
        `series ${manifest.seriesKey}: member ${memberKey} has a different themeKey (${def.themeKey} != ${expectedTheme})`,
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

  const owner = new Map<string, string>();
  for (const manifest of manifests) {
    for (const key of manifest.members) {
      const existing = owner.get(key);
      if (existing && existing !== manifest.seriesKey) {
        throw new Error(`title ${key} belongs to multiple series: ${existing}, ${manifest.seriesKey}`);
      }
      owner.set(key, manifest.seriesKey);
    }
  }
}
