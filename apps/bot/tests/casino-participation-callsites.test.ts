import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  Casino,
  CasinoChipAssets,
  CasinoParticipationHistory,
  ChipLedger,
  ChipTx,
  CHIP_ESCROW,
  DailyRisk,
  Escrow,
  EventLog,
  FORMAL_OPENING_VERSION,
  HOUSE_HOLDER,
  HouseReservations,
  Items,
  Ledger,
  openDb,
  registerDefaultTxTypes,
  isPlayerHolder,
} from "@meigokujo/core";
import type { Services } from "../src/services.js";
import { acceptRouletteBet } from "../src/casino/roulette.js";
import { acceptKeibaBet } from "../src/casino/keiba.js";
import { acceptPvpChallenge, type AcceptDeps } from "../src/casino/pvp-accept.js";
import { createChallenge, resetChallengesForTesting } from "../src/casino/pvp-challenge.js";
import { resetTransientParticipationForTesting } from "../src/casino/participation.js";

registerDefaultTxTypes();

/**
 * PR E4 §18: production callsite audit。
 *
 * 「service単体だけ動く」ではなく、本番casino pathから実際にsafe writerへ到達すること、
 * pre-commit rejectionでは一切書き込まれないことを固定する。
 */

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  chipTx.captureOpening(FORMAL_OPENING_VERSION, [], { poolLand: ledger.balanceOf(CHIP_ESCROW), fromLedgerTxId: ledger.lastTransactionId() });
  const items = new Items(db);
  const reservations = new HouseReservations(db, chips, events);
  chips.setReservedProvider((holderId) => (holderId === HOUSE_HOLDER ? reservations.totalReserved() : 0));
  const chipAssets = new CasinoChipAssets(db, chips);
  const dailyRisk = new DailyRisk(db, ledger, chipAssets);
  const casino = new Casino(db, chips, events, { items, reservations, dailyRisk });
  const escrow = new Escrow(db, chips, events, { onPlayerNet: (userId, net) => casino.recordGameNet(userId, net) });
  const casinoParticipation = new CasinoParticipationHistory(db);
  const services = {
    db, ledger, events, chipTx, chips, ether: chips, chipAssets, casino, escrow, items, reservations, dailyRisk,
    casinoParticipation,
  } as unknown as Services;
  resetTransientParticipationForTesting();
  resetChallengesForTesting();
  return { db, ledger, chips, casino, escrow, reservations, dailyRisk, casinoParticipation, services };
}

function seed(db: ReturnType<typeof openDb>, holder: string, amount: number): void {
  db.prepare(
    "INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET amount = excluded.amount",
  ).run(holder, amount);
  if (isPlayerHolder(holder)) ensureLandAccount(db, holder);
}

function ensureLandAccount(db: ReturnType<typeof openDb>, userId: string): void {
  db.prepare("INSERT INTO accounts (id, kind, status, created_at) VALUES (?, 'user', 'active', 1) ON CONFLICT(id) DO NOTHING").run(`user:${userId}`);
  db.prepare("INSERT INTO balances (account_id, amount, updated_at) VALUES (?, 0, 1) ON CONFLICT(account_id) DO NOTHING").run(`user:${userId}`);
}

function participationRows(db: ReturnType<typeof openDb>) {
  return db.prepare(`SELECT participation_key, user_id, activity_key FROM casino_participations ORDER BY user_id`).all() as Array<{
    participation_key: string;
    user_id: string;
    activity_key: string;
  }>;
}

// ─────────────────────────────────────────────────────────────
// roulette
// ─────────────────────────────────────────────────────────────

