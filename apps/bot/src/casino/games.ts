export const CASINO_SOLO_GAMES = [
  "スロット",
  "丁半",
  "クラッシュ",
  "チンチロ",
  "ブラックジャック",
  "ポーカー",
  "ホールデム",
] as const;

export type CasinoSoloGame = (typeof CASINO_SOLO_GAMES)[number];

export const CASINO_SOLO_GAME_EMOJI: Readonly<Record<CasinoSoloGame, string>> = {
  スロット: "🎰",
  丁半: "🎲",
  クラッシュ: "📈",
  チンチロ: "🎲",
  ブラックジャック: "🃏",
  ポーカー: "🃏",
  ホールデム: "🃏",
};

export const CASINO_SOLO_GAME_DESCRIPTIONS: Readonly<Record<CasinoSoloGame, string>> = {
  スロット: "ジャックポットを狙う",
  丁半: "偶数か奇数を当てる",
  クラッシュ: "上がる前に逃げる",
  チンチロ: "最大損失は賭け額の2倍",
  ブラックジャック: "21を目指す",
  ポーカー: "役を作って勝負",
  ホールデム: "共有札で勝負",
};

const CASINO_SOLO_GAME_SET = new Set<string>(CASINO_SOLO_GAMES);

export function isCasinoSoloGame(game: string): game is CasinoSoloGame {
  return CASINO_SOLO_GAME_SET.has(game);
}
