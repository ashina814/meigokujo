import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isSeatOccupied } from "./casino/common.js";
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
  ChipLedger,
  ETHER_ESCROW,
  HOUSE_HOLDER,
  Casino,
  CasinoMetrics,
  OpeningPlanner,
  OpeningReset,
  CasinoStatus,
  CasinoIntegrity,
  ChipTx,
  isHumanHeld,
  isPlayerHolder,
  FreeSpins,
  HouseReservations,
  RecoveryRegistry,
  Daily,
  Items,
  Stocks,
  Vip,
  Markets,
  MARKET_FINALIZER,
  PersistentTables,
  RankedTables,
  RankedDisputes,
  Takutate,
  Escrow,
  CasinoChipAssets,
  CasinoChipFlow,
  DailyRisk,
  defaultRng,
  openDb,
  registerDefaultTxTypes,
} from "@meigokujo/core";
import { config } from "./config.js";
import { meetsRoleRequirement } from "./rank-requirement.js";
import { seedSpecialProfiles } from "./special-profile.js";

/**
 * 旧 `services.ether` に残す**読み取り専用の窓**（PR8監査・項目12）。
 *
 * 資金を動かす入口を2つ持つと、片方だけに検証・予約保護・正式開業ロックを足したときに
 * 保護が食い違う。`deposit` / `redeem` / `fundFromAccount` / `redeemToAccount` /
 * `transfer` / `runGroup` / 旧 `buy` `sell` `quoteBuy` `quoteSell` を**型から落として**、
 * `services.ether` 経由では資金が動かせないことをコンパイル時に固定する。
 * 資金操作も残高の読み取りも、production は必ず `services.chips` を使う
 * （PR8監査の時点で `services.ether` の production 参照は 0 件）。
 */
