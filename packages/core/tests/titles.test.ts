import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";
import { VcTracker } from "../src/vc/service.js";
import { TitleEngine, EQUIP_SLOTS } from "../src/titles/service.js";
import { TITLE_RULES } from "../src/titles/catalog.js";

afterEach(() => vi.useRealTimers());

const HOUR = 3600;

function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const vc = new VcTracker(db);
  const titles = new TitleEngine(db, vc);
  return { db, events, vc, titles };
}

/** 招待は invites テーブルが正（Entry が台帳と同時に書く）。血脈判定もこの表を辿る */
function credit(db: Database.Database, inviter: string, invitee: string) {
  db.prepare("INSERT INTO invites (inviter_id, invitee_id, credited_at) VALUES (?, ?, 0)").run(inviter, invitee);
}

describe("称号カタログの健全性", () => {
  it("キーが重複していない", () => {
    const keys = TITLE_RULES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("名前が重複していない（命名作業での取り違え防止）", () => {
    const names = TITLE_RULES.map((r) => r.name);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });

  it("全ルールに説明と絵文字がある", () => {
    for (const r of TITLE_RULES) {
      expect(r.desc.length, `${r.key} の desc`).toBeGreaterThan(0);
      expect(r.emoji.length, `${r.key} の emoji`).toBeGreaterThan(0);
    }
  });

  it("総数100以上・うち段位以外が60以上", () => {
    expect(TITLE_RULES.length).toBeGreaterThanOrEqual(100);
    expect(TITLE_RULES.filter((r) => r.category !== "dan").length).toBeGreaterThanOrEqual(60);
  });

  it("匿名機能（トートの耳・チケット）を条件にしていない", () => {
    // 称号として露出すると匿名性が壊れる。カタログのコメントで禁じている規約の実行版
    for (const r of TITLE_RULES) {
      expect(r.check.toString(), `${r.key} が匿名機能を参照している`).not.toMatch(/confession|ticket/);
    }
  });

  it("実績ゼロの魂には1つも付与されない（常に真のルールが紛れていない）", () => {
    const { titles } = setup();
    expect(titles.evaluate("nobody")).toEqual([]);
  });
});

describe("称号機関", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("亡霊化で『生まれし魂』、昇格で『魔人への道』が付く", () => {
    ctx.events.log("ghosted", { actor: "staff", target: "alice" });
    expect(ctx.titles.evaluate("alice").map((t) => t.key)).toContain("newborn");

    ctx.events.log("promotion", { actor: "staff", target: "alice" });
    const g2 = ctx.titles.evaluate("alice").map((t) => t.key);
    expect(g2).toContain("risen");
    expect(g2).not.toContain("newborn"); // 既得は再付与されない
  });

  it("招待は招いた側でカウントされ、5人で上位称号に昇格する", () => {
    for (let i = 0; i < 4; i++) credit(ctx.db, "bob", `g${i}`);
    const g1 = ctx.titles.evaluate("bob").map((t) => t.key);
    expect(g1).toContain("recruiter_1");
    expect(g1).not.toContain("recruiter_5");

    credit(ctx.db, "bob", "g4");
    expect(ctx.titles.evaluate("bob").map((t) => t.key)).toContain("recruiter_5");
  });

  it("被招待者には勧誘者称号は付かない", () => {
    credit(ctx.db, "bob", "guest");
    expect(ctx.titles.evaluate("guest").map((t) => t.key)).not.toContain("recruiter_1");
  });

  it("招いた者がさらに人を招くと『血脈』が生まれる", () => {
    credit(ctx.db, "bob", "child");
    expect(ctx.titles.evaluate("bob").map((t) => t.key)).not.toContain("lineage_1");

    credit(ctx.db, "child", "grandchild");
    expect(ctx.titles.evaluate("bob").map((t) => t.key)).toContain("lineage_1");
    // 孫は自分の直接招待には数えない
    expect(ctx.titles.progress("bob").owned).toBeGreaterThan(0);
  });

  it("在城日数の段位が刻まれる", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const ts = Math.floor(Date.now() / 1000);
    ctx.db
      .prepare("INSERT INTO souls (user_id, status, ghost_at, updated_at) VALUES ('carol','ghost',?,?)")
      .run(ts, ts);

    vi.setSystemTime(new Date("2026-02-05T00:00:00Z")); // 35日後
    expect(ctx.titles.evaluate("carol").map((t) => t.key)).toContain("dan_days_2");

    vi.setSystemTime(new Date("2026-04-15T00:00:00Z")); // 100日超
    expect(ctx.titles.evaluate("carol").map((t) => t.key)).toContain("dan_days_3");
  });

  it("VCの累計時間そのものでは称号が付かない（ランクの領分）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    ctx.vc.open("dave", "vc1", null, false, false);
    vi.setSystemTime(new Date("2026-07-05T12:00:00Z")); // 108時間 独りで浮上
    ctx.vc.close("dave");

    const keys = ctx.titles.evaluate("dave").map((t) => t.key);
    expect(keys).not.toContain("nightwalker"); // 廃止済み
    // 独りなので縁の称号も付かない
    expect(keys).not.toContain("co_first");
    // 一方で「一度に長く居た」「日を跨いだ」といった事件性は拾う
    expect(keys).toContain("marathon_8h");
    expect(keys).toContain("cross_1");
  });

  it("同席の実績から縁の称号が付く", () => {
    const t0 = Math.floor(Date.now() / 1000) - 100 * HOUR;
    for (const u of ["u1", "u2"]) {
      ctx.db.prepare("INSERT INTO vc_segments (user_id, channel_id, started_at, ended_at) VALUES (?,'vc:1',?,?)").run(
        u,
        t0,
        t0 + 12 * HOUR,
      );
    }
    ctx.vc.rebuildCompanions();

    const keys = ctx.titles.evaluate("u1").map((t) => t.key);
    expect(keys).toContain("co_first");
    expect(keys).toContain("buddy_10h");
    expect(keys).not.toContain("buddy_50h");
  });

  it("段位は跨いだぶんだけまとめて付く", () => {
    // 開室中の宿は1人1件までという制約があるため、過去に開いて閉じた部屋として積む
    for (let i = 0; i < 6; i++) {
      ctx.db
        .prepare(
          "INSERT INTO rooms (kind, channel_id, owner_id, status, created_at, updated_at) VALUES ('normal', ?, 'u1', 'closed', 0, 0)",
        )
        .run(`ch${i}`);
    }
    const keys = ctx.titles.evaluate("u1").map((t) => t.key);
    expect(keys).toContain("dan_room_1");
    expect(keys).toContain("dan_room_2");
    expect(keys).not.toContain("dan_room_3");
  });

  it("賭場テーブルが未生成でも評価が落ちない", () => {
    ctx.events.log("ghosted", { target: "u1" });
    expect(() => ctx.titles.evaluate("u1")).not.toThrow();
    expect(ctx.titles.list("u1").length).toBeGreaterThan(0);
  });

  it("list は獲得順に返し、evaluate は冪等（新規のみ返す）", () => {
    ctx.events.log("ghosted", { target: "eve" });
    ctx.titles.evaluate("eve");
    expect(ctx.titles.evaluate("eve")).toEqual([]);
    expect(ctx.titles.list("eve").map((t) => t.key)).toEqual(["newborn"]);
    expect(ctx.titles.ownedKeys("eve")).toEqual(["newborn"]);
  });

  it("進捗の分母は現行ルールの総数", () => {
    ctx.events.log("ghosted", { target: "u1" });
    ctx.titles.evaluate("u1");
    const p = ctx.titles.progress("u1");
    expect(p.total).toBe(TITLE_RULES.length);
    expect(p.owned).toBeGreaterThan(0);
    expect(p.owned).toBeLessThanOrEqual(p.total);
  });
});

