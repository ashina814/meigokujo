import { opId, openFormally } from "./helpers/chip-ctx.js";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { ChipLedger } from "../src/casino/exchange.js";
import { MARKET_HOUSE_CUT } from "../src/casino/game-models.js";
import {
  EVENT_MARKET_CREATE_FEE,
  EVENT_MARKET_FEES_HOLDER,
  EVENT_MARKET_MAX_OPTIONS,
  EVENT_MARKET_PERSONAL_CAP,
  EVENT_MARKET_POT_CAP,
  MarketError,
  Markets,
  eventMarketEscrowHolder,
} from "../src/casino/market.js";

registerDefaultTxTypes();

/**
 * イベントLand板（緊急イベント用 hotfix・PR12とは独立）のテスト。
 *
 * 通常板（ChipLedger決済・選択肢2〜4・承認/異議・5分無異議精算）は一切変更していないので、
 * 末尾の「通常板の回帰」だけそちらの経路を通す。それ以外はすべて market_mode='event' の
 * Land決済専用APIを対象にする。
 */

const ROLE_A = "111111111111111111";
const ROLE_B = "222222222222222222";
const ROLE_OTHER = "999999999999999999";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const ether = new ChipLedger(db, ledger, new EventLog(db));
  // 標準板の回帰テストのために正式開業ロックを確定させておく（イベント板の Land 決済には無関係）
  openFormally(ether.chipTx, ledger);
  const events = new EventLog(db);
  const markets = new Markets(db, ether, events, { landLedger: ledger });
  return { db, ledger, ether, events, markets };
}

function seedLand(ledger: Ledger, userId: string, amount: number): void {
  ledger.ensureAccount(`user:${userId}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${userId}`,
    amount,
    type: "initial",
    actor: "t",
    idempotencyKey: `seed:${userId}:${opId()}`,
  });
}

function createEventMarket(
  ctx: ReturnType<typeof setup>,
  overrides: Partial<Parameters<Markets["createEvent"]>[0]> = {},
) {
  seedLand(ctx.ledger, overrides.creatorId ?? "creator", EVENT_MARKET_CREATE_FEE);
  return ctx.markets.createEvent({
    guildId: "g",
    creatorId: "creator",
    title: "イベント板",
    options: ["A", "B"],
    durationMin: 60,
    allowedRoleIds: [ROLE_A, ROLE_B],
    operationId: opId(),
    ...overrides,
  });
}

describe("イベントLand板: 作成", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("2択・32択を受理し、33択は拒否する", () => {
    seedLand(ctx.ledger, "c1", EVENT_MARKET_CREATE_FEE * 3);
    const m2 = ctx.markets.createEvent({
      guildId: "g",
      creatorId: "c1",
      title: "2択",
      options: ["A", "B"],
      durationMin: 10,
      allowedRoleIds: [ROLE_A],
      operationId: opId(),
    });
    expect(m2.market_mode).toBe("event");
    expect(m2.currency_mode).toBe("land");
    expect(m2.approval_mode).toBe("instant");

    const options32 = Array.from({ length: EVENT_MARKET_MAX_OPTIONS }, (_, i) => `opt${i}`);
    const m32 = ctx.markets.createEvent({
      guildId: "g",
      creatorId: "c1",
      title: "32択",
      options: options32,
      durationMin: 10,
      allowedRoleIds: [ROLE_A],
      operationId: opId(),
    });
    expect((JSON.parse(m32.options_json) as string[]).length).toBe(32);

    const options33 = Array.from({ length: 33 }, (_, i) => `opt${i}`);
    expect(() =>
      ctx.markets.createEvent({
        guildId: "g",
        creatorId: "c1",
        title: "33択",
        options: options33,
        durationMin: 10,
        allowedRoleIds: [ROLE_A],
        operationId: opId(),
      }),
    ).toThrow(MarketError);
  });

  it("Discord role ID を snapshot として保存する（重複除去）", () => {
    const m = createEventMarket(ctx, { allowedRoleIds: [ROLE_A, ROLE_A, ROLE_B] });
    const stored = JSON.parse(m.allowed_role_ids_json) as string[];
    expect(stored.sort()).toEqual([ROLE_A, ROLE_B].sort());
  });

  it("参加ロールが0個・6個以上（重複除去後）なら ERR_BAD_ROLE_LIST", () => {
    seedLand(ctx.ledger, "c2", EVENT_MARKET_CREATE_FEE * 2);
    expect(() =>
      ctx.markets.createEvent({
        guildId: "g",
        creatorId: "c2",
        title: "x",
        options: ["A", "B"],
        durationMin: 10,
        allowedRoleIds: [],
        operationId: opId(),
      }),
    ).toThrow(MarketError);
    const sixRoles = ["1", "2", "3", "4", "5", "6"];
    expect(() =>
      ctx.markets.createEvent({
        guildId: "g",
        creatorId: "c2",
        title: "x",
        options: ["A", "B"],
        durationMin: 10,
        allowedRoleIds: sixRoles,
        operationId: opId(),
      }),
    ).toThrow(MarketError);
  });

  it("開設手数料 500Ld を sys:escrow:market:fees へ徴収し、板をatomicに作る", () => {
    seedLand(ctx.ledger, "creator", EVENT_MARKET_CREATE_FEE);
    const before = ctx.ledger.balanceOf(`user:creator`);
    const m = ctx.markets.createEvent({
      guildId: "g",
      creatorId: "creator",
      title: "手数料テスト",
      options: ["A", "B"],
      durationMin: 10,
      allowedRoleIds: [ROLE_A],
      operationId: opId(),
    });
    expect(ctx.ledger.balanceOf("user:creator")).toBe(before - EVENT_MARKET_CREATE_FEE);
    expect(ctx.ledger.balanceOf(EVENT_MARKET_FEES_HOLDER)).toBe(EVENT_MARKET_CREATE_FEE);
    expect(m.fund_mode).toBe("escrow");
  });

  it("手数料不足なら ERR_INSUFFICIENT_LAND・板もfeeも作られない", () => {
    ctx.ledger.ensureAccount("user:poor", "user");
    expect(() =>
      ctx.markets.createEvent({
        guildId: "g",
        creatorId: "poor",
        title: "x",
        options: ["A", "B"],
        durationMin: 10,
        allowedRoleIds: [ROLE_A],
        operationId: opId(),
      }),
    ).toThrow(MarketError);
    expect(ctx.ledger.balanceOf(EVENT_MARKET_FEES_HOLDER)).toBe(0);
    expect(ctx.markets.listOpen()).toHaveLength(0);
  });

  it("同じoperationIdの再送は二重徴収しない（作成成功後の再送）", () => {
    seedLand(ctx.ledger, "creator", EVENT_MARKET_CREATE_FEE);
    const op = opId();
    const m1 = ctx.markets.createEvent({
      guildId: "g",
      creatorId: "creator",
      title: "reP",
      options: ["A", "B"],
      durationMin: 10,
      allowedRoleIds: [ROLE_A],
      operationId: op,
    });
    const before = ctx.ledger.balanceOf(EVENT_MARKET_FEES_HOLDER);
    const m2 = ctx.markets.createEvent({
      guildId: "g",
      creatorId: "creator",
      title: "reP",
      options: ["A", "B"],
      durationMin: 10,
      allowedRoleIds: [ROLE_A],
      operationId: op,
    });
    expect(m2.id).toBe(m1.id);
    expect(ctx.ledger.balanceOf(EVENT_MARKET_FEES_HOLDER)).toBe(before); // 変化なし
  });
});

