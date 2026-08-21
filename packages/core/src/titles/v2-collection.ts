import { assertSlug, type TitleDefinition } from "./v2-contract.js";

/**
 * Collection Edition / Full-clear契約。
 *
 * Collection Editionはtitle catalogとは別概念——「このcatalogのどのtitleを集める
 * 対象とするか」を独立したimmutable manifestとして持つ。旧countsForCompletionのように
 * title definition自身へCollection Credit / Full-clear Requiredを持たせない
 * （廃止済み。§2参照）。DB persistenceは後続PR、ここでは型とvalidationだけを固定する。
 *
 * 《千印万来》《万印皆伝》のようなmeta titleのsemanticは、絶対的な閾値をmeta title
 * 自身に持たせず「有効なcollection/full-clear editionのmilestone policyを満たしたか」
 * とする——catalog規模が変われば新しいeditionを作ればよく、meta title自体のkeyや
 * 判定ロジックを変えなくて済む。
 */
export interface TitleCollectionMember {
  readonly titleKey: `v2.${string}`;
  readonly themeKey: string;
  readonly collectionCredit: boolean;
  readonly fullClearRequired: boolean;
}

/**
 * milestoneの絶対値。catalog規模によって変わるため、meta title自身ではなく
 * edition側が持つ。
 */
export interface TitleCollectionMilestonePolicy {
  readonly startedCollecting: number;
  readonly collectorHabit: number;
  readonly stillCollecting: number;
  readonly thousandMarks: { readonly count: number; readonly themes: number };
  readonly almostComplete: { readonly remaining: number };
}

export interface TitleCollectionEdition {
  readonly editionKey: string;
  readonly catalog: string;
  readonly members: readonly TitleCollectionMember[];
  readonly milestones: TitleCollectionMilestonePolicy;
}

/**
 * - member重複禁止
 * - member titleが実在する（allDefinitionsに含まれる）
 * - member.themeKeyがdefinition.themeKeyと一致する
 * - meta titleをfullClearRequiredにしない
 * - fullClearRequired titleが最低1件存在する
 * - milestone値は負数不可
 * - thousandMarks.themes は数えられるtheme数を超えない
 * - almostComplete.remaining はfull-clear required総数未満
 */
export function assertValidCollectionEdition(
  edition: TitleCollectionEdition,
  allDefinitions: ReadonlyMap<string, TitleDefinition>,
): void {
  assertSlug(edition.editionKey, "collection edition editionKey");
  if (!edition.catalog.trim()) throw new Error(`collection edition ${edition.editionKey}: catalog is required`);
  if (edition.members.length === 0) {
    throw new Error(`collection edition ${edition.editionKey}: at least one member is required`);
  }

  const seen = new Set<string>();
  const themes = new Set<string>();
  let fullClearCount = 0;

  for (const member of edition.members) {
    if (seen.has(member.titleKey)) {
      throw new Error(`collection edition ${edition.editionKey}: duplicate member ${member.titleKey}`);
    }
    seen.add(member.titleKey);

    const def = allDefinitions.get(member.titleKey);
    if (!def) throw new Error(`collection edition ${edition.editionKey}: member title not found: ${member.titleKey}`);
    if (def.themeKey !== member.themeKey) {
      throw new Error(
        `collection edition ${edition.editionKey}: member ${member.titleKey} themeKey mismatch ` +
          `(definition=${def.themeKey}, manifest=${member.themeKey})`,
      );
    }
    if (member.fullClearRequired && def.kind === "meta") {
      throw new Error(`collection edition ${edition.editionKey}: meta title cannot be fullClearRequired: ${member.titleKey}`);
    }

    themes.add(member.themeKey);
    if (member.fullClearRequired) fullClearCount += 1;
  }

  if (fullClearCount === 0) {
    throw new Error(`collection edition ${edition.editionKey}: at least one fullClearRequired member must exist`);
  }

  const m = edition.milestones;
  const milestoneEntries: ReadonlyArray<readonly [string, number]> = [
    ["startedCollecting", m.startedCollecting],
    ["collectorHabit", m.collectorHabit],
    ["stillCollecting", m.stillCollecting],
    ["thousandMarks.count", m.thousandMarks.count],
    ["thousandMarks.themes", m.thousandMarks.themes],
    ["almostComplete.remaining", m.almostComplete.remaining],
  ];
  for (const [label, value] of milestoneEntries) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`collection edition ${edition.editionKey}: milestone ${label} must be a non-negative integer`);
    }
  }
  if (m.thousandMarks.themes > themes.size) {
    throw new Error(
      `collection edition ${edition.editionKey}: thousandMarks.themes (${m.thousandMarks.themes}) exceeds countable theme count (${themes.size})`,
    );
  }
  if (m.almostComplete.remaining >= fullClearCount) {
    throw new Error(
      `collection edition ${edition.editionKey}: almostComplete.remaining (${m.almostComplete.remaining}) ` +
        `must be less than the full-clear required count (${fullClearCount})`,
    );
  }
}
