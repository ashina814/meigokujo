import { randomInt as nodeRandomInt } from "node:crypto";

/**
 * 賭場の乱数モジュール。
 *
 * 目的:
 * - 本番はNodeの`crypto`ベースの一様乱数を使用する（`Math.random`を賭博結果に使わない）
 * - テスト時は固定シードRNGを注入して結果を再現できるようにする
 * - 将来のProvably Fair化に備え、乱数の入手をゲームロジックから分離する
 *
 * ゲーム側は必ずここのインターフェース経由でしか乱数を取らない。
 * `Math.random()` の直接呼び出しは casino/ 配下ではリンタで禁止する想定。
 */
export interface CasinoRng {
  /** [min, max] 両端含む一様整数 */
  int(min: number, max: number): number;
  /** [0, 1) 一様実数（レア判定・重み抽選の内部で使う） */
  float(): number;
  /** 配列を破壊せず新しい順序で返す（Fisher–Yates） */
  shuffle<T>(values: readonly T[]): T[];
  /** 配列から1つ選ぶ（空配列は例外） */
  pick<T>(values: readonly T[]): T;
  /** 重み付き抽選（重みは非負整数を想定・0重みは選ばれない） */
  weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T;
}

/**
 * 内部実装: float→intの安全変換を1箇所に集約する。
 * randomFloat が [0,1) を返す前提。int(0, n-1) のようなよくある使い方が誤りなく動くこと。
 */
class BaseRng implements CasinoRng {
  constructor(private readonly randomFloat: () => number) {}

  int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
      throw new Error(`CasinoRng.int: invalid range [${min}, ${max}]`);
    }
    const span = max - min + 1;
    return min + Math.floor(this.randomFloat() * span);
  }

  float(): number {
    return this.randomFloat();
  }

  shuffle<T>(values: readonly T[]): T[] {
    const arr = values.slice() as T[];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = arr[i]!;
      arr[i] = arr[j]!;
      arr[j] = tmp;
    }
    return arr;
  }

  pick<T>(values: readonly T[]): T {
    if (values.length === 0) throw new Error("CasinoRng.pick: empty");
    return values[this.int(0, values.length - 1)]!;
  }

  weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T {
    let total = 0;
    for (const [, w] of entries) {
      if (!Number.isFinite(w) || w < 0) throw new Error(`CasinoRng.weighted: bad weight ${w}`);
      total += w;
    }
    if (total <= 0) throw new Error("CasinoRng.weighted: total weight is 0");
    let roll = this.randomFloat() * total;
    for (const [v, w] of entries) {
      roll -= w;
      if (roll < 0) return v;
    }
    // 数値誤差で最後まで残ったとき: 末尾の有重量エントリを返す
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]![1] > 0) return entries[i]![0];
    }
    throw new Error("CasinoRng.weighted: unreachable");
  }
}

/**
 * 本番用: node の crypto.randomInt を使って [0, 2^32) の一様整数から float 化する。
 * Math.random より予測困難で、テスト時にモックしやすい。
 */
export function defaultRng(): CasinoRng {
  const RANGE = 2 ** 32;
  return new BaseRng(() => nodeRandomInt(0, RANGE) / RANGE);
}

/**
 * テスト用: mulberry32 の決定的PRNG。
 * 同じシードなら同じ結果列。RTPシミュレーションや回帰テストで固定シードを使う。
 */
export function deterministicRng(seed: number): CasinoRng {
  let s = (seed | 0) >>> 0;
  return new BaseRng(() => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
}

/**
 * テスト用: あらかじめ用意した数列を順に返す。長さを超えたら循環する。
 * ゲームの分岐を1手ずつ再現したいときに使う。
 */
export function scriptedRng(sequence: readonly number[]): CasinoRng {
  if (sequence.length === 0) throw new Error("scriptedRng: sequence is empty");
  let i = 0;
  return new BaseRng(() => {
    const v = sequence[i % sequence.length]!;
    i++;
    if (v < 0 || v >= 1) throw new Error(`scriptedRng: value out of [0,1): ${v}`);
    return v;
  });
}
