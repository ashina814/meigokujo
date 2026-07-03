import { describe, expect, it } from "vitest";
import { parseBalanceDump, splitForMigration } from "../src/migration/parse.js";

// 実データ（2026-07-04 ダンプ）から抜粋した代表ケース
const SAMPLE = `
01 | 酤-Hitoyozake-: 28455109570032424 Ld (手:8999999999100000 / 預:10455109570932424 / 業:9000000000000000)
04 | Belphegor: 7648595 Ld (手:50000 / 預:613595 / 業:6985000)
08 | 橋本: 3115933 Ld (手:459800 / 預:253133 / 業:2403000)
32 | 橋本: 325000 Ld (手:325000 / 預:0 / 業:0)
43 | 江戸川乱歩: 196719 Ld (手:169005 / 預:27714 / 業:0)
45 | eiπ+1=0: 181000 Ld (手:181000 / 預:0 / 業:0)
65 | 神！神！俺に逆らうなDX: 80000 Ld (手:80000 / 預:0 / 業:0)
75 | Oil: 80000 Ld (手:80000 / 預:0 / 業:
`;

describe("残高ダンプのパース", () => {
  it("正常行をパースし、名前の記号・絵文字にも耐える", () => {
    const dump = parseBalanceDump(SAMPLE);
    expect(dump.entries.length).toBe(6); // Oil の途切れ行と京クラスの1位は除外
    const eipi = dump.entries.find((e) => e.displayName === "eiπ+1=0");
    expect(eipi?.total).toBe(181_000);
    const bel = dump.entries.find((e) => e.displayName === "Belphegor");
    expect(bel?.total).toBe(7_648_595); // 手+預+業 の合算
    expect(bel?.business).toBe(6_985_000);
  });

  it("途切れ行は issues に回り、エントリには入らない", () => {
    const dump = parseBalanceDump(SAMPLE);
    expect(dump.issues.some((i) => i.line.includes("Oil") && i.reason === "malformed")).toBe(true);
  });

  it("合計欄と3成分の和が食い違ったら和を採用して報告する", () => {
    const dump = parseBalanceDump("01 | test: 999 Ld (手:100 / 預:200 / 業:300)");
    expect(dump.entries[0]?.total).toBe(600);
    expect(dump.issues.some((i) => i.reason === "sum_mismatch")).toBe(true);
  });

  it("同名（橋本×2）を検出する", () => {
    const dump = parseBalanceDump(SAMPLE);
    expect(dump.duplicateNames).toEqual(["橋本"]);
  });

  it("京クラス（安全な整数を超える金額）は unsafe_amount として手動対応に回す", () => {
    const dump = parseBalanceDump(SAMPLE);
    expect(dump.entries.some((e) => e.displayName === "酤-Hitoyozake-")).toBe(false);
    expect(dump.issues.some((i) => i.reason === "unsafe_amount" && i.line.includes("酤"))).toBe(true);
  });
});

describe("移行の振り分け", () => {
  it("キャップ超過は overCap、同名は ambiguous、それ以外は auto に分かれる", () => {
    const dump = parseBalanceDump(SAMPLE);
    const split = splitForMigration(dump, { cap: 5_000_000 });
    expect(split.overCap.map((e) => e.displayName)).toContain("Belphegor");
    expect(split.ambiguous.map((e) => e.displayName)).toEqual(["橋本", "橋本"]);
    expect(split.auto.map((e) => e.displayName)).toEqual([
      "江戸川乱歩",
      "eiπ+1=0",
      "神！神！俺に逆らうなDX",
    ]);
  });
});
