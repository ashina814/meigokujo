import { describe, expect, it } from "vitest";
import { buildChinchiroDuelResult } from "../src/casino/chinchiro-duel.js";
import { buildPvpResult } from "../src/casino/pvp-common.js";

function assertRenderedWinner(
  embed: { toJSON(): { title?: string; description?: string } },
  winnerId: string,
  loserId: string,
): void {
  const json = embed.toJSON();
  expect(json.title).not.toContain("<@");
  expect(json.title).not.toContain(winnerId);
  expect(json.description).toContain(`**勝者** <@${winnerId}>`);
  expect(json.description).toContain(`**敗者** <@${loserId}>`);
}

describe("PvPの勝敗表示", () => {
  it("共通結果はタイトルにmentionを置かず、勝者・敗者を本文で表示する", () => {
    const winnerId = "1238676215506931778";
    const loserId = "987654321012345678";
    const embed = buildPvpResult({
      game: "ブラックジャック対戦",
      icon: "🃏",
      winnerId,
      loserId,
      bet: 10_000,
      payout: 19_400,
      houseCut: 600,
    });

    assertRenderedWinner(embed, winnerId, loserId);
    expect(embed.toJSON().title).toBe("🃏  ブラックジャック対戦 — 決着");
  });

  it("対戦チンチロもタイトルにmentionを置かず、勝者・敗者を本文で表示する", () => {
    const winnerId = "1238676215506931778";
    const loserId = "987654321012345678";
    const embed = buildChinchiroDuelResult(winnerId, loserId, 10_000, 19_400, 600);

    assertRenderedWinner(embed, winnerId, loserId);
    expect(embed.toJSON().title).toBe("🎲 対戦チンチロ — 決着");
    expect(embed.toJSON().description).toContain("+9,400 Ld");
    expect(embed.toJSON().description).toContain("場代 600 Ld → JPプール");
  });

  it("共通結果の引き分け表示にも人物IDをタイトルへ出さない", () => {
    const embed = buildPvpResult({
      game: "インディアンポーカー",
      icon: "🪶",
      winnerId: null,
      bet: 500,
      payout: 0,
      houseCut: 0,
    });
    const json = embed.toJSON();

    expect(json.title).toBe("🪶  インディアンポーカー — 引き分け");
    expect(json.title).not.toContain("<@");
    expect(json.description).toBe("両者に返金。");
  });
});
