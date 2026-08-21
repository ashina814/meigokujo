import { canonicalHash } from "../casino/opening-canonical.js";
import { assertSlug, type TitleDefinition } from "./v2-contract.js";

/**
 * Collection Edition / Full-clear契約。
 *
 * Collection Editionはtitle catalogとは別概念——「このtitleを集める対象とするか」を
 * 独立したimmutable manifestとして持つ。旧countsForCompletionのようにtitle definition
 * 自身へCollection Credit / Full-clear Requiredを持たせない（廃止済み。§2参照）。
 * DB persistence（`title_collection_editions` 等）は `v2-collection-store.ts`（PR B2）
 * が担う。ここでは型とvalidationを固定する。
 *
 * 意図的に `catalog` フィールドを持たせない: collection editionは将来的に複数catalog
 * （第I期・第II期等）由来のbehavior titleを1つのfull-clear edition（例: 全期間通しての
 * 万印皆伝）へ束ねる必要がある。単一catalogへ拘束する設計上の根拠が無いため、
 * memberごとのtitleKeyから実際のdefinitionを引いてcollectionDomainKey等を検証すれば
 * 足り、edition自体がcatalogを名乗る必要は無い。
 *
 * 《千印万来》《万印皆伝》のようなmeta titleのsemanticは、絶対的な閾値をmeta title
 * 自身に持たせず「有効なcollection/full-clear editionのmilestone policyを満たしたか」
 * とする——catalog規模が変われば新しいeditionを作ればよく、meta title自体のkeyや
 * 判定ロジックを変えなくて済む。
 *
 * ## 構造契約とactivation eligibilityの分離
 *
 * `assertValidCollectionEdition()` は時間が経っても変わらない**構造契約**だけを見る
 * （member重複・title実在・collectionDomainKey一致・meta除外・milestone整合性等）。member titleの
 * `lifecycle`（現在activeかどうか）は構造契約に含めない——これはeditionのimmutable契約
 * （下記）と衝突するため。
 *
 * `assertCollectionEditionActivatable()` が構造契約に加えて「今このeditionを新規
 * activateしてよいか」（＝required titleが現在も取得可能か）を見る。historical repair
 * （後述）のために閉じたeditionを保持し続ける場合、この関数はもう通らなくてよい
 * ——構造としては最後まで有効なmanifestのままでよい。
 *
 * ## historical repairとの整合性（collection editionもimmutable）
 *
 * collection editionはtitle catalogと同様、一度公開したら**members・milestoneを
 * 書き換えない**。ある時点でrequired titleがretired/disabledになった場合でも、
 * そのeditionが「当時は有効だった」という事実は変わらない——後日「当時edition Aを
 * complete済みだったユーザー」を修復評価（historical repair）するには、edition A
 * の構造そのものが引き続きvalidである必要がある。
 *
 * 運用の想定手順:
 * 1. active editionのrequired/collection titleをretire/disableする必要が生じたら、
 *    まず**そのeditionをclose**する（`v2-collection-store.ts` の `closeCollectionEdition()`）。
 * 2. old editionのmanifest（members/milestones）は変更しない。
 * 3. 次のeditionを、新しいmember set（retireしたtitleを含まない）で作る。
 * 4. closed editionはhistorical repairのために保持し続ける——`assertValidCollectionEdition()`
 *    は通り続けるが、`assertCollectionEditionActivatable()` は通らなくなる（それでよい）。
 *    close以降にpost-close acquisitionされたtitleは旧editionのprogressへcreditしない
 *    （`v2-collection-store.ts` の historical repair proof契約参照）。
 */
export interface TitleCollectionMember {
  readonly titleKey: `v2.${string}`;
  /**
   * collection breadth判定用のsemantic identity（`BehaviorTitleDefinition.collectionDomainKey`
   * と一致させる）。`themeKey` ではない——themeはeditorial/display専用で、collection
   * breadth集計には使わない（`v2-contract.ts` の `TitleDefinitionCommon.themeKey` 参照）。
   */
  readonly collectionDomainKey: string;
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
  readonly thousandMarks: { readonly count: number; readonly domains: number };
  readonly almostComplete: { readonly remaining: number };
}

export interface TitleCollectionEdition {
  readonly editionKey: string;
  readonly members: readonly TitleCollectionMember[];
  readonly milestones: TitleCollectionMilestonePolicy;
}

