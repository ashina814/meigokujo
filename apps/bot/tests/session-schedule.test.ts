import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLog, SessionCalendar, Settings, openDb } from "@meigokujo/core";

vi.mock("../src/permissions.js", () => ({ isAdmin: () => false }));

import { handleSessionScheduleAutocomplete, handleSessionScheduleCommand } from "../src/commands/session-schedule.js";

// 2026-07-31(金) 20:30 JST。08-01(土)は通常開催、08-03(月)は通常休み
const NOW = new Date("2026-07-31T11:30:00Z");

// 予定の判定はすべて「いま」を基準にするので、実行日に結果が揺れないよう時刻を固定する
beforeEach(() => {
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(options: { judge?: boolean } = {}) {
  const db = openDb(":memory:");
  const settings = new Settings(db);
  const sessions = new SessionCalendar(db, settings, new EventLog(db));
  settings.set("role:judge", "judge_role", "test");
  const services = { db, settings, sessions } as any;
  const roleIds = options.judge === false ? [] : ["judge_role"];
  return { db, settings, sessions, services, roleIds };
}

function commandInteraction(options: {
  sub: string;
  strings?: Record<string, string>;
  integers?: Record<string, number>;
  roleIds: string[];
}) {
  const reply = vi.fn(async () => undefined);
  const interaction: any = {
    user: { id: "staff1" },
    member: { roles: { cache: { has: (id: string) => options.roleIds.includes(id) } } },
    options: {
      getSubcommand: () => options.sub,
      getString: (name: string, required?: boolean) => {
        const value = options.strings?.[name];
        if (value === undefined && required) throw new Error(`missing ${name}`);
        return value ?? null;
      },
      getInteger: (name: string, required?: boolean) => {
        const value = options.integers?.[name];
        if (value === undefined && required) throw new Error(`missing ${name}`);
        return value ?? null;
      },
    },
    reply,
  };
  return { interaction, reply };
}

function autocompleteInteraction(options: {
  sub: string;
  focused: string;
  value?: string;
  strings?: Record<string, string>;
  roleIds: string[];
}) {
  const respond = vi.fn(async () => undefined);
  const interaction: any = {
    user: { id: "staff1" },
    member: { roles: { cache: { has: (id: string) => options.roleIds.includes(id) } } },
    options: {
      getSubcommand: () => options.sub,
      getFocused: () => ({ name: options.focused, value: options.value ?? "" }),
      getString: (name: string) => options.strings?.[name] ?? null,
    },
    respond,
  };
  return { interaction, respond };
}

/** reply に渡された本文（content か embed の中身）を1本の文字列にする */
function replyText(reply: ReturnType<typeof vi.fn>): string {
  const arg = reply.mock.calls.at(-1)?.[0] as any;
  if (arg?.content) return String(arg.content);
  const embed = arg?.embeds?.[0]?.data;
  return JSON.stringify(embed);
}

describe("/説明会 の権限", () => {
  it("門番でなければ操作できない", async () => {
    const { db, services } = setup();
    const { interaction, reply } = commandInteraction({ sub: "予定", roleIds: [] });

    await handleSessionScheduleCommand(interaction, services);

    expect(replyText(reply)).toContain("門番");
    db.close();
  });

  it("補完も門番以外には候補を返さない", async () => {
    const { db, services } = setup();
    const { interaction, respond } = autocompleteInteraction({ sub: "休止", focused: "日付", roleIds: [] });

    await handleSessionScheduleAutocomplete(interaction, services);

    expect(respond).toHaveBeenCalledWith([]);
    db.close();
  });
});

describe("/説明会 予定", () => {
  it("休止は取り消し線、臨時追加は＋で通常枠と区別して並べる", async () => {
    const { db, sessions, services, roleIds } = setup();
    sessions.skip({ date: "2026-08-01", hour: 21, reason: "門番不在", actor: "user:1", now: NOW });
    sessions.add({ date: "2026-08-03", hour: 20, actor: "user:1", now: NOW });
    const { interaction, reply } = commandInteraction({ sub: "予定", integers: { 日数: 4 }, roleIds });

    await handleSessionScheduleCommand(interaction, services);
    const text = replyText(reply);

    expect(text).toContain("~~21:00~~");
    expect(text).toContain("門番不在");
    expect(text).toContain("＋20:00");
    expect(text).toContain("月・木を除く 21 / 22 / 23 時");
    db.close();
  });
});

describe("/説明会 休止・追加・取消", () => {
  it("枠を休止すると通知が出なくなることまで返す", async () => {
    const { db, sessions, services, roleIds } = setup();
    const { interaction, reply } = commandInteraction({
      sub: "休止",
      strings: { 日付: "2026-08-01", 理由: "門番不在" },
      integers: { 時刻: 21 },
      roleIds,
    });

    await handleSessionScheduleCommand(interaction, services);

    expect(replyText(reply)).toContain("08/01(土)");
    expect(replyText(reply)).toContain("5分前通知は出ません");
    expect(sessions.isOccurring("2026-08-01", 21)).toBe(false);
    db.close();
  });

  it("時刻を省略するとその日を全休にする", async () => {
    const { db, sessions, services, roleIds } = setup();
    const { interaction, reply } = commandInteraction({ sub: "休止", strings: { 日付: "2026-08-01" }, roleIds });

    await handleSessionScheduleCommand(interaction, services);

    expect(replyText(reply)).toContain("すべて");
    expect(sessions.occurrences({ from: NOW, days: 2 }).filter((o) => o.date === "2026-08-01")).toEqual([]);
    db.close();
  });

  it("休みの曜日への臨時追加は、その旨を添えて受け付ける", async () => {
    const { db, sessions, services, roleIds } = setup();
    const { interaction, reply } = commandInteraction({
      sub: "追加",
      strings: { 日付: "2026-08-03" },
      integers: { 時刻: 20 },
      roleIds,
    });

    await handleSessionScheduleCommand(interaction, services);

    expect(replyText(reply)).toContain("通常お休みですが");
    expect(sessions.isOccurring("2026-08-03", 20)).toBe(true);
    db.close();
  });

  it("取り消すと通常予定へ戻り、その日の実際の開催枠を返す", async () => {
    const { db, sessions, services, roleIds } = setup();
    const row = sessions.skip({ date: "2026-08-01", hour: 21, actor: "user:1", now: NOW });
    const { interaction, reply } = commandInteraction({ sub: "取消", integers: { 対象: row.id }, roleIds });

    await handleSessionScheduleCommand(interaction, services);

    expect(replyText(reply)).toContain("**21:00** は開催します");
    expect(replyText(reply)).toContain("この日の開催: **21:00** / **22:00** / **23:00**");
    expect(sessions.isOccurring("2026-08-01", 21)).toBe(true);
    db.close();
  });

  it("別の休止が残っていれば、取消後も開催しないことを返す", async () => {
    const { db, sessions, services, roleIds } = setup();
    // 全休と個別休止が重なっている状態。個別のほうを取り消しても、その枠は開催しない
    const perSlot = sessions.skip({ date: "2026-08-01", hour: 21, actor: "user:1", now: NOW });
    sessions.skip({ date: "2026-08-01", actor: "user:1", now: NOW });
    const { interaction, reply } = commandInteraction({ sub: "取消", integers: { 対象: perSlot.id }, roleIds });

    await handleSessionScheduleCommand(interaction, services);

    expect(replyText(reply)).toContain("開催しません（別の休止が残っています）");
    expect(replyText(reply)).toContain("この日の開催はありません");
    expect(sessions.isOccurring("2026-08-01", 21)).toBe(false);
    db.close();
  });

  it("臨時追加の取消では、その枠が無くなったことを返す", async () => {
    const { db, sessions, services, roleIds } = setup();
    const row = sessions.add({ date: "2026-08-03", hour: 20, actor: "user:1", now: NOW });
    const { interaction, reply } = commandInteraction({ sub: "取消", integers: { 対象: row.id }, roleIds });

    await handleSessionScheduleCommand(interaction, services);

    expect(replyText(reply)).toContain("臨時開催は無くなりました");
    expect(replyText(reply)).toContain("この日の開催はありません"); // 月曜は通常休み
    db.close();
  });

  it("誤操作は理由を添えて断る（重複・過去・通常枠に無い時刻）", async () => {
    const { db, sessions, services, roleIds } = setup();
    sessions.skip({ date: "2026-08-01", hour: 21, actor: "user:1", now: NOW });

    const duplicate = commandInteraction({ sub: "休止", strings: { 日付: "2026-08-01" }, integers: { 時刻: 21 }, roleIds });
    await handleSessionScheduleCommand(duplicate.interaction, services);
    expect(replyText(duplicate.reply)).toContain("すでに登録されています");

    const past = commandInteraction({ sub: "追加", strings: { 日付: "2020-01-01" }, integers: { 時刻: 21 }, roleIds });
    await handleSessionScheduleCommand(past.interaction, services);
    expect(replyText(past.reply)).toContain("過ぎています");

    const notRegular = commandInteraction({ sub: "休止", strings: { 日付: "2026-08-02" }, integers: { 時刻: 15 }, roleIds });
    await handleSessionScheduleCommand(notRegular.interaction, services);
    expect(replyText(notRegular.reply)).toContain("通常の開催枠ではありません");
    db.close();
  });
});

describe("/説明会 の補完", () => {
  it("休止の日付候補は通常枠がある日だけ", async () => {
    const { db, services, roleIds } = setup();
    const { interaction, respond } = autocompleteInteraction({ sub: "休止", focused: "日付", roleIds });

    await handleSessionScheduleAutocomplete(interaction, services);
    const values = (respond.mock.calls[0]![0] as Array<{ value: string }>).map((c) => c.value);

    expect(values).toContain("2026-07-31");
    expect(values).not.toContain("2026-08-03"); // 月曜は通常休み
    db.close();
  });

  it("休止の時刻候補は実際に開催が残っている枠、追加の候補は空いている枠", async () => {
    const { db, sessions, services, roleIds } = setup();
    sessions.skip({ date: "2026-08-01", hour: 21, actor: "user:1", now: NOW });

    const skip = autocompleteInteraction({ sub: "休止", focused: "時刻", strings: { 日付: "2026-08-01" }, roleIds });
    await handleSessionScheduleAutocomplete(skip.interaction, services);
    expect((skip.respond.mock.calls[0]![0] as Array<{ value: number }>).map((c) => c.value)).toEqual([22, 23]);

    const add = autocompleteInteraction({ sub: "追加", focused: "時刻", strings: { 日付: "2026-08-01" }, roleIds });
    await handleSessionScheduleAutocomplete(add.interaction, services);
    const addable = (add.respond.mock.calls[0]![0] as Array<{ value: number }>).map((c) => c.value);
    expect(addable).toContain(21); // 休止したので空いている
    expect(addable).not.toContain(22);
    db.close();
  });

  it("取消の候補は有効な予定変更だけ", async () => {
    const { db, sessions, services, roleIds } = setup();
    const kept = sessions.skip({ date: "2026-08-01", hour: 21, reason: "門番不在", actor: "user:1", now: NOW });
    const canceled = sessions.add({ date: "2026-08-03", hour: 20, actor: "user:1", now: NOW });
    sessions.cancel(canceled.id, "user:1", NOW);

    const { interaction, respond } = autocompleteInteraction({ sub: "取消", focused: "対象", roleIds });
    await handleSessionScheduleAutocomplete(interaction, services);
    const choices = respond.mock.calls[0]![0] as Array<{ name: string; value: number }>;

    expect(choices.map((c) => c.value)).toEqual([kept.id]);
    expect(choices[0]!.name).toContain("門番不在");
    db.close();
  });
});
