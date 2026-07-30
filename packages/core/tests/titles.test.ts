import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";
import { VcTracker } from "../src/vc/service.js";
import { TitleEngine, EQUIP_SLOTS } from "../src/titles/service.js";
import { TITLE_RULES } from "../src/titles/catalog.js";
import { SENSITIVE_SOURCES, findSensitiveReference } from "../src/titles/privacy.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";

registerDefaultTxTypes();
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

  it("実績ゼロの魂には1つも付与されない（常に真のルールが紛れていない）", () => {
    const { titles } = setup();
    expect(titles.evaluate("nobody")).toEqual([]);
  });
});

describe("秘匿機能の構造的な排除", () => {
  it("どのルールも秘匿対象のデータ源を参照していない", () => {
    // トートの耳・チケット・蜜月・朧月は、称号にすると利用事実や人間関係が
    // プロフィールから逆算できてしまう。判定式を機械的に走査して禁止する。
    for (const r of TITLE_RULES) {
      const hit = findSensitiveReference(r.check.toString());
      expect(hit, `${r.key} が秘匿データ源 "${hit}" を参照している`).toBeNull();
    }
  });

  it("説明文にも秘匿機能の名前が出ていない", () => {
    // 未獲得一覧に条件が公示されるため、説明文からも辿れてはいけない
    for (const r of TITLE_RULES) {
      expect(findSensitiveReference(r.desc), `${r.key} の説明が秘匿機能に言及している`).toBeNull();
    }
  });

  it("秘匿対象の一覧が縮んでいない（うっかり削除の検知）", () => {
    expect([...SENSITIVE_SOURCES]).toEqual(
      expect.arrayContaining(["confession", "toto", "ticket", "mitsugetsu", "oborozuki", "recruit"]),
    );
  });

  it("蜜月・朧月の部屋は部屋の実績に数えない", () => {
    const { db, titles } = setup();
    // 秘匿対象の部屋しか持っていない場合、部屋系の称号は一切付かない
    db.prepare(
      "INSERT INTO rooms (kind, channel_id, owner_id, status, created_at, updated_at) VALUES ('mitsugetsu','ch-m','u1','closed',0,0)",
    ).run();
    db.prepare(
      "INSERT INTO rooms (kind, channel_id, owner_id, status, created_at, updated_at) VALUES ('oborozuki','ch-o','u1','closed',0,0)",
    ).run();
    const keys = titles.evaluate("u1").map((t) => t.key);
    expect(keys).not.toContain("dan_room_1");
    expect(keys).not.toContain("room_normal");
  });

  it("蜜月成立・朧月受諾は称号にならない", () => {
    const { events, titles } = setup();
    events.log("recruit_matched", { actor: "u1" });
    events.log("oborozuki_invite_accepted", { actor: "u1" });
    expect(titles.evaluate("u1")).toEqual([]);
  });
});