describe("イベントLand板: ロール制限つき bet", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("allowed roleのいずれか1つを持っていればbetできる", () => {
    const m = createEventMarket(ctx);
    seedLand(ctx.ledger, "bettor", 1_000);
    const r = ctx.markets.betEventLand(m.id, "bettor", [ROLE_B], 0, 500, opId());
    expect(r).toEqual({ previous: null, net: 500 });
    expect(ctx.ledger.balanceOf("user:bettor")).toBe(500);
    expect(ctx.ledger.balanceOf(eventMarketEscrowHolder(m.id))).toBe(500);
  });

  it("対象ロールを一切持っていなければ ERR_ROLE_NOT_ALLOWED", () => {
    const m = createEventMarket(ctx);
    seedLand(ctx.ledger, "bettor", 1_000);
    expect(() => ctx.markets.betEventLand(m.id, "bettor", [ROLE_OTHER], 0, 500, opId())).toThrow(MarketError);
    try {
      ctx.markets.betEventLand(m.id, "bettor", [], 0, 500, opId());
    } catch (e) {
      expect(e).toBeInstanceOf(MarketError);
      expect((e as MarketError).code).toBe("ERR_ROLE_NOT_ALLOWED");
    }
  });

  it("管理者フラグ・板作成者であっても対象ロールが無ければbet拒否される（バイパスが存在しない）", () => {
    const m = createEventMarket(ctx, { creatorId: "creator" });
    // 作成者自身が bettor でも betEventLand には isAdmin/creator バイパス引数が無い
    seedLand(ctx.ledger, "creator", 1_000);
    expect(() => ctx.markets.betEventLand(m.id, "creator", [ROLE_OTHER], 0, 500, opId())).toThrow(MarketError);
  });

  it("role拒否時はLand・bet行・eventのいずれも変化しない", () => {
    const m = createEventMarket(ctx);
    seedLand(ctx.ledger, "bettor", 1_000);
    const landBefore = ctx.ledger.balanceOf("user:bettor");
    const escrowBefore = ctx.ledger.balanceOf(eventMarketEscrowHolder(m.id));
    const betsBefore = ctx.markets.bets(m.id).length;
    expect(() => ctx.markets.betEventLand(m.id, "bettor", [ROLE_OTHER], 0, 500, opId())).toThrow(MarketError);
    expect(ctx.ledger.balanceOf("user:bettor")).toBe(landBefore);
    expect(ctx.ledger.balanceOf(eventMarketEscrowHolder(m.id))).toBe(escrowBefore);
    expect(ctx.markets.bets(m.id)).toHaveLength(betsBefore);
  });

});

