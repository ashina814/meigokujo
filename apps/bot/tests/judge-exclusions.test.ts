import { describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
import type { Guild } from "discord.js";
import { Entry, EventLog, Evaluation, Ledger, Returns, Settings, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import type { Services } from "../src/services.js";

/**
 * `/審判` が誰を対象から外すか。
 *
 * 除外の穴は静かに壊れる。眷魔のように階級が増えたとき除外リストへ足し忘れると、
 * その階級の人を案内待ちへ「修復」してしまう。出戻りの人も、通常判定で亡霊にすると
 * 運営が戻し先を決める前に新規と同じ扱いになる。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const entryModule = import("../src/commands/entry.js");

const ROLE = { wait: "r-wait", ghost: "r-ghost", majin: "r-majin", kenma: "r-kenma", mazoku: "r-mazoku", meirei: "r-meirei" };
const VC = "vc-1";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const entry = new Entry(db, ledger, settings, events);
  const evaluation = new Evaluation(db, settings, events);
  const returns = new Returns(db, settings, events);
  for (const [k, v] of [
    ["role:queue_wait", ROLE.wait],
    ["role:ghost", ROLE.ghost],
    ["role:majin", ROLE.majin],
    ["role:kenma", ROLE.kenma],
    ["role:mazoku", ROLE.mazoku],
    ["role:meirei", ROLE.meirei],
    ["channel:session_vc", VC],
  ] as const) {
    settings.set(k, v, "test");
  }
  const services = { db, ledger, settings, events, entry, evaluation, returns } as unknown as Services;
  return { db, settings, events, entry, evaluation, returns, services };
}

/** 説明会VCに人が居る状態 */
function guildWith(members: { id: string; roles: string[] }[]): Guild {
  const cache = new Collection(
    members.map((m) => [
      m.id,
      {
        id: m.id,
        user: { bot: false },
        roles: { cache: new Collection(m.roles.map((r) => [r, { id: r }] as [string, { id: string }])) },
      },
    ] as [string, unknown]),
  );
  return {
    channels: { fetch: vi.fn(async () => ({ isVoiceBased: () => true, members: cache })) },
  } as unknown as Guild;
}

describe("/審判 の対象から外れる人", () => {
  it("眷魔ロールを持つ人は対象外で、魂も書き換えない", async () => {
    const { presentWaitersSplit } = await entryModule;
    const ctx = setup();
    // 案内待ちロールが外れ残っている眷魔（この取り合わせが「修復」の誤爆を生む）
    ctx.entry.recordJoin("u-kenma");
    ctx.entry.ghostify("u-kenma", "test");
    ctx.db.prepare("UPDATE souls SET status='kenma' WHERE user_id=?").run("u-kenma");

    const { targets } = await presentWaitersSplit(guildWith([{ id: "u-kenma", roles: [ROLE.wait, ROLE.kenma] }]), ctx.services);

    expect(targets).not.toContain("u-kenma");
    expect(ctx.entry.getSoul("u-kenma")!.status).toBe("kenma"); // waiting へ戻されていない
  });

  it("階級ロール（亡霊・魔人・眷魔・魔族・迷霊）はすべて対象外", async () => {
    const { presentWaitersSplit } = await entryModule;
    const ctx = setup();
    const ranked = [ROLE.ghost, ROLE.majin, ROLE.kenma, ROLE.mazoku, ROLE.meirei].map((role, i) => ({
      id: `u-${i}`,
      roles: [ROLE.wait, role],
    }));

    const { targets } = await presentWaitersSplit(guildWith([...ranked, { id: "u-new", roles: [ROLE.wait] }]), ctx.services);

    expect(targets).toEqual(["u-new"]);
  });

  it("出戻りの人は対象から外し、別枠で返す", async () => {
    const { presentWaitersSplit } = await entryModule;
    const ctx = setup();
    ctx.entry.recordJoin("u-back");
    ctx.entry.ghostify("u-back", "test");
    ctx.evaluation.promoteToMajin("u-back", "test");
    ctx.returns.recordDeparture("u-back");
    ctx.returns.markReturnedToWaiting("u-back", null);

    const { targets, returnees } = await presentWaitersSplit(
      guildWith([
        { id: "u-back", roles: [ROLE.wait] },
        { id: "u-new", roles: [ROLE.wait] },
      ]),
      ctx.services,
    );

    expect(targets).toEqual(["u-new"]);
    expect(returnees).toEqual(["u-back"]);
  });

  it("台帳に記録が無いまま出戻り対応で作った人も、通常判定へ流れない", async () => {
    const { presentWaitersSplit } = await entryModule;
    const ctx = setup();
    // Bot停止中に参加していた等で souls 行が無い人を、出戻り対応のために作る
    expect(ctx.entry.getSoul("u-recovered")).toBeUndefined();
    ctx.returns.createWaitingSoulForReturn("u-recovered", null, "user:staff", { note: "歴史回収" });

    expect(ctx.returns.isReturnee("u-recovered")).toBe(true);
    const { targets, returnees } = await presentWaitersSplit(guildWith([{ id: "u-recovered", roles: [ROLE.wait] }]), ctx.services);
    expect(targets).toEqual([]);
    expect(returnees).toEqual(["u-recovered"]);
  });
});
