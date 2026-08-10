import { describe, expect, it, vi } from "vitest";
import type { Guild } from "discord.js";
import type { Services } from "../src/services.js";
import { reconcileMemberRank, resetRankSyncForTesting } from "../src/rank-sync.js";

/**
 * 階級再判定の統合部分。
 *
 * イベントに付いてきた途中状態ではなく、**再fetchした最終ロール**から判定することと、
 * DBを書くのは許可された遷移だけであることを押さえる。
 */

const ROLE = { ghost: "r-ghost", majin: "r-majin", kenma: "r-kenma", mazoku: "r-mazoku", meirei: "r-meirei" };

function world(opts: { roles: string[]; status?: string | null; syncOk?: boolean }) {
  const syncStatusFromRoles = vi.fn(() => opts.syncOk !== false);
  const log = vi.fn();
  const services = {
    settings: {
      getString: vi.fn((key: string) =>
        ({
          "role:ghost": ROLE.ghost,
          "role:majin": ROLE.majin,
          "role:kenma": ROLE.kenma,
          "role:mazoku": ROLE.mazoku,
          "role:meirei": ROLE.meirei,
        })[key],
      ),
    },
    entry: { getSoul: vi.fn(() => (opts.status === null ? undefined : { status: opts.status ?? "majin" })) },
    evaluation: { syncStatusFromRoles },
    events: { log },
  } as unknown as Services;

  const member = {
    id: "u1",
    user: { bot: false },
    roles: { cache: new Map(opts.roles.map((r) => [r, { id: r }])) },
  };
  const guild = { members: { fetch: vi.fn(async () => member) } } as unknown as Guild;
  return { guild, services, syncStatusFromRoles, log, memberFetch: guild.members.fetch as ReturnType<typeof vi.fn> };
}

