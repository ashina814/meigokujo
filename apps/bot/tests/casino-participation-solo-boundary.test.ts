import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CasinoParticipationHistory, openDb } from "@meigokujo/core";
import type { Services } from "../src/services.js";

/**
 * PR #163レビュー BLOCKER: solo 7ゲームのparticipation commit boundaryは、
 * `withExplicitHouseReservation()`のhouse reservation成立直後ではなく、
 * 各ゲームが実際にround（資金処理）を確定させる正本（`settleSolo()`/
 * `spinPaid()`/`settleChinchiroRound()`）が成功した後でなければならない。
 *
 * chohan/blackjack/holdemは`reply.awaitMessageComponent()`（Promise形）を使うため、
 * `common.js`をmockしてhouse reservationをbypassし、`awaitMessageComponent`の
 * timeout/rejectで実際のproduction control flowを駆動する（casino-metrics-abandon.test.ts
 * と同じ手法）。slotsは`playSlots()`を実サービスで直接駆動する
 * （casino-known-bugs.test.tsと同じ手法）。
 */

vi.mock("../src/casino/common.js", () => ({
  MIN_BET: 5,
  MAX_BET: 1_000_000,
  acquireSeat: vi.fn(() => true),
  releaseSeat: vi.fn(),
  sleep: vi.fn(async () => undefined),
  validateBet: vi.fn(async (_interaction: unknown, _services: unknown, bet: number) => ({ ok: true, bet })),
  withHouseReservation: vi.fn(
    async (
      _interaction: unknown,
      _services: unknown,
      _game: string,
      _bet: number,
      _operationId: string,
      run: (reservationKey: string) => Promise<void>,
    ) => run("reservation"),
  ),
  reserveBlackjackLiability: vi.fn(() => ({ reservationKey: "reservation", doubleAllowed: false })),
  withExplicitHouseReservation: vi.fn(
    async (
      _interaction: unknown,
      _services: unknown,
      _game: string,
      _reserve: unknown,
      run: (reservationKey: string) => Promise<void>,
    ) => run("reservation"),
  ),
}));

vi.mock("../src/casino/solo-result.js", () => ({
  buildSoloResult: vi.fn(() => ({ embeds: [], components: [] })),
}));

vi.mock("../src/casino/bigwin.js", () => ({
  broadcastBigWin: vi.fn(),
}));

import { playChohan } from "../src/casino/chohan.js";
import { playBlackjack } from "../src/casino/blackjack.js";
import { playHoldem } from "../src/casino/holdem.js";
import { playSlots } from "../src/casino/slots.js";

const timeoutError = () => ({
  code: "InteractionCollectorError",
  message: "Collector received no interactions before ending with reason: time",
});
const systemError = () => new Error("Discord API failed");

function fakeInteraction(awaitResult: { resolve?: unknown; reject?: unknown }) {
  const message = {
    awaitMessageComponent: awaitResult.reject
      ? vi.fn().mockRejectedValue(awaitResult.reject)
      : vi.fn().mockResolvedValue(awaitResult.resolve),
    edit: vi.fn().mockResolvedValue(undefined),
  };
  const interaction = {
    id: "interaction-1",
    user: { id: "alice" },
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(message),
    fetchReply: vi.fn().mockResolvedValue(message),
    client: {},
  };
  return { interaction, message };
}

function fakeButton(customId: string) {
  return { customId, deferUpdate: vi.fn().mockResolvedValue(undefined) };
}

