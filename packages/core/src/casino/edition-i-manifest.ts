import type { CasinoActivityKey } from "./participation-history.js";

/**
 * Titles v2 がいう「第I期 core game family」の版付き正本。
 *
 * `CASINO_ACTIVITY_KEYS` は運用上記録できる全activity（競馬・サシ・インディアン等）であり、
 * Edition-I の会員集合ではない。将来activityが追加されても、このmanifestを明示改訂しない
 * 限りNo.69の必要familyは増減しない。
 *
 * 根拠: `docs/casino/マモンの賭場_常設パネル仕様_2026-08-18.md` の
 * 「常設パネル > 基本ゲーム入口」に明記された8ゲーム。
 */
export const CASINO_EDITION_I_MANIFEST = {
  editionKey: "casino-edition-i",
  version: 1,
  families: [
    { familyKey: "slots", activityKeys: ["slots"] },
    { familyKey: "chohan", activityKeys: ["chohan"] },
    { familyKey: "crash", activityKeys: ["crash"] },
    { familyKey: "chinchiro", activityKeys: ["chinchiro"] },
    { familyKey: "roulette", activityKeys: ["roulette"] },
    { familyKey: "blackjack", activityKeys: ["blackjack"] },
    { familyKey: "poker", activityKeys: ["poker"] },
    { familyKey: "holdem", activityKeys: ["holdem"] },
  ],
} as const satisfies {
  readonly editionKey: string;
  readonly version: number;
  readonly families: readonly {
    readonly familyKey: string;
    readonly activityKeys: readonly CasinoActivityKey[];
  }[];
};

export type CasinoEditionIFamily = (typeof CASINO_EDITION_I_MANIFEST.families)[number]["familyKey"];

const FAMILY_BY_ACTIVITY = new Map<CasinoActivityKey, CasinoEditionIFamily>(
  CASINO_EDITION_I_MANIFEST.families.flatMap((family) =>
    family.activityKeys.map((activityKey) => [activityKey, family.familyKey] as const),
  ),
);

/** Edition-I外のactivityはundefined。全casino activityを自動採用しない。 */
export function casinoEditionIFamilyFor(activityKey: CasinoActivityKey): CasinoEditionIFamily | undefined {
  return FAMILY_BY_ACTIVITY.get(activityKey);
}