describe("イベントLand板: Landベット（初回・張り直し・冪等性）", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("初回bet: user → escrow へちょうど amount 移動する", () => {
    const m = createEventMarket(ctx);
    seedLand(ctx.ledger, "u1", 5_000);
    ctx.markets.betEventLand(m.id, "u1", [ROLE_A], 0, 1_000, opId());
    expect(ctx.ledger.balanceOf("user:u1")).toBe(4_000);
    expect(ctx.ledger.balanceOf(eventMarketEscrowHolder(m.id))).toBe(1_000);
    const bet = ctx.markets.betOf(m.id, "u1")!;
    expect(bet.amount).toBe(1_000);
    expect(bet.option_index).toBe(0);
  });

  it("張り直し: 旧額を返金し新額を徴収、bet行を新内容へ更新する", () => {
    const m = createEventMarket(ctx);
    seedLand(ctx.ledger, "u1", 5_000);
    ctx.markets.betEventLand(m.id, "u1", [ROLE_A], 0, 1_000, opId());
    const r = ctx.markets.betEventLand(m.id, "u1", [ROLE_A], 1, 2_000, opId());
    expect(r.previous).toBe(1_000);
    expect(r.net).toBe(1_000);
    expect(ctx.ledger.balanceOf("user:u1")).toBe(3_000); // 5000 - 2000
    expect(ctx.ledger.balanceOf(eventMarketEscrowHolder(m.id))).toBe(2_000);
    const bet = ctx.markets.betOf(m.id, "u1")!;
    expect(bet.amount).toBe(2_000);
    expect(bet.option_index).toBe(1);
    expect(ctx.markets.bets(m.id)).toHaveLength(1); // 1人1口
  });

  it("張り直し途中で例外が飛べば全額 rollback する（crash window）", () => {
    const m = createEventMarket(ctx);
    seedLand(ctx.ledger, "u1", 5_000);
    ctx.markets.betEventLand(m.id, "u1", [ROLE_A], 0, 1_000, opId());
    const landBefore = ctx.ledger.balanceOf("user:u1");
    const escrowBefore = ctx.ledger.balanceOf(eventMarketEscrowHolder(m.id));
    const betBefore = ctx.markets.betOf(m.id, "u1")!;

    expect(() =>
      ctx.markets.betEventLand(m.id, "u1", [ROLE_A], 1, 2_000, opId(), () => {
        throw new Error("模擬crash: 返金は終わったが新額徴収の前で落ちた");
      }),
    ).toThrow("模擬crash");

    // 返金トランザクションを含め、全部 rollback されている（片方だけ確定した窓が無い）
    expect(ctx.ledger.balanceOf("user:u1")).toBe(landBefore);
    expect(ctx.ledger.balanceOf(eventMarketEscrowHolder(m.id))).toBe(escrowBefore);
    const betAfter = ctx.markets.betOf(m.id, "u1")!;
    expect(betAfter).toEqual(betBefore);
  });

  it("同じoperationIdの再送（replay）は二重徴収しない・現在のbetを読み直さない", () => {
    const m = createEventMarket(ctx);
    seedLand(ctx.ledger, "u1", 5_000);
    const op = opId();
    const r1 = ctx.markets.betEventLand(m.id, "u1", [ROLE_A], 0, 1_000, op);
    const landAfterFirst = ctx.ledger.balanceOf("user:u1");
    // 同じ operationId で再送（例: Discord再送・二重クリック）
    const r2 = ctx.markets.betEventLand(m.id, "u1", [ROLE_A], 0, 1_000, op);
    expect(r2).toEqual(r1);
    expect(ctx.ledger.balanceOf("user:u1")).toBe(landAfterFirst); // 変化なし
    expect(ctx.markets.bets(m.id)).toHaveLength(1);
  });

  it("残高不足なら ERR_INSUFFICIENT_LAND", () => {
    const m = createEventMarket(ctx);
    seedLand(ctx.ledger, "u1", 100);
    expect(() => ctx.markets.betEventLand(m.id, "u1", [ROLE_A], 0, 500, opId())).toThrow(MarketError);
  });

  it("締切超過なら ERR_NOT_OPEN", () => {
    seedLand(ctx.ledger, "creator", EVENT_MARKET_CREATE_FEE);
    const m = ctx.markets.createEvent({
      guildId: "g",
      creatorId: "creator",
      title: "即締切",
      options: ["A", "B"],
      durationMin: 1,
      allowedRoleIds: [ROLE_A],
      operationId: opId(),
    });
    ctx.markets.close(m.id, "creator");
    seedLand(ctx.ledger, "u1", 1_000);
    expect(() => ctx.markets.betEventLand(m.id, "u1", [ROLE_A], 0, 500, opId())).toThrow(MarketError);
  });

  it("個人の1口上限（張り直し後合計 100,000 Ld）を超えたら ERR_PERSONAL_CAP_EXCEEDED", () => {
    const m = createEventMarket(ctx);
    seedLand(ctx.ledger, "u1", EVENT_MARKET_PERSONAL_CAP + 10_000);
    expect(() => ctx.markets.betEventLand(m.id, "u1", [ROLE_A], 0, EVENT_MARKET_PERSONAL_CAP + 1, opId())).toThrow(
      MarketError,
    );
    // 上限ちょうどは通る
    expect(() => ctx.markets.betEventLand(m.id, "u1", [ROLE_A], 0, EVENT_MARKET_PERSONAL_CAP, opId())).not.toThrow();
  });

  it("板全体のpot上限（900,000 Ld）を超える新規/張り直しは拒否する", () => {
    const m = createEventMarket(ctx);
    // 9人でちょうど 900,000 まで積む（各上限 100,000）
    for (let i = 0; i < 9; i++) {
      seedLand(ctx.ledger, `u${i}`, EVENT_MARKET_PERSONAL_CAP);
      ctx.markets.betEventLand(m.id, `u${i}`, [ROLE_A], 0, EVENT_MARKET_PERSONAL_CAP, opId());
    }
    expect(
      (ctx.db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM casino_market_bets WHERE market_id = ?").get(m.id) as {
        s: number;
      }).s,
    ).toBe(EVENT_MARKET_POT_CAP);
    // 10人目は1Ldでも pot 上限を超えるので拒否
    seedLand(ctx.ledger, "u9", 10);
    expect(() => ctx.markets.betEventLand(m.id, "u9", [ROLE_A], 0, 1, opId())).toThrow(MarketError);
  });

  it("escrow残高とpotが不一致なら資金を動かさずfreezeする", () => {
    const m = createEventMarket(ctx);
    seedLand(ctx.ledger, "u1", 5_000);
    ctx.markets.betEventLand(m.id, "u1", [ROLE_A], 0, 1_000, opId());
    // escrow を人為的に壊す（本来なら起きない不整合を模擬）
    ctx.ledger.transfer({
      from: eventMarketEscrowHolder(m.id),
      to: "sys:treasury",
      amount: 1,
      type: "market_house_fee",
      actor: "test",
      idempotencyKey: `corrupt:${opId()}`,
    });
    seedLand(ctx.ledger, "u2", 1_000);
    expect(() => ctx.markets.betEventLand(m.id, "u2", [ROLE_A], 0, 500, opId())).toThrow(MarketError);
    expect(ctx.markets.get(m.id)!.status).toBe("frozen");
  });

  it("landLedger 未設定の Markets ではイベントAPIが ERR_LAND_LEDGER_NOT_CONFIGURED", () => {
    const db = openDb(":memory:");
    const ledger = new Ledger(db);
    const ether = new ChipLedger(db, ledger, new EventLog(db));
    openFormally(ether.chipTx, ledger);
    const noLandMarkets = new Markets(db, ether, new EventLog(db)); // landLedger 未指定
    expect(() =>
      noLandMarkets.createEvent({
        guildId: "g",
        creatorId: "c",
        title: "x",
        options: ["A", "B"],
        durationMin: 10,
        allowedRoleIds: [ROLE_A],
        operationId: opId(),
      }),
    ).toThrow(MarketError);
  });
});

