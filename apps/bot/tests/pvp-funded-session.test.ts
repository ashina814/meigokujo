import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runFundedBjDuel } from "../src/casino/bj-duel.js";
import { runFundedSession } from "../src/casino/pvp-common.js";

/**
 * `runFundedSession()` の契約を固定する。
 *
 * 両者から徴収した後の本体が、精算も返金もしないまま終わる／落ちると、
 * 預り金と露出が残る。公開募集では募集カードが3分間チャンネルに晒され、
 * 削除・権限変更で `edit()` が落ちる面積が広いので、ここが最後の防波堤になる。
 */
/** voidPvpTable が実際に触るものだけを最小限で観測する */
function fakeServices(onRefund?: () => void) {
  const calls: string[] = [];
  const services = {
    chips: { runGroup: (_opts: unknown, fn: () => void) => fn() },
    escrow: {
      // voidPvpTable は pvpParticipants() 経由でこれを引く。
      // 持たせないと catch へ落ちて参加者列挙を素通りしてしまう
      list: () => [],
      refund: (session: string) => {
        onRefund?.();
        calls.push(session);
      },
    },
    dailyRisk: { releaseExposureScope: () => undefined },
    events: { log: () => undefined },
  } as never;
  return { services, calls };
}

describe("fund済みセッションは資金を取り残さない", () => {
  it("精算前に落ちたら返金して、元の例外をそのまま投げる", async () => {
    const { services, calls } = fakeServices();
    const boom = new Error("Missing Permissions");
    await expect(
      runFundedSession(services, "s1", async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(calls, "返金されていない").toContain("s1");
  });

  it("精算後に表示だけ落ちても金銭処理を巻き戻さない", async () => {
    const { services, calls } = fakeServices();
    const boom = new Error("edit failed");
    await expect(
      runFundedSession(services, "s2", async (markResolved) => {
        markResolved();
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(calls, "確定済みの勝敗を巻き戻している").not.toContain("s2");
  });

  it("markResolved を呼ばずに正常終了したら、返金して異常終了する", async () => {
    const { services, calls } = fakeServices();
    // 本体の分岐で return し忘れるパターン。金だけ残すより返して落とす
    await expect(runFundedSession(services, "s3", async () => undefined)).rejects.toThrow(
      "exited without settlement or refund",
    );
    expect(calls).toContain("s3");
  });

  it("markResolved 済みなら、静かに終わってよい", async () => {
    const { services, calls } = fakeServices();
    await expect(
      runFundedSession(services, "s4", async (markResolved) => {
        markResolved();
      }),
    ).resolves.toBeUndefined();
    expect(calls).not.toContain("s4");
  });

  it("返金自体が落ちたら、元の障害と返金障害の両方を残す", async () => {
    const boom = new Error("game blew up");
    const cleanupBoom = new Error("db unavailable");
    const { services } = fakeServices(() => {
      throw cleanupBoom;
    });

    const err = await runFundedSession(services, "s5", async () => {
      throw boom;
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors).toEqual([boom, cleanupBoom]);
  });
});

describe("二重障害はどちらの入口でも両方残す", () => {
  it("markResolved 忘れと返金失敗が重なっても、契約違反が消えない", async () => {
    const cleanupBoom = new Error("db unavailable");
    const services = {
      chips: { runGroup: (_opts: unknown, fn: () => void) => fn() },
      escrow: {
        list: () => [],
        refund: () => {
          throw cleanupBoom;
        },
      },
      dailyRisk: { releaseExposureScope: () => undefined },
      events: { log: () => undefined },
    } as never;

    const err = await runFundedSession(services, "s6", async () => undefined).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AggregateError);
    const errors = (err as AggregateError).errors as Error[];
    expect(errors).toHaveLength(2);
    expect(errors[0]?.message, "契約違反そのものが消えている").toContain("exited without settlement or refund");
    expect(errors[1]).toBe(cleanupBoom);
  });
});

describe("fund済み後の盤面取得は保護区間の内側にある", () => {
  it("runFundedBjDuel の view.message() が実際に落ちても返金される", async () => {
    // 以前のテストは runFundedSession に直接 throw を渡しただけで、BJ 本体を通っていなかった。
    // 実際の runner を通し、最初の view.message() が落ちたときに同じ session が void されることを固定する。
    const { services, calls } = fakeServices();
    const boom = new Error("Unknown Message");
    const view = {
      edit: async () => undefined,
      followUp: async () => undefined,
      message: async () => {
        throw boom;
      },
    } as never;

    await expect(
      runFundedBjDuel(services, {
        challenger: { id: "alice" } as never,
        opponent: { id: "bob" } as never,
        bet: 500,
        session: "s7",
        view,
      }),
    ).rejects.toBe(boom);
    expect(calls, "BJ本体の盤面取得失敗で資金が残っている").toContain("s7");
  });

  it("対話型の本体は message() を保護区間の内側で呼ぶ", () => {
    for (const file of ["bj-duel", "indian"]) {
      const source = readFileSync(new URL(`../src/casino/${file}.ts`, import.meta.url), "utf8");
      const sessionAt = source.indexOf("await runFundedSession(");
      const messageAt = source.indexOf("await view.message()");
      expect(sessionAt, `${file}: runFundedSession が無い`).toBeGreaterThan(-1);
      expect(messageAt, `${file}: view.message() が無い`).toBeGreaterThan(-1);
      expect(messageAt, `${file}: view.message() が保護区間の外`).toBeGreaterThan(sessionAt);
    }
  });

  it("指名導線は fund 後に fetchReply をやり直さない", () => {
    for (const file of ["bj-duel", "indian"]) {
      const source = readFileSync(new URL(`../src/casino/${file}.ts`, import.meta.url), "utf8");
      // 受諾待ちで取得済みの reply を factory へ渡し、余計な Discord API を叩かない
      expect(source, `${file}: 取得済み reply を再利用していない`).toContain(
        "pvpViewFromInteraction(interaction, reply)",
      );
    }
  });
});

describe("インディアンは DM 失敗で再戦を出さない", () => {
  it("返金はするが、再戦オファーの手前で抜ける", () => {
    const source = readFileSync(new URL("../src/casino/indian.ts", import.meta.url), "utf8");
    // 切り出し前は playIndian ごと return していたので offerRematch へ到達しなかった。
    // callback の return はセッションを抜けるだけなので、明示的に止める必要がある
    expect(source).toContain("rematchEligible = false;");
    expect(source).toContain("if (!rematchEligible || !rematchInteraction) return;");
  });
});
