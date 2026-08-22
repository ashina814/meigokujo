import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isSeatOccupied } from "./casino/common.js";
import { createFundedEscrow, createSoloLiquidityViews, createSpendableChipLedger } from "./casino/spendable-wallet.js";
import {
  Departments,
  Entry,
  Returns,
  SessionCalendar,
  Fiscal,
  Evaluation,
  EventLog,
  Ledger,
  Migration,
  Nicknames,
  OriginalRoles,
  OriginalRoleCases,
  SubAccounts,
  Payroll,
  Settings,
  Rooms,
  Tickets,
  Confessions,
  TitleEngine,
  TitleV2Store,
  VcRewards,
  VcTracker,
  RankEngine,
  BumpCounter,
  TextActivity,
  PublicEvents,
  CasinoParticipationHistory,
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
 * 資金操作も残高の読み取りも、production は必ず `services.chips` を使う。
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
  // 名前（サーバーニックネーム）の正本。入城パネルと商館の改名が同じ規則を通る
  const nicknames = new Nicknames(db, events);
  // オリジナルロール（申請 → 承認 → 支払い → 作成・付与 → 30日契約）
  const originalRoles = new OriginalRoles(db, ledger, events);
  const originalRoleCases = new OriginalRoleCases(db, events);
  const subAccounts = new SubAccounts(db, events);
  // 出戻り（退出→再参加→申請→運営判断）。入城処理とは別の意味論として分けてある
  const returns = new Returns(db, settings, events);
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
  // v2称号基盤（PR A〜C2）の新規service。旧`titles`（TitleEngine）は置換しない——
  // 既存productionの正本はそのまま`titles`が持ち続ける。PR D2時点ではrank_title_unlocks
  // のlive/reconcile wiringだけがこれを使う。SYSTEM_EPOCH/CATALOG_EPOCHは未施行のままで
  // よい（rank title identityはbehavior title catalogとは別のsubsystem、clockはdefault
  // Store clockのままでBot側からtimestampをinjectしない）。
  const titleV2 = new TitleV2Store(db);
  const departments = new Departments(db, ledger);
  const fiscal = new Fiscal(db, ledger);
  const ranks = new RankEngine(db);
  const bumps = new BumpCounter(db);
  // TC安全source（PR E1）。rank_text（XP/level/cooldown）とは独立したsubsystem——
  // raw message数もmessage内容も保存しない。既存servicesを置換しない。
  const textActivity = new TextActivity(db);
  // 公開イベント運営ドメイン（PR E3）。称号v2専用ログではない——運営が確定した公開
  // イベントrosterの正本。generic EventLog（events）は置換しない。
  const publicEvents = new PublicEvents(db);
  // 賭場のneutral participation正本（PR E4）。CasinoMetrics（後述、wager/payout/net
  // を持つanalytics正本）とは完全に別module——「どの遊戯へ参加したか」だけを持つ。
  const casinoParticipation = new CasinoParticipationHistory(db);
  // 階級要件は「〇〇以上」判定（亡霊 < 魔人 < 魔族。上位階級は下位要件の商品を買える）
  const shop = new Shop(db, ledger, events, {
    roleCheck: (memberRoleIds, requireRoleId) => meetsRoleRequirement(settings, memberRoleIds, requireRoleId),
    reevalItemId: () => {
      const id = Number(settings.getString("shop:reeval_item_id"));
      return Number.isSafeInteger(id) && id > 0 ? id : null;
    },
    originalRoleItemId: () => {
      const id = Number(settings.getString("shop:original_role_item_id"));
      return Number.isSafeInteger(id) && id > 0 ? id : null;
    },
    assertOriginalRolePayable: (applicationId, userId) => {
      originalRoles.assertPayable(applicationId, userId);
    },
    departments,
  });

  // 賭場の取引監査。全サービスで同じ raw ChipLedger / ChipTx を共有する。
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  if (
    chipTx.captureLegacyOpening({
      poolLand: ledger.balanceOf(chips.reserveHolder()),
      fromLedgerTxId: ledger.lastTransactionId(),
    })
  ) {
    console.log("[賭場] 取引監査の開始残高を記録しました（legacy_pre_reset）");
  }

  // 賭場の稼働状態。open 以外では資金グループそのものを作らせない。
  const casinoStatus = new CasinoStatus(db);
  chipTx.setClosedReason(() => casinoStatus.denyMessage());

  const items = new Items(db);
  const freeSpins = new FreeSpins(db);
  const reservations = new HouseReservations(db, chips, events);
  chips.setReservedProvider((holderId) => (holderId === HOUSE_HOLDER ? reservations.totalReserved() : 0));

  // raw のチップ資産・入出金サービスを先に作る。自動預入はこの正本だけを使う。
  const chipAssets = new CasinoChipAssets(db, chips);
  const chipFlow = new CasinoChipFlow(db, chips, events, chipAssets, { isSeatOccupied });
  const spendableChips = createSpendableChipLedger(chips, ledger, chipFlow);

  // DailyRisk は Land + 自由チップを自前で合算するため raw chipAssets を使い続ける。
  const dailyRiskCore = new DailyRisk(db, ledger, chipAssets, {
    openingPhase: () => chipTx.openingPhase(),
    dailyLossLimitBps: () => settings.getNumber("casino_daily_loss_limit_bps"),
    boundaryOffsetMinutes: () => settings.getNumber("casino_daily_boundary_offset_minutes"),
  });
  // validateBet の「maxPlayerLoss判定」と「capacity通過後のensureFreeChips」を橋渡しし、
  // BJダブル/ホールデムコール等の途中増額も開始時に自由チップで裏付ける。
  const soloLiquidity = createSoloLiquidityViews(dailyRiskCore, chipFlow);

  // 利用者が支払う core サービスには「通常Land + 自由チップ」の互換窓を渡す。
  // system holder は proxy 内で raw 残高のままなので、house / JP / relief の意味は変わらない。
  const casino = new Casino(db, spendableChips, events, {
    fukuScale: () => settings.getNumber("ether_fuku_scale"),
    items,
    reservations,
    dailyRisk: dailyRiskCore,
  });
  const casinoMetrics = new CasinoMetrics(db, chipTx);
  const daily = new Daily(db, spendableChips, events, {
    base: () => settings.getNumber("daily_base"),
    reliefThreshold: () => settings.getNumber("daily_relief_threshold"),
    reliefMax: () => settings.getNumber("daily_relief_max"),
  });
  const stocks = new Stocks(db, spendableChips, events, { rng: defaultRng() });
  const vip = new Vip(db, spendableChips, events, {
    price: () => settings.getNumber("vip_price"),
    days: () => settings.getNumber("vip_days"),
    betCapMult: () => settings.getNumber("vip_bet_cap_mult"),
  });

  // 通算損益は確定精算のときだけ記録する。
  const recordPlayerNet = (userId: string, net: number) => {
    if (isPlayerHolder(userId)) casino.recordGameNet(userId, net);
  };

  // イベントLand板は landLedger を直接使う別経路。通常板だけ spendableChips 経由になる。
  const markets = new Markets(db, spendableChips, events, { onPlayerNet: recordPlayerNet, landLedger: ledger });
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

  // Escrow 本体は raw chips で監査する。公開側だけ funded proxy を渡し、
  // Land→chip と hold/holdAll を同一 transaction に包む。
  const escrowCore = new Escrow(db, chips, events, { onPlayerNet: recordPlayerNet });
  const escrow = createFundedEscrow(escrowCore, chips, ledger, chipFlow);

  const takutate = new Takutate(db, events);
  // integrity / opening は帳簿の実体を監査するので raw chips / raw escrow を必ず使う。
  const casinoIntegrity = new CasinoIntegrity(db, ledger, chips, escrowCore, chipAssets);
  const openingPlanner = new OpeningPlanner({
    db,
    ledger,
    chips,
    chipAssets,
    integrity: casinoIntegrity,
    status: casinoStatus,
    settings,
    departments,
  });
  const openingReset = new OpeningReset({
    db,
    ledger,
    chips,
    chipAssets,
    integrity: casinoIntegrity,
    status: casinoStatus,
    settings,
    departments,
  });

  // 起動・復旧では、永続する通常板だけが生きている escrow を申告する。
  const recoveryRegistry = new RecoveryRegistry();
  recoveryRegistry.register({ type: "market", listLiveEscrowHolders: () => markets.liveEscrowHolders() });
  const rng = defaultRng();

  const services = {
    db,
    settings,
    ledger,
    payroll,
    migration,
    events,
    entry,
    nicknames,
    originalRoles,
    originalRoleCases,
    subAccounts,
    returns,
    sessions,
    vc,
    tickets,
    chipTx,
    confessions,
    evaluation,
    vcRewards,
    rooms,
    titles,
    titleV2,
    departments,
    fiscal,
    ranks,
    bumps,
    textActivity,
    publicEvents,
    casinoParticipation,
    shop,
    // Discord/UI と支払い系には spendable view を公開する。
    chips: spendableChips,
    // `ether` は監査・互換用の raw read-only view のまま。
    ether: chips as ChipReadonlyView,
    chipAssets,
    // ソロ開始だけmaxPlayerLossの流動性を確保し、それ以外のchipFlow/DailyRiskメソッドはrawへ委譲する。
    chipFlow: soloLiquidity.chipFlow,
    dailyRisk: soloLiquidity.dailyRisk,
    casino,
    casinoMetrics,
    casinoStatus,
    casinoIntegrity,
    openingPlanner,
    openingReset,
    daily,
    items,
    stocks,
    vip,
    markets,
    escrow,
    takutate,
    freeSpins,
    reservations,
    recoveryRegistry,
    rng,
  };
  seedSpecialProfiles(services);
  return services;
}

export type Services = ReturnType<typeof buildServices>;
