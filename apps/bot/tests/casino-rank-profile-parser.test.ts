import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({ config: { ownerId: "owner-user" } }));

import { parseRankDeltaTokens } from "../src/commands/admin-hub.js";

/**
 * PR24 レビュー BLOCKER 3: 順位配分は配当に直結する信頼設定なので、
 * 読めない語を黙って捨てて登録してはいけない。
 */
describe("順位配分の入力は全件 strict に読む", () => {
  it("10進整数だけの入力を、入力された順位の件数そのままで受け取る", () => {
    expect(parseRankDeltaTokens("10000, 0, -10000")).toEqual([10_000, 0, -10_000]);
    expect(parseRankDeltaTokens("10000 -10000")).toEqual([10_000, -10_000]);
    expect(parseRankDeltaTokens("+5000, -5000")).toEqual([5_000, -5_000]);
    // 空白・カンマ混在と余分な区切りは既存UXのまま許す
    expect(parseRankDeltaTokens("  10000 ,, -10000  ")).toEqual([10_000, -10_000]);
  });

  it("不正トークンが1つでもあれば入力全体を拒否する（読み飛ばさない）", () => {
    // 以前はこれが [10000, -10000] の2人卓として登録されえた
    expect(parseRankDeltaTokens("10000, foo, -10000")).toBeNull();
    expect(parseRankDeltaTokens("10000, 1.5, -10000")).toBeNull();
    expect(parseRankDeltaTokens("10000, 1e4, -20000")).toBeNull();
    expect(parseRankDeltaTokens("10000, 0x100, -10000")).toBeNull();
    expect(parseRankDeltaTokens("10000, NaN, -10000")).toBeNull();
    expect(parseRankDeltaTokens("10000, Infinity, -10000")).toBeNull();
    expect(parseRankDeltaTokens("10000, -Infinity, -10000")).toBeNull();
    expect(parseRankDeltaTokens("10000, , -10000, bar")).toBeNull();
  });

  it("安全な整数の範囲を超える値も拒否する", () => {
    expect(parseRankDeltaTokens("99999999999999999999, -99999999999999999999")).toBeNull();
  });

  it("順位が2つ未満の入力は拒否する", () => {
    expect(parseRankDeltaTokens("")).toBeNull();
    expect(parseRankDeltaTokens("   ")).toBeNull();
    expect(parseRankDeltaTokens("10000")).toBeNull();
  });

  it("人数は「有効だったトークン数」ではなく入力された順位の件数になる", () => {
    // 3件入れて1件が不正なら 2人卓にはならず、登録そのものが起きない
    expect(parseRankDeltaTokens("10000, foo, -10000")).toBeNull();
    expect(parseRankDeltaTokens("10000, 0, -10000")).toHaveLength(3);
  });
});
