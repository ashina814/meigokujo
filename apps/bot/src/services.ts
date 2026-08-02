import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  Departments,
  Entry,
  SessionCalendar,
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
  ETHER_ESCROW,
  Casino,
  CasinoStatus,
  CasinoIntegrity,
  ChipTx,
  isHumanHeld,
  isPlayerHolder,
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
  // 説明会の開催予定（通常枠 × 日付ごとの例外）。案内・通知・ボードは全部ここを見る
  const sessions = new SessionCalendar(db, settings, events);
  const vc = new VcTracker(db);
  const tickets = new Tickets(db, events);
  if (tickets.migrationResult.deletedLegacyTickets > 0) {
    console.warn(`[ticket] 旧式チケットを ${tickets.migrationResult.deletedLegacyTickets} 件削除しました（受付パネル設定は保持）`);
  }
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
  // 賭場の取引監査。全サービスで同じインスタンスを共有する（実行中グループを共有するため）
  const chipTx = new ChipTx(db);
  const ether = new EtherExchange(db, ledger, events, {
    baseRate: () => settings.getNumber("ether_rate_base"),
    chipTx,
  });
  // 監査の出発点。導入時のチップ残高と、Land 側の基準（準備プール残高＋境界取引ID）を
  // 一度だけ記録する。ここで基準を持てるのは「まだ何も動いていない」新規DBだけで、
  // すでに版がある既存DBは運営卓の「検算Bの基準を確定」から明示的に置く
  if (
    chipTx.captureLegacyOpening({
      poolLand: ledger.balanceOf(ETHER_ESCROW),
      fromLedgerTxId: ledger.lastTransactionId(),
    })
  ) {
    console.log("[賭場] 取引監査の開始残高を記録しました（legacy_pre_reset）");
  }
  // 賭場の稼働状態。open 以外では**資金グループそのものが作れない**ようにここで繋ぐ
  // （Discord の入口ガードだけだと、進行中のゲーム・scheduler・運営卓を止められない）
  const casinoStatus = new CasinoStatus(db);
  chipTx.setClosedReason(() => casinoStatus.denyMessage());
  // お守りは精算と同じグループで消費する（Casino.settleSolo）。そのため casino より先に作る
  const items = new Items(db);
  const casino = new Casino(db, ether, events, {
    fukuScale: () => settings.getNumber("ether_fuku_scale"),
    items,
  });
  const daily = new Daily(db, ether, events, {
    base: () => settings.getNumber("daily_base"),
    reliefThreshold: () => settings.getNumber("daily_relief_threshold"),
    reliefMax: () => settings.getNumber("daily_relief_max"),
  });
  // Stocks の価格ランダムウォークは共通RNGを使う（テスト時は決定的にできる）
  const stocks = new Stocks(db, ether, events, { rng: defaultRng() });
  const vip = new Vip(db, ether, events, {
    price: () => settings.getNumber("vip_price"),
    days: () => settings.getNumber("vip_days"),
    betCapMult: () => settings.getNumber("vip_bet_cap_mult"),
  });
  const markets = new Markets(db, ether, events);
  // 対人卓の預託・返金・精算も「通算損益」に載せる（PR3）。
  // 預託で −amount、返金・配当で +amount なので、返金しかされなかった卓は差引0になる。
  // 胴元・JP・救済・隔離への配分は利用者の損益ではないので `isPlayerHolder` で落とす
  const escrow = new Escrow(db, ether, events, {
    onHolderNet: (holderId, net) => {
      if (isPlayerHolder(holderId)) casino.recordGameNet(holderId, net);
    },
  });
  const takutate = new Takutate(db, events);
  const casinoIntegrity = new CasinoIntegrity(db, ledger, ether, escrow);
  // 起動時: 全点検 → 通ったときだけ掃除 → 掃除後にもう一度全点検 → 開ける
  runCasinoStartup(casinoStatus, casinoIntegrity, chipTx, events, () => sweepCasinoOnBoot(markets, escrow));
  // 賭博結果の乱数は crypto ベースを共通で使う。テスト時は上書き注入可能（services 型は同じ）。
  const rng = defaultRng();
  const services = { db, settings, ledger, payroll, migration, events, entry, sessions, vc, tickets, chipTx, confessions, evaluation, vcRewards, rooms, titles, departments, fiscal, ranks, bumps, shop, ether, casino, casinoStatus, casinoIntegrity, daily, items, stocks, vip, markets, escrow, takutate, rng };
  // 特別プロフィール（魔王など）の初期シード。未設定時のみ既定を投入し、以後は運営ボードで変更可
  seedSpecialProfiles(services);
  return services;
}

export type Services = ReturnType<typeof buildServices>;

