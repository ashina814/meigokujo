import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CasinoParticipationHistory, openDb } from "@meigokujo/core";
import type { Services } from "../src/services.js";
import { runFundedSession, voidPvpTable } from "../src/casino/pvp-common.js";

/**
 * PR F2b: casino completion writer（`recordCasinoCompletionBestEffort`）の
 * production callsite監査。
 *
 * `casino_activity_days`が証明する「successful funded participation
 * commitment」と、`casino_completed_activity_days`が証明する「そのゲーム固有の
 * canonical financial resolution primitiveが成功した」ことは別事実——本fileは
 * その分離が実際のproduction codeで正しく成立していることを検証する。
 *
 * 最重要回帰（§8-1）: commitment成立→settlement失敗/abnormal void→
 * participation=1・completion=0。これはPVP全ゲーム共通の土台である
 * `pvp-common.ts`の`runFundedSession()`契約が守る——ここでは各ゲームの
 * card/dice等のgame logicを再実装せず、`runFundedSession`/`voidPvpTable`という
 * 実際の共有primitiveを直接使い、この契約そのものを機能テストで固定する。
 * 各ゲームファイル自身の「settlement呼び出し→completion呼び出し」の相対位置は
 * source-order検証（casino-metrics-slots-structure.test.tsと同じ手法）で
 * 別途固定する。
 */

function realServices() {
  const db = openDb(":memory:");
  const casinoParticipation = new CasinoParticipationHistory(db);
  const services = {
    db,
    casinoParticipation,
    escrow: { refund: () => undefined },
    dailyRisk: { releaseExposureScope: () => undefined },
    chips: { runGroup: (_opts: unknown, fn: () => unknown) => fn() },
  } as unknown as Services;
  return { services, db, casinoParticipation };
}

function commitmentRows(db: ReturnType<typeof openDb>) {
  return db.prepare(`SELECT activity_key FROM casino_participations`).all() as Array<{ activity_key: string }>;
}

function completionRows(db: ReturnType<typeof openDb>) {
  return db
    .prepare(
      `SELECT p.activity_key AS activity_key FROM casino_participation_completions c
         JOIN casino_participations p
           ON p.participation_key = c.participation_key AND p.user_id = c.user_id`,
    )
    .all() as Array<{ activity_key: string }>;
}

describe("pvp-common.ts runFundedSession(): §8-1 commitment成立→settlement失敗/abnormal void→completion 0", () => {
  it("callbackがsettlement前に投げるとcompletionは書かれず、voidPvpTable相当のcleanupが走る（例外はrethrowされる）", async () => {
    const { services, db, casinoParticipation } = realServices();
    const session = "pvp:test-fail";
    casinoParticipation.recordCommittedParticipation({
      participationKey: `pvp:${session}`,
      activityKey: "blackjack",
      participantUserIds: ["alice", "bob"],
    });
    expect(commitmentRows(db)).toHaveLength(2);

    await expect(
      runFundedSession(services, session, async (_markResolved) => {
        // 本番の各PVPゲームと同じ構造: settlement primitive呼び出しがthrowし、
        // completion writerへは到達しない。
        throw new Error("simulated settlement failure");
      }),
    ).rejects.toThrow(/simulated settlement failure/);

    // commitmentは既存のまま残る（immutable evidence store）が、completionは0件。
    expect(commitmentRows(db)).toHaveLength(2);
    expect(completionRows(db)).toHaveLength(0);
  });

  it("callbackがmarkResolved()を呼ばずに正常returnした場合も強制cleanupされ、completionは0（実装漏れの安全側）", async () => {
    const { services, db, casinoParticipation } = realServices();
    const session = "pvp:test-unresolved";
    casinoParticipation.recordCommittedParticipation({
      participationKey: `pvp:${session}`,
      activityKey: "sashi",
      participantUserIds: ["alice", "bob"],
    });

    await expect(
      runFundedSession(services, session, async (_markResolved) => {
        // markResolved()を呼び忘れて静かに抜ける契約違反
      }),
    ).rejects.toThrow(/exited without settlement or refund/);

    expect(completionRows(db)).toHaveLength(0);
  });
});