describe("台帳の実績（口座の出入りで数える）", () => {
  /**
   * 台帳は Ledger を通して作る。
   * transactions.actor_id はユーザー操作では `user:<id>` 形式で入るため、
   * 裸のユーザーIDで actor_id を引くと1件も拾えない。ここはその回帰テスト。
   */
  function ledgerSetup() {
    const db = openDb(":memory:");
    const ledger = new Ledger(db);
    const vc = new VcTracker(db);
    const titles = new TitleEngine(db, vc);
    for (const id of ["user:alice", "user:bob", "user:carol"]) ledger.ensureAccount(id, "user");
    ledger.ensureAccount("sys:dept:kitchen", "system");
    const fund = (to: string, amount: number) =>
      ledger.transfer({
        from: TREASURY,
        to,
        amount,
        type: "initial",
        actor: "system:test",
        idempotencyKey: `fund:${to}:${amount}:${Math.random()}`,
      });
    return { db, ledger, titles, fund };
  }

  it("実際の /投げ銭 と同じ形（actor は user:<id>）で投げ銭称号が解除される", () => {
    const { ledger, titles, fund } = ledgerSetup();
    fund("user:alice", 500_000);
    // tip.ts と同じ呼び方: from も actor も `user:<id>`
    ledger.transfer({
      from: "user:alice",
      to: "user:bob",
      amount: 200_000,
      type: "tip",
      actor: "user:alice",
      idempotencyKey: "tip:1",
    });

    const alice = titles.evaluate("alice").map((t) => t.key);
    expect(alice).toContain("dan_tip_1");
    expect(alice).toContain("tip_sum_100k");

    const bob = titles.evaluate("bob").map((t) => t.key);
    expect(bob).toContain("tip_received_1");
    expect(bob).not.toContain("dan_tip_1"); // 受け取った側は投げていない
  });

  it("投げ銭の相手人数を口座から正しく数える", () => {
    const { ledger, titles, fund } = ledgerSetup();
    fund("user:alice", 500_000);
    for (const [i, to] of ["user:bob", "user:carol", "user:bob"].entries()) {
      ledger.transfer({
        from: "user:alice",
        to,
        amount: 1_000,
        type: "tip",
        actor: "user:alice",
        idempotencyKey: `tip:multi:${i}`,
      });
    }
    titles.evaluate("alice");
    // 3回投げたが相手は2人。段位は回数（閾値 1/10/50/200）、tip_targets は人数
    const keys = titles.ownedKeys("alice");
    expect(keys).toContain("dan_tip_1");
    expect(keys).not.toContain("dan_tip_2"); // 10回には届かない
    expect(keys).not.toContain("tip_targets_5"); // 相手は2人なので届かない
  });

  it("部署口座への入金・部署からの受け取りで部署称号が解除される", () => {
    const { ledger, titles, fund } = ledgerSetup();
    fund("user:alice", 50_000);
    // bank-panel.ts と同じ形
    ledger.transfer({
      from: "user:alice",
      to: "sys:dept:kitchen",
      amount: 10_000,
      type: "dept_in",
      actor: "user:alice",
      idempotencyKey: "dept:in:1",
    });
    expect(titles.evaluate("alice").map((t) => t.key)).toContain("dept_first");

    // 出金側（部署→住人）は受け取りとして数える
    ledger.transfer({
      from: "sys:dept:kitchen",
      to: "user:bob",
      amount: 5_000,
      type: "dept_out",
      actor: "user:bob",
      idempotencyKey: "dept:out:1",
    });
    expect(titles.evaluate("bob").map((t) => t.key)).toContain("dept_first");
  });

  it("冥府税・年金は実在する取引種別なので称号が解除される", () => {
    const { ledger, titles, fund } = ledgerSetup();
    fund("user:alice", 100_000);
    // fiscal/service.ts が type: isTax ? "tax" : "pension" で作る
    ledger.transfer({
      from: "user:alice",
      to: TREASURY,
      amount: 10_000,
      type: "tax",
      actor: "system:fiscal",
      idempotencyKey: "tax:1",
    });
    ledger.transfer({
      from: TREASURY,
      to: "user:bob",
      amount: 3_000,
      type: "pension",
      actor: "system:fiscal",
      idempotencyKey: "pension:1",
    });

    expect(titles.evaluate("alice").map((t) => t.key)).toContain("taxpayer");
    expect(titles.evaluate("bob").map((t) => t.key)).toContain("pensioner");
  });

  it("冥獄ボットへの投げ銭（焼却）も口座の出で拾える", () => {
    const { ledger, titles, fund } = ledgerSetup();
    fund("user:alice", 50_000);
    ledger.transfer({
      from: "user:alice",
      to: TREASURY,
      amount: 1_000,
      type: "tip_burn",
      actor: "user:alice",
      idempotencyKey: "burn:1",
    });
    expect(titles.evaluate("alice").map((t) => t.key)).toContain("burnt_offering");
  });

  it("他人の取引で自分の称号が解除されない", () => {
    const { ledger, titles, fund } = ledgerSetup();
    fund("user:alice", 50_000);
    ledger.transfer({
      from: "user:alice",
      to: "user:bob",
      amount: 40_000,
      type: "tip",
      actor: "user:alice",
      idempotencyKey: "tip:other",
    });
    expect(titles.evaluate("carol")).toEqual([]);
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
    expect(g2).not.toContain("newborn");
  });

  it("招待は招いた側でカウントされ、5人で上位称号に昇格する", () => {
    for (let i = 0; i < 4; i++) credit(ctx.db, "bob", `g${i}`);
    const g1 = ctx.titles.evaluate("bob").map((t) => t.key);
    expect(g1).toContain("recruiter_1");
    expect(g1).not.toContain("recruiter_5");

    credit(ctx.db, "bob", "g4");
    expect(ctx.titles.evaluate("bob").map((t) => t.key)).toContain("recruiter_5");
  });

  it("招いた者がさらに人を招くと『血脈』が生まれる", () => {
    credit(ctx.db, "bob", "child");
    expect(ctx.titles.evaluate("bob").map((t) => t.key)).not.toContain("lineage_1");
    credit(ctx.db, "child", "grandchild");
    expect(ctx.titles.evaluate("bob").map((t) => t.key)).toContain("lineage_1");
  });

  it("在城日数の段位が刻まれる", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const ts = Math.floor(Date.now() / 1000);
    ctx.db.prepare("INSERT INTO souls (user_id, status, ghost_at, updated_at) VALUES ('carol','ghost',?,?)").run(ts, ts);

    vi.setSystemTime(new Date("2026-02-05T00:00:00Z"));
    expect(ctx.titles.evaluate("carol").map((t) => t.key)).toContain("dan_days_2");
    vi.setSystemTime(new Date("2026-04-15T00:00:00Z"));
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
    expect(keys).not.toContain("co_first"); // 独りなので縁は付かない
    expect(keys).toContain("marathon_8h"); // 一度に長く居た事実は拾う
    expect(keys).toContain("cross_1");
  });

  it("状態変化で分割された滞在も1回の滞在として扱う", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T10:00:00Z"));
    ctx.vc.open("erin", "vc1", null, false, false);
    // ミュート切替で分割される（open が既存を閉じて開き直す）
    vi.setSystemTime(new Date("2026-07-01T13:00:00Z"));
    ctx.vc.open("erin", "vc1", null, true, false);
    vi.setSystemTime(new Date("2026-07-01T16:00:00Z"));
    ctx.vc.open("erin", "vc1", null, false, false);
    vi.setSystemTime(new Date("2026-07-01T19:00:00Z"));
    ctx.vc.close("erin");

    // 3時間×3本に割れているが、通しで9時間なので8時間称号が付く
    expect(ctx.titles.evaluate("erin").map((t) => t.key)).toContain("marathon_8h");
  });

  it("同席の実績から縁の称号が付く", () => {
    const t0 = Math.floor(Date.now() / 1000) - 100 * HOUR;
    for (const u of ["u1", "u2"]) {
      ctx.db
        .prepare("INSERT INTO vc_segments (user_id, channel_id, started_at, ended_at) VALUES (?,'vc:1',?,?)")
        .run(u, t0, t0 + 12 * HOUR);
    }
    ctx.vc.rebuildCompanions();
    const keys = ctx.titles.evaluate("u1").map((t) => t.key);
    expect(keys).toContain("co_first");
    expect(keys).toContain("buddy_10h");
    expect(keys).not.toContain("buddy_50h");
  });

  it("段位は跨いだぶんだけまとめて付く", () => {
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

  it("動的生成の部屋を渡り歩くだけでは探索称号が取れない", () => {
    const t0 = Math.floor(Date.now() / 1000) - 100 * HOUR;
    // 12個の宿を開いて回っただけ
    for (let i = 0; i < 12; i++) {
      ctx.db
        .prepare(
          "INSERT INTO rooms (kind, channel_id, owner_id, status, created_at, updated_at) VALUES ('normal', ?, 'u1', 'closed', 0, 0)",
        )
        .run(`room${i}`);
      ctx.db
        .prepare("INSERT INTO vc_segments (user_id, channel_id, started_at, ended_at) VALUES ('u1',?,?,?)")
        .run(`room${i}`, t0 + i * 3600, t0 + i * 3600 + 600);
    }
    expect(ctx.titles.evaluate("u1").map((t) => t.key)).not.toContain("explorer_10");

    // 常設VCを10種類回れば付く
    for (let i = 0; i < 10; i++) {
      ctx.db
        .prepare("INSERT INTO vc_segments (user_id, channel_id, started_at, ended_at) VALUES ('u1',?,?,?)")
        .run(`vc:hall${i}`, t0 + 50 * 3600 + i * 3600, t0 + 50 * 3600 + i * 3600 + 600);
    }
    expect(ctx.titles.evaluate("u1").map((t) => t.key)).toContain("explorer_10");
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

describe("旧称号キーの引き継ぎ（ロールバック耐性）", () => {
  const LEGACY = ["recruiter", "recruiter_gold", "matchmaker", "innkeeper", "veteran", "elder"];

  function withLegacy(keys: string[] = LEGACY) {
    const db = openDb(":memory:");
    keys.forEach((key, i) => {
      db.prepare("INSERT INTO titles (user_id, title_key, granted_at) VALUES ('u1', ?, ?)").run(key, 100 + i);
    });
    return db;
  }

  it("旧行を残したまま新キー行を足す（旧コードへ戻しても表示が欠落しない）", () => {
    const db = withLegacy();
    new TitleEngine(db, new VcTracker(db));

    const rows = db.prepare("SELECT title_key FROM titles WHERE user_id = 'u1'").all() as Array<{
      title_key: string;
    }>;
    const stored = rows.map((r) => r.title_key);
    // 旧キーは消さない
    for (const legacy of LEGACY) expect(stored, `${legacy} が消えている`).toContain(legacy);
    // 新キーが増えている
    expect(stored).toEqual(
      expect.arrayContaining(["recruiter_1", "recruiter_5", "dan_room_2", "dan_days_2", "dan_days_3"]),
    );
  });

  it("獲得時刻を引き継ぐ", () => {
    const db = withLegacy(["veteran"]);
    new TitleEngine(db, new VcTracker(db));
    const row = db
      .prepare("SELECT granted_at FROM titles WHERE user_id = 'u1' AND title_key = 'dan_days_2'")
      .get() as { granted_at: number };
    expect(row.granted_at).toBe(100); // 旧行と同じ
  });

  it("新コードから見ると新キー1件に潰れて見える", () => {
    const db = withLegacy();
    const titles = new TitleEngine(db, new VcTracker(db));
    const keys = titles.list("u1").map((t) => t.key);

    expect(keys).toEqual(
      expect.arrayContaining(["recruiter_1", "recruiter_5", "dan_room_2", "dan_days_2", "dan_days_3"]),
    );
    expect(keys).not.toContain("recruiter"); // 旧キーとしては見えない
    expect(new Set(keys).size).toBe(keys.length); // 重複なし
    expect(keys).toHaveLength(LEGACY.length);
  });

  it("移行は何度走らせても同じ結果になる", () => {
    const db = withLegacy();
    new TitleEngine(db, new VcTracker(db));
    const after1 = db
      .prepare("SELECT title_key, granted_at FROM titles WHERE user_id='u1' ORDER BY title_key")
      .all();
    new TitleEngine(db, new VcTracker(db));
    new TitleEngine(db, new VcTracker(db));
    const after3 = db
      .prepare("SELECT title_key, granted_at FROM titles WHERE user_id='u1' ORDER BY title_key")
      .all();
    expect(after3).toEqual(after1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM title_key_migrations").get()).toEqual({ n: LEGACY.length });
  });

  it("新旧どちらも持っていても重複せず、古い方の獲得時刻を採る", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO titles (user_id, title_key, granted_at) VALUES ('u1','recruiter',100)").run();
    db.prepare("INSERT INTO titles (user_id, title_key, granted_at) VALUES ('u1','recruiter_1',500)").run();
    const titles = new TitleEngine(db, new VcTracker(db));
    const entries = titles.list("u1").filter((t) => t.key === "recruiter_1");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.granted_at).toBe(100);
  });

  it("旧キーしか持たない人にも新キーの再付与が走らない", () => {
    const db = withLegacy(["veteran"]);
    const titles = new TitleEngine(db, new VcTracker(db));
    // 在城日数の実績が無くても、移行済みなので dan_days_2 は再付与対象にならない
    expect(titles.evaluate("u1").map((t) => t.key)).not.toContain("dan_days_2");
  });

  it("廃止した称号は一覧に残るが、新規付与はされない", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO titles (user_id, title_key, granted_at) VALUES ('u1','nightwalker',100)").run();
    const titles = new TitleEngine(db, new VcTracker(db));
    expect(titles.list("u1").map((t) => t.key)).toContain("nightwalker");
    expect(titles.progress("u1").owned).toBe(0); // 分子・分母とも現行ルールのみ
    expect(TITLE_RULES.map((r) => r.key)).not.toContain("nightwalker");
  });

  it("旧『月下氷人』は廃止称号として記録だけ残る（蜜月は秘匿対象）", () => {
    const db = withLegacy(["matchmaker"]);
    const titles = new TitleEngine(db, new VcTracker(db));
    const keys = titles.list("u1").map((t) => t.key);
    expect(keys).toEqual(["mitsugetsu_retired"]);
    expect(titles.progress("u1").owned).toBe(0);
    expect(TITLE_RULES.map((r) => r.key)).not.toContain("mitsugetsu_retired");
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

  it("旧キーで指定しても新キーとして扱う", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO titles (user_id, title_key, granted_at) VALUES ('u1','veteran',100)").run();
    const titles = new TitleEngine(db, new VcTracker(db));
    expect(titles.equip("u1", ["veteran"])).toEqual({ ok: true });
    expect(titles.equipped("u1").map((t) => t.key)).toEqual(["dan_days_2"]);
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

  it("廃止称号も本人が選べば掲げられる（記録として残す方針）", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO titles (user_id, title_key, granted_at) VALUES ('u1','nightwalker',100)").run();
    const titles = new TitleEngine(db, new VcTracker(db));
    expect(titles.equip("u1", ["nightwalker"])).toEqual({ ok: true });
    expect(titles.equipped("u1").map((t) => t.key)).toEqual(["nightwalker"]);
  });

  it("カタログから消えたキーを装備していても表示が壊れない", () => {
    const { db, titles } = setup();
    ownSome(db);
    db.prepare("INSERT INTO titles (user_id, title_key, granted_at) VALUES ('u1','gone_forever',999)").run();
    db.prepare(
      "INSERT INTO title_equips (user_id, slot, title_key, updated_at) VALUES ('u1', 0, 'gone_forever', 0)",
    ).run();
    // 未知キーは黙って落ち、空になれば自動選択にフォールバックする
    const equipped = titles.equipped("u1");
    expect(equipped.every((t) => t.key !== "gone_forever")).toBe(true);
    expect(equipped.length).toBeGreaterThan(0);
  });

  it("全称号を持っていてもカードに渡るのは枠数まで", () => {
    const { db, titles } = setup();
    for (const r of TITLE_RULES) {
      db.prepare("INSERT INTO titles (user_id, title_key, granted_at) VALUES ('u1', ?, 100)").run(r.key);
    }
    expect(titles.equipped("u1").length).toBeLessThanOrEqual(EQUIP_SLOTS);
  });
});