describe("roulette: acceptRouletteBet", () => {
  it("successful accept → participation recorded", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    seed(c.db, "alice", 100_000);
    const r = acceptRouletteBet(c.services, "roulette:s1", new Map(), "alice", "red", 1_000, "op1");
    expect(r.ok).toBe(true);
    expect(participationRows(c.db)).toEqual([{ participation_key: "roulette:roulette:s1:alice", user_id: "alice", activity_key: "roulette" }]);
  });

  it("rebet same session/user → source上同じactivity-day 1（raw rowも1のまま）", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    seed(c.db, "alice", 100_000);
    const bets = new Map();
    acceptRouletteBet(c.services, "roulette:s1", bets, "alice", "red", 1_000, "op1");
    acceptRouletteBet(c.services, "roulette:s1", bets, "alice", "black", 500, "op2"); // 張り直し
    expect(participationRows(c.db)).toHaveLength(1);
  });

  it("capacity reject → writer 0", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000); // 零(35倍)を受けられない薄さ
    seed(c.db, "alice", 100_000);
    const r = acceptRouletteBet(c.services, "roulette:s1", new Map(), "alice", "green", 1_000, "op1");
    expect(r.ok).toBe(false);
    expect(participationRows(c.db)).toHaveLength(0);
  });

  it("broke（エスクロー不足）reject → writer 0", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    seed(c.db, "alice", 500); // 賭け額に届かない
    const r = acceptRouletteBet(c.services, "roulette:s1", new Map(), "alice", "red", 1_000, "op1");
    expect(r.ok).toBe(false);
    expect(participationRows(c.db)).toHaveLength(0);
  });

  it("conflict（取り違え検出）reject → writer 0", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    seed(c.db, "alice", 100_000);
    const bets = new Map();
    acceptRouletteBet(c.services, "roulette:s1", bets, "alice", "red", 1_000, "op1");
    const before = participationRows(c.db).length;
    const r = acceptRouletteBet(c.services, "roulette:s1", bets, "alice", "black", 5_000, "op1"); // 同じoperationId・別内容
    expect(r.ok).toBe(false);
    expect(participationRows(c.db)).toHaveLength(before); // 増えない
  });
});

// ─────────────────────────────────────────────────────────────
// keiba
// ─────────────────────────────────────────────────────────────

describe("keiba: acceptKeibaBet", () => {
  it("successful accept → participation recorded", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    seed(c.db, "alice", 100_000);
    const r = acceptKeibaBet(c.services, "keiba:s1", new Map(), "alice", 1, "win", 1_000, "op1");
    expect(r.ok).toBe(true);
    expect(participationRows(c.db)).toEqual([{ participation_key: "keiba:keiba:s1:alice", user_id: "alice", activity_key: "keiba" }]);
  });

  it("same race multiple bets → same participation semantics（raw rowも1のまま）", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    seed(c.db, "alice", 100_000);
    const bets = new Map();
    acceptKeibaBet(c.services, "keiba:s1", bets, "alice", 1, "win", 1_000, "op1");
    acceptKeibaBet(c.services, "keiba:s1", bets, "alice", 2, "place", 500, "op2"); // 同じレースへの別口
    expect(participationRows(c.db)).toHaveLength(1);
  });

  it("broke reject → writer 0", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    seed(c.db, "alice", 500);
    const r = acceptKeibaBet(c.services, "keiba:s1", new Map(), "alice", 1, "win", 1_000, "op1");
    expect(r.ok).toBe(false);
    expect(participationRows(c.db)).toHaveLength(0);
  });

  it("conflict reject → writer 0", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    seed(c.db, "alice", 100_000);
    const bets = new Map();
    acceptKeibaBet(c.services, "keiba:s1", bets, "alice", 1, "win", 1_000, "op1");
    const before = participationRows(c.db).length;
    const r = acceptKeibaBet(c.services, "keiba:s1", bets, "alice", 4, "place", 9_000, "op1");
    expect(r.ok).toBe(false);
    expect(participationRows(c.db)).toHaveLength(before);
  });
});

// ─────────────────────────────────────────────────────────────
// PVP 公開募集（pvp-accept.ts）
// ─────────────────────────────────────────────────────────────

