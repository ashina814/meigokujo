/** 公開募集に対応する 1v1 ゲーム。丁半・ポーカーは既存の多人数受付を使うのでここに含めない */
export const PVP_GAMES = [
  { key: "chinchiro", label: "チンチロ", emoji: "🎲" },
  { key: "bj", label: "BJ", emoji: "🃏" },
  { key: "sashi", label: "サシ", emoji: "⚔" },
  { key: "indian", label: "インディアン", emoji: "🃏" },
] as const;

export type PvpGameKey = (typeof PVP_GAMES)[number]["key"];

export function pvpGame(key: string): (typeof PVP_GAMES)[number] | undefined {
  return PVP_GAMES.find((g) => g.key === key);
}
