import { describe, expect, it } from "vitest";
import { defaultRng, deterministicRng, scriptedRng } from "../src/casino/rng.js";

describe("CasinoRng: 基本契約", () => {
  it("int: 範囲外は例外・両端含む", () => {
    const rng = deterministicRng(1);
    expect(() => rng.int(5, 3)).toThrow();
    expect(() => rng.int(1.5 as unknown as number, 3)).toThrow();
    for (let i = 0; i < 200; i++) {
      const v = rng.int(1, 6);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
    }
  });

  it("shuffle: 元配列を破壊せず全要素を保持する", () => {
    const rng = deterministicRng(42);
    const src = [1, 2, 3, 4, 5];
    const out = rng.shuffle(src);
    expect(out).not.toBe(src);
    expect(out.slice().sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("weighted: 0重みは選ばれない", () => {
    const rng = deterministicRng(7);
    for (let i = 0; i < 500; i++) {
      const v = rng.weighted([["a", 0], ["b", 1], ["c", 0]] as const);
      expect(v).toBe("b");
    }
  });

  it("weighted: 大数で重みに比例した頻度になる", () => {
    const rng = deterministicRng(100);
    const counts = { a: 0, b: 0, c: 0 };
    const N = 20_000;
    for (let i = 0; i < N; i++) {
      const v = rng.weighted([["a", 1], ["b", 3], ["c", 6]] as const);
      counts[v as "a" | "b" | "c"]++;
    }
    // 期待値 10/30/60 に対して ±2% 以内
    expect(counts.a / N).toBeCloseTo(0.1, 1);
    expect(counts.b / N).toBeCloseTo(0.3, 1);
    expect(counts.c / N).toBeCloseTo(0.6, 1);
  });

  it("deterministicRng: 同じシードなら同じ列", () => {
    const a = deterministicRng(999);
    const b = deterministicRng(999);
    for (let i = 0; i < 100; i++) expect(a.int(0, 1_000_000)).toBe(b.int(0, 1_000_000));
  });

  it("scriptedRng: 数列を順に返し、末尾で循環する", () => {
    const rng = scriptedRng([0.0, 0.5, 0.99]);
    expect(rng.float()).toBe(0.0);
    expect(rng.float()).toBe(0.5);
    expect(rng.float()).toBe(0.99);
    expect(rng.float()).toBe(0.0); // 循環
    expect(() => scriptedRng([1.5])).not.toThrow(); // 生成は成功
    expect(() => scriptedRng([1.5]).float()).toThrow(); // 値取り出しで検出
  });

  it("defaultRng: 呼び出しでエラーにならず範囲を守る", () => {
    const rng = defaultRng();
    for (let i = 0; i < 20; i++) {
      const v = rng.int(0, 36);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(36);
      const f = rng.float();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });
});