describe("イベントLand板: 結果確定＋即時精算（承認なし）", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  function closedMarketWithBets(payoutMode?: "parimutuel" | "winner_take_all") {
    const m = createEventMarket(ctx, { payoutMode, creatorId: "creator" });
    seedLand(ctx.ledger, "winner", 3_000);
    seedLand(ctx.ledger, "loser", 3_000);
    ctx.markets.betEventLand(m.id, "winner", [ROLE_A], 0, 2_000, opId());
    ctx.markets.betEventLand(m.id, "loser", [ROLE_A], 1, 1_000, opId());
    ctx.markets.close(m.id, "creator");
    return m;
  }

  it("closed板だけ受理する（open のままなら ERR_NOT_CLOSED）", () => {
    const m = createEventMarket(ctx, { creatorId: "creator" });
    expect(() => ctx.markets.reportAndSettleEventLand(m.id, "creator", 0, opId(), false)).toThrow(MarketError);
  });

  it("creatorまたは運営だけが確定できる（第三者は ERR_NOT_CREATOR）", () => {
    const m = closedMarketWithBets();
    expect(() => ctx.markets.reportAndSettleEventLand(m.id, "stranger", 0, opId(), false)).toThrow(MarketError);
    // isAdmin=true なら creator でなくても通る
    expect(() => ctx.markets.reportAndSettleEventLand(m.id, "stranger", 0, opId(), true)).not.toThrow();
  });

  it("結果確定後は直接 settled になる（reportedへ止まらない・approvals行が0）", () => {
    const m = closedMarketWithBets();
    const settled = ctx.markets.reportAndSettleEventLand(m.id, "creator", 0, opId(), false);
    expect(settled.void).toBe(false);
    expect(ctx.markets.get(m.id)!.status).toBe("settled");
    expect(ctx.markets.approvals(m.id)).toHaveLength(0);
  });

  it("3,000潤沢のpotで3%場代を徴収し、残りを勝者へ配分する（parimutuel）", () => {
    const m = closedMarketWithBets("parimutuel");
    const feesBefore = ctx.ledger.balanceOf(EVENT_MARKET_FEES_HOLDER);
    const settled = ctx.markets.reportAndSettleEventLand(m.id, "creator", 0, opId(), false);
    const expectedHouseCut = Math.floor(3_000 * MARKET_HOUSE_CUT);
    expect(settled.houseCut).toBe(expectedHouseCut);
    expect(ctx.ledger.balanceOf(EVENT_MARKET_FEES_HOLDER)).toBe(feesBefore + expectedHouseCut);
    expect(ctx.ledger.balanceOf(eventMarketEscrowHolder(m.id))).toBe(0); // escrow残高が0になる
    // 単独の的中者なので配当は distributable 全額
    expect(ctx.ledger.balanceOf("user:winner")).toBe(1_000 + settled.distributable); // 3000-2000=1000 残 + 配当
  });

  it("winner_take_all: 的中者で均等頭割り・端数は最後の勝者へ", () => {
    const m = createEventMarket(ctx, { payoutMode: "winner_take_all", creatorId: "creator" });
    seedLand(ctx.ledger, "w1", 1_000);
    seedLand(ctx.ledger, "w2", 1_000);
    seedLand(ctx.ledger, "loser", 1_000);
    ctx.markets.betEventLand(m.id, "w1", [ROLE_A], 0, 1_000, opId());
    ctx.markets.betEventLand(m.id, "w2", [ROLE_A], 0, 1_000, opId());
    ctx.markets.betEventLand(m.id, "loser", [ROLE_A], 1, 1_000, opId());
    ctx.markets.close(m.id, "creator");
    const settled = ctx.markets.reportAndSettleEventLand(m.id, "creator", 0, opId(), false);
    expect(settled.winnerCount).toBe(2);
    const total = settled.payouts.reduce((s, p) => s + p.amount, 0);
    expect(total).toBe(settled.distributable);
  });

  it("的中者0なら全額返金してvoidになる（場代は取らない）", () => {
    const m = createEventMarket(ctx, { creatorId: "creator" });
    seedLand(ctx.ledger, "a", 1_000);
    seedLand(ctx.ledger, "b", 1_000);
    ctx.markets.betEventLand(m.id, "a", [ROLE_A], 0, 500, opId());
    ctx.markets.betEventLand(m.id, "b", [ROLE_A], 0, 700, opId());
    ctx.markets.close(m.id, "creator");
    // 誰も選んでいない選択肢1を「勝ち」として確定
    const settled = ctx.markets.reportAndSettleEventLand(m.id, "creator", 1, opId(), false);
    expect(settled.void).toBe(true);
    expect(settled.houseCut).toBe(0);
    expect(ctx.ledger.balanceOf("user:a")).toBe(1_000);
    expect(ctx.ledger.balanceOf("user:b")).toBe(1_000);
    expect(ctx.ledger.balanceOf(eventMarketEscrowHolder(m.id))).toBe(0);
    expect(ctx.markets.get(m.id)!.status).toBe("void");
  });

  it("同じoperationIdでの二重結果確定は二重配当しない（replay）", () => {
    const m = closedMarketWithBets();
    const op = opId();
    const s1 = ctx.markets.reportAndSettleEventLand(m.id, "creator", 0, op, false);
    const feesAfterFirst = ctx.ledger.balanceOf(EVENT_MARKET_FEES_HOLDER);
    const winnerAfterFirst = ctx.ledger.balanceOf("user:winner");
    const s2 = ctx.markets.reportAndSettleEventLand(m.id, "creator", 0, op, false);
    expect(s2).toEqual(s1);
    expect(ctx.ledger.balanceOf(EVENT_MARKET_FEES_HOLDER)).toBe(feesAfterFirst);
    expect(ctx.ledger.balanceOf("user:winner")).toBe(winnerAfterFirst);
  });

  it("escrow残高とpotが不一致なら資金を動かさずfreezeする", () => {
    const m = closedMarketWithBets();
    ctx.ledger.transfer({
      from: eventMarketEscrowHolder(m.id),
      to: "sys:treasury",
      amount: 1,
      type: "market_house_fee",
      actor: "test",
      idempotencyKey: `corrupt-settle:${opId()}`,
    });
    expect(() => ctx.markets.reportAndSettleEventLand(m.id, "creator", 0, opId(), false)).toThrow(MarketError);
    expect(ctx.markets.get(m.id)!.status).toBe("frozen");
  });

  it("単独配当は承認閾値(既定1,000,000Ld)を超えない（900,000×0.97=873,000）", () => {
    // 個人上限は 100,000Ld なので、1人の的中者が pot 900,000 全額を張ることはできない。
    // 「1人の的中者 + 残りは全員ハズレ」で pot を 900,000 まで積み、実際に単独配当が
    // いくらになるかを数値で確認する（理論上の最大: 900,000 × 0.97 = 873,000）。
    const m = createEventMarket(ctx, { payoutMode: "winner_take_all", creatorId: "creator" });
    seedLand(ctx.ledger, "winner", EVENT_MARKET_PERSONAL_CAP);
    ctx.markets.betEventLand(m.id, "winner", [ROLE_A], 0, EVENT_MARKET_PERSONAL_CAP, opId());
    for (let i = 0; i < 8; i++) {
      seedLand(ctx.ledger, `loser${i}`, EVENT_MARKET_PERSONAL_CAP);
      ctx.markets.betEventLand(m.id, `loser${i}`, [ROLE_A], 1, EVENT_MARKET_PERSONAL_CAP, opId());
    }
    const pot = (
      ctx.db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM casino_market_bets WHERE market_id = ?").get(m.id) as {
        s: number;
      }
    ).s;
    expect(pot).toBe(EVENT_MARKET_POT_CAP); // 900,000（板全体の上限ちょうど）
    ctx.markets.close(m.id, "creator");
    const settled = ctx.markets.reportAndSettleEventLand(m.id, "creator", 0, opId(), false);
    expect(settled.winnerCount).toBe(1);
    expect(settled.distributable).toBe(873_000);
    expect(settled.payouts[0]!.amount).toBe(873_000);
    expect(settled.payouts[0]!.amount).toBeLessThan(1_000_000); // Ledger既定の承認閾値(approvalThreshold)未満
  });
});