describe("旧称号キーの引き継ぎ", () => {
  it("旧キーの実績が新キーへ移り、失われない", () => {
    const db = openDb(":memory:");
    for (const key of ["recruiter", "recruiter_gold", "matchmaker", "innkeeper", "veteran", "elder"]) {
      db.prepare("INSERT INTO titles (user_id, title_key, granted_at) VALUES ('u1', ?, 100)").run(key);
    }
    const titles = new TitleEngine(db, new VcTracker(db));
    const keys = titles.list("u1").map((t) => t.key);

    expect(keys).toEqual(
      expect.arrayContaining(["recruiter_1", "recruiter_5", "mitsugetsu", "dan_room_2", "dan_days_2", "dan_days_3"]),
    );
    expect(keys).not.toContain("recruiter");
    expect(titles.list("u1")).toHaveLength(6);
  });

  it("廃止した称号は一覧に残るが、新規付与はされない", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO titles (user_id, title_key, granted_at) VALUES ('u1', 'nightwalker', 100)").run();
    const titles = new TitleEngine(db, new VcTracker(db));

    expect(titles.list("u1").map((t) => t.key)).toContain("nightwalker");
    expect(titles.progress("u1").owned).toBe(0); // 分母・分子とも現行ルールのみ
    expect(TITLE_RULES.map((r) => r.key)).not.toContain("nightwalker");
  });

  it("新旧どちらも持っていても重複行にならない", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO titles (user_id, title_key, granted_at) VALUES ('u1', 'recruiter', 100)").run();
    db.prepare("INSERT INTO titles (user_id, title_key, granted_at) VALUES ('u1', 'recruiter_1', 200)").run();
    const titles = new TitleEngine(db, new VcTracker(db));
    expect(titles.list("u1").filter((t) => t.key === "recruiter_1")).toHaveLength(1);
  });

  it("移行は二度走らせても壊れない", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO titles (user_id, title_key, granted_at) VALUES ('u1', 'veteran', 100)").run();
    new TitleEngine(db, new VcTracker(db));
    const titles = new TitleEngine(db, new VcTracker(db));
    expect(titles.list("u1").map((t) => t.key)).toEqual(["dan_days_2"]);
  });
});