function fakeServices(opts: { settleSoloThrows?: boolean; writerThrows?: boolean } = {}) {
  const db = openDb(":memory:");
  const casinoParticipation = new CasinoParticipationHistory(db);
  if (opts.writerThrows) {
    vi.spyOn(casinoParticipation, "recordCommittedParticipation").mockImplementation(() => {
      throw new Error("simulated writer failure");
    });
  }
  const settleSolo = vi.fn(() => {
    if (opts.settleSoloThrows) throw new Error("simulated settle failure");
    return {
      payout: 100,
      net: 0,
      chainBonus: 0,
      chainLabel: "",
      chainStreak: 0,
      chainMult: 1,
      fukuTax: 0,
      fukuRate: 0,
      amuletNote: null,
    };
  });
  const services = {
    db,
    casinoParticipation,
    rng: {
      int: vi.fn(() => 1),
      shuffle: vi.fn(<T>(values: T[]) => values), // identity shuffle: player K/Q=20, dealer J/10=20, no natural
      // 常に最初の重み付き候補（🦇蝙蝠、jackpot/scatterではない）を返す——slotsのjackpot/
      // freeSpin分岐を誘発せず、settleSolo経由の通常決着だけを見る。
      weighted: vi.fn(<T>(items: ReadonlyArray<readonly [T, number]>) => items[0]![0]),
    },
    casino: { settleSolo, jackpotPool: vi.fn(() => 0), stats: vi.fn(() => ({ current_win_streak: 0 })) },
    chips: {
      balanceOf: vi.fn(() => 10_000),
      ensureFreeChips: vi.fn(() => ({ freeAfter: 10_000 })),
      runGroup: vi.fn((_opts: unknown, fn: () => unknown) => fn()),
    },
    freeSpins: { listPending: vi.fn(() => []) },
  } as unknown as Services;
  return { services, settleSolo, casinoParticipation, db };
}

function rows(db: ReturnType<typeof openDb>) {
  return db.prepare(`SELECT activity_key FROM casino_participations`).all() as Array<{ activity_key: string }>;
}

describe("chohan: participation commit boundary", () => {
  it("A. 選択timeout（pre-commit failure）→ participation 0、settleSoloも呼ばれない", async () => {
    const { interaction } = fakeInteraction({ reject: timeoutError() });
    const { services, settleSolo, db } = fakeServices();

    await playChohan(interaction as never, services, 100, { source: "amount" });

    expect(settleSolo).not.toHaveBeenCalled();
    expect(rows(db)).toHaveLength(0);
  });

  it("B. 選択成功→settleSolo成功 → participation 1", async () => {
    const { interaction } = fakeInteraction({ resolve: fakeButton("chohan:cho") });
    const { services, settleSolo, db } = fakeServices();

    await playChohan(interaction as never, services, 100, { source: "amount" });

    expect(settleSolo).toHaveBeenCalledOnce();
    expect(rows(db)).toEqual([{ activity_key: "chohan" }]);
  });

  it("C. writer failure → gameplayは継続する（best-effort contract）", async () => {
    const { interaction } = fakeInteraction({ resolve: fakeButton("chohan:cho") });
    const { services, settleSolo } = fakeServices({ writerThrows: true });

    await expect(playChohan(interaction as never, services, 100, { source: "amount" })).resolves.toBeUndefined();
    expect(settleSolo).toHaveBeenCalledOnce();
  });

  it("D. 選択成功後settleSoloが失敗（pre-commit failure）→ participation 0", async () => {
    const { interaction } = fakeInteraction({ resolve: fakeButton("chohan:cho") });
    const { services, settleSolo, db } = fakeServices({ settleSoloThrows: true });

    await expect(playChohan(interaction as never, services, 100, { source: "amount" })).rejects.toThrow(
      "simulated settle failure",
    );
    expect(settleSolo).toHaveBeenCalledOnce();
    expect(rows(db)).toHaveLength(0);
  });
});

describe("blackjack: participation commit boundary", () => {
  it("A. 非timeoutエラー（pre-commit failure）→ participation 0、settleSoloも呼ばれない", async () => {
    const { interaction } = fakeInteraction({ reject: systemError() });
    const { services, settleSolo, db } = fakeServices();

    await expect(playBlackjack(interaction as never, services, 100, { source: "amount" })).rejects.toThrow(
      "Discord API failed",
    );
    expect(settleSolo).not.toHaveBeenCalled();
    expect(rows(db)).toHaveLength(0);
  });

  it("B. timeout（強制スタンド）でもfinish()まで到達しsettleSolo成功 → participation 1", async () => {
    const { interaction } = fakeInteraction({ reject: timeoutError() });
    const { services, settleSolo, db } = fakeServices();

    await playBlackjack(interaction as never, services, 100, { source: "amount" });

    expect(settleSolo).toHaveBeenCalledOnce();
    expect(rows(db)).toEqual([{ activity_key: "blackjack" }]);
  });

  it("C. writer failure → gameplayは継続する（best-effort contract）", async () => {
    const { interaction } = fakeInteraction({ reject: timeoutError() });
    const { services, settleSolo } = fakeServices({ writerThrows: true });

    await expect(playBlackjack(interaction as never, services, 100, { source: "amount" })).resolves.toBeUndefined();
    expect(settleSolo).toHaveBeenCalledOnce();
  });

  it("D. timeout強制スタンド後settleSoloが失敗（pre-commit failure）→ participation 0", async () => {
    const { interaction } = fakeInteraction({ reject: timeoutError() });
    const { services, settleSolo, db } = fakeServices({ settleSoloThrows: true });

    await expect(playBlackjack(interaction as never, services, 100, { source: "amount" })).rejects.toThrow(
      "simulated settle failure",
    );
    expect(settleSolo).toHaveBeenCalledOnce();
    expect(rows(db)).toHaveLength(0);
  });
});

