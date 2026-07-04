import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";
import { VcTracker } from "../src/vc/service.js";
import { TitleEngine } from "../src/titles/service.js";

afterEach(() => vi.useRealTimers());

function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const vc = new VcTracker(db);
  const titles = new TitleEngine(db, vc);
  return { db, events, vc, titles };
}

describe("称号機関", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("亡霊化で『生まれし魂』、昇格で『魔人への道』が付く", () => {
    ctx.events.log("ghosted", { actor: "staff", target: "alice" });
    const g1 = ctx.titles.evaluate("alice");
    expect(g1.map((t) => t.key)).toContain("newborn");

    ctx.events.log("promotion", { actor: "staff", target: "alice" });
    const g2 = ctx.titles.evaluate("alice");
    expect(g2.map((t) => t.key)).toContain("risen");
    // 既得の newborn は再付与されない
    expect(g2.map((t) => t.key)).not.toContain("newborn");
  });

  it("招待は actor 側でカウントされ、5人で上位称号に昇格する", () => {
    for (let i = 0; i < 4; i++) ctx.events.log("invite_credited", { actor: "bob", target: `g${i}` });
    const g1 = ctx.titles.evaluate("bob");
    expect(g1.map((t) => t.key)).toContain("recruiter");
    expect(g1.map((t) => t.key)).not.toContain("recruiter_gold");

    ctx.events.log("invite_credited", { actor: "bob", target: "g4" });
    const g2 = ctx.titles.evaluate("bob");
    expect(g2.map((t) => t.key)).toContain("recruiter_gold");
  });

  it("被招待者（target側）には勧誘者称号は付かない", () => {
    ctx.events.log("invite_credited", { actor: "bob", target: "guest" });
    const granted = ctx.titles.evaluate("guest");
    expect(granted.map((t) => t.key)).not.toContain("recruiter");
  });

  it("在城日数で古参・百年の称号が付く", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    ctx.db.prepare("INSERT INTO souls (user_id, status, ghost_at, updated_at) VALUES ('carol','ghost',?,?)")
      .run(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));

    vi.setSystemTime(new Date("2026-02-05T00:00:00Z")); // 35日後
    expect(ctx.titles.evaluate("carol").map((t) => t.key)).toContain("veteran");

    vi.setSystemTime(new Date("2026-04-15T00:00:00Z")); // 100日超
    expect(ctx.titles.evaluate("carol").map((t) => t.key)).toContain("elder");
  });

  it("VC累計100時間で『不眠の魂』", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    ctx.vc.open("dave", "vc1", false, false);
    vi.setSystemTime(new Date("2026-07-05T12:00:00Z")); // 108時間後
    ctx.vc.close("dave");
    expect(ctx.titles.evaluate("dave").map((t) => t.key)).toContain("nightwalker");
  });

  it("list は獲得済みを獲得順に返し、evaluate は冪等（新規のみ返す）", () => {
    ctx.events.log("ghosted", { target: "eve" });
    ctx.titles.evaluate("eve");
    expect(ctx.titles.evaluate("eve")).toEqual([]); // 2回目は新規なし
    expect(ctx.titles.list("eve").map((t) => t.key)).toEqual(["newborn"]);
    expect(ctx.titles.ownedKeys("eve")).toEqual(["newborn"]);
  });
});