function pvpDeps(): { deps: AcceptDeps; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async () => undefined);
  const deps: AcceptDeps = {
    runners: { chinchiro: run, bj: run, sashi: run, indian: run },
    closeCard: async () => undefined,
  };
  return { deps, run };
}

describe("PVP 公開募集: acceptPvpChallenge", () => {
  it("challenge作成だけ → writer 0", () => {
    const c = setup();
    createChallenge({ id: "c1", challengerId: "alice", game: "sashi", bet: 1_000, channelId: "ch1", onExpire: () => undefined });
    expect(participationRows(c.db)).toHaveLength(0);
  });

  it("collectStakes success → challenger + accepterをatomicに記録", async () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    seed(c.db, "alice", 100_000);
    seed(c.db, "bob", 100_000);
    createChallenge({ id: "c1", challengerId: "alice", game: "bj", bet: 1_000, channelId: "ch1", onExpire: () => undefined });
    const { deps } = pvpDeps();
    const interaction = {
      user: { id: "bob", bot: false },
      message: { id: "card1" },
      client: { users: { fetch: async (id: string) => ({ id }) } },
      deferUpdate: async () => undefined,
      reply: async () => undefined,
    } as never;

    const result = await acceptPvpChallenge(interaction, c.services, "c1", deps);
    expect(result).toEqual({ ok: true });
    expect(participationRows(c.db).map((r) => r.user_id).sort()).toEqual(["alice", "bob"]);
    expect(participationRows(c.db).every((r) => r.activity_key === "blackjack")).toBe(true); // "bj" → "blackjack"へ正規化
    // 対戦相手identityはparticipation_keyへ出ない（session単位のみ）
    expect(participationRows(c.db).every((r) => r.participation_key === "pvp:pvpopen:c1")).toBe(true);
  });

  it("collectStakes failure（残高不足）→ writer 0", async () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    seed(c.db, "alice", 100_000);
    seed(c.db, "bob", 0); // accepterが残高0
    createChallenge({ id: "c1", challengerId: "alice", game: "sashi", bet: 1_000, channelId: "ch1", onExpire: () => undefined });
    const { deps, run } = pvpDeps();
    const interaction = {
      user: { id: "bob", bot: false },
      message: { id: "card1" },
      client: { users: { fetch: async (id: string) => ({ id }) } },
      deferUpdate: async () => undefined,
      reply: async () => undefined,
    } as never;

    const result = await acceptPvpChallenge(interaction, c.services, "c1", deps);
    expect(result).toEqual({ ok: false, reason: "accepter_ineligible" });
    expect(run).not.toHaveBeenCalled();
    expect(participationRows(c.db)).toHaveLength(0);
  });

  it("claimだけ（別人が同時に受けて敗れる）→ writer 0", async () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    seed(c.db, "alice", 100_000);
    seed(c.db, "bob", 100_000);
    seed(c.db, "carol", 100_000);
    createChallenge({ id: "c1", challengerId: "alice", game: "indian", bet: 1_000, channelId: "ch1", onExpire: () => undefined });
    const { deps } = pvpDeps();
    const carolInteraction = {
      user: { id: "carol", bot: false },
      message: { id: "card1" },
      client: { users: { fetch: async (id: string) => ({ id }) } },
      deferUpdate: async () => undefined,
      reply: async () => undefined,
    } as never;
    // carolが先にacquireTransientParticipationしてbobを弾く状況を模す代わりに、
    // 同じchallengeIdを2回受けさせて2人目がgoneで敗れることを確認する
    const bobInteraction = { ...carolInteraction, user: { id: "bob", bot: false } };
    const [a, b] = await Promise.all([
      acceptPvpChallenge(carolInteraction, c.services, "c1", deps),
      acceptPvpChallenge(bobInteraction, c.services, "c1", deps),
    ]);
    const winners = [a, b].filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    // reserveSeatsAndClaimはnon-asyncなので、Promise.all配列順に同期的にclaimが決まる——
    // carolが先勝ちし、bobはgoneで敗れる（決定的）。敗れた側のuserIdはparticipationに含まれない。
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: false, reason: "gone" });
    expect(participationRows(c.db).map((r) => r.user_id).sort()).toEqual(["alice", "carol"]);
  });
});