describe("階級の再判定", () => {
  it("イベントではなく、取り直した最終ロールで判定する", async () => {
    const { guild, services, memberFetch } = world({ roles: [ROLE.kenma], status: "majin" });

    await reconcileMemberRank(guild, services, "u1", "test");

    // 途中状態を信じず、必ず現在のロールを取り直す
    expect(memberFetch).toHaveBeenCalledWith(expect.objectContaining({ user: "u1", force: true }));
  });

  it("横移動（魔人→眷魔）はDBへ反映する", async () => {
    const { guild, services, syncStatusFromRoles } = world({ roles: [ROLE.kenma], status: "majin" });

    const outcome = await reconcileMemberRank(guild, services, "u1", "test");

    expect(outcome).toMatchObject({ kind: "update", from: "majin", to: "kenma" });
    expect(syncStatusFromRoles).toHaveBeenCalledWith("u1", "majin", "kenma", "test", expect.anything());
  });

  it("既に一致していれば何も書かない（Bot自身の操作で発火しても安全）", async () => {
    const { guild, services, syncStatusFromRoles } = world({ roles: [ROLE.majin], status: "majin" });

    const outcome = await reconcileMemberRank(guild, services, "u1", "test");

    expect(outcome.kind).toBe("noop");
    expect(syncStatusFromRoles).not.toHaveBeenCalled();
  });

  it("階級ロールが全部消えてもDBを触らず、監査イベントだけ残す", async () => {
    const { guild, services, syncStatusFromRoles, log } = world({ roles: [], status: "kenma" });

    const outcome = await reconcileMemberRank(guild, services, "u1", "test");

    expect(outcome).toMatchObject({ kind: "ambiguous", detail: "no_rank_role" });
    expect(syncStatusFromRoles).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("rank_sync_ambiguous", expect.objectContaining({ target: "u1" }));
  });

  it("入城処理を迂回する遷移は書かずに記録する", async () => {
    const { guild, services, syncStatusFromRoles, log } = world({ roles: [ROLE.mazoku], status: "waiting" });

    const outcome = await reconcileMemberRank(guild, services, "u1", "test");

    expect(outcome.kind).toBe("ambiguous");
    expect(syncStatusFromRoles).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("rank_sync_ambiguous", expect.anything());
  });

  it("魂の記録が無い相手には階級を作らない", async () => {
    const { guild, services, syncStatusFromRoles } = world({ roles: [ROLE.majin], status: null });

    const outcome = await reconcileMemberRank(guild, services, "u1", "test");

    expect(outcome.kind).toBe("no_soul");
    expect(syncStatusFromRoles).not.toHaveBeenCalled();
  });

  it("迷霊と通常階級の同居は、迷霊にしつつ構成異常を記録する", async () => {
    const { guild, services, log } = world({ roles: [ROLE.mazoku, ROLE.meirei], status: "mazoku" });

    const outcome = await reconcileMemberRank(guild, services, "u1", "test");

    expect(outcome).toMatchObject({ kind: "update", to: "meirei" });
    expect(log).toHaveBeenCalledWith("rank_sync_role_anomaly", expect.objectContaining({ target: "u1" }));
  });

  it("既に一致していても、ロール構成の異常は記録する（DB眷魔 + ロール魔人/眷魔）", async () => {
    // status は合っているので何も書かないが、通常階級が2つ付いたまま放置されている
    const { guild, services, syncStatusFromRoles, log } = world({ roles: [ROLE.majin, ROLE.kenma], status: "kenma" });

    const outcome = await reconcileMemberRank(guild, services, "u1", "test");

    expect(outcome.kind).toBe("noop");
    expect(syncStatusFromRoles).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "rank_sync_role_anomaly",
      expect.objectContaining({ payload: expect.objectContaining({ anomaly: "multiple_ladder_roles:majin+kenma" }) }),
    );
  });

  it("DB迷霊 + ロール迷霊/魔族が一致していても記録する", async () => {
    const { guild, services, syncStatusFromRoles, log } = world({ roles: [ROLE.mazoku, ROLE.meirei], status: "meirei" });

    const outcome = await reconcileMemberRank(guild, services, "u1", "test");

    expect(outcome.kind).toBe("noop");
    expect(syncStatusFromRoles).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "rank_sync_role_anomaly",
      expect.objectContaining({ payload: expect.objectContaining({ anomaly: "meirei_with_ladder:mazoku" }) }),
    );
  });

  it("自動同期を禁じた遷移でも、ロール構成の異常は記録する", async () => {
    // waiting からは階級を生やさない（ambiguous）。それとは別に迷霊と魔族が同居している
    const { guild, services, syncStatusFromRoles, log } = world({ roles: [ROLE.mazoku, ROLE.meirei], status: "waiting" });

    const outcome = await reconcileMemberRank(guild, services, "u1", "test");

    expect(outcome.kind).toBe("ambiguous");
    expect(syncStatusFromRoles).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "rank_sync_role_anomaly",
      expect.objectContaining({ payload: expect.objectContaining({ anomaly: "meirei_with_ladder:mazoku" }) }),
    );
  });

  it("剥がし漏れの階級ロールは全部ペイロードに書き出す（どれを外せばよいか分かる）", async () => {
    // 亡霊・魔人・眷魔が残ったまま迷霊が付いている。最上位は眷魔だが迷霊を採る
    const { guild, services, log } = world({ roles: [ROLE.ghost, ROLE.majin, ROLE.kenma, ROLE.meirei], status: "meirei" });

    const outcome = await reconcileMemberRank(guild, services, "u1", "test");

    expect(outcome.kind).toBe("noop");
    const anomalies = log.mock.calls
      .filter(([type]) => type === "rank_sync_role_anomaly")
      .map(([, opts]) => (opts as { payload: { anomaly: string } }).payload.anomaly);
    expect(anomalies).toContain("meirei_with_ladder:ghost+majin+kenma");
  });

  it("判定後に別経路が階級を動かしていたら書き込まない（stale）", async () => {
    // syncStatusFromRoles が false = WHERE 条件に合わず0行更新だった
    const { guild, services } = world({ roles: [ROLE.kenma], status: "majin", syncOk: false });

    const outcome = await reconcileMemberRank(guild, services, "u1", "test");

    expect(outcome).toMatchObject({ kind: "noop", detail: "stale_precondition" });
  });

  it("ロールの並び順が違っても同じ結論になる（イベント順に依存しない）", async () => {
    resetRankSyncForTesting();
    // 「魔人を付けたが亡霊がまだ残っている」途中状態。並び順を変えても結論は同じ
    const forward = world({ roles: [ROLE.ghost, ROLE.majin], status: "kenma" });
    const reversed = world({ roles: [ROLE.majin, ROLE.ghost], status: "kenma" });

    const a = await reconcileMemberRank(forward.guild, forward.services, "u1", "t");
    const b = await reconcileMemberRank(reversed.guild, reversed.services, "u1", "t");

    // どちらも「最上位=魔人」と読み、眷魔→魔人の横移動として同じ結果になる
    expect(a).toEqual(b);
    expect(a).toMatchObject({ kind: "update", from: "kenma", to: "majin" });
  });
});
