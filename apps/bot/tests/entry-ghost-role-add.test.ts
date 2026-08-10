import { afterEach, describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
import type { Guild, GuildMember } from "discord.js";
import { Entry, EventLog, Evaluation, Ledger, Settings, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import type { Services } from "../src/services.js";
import { resetRankSyncForTesting } from "../src/rank-sync.js";

/**
 * 亡霊ロールを**手で付けただけ**で入城処理が走ってよいのはどこまでか。
 *
 * `Entry.ghostify()` は `status='ghost'` を上書きするだけでなく、評価期限と
 * 評価スナップショット（policy_version・昇格印の要求数など）を作り直す。
 * つまり魔人・眷魔・魔族・迷霊の人に亡霊ロールを足しただけで**評価前まで巻き戻る**。
 * これは「上位階級 → ghost は自動同期しない」という遷移表の規則を、reconciler の
 * 外から破ることになる。ここではその入口が塞がっていることを実DBで確かめる。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const entryModule = import("../src/commands/entry.js");

const ROLE = { ghost: "r-ghost", majin: "r-majin", kenma: "r-kenma", mazoku: "r-mazoku", meirei: "r-meirei", wait: "r-wait" };
const USER = "1463201396567441441";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const entry = new Entry(db, ledger, settings, events);
  const evaluation = new Evaluation(db, settings, events);
  for (const [key, id] of [
    ["role:ghost", ROLE.ghost],
    ["role:majin", ROLE.majin],
    ["role:kenma", ROLE.kenma],
    ["role:mazoku", ROLE.mazoku],
    ["role:meirei", ROLE.meirei],
    ["role:queue_wait", ROLE.wait],
  ] as const) {
    settings.set(key, id, "test");
  }
  const services = { db, ledger, settings, events, entry, evaluation, titles: { evaluate: vi.fn(() => []) } } as unknown as Services;
  return { db, ledger, settings, events, entry, evaluation, services };
}

/** 「ロールが1本増えた」だけの GuildMemberUpdate を作る */
function roleAdded(before: string[], addedRoleId: string): { oldMember: GuildMember; newMember: GuildMember; guild: Guild } {
  const cacheOf = (ids: string[]) => new Collection(ids.map((id) => [id, { id }] as [string, { id: string }]));
  const roleAdd = vi.fn(async () => undefined);
  const roleRemove = vi.fn(async () => undefined);
  const guild = {
    members: { fetch: vi.fn(async () => newMember) },
    client: { channels: { fetch: vi.fn(async () => null) } },
  } as unknown as Guild;
  const oldMember = { id: USER, user: { bot: false }, guild, roles: { cache: cacheOf(before) } } as unknown as GuildMember;
  const newMember = {
    id: USER,
    user: { bot: false },
    guild,
    roles: { cache: cacheOf([...before, addedRoleId]), add: roleAdd, remove: roleRemove },
    send: vi.fn(async () => undefined),
  } as unknown as GuildMember;
  return { oldMember, newMember, guild };
}

afterEach(() => {
  // ③ の debounce タイマーを持ち越さない
  resetRankSyncForTesting();
});

describe("亡霊ロールの手動付与", () => {
  for (const status of ["majin", "kenma", "mazoku", "meirei"] as const) {
    it(`${status} に亡霊ロールを足しても、status も評価スナップショットも変わらない`, async () => {
      const { handleMemberRoleUpdate } = await entryModule;
      const ctx = setup();
      // 入城済みの人を作ってから、その階級へ上げる（評価スナップショットは亡霊化時のもの）
      ctx.entry.recordJoin(USER);
      ctx.entry.ghostify(USER, "user:staff");
      ctx.db.prepare("UPDATE souls SET status = ? WHERE user_id = ?").run(status, USER);
      const before = ctx.db.prepare("SELECT * FROM souls WHERE user_id = ?").get(USER);

      const roleOf = { majin: ROLE.majin, kenma: ROLE.kenma, mazoku: ROLE.mazoku, meirei: ROLE.meirei }[status];
      const { oldMember, newMember } = roleAdded([roleOf], ROLE.ghost);
      await handleMemberRoleUpdate(oldMember, newMember, ctx.services);

      // status・評価期限・評価スナップショット・updated_at まで全て元のまま
      expect(ctx.db.prepare("SELECT * FROM souls WHERE user_id = ?").get(USER)).toEqual(before);
      // 巻き戻しを試みたことは監査に残す（黙って無視はしない）
      const logged = ctx.events.listByTarget(USER).map((e) => e.type);
      expect(logged).toContain("rank_sync_ambiguous");
      // 初期発行が二重に走っていない
      expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(30_000);
    });
  }

  it("入城前（waiting）に亡霊ロールが付いたら、従来どおり入城処理が走る", async () => {
    const { handleMemberRoleUpdate } = await entryModule;
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    expect(ctx.entry.getSoul(USER)!.status).toBe("waiting");

    const { oldMember, newMember } = roleAdded([ROLE.wait], ROLE.ghost);
    await handleMemberRoleUpdate(oldMember, newMember, ctx.services);

    const soul = ctx.entry.getSoul(USER)!;
    expect(soul.status).toBe("ghost");
    expect(soul.eval_deadline_at).not.toBeNull();
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(30_000);
  });

  it("台帳に居ない人に亡霊ロールが付いたら、従来どおり台帳を作る", async () => {
    // Bot 停止中の参加・移行前からの在籍。巻き戻す既存 status がそもそも無い
    const { handleMemberRoleUpdate } = await entryModule;
    const ctx = setup();
    expect(ctx.entry.getSoul(USER)).toBeUndefined();

    const { oldMember, newMember } = roleAdded([], ROLE.ghost);
    await handleMemberRoleUpdate(oldMember, newMember, ctx.services);

    expect(ctx.entry.getSoul(USER)!.status).toBe("ghost");
  });

  it("既に亡霊なら二重に走らない（冪等）", async () => {
    const { handleMemberRoleUpdate } = await entryModule;
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    ctx.entry.ghostify(USER, "user:staff");
    const before = ctx.db.prepare("SELECT * FROM souls WHERE user_id = ?").get(USER);

    const { oldMember, newMember } = roleAdded([], ROLE.ghost);
    await handleMemberRoleUpdate(oldMember, newMember, ctx.services);

    expect(ctx.db.prepare("SELECT * FROM souls WHERE user_id = ?").get(USER)).toEqual(before);
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(30_000);
  });
});
