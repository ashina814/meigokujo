import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Entry, EventLog, Ledger, SessionCalendar, Settings, openDb, registerDefaultTxTypes } from "@meigokujo/core";

import {
  WAITERS_BOARD_CHANNEL_KEY,
  WAITERS_BOARD_MESSAGE_KEY,
  buildWaitersBoardEmbed,
  updateWaitersBoard,
} from "../src/waiters-board.js";

registerDefaultTxTypes();

// 2026-07-31(金) 20:30 JST。08-03(月)は通常休み
const NOW = new Date("2026-07-31T11:30:00Z");

beforeEach(() => {
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-board-"));
  tempDirs.push(dir);
  return join(dir, "test.db");
}

function setup(path = ":memory:") {
  const db = openDb(path);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const entry = new Entry(db, new Ledger(db), settings, events);
  const sessions = new SessionCalendar(db, settings, events);
  return { db, settings, events, entry, sessions, services: { db, settings, events, entry, sessions } as any };
}

function embedText(embed: { data: unknown }): string {
  return JSON.stringify(embed.data);
}

/** ボードのチャンネルとメッセージを持つ最小の client */
function clientWith(options: { channel?: unknown } = {}) {
  return { channels: { fetch: vi.fn(async () => options.channel ?? null) } } as any;
}

function textChannel(options: { message?: unknown; sendId?: string; fetchError?: unknown } = {}) {
  const send = vi.fn(async () => ({ id: options.sendId ?? "new_message", pin: vi.fn(async () => undefined) }));
  return {
    isTextBased: () => true,
    guild: { channels: { fetch: vi.fn(async () => null) } },
    messages: {
      fetch: vi.fn(async () => {
        if (options.fetchError) throw options.fetchError;
        if (!options.message) throw Object.assign(new Error("Unknown Message"), { code: 10008 });
        return options.message;
      }),
    },
    send,
  };
}

describe("待ち人ボードの表示", () => {
  it("案内待ち・滞留・未検出・配送結果を載せ、未検出が合格を止めないと明示する", () => {
    const { db, entry, events, services } = setup();
    entry.recordJoin("newcomer");
    entry.recordJoin("stale");
    db.prepare("UPDATE souls SET joined_at = ? WHERE user_id = 'stale'").run(
      Math.floor(NOW.getTime() / 1000) - 10 * 86_400,
    );
    entry.recordInviterHint("newcomer", { userId: "inviter", source: "user" }, "auto", "system:test");
    events.log("entry_guide_sent", { target: "newcomer", payload: { via: "dm" } });
    events.log("entry_guide_sent", { target: "stale", payload: { via: "none" } });

    const text = embedText(buildWaitersBoardEmbed(services, { vcPresent: { count: 3, missing: 0 }, flexOpen: 2, flexFallback: false }));

    expect(text).toContain("案内待ち");
    expect(text).toContain("**2**人（7日以上 **1**人）"); // 滞留1人
    expect(text).toContain("**1**人"); // 招待経路の未検出は stale の1人だけ
    expect(text).toContain("合格を止める条件ではありません");
    expect(text).toContain("不達 1件");
    expect(text).toContain("**3**人"); // 説明会VC
    expect(text).toContain("**2**件（未クローズ）");
    db.close();
  });

  it("休止した枠は予定に出さず、臨時追加は印を付ける", () => {
    const { db, sessions, services } = setup();
    sessions.skip({ date: "2026-07-31", hour: 21, actor: "user:1", now: NOW });
    sessions.add({ date: "2026-08-03", hour: 20, actor: "user:1", now: NOW });

    const embed = buildWaitersBoardEmbed(services, { vcPresent: { count: 0, missing: 0 }, flexOpen: 0, flexFallback: false });
    const upcoming = embed.data.fields?.find((f) => f.name.includes("今後の予定"))?.value ?? "";
    const lineFor = (date: string) => upcoming.split("\n").find((l) => l.includes(date)) ?? "";

    expect(lineFor("07/31")).toBe("`07/31(金)` 22:00 / 23:00"); // 休止した21時は出ない
    expect(lineFor("08/01")).toBe("`08/01(土)` 21:00 / 22:00 / 23:00");
    expect(lineFor("08/03")).toBe("`08/03(月)` 20:00＋"); // 通常休みの日に足した臨時枠
    db.close();
  });

  it("実況値が取れないときは0と偽らず「取得できず」と出す", () => {
    const { db, services } = setup();

    const text = embedText(buildWaitersBoardEmbed(services, { vcPresent: null, flexOpen: null, flexFallback: false }));

    expect(text).toContain("取得できず");
    db.close();
  });

  it("説明会VCの一部を取得できなかったら0人と断定しない", () => {
    const { db, services } = setup();
    const field = (live: Parameters<typeof buildWaitersBoardEmbed>[1]) =>
      buildWaitersBoardEmbed(services, live).data.fields?.find((f) => f.name.includes("説明会VC"))?.value ?? "";

    expect(field({ vcPresent: { count: 0, missing: 1 }, flexOpen: 0, flexFallback: false })).toBe(
      "一部取得できず（1か所）",
    );
    expect(field({ vcPresent: { count: 2, missing: 1 }, flexOpen: 0, flexFallback: false })).toBe(
      "**2**人＋（1か所を取得できず）",
    );
    expect(field({ vcPresent: { count: 0, missing: 0 }, flexOpen: 0, flexFallback: false })).toBe("**0**人");
    db.close();
  });
});

describe("待ち人ボードの5分前通知の状態", () => {
  const live = { vcPresent: { count: 0, missing: 0 }, flexOpen: 0, flexFallback: false };
  const notificationField = (services: any) =>
    buildWaitersBoardEmbed(services, live).data.fields?.find((f) => f.name.includes("5分前通知"))?.value ?? "";

  it("送信済み・失敗・未送信を区別して出す", () => {
    const { db, events, services } = setup();
    // 07-31 21:00 の枠は 20:55 に通知時刻を迎えている（いまは 20:30 なので1つ前の枠を見る）
    vi.setSystemTime(new Date("2026-07-31T13:30:00Z")); // 金 22:30 JST

    expect(notificationField(services)).toContain("未送信");

    events.log("session_notified", { actor: "system:scheduler", payload: { date: "2026-07-31", hour: 22, kind: "5m" } });
    expect(notificationField(services)).toContain("送信済み");

    events.log("session_notify_failed", {
      actor: "system:scheduler",
      payload: { date: "2026-07-31", hour: 22, kind: "5m", error: "Missing Permissions" },
    });
    expect(notificationField(services)).toContain("失敗（Missing Permissions）");
    db.close();
  });

  it("次の枠がまだ通知時刻前ならそう分かる", () => {
    const { db, services } = setup();

    // いまは 20:30 JST。21時の枠の通知は 20:55
    expect(notificationField(services)).toContain("まだ通知時刻前");
    db.close();
  });

  it("再起動後も記録から読めるよう、状態は事件録に残っている", () => {
    const path = tempDbPath();
    const first = setup(path);
    first.events.log("session_notified", {
      actor: "system:scheduler",
      payload: { date: "2026-07-31", hour: 21, kind: "5m" },
    });
    first.db.close();

    const restarted = setup(path);
    const status = restarted.sessions.notificationStatus("2026-07-31", 21);
    restarted.db.close();

    expect(status.status).toBe("sent");
  });
});

describe("待ち人ボードの設置と更新", () => {
  it("設置先が未設定なら何もしない", async () => {
    const { db, services } = setup();

    const result = await updateWaitersBoard(clientWith(), services);

    expect(result).toMatchObject({ ok: false, action: "skipped" });
    db.close();
  });

  it("初回は投稿してメッセージIDを覚え、次回からは同じメッセージを編集する", async () => {
    const { db, settings, services } = setup();
    settings.set(WAITERS_BOARD_CHANNEL_KEY, "board_channel", "test");
    const channel = textChannel({ sendId: "board_message" });

    const created = await updateWaitersBoard(clientWith({ channel }), services);
    expect(created).toMatchObject({ ok: true, action: "created", messageId: "board_message" });
    expect(settings.getString(WAITERS_BOARD_MESSAGE_KEY)).toBe("board_message");

    const edit = vi.fn(async () => undefined);
    const withMessage = textChannel({ message: { edit } });
    const edited = await updateWaitersBoard(clientWith({ channel: withMessage }), services);

    expect(edited).toMatchObject({ ok: true, action: "edited" });
    expect(edit).toHaveBeenCalledTimes(1);
    expect(withMessage.send).not.toHaveBeenCalled(); // 新規投稿を増やさない
    db.close();
  });

  it("覚えているメッセージが消えていれば投稿し直す", async () => {
    const { db, settings, services } = setup();
    settings.set(WAITERS_BOARD_CHANNEL_KEY, "board_channel", "test");
    settings.set(WAITERS_BOARD_MESSAGE_KEY, "deleted_message", "test");
    const channel = textChannel({ sendId: "reposted" });

    const result = await updateWaitersBoard(clientWith({ channel }), services);

    expect(result).toMatchObject({ ok: true, action: "created", messageId: "reposted" });
    expect(settings.getString(WAITERS_BOARD_MESSAGE_KEY)).toBe("reposted");
    db.close();
  });

  it("取得の一時失敗では投稿し直さない（重複設置を避ける）", async () => {
    const { db, settings, services } = setup();
    settings.set(WAITERS_BOARD_CHANNEL_KEY, "board_channel", "test");
    settings.set(WAITERS_BOARD_MESSAGE_KEY, "existing", "test");
    const channel = textChannel({ fetchError: Object.assign(new Error("rate limited"), { code: 50013 }) });

    const result = await updateWaitersBoard(clientWith({ channel }), services);

    expect(result.ok).toBe(false);
    expect(channel.send).not.toHaveBeenCalled();
    expect(settings.getString(WAITERS_BOARD_MESSAGE_KEY)).toBe("existing");
    db.close();
  });
});
