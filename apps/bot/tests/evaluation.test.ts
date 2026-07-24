import { describe, expect, it, vi } from "vitest";
import { markWeightLimitForRoleIds } from "../src/evaluation-rules.js";

vi.mock("../src/permissions.js", () => ({ isAdmin: () => false }));
vi.mock("../src/eval-daily.js", () => ({ refreshEvalStatsForUser: vi.fn() }));

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

describe("評価操作中の資格再検証", () => {
  function roles(ids: string[]) {
    return { cache: { has: (id: string) => ids.includes(id), keys: () => ids[Symbol.iterator]() } };
  }

  function services() {
    return {
      settings: {
        getString: vi.fn((key: string) => (key === "role:swordsman" ? "role:swordsman" : undefined)),
        getJson: vi.fn(() => ({})),
        getNumber: vi.fn(() => 1),
      },
      evaluation: {
        latestByEvaluator: vi.fn(() => undefined),
        submitEvaluation: vi.fn(),
      },
    };
  }

  async function importHandlers() {
    return import("../src/commands/evaluation.js");
  }

  it("点数選択時に魔剣士ロールを失っていたら評価入力を続行しない", async () => {
    const { handleEvaluationCommand, handleEvaluationSelect } = await importHandlers();
    const svc = services();
    const user = { id: "evaluator", username: "eval" };
    const member = { roles: roles(["role:swordsman"]), displayName: "Eval" };
    await handleEvaluationCommand(
      {
        user,
        member,
        options: { getUser: () => ({ id: "target", bot: false }) },
        reply: vi.fn(),
      } as any,
      svc as any,
    );

    const reply = vi.fn();
    await handleEvaluationSelect(
      {
        user,
        member: { roles: roles([]) },
        customId: "eval:s:voice",
        values: ["5"],
        reply,
        update: vi.fn(),
        deferUpdate: vi.fn(),
      } as any,
      svc as any,
    );

    expect(reply).toHaveBeenCalled();
    expect(svc.evaluation.submitEvaluation).not.toHaveBeenCalled();
  });

  it("モーダル送信時に魔剣士ロールを失っていたら記帳しない", async () => {
    const { handleEvaluationCommand, handleEvaluationSelect, handleEvaluationModal } = await importHandlers();
    const svc = services();
    const user = { id: "modal-evaluator", username: "eval" };
    const member = { roles: roles(["role:swordsman"]), displayName: "Eval" };
    await handleEvaluationCommand(
      {
        user,
        member,
        options: { getUser: () => ({ id: "modal-target", bot: false }) },
        reply: vi.fn(),
      } as any,
      svc as any,
    );
    for (const [key, value] of [
      ["voice", "4"],
      ["communication", "4"],
      ["presence", "4"],
      ["understanding", "4"],
    ] as const) {
      await handleEvaluationSelect(
        {
          user,
          member,
          customId: `eval:s:${key}`,
          values: [value],
          deferUpdate: vi.fn(),
          reply: vi.fn(),
          update: vi.fn(),
        } as any,
        svc as any,
      );
    }
    await handleEvaluationSelect(
      {
        user,
        member,
        customId: "eval:s:conclusion",
        values: ["promotion"],
        showModal: vi.fn(),
        reply: vi.fn(),
        update: vi.fn(),
      } as any,
      svc as any,
    );

    const reply = vi.fn();
    await handleEvaluationModal(
      {
        user,
        member: { roles: roles([]) },
        reply,
        fields: { getTextInputValue: vi.fn(() => "text") },
      } as any,
      svc as any,
    );

    expect(reply).toHaveBeenCalled();
    expect(svc.evaluation.submitEvaluation).not.toHaveBeenCalled();
  });
});