describe("holdem: participation commit boundary", () => {
  it("A. 非timeoutエラー（pre-commit failure）→ participation 0、settleSoloも呼ばれない", async () => {
    const { interaction } = fakeInteraction({ reject: systemError() });
    const { services, settleSolo, db } = fakeServices();

    await expect(playHoldem(interaction as never, services, 100, { source: "amount" })).rejects.toThrow(
      "Discord API failed",
    );
    expect(settleSolo).not.toHaveBeenCalled();
    expect(rows(db)).toHaveLength(0);
  });

  it("B. timeout（強制check連鎖）でもshowdownまで到達しsettleSolo成功 → participation 1", async () => {
    const { interaction } = fakeInteraction({ reject: timeoutError() });
    const { services, settleSolo, db } = fakeServices();

    await playHoldem(interaction as never, services, 100, { source: "amount" });

    expect(settleSolo).toHaveBeenCalledOnce();
    expect(rows(db)).toEqual([{ activity_key: "holdem" }]);
  });

  it("C. writer failure → gameplayは継続する（best-effort contract）", async () => {
    const { interaction } = fakeInteraction({ reject: timeoutError() });
    const { services, settleSolo } = fakeServices({ writerThrows: true });

    await expect(playHoldem(interaction as never, services, 100, { source: "amount" })).resolves.toBeUndefined();
    expect(settleSolo).toHaveBeenCalledOnce();
  });

  it("D. timeout強制check連鎖後settleSoloが失敗（pre-commit failure）→ participation 0", async () => {
    const { interaction } = fakeInteraction({ reject: timeoutError() });
    const { services, settleSolo, db } = fakeServices({ settleSoloThrows: true });

    await expect(playHoldem(interaction as never, services, 100, { source: "amount" })).rejects.toThrow(
      "simulated settle failure",
    );
    expect(settleSolo).toHaveBeenCalledOnce();
    expect(rows(db)).toHaveLength(0);
  });
});