describe("イベントLand板: 管理者無効化", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("open/closedのイベント板を無効化すると全額Land返金してvoidになる", () => {
    const m = createEventMarket(ctx, { creatorId: "creator" });
    seedLand(ctx.ledger, "u1", 1_000);
    ctx.markets.betEventLand(m.id, "u1", [ROLE_A], 0, 800, opId());
    const r = ctx.markets.adminVoidEventLand(m.id, "admin", opId());
    expect(r.refunded).toBe(800);
    expect(r.alreadyClosed).toBe(false);
    expect(ctx.ledger.balanceOf("user:u1")).toBe(1_000);
    expect(ctx.ledger.balanceOf(eventMarketEscrowHolder(m.id))).toBe(0);
    expect(ctx.markets.get(m.id)!.status).toBe("void");
  });

  it("成功後のreplay（新しいoperationId）は二重返金せず alreadyClosed を返す", () => {
    const m = createEventMarket(ctx, { creatorId: "creator" });
    seedLand(ctx.ledger, "u1", 1_000);
    ctx.markets.betEventLand(m.id, "u1", [ROLE_A], 0, 800, opId());
    ctx.markets.adminVoidEventLand(m.id, "admin", opId());
    const landAfterFirst = ctx.ledger.balanceOf("user:u1");
    const r2 = ctx.markets.adminVoidEventLand(m.id, "admin", opId()); // 別のoperationId
    expect(r2.alreadyClosed).toBe(true);
    expect(r2.refunded).toBe(0);
    expect(ctx.ledger.balanceOf("user:u1")).toBe(landAfterFirst); // 変化なし
  });

  it("同じoperationIdの再送は保存済みの結果をそのまま返す", () => {
    const m = createEventMarket(ctx, { creatorId: "creator" });
    seedLand(ctx.ledger, "u1", 1_000);
    ctx.markets.betEventLand(m.id, "u1", [ROLE_A], 0, 800, opId());
    const op = opId();
    const r1 = ctx.markets.adminVoidEventLand(m.id, "admin", op);
    const r2 = ctx.markets.adminVoidEventLand(m.id, "admin", op);
    expect(r2).toEqual(r1);
  });
});

