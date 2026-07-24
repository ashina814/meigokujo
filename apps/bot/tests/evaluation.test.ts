import { describe, expect, it } from "vitest";
import { markWeightLimitForRoleIds } from "../src/evaluation-rules.js";

describe("評価印ロール上限", () => {
  it("設定なしでは最大1印", () => {
    expect(markWeightLimitForRoleIds(["role:a"], {})).toBe(1);
  });

  it("階級ロール別に1印・2印・複数印を判定する", () => {
    expect(markWeightLimitForRoleIds(["role:a"], { "role:a": 1, "role:b": 2, "role:c": 3 })).toBe(1);
    expect(markWeightLimitForRoleIds(["role:b"], { "role:a": 1, "role:b": 2, "role:c": 3 })).toBe(2);
    expect(markWeightLimitForRoleIds(["role:c"], { "role:a": 1, "role:b": 2, "role:c": 3 })).toBe(3);
  });

  it("複数階級ロール時は設定上限の最大値を使う", () => {
    expect(markWeightLimitForRoleIds(["role:a", "role:c"], { "role:a": 1, "role:b": 2, "role:c": 3 })).toBe(3);
  });

  it("不正な上限値や0は無視して既定値1へフォールバックする", () => {
    expect(markWeightLimitForRoleIds(["role:a", "role:b"], { "role:a": 0, "role:b": -2 })).toBe(1);
  });
});
