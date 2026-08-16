import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";
import {
  CASINO_METRIC_EVENT_TYPES,
  CASINO_TABLE_CLASSIFICATION,
  HOUSE_HOLDER,
  HouseReservations,
  EventLog,
  ChipLedger,
  ChipTx,
  Ledger,
  openDb,
  classifyHousePnlTx,
  registerDefaultTxTypes,
} from "../src/index.js";

registerDefaultTxTypes();

/**
 * 対人順位卓・異議裁定・賭博場従業員の**不存在**を固定する。
 *
 * 退役した機能は「消えたこと」を確認しないと、後から別タスクの実装や
 * AI セッションが旧設計を現行APIとして拾って復活させてしまう。
 * 存在確認ではなく不存在確認をテストにしておく。
 *
 * 旧設計は Git タグ `archive/casino-ranked-before-retirement-20260816` にのみ残る。
 */
describe("退役した対人順位卓が現行APIへ戻っていない", () => {
  const RETIRED_EXPORTS = [
    "RankedTables",
    "RankedTableError",
    "RankedDisputes",
    "RankedDisputeError",
    "RankedProfiles",
    "RankedProfileError",
    "PersistentTables",
    "PersistentTableError",
    "RANKED_TABLE_TIERS",
    "RANKED_PROFILES",
    "EMPLOYEE_OPERABLE_TIER_KEYS",
    "rankedReceipts",
    "rankedFeeReservationKey",
    "RANKED_FEE_RESERVATION_SCOPE",
    "feeForBaseAmount",
    "validateRankProfile",
    "recoverCasinoAsync",
  ] as const;

  /** 型だけの退役シンボル（実行時 export に現れないので原文で確認する） */
  const RETIRED_TYPE_NAMES = ["DailyRiskTableExposure"] as const;

  it("core が順位卓のシンボルを一切 export しない", () => {
    const exported = new Set(Object.keys(core));
    for (const name of RETIRED_EXPORTS) {
      expect(exported.has(name), `${name} が再び export されている`).toBe(false);
    }
  });

  it("退役した型・メソッドが core の原文に残っていない", () => {
    const index = readFileSync(new URL("../src/index.js".replace(".js", ".ts"), import.meta.url), "utf8");
    for (const name of RETIRED_TYPE_NAMES) {
      expect(index, `${name} が再び export されている`).not.toContain(name);
    }
    // 順位卓専用だった参加認可。露出型は authorizeExposure が担う
    const dailyRisk = readFileSync(new URL("../src/casino/daily-risk.ts", import.meta.url), "utf8");
    expect(dailyRisk).not.toContain("authorizeTableJoin");
    expect(dailyRisk).not.toContain("table_join_risk");
    expect(dailyRisk).not.toContain("ranked join requires");
    // 現役の露出型経路は残っていること（消しすぎの検知）
    expect(dailyRisk).toContain("authorizeExposure");
    expect(dailyRisk).toContain("settleExposure");
    expect(dailyRisk).toContain("exposure_result");
  });

  it("recoverCasino が S11 の restore provider を受け付けない", () => {
    const source = readFileSync(new URL("../src/casino/recovery.ts", import.meta.url), "utf8");
    expect(source).not.toContain("persistentTableRestore");
    expect(source).not.toContain("S11:persistent_table_restore");
    expect(source).not.toContain("recoverCasinoAsync");
  });

  it("計測の現行イベント型に卓イベントが無い", () => {
    for (const retired of ["table_open", "table_join", "table_start", "table_settle", "table_dispute"]) {
      expect(CASINO_METRIC_EVENT_TYPES as readonly string[]).not.toContain(retired);
    }
  });

  it("退役スコープでは新規予約を取れない", () => {
    const db = openDb(":memory:");
    const ledger = new Ledger(db);
    const events = new EventLog(db);
    const chipTx = new ChipTx(db);
    const chips = new ChipLedger(db, ledger, events, { chipTx });
    const reservations = new HouseReservations(db, chips, events);
    expect(() =>
      reservations.reserve("k", 1_000, "ranked_fee_refund", "table:t1", "persistent_table_fee_refund" as never),
    ).toThrow();
    db.close();
  });

  it("退役した順位卓由来の house 収支を営業収入として受け入れない", () => {
    // `table_settle` / `table_refund` という group kind 自体は /勝負・競馬で現役。
    // ただし現行経路では house を動かさない（場代は jackpot 行き）ので、
    // house を動かす table_* が来たら旧順位卓由来として fail-closed にする。
    for (const groupKind of ["table_start", "table_settle", "table_fee_refund", "table_refund"]) {
      const classified = classifyHousePnlTx({ group_kind: groupKind, from_holder: HOUSE_HOLDER, to_holder: "user:u1", amount: 100 });
      expect(classified.kind, `${groupKind} の house 取引が既知扱いになっている`).toBe("unclassified");
    }
  });

  it("現役ゲームの営業収入分類は残っている（消しすぎの検知）", () => {
    for (const groupKind of ["solo_game", "daily", "vip", "shop"]) {
      const classified = classifyHousePnlTx({ group_kind: groupKind, from_holder: "user:u1", to_holder: HOUSE_HOLDER, amount: 100 });
      expect(classified, `${groupKind} の分類が落ちている`).toEqual({ kind: "operating", amount: 100 });
    }
  });

  it("正式開業のテーブル分類に退役スキーマが載っていない", () => {
    const classified = new Set(CASINO_TABLE_CLASSIFICATION.map((row) => row.table));
    for (const retired of [
      "casino_tables",
      "casino_table_participants",
      "casino_table_disputes",
      "casino_table_dispute_assignments",
      "casino_table_evidence",
      "casino_ranked_match_history",
      "casino_table_message_sync_outbox",
      "casino_ranked_profiles",
      "casino_ranked_open_history",
    ]) {
      expect(classified.has(retired), `${retired} が既知テーブルとして復活している`).toBe(false);
    }
  });
});