describe("pvp-common.ts runFundedSession(): §8-2 settlement成功→その後のUI失敗でもcompletionは1のまま", () => {
  it("callbackがcompletion write→markResolved()の後にthrowしても、既に書かれたcompletionはrollbackされない", async () => {
    const { services, db, casinoParticipation } = realServices();
    const session = "pvp:test-ui-fail";
    casinoParticipation.recordCommittedParticipation({
      participationKey: `pvp:${session}`,
      activityKey: "indian",
      participantUserIds: ["alice", "bob"],
    });

    await expect(
      runFundedSession(services, session, async (markResolved) => {
        // 本番同様: settlement primitive成功 → completion write → markResolved() → UI edit
        casinoParticipation.recordCompletedParticipation({
          participationKey: `pvp:${session}`,
          activityKey: "indian",
          participantUserIds: ["alice", "bob"],
        });
        markResolved();
        throw new Error("simulated Discord UI edit failure (post-settlement)");
      }),
    ).rejects.toThrow(/simulated Discord UI edit failure/);

    // markResolved()済みなのでcleanupUnresolvedFundedSessionは何もしない
    // （resolved=trueでno-op）——completionは書かれたまま残る。
    expect(completionRows(db)).toEqual([{ activity_key: "indian" }, { activity_key: "indian" }]);
  });
});

