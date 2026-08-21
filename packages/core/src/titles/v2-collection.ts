import { assertSlug, type TitleDefinition } from "./v2-contract.js";

/**
 * Collection Edition / Full-clear契約。
 *
 * Collection Editionはtitle catalogとは別概念——「このtitleを集める対象とするか」を
 * 独立したimmutable manifestとして持つ。旧countsForCompletionのようにtitle definition
 * 自身へCollection Credit / Full-clear Requiredを持たせない（廃止済み。§2参照）。
 * DB persistenceは後続PR、ここでは型とvalidationだけを固定する。
 *
 * 意図的に `catalog` フィールドを持たせない: collection editionは将来的に複数catalog
 * （第I期・第II期等）由来のbehavior titleを1つのfull-clear edition（例: 全期間通しての
 * 万印皆伝）へ束ねる必要がある。単一catalogへ拘束する設計上の根拠が無いため、
 * memberごとのtitleKeyから実際のdefinitionを引いてthemeKey等を検証すれば足り、
 * edition自体がcatalogを名乗る必要は無い。
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
  readonly members: readonly TitleCollectionMember[];
  readonly milestones: TitleCollectionMilestonePolicy;
}

/**
 * - member重複禁止
 * - member titleが実在する（allDefinitionsに含まれる）
 * - member.themeKeyがdefinition.themeKeyと一致する
 * - meta titleをcollectionCredit/fullClearRequiredのどちらにもしない
 *   （meta titleはcollection/full-clearの分母・分子どちらへも入らない——meta title自体が
 *   「有効なcollection editionを満たしたか」を判定する側であり、判定対象の一部を
 *   兼ねると自己参照的になる）
 * - fullClearRequired titleが最低1件存在する
 *
 * milestoneはcollectionCredit:trueのmemberだけから算出した
 * countableCount（collectionCredit:trueなmember数）・countableThemes
 * （collectionCredit:trueなmemberのdistinct themeKey数）を基準に、以下を検証する。
 *
 * - milestone値はいずれも非負整数
 * - startedCollecting >= 1
 * - startedCollecting < collectorHabit < stillCollecting
 * - stillCollecting <= thousandMarks.count <= countableCount
 * - thousandMarks.themes >= 1
 * - thousandMarks.themes <= countableThemes
 * - thousandMarks.themes <= thousandMarks.count
 * - almostComplete.remaining >= 1
 * - almostComplete.remaining < fullClearCount（full-clear required総数）
 */
export function assertValidCollectionEdition(
  edition: TitleCollectionEdition,
  allDefinitions: ReadonlyMap<string, TitleDefinition>,
): void {
  assertSlug(edition.editionKey, "collection edition editionKey");
  if (edition.members.length === 0) {
    throw new Error(`collection edition ${edition.editionKey}: at least one member is required`);
  }

  const seen = new Set<string>();
  const countableThemes = new Set<string>();
  let countableCount = 0;
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
    if (def.kind === "meta") {
      if (member.collectionCredit) {
        throw new Error(
          `collection edition ${edition.editionKey}: meta title cannot be a collection member (collectionCredit): ${member.titleKey}`,
        );
      }
      if (member.fullClearRequired) {
        throw new Error(
          `collection edition ${edition.editionKey}: meta title cannot be fullClearRequired: ${member.titleKey}`,
        );
      }
    }

    // collectionCredit:falseのmemberのthemeは、theme breadth集計の分母（countableThemes）
    // へ数えない——「集めた/集めていない」の対象にしていないtitleのthemeを、
    // 千印万来のtheme breadth判定に混ぜると、実質未対象のthemeで達成扱いになってしまう。
    if (member.collectionCredit) {
      countableCount += 1;
      countableThemes.add(member.themeKey);
    }
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

  const fail = (message: string): never => {
    throw new Error(`collection edition ${edition.editionKey}: ${message}`);
  };

  if (m.startedCollecting < 1) fail(`startedCollecting (${m.startedCollecting}) must be >= 1`);
  if (!(m.startedCollecting < m.collectorHabit)) {
    fail(`startedCollecting (${m.startedCollecting}) must be < collectorHabit (${m.collectorHabit})`);
  }
  if (!(m.collectorHabit < m.stillCollecting)) {
    fail(`collectorHabit (${m.collectorHabit}) must be < stillCollecting (${m.stillCollecting})`);
  }
  if (!(m.stillCollecting <= m.thousandMarks.count)) {
    fail(`stillCollecting (${m.stillCollecting}) must be <= thousandMarks.count (${m.thousandMarks.count})`);
  }
  if (!(m.thousandMarks.count <= countableCount)) {
    fail(`thousandMarks.count (${m.thousandMarks.count}) exceeds countable collection count (${countableCount})`);
  }
  if (m.thousandMarks.themes < 1) fail(`thousandMarks.themes (${m.thousandMarks.themes}) must be >= 1`);
  if (!(m.thousandMarks.themes <= countableThemes.size)) {
    fail(`thousandMarks.themes (${m.thousandMarks.themes}) exceeds countable theme count (${countableThemes.size})`);
  }
  if (!(m.thousandMarks.themes <= m.thousandMarks.count)) {
    fail(`thousandMarks.themes (${m.thousandMarks.themes}) must be <= thousandMarks.count (${m.thousandMarks.count})`);
  }
  if (m.almostComplete.remaining < 1) fail(`almostComplete.remaining (${m.almostComplete.remaining}) must be >= 1`);
  if (!(m.almostComplete.remaining < fullClearCount)) {
    fail(
      `almostComplete.remaining (${m.almostComplete.remaining}) must be less than the full-clear required count (${fullClearCount})`,
    );
  }
}