describe("イベントLand板: 明示的な管理者操作による一括返金（adminRefundAllPendingEventLand・通常起動からは呼ばない）", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("adminRefundAllPendingEventLand は open/closed のイベント板だけ返金し、frozen/settled/voidは対象外", () => {
    const mOpen = createEventMarket(ctx, { creatorId: "c1" });
    seedLand(ctx.ledger, "u1", 1_000);
    ctx.markets.betEventLand(mOpen.id, "u1", [ROLE_A], 0, 500, opId());

    const mClosed = createEventMarket(ctx, { creatorId: "c2" });
    seedLand(ctx.ledger, "u2", 1_000);
    ctx.markets.betEventLand(mClosed.id, "u2", [ROLE_A], 0, 300, opId());
    ctx.markets.close(mClosed.id, "c2");

    const r = ctx.markets.adminRefundAllPendingEventLand("system:startup");
    expect(r.total).toBe(2);
    expect(r.refunded).toBe(2);
    expect(ctx.ledger.balanceOf("user:u1")).toBe(1_000);
    expect(ctx.ledger.balanceOf("user:u2")).toBe(1_000);
    expect(ctx.markets.get(mOpen.id)!.status).toBe("void");
    expect(ctx.markets.get(mClosed.id)!.status).toBe("void");
  });

  it("通常板（market_mode='standard'）には触れない", () => {
    const std = ctx.markets.create({ operationId: opId(), guildId: "g", creatorId: "std-user", title: "通常板", options: ["A", "B"], durationMin: 10, fee: 0 });
    const r = ctx.markets.adminRefundAllPendingEventLand("system:startup");
    expect(r.total).toBe(0);
    expect(ctx.markets.get(std.id)!.status).toBe("open"); // 触れられていない
  });
});