describe("voidPvpTable()（異常系）はcompletionを一切書かない", () => {
  it("voidPvpTable呼び出し自体はcasino_participation_completionsへ触れない", () => {
    const { services, db, casinoParticipation } = realServices();
    const session = "pvp:test-void";
    casinoParticipation.recordCommittedParticipation({
      participationKey: `pvp:${session}`,
      activityKey: "chinchiro",
      participantUserIds: ["alice", "bob"],
    });
    // pvpParticipants等はここでは0件想定のfake services——voidPvpTable自体の
    // completion非関与を確認するのが目的（実際の返金ロジックはpvp-common.test相当で別途担保）。
    expect(() => voidPvpTable(services, session)).not.toThrow();
    expect(completionRows(db)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// production callsite source-order監査（§8監査表の裏付け）
// ─────────────────────────────────────────────────────────────

function readSource(file: string): string {
  return readFileSync(new URL(`../src/casino/${file}.ts`, import.meta.url), "utf8");
}

describe("PVP named-invite（bj-duel/chinchiro-duel/sashi/indian）: settlement primitiveの直後にcompletionを書く", () => {
  it("bj-duel.ts: push分岐（refundAll直後）と win/loss分岐（settlePvp直後）の両方にcompletionがある", () => {
    const source = readSource("bj-duel");
    const pushRefundAt = source.indexOf(`refundAll(services, [challenger.id, opponent.id], bet, \`${"${session}"}:refund:push\`, session);`);
    expect(pushRefundAt, "push refundAllが無い").toBeGreaterThanOrEqual(0);
    const pushCompleteAt = source.indexOf("recordCasinoCompletionBestEffort(services, {", pushRefundAt);
    const pushMarkResolvedAt = source.indexOf("markResolved();", pushRefundAt);
    expect(pushCompleteAt).toBeGreaterThan(pushRefundAt);
    expect(pushCompleteAt).toBeLessThan(pushMarkResolvedAt);

    const settleAt = source.indexOf("settlePvp(services, [winnerId], bet * 2,");
    expect(settleAt, "settlePvpが無い").toBeGreaterThanOrEqual(0);
    const settleCompleteAt = source.indexOf("recordCasinoCompletionBestEffort(services, {", settleAt);
    const settleMarkResolvedAt = source.indexOf("markResolved();", settleAt);
    expect(settleCompleteAt).toBeGreaterThan(settleAt);
    expect(settleCompleteAt).toBeLessThan(settleMarkResolvedAt);
  });

  it("chinchiro-duel.ts: 引き分け分岐（refundAll直後）とwin分岐（settlePvp直後）の両方にcompletionがある", () => {
    const source = readSource("chinchiro-duel");
    const drawRefundAt = source.indexOf(`\`${"${session}"}:refund:draw\``);
    expect(drawRefundAt, "draw refundAllが無い").toBeGreaterThanOrEqual(0);
    const drawCompleteAt = source.indexOf("recordCasinoCompletionBestEffort(services, {", drawRefundAt);
    const drawMarkResolvedAt = source.indexOf("markResolved();", drawRefundAt);
    expect(drawCompleteAt).toBeGreaterThan(drawRefundAt);
    expect(drawCompleteAt).toBeLessThan(drawMarkResolvedAt);

    const settleAt = source.indexOf("settlePvp(");
    const settleCompleteAt = source.indexOf("recordCasinoCompletionBestEffort(services, {", settleAt);
    const settleMarkResolvedAt = source.indexOf("markResolved();", settleAt);
    expect(settleCompleteAt).toBeGreaterThan(settleAt);
    expect(settleCompleteAt).toBeLessThan(settleMarkResolvedAt);
  });

  it("sashi.ts: settlePvp直後にcompletionがある（push/drawの無い単一終端）", () => {
    const source = readSource("sashi");
    const settleAt = source.indexOf("settlePvp(services, [winnerId], bet * 2,");
    expect(settleAt).toBeGreaterThanOrEqual(0);
    const completeAt = source.indexOf("recordCasinoCompletionBestEffort(services, {", settleAt);
    const markResolvedAt = source.indexOf("markResolved();", settleAt);
    expect(completeAt).toBeGreaterThan(settleAt);
    expect(completeAt).toBeLessThan(markResolvedAt);
  });

  it("indian.ts: DM失敗abort（refundAll直後）にはcompletionが無く、both-fold/draw/winの3分岐にはある", () => {
    const source = readSource("indian");
    const dmFailedRefundAt = source.indexOf("refund:dm_failed");
    const dmFailedMarkResolvedAt = source.indexOf("markResolved();", dmFailedRefundAt);
    const between = source.slice(dmFailedRefundAt, dmFailedMarkResolvedAt);
    expect(between, "DM失敗abortにcompletionが書かれている（あってはならない）").not.toContain(
      "recordCasinoCompletionBestEffort(",
    );

    for (const needle of ["refund:both_fold", "refund:draw"]) {
      const refundAt = source.indexOf(needle);
      expect(refundAt, `${needle}が無い`).toBeGreaterThanOrEqual(0);
      const completeAt = source.indexOf("recordCasinoCompletionBestEffort(services, {", refundAt);
      const markResolvedAt = source.indexOf("markResolved();", refundAt);
      expect(completeAt, `${needle}後にcompletionが無い`).toBeGreaterThan(refundAt);
      expect(completeAt).toBeLessThan(markResolvedAt);
    }

    const settleAt = source.indexOf("settlePvp(services, [winner], pot,");
    expect(settleAt).toBeGreaterThanOrEqual(0);
    const settleCompleteAt = source.indexOf("recordCasinoCompletionBestEffort(services, {", settleAt);
    const settleMarkResolvedAt = source.indexOf("markResolved();", settleAt);
    expect(settleCompleteAt).toBeGreaterThan(settleAt);
    expect(settleCompleteAt).toBeLessThan(settleMarkResolvedAt);
  });
});

describe("poker-duel.ts: settlePvp/settleProportional直後・postResult前にcompletionがある", () => {
  it("単独勝者branch: settlePvp → recordPokerDuelCompletion → postResult", () => {
    const source = readSource("poker-duel");
    const settleAt = source.indexOf("settlePvp(services, [w.userId],");
    expect(settleAt).toBeGreaterThanOrEqual(0);
    const completeAt = source.indexOf("recordPokerDuelCompletion(services, s);", settleAt);
    const postResultAt = source.indexOf("await postResult(client, s, entries, winners, houseCut);", settleAt);
    expect(completeAt).toBeGreaterThan(settleAt);
    expect(completeAt).toBeLessThan(postResultAt);
  });

  it("比例配分branch: settleProportional → recordPokerDuelCompletion → postResult", () => {
    const source = readSource("poker-duel");
    const settleAt = source.indexOf("settleProportional(");
    expect(settleAt).toBeGreaterThanOrEqual(0);
    const completeAt = source.indexOf("recordPokerDuelCompletion(services, s);", settleAt);
    const postResultAt = source.indexOf("await postResult(client, s, entries, winners, totalHouseCut);", settleAt);
    expect(completeAt).toBeGreaterThan(settleAt);
    expect(completeAt).toBeLessThan(postResultAt);
  });
});

describe("chohan-multi.ts: settleProportional直後・結果embed編集前にcompletionがある", () => {
  it("settleProportional → recordCasinoCompletionBestEffort の順、かつ「中断」try/catchの外（settlement成功パスのみ）", () => {
    const source = readSource("chohan-multi");
    const settleAt = source.indexOf("const { totalHouseCut } = settleProportional(");
    expect(settleAt).toBeGreaterThanOrEqual(0);
    const completeAt = source.indexOf("recordCasinoCompletionBestEffort(services, {", settleAt);
    expect(completeAt).toBeGreaterThan(settleAt);

    // 「中断」catchブロック（voidPvpTable呼び出し）にはcompletionが無いこと
    const catchAt = source.indexOf("異常終了・全額返金");
    const catchVoidAt = source.indexOf("voidPvpTable(services, session);", catchAt);
    const catchEndAt = source.indexOf("return;", catchVoidAt);
    const catchBody = source.slice(catchAt, catchEndAt);
    expect(catchBody).not.toContain("recordCasinoCompletionBestEffort(");
  });
});

describe("roulette.ts: settleRoulette成功直後・結果embed編集前に参加者ごとcompletionがある", () => {
  it("settleRoulette → for (participants) recordCasinoCompletionBestEffort の順、catch節には無い", () => {
    const source = readSource("roulette");
    const settleAt = source.indexOf("spin = settleRoulette(services, session, [...bets.values()]);");
    expect(settleAt).toBeGreaterThanOrEqual(0);
    const completeAt = source.indexOf("recordCasinoCompletionBestEffort(services, {", settleAt);
    const catchAt = source.indexOf("} catch (e) {", settleAt);
    expect(completeAt).toBeGreaterThan(settleAt);
    expect(completeAt).toBeLessThan(catchAt);

    const voidAt = source.indexOf("voidRouletteTable(services, session, participants);", catchAt);
    const catchEndAt = source.indexOf("return;", voidAt);
    const catchBody = source.slice(catchAt, catchEndAt);
    expect(catchBody, "catch節（精算失敗）にcompletionが書かれている（あってはならない）").not.toContain(
      "recordCasinoCompletionBestEffort(",
    );
  });
});

describe("keiba.ts: settleKeibaRace成功直後・結果表示前にparticipantごとcompletionがある", () => {
  it("settleKeibaRace → for (distinct bettors) recordCasinoCompletionBestEffort の順", () => {
    const source = readSource("keiba");
    const settleAt = source.indexOf("settleKeibaRace(services, session, distributions);");
    expect(settleAt).toBeGreaterThanOrEqual(0);
    const completeAt = source.indexOf("recordCasinoCompletionBestEffort(services, {", settleAt);
    expect(completeAt).toBeGreaterThan(settleAt);

    // voidKeibaRaceを呼ぶ外側catchはrunRaceAndSettle全体を囲む——settleKeibaRace自体は
    // 単一atomic transactionで、失敗時はここへ到達しない（settleAt自体が実行されない）。
    const voidAt = source.indexOf("voidKeibaRace(services, session);");
    expect(voidAt, "voidKeibaRaceが無い").toBeGreaterThanOrEqual(0);
    expect(voidAt).toBeLessThan(settleAt); // catch節の定義自体はsettle呼び出しより前に現れる（外側try）
  });
});
