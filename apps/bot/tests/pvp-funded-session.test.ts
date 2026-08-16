import { describe, expect, it } from "vitest";
import { runFundedSession } from "../src/casino/pvp-common.js";

/**
 * `runFundedSession()` の契約を固定する。
 *
 * 両者から徴収した後の本体が、精算も返金もしないまま終わる／落ちると、
 * 預り金と露出が残る。公開募集では募集カードが3分間チャンネルに晒され、
 * 削除・権限変更で `edit()` が落ちる面積が広いので、ここが最後の防波堤になる。
 */
describe("fund済みセッションは資金を取り残さない", () => {
  /** voidPvpTable が実際に触るものだけを最小限で観測する */
  function fakeServices(onRefund?: () => void) {
    const calls: string[] = [];
    const services = {
      chips: { runGroup: (_opts: unknown, fn: () => void) => fn() },
      escrow: {
        refund: (session: string) => {
          onRefund?.();
          calls.push(session);
        },
        listParticipants: () => [],
      },
      dailyRisk: { releaseExposureScope: () => undefined },
      events: { log: () => undefined },
    } as never;
    return { services, calls };
  }

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