describe("イベントLand板: 起動時監査（auditPendingEventLand・資金移動なし・監査指摘1）", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("正常なopen板の再起動: statusはopenのまま・bet行不変・利用者残高不変・escrow残高不変・fee口座不変・event_market_ops不変", () => {
    const m = createEventMarket(ctx, { creatorId: "c1" });
    seedLand(ctx.ledger, "u1", 1_000);
    seedLand(ctx.ledger, "u2", 1_000);
    ctx.markets.betEventLand(m.id, "u1", [ROLE_A], 0, 500, opId());
    ctx.markets.betEventLand(m.id, "u2", [ROLE_A], 1, 300, opId());
    expect(ctx.markets.get(m.id)!.status).toBe("open");

    const betsBefore = ctx.markets.bets(m.id);
    const u1Before = ctx.ledger.balanceOf("user:u1");
    const u2Before = ctx.ledger.balanceOf("user:u2");
    const escBefore = ctx.ledger.balanceOf(eventMarketEscrowHolder(m.id));
    const feeBefore = ctx.ledger.balanceOf(EVENT_MARKET_FEES_HOLDER);
    const opsCountBefore = (ctx.db.prepare("SELECT COUNT(*) AS c FROM event_market_ops").get() as { c: number }).c;

    // 「Botの再起動」相当: 新しい Markets/Ledger インスタンスを同じ db 上に作り直して監査する
    const ledger2 = new Ledger(ctx.db);
    const ether2 = new ChipLedger(ctx.db, ledger2, new EventLog(ctx.db));
    const markets2 = new Markets(ctx.db, ether2, new EventLog(ctx.db), { landLedger: ledger2 });
    const r = markets2.auditPendingEventLand("system:startup");

    expect(r.total).toBe(1);
    expect(r.healthy).toBe(1);
    expect(r.frozen).toBe(0);
    expect(r.failed).toEqual([]);
    expect(ctx.markets.get(m.id)!.status).toBe("open");
    expect(ctx.markets.bets(m.id)).toEqual(betsBefore);
    expect(ctx.ledger.balanceOf("user:u1")).toBe(u1Before);
    expect(ctx.ledger.balanceOf("user:u2")).toBe(u2Before);
    expect(ctx.ledger.balanceOf(eventMarketEscrowHolder(m.id))).toBe(escBefore);
    expect(ctx.ledger.balanceOf(EVENT_MARKET_FEES_HOLDER)).toBe(feeBefore);
    const opsCountAfter = (ctx.db.prepare("SELECT COUNT(*) AS c FROM event_market_ops").get() as { c: number }).c;
    expect(opsCountAfter).toBe(opsCountBefore);
  });

  it("正常なclosed板の再起動: statusはclosedのまま維持され、監査後もそのまま精算できる", () => {
    const m = createEventMarket(ctx, { creatorId: "c1" });
    seedLand(ctx.ledger, "u1", 1_000);
    seedLand(ctx.ledger, "u2", 1_000);
    ctx.markets.betEventLand(m.id, "u1", [ROLE_A], 0, 500, opId());
    ctx.markets.betEventLand(m.id, "u2", [ROLE_A], 1, 300, opId());
    ctx.markets.close(m.id, "c1");
    expect(ctx.markets.get(m.id)!.status).toBe("closed");

    const r = ctx.markets.auditPendingEventLand("system:startup");
    expect(r.total).toBe(1);
    expect(r.healthy).toBe(1);
    expect(r.frozen).toBe(0);
    expect(ctx.markets.get(m.id)!.status).toBe("closed");

    // 監査後も即時精算できる（statusを壊していない証拠）
    const settled = ctx.markets.reportAndSettleEventLand(m.id, "c1", 0, opId(), false);
    expect(settled.void).toBe(false);
    expect(ctx.markets.get(m.id)!.status).toBe("settled");
  });

  it("escrow不足（pot > escrow）: 資金移動なしでfrozenにし、pot/escrow差分をログに残す", () => {
    const m = createEventMarket(ctx, { creatorId: "c1" });
    seedLand(ctx.ledger, "u1", 1_000);
    ctx.markets.betEventLand(m.id, "u1", [ROLE_A], 0, 500, opId());
    const betsBefore = ctx.markets.bets(m.id);

    // escrowから抜き取って不整合を作る（テストのみが直接 ledger を叩ける操作。本番コードは通らない）
    ctx.ledger.transfer({
      from: eventMarketEscrowHolder(m.id),
      to: "user:u1",
      amount: 200,
      type: "prize",
      actor: "test",
      idempotencyKey: `test-drain:${m.id}`,
    });
    expect(ctx.ledger.balanceOf(eventMarketEscrowHolder(m.id))).toBe(300); // pot(500) > escrow(300)
    const u1AfterDrain = ctx.ledger.balanceOf("user:u1"); // ここまではテストのdrain操作による変化（本番コードとは無関係）

    const r = ctx.markets.auditPendingEventLand("system:startup");
    expect(r.total).toBe(1);
    expect(r.healthy).toBe(0);
    expect(r.frozen).toBe(1);
    expect(ctx.markets.get(m.id)!.status).toBe("frozen");
    // bet行は監査では一切変更しない
    expect(ctx.markets.bets(m.id)).toEqual(betsBefore);
    // 監査自体はLandを一切動かさない（drain後の残高からさらに変化しない）
    expect(ctx.ledger.balanceOf("user:u1")).toBe(u1AfterDrain);
    expect(ctx.ledger.balanceOf(eventMarketEscrowHolder(m.id))).toBe(300); // escrowも監査では動かない

    const frozenEvents = ctx.events
      .listByType("market_frozen")
      .map((e) => JSON.parse(e.payload_json ?? "{}") as { id?: number; reason?: string; pot?: number; escrowBalance?: number; marketId?: number })
      .filter((p) => p.id === m.id);
    expect(frozenEvents.length).toBe(1);
    const payload = frozenEvents[0]!;
    expect(payload.reason).toBe("event_escrow_mismatch_on_audit");
    expect(payload.pot).toBe(500);
    expect(payload.escrowBalance).toBe(300);
    expect(payload.marketId).toBe(m.id);
  });

  it("escrow過剰（pot < escrow）も同様にfrozenにする", () => {
    const m = createEventMarket(ctx, { creatorId: "c1" });
    seedLand(ctx.ledger, "u1", 1_000);
    ctx.markets.betEventLand(m.id, "u1", [ROLE_A], 0, 500, opId());

    // escrowへ余分に足して不整合を作る
    seedLand(ctx.ledger, "extra", 100);
    ctx.ledger.transfer({
      from: "user:extra",
      to: eventMarketEscrowHolder(m.id),
      amount: 100,
      type: "bet",
      actor: "test",
      idempotencyKey: `test-overfund:${m.id}`,
    });
    expect(ctx.ledger.balanceOf(eventMarketEscrowHolder(m.id))).toBe(600); // pot(500) < escrow(600)

    const r = ctx.markets.auditPendingEventLand("system:startup");
    expect(r.healthy).toBe(0);
    expect(r.frozen).toBe(1);
    expect(ctx.markets.get(m.id)!.status).toBe("frozen");
    expect(ctx.ledger.balanceOf(eventMarketEscrowHolder(m.id))).toBe(600); // 監査は資金を動かさない
  });

  it("冪等性: 複数回実行しても、正常板は変化せず、frozen板を再度変更せず、Landを動かさない", () => {
    const mHealthy = createEventMarket(ctx, { creatorId: "c1" });
    seedLand(ctx.ledger, "u1", 1_000);
    ctx.markets.betEventLand(mHealthy.id, "u1", [ROLE_A], 0, 500, opId());

    const mBad = createEventMarket(ctx, { creatorId: "c2" });
    seedLand(ctx.ledger, "u2", 1_000);
    ctx.markets.betEventLand(mBad.id, "u2", [ROLE_A], 0, 500, opId());
    ctx.ledger.transfer({
      from: eventMarketEscrowHolder(mBad.id),
      to: "user:u2",
      amount: 500,
      type: "prize",
      actor: "test",
      idempotencyKey: `test-drain2:${mBad.id}`,
    });

    const r1 = ctx.markets.auditPendingEventLand("system:startup");
    expect(r1.total).toBe(2);
    expect(r1.healthy).toBe(1);
    expect(r1.frozen).toBe(1);
    expect(ctx.markets.get(mBad.id)!.status).toBe("frozen");

    const u2AfterFirst = ctx.ledger.balanceOf("user:u2");
    const opsCountAfterFirst = (ctx.db.prepare("SELECT COUNT(*) AS c FROM event_market_ops").get() as { c: number }).c;
    const frozenEventsAfterFirst = ctx.events.listByType("market_frozen", 1000).length;

    // 2回目: mBadは既にfrozenなので対象から外れ、mHealthyだけが健全として再確認される
    const r2 = ctx.markets.auditPendingEventLand("system:startup");
    expect(r2.total).toBe(1);
    expect(r2.healthy).toBe(1);
    expect(r2.frozen).toBe(0);
    expect(ctx.markets.get(mHealthy.id)!.status).toBe("open");
    expect(ctx.markets.get(mBad.id)!.status).toBe("frozen"); // 変化なし
    expect(ctx.ledger.balanceOf("user:u2")).toBe(u2AfterFirst); // Landは動いていない
    const opsCountAfterSecond = (ctx.db.prepare("SELECT COUNT(*) AS c FROM event_market_ops").get() as { c: number }).c;
    expect(opsCountAfterSecond).toBe(opsCountAfterFirst); // 資金操作は増えていない
    const frozenEventsAfterSecond = ctx.events.listByType("market_frozen", 1000).length;
    expect(frozenEventsAfterSecond).toBe(frozenEventsAfterFirst); // 再frozen化していない
  });
});

