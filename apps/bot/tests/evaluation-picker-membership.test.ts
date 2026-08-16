import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

interface Cycle {
  userId: string;
  startedAt: number;
  deadlineAt: number | null;
  inviteBaseline: number;
  origin: "entry";
}

const forumMock = vi.hoisted(() => ({ cycles: [] as Cycle[] }));

vi.mock("@meigokujo/core/evaluation/forum", () => ({
  EvaluationForumStore: class {
    listCurrentCycles(): Cycle[] {
      return forumMock.cycles;
    }

    currentCycle(userId: string): Cycle | null {
      return forumMock.cycles.find((cycle) => cycle.userId === userId) ?? null;
    }
  },
}));

vi.mock("../src/permissions.js", () => ({ isAdmin: () => true }));

const source = readFileSync(new URL("../src/commands/evaluation.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const NOW_SEC = 2_000_000_000;

function cycle(userId: string, deadlineAt: number | null): Cycle {
  return {
    userId,
    startedAt: NOW_SEC - 86_400,
    deadlineAt,
    inviteBaseline: 0,
    origin: "entry",
  };
}

async function renderTargetMenus(cycles: Cycle[]) {
  forumMock.cycles = cycles;
  const members = new Map(cycles.map((row) => [row.userId, { displayName: row.userId }]));
  const reply = vi.fn();
  const now = vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);

  try {
    const { handleEvaluationButton } = await import("../src/commands/evaluation.js");
    await handleEvaluationButton(
      {
        customId: "eval:open",
        guild: { members: { fetch: vi.fn(async () => members) } },
        reply,
      } as any,
      { db: {}, settings: {} } as any,
    );
  } finally {
    now.mockRestore();
  }

  expect(reply).toHaveBeenCalledTimes(1);
  const payload = reply.mock.calls[0]![0] as {
    content: string;
    components: Array<{ toJSON(): { components: Array<Record<string, any>> } }>;
  };
  return {
    content: payload.content,
    menus: payload.components.map((row) => row.toJSON().components[0]!),
  };
}

describe("evaluation picker membership UX", () => {
  it("常設入口は1択selectではなく何度でも押せるbutton", () => {
    const panelStart = source.indexOf("function panelRow");
    const panelEnd = source.indexOf("export async function handleEvaluationCommand", panelStart);
    const panel = source.slice(panelStart, panelEnd);
    expect(panel).toContain("ActionRowBuilder<ButtonBuilder>");
    expect(panel).toContain('setCustomId("eval:open")');
    expect(panel).toContain('setLabel("評価する亡霊を選択")');
    expect(panel).not.toContain("StringSelectMenuBuilder");
    expect(indexSource).toContain('interaction.customId === "eval:open"');
    expect(indexSource).toContain("handleEvaluationButton(interaction, services)");
  });

  it("DB評価中とGuild在籍の積集合だけを表示しIDへフォールバックしない", () => {
    expect(source).toContain("const members = await guild.members.fetch();");
    expect(source).toContain("memberIds.has(cycle.userId)");
    expect(source).toContain("member.displayName.slice(0, 100)");
    expect(source).not.toContain("member?.displayName ?? cycle.userId");
    expect(source).toContain("メンバー一覧の取得に失敗しました。もう一度押してください。");
  });

  it("期限超過は消さずに判定待ちとして通常評価と分離する", () => {
    expect(source).toContain("function isPendingJudgement");
    expect(source).toContain("return deadlineAt !== null && deadlineAt <= nowSec;");
    expect(source).toContain("const activeCycles = presentCycles.filter");
    expect(source).toContain("const pendingCycles = presentCycles.filter");
    expect(source).toContain("eval:target:active:");
    expect(source).toContain("eval:target:pending:");
    expect(source).toContain("⏳ 期限超過・判定待ち");
    expect(source).toContain("判定待ちがいる場合は最低1行を必ず残す");
    expect(source).not.toContain("UPDATE souls SET status");
  });

  it("期限超過フォーラムにも判定待ち状態を明示する", () => {
    expect(source).toContain('lines.push("", "⏳ **期限超過・判定待ち**")');
    expect(source).toContain("評価期限：");
    expect(source).toContain("この対象は期限超過・判定待ちです。");
    expect(source).toContain("人間側で最終判断してください。");
  });

  it("選択確定時も在籍を再確認し、成功後に残り一覧を消さない", () => {
    expect(source).toContain("if (!menus.memberIds.has(targetId))");
    expect(source).toContain("現在サーバーに在籍していないため、評価対象一覧から外れました");
    expect(source).toContain("**続けて別の亡霊も選択できます。**");
    expect(source).toContain("components: menus.rows");
    expect(source).toContain("if (!member) return null;");
    expect(source).not.toContain('name: threadTitleFor(member?.displayName ?? targetId)');
  });

  it("deadline > now は実際の描画で評価期間中menuへ入る", async () => {
    const rendered = await renderTargetMenus([cycle("future", NOW_SEC + 1)]);

    expect(rendered.menus).toHaveLength(1);
    expect(rendered.menus[0]?.custom_id).toBe("eval:target:active:0");
    expect(rendered.menus[0]?.options?.map((option: { value: string }) => option.value)).toEqual(["future"]);
    expect(rendered.content).toContain("評価期間中 **1名**");
    expect(rendered.content).toContain("期限超過・判定待ち **0名**");
  });

  it("deadline === now は実際の描画で判定待ちmenuへ入る", async () => {
    const rendered = await renderTargetMenus([cycle("boundary", NOW_SEC)]);

    expect(rendered.menus).toHaveLength(1);
    expect(rendered.menus[0]?.custom_id).toBe("eval:target:pending:0");
    expect(rendered.menus[0]?.options?.map((option: { value: string }) => option.value)).toEqual(["boundary"]);
    expect(rendered.content).toContain("評価期間中 **0名**");
    expect(rendered.content).toContain("期限超過・判定待ち **1名**");
  });

  it("deadline < now は実際の描画で判定待ちmenuへ入る", async () => {
    const rendered = await renderTargetMenus([cycle("overdue", NOW_SEC - 1)]);

    expect(rendered.menus).toHaveLength(1);
    expect(rendered.menus[0]?.custom_id).toBe("eval:target:pending:0");
    expect(rendered.menus[0]?.options?.map((option: { value: string }) => option.value)).toEqual(["overdue"]);
    expect(rendered.content).toContain("期限超過・判定待ち **1名**");
  });

  it("大量のactive/pendingでも5行を超えず判定待ちへ最低1行を確保する", async () => {
    const active = Array.from({ length: 125 }, (_, index) => cycle(`active-${index}`, NOW_SEC + 3600));
    const pending = Array.from({ length: 30 }, (_, index) => cycle(`pending-${index}`, NOW_SEC - 3600));
    const rendered = await renderTargetMenus([...active, ...pending]);

    expect(rendered.menus).toHaveLength(5);
    expect(rendered.menus.slice(0, 4).map((menu) => menu.custom_id)).toEqual([
      "eval:target:active:0",
      "eval:target:active:1",
      "eval:target:active:2",
      "eval:target:active:3",
    ]);
    expect(rendered.menus[4]?.custom_id).toBe("eval:target:pending:0");
    expect(rendered.menus.slice(0, 4).every((menu) => menu.options?.length === 25)).toBe(true);
    expect(rendered.menus[4]?.options?.length).toBe(25);
    expect(rendered.content).toContain("評価期間中 100/125名・判定待ち 25/30名");
  });
});
