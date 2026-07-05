import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Settings } from "../src/settings/service.js";
import { VcRewards } from "../src/vc/rewards.js";

const DATE = "2026-07-05";
const BASE = Date.UTC(2026, 6, 5) / 1000 - 9 * 3600; // JST 2026-07-05 00:00

function setup() {
  const db = openDb(":memory:");
  const settings = new Settings(db);
  settings.set("vc_whitelist", ["vc:eval"], "test");
  settings.set("vc_sleep_list", ["vc:sleep"], "test");
  const rewards = new VcRewards(db, settings);
  const insert = (
    userId: string,
    channelId: string,
    startMin: number,
    endMin: number,
    muted = false,
    deafened = false,
  ) =>
    db
      .prepare(
        "INSERT INTO vc_segments (user_id, channel_id, started_at, ended_at, self_muted, self_deafened) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(userId, channelId, BASE + startMin * 60, BASE + endMin * 60, muted ? 1 : 0, deafened ? 1 : 0);
  return { db, settings, rewards, insert };
}

describe("VC浮上報酬の日次計算", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("巣穴の複製VC（vc_whitelist_den）も報酬対象になる", () => {
    ctx.settings.set("vc_whitelist_den", ["vc:den-clone-1"], "test");
    ctx.insert("a", "vc:den-clone-1", 0, 120);
    ctx.insert("b", "vc:den-clone-1", 60, 120); // 重なり60分
    const r = ctx.rewards.computeDay(DATE);
    expect(r.find((x) => x.userId === "a")?.normalSeconds).toBe(3600);
    expect(r.find((x) => x.userId === "b")?.normalSeconds).toBe(3600);
  });

  it("2人が重なっている時間だけカウントされる（1人浮上は無収入）", () => {
    ctx.insert("a", "vc:eval", 0, 120); // 0〜120分
    ctx.insert("b", "vc:eval", 60, 120); // 60〜120分 → 重なり60分
    const r = ctx.rewards.computeDay(DATE);
    const a = r.find((x) => x.userId === "a")!;
    expect(a.normalSeconds).toBe(3600); // 重なった60分だけ
    expect(a.amount).toBe(600); // 100 Ld/10分 × 6
    expect(r.find((x) => x.userId === "b")!.amount).toBe(600);
  });

  it("ミュート中は在室者としては数えるが、本人は稼げない", () => {
    ctx.insert("speaker", "vc:eval", 0, 60);
    ctx.insert("muted", "vc:eval", 0, 60, true); // ミュートで同席
    const r = ctx.rewards.computeDay(DATE);
    // muted がいるおかげで speaker は「2人以上」を満たして稼げる
    expect(r.find((x) => x.userId === "speaker")!.amount).toBe(600);
    // muted 本人は対象外
    expect(r.find((x) => x.userId === "muted")).toBeUndefined();
  });

  it("寝落ちVCはミュートでも減額レートで稼げる", () => {
    ctx.insert("a", "vc:sleep", 0, 100, true, true);
    ctx.insert("b", "vc:sleep", 0, 100, true);
    const r = ctx.rewards.computeDay(DATE);
    expect(r.find((x) => x.userId === "a")!.amount).toBe(300); // 30 Ld/10分 × 10
  });

  it("ホワイトリスト外のVCは何時間いても無収入", () => {
    ctx.insert("a", "vc:other", 0, 600);
    ctx.insert("b", "vc:other", 0, 600);
    expect(ctx.rewards.computeDay(DATE)).toEqual([]);
  });

  it("10分未満のセグメント（出入り連打）は無効", () => {
    for (let i = 0; i < 6; i++) {
      ctx.insert("a", "vc:eval", i * 20, i * 20 + 9); // 9分×6回
      ctx.insert("b", "vc:eval", i * 20, i * 20 + 9);
    }
    expect(ctx.rewards.computeDay(DATE)).toEqual([]);
  });

  it("日次上限で頭打ちになる（通常+寝落ちの合算）", () => {
    ctx.insert("a", "vc:eval", 0, 360); // 6時間 → 3,600 Ld相当
    ctx.insert("b", "vc:eval", 0, 360);
    const r = ctx.rewards.computeDay(DATE);
    expect(r.find((x) => x.userId === "a")!.amount).toBe(3_000); // cap
  });

  it("日をまたぐセグメントは窓にクリップされる", () => {
    ctx.insert("a", "vc:eval", -60, 60); // 前日23:00〜当日1:00
    ctx.insert("b", "vc:eval", -60, 60);
    const r = ctx.rewards.computeDay(DATE);
    expect(r.find((x) => x.userId === "a")!.normalSeconds).toBe(3600); // 当日分の60分だけ
  });
});
