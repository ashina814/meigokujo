/**
 * ランク（テキスト・ボイス）の称号と経験値カーブ。
 * レベル → 累計必要XP は等差的に増える（毎レベルで一定量ずつ要求量が増える）。
 * 各種閾値・名称は冥獄城の世界観に合わせた完全オリジナル。
 *
 * PR B3: `RankTier` へstable identity（`key`）を追加した。DB identity
 * （`rank_title_unlocks` / `profile_identity_equips`、`packages/core/src/titles/
 * v2-identity-store.ts`）は必ずこの`key`を正本にする——display name・array index・
 * `last_tier`のnumeric index・`minLevel`だけをidentityとして使わない。`key`/`name`/
 * `minLevel`の組は、released後は実質freezeとして扱うこと（display typo修正等を除く）。
 * threshold semanticを変更するなら原則新keyにする。
 */

export type RankTrack = "text" | "voice";
export type RankTitleKey = `rank.${RankTrack}.${string}`;

export interface RankTier {
  readonly key: RankTitleKey;
  readonly track: RankTrack;
  readonly minLevel: number;
  readonly name: string;
}

function tier(key: RankTitleKey, track: RankTrack, minLevel: number, name: string): RankTier {
  return Object.freeze({ key, track, minLevel, name });
}

/**
 * 18件のstable key/track/minLevel/nameは明示的literalとして固定する——
 * `` `rank.${track}.lv${minLevel}` `` のようなruntime組み立てにしない。keyがstable
 * identityであり、minLevel/nameはそのkeyのcontract。
 */

/** テキスト称号（発言レベルに応じて変化）*/
export const TEXT_TIERS: readonly RankTier[] = Object.freeze([
  tier("rank.text.lv000", "text", 0, "無言の魂"),
  tier("rank.text.lv005", "text", 5, "囁く者"),
  tier("rank.text.lv015", "text", 15, "談笑の徒"),
  tier("rank.text.lv030", "text", 30, "口達者"),
  tier("rank.text.lv050", "text", 50, "饒舌の亡霊"),
  tier("rank.text.lv075", "text", 75, "言葉の冥王"),
  tier("rank.text.lv100", "text", 100, "冥獄の弁士"),
  tier("rank.text.lv130", "text", 130, "冥獄の詩人"),
  tier("rank.text.lv150", "text", 150, "冥獄の言霊"),
]);

/** ボイス称号（浮上レベルに応じて変化）*/
export const VOICE_TIERS: readonly RankTier[] = Object.freeze([
  tier("rank.voice.lv000", "voice", 0, "気配ある魂"),
  tier("rank.voice.lv005", "voice", 5, "たゆたう影"),
  tier("rank.voice.lv015", "voice", 15, "浮上者"),
  tier("rank.voice.lv030", "voice", 30, "常連の亡霊"),
  tier("rank.voice.lv050", "voice", 50, "冥獄の住人"),
  tier("rank.voice.lv075", "voice", 75, "浮上の主"),
  tier("rank.voice.lv100", "voice", 100, "冥獄の魂柱"),
  tier("rank.voice.lv130", "voice", 130, "浮上の冥王"),
  tier("rank.voice.lv150", "voice", 150, "冥獄の永久魂"),
]);

/**
 * registry contractをfail-fastで検証する。モジュール読み込み時に一度だけ実行する
 * ——typoやarray順の事故を、実際にDBへ書き込まれる前にimport時点で検出する。
 *
 * 任意の`(track, tiers)`の組に対して独立して呼べるよう、モジュール内蔵の
 * TEXT_TIERS/VOICE_TIERSへ直接依存しない形にしてある——testが壊れたfixtureを
 * 直接構築して、このvalidatorに通せるようにするため。実際のmodule load時には
 * TEXT_TIERS/VOICE_TIERSを渡して呼ぶ（下記）。
 */
