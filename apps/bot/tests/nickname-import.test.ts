import { describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
import type { Guild, GuildMember } from "discord.js";
import { Entry, EventLog, Evaluation, Ledger, Nicknames, Settings, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import type { Services } from "../src/services.js";

/**
 * 既存の名前の取り込み。
 *
 * - **誰も改名しない**（Discord 側には触らない）
 * - **入城済みの名前はそこで確定している**ので固定して取り込む。
 *   未固定のまま入れると、入城済みの人だけ入城パネルから名前を変えられてしまう
 * - ニックネーム未設定は取り込まない（本人が城で名乗ると決めた名前ではない）
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const importModule = import("../src/nickname-import.js");

const ROLE = { ghost: "r-ghost", majin: "r-majin", kenma: "r-kenma", mazoku: "r-mazoku", meirei: "r-meirei", wait: "r-wait" };

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const entry = new Entry(db, ledger, settings, events);
  const evaluation = new Evaluation(db, settings, events);
  const nicknames = new Nicknames(db, events);
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
  const services = { db, ledger, settings, events, entry, evaluation, nicknames } as unknown as Services;
  return { db, settings, events, entry, nicknames, services };
}

type Person = { id: string; nickname: string | null; roles: string[]; bot?: boolean };

function guildOf(people: Person[]): Guild {
  const members = new Collection(
    people.map((p) => [
      p.id,
      {
        id: p.id,
        nickname: p.nickname,
        user: { bot: p.bot === true },
        roles: { cache: new Collection(p.roles.map((r) => [r, { id: r }])) },
      } as unknown as GuildMember,
    ]),
  );
  return { id: "g1", members: { fetch: vi.fn(async () => members) } } as unknown as Guild;
}

describe("取り込み対象の切り分け", () => {
  const people: Person[] = [
    { id: "1", nickname: "にゅうじょう", roles: [ROLE.ghost] }, // 入城済み
    { id: "2", nickname: "めいれい", roles: [ROLE.meirei] }, // 入城済み（迷霊）
    { id: "3", nickname: "まちびと", roles: [ROLE.wait] }, // 案内待ち
    { id: "4", nickname: "うんえい", roles: [] }, // その他（運営など）
    { id: "5", nickname: null, roles: [ROLE.ghost] }, // 入城済みだが未設定
    { id: "6", nickname: null, roles: [ROLE.wait] }, // 案内待ちで未設定
    { id: "7", nickname: "ぼっと", roles: [], bot: true }, // Bot は対象外
  ];

  it("入城済みと運営は固定、案内待ちだけ未固定で拾う", async () => {
    const { collectGuildNames } = await importModule;
    const ctx = setup();

    const entries = await collectGuildNames(guildOf(people), ctx.services);

    expect(entries.map((e) => e.userId).sort()).toEqual(["1", "2", "3", "4"]); // 未設定とBotは入らない
    const locked = Object.fromEntries(entries.map((e) => [e.userId, e.locked]));
    expect(locked).toEqual({ "1": true, "2": true, "3": false, "4": true });
    ctx.db.close();
  });

  it("**プレビューの人数と実際に書く人数が一致する**", async () => {
    const { collectGuildNames, previewLegacyImport } = await importModule;
    const ctx = setup();
    const guild = guildOf(people);

    const preview = await previewLegacyImport(guild, ctx.services);
    const result = ctx.nicknames.importLegacy(await collectGuildNames(guild, ctx.services), "staff");

    expect(preview.newlyImportable).toBe(4);
    expect(result.imported + result.conflicted).toBe(preview.newlyImportable);
    expect(preview.byGroup).toEqual({ entered: 2, waiting: 1, other: 1 });
    expect(preview.unsetByGroup).toEqual({ entered: 1, waiting: 1, other: 0 });
    expect(result.locked).toBe(3); // 入城済み2 + 運営1
    ctx.db.close();
  });

  it("台帳が入城済みならロールが落ちていても固定する", async () => {
    const { collectGuildNames } = await importModule;
    const ctx = setup();
    ctx.entry.recordJoin("8");
    ctx.entry.ghostify("8", "staff"); // 台帳は ghost、ロールは無い
    const guild = guildOf([{ id: "8", nickname: "ろーるおち", roles: [] }]);

    const entries = await collectGuildNames(guild, ctx.services);

    expect(entries[0]!.locked).toBe(true);
    ctx.db.close();
  });

  it("取り込んだ入城済みの人は、入城パネルから名前を変えられない", async () => {
    const { collectGuildNames } = await importModule;
    const ctx = setup();
    const guild = guildOf(people);
    ctx.nicknames.importLegacy(await collectGuildNames(guild, ctx.services), "staff");

    expect(ctx.nicknames.get("1")?.locked_at).not.toBeNull();
    expect(ctx.nicknames.claim({ userId: "1", nickname: "べつめい", setVia: "entry", actor: "t" }).ok).toBe(false);
    // 案内待ちの人はまだ直せる
    expect(ctx.nicknames.get("3")?.locked_at).toBeNull();
    expect(ctx.nicknames.claim({ userId: "3", nickname: "なおした", setVia: "entry", actor: "t" }).ok).toBe(true);
    ctx.db.close();
  });

  it("何度実行しても同じ結果になる", async () => {
    const { collectGuildNames } = await importModule;
    const ctx = setup();
    const guild = guildOf(people);
    ctx.nicknames.importLegacy(await collectGuildNames(guild, ctx.services), "staff");
    const again = ctx.nicknames.importLegacy(await collectGuildNames(guild, ctx.services), "staff");

    expect(again.imported).toBe(0);
    expect(again.skipped).toBe(4);
    ctx.db.close();
  });
});
