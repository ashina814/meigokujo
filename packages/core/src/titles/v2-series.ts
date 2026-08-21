import { assertSlug, type BehaviorTitleDefinition } from "./v2-contract.js";

/**
 * 連番progressionを持つtitle群を束ねる、immutableなmanifest契約。
 *
 * title definitionsを自動走査して「現在存在するstage全部」を一門皆伝（mastery）対象に
 * する方式は禁止——`members` そのものがimmutable manifestであり、後からstage5を追加
 * しても既存manifestのmembersは書き換えない（新しいmanifest行を別途作る）。DB
 * persistenceは後続PR。ここでは型とvalidationだけを固定する。
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
  if (!manifest.catalog.trim()) throw new Error(`series ${manifest.seriesKey}: catalog is required`);
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
 * 複数manifestを横断して「1 titleが複数seriesへ所属していないか」を検証する。
 * 単一manifest内の重複は assertValidSeriesManifest() が既に見ているので、
 * これは別seriesどうしの重複だけを見る。
 */
export function assertNoOverlappingSeriesMembership(manifests: readonly TitleSeriesManifest[]): void {
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