export interface ChipReadonlyView {
  balanceOf(holderId: string): number;
  pool(): number;
  outstanding(): number;
  settleableBalance(holderId: string): number;
  /** 現在の準備口座（opening 状態の読み取り。未知版では例外＝fail-closed） */
  reserveHolder(): string;
}

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
  // 正式開業ロックは `ChipLedger` に組み込まれていて外せない（PR8監査・ブロッカーA）。
  // 「ロックを解除するオプション」も「ロックなしの派生」も存在しないので、
  // ここで有効化し忘れる／うっかり無効化する余地が構造的に無い。
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  // 監査の出発点。導入時のチップ残高と、Land 側の基準（準備プール残高＋境界取引ID）を
  // 一度だけ記録する。ここで基準を持てるのは「まだ何も動いていない」新規DBだけで、
  // すでに版がある既存DBは運営卓の「検算Bの基準を確定」から明示的に置く
  if (
    chipTx.captureLegacyOpening({
      poolLand: ledger.balanceOf(chips.reserveHolder()),
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
  // 獲得済みフリースピンの保留台帳（PR3）。有料スピンの確定と同じトランザクションで積む
  const freeSpins = new FreeSpins(db);
  // 胴元債務予約（PR5）。canAccept が見るのは house 残高ではなく「残高 − 予約合計」になる
  const reservations = new HouseReservations(db, chips, events);
  // 売上精算（redeemFairToAccount）も予約分は出せないようにする。UI ではなく資金処理層で止める
  chips.setReservedProvider((holderId) => (holderId === HOUSE_HOLDER ? reservations.totalReserved() : 0));
  const chipAssets = new CasinoChipAssets(db, chips);
  const dailyRisk = new DailyRisk(db, ledger, chipAssets, {
    openingPhase: () => chipTx.openingPhase(),
    dailyLossLimitBps: () => settings.getNumber("casino_daily_loss_limit_bps"),
    boundaryOffsetMinutes: () => settings.getNumber("casino_daily_boundary_offset_minutes"),
  });
  const casino = new Casino(db, chips, events, {
    fukuScale: () => settings.getNumber("ether_fuku_scale"),
    items,
    reservations,
    dailyRisk,
  });
  const casinoMetrics = new CasinoMetrics(db, chipTx);
  const daily = new Daily(db, chips, events, {
    base: () => settings.getNumber("daily_base"),
    reliefThreshold: () => settings.getNumber("daily_relief_threshold"),
    reliefMax: () => settings.getNumber("daily_relief_max"),
  });
  // Stocks の価格ランダムウォークは共通RNGを使う（テスト時は決定的にできる）
  const stocks = new Stocks(db, chips, events, { rng: defaultRng() });
  const vip = new Vip(db, chips, events, {
    price: () => settings.getNumber("vip_price"),
    days: () => settings.getNumber("vip_days"),
    betCapMult: () => settings.getNumber("vip_bet_cap_mult"),
  });
  // 通算損益は**確定精算のときだけ**記録する（PR3）。
  // 板・競馬・対人卓は「預けた額」と「受け取った額」の差を、精算の資金グループの中で一度だけ足す。
  // 預託中・返金・無効試合は 0（対局中に通算負けが増えたり、全額返金で両方が膨らんだりしない）
  const recordPlayerNet = (userId: string, net: number) => {
    if (isPlayerHolder(userId)) casino.recordGameNet(userId, net);
  };
  // イベントLand板（緊急イベント用 hotfix・PR12とは独立）は生の Ledger（landLedger）を直接使う。
  // 通常板の資金経路（ChipLedger 経由の `ether`）とは完全に分離したまま渡す。
  const markets = new Markets(db, chips, events, { onPlayerNet: recordPlayerNet, landLedger: ledger });
  // 起動時: イベントLand板の未精算（open/closed）分を**監査するだけ**（資金は一切動かさない）。
  // recoverCasino()（chip 経済専用）とは独立の監査経路。Land はカジノチップ経済と別レイヤーで、
  // liveEscrowHolders() の孤児検出（chip 側）にも含めていないため、ここで明示的に呼ぶ必要がある。
  //
  // 監査指摘1（PR#94独立監査）: 以前はここで adminRefundAllPendingEventLand()（旧名
  // refundAllPendingEventLand）を無条件に呼んでいたため、deploy・クラッシュ・自動再起動の
  // たびに正常な進行中イベント板まで全額返金・void化されてしまっていた。通常のBot起動経路
  // では資金を動かさない auditPendingEventLand() だけを呼ぶ。escrow残高とbet合計が一致する
  // 健全な板は open/closed のまま継続し、不一致の板だけ資金移動なしで frozen にする。
  {
    const eventAudit = markets.auditPendingEventLand(MARKET_FINALIZER);
    if (eventAudit.total > 0) {
      console.log(
        `[event-market] 起動時イベント板の監査: 対象${eventAudit.total}件 健全${eventAudit.healthy}件 凍結${eventAudit.frozen}件`,
      );
    }
    if (eventAudit.failed.length > 0) {
      console.error(
        `[event-market] 起動時イベント板の監査に失敗: ` + eventAudit.failed.map((f) => `#${f.id}: ${f.error}`).join(" / "),
      );
    }
  }
  const escrow = new Escrow(db, chips, events, { onPlayerNet: recordPlayerNet });
  const persistentTables = new PersistentTables(db, events, { openingPhase: () => chipTx.openingPhase() });
  // 所有判定の正本をここで一本化する。プロセス内の着席は DB のどの表にも
  // 現れないので、渡さないとショップの域外確認票がゲーム中の自由チップを
  // Land へ戻せてしまう（監査ブロッカー・項目11）
  const chipFlow = new CasinoChipFlow(db, chips, events, chipAssets, { isSeatOccupied });
  const rankedDisputes = new RankedDisputes(db, chips, escrow, persistentTables, reservations, events, {
    openingPhase: () => chipTx.openingPhase(),
    onPlayerNet: recordPlayerNet,
    dailyRisk,
  });
  const rankedTables = new RankedTables(db, chips, escrow, persistentTables, events, casinoMetrics, {
    chipFlow,
    isSoloSeatOccupied: isSeatOccupied,
    reservations,
    disputes: rankedDisputes,
    dailyRisk,
    superHighEnabled: () => settings.getNumber("casino_super_high_enabled") === 1,
    extremeEnabled: () => settings.getNumber("casino_extreme_enabled") === 1,
    highCooldownSec: () => {
      const raw = settings.getString("casino_ranked_high_cooldown_sec");
      if (raw === undefined) return null;
      const parsed = Number(raw);
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    },
  });
  const takutate = new Takutate(db, events);
  const casinoIntegrity = new CasinoIntegrity(db, ledger, chips, escrow, chipAssets);
  const openingPlanner = new OpeningPlanner({ db, ledger, chips, chipAssets, integrity: casinoIntegrity, status: casinoStatus, settings, departments });
  const openingReset = new OpeningReset({ db, ledger, chips, chipAssets, integrity: casinoIntegrity, status: casinoStatus, settings, departments });
  // 起動時: 全点検 → 通ったときだけ掃除 → 掃除後にもう一度全点検 → 開ける
  // 起動・復旧（正本 §8.2 S1〜S9, S12）。**所有元が「生きている預託」を自分で申告する**。
  // 板だけを登録し、競馬は登録しない（永続テーブルが無く、再起動でレースごと消えるので
  // その預託は孤児として返金するのが正しい）。PR20 で対人卓を同じ形で足す。
  const recoveryRegistry = new RecoveryRegistry();
  recoveryRegistry.register({ type: "market", listLiveEscrowHolders: () => markets.liveEscrowHolders() });
  recoveryRegistry.register({ type: "table", listLiveEscrowHolders: () => persistentTables.liveEscrowHolders() });
  // 賭博結果の乱数は crypto ベースを共通で使う。テスト時は上書き注入可能（services 型は同じ）。
  const rng = defaultRng();
  // 資金を動かす経路は `chips` に一本化した（PR8監査・項目12）。`ether` は
  // 旧名称で書かれた外部プラグイン・古い呼び出しが**読むだけ**なら壊れないように
  // 残す互換窓で、型を `ChipReadonlyView` に狭めてある（下の注釈参照）。
  const services = { db, settings, ledger, payroll, migration, events, entry, sessions, vc, tickets, chipTx, confessions, evaluation, vcRewards, rooms, titles, departments, fiscal, ranks, bumps, shop, chips, ether: chips as ChipReadonlyView, chipAssets, chipFlow, dailyRisk, casino, casinoMetrics, casinoStatus, casinoIntegrity, openingPlanner, openingReset, daily, items, stocks, vip, markets, escrow, persistentTables, rankedTables, rankedDisputes, takutate, freeSpins, reservations, recoveryRegistry, rng };
  // 特別プロフィール（魔王など）の初期シード。未設定時のみ既定を投入し、以後は運営ボードで変更可
  seedSpecialProfiles(services);
  return services;
}

export type Services = ReturnType<typeof buildServices>;
