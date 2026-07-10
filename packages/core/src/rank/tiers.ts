/**
 * ランク（テキスト・ボイス）の称号と経験値カーブ。
 * レベル → 累計必要XP は等差的に増える（毎レベルで一定量ずつ要求量が増える）。
 * 各種閾値・名称は冥獄城の世界観に合わせた完全オリジナル。
 */

export interface RankTier {
  minLevel: number;
  name: string;
}

/** テキスト称号（発言レベルに応じて変化）*/
export const TEXT_TIERS: RankTier[] = [
  { minLevel: 0, name: "無言の魂" },
  { minLevel: 5, name: "囁く者" },
  { minLevel: 15, name: "談笑の徒" },
  { minLevel: 30, name: "口達者" },
  { minLevel: 50, name: "饒舌の亡霊" },
  { minLevel: 75, name: "言葉の冥王" },
  { minLevel: 100, name: "冥獄の弁士" },
  { minLevel: 130, name: "冥獄の詩人" },
  { minLevel: 150, name: "冥獄の言霊" },
];

/** ボイス称号（浮上レベルに応じて変化）*/
export const VOICE_TIERS: RankTier[] = [
  { minLevel: 0, name: "気配ある魂" },
  { minLevel: 5, name: "たゆたう影" },
  { minLevel: 15, name: "浮上者" },
  { minLevel: 30, name: "常連の亡霊" },
  { minLevel: 50, name: "冥獄の住人" },
  { minLevel: 75, name: "浮上の主" },
  { minLevel: 100, name: "冥獄の魂柱" },
  { minLevel: 130, name: "浮上の冥王" },
  { minLevel: 150, name: "冥獄の永久魂" },
];

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
export function tierFor(level: number, tiers: RankTier[]): RankTier {
  let current = tiers[0]!;
  for (const t of tiers) {
    if (level >= t.minLevel) current = t;
    else break;
  }
  return current;
}

/** レベル → 「次の称号までのレベル差」（無ければnull） */
export function nextTier(level: number, tiers: RankTier[]): RankTier | null {
  for (const t of tiers) if (t.minLevel > level) return t;
  return null;
}
