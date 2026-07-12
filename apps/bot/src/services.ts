import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  Departments,
  Entry,
  Fiscal,
  Evaluation,
  EventLog,
  Ledger,
  Migration,
  Payroll,
  Settings,
  Rooms,
  Tickets,
  TitleEngine,
  VcRewards,
  VcTracker,
  RankEngine,
  BumpCounter,
  Shop,
  EtherExchange,
  Casino,
  Daily,
  Items,
  Stocks,
  openDb,
  registerDefaultTxTypes,
} from "@meigokujo/core";
import { config } from "./config.js";

/**
 * コアサービスの組み立て。アプリ層は薄く、ロジックは全て core 側（システム設計.md の原則）。
 */
export function buildServices() {
  if (config.dbPath !== ":memory:") {
    mkdirSync(dirname(config.dbPath), { recursive: true });
  }
  registerDefaultTxTypes();
  const db = openDb(config.dbPath);
  const settings = new Settings(db);
  const ledger = new Ledger(db, {
    // 関数で渡す＝ /設定 での変更が再起動なしで反映される
    approvalThreshold: () => settings.getNumber("approval_threshold"),
  });
  const payroll = new Payroll(db, ledger);
  const migration = new Migration(db, ledger);
  const events = new EventLog(db);
  const entry = new Entry(db, ledger, settings, events);
  const vc = new VcTracker(db);
  const tickets = new Tickets(db, events);
  const evaluation = new Evaluation(db, settings, events);
  const vcRewards = new VcRewards(db, settings);
  const rooms = new Rooms(db, ledger, settings, events);
  // クラッシュで閉じ損ねたVCセグメントの後始末
  const dangling = vc.closeAllDangling();
  if (dangling > 0) console.warn(`[vc] 閉じ損ねセグメントを ${dangling} 件補正しました`);
  const titles = new TitleEngine(db, vc);
  const departments = new Departments(db, ledger);
  const fiscal = new Fiscal(db, ledger);
  const ranks = new RankEngine(db);
  const bumps = new BumpCounter(db);
  const shop = new Shop(db, ledger, events);
  const ether = new EtherExchange(db, ledger, events, {
    baseRate: () => settings.getNumber("ether_rate_base"),
  });
  const casino = new Casino(db, ether, events, {
    fukuScale: () => settings.getNumber("ether_fuku_scale"),
  });
  const daily = new Daily(db, ether, events, {
    base: () => settings.getNumber("daily_base"),
    reliefThreshold: () => settings.getNumber("daily_relief_threshold"),
    reliefMax: () => settings.getNumber("daily_relief_max"),
  });
  const items = new Items(db);
  const stocks = new Stocks(db, ether, events);
  return { db, settings, ledger, payroll, migration, events, entry, vc, tickets, evaluation, vcRewards, rooms, titles, departments, fiscal, ranks, bumps, shop, ether, casino, daily, items, stocks };
}

export type Services = ReturnType<typeof buildServices>;