describe("装備", () => {
  /** 獲得時刻をずらして入れる（「新しい順」の検証を決定的にするため） */
  function ownSome(db: Database.Database) {
    ["newborn", "co_first", "night_1", "dawn_1"].forEach((key, i) => {
      db.prepare("INSERT INTO titles (user_id, title_key, granted_at) VALUES ('u1', ?, ?)").run(key, 100 + i);
    });
  }

  it("持っている称号を掲げられる", () => {
    const { db, titles } = setup();
    ownSome(db);
    expect(titles.equip("u1", ["co_first", "night_1"])).toEqual({ ok: true });
    expect(titles.equipped("u1").map((t) => t.key)).toEqual(["co_first", "night_1"]);
  });

  it("持っていない称号・枠超過・重複は弾く", () => {
    const { db, titles } = setup();
    ownSome(db);
    expect(titles.equip("u1", ["jackpot_1"]).ok).toBe(false);
    expect(titles.equip("u1", ["newborn", "co_first", "night_1", "dawn_1"]).ok).toBe(false);
    expect(titles.equip("u1", ["co_first", "co_first"]).ok).toBe(false);
  });

  it("未設定なら獲得が新しい順で自動的に埋まる", () => {
    const { db, titles } = setup();
    ownSome(db);
    expect(titles.equipped("u1").map((t) => t.key)).toEqual(["dawn_1", "night_1", "co_first"]);
  });

  it("空配列を渡すと自動に戻る", () => {
    const { db, titles } = setup();
    ownSome(db);
    titles.equip("u1", ["newborn"]);
    expect(titles.equipped("u1").map((t) => t.key)).toEqual(["newborn"]);
    titles.equip("u1", []);
    expect(titles.equipped("u1")).toHaveLength(EQUIP_SLOTS);
  });

  it("全称号を持っていてもカードに渡るのは枠数まで", () => {
    const { db, titles } = setup();
    for (const r of TITLE_RULES) {
      db.prepare("INSERT INTO titles (user_id, title_key, granted_at) VALUES ('u1', ?, 100)").run(r.key);
    }
    expect(titles.equipped("u1").length).toBeLessThanOrEqual(EQUIP_SLOTS);
  });
});