export function assertRankTierRegistry(entries: ReadonlyArray<readonly [RankTrack, readonly RankTier[]]>): void {
  const seenKeys = new Set<RankTitleKey>();
  for (const [track, tiers] of entries) {
    if (tiers.length === 0) throw new Error(`rank tier registry: ${track} track must not be empty`);
    if (tiers[0]!.minLevel !== 0) {
      throw new Error(`rank tier registry: ${track} track's first tier must have minLevel=0 (got ${tiers[0]!.minLevel})`);
    }
    const expectedPrefix = `rank.${track}.`;
    let prevMinLevel = -1;
    for (const t of tiers) {
      if (t.track !== track) {
        throw new Error(`rank tier registry: tier ${t.key} declares track=${t.track}, expected ${track}`);
      }
      if (!t.key.startsWith(expectedPrefix)) {
        throw new Error(`rank tier registry: key ${t.key} must start with "${expectedPrefix}"`);
      }
      if (!Number.isInteger(t.minLevel) || t.minLevel < 0) {
        throw new Error(`rank tier registry: ${t.key} minLevel must be a non-negative integer (got ${t.minLevel})`);
      }
      if (t.minLevel <= prevMinLevel) {
        throw new Error(
          `rank tier registry: ${track} track minLevel must strictly increase (${t.key}: ${t.minLevel} <= ${prevMinLevel})`,
        );
      }
      prevMinLevel = t.minLevel;
      if (t.name.trim().length === 0) {
        throw new Error(`rank tier registry: ${t.key} name must be non-empty after trim`);
      }
      if (seenKeys.has(t.key)) {
        throw new Error(`rank tier registry: duplicate key ${t.key} (keys must be unique across all tracks)`);
      }
      seenKeys.add(t.key);
    }
  }
}
assertRankTierRegistry([
  ["text", TEXT_TIERS],
  ["voice", VOICE_TIERS],
]);

const ALL_TIERS: readonly RankTier[] = Object.freeze([...TEXT_TIERS, ...VOICE_TIERS]);

/**
 * keyからtierを引く。**unknown keyはnullではなくundefinedを返す**——呼び出し側の
 * 用途（integrity違反としてthrowする・単に「見つからなかった」を許容する等）に
 * よって扱いが変わるため、ここでは決め打ちのfallback値を返さない。
 */
export function rankTierByKey(key: string): RankTier | undefined {
  return ALL_TIERS.find((t) => t.key === key);
}

export function rankTiersForTrack(track: RankTrack): readonly RankTier[] {
  return track === "text" ? TEXT_TIERS : VOICE_TIERS;
}

/** レベル N → N+1 に必要なXP（Nは0起点） */
export function textXpPerLevel(level: number): number {
  return 100 + level * 50;
}
export function voiceXpPerLevel(level: number): number {
  return 200 + level * 100;
}

/** 累計XPからレベルを求める（0起点、xp=0でLv0） */
function levelFromXp(xp: number, perLevel: (l: number) => number): number {
  let level = 0;
  let acc = 0;
  while (true) {
    const need = perLevel(level);
    if (acc + need > xp) return level;
    acc += need;
    level += 1;
    if (level > 500) return level;
  }
}

export function textLevel(xp: number): number {
  return levelFromXp(xp, textXpPerLevel);
}
export function voiceLevel(xp: number): number {
  return levelFromXp(xp, voiceXpPerLevel);
}

/** 現レベルの進捗（現レベル内で溜まったXP / 次レベルまでの必要XP） */
export function textProgress(xp: number): { level: number; inLevel: number; toNext: number } {
  const level = textLevel(xp);
  let acc = 0;
  for (let l = 0; l < level; l++) acc += textXpPerLevel(l);
  return { level, inLevel: xp - acc, toNext: textXpPerLevel(level) };
}
export function voiceProgress(xp: number): { level: number; inLevel: number; toNext: number } {
  const level = voiceLevel(xp);
  let acc = 0;
  for (let l = 0; l < level; l++) acc += voiceXpPerLevel(l);
  return { level, inLevel: xp - acc, toNext: voiceXpPerLevel(level) };
}

/** レベル → 称号 */
export function tierFor(level: number, tiers: readonly RankTier[]): RankTier {
  let current = tiers[0]!;
  for (const t of tiers) {
    if (level >= t.minLevel) current = t;
    else break;
  }
  return current;
}

/** レベル → 「次の称号までのレベル差」（無ければnull） */
export function nextTier(level: number, tiers: readonly RankTier[]): RankTier | null {
  for (const t of tiers) if (t.minLevel > level) return t;
  return null;
}
