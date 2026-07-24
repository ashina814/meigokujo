import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Settings } from "../src/settings/service.js";
import { VcRewards } from "../src/vc/rewards.js";

const DATE = "2026-07-05";
const BASE = Date.UTC(2026, 6, 5) / 1000 - 9 * 3600; // JST 2026-07-05 00:00

function setup() {
  const db = openDb(":memory:");
  const settings = new Settings(db);
  settings.set("vc_sleep_list", ["vc:sleep"], "test");
  const rewards = new VcRewards(db, settings);
  const insert = (
    userId: string,
    channelId: string,
    startMin: number,
    endMin: number,
    opts: { muted?: boolean; deafened?: boolean; parentId?: string | null } = {},
  ) =>
    db
      .prepare(
        "INSERT INTO vc_segments (user_id, channel_id, parent_id, started_at, ended_at, self_muted, self_deafened) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        userId,
        channelId,
        opts.parentId ?? null,
        BASE + startMin * 60,
        BASE + endMin * 60,
        opts.muted ? 1 : 0,
        opts.deafened ? 1 : 0,
      );
  return { db, settings, rewards, insert };
}

describe("VC浮上報酬の日次計算（ブラックリスト方式）", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("任意のVC（ホワイトリスト不要）で2人重なれば報酬対象になる", () => {
    // 旧仕様ではリスト外だった任意のチャンネルでも、新仕様では対象
    ctx.insert("a", "vc:any-auto-generated", 0, 120);
    ctx.insert("b", "vc:any-auto-generated", 60, 120); // 重なり60分
    const r = ctx.rewards.computeDay(DATE);
    expect(r.find((x) => x.userId === "a")?.normalSeconds).toBe(3600);
    expect(r.find((x) => x.userId === "b")?.normalSeconds).toBe(3600);
    expect(r.find((x) => x.userId === "a")?.amount).toBe(600);
  });

  it("2人が重なっている時間だけカウントされる（1人浮上は無収入）", () => {
    ctx.insert("a", "vc:x", 0, 120);
    ctx.insert("b", "vc:x", 60, 120); // 重なり60分
    const r = ctx.rewards.computeDay(DATE);
    expect(r.find((x) => x.userId === "a")!.normalSeconds).toBe(3600);
    expect(r.find((x) => x.userId === "a")!.amount).toBe(600);
    expect(r.find((x) => x.userId === "b")!.amount).toBe(600);
  });

  it("除外リスト(xp_excluded_channels)のチャンネルは対象外", () => {
    ctx.settings.set("xp_excluded_channels", ["vc:afk"], "test");
    ctx.insert("a", "vc:afk", 0, 120);
    ctx.insert("b", "vc:afk", 0, 120);
    expect(ctx.rewards.computeDay(DATE)).toEqual([]);
  });

  it("除外リストに親カテゴリIDが入っていれば、その配下VCは対象外", () => {
    ctx.settings.set("xp_excluded_channels", ["cat:casino"], "test");
    // parent_id が除外カテゴリ → 対象外
    ctx.insert("a", "vc:casino-table-1", 0, 120, { parentId: "cat:casino" });
    ctx.insert("b", "vc:casino-table-1", 0, 120, { parentId: "cat:casino" });
    expect(ctx.rewards.computeDay(DATE)).toEqual([]);
  });

  it("同じ親カテゴリでも除外されていないカテゴリなら対象", () => {
    ctx.settings.set("xp_excluded_channels", ["cat:casino"], "test");
    ctx.insert("a", "vc:lounge", 0, 120, { parentId: "cat:hangout" });
    ctx.insert("b", "vc:lounge", 0, 120, { parentId: "cat:hangout" });
    const r = ctx.rewards.computeDay(DATE);
    expect(r.find((x) => x.userId === "a")!.amount).toBe(1200); // 120分 → 100×12
  });

  it("scope を明示注入すると設定より優先して使われる", () => {
    // 設定は空だが、scope で除外を渡すと効く
    ctx.insert("a", "vc:z", 0, 120);
    ctx.insert("b", "vc:z", 0, 120);
    const excluded = ctx.rewards.computeDay(DATE, { excludedIds: new Set(["vc:z"]) });
    expect(excluded).toEqual([]);
    const included = ctx.rewards.computeDay(DATE, { excludedIds: new Set(["vc:other"]) });
    expect(included.find((x) => x.userId === "a")!.amount).toBe(1200); // 120分 → 100×12
  });

  it("ミュート中は在室者としては数えるが、本人は稼げない", () => {
    ctx.insert("speaker", "vc:x", 0, 60);
    ctx.insert("muted", "vc:x", 0, 60, { muted: true });
    const r = ctx.rewards.computeDay(DATE);
    expect(r.find((x) => x.userId === "speaker")!.amount).toBe(600);
    expect(r.find((x) => x.userId === "muted")).toBeUndefined();
  });

  it("寝落ちVC(vc_sleep_list)はミュートでも減額レートで稼げる", () => {
    ctx.insert("a", "vc:sleep", 0, 100, { muted: true, deafened: true });
    ctx.insert("b", "vc:sleep", 0, 100, { muted: true });
    const r = ctx.rewards.computeDay(DATE);
    expect(r.find((x) => x.userId === "a")!.amount).toBe(300); // 30 Ld/10分 × 10
  });

  it("10分未満のセグメント（出入り連打）は無効", () => {
    for (let i = 0; i < 6; i++) {
      ctx.insert("a", "vc:x", i * 20, i * 20 + 9);
      ctx.insert("b", "vc:x", i * 20, i * 20 + 9);
    }
    expect(ctx.rewards.computeDay(DATE)).toEqual([]);
  });

  it("日次上限で頭打ちになる（通常+寝落ちの合算）", () => {
    ctx.insert("a", "vc:x", 0, 360); // 6時間
    ctx.insert("b", "vc:x", 0, 360);
    const r = ctx.rewards.computeDay(DATE);
    expect(r.find((x) => x.userId === "a")!.amount).toBe(3_000); // cap
  });

  it("日をまたぐセグメントは窓にクリップされる", () => {
    ctx.insert("a", "vc:x", -60, 60);
    ctx.insert("b", "vc:x", -60, 60);
    const r = ctx.rewards.computeDay(DATE);
    expect(r.find((x) => x.userId === "a")!.normalSeconds).toBe(3600);
  });

  it("複数チャンネル横断で合算される（別々のVCの時間が足される）", () => {
    ctx.insert("a", "vc:room1", 0, 60);
    ctx.insert("b", "vc:room1", 0, 60);
    ctx.insert("a", "vc:room2", 60, 120);
    ctx.insert("c", "vc:room2", 60, 120);
    const r = ctx.rewards.computeDay(DATE);
    // a は room1 で60分 + room2 で60分 = 120分
    expect(r.find((x) => x.userId === "a")!.normalSeconds).toBe(7200);
    expect(r.find((x) => x.userId === "a")!.amount).toBe(1200);
  });
});
