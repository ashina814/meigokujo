import { describe, expect, it, vi, afterEach } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { VcTracker } from "../src/vc/service.js";
import { Tickets } from "../src/tickets/service.js";
import { EventLog } from "../src/events/service.js";

afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const db = openDb(":memory:");
  return { db, vc: new VcTracker(db), tickets: new Tickets(db, new EventLog(db)) };
}

describe("VC計測", () => {
  it("入室→退出でセグメントが閉じ、浮上実績に集計される", () => {
    vi.useFakeTimers();
    const { vc } = setup();
    vi.setSystemTime(new Date("2026-07-04T12:00:00Z"));
    vc.open("alice", "vc1", false, false);
    vi.setSystemTime(new Date("2026-07-04T13:30:00Z"));
    vc.close("alice");

    const p = vc.presence("alice", 14);
    expect(p.totalSeconds).toBe(90 * 60);
    expect(p.daysSeen).toBe(1);
    expect(p.perChannel).toEqual([{ channelId: "vc1", seconds: 5400 }]);
  });

  it("チャンネル移動・ミュート変化は別セグメントになり、対象VC絞り込みが効く", () => {
    vi.useFakeTimers();
    const { vc } = setup();
    vi.setSystemTime(new Date("2026-07-04T12:00:00Z"));
    vc.open("alice", "vc1", false, false);
    vi.setSystemTime(new Date("2026-07-04T12:10:00Z"));
    vc.open("alice", "vc2", false, false); // 移動: vc1を閉じてvc2を開く
    vi.setSystemTime(new Date("2026-07-04T12:40:00Z"));
    vc.close("alice");

    const all = vc.presence("alice", 14);
    expect(all.totalSeconds).toBe(40 * 60);
    const whitelisted = vc.presence("alice", 14, ["vc1"]);
    expect(whitelisted.totalSeconds).toBe(10 * 60);
  });

  it("閉じ損ね（クラッシュ）は起動時に上限つきで閉じられる", () => {
    vi.useFakeTimers();
    const { vc } = setup();
    vi.setSystemTime(new Date("2026-07-04T00:00:00Z"));
    vc.open("alice", "vc1", false, false);
    // 2日後に再起動した想定 → 6時間で打ち切り
    vi.setSystemTime(new Date("2026-07-06T00:00:00Z"));
    expect(vc.closeAllDangling()).toBe(1);
    expect(vc.presence("alice", 14).totalSeconds).toBe(6 * 3600);
  });

  it("totalsByUser: 全ユーザーの累計VC時間を全VC対象で集計（位階判定用）", () => {
    vi.useFakeTimers();
    const { vc } = setup();
    vi.setSystemTime(new Date("2026-07-04T12:00:00Z"));
    vc.open("alice", "vc1", false, false);
    vc.open("bob", "vc2", false, false);
    vi.setSystemTime(new Date("2026-07-04T12:30:00Z"));
    vc.close("bob"); // 30分
    vi.setSystemTime(new Date("2026-07-04T13:00:00Z"));
    vc.close("alice"); // 60分

    const totals = vc.totalsByUser(30);
    expect(totals.find((t) => t.userId === "alice")?.seconds).toBe(60 * 60);
    expect(totals.find((t) => t.userId === "bob")?.seconds).toBe(30 * 60);
    expect(totals[0]?.userId).toBe("alice"); // 多い順
  });

  it("lastSeen が最終浮上時刻を返す（死亡判定の材料）", () => {
    vi.useFakeTimers();
    const { vc } = setup();
    expect(vc.lastSeen("alice")).toBeNull();
    vi.setSystemTime(new Date("2026-07-04T12:00:00Z"));
    vc.open("alice", "vc1", false, false);
    vi.setSystemTime(new Date("2026-07-04T12:30:00Z"));
    vc.close("alice");
    expect(vc.lastSeen("alice")).toBe(Math.floor(new Date("2026-07-04T12:30:00Z").getTime() / 1000));
  });
});

describe("チケット", () => {
  it("作成→対応→クローズのライフサイクル", () => {
    const { tickets } = setup();
    tickets.create("th1", "alice", "return");
    expect(tickets.get("th1")!.status).toBe("open");
    tickets.claim("th1", "staff1");
    expect(tickets.get("th1")!.claimed_by).toBe("staff1");
    tickets.close("th1", "staff1");
    expect(tickets.get("th1")!.status).toBe("closed");
  });

  it("24時間無応答の open チケットだけが staleOpen に出る（claimed・リマインド済みは除外）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T00:00:00Z"));
    const { tickets } = setup();
    tickets.create("old_open", "a", "consult");
    tickets.create("old_claimed", "b", "consult");
    tickets.claim("old_claimed", "staff");
    vi.setSystemTime(new Date("2026-07-05T01:00:00Z")); // 25時間後
    tickets.create("fresh", "c", "return");

    const stale = tickets.staleOpen(24);
    expect(stale.map((t) => t.thread_id)).toEqual(["old_open"]);

    tickets.markReminded("old_open");
    expect(tickets.staleOpen(24)).toEqual([]);
  });
});