/** 起動時の掃除（未精算の板とエスクローの返金）。`runMaintenance` の中からだけ呼ばれる */
function sweepCasinoOnBoot(markets: Markets, escrow: Escrow): void {
  const marketSweep = markets.refundAllPending("system:startup");
  if (marketSweep.refunded > 0) {
    console.log(`[market] 起動時に未精算板 ${marketSweep.refunded}/${marketSweep.total}件 を返金＆void 化`);
  }
  if (marketSweep.failed.length > 0) {
    // underfunded/overfunded/mismatch などで返金に失敗した板は frozen に変更済み。
    // frozen 板は新規ベットを受け付けず、帳簿とエスクロー残高を保持したまま手動調査を待つ。
    // escrow.sweepAll() は frozen 板を孤児として隔離しない（所有者情報が casino_market_bets に残るため）。
    console.warn(
      `[market] 起動時 refund 失敗 ${marketSweep.failed.length}件 → frozen へ変更（帳簿・残高を保持し手動調査）: ${marketSweep.failed
        .map((f) => `#${f.id}(${f.error})`)
        .join(", ")}`,
    );
  }
  // 起動時にセッション型ゲーム（対人・競馬・丁半・PvPポーカー等）の預かり残をセッション単位で返金
  const swept = escrow.sweepAll("system:startup");
  if (swept.refundedUsers > 0) {
    console.log(
      `[escrow] 起動時に未精算エスクロー ${swept.refundedSessions}/${swept.totalSessions}卓・${swept.refundedUsers}人分（計 ${swept.refundedTotal.toLocaleString("ja-JP")}◈）を返金`,
    );
  }
  if (swept.failed.length > 0) {
    // 帳簿と保有者残高が乖離して返金できなかったセッション。house 補填せず帳簿を保持した。要調査
    console.warn(
      `[escrow] 返金失敗セッション ${swept.failed.length}件（他セッションは正常返金・Bot 起動は継続）: ${swept.failed
        .map((f) => `${f.sessionId}(帳簿${f.expected}/保有${f.actual})`)
        .join(", ")}`,
    );
  }
  if (swept.orphans > 0) {
    // 帳簿と保有者残高が乖離した孤児残高。house へ吸い上げず隔離した。要調査
    console.warn(
      `[escrow] 孤児残高 ${swept.orphans}件 (計 ${swept.orphanTotal.toLocaleString("ja-JP")}◈) を sys:escrow:quarantine へ隔離。監査ログを確認して手動対応してください。`,
    );
  }
}

/**
 * 起動時の手順（仕様書 S1〜S2 / 実装計画 PR2）。
 *
 * ```
 * 全点検（Land台帳 + 検算A〜D）
 *   → 通ったときだけ、許可された掃除（未精算の板・エスクローの返金）
 *   → 掃除のあとにもう一度 全点検
 *   → 通れば startup_check だけを解除して開ける
 * ```
 *
 * 掃除より**先に**点検するのは、壊れた帳簿の上で自動返金を走らせないため。
 * 人が止めている状態（手動停止・改装中・開業準備中）では**資金を1 Ld も動かさず**、
 * 検算NGを見つけても状態を `integrity_halt` で上書きしない（止めた理由がすり替わる）。
 * 見つけた不整合は別途 events と監査ログに残す。
 */
function runCasinoStartup(
  status: CasinoStatus,
  integrity: CasinoIntegrity,
  chipTx: ChipTx,
  events: EventLog,
  sweep: () => void,
): void {
  const held = status.current();
  const preflight = integrity.runFull();
  if (!preflight.ok) recordIntegrityFailure(events, preflight, "preflight");

  if (isHumanHeld(held.status)) {
    // 人が止めている＝掃除も再開もしない。点検結果だけ記録して起動を続ける
    console.warn(
      `[賭場] ${held.status} のため起動時の掃除を行いません（理由: ${held.reason}）。` +
        (preflight.ok ? "" : ` 検算NGも見つかっています: ${CasinoIntegrity.describeFailure(preflight)}`),
    );
    return;
  }
  if (!preflight.ok) {
    const reason = CasinoIntegrity.describeFailure(preflight);
    status.haltForIntegrity(reason);
    console.error(`[賭場] 起動時の点検に失敗したため、掃除も行わず賭場を停止しました: ${reason}`);
    return;
  }
  if (held.status === "integrity_halt") {
    // 検算は通っているが、人がまだ確認していない。掃除も再開も自動ではしない
    console.warn("[賭場] integrity_halt のままです。検算は通っているので、運営卓の「再点検」で開けてください");
    return;
  }

  status.beginStartupCheck();
  // 掃除は停止中でも資金を動かす唯一の経路。actor 名ではなくこの区間だけが許可される
  chipTx.runMaintenance("起動時の未精算返金", sweep);

  const postflight = integrity.runFull();
  if (!postflight.ok) {
    const reason = CasinoIntegrity.describeFailure(postflight);
    recordIntegrityFailure(events, postflight, "postflight");
    status.haltForIntegrity(reason);
    console.error(`[賭場] 起動時の掃除後の点検に失敗したため賭場を停止しました: ${reason}`);
    return;
  }
  if (status.finishStartupCheck()) {
    console.log("[賭場] 起動時の点検（Land台帳 + 検算A〜D）は正常。営業を開けました");
  }
}

/** 検算NGを状態とは別に記録する（人が止めている状態でも取りこぼさないため） */
function recordIntegrityFailure(events: EventLog, report: ReturnType<CasinoIntegrity["runFull"]>, phase: string): void {
  events.log("casino_integrity_failed", {
    actor: "system:integrity",
    payload: {
      phase,
      ledgerOk: report.ledger.ok,
      failed: report.failed,
      detail: CasinoIntegrity.describeFailure(report),
    },
  });
}