describe("slots: participation commit boundary", () => {
  it("A. spinPaid失敗（settleSolo同等のprimitive）→ participation 0", async () => {
    // slotsはspinPaid()内部でservices.casino.settleSoloを呼ぶ。settleSoloが投げれば
    // spinPaid()も投げ、その後段のwriterへは到達しない。
    const { interaction } = fakeInteraction({});
    const { services, settleSolo, db } = fakeServices({ settleSoloThrows: true });

    await expect(playSlots(interaction as never, services, 100)).rejects.toThrow("simulated settle failure");
    expect(settleSolo).toHaveBeenCalledOnce();
    expect(rows(db)).toHaveLength(0);
  });

  it("B. spinPaid成功 → participation 1", async () => {
    const { interaction } = fakeInteraction({});
    const { services, settleSolo, db } = fakeServices();

    await playSlots(interaction as never, services, 100);

    expect(settleSolo).toHaveBeenCalledOnce();
    expect(rows(db)).toEqual([{ activity_key: "slots" }]);
  });

  it("C. writer failure → gameplayは継続する（best-effort contract）", async () => {
    const { interaction } = fakeInteraction({});
    const { services, settleSolo } = fakeServices({ writerThrows: true });

    await expect(playSlots(interaction as never, services, 100)).resolves.toBeUndefined();
    expect(settleSolo).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────
// crash / chinchiro（solo）: real-time collectorやescrow事前預託の都合上、
// 機能fixtureではなくsource-order検証を使う（casino-metrics-slots-structure.test.ts
// と同じ手法）。ただし house reservation ではなく、実際のsettle primitiveより
// 「後ろ」にあることを検証する（今回のBLOCKERの再発防止）。
// ─────────────────────────────────────────────────────────────

function readSource(file: string): string {
  return readFileSync(new URL(`../src/casino/${file}.ts`, import.meta.url), "utf8");
}

describe("crash: recordCasinoParticipationBestEffortはsettleSolo成功後（両分岐）", () => {
  it("win分岐: settleSolo → recordCasinoParticipationBestEffort の順", () => {
    const source = readSource("crash");
    const winSettleAt = source.indexOf('settleSolo(uid, "クラッシュ", bet, rawPayout,');
    const elseAt = source.indexOf("} else {", winSettleAt);
    const winWriteAt = source.indexOf("recordCasinoParticipationBestEffort(services, {", winSettleAt);
    expect(winSettleAt).toBeGreaterThanOrEqual(0);
    expect(elseAt).toBeGreaterThan(winSettleAt);
    // win分岐内（settleSolo〜else節開始前）に収まっていることまで確認する——
    // loss分岐側のwriterを誤って拾ってpassしないようwindowを閉じる（自己mutation検証で発覚）
    expect(winWriteAt).toBeGreaterThan(winSettleAt);
    expect(winWriteAt).toBeLessThan(elseAt);
  });

  it("loss分岐: settleSolo → recordCasinoParticipationBestEffort の順", () => {
    const source = readSource("crash");
    const lossSettleAt = source.indexOf('settleSolo(uid, "クラッシュ", bet, 0,');
    const lossWriteAt = source.indexOf("recordCasinoParticipationBestEffort(services, {", lossSettleAt);
    expect(lossSettleAt).toBeGreaterThanOrEqual(0);
    expect(lossWriteAt).toBeGreaterThan(lossSettleAt);
  });

  it("house reservation取得直後（旧BLOCKERの位置）には書き込みが存在しない", () => {
    const source = readSource("crash");
    const startAt = source.indexOf("recordCasinoGameStartBestEffort(services, {");
    const generateAt = source.indexOf("generateCrashPoint(services.rng)");
    const between = source.slice(startAt, generateAt);
    expect(between).not.toContain("recordCasinoParticipationBestEffort(");
  });
});

describe("chinchiro（solo）: recordCasinoParticipationBestEffortはsettleChinchiroRound成功後", () => {
  it("settleChinchiroRound → recordCasinoParticipationBestEffort の順", () => {
    const source = readSource("chinchiro");
    const settleAt = source.indexOf("const round = settleChinchiroRound(");
    const writeAt = source.indexOf("recordCasinoParticipationBestEffort(services, {", settleAt);
    expect(settleAt).toBeGreaterThanOrEqual(0);
    expect(writeAt).toBeGreaterThan(settleAt);
  });

  it("house reservation取得直後（旧BLOCKERの位置）には書き込みが存在しない", () => {
    const source = readSource("chinchiro");
    const startAt = source.indexOf('game: "チンチロ",');
    const settleAt = source.indexOf("const round = settleChinchiroRound(");
    const between = source.slice(startAt, settleAt);
    expect(between).not.toContain("recordCasinoParticipationBestEffort(");
  });
});

describe("poker（solo）: recordCasinoParticipationBestEffortはsettleSolo成功後", () => {
  it("settleSolo → recordCasinoParticipationBestEffort の順", () => {
    const source = readSource("poker");
    const settleAt = source.indexOf('settleSolo(uid, "ポーカー", bet, rawPayout,');
    const writeAt = source.indexOf("recordCasinoParticipationBestEffort(services, {", settleAt);
    expect(settleAt).toBeGreaterThanOrEqual(0);
    expect(writeAt).toBeGreaterThan(settleAt);
  });

  it("house reservation取得直後（旧BLOCKERの位置）には書き込みが存在しない", () => {
    const source = readSource("poker");
    const startAt = source.indexOf('game: "ポーカー",');
    const settleAt = source.indexOf('settleSolo(uid, "ポーカー", bet, rawPayout,');
    const between = source.slice(startAt, settleAt);
    expect(between).not.toContain("recordCasinoParticipationBestEffort(");
  });
});