/**
 * editionの**構造契約**だけを検証する（時間が経っても変わらない不変条件）。
 * member titleの現在lifecycleは見ない——historical closed editionもこの検証は通り
 * 続ける（上のmodule doc comment「構造契約とactivation eligibilityの分離」参照）。
 *
 * - member重複禁止
 * - member titleが実在する（allDefinitionsに含まれる）
 * - member.collectionDomainKeyがdefinition.collectionDomainKeyと一致する
 *   （meta titleはcollectionDomainKeyを持たないため、meta memberはこの検証を通らない
 *   ——後続のmeta title除外チェックで先に弾かれる想定だが、万一定義順が変わっても
 *   安全なようmeta判定を先に行う）
 * - meta titleをcollectionCredit/fullClearRequiredのどちらにもしない
 *   （meta titleはcollection/full-clearの分母・分子どちらへも入らない——meta title自体が
 *   「有効なcollection editionを満たしたか」を判定する側であり、判定対象の一部を
 *   兼ねると自己参照的になる）
 * - fullClearRequired titleが最低1件存在する
 * - collectionCredit:falseかつfullClearRequired:falseのmemberは禁止
 *   （editionのmemberとして何の意味も持たない）
 *
 * milestoneはcollectionCredit:trueのmemberだけから算出した
 * countableCount（collectionCredit:trueなmember数）・countableDomains
 * （collectionCredit:trueなmemberのdistinct collectionDomainKey数）を基準に、以下を検証する。
 *
 * - milestone値はいずれも非負整数
 * - startedCollecting >= 1
 * - startedCollecting < collectorHabit < stillCollecting
 * - stillCollecting <= thousandMarks.count <= countableCount
 * - thousandMarks.domains >= 1
 * - thousandMarks.domains <= countableDomains
 * - thousandMarks.domains <= thousandMarks.count
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
  const countableDomains = new Set<string>();
  let countableCount = 0;
  let fullClearCount = 0;

  for (const member of edition.members) {
    if (seen.has(member.titleKey)) {
      throw new Error(`collection edition ${edition.editionKey}: duplicate member ${member.titleKey}`);
    }
    seen.add(member.titleKey);

    const def = allDefinitions.get(member.titleKey);
    if (!def) throw new Error(`collection edition ${edition.editionKey}: member title not found: ${member.titleKey}`);
    if (def.kind === "behavior" && def.collectionDomainKey !== member.collectionDomainKey) {
      throw new Error(
        `collection edition ${edition.editionKey}: member ${member.titleKey} collectionDomainKey mismatch ` +
          `(definition=${def.collectionDomainKey}, manifest=${member.collectionDomainKey})`,
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

    if (!member.collectionCredit && !member.fullClearRequired) {
      throw new Error(
        `collection edition ${edition.editionKey}: member ${member.titleKey} is neither collectionCredit nor fullClearRequired (meaningless edition member)`,
      );
    }

    // collectionCredit:falseのmemberのdomainは、domain breadth集計の分母
    // （countableDomains）へ数えない——「集めた/集めていない」の対象にしていない
    // titleのdomainを、千印万来のdomain breadth判定に混ぜると、実質未対象のdomainで
    // 達成扱いになってしまう。
    if (member.collectionCredit) {
      countableCount += 1;
      countableDomains.add(member.collectionDomainKey);
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
    ["thousandMarks.domains", m.thousandMarks.domains],
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
  if (m.thousandMarks.domains < 1) fail(`thousandMarks.domains (${m.thousandMarks.domains}) must be >= 1`);
  if (!(m.thousandMarks.domains <= countableDomains.size)) {
    fail(`thousandMarks.domains (${m.thousandMarks.domains}) exceeds countable domain count (${countableDomains.size})`);
  }
  if (!(m.thousandMarks.domains <= m.thousandMarks.count)) {
    fail(`thousandMarks.domains (${m.thousandMarks.domains}) must be <= thousandMarks.count (${m.thousandMarks.count})`);
  }
  if (m.almostComplete.remaining < 1) fail(`almostComplete.remaining (${m.almostComplete.remaining}) must be >= 1`);
  if (!(m.almostComplete.remaining < fullClearCount)) {
    fail(
      `almostComplete.remaining (${m.almostComplete.remaining}) must be less than the full-clear required count (${fullClearCount})`,
    );
  }
}

/**
 * editionを**今から新規activateしてよいか**（構造契約 + 現在時点のactivation
 * eligibility）を検証する。`assertValidCollectionEdition()` を先に通した上で、
 * collectionCredit/fullClearRequiredなmemberが現在すべて `lifecycle:"active"` である
 * ことを追加で要求する——retired/disabledなtitleを新規にfull-clear必須・collection
 * 対象として運用開始すると、誰にも取得不能な条件を課すことになる。
 *
 * historical closed edition（過去のユーザーをrepairするためだけに保持するedition）は、
 * この関数を通す必要は無い——`assertValidCollectionEdition()` だけが通り続けていれば
 * 構造としては引き続き有効で、repair用途には十分（module doc comment参照）。
 */
export function assertCollectionEditionActivatable(
  edition: TitleCollectionEdition,
  allDefinitions: ReadonlyMap<string, TitleDefinition>,
): void {
  assertValidCollectionEdition(edition, allDefinitions);

  for (const member of edition.members) {
    if (!member.collectionCredit && !member.fullClearRequired) continue; // 構造validationで既に弾かれているはず
    const def = allDefinitions.get(member.titleKey);
    if (!def) throw new Error(`collection edition ${edition.editionKey}: member title not found: ${member.titleKey}`);
    if (def.lifecycle !== "active") {
      throw new Error(
        `collection edition ${edition.editionKey}: cannot activate — member ${member.titleKey} is not active ` +
          `(lifecycle=${def.lifecycle}) but is collectionCredit/fullClearRequired`,
      );
    }
  }
}

/**
 * Collection Editionもimmutable semantic hashを持つ（PR B2）——activation後に
 * members/milestoneが書き換えられていないかをconstruction-time integrityで検出する。
 *
 * hash対象: `editionKey` / `milestones`（全milestone値） / member（titleKey順に
 * sortした上での titleKey・collectionDomainKey・collectionCredit・fullClearRequired）。
 * member入力順はsemanticではないため、titleKey順へcanonicalizeしてからhashする。
 *
 * hashから除外: `activatedAt` / `activatedBy`（actor） / `activationNote` / close
 * metadata——これらはeditionの構造そのものではなく運用ログであり、後から変わっても
 * editionのsemanticは変わらない。
 */
export function computeCollectionEditionHash(edition: TitleCollectionEdition): string {
  const canonicalMembers = [...edition.members]
    .sort((a, b) => a.titleKey.localeCompare(b.titleKey))
    .map((m) => [m.titleKey, m.collectionDomainKey, m.collectionCredit, m.fullClearRequired] as const);
  return canonicalHash({
    editionKey: edition.editionKey,
    milestones: edition.milestones,
    members: canonicalMembers,
  });
}
