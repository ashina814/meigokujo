/** 公開募集に対応する 1v1 ゲーム。丁半・ポーカーは既存の多人数受付を使うのでここに含めない */
/**
 * `riskGame` は **台帳へ入る内部識別子**。`dailyRisk.authorizeExposure({ game })` と
 * `escrow.holdAll(..., game, ...)` に渡るので、公開募集と `/勝負` の指名で
 * **同じ値でなければならない**（違うと同じゲームの記録が2種類の名前で混ざる）。
 * `label` は表示専用。
 */
export const PVP_GAMES = [
  { key: "chinchiro", label: "チンチロ", emoji: "🎲", riskGame: "chinchiro-duel" },
  { key: "bj", label: "BJ", emoji: "🃏", riskGame: "bj-duel" },
  { key: "sashi", label: "サシ", emoji: "⚔", riskGame: "sashi" },
  { key: "indian", label: "インディアン", emoji: "🃏", riskGame: "indian" },
] as const;

export type PvpGameKey = (typeof PVP_GAMES)[number]["key"];

export function pvpGame(key: string): (typeof PVP_GAMES)[number] | undefined {
  return PVP_GAMES.find((g) => g.key === key);
}
