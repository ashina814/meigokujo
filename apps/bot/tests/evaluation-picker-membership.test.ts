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

async function renderTargetMenus(
  cycles: Cycle[],
  options: {
    fetch?: (arg: any) => Promise<any>;
    cache?: Map<string, any>;
  } = {},
) {
  forumMock.cycles = cycles;
  const members = new Map(cycles.map((row) => [row.userId, { displayName: row.userId }]));
  const fetch = vi.fn(options.fetch ?? (async () => members));
  const cache = options.cache ?? new Map<string, any>();
  const reply = vi.fn();
  const deferReply = vi.fn();
  const editReply = vi.fn();
  const now = vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);

  try {
    const { handleEvaluationButton } = await import("../src/commands/evaluation.js");
    await handleEvaluationButton(
      {
        customId: "eval:open",
        guild: { members: { fetch, cache } },
        reply,
        deferReply,
        editReply,
      } as any,
      { db: {}, settings: {} } as any,
    );
  } finally {
    now.mockRestore();
  }

  expect(deferReply).toHaveBeenCalledTimes(1);
  expect(deferReply).toHaveBeenCalledWith({ flags: expect.anything() });
  expect(reply).not.toHaveBeenCalled();
  expect(editReply).toHaveBeenCalledTimes(1);
  const payload = editReply.mock.calls[0]![0] as {
    content: string;
    components: Array<{ toJSON(): { components: Array<Record<string, any>> } }>;
  };
  return {
    content: payload.content,
    menus: (payload.components ?? []).map((row) => row.toJSON().components[0]!),
    fetch,
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

  it("DB評価対象だけをGuildへ照会し、全Guild member取得へ依存しない", () => {
    expect(source).toContain("fetchEvaluationMembers");
    expect(source).toContain("guild.members.fetch({ user: chunk })");
    expect(source).toContain("guild.members.fetch({ user: userId, force: true })");
    expect(source).toContain("targeted member fetch failed; falling back to per-user fetch");
    expect(source).toContain("memberIds.has(cycle.userId)");
    expect(source).toContain("member.displayName.slice(0, 100)");
    expect(source).not.toContain("member?.displayName ?? cycle.userId");
  });

  it("一覧作成は先にephemeral deferし、例外をログへ残してから失敗表示する", () => {
    expect(source).toContain("await interaction.deferReply({ flags: MessageFlags.Ephemeral })");
    expect(source).toContain('[eval-forum] target menu build failed');
    expect(source).toContain('[eval-forum] target menu refresh failed');
    expect(source).toContain("評価対象一覧の作成に失敗しました");
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
    expect(source).toContain("if (menus.unresolvedIds.has(targetId))");
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

  it("実際のmember fetchは評価対象IDだけを指定して行う", async () => {
    const rendered = await renderTargetMenus([
      cycle("target-a", NOW_SEC + 1),
      cycle("target-b", NOW_SEC + 1),
    ]);

    expect(rendered.fetch).toHaveBeenCalledTimes(1);
    expect(rendered.fetch).toHaveBeenCalledWith({ user: ["target-a", "target-b"] });
  });

  it("対象まとめ取得が失敗しても個別取得へfallbackし一覧全体を落とさない", async () => {
    const rendered = await renderTargetMenus(
      [cycle("target-a", NOW_SEC + 1), cycle("target-b", NOW_SEC - 1)],
      {
        fetch: async (arg) => {
          if (Array.isArray(arg?.user)) throw new Error("bulk member request failed");
          return { displayName: arg.user };
        },
      },
    );

    expect(rendered.fetch).toHaveBeenCalledTimes(3);
    expect(rendered.menus).toHaveLength(2);
    expect(rendered.content).toContain("評価期間中 **1名**");
    expect(rendered.content).toContain("期限超過・判定待ち **1名**");
    expect(rendered.content).not.toContain("一覧の作成に失敗");
  });

  it("1人がUnknown Memberでも他の評価対象を表示し続ける", async () => {
    const unknown = Object.assign(new Error("Unknown Member"), { code: 10007 });
    const rendered = await renderTargetMenus(
      [cycle("gone", NOW_SEC + 1), cycle("present", NOW_SEC + 1)],
      {
        fetch: async (arg) => {
          if (Array.isArray(arg?.user)) throw new Error("bulk member request failed");
          if (arg.user === "gone") throw unknown;
          return { displayName: arg.user };
        },
      },
    );

    expect(rendered.menus).toHaveLength(1);
    expect(rendered.menus[0]?.options?.map((option: { value: string }) => option.value)).toEqual(["present"]);
    expect(rendered.content).toContain("評価期間中 **1名**");
    expect(rendered.content).not.toContain("在籍確認に失敗");
  });

  it("個別取得が一時失敗してもcacheがあれば対象を表示する", async () => {
    const rendered = await renderTargetMenus(
      [cycle("cached", NOW_SEC + 1)],
      {
        cache: new Map([["cached", { displayName: "cached" }]]),
        fetch: async () => {
          throw new Error("temporary gateway failure");
        },
      },
    );

    expect(rendered.menus).toHaveLength(1);
    expect(rendered.menus[0]?.options?.[0]?.value).toBe("cached");
    expect(rendered.content).toContain("評価期間中 **1名**");
  });
});
