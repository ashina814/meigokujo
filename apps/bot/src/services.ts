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
  Confessions,
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
  Vip,
  Markets,
  Takutate,
  Escrow,
  defaultRng,
  openDb,
  registerDefaultTxTypes,
} from "@meigokujo/core";
import { config } from "./config.js";
import { meetsRoleRequirement } from "./rank-requirement.js";
import { seedSpecialProfiles } from "./special-profile.js";

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
    // 未成年判定は使わない方針。Ledger 側の minorBlocked 種別は宣言されているが
    // isMinor() 未接続なので常に成人扱い（＝実質 no-op）。
    // 冥獄城の Land/エテルはサーバー内独自通貨で外部換金しないため、賭場に年齢制限を敷かない。
  });
  const payroll = new Payroll(db, ledger);
  const migration = new Migration(db, ledger);
  const events = new EventLog(db);
  const entry = new Entry(db, ledger, settings, events);
  const vc = new VcTracker(db);
  const tickets = new Tickets(db, events);
  const confessions = new Confessions(db, events);
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
  // 階級要件は「〇〇以上」判定（亡霊 < 魔人 < 魔族。上位階級は下位要件の商品を買える）
  const shop = new Shop(db, ledger, events, {
    roleCheck: (memberRoleIds, requireRoleId) => meetsRoleRequirement(settings, memberRoleIds, requireRoleId),
  });
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
  // Stocks の価格ランダムウォークは共通RNGを使う（テスト時は決定的にできる）
  const stocks = new Stocks(db, ether, events, { rng: defaultRng() });
  const vip = new Vip(db, ether, events, {
    price: () => settings.getNumber("vip_price"),
    days: () => settings.getNumber("vip_days"),
    betCapMult: () => settings.getNumber("vip_bet_cap_mult"),
  });
  const markets = new Markets(db, ether, events);
  // 起動時に未精算の板を全部返金＆void（エスクロー整合維持）
  const marketSweep = markets.refundAllPending("system:startup");
  if (marketSweep.refunded > 0) {
    console.log(`[market] 起動時に未精算板 ${marketSweep.refunded}/${marketSweep.total}件 を返金＆void 化`);
  }
  if (marketSweep.failed.length > 0) {
    // underfunded escrow などで返金に失敗した板。監査ログを見て手動対応する。
    // この後 escrow.sweepAll() が escrow:market:<id> の残高を隔離するので二重補填にはならない。
    console.warn(
      `[market] 起動時 refund 失敗 ${marketSweep.failed.length}件: ${marketSweep.failed.map((f) => `#${f.id}(${f.error})`).join(", ")}`,
    );
  }
  const escrow = new Escrow(db, ether, events);
  // 起動時にセッション型ゲーム（対人・競馬・丁半・PvPポーカー等）の預かり残を全額返金
  const swept = escrow.sweepAll("system:startup");
  if (swept.users > 0) {
    console.log(`[escrow] 起動時に未精算エスクロー ${swept.sessions}卓/${swept.users}人分（計 ${swept.total.toLocaleString("ja-JP")}◈）を返金`);
  }
  if (swept.orphans > 0) {
    // 帳簿と保有者残高が乖離した孤児残高。house へ吸い上げず隔離した。要調査
    console.warn(
      `[escrow] 孤児残高 ${swept.orphans}件 (計 ${swept.orphanTotal.toLocaleString("ja-JP")}◈) を sys:escrow:quarantine へ隔離。監査ログを確認して手動対応してください。`,
    );
  }
  const takutate = new Takutate(db, events);
  // 賭博結果の乱数は crypto ベースを共通で使う。テスト時は上書き注入可能（services 型は同じ）。
  const rng = defaultRng();
  const services = { db, settings, ledger, payroll, migration, events, entry, vc, tickets, confessions, evaluation, vcRewards, rooms, titles, departments, fiscal, ranks, bumps, shop, ether, casino, daily, items, stocks, vip, markets, escrow, takutate, rng };
  // 特別プロフィール（魔王など）の初期シード。未設定時のみ既定を投入し、以後は運営ボードで変更可
  seedSpecialProfiles(services);
  return services;
}

export type Services = ReturnType<typeof buildServices>;