// ─────────────────────────────────────────────────────────────
// 構造的な呼び出し順序の固定（Discordフルモックが非現実的な経路向け、
// casino-metrics-slots-structure.test.tsと同じ手法）
// ─────────────────────────────────────────────────────────────

function readSource(file: string): string {
  return readFileSync(new URL(`../src/casino/${file}.ts`, import.meta.url), "utf8");
}

// solo 7ゲームのcommit boundary検証は casino-participation-solo-boundary.test.ts
// （PR #163レビュー対応: house reservation成立後ではなく、各ゲームの実際のsettle
// primitiveより後であることを機能fixture/source-order両方で検証する）。

describe("PVP named-invite duels: recordCasinoParticipationBestEffort は両者collectStakes成功後、runFunded*前", () => {
  const cases = [
    { file: "bj-duel", runFundedNeedle: "await runFundedBjDuel(services, {" },
    { file: "chinchiro-duel", runFundedNeedle: "await runFundedChinchiroDuel(services, {" },
    { file: "sashi", runFundedNeedle: "await runFundedSashiDuel(services, {" },
    { file: "indian", runFundedNeedle: "await runFundedIndian(services, {" },
  ];

  for (const { file, runFundedNeedle } of cases) {
    it(`${file}.ts: opponentStake成功チェック後・runFunded*前に書き込む`, () => {
      const source = readSource(file);
      const opponentCollectAt = source.indexOf("collect:opponent");
      expect(opponentCollectAt, `${file}: opponent collectStakes呼び出しが無い`).toBeGreaterThanOrEqual(0);
      const participationAt = source.indexOf("recordCasinoParticipationBestEffort(services, {", opponentCollectAt);
      const runFundedAt = source.indexOf(runFundedNeedle, opponentCollectAt);
      expect(participationAt, `${file}: recordCasinoParticipationBestEffort呼び出しが無い`).toBeGreaterThan(opponentCollectAt);
      expect(runFundedAt, `${file}: runFunded*呼び出しが無い`).toBeGreaterThan(participationAt);
    });
  }
});

describe("poker-duel.ts: dealHands/dealHandsFromClientの先頭で記録する", () => {
  it("両関数とも配布処理より前に呼ぶ", () => {
    const source = readSource("poker-duel");
    for (const fn of ["async function dealHands(", "async function dealHandsFromClient("]) {
      const fnAt = source.indexOf(fn);
      expect(fnAt, `${fn} が無い`).toBeGreaterThanOrEqual(0);
      const bodyEnd = source.indexOf("\n}\n", fnAt);
      const body = source.slice(fnAt, bodyEnd);
      const recordAt = body.indexOf("recordPokerDuelParticipation(services, s);");
      const dealAt = body.indexOf("newDeck(services.rng)");
      expect(recordAt, `${fn}: recordPokerDuelParticipationが無い`).toBeGreaterThanOrEqual(0);
      expect(dealAt, `${fn}: newDeckが無い`).toBeGreaterThan(recordAt);
    }
  });
});

describe("chohan-multi.ts: 両側成立チェック後・revealAndSettle前に記録する", () => {
  it("不成立returnの後、revealAndSettle呼び出しの前", () => {
    const source = readSource("chohan-multi");
    const voidAt = source.indexOf("両側に張り手が揃わなかった");
    const participationAt = source.indexOf("recordCasinoParticipationBestEffort(services, {", voidAt);
    const settleAt = source.indexOf("await revealAndSettle();", voidAt);
    expect(participationAt, "recordCasinoParticipationBestEffortが無い").toBeGreaterThan(voidAt);
    expect(settleAt, "revealAndSettle呼び出しが無い").toBeGreaterThan(participationAt);
  });
});