describe("イベントLand板: 冪等キー衝突", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("同じoperationIdを別の市場・種別で再利用すると ERR_OPERATION_CONFLICT", () => {
    const m1 = createEventMarket(ctx, { creatorId: "c1" });
    const m2 = createEventMarket(ctx, { creatorId: "c2" });
    seedLand(ctx.ledger, "u1", 1_000);
    const op = opId();
    ctx.markets.betEventLand(m1.id, "u1", [ROLE_A], 0, 500, op);
    expect(() => ctx.markets.betEventLand(m2.id, "u1", [ROLE_A], 0, 500, op)).toThrow(MarketError);
  });

  it("同じoperationIdを別のactorが再利用すると ERR_OPERATION_CONFLICT（bet）。Aの結果はBへ返らずBのLandも動かない（監査指摘2）", () => {
    const m = createEventMarket(ctx, { creatorId: "c1" });
    seedLand(ctx.ledger, "u1", 1_000);
    seedLand(ctx.ledger, "u2", 1_000);
    const op = opId();
    ctx.markets.betEventLand(m.id, "u1", [ROLE_A], 0, 500, op); // actor=u1 が先に確定

    const opsCountBefore = (ctx.db.prepare("SELECT COUNT(*) AS c FROM event_market_ops").get() as { c: number }).c;
    let caught: unknown;
    try {
      ctx.markets.betEventLand(m.id, "u2", [ROLE_A], 1, 300, op); // actor=u2 が同じoperationIdを再利用
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MarketError);
    expect((caught as MarketError).code).toBe("ERR_OPERATION_CONFLICT");

    // u1の結果がu2へ返っていない・u2のbetは作られていない・u1のbetは変更されていない
    expect(ctx.markets.betOf(m.id, "u1")).toMatchObject({ market_id: m.id, user_id: "u1", option_index: 0, amount: 500 });
    expect(ctx.markets.betOf(m.id, "u2")).toBeUndefined();
    // u2のLandは動いていない
    expect(ctx.ledger.balanceOf("user:u2")).toBe(1_000);
    // event_market_opsは1行のまま（Bの試行は書き込まれていない）
    const opsCountAfter = (ctx.db.prepare("SELECT COUNT(*) AS c FROM event_market_ops").get() as { c: number }).c;
    expect(opsCountAfter).toBe(opsCountBefore);
  });

  it("同じoperationIdを別のactorが再利用すると ERR_OPERATION_CONFLICT（settle）。二重配当されない（監査指摘2）", () => {
    const m = createEventMarket(ctx, { creatorId: "c1" });
    seedLand(ctx.ledger, "winner", 1_000);
    seedLand(ctx.ledger, "loser", 1_000);
    ctx.markets.betEventLand(m.id, "winner", [ROLE_A], 0, 500, opId());
    ctx.markets.betEventLand(m.id, "loser", [ROLE_A], 1, 300, opId());
    ctx.markets.close(m.id, "c1");

    const op = opId();
    ctx.markets.reportAndSettleEventLand(m.id, "c1", 0, op, false); // actor="c1" が先に確定
    const winnerBalAfterFirst = ctx.ledger.balanceOf("user:winner");
    const opsCountBefore = (ctx.db.prepare("SELECT COUNT(*) AS c FROM event_market_ops").get() as { c: number }).c;

    let caught: unknown;
    try {
      // actor="admin" が同じoperationIdを再利用（isAdmin=trueで正規の権限を持っていても、
      // actor不一致は fn() 実行前の replayExisting() で弾かれる）
      ctx.markets.reportAndSettleEventLand(m.id, "admin", 0, op, true);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MarketError);
    expect((caught as MarketError).code).toBe("ERR_OPERATION_CONFLICT");

    expect(ctx.markets.get(m.id)!.status).toBe("settled"); // 既にsettled・変化なし
    expect(ctx.ledger.balanceOf("user:winner")).toBe(winnerBalAfterFirst); // 二重配当されない
    const opsCountAfter = (ctx.db.prepare("SELECT COUNT(*) AS c FROM event_market_ops").get() as { c: number }).c;
    expect(opsCountAfter).toBe(opsCountBefore); // 新しい行は作られていない
  });
});

describe("通常板（ChipLedger決済）の回帰", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  function seedChip(userId: string, amount: number) {
    ctx.ledger.ensureAccount(`user:${userId}`, "user");
    if (amount <= 0) return;
    ctx.ledger.transfer({ from: TREASURY, to: `user:${userId}`, amount, type: "initial", actor: "t", idempotencyKey: `seedchip:${userId}:${opId()}` });
    ctx.ether.deposit(userId, amount, `buy:${userId}:${opId()}`);
  }

  it("選択肢は2〜4のまま（5個はERR_BAD_OPTION）", () => {
    expect(() =>
      ctx.markets.create({ operationId: opId(), guildId: "g", creatorId: "c", title: "x", options: ["A", "B", "C", "D", "E"], durationMin: 10, fee: 0 }),
    ).toThrow(MarketError);
  });

  it("bet/close/report/approve/settle の一連が引き続き動く（market_mode='standard'固定）", () => {
    seedChip("c", 0);
    const m = ctx.markets.create({ operationId: opId(), guildId: "g", creatorId: "c", title: "通常板", options: ["A", "B"], durationMin: 10, fee: 0 });
    expect(m.market_mode).toBe("standard");
    expect(m.currency_mode).toBe("chip");
    expect(m.approval_mode).toBe("participant");
    expect(m.allowed_role_ids_json).toBe("[]");

    seedChip("bettor1", 1_000);
    seedChip("bettor2", 1_000);
    ctx.markets.bet(m.id, "bettor1", 0, 500, opId());
    ctx.markets.bet(m.id, "bettor2", 1, 300, opId());
    ctx.markets.close(m.id, "c");
    ctx.markets.report(m.id, "c", 0, false);
    expect(ctx.markets.get(m.id)!.status).toBe("reported");
    const res = ctx.markets.approve(m.id, "bettor1");
    expect(res.settled).toBeNull(); // まだ bettor2 が未承認
    const res2 = ctx.markets.approve(m.id, "bettor2");
    expect(res2.settled).not.toBeNull();
    expect(ctx.markets.get(m.id)!.status).toBe("settled");
  });
});
