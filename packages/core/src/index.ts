export { openDb } from "./db/bootstrap.js";
export { LedgerError, type LedgerErrorCode } from "./ledger/errors.js";
export {
  registerTxType,
  registerDefaultTxTypes,
  getTxType,
  knownTxTypes,
  type AccountKind,
  type TxTypePolicy,
} from "./ledger/registry.js";
export {
  Ledger,
  TREASURY,
  type TransferRequest,
  type TransferResult,
  type TxRow,
  type AccountRow,
  type LedgerOptions,
} from "./ledger/service.js";
export { Settings, SETTING_DEFAULTS, type SettingKey } from "./settings/service.js";
export {
  Payroll,
  PayrollError,
  type PayrollErrorCode,
  type SalaryRow,
  type PlanItem,
  type PayoutPlan,
  type PayoutRunRow,
  type MemberRoles,
  type ExecutionReport,
  type RunStatus,
} from "./payroll/service.js";
export { parseBalanceDump, splitForMigration, type DumpEntry, type ParsedDump, type MigrationSplit } from "./migration/parse.js";
export { Migration, MigrationError, type MigrationErrorCode, type StagingRow, type StagingStatus, type MemberNameInfo, type ImportSummary, type MigrationReport } from "./migration/service.js";
export { EventLog, type EventRow } from "./events/service.js";
export { Entry, type BookingRow, type SoulRow, type GhostifyResult, type BookingStatus, type InviterSource } from "./entry/service.js";
export {
  SessionCalendar,
  SessionCalendarError,
  sessionSchedule,
  describeSessionSchedule,
  jstDateStr,
  jstDayOfWeekFor,
  sessionStartAt,
  addJstDays,
  normalizeDateStr,
  formatJstDate,
  DEFAULT_SESSION_HOURS,
  DEFAULT_SESSION_SKIP_DOW,
  SESSION_HOURS_KEY,
  SESSION_SKIP_DOW_KEY,
  SESSION_SEARCH_DAYS,
  type SessionSchedule,
  type SessionOccurrence,
  type SessionOverrideKind,
  type SessionOverrideRow,
  type SessionCalendarErrorCode,
} from "./entry/sessions.js";
export { VcTracker, type VcSegment, type PresenceSummary } from "./vc/service.js";
export {
  RankEngine,
  TEXT_TIERS,
  VOICE_TIERS,
  textLevel,
  voiceLevel,
  textProgress,
  voiceProgress,
  tierFor,
  nextTier,
  type RankSnapshot,
  type RankAward,
  type RankTier,
} from "./rank/service.js";
export { BumpCounter } from "./rank/bump.js";
export {
  Shop,
  ShopError,
  nextFirstOfMonthJst,
  endOfMonthJst,
  type ShopItemRow,
  type ShopItemInput,
  type PurchaseRow,
  type ItemKind,
  type DeliveryMode,
  type DeliveryKind,
  type PurchaseStatus,
  type ShopErrorCode,
  type ShopRoleRevocationRow,
} from "./shop/service.js";
export {
  Tickets,
  type TicketRow,
  type TicketKind,
  type TicketStatus,
  type TicketPanel,
  type TicketPanelInput,
  type TicketPanelRow,
} from "./tickets/service.js";
export { ensureTicketOpenUniqueness } from "./tickets/constraints.js";
export {
  Confessions,
  type ConfessionRow,
  type ConfessionStatus,
  type ConfessionType,
  type ReplyWish,
  type ConfessionMeta,
  type ConfessionStage,
  type Disposition,
  type CloseReason,
  type AssigneeRow,
  type EmergencyRow,
  type VoiceReceivedCloseResult,
} from "./confession/service.js";
export {
  Evaluation,
  type Conclusion,
  type EvalScores,
  type EvalTexts,
  type EvalThresholds,
  type PreviousEvaluation,
  type PromotionScore,
  type SubmitResult,
  type SoulDeadlineRow,
} from "./evaluation/service.js";
export { VcRewards, type DailyReward, type RewardScope } from "./vc/rewards.js";
export {
  Rooms,
  RoomError,
  roomOwnershipSlot,
  type RoomRow,
  type RecruitRow,
  type OborozukiInviteRow,
  type RoomKind,
  type RoomErrorCode,
  type RoomOwnershipSlot,
  type RoomPanelValues,
} from "./rooms/service.js";
export { TitleEngine, TitleHelper, TITLE_RULES, type TitleRule, type GrantedTitle } from "./titles/service.js";
export {
  Departments,
  DepartmentError,
  deptAccount,
  type DepartmentRow,
  type DepartmentBalance,
  type DepartmentErrorCode,
} from "./departments/service.js";
export {
  Fiscal,
  FiscalError,
  type FiscalRunRow,
  type FiscalPlan,
  type FiscalPlanItem,
  type FiscalReport,
  type FiscalKind,
  type FiscalErrorCode,
} from "./fiscal/service.js";
export {
  EtherExchange,
  EtherError,
  ETHER_ESCROW,
  HOUSE_HOLDER,
  POOL_SWEEP_REASON,
  ETHER_APPROVER,
  isPlayerHolder,
  type EtherQuote,
  type EtherErrorCode,
  type EtherExchangeOptions,
  type ChipMoveInfo,
} from "./casino/exchange.js";
export {
  ChipTx,
  ChipTxError,
  CHIP_OPENING_VERSION_KEY,
  LEGACY_OPENING_VERSION,
  type ChipTxKind,
  type ChipMove,
  type ChipGroupInput,
  type ChipGroupRow,
  type ChipTxRow,
  type ChipBalanceMismatch,
  type ChipTxErrorCode,
} from "./casino/chip-tx.js";
export {
  Casino,
  JACKPOT_HOLDER,
  RELIEF_HOLDER,
  CHAIN_TIERS,
  soloGroupKey,
  chainMultiplier,
  fukuRate,
  type CasinoStatsRow,
  type SettleResult,
  type SoloRoundResult,
  type SoloRoundOptions,
  type CasinoOptions,
} from "./casino/service.js";
export { Daily, type DailyClaim, type DailyClaimResult, type DailyOptions } from "./casino/daily.js";
export { Items, CONSUMABLES, getConsumableDef, type ItemKind as CasinoItemKind, type ConsumableDef, type ArmResult } from "./casino/items.js";
export { Stocks, StockError, STOCK_HOLD_DAYS, STOCK_SELL_FEE_RATE, type Stock, type Holding, type StockErrorCode } from "./casino/stocks.js";
export { Vip, type VipOptions, type VipJoinResult } from "./casino/vip.js";
export {
  Markets,
  MarketError,
  DISPUTE_WINDOW_SEC,
  MARKET_FINALIZER,
  marketEscrowHolder,
  type Market,
  type MarketBet,
  type MarketApproval,
  type MarketStatus,
  type MarketErrorCode,
  type MarketFundMode,
  type PayoutMode,
  type MarketSettleResult,
  type MarketRefundResult,
  type MarketsOptions,
} from "./casino/market.js";
export {
  CasinoStatus,
  CASINO_STATUSES,
  isHumanHeld,
  type CasinoStatusValue,
  type CasinoStatusRow,
  type TransitionResult,
} from "./casino/status.js";
export {
  CasinoIntegrity,
  type CasinoCheckId,
  type CasinoCheckResult,
  type CasinoCheckMismatch,
  type CasinoIntegrityReport,
} from "./casino/integrity.js";
export { Takutate, TABLE_TYPES, type TableTypeDef, type TempVc } from "./casino/takutate.js";
export {
  Escrow,
  escrowHolderFor,
  isEscrowHolder,
  ESCROW_QUARANTINE,
  type EscrowRow,
  type EscrowOptions,
} from "./casino/escrow.js";
export {
  FreeSpins,
  FREE_SPIN_JACKPOT_CLAIMS_HOLDER,
  type PendingFreeSpinRow,
  type FreeSpinStatus,
} from "./casino/free-spins.js";
export { defaultRng, deterministicRng, scriptedRng, type CasinoRng } from "./casino/rng.js";
export {
  SLOT_SYMBOLS,
  TRIPLE_PAYOUTS,
  DOUBLE_PAYOUTS,
  SLOT_MAX_PAYOUT_MULT,
  JP_CONTRIBUTION as SLOTS_JP_CONTRIBUTION,
  jackpotCutFor as slotsJackpotCutFor,
  JP_WIN_SHARE as SLOTS_JP_WIN_SHARE,
  SCATTER_TRIGGER_COUNT as SLOTS_SCATTER_TRIGGER_COUNT,
  spinReel as slotsSpinReel,
  evaluate as slotsEvaluate,
  computeRtp as slotsComputeRtp,
  simulateRtp as slotsSimulateRtp,
  type SlotSymbol,
  type SpinOutcome as SlotSpinOutcome,
  type SpinKind as SlotSpinKind,
} from "./casino/slots-model.js";
export {
  CHOHAN_PAYOUT,
  chohanRollAndPay,
  chohanRtp,
  ROULETTE_SLOTS,
  ROULETTE_PAYOUTS,
  rouletteSpin,
  rouletteRtp,
  CRASH_HOUSE_EDGE,
  CRASH_INSTANT_BUST_RATE,
  CRASH_MIN_CASHOUT,
  CRASH_MAX_MULT_CAP,
  crashPoint,
  crashRtp,
  MARKET_HOUSE_CUT,
  marketPlayerRtp,
  KEIBA_HOUSE_RATE,
  keibaPlayerRtp,
  bjSimulateHand,
  bjSimulateRtp,
  POKER_PAYOUTS,
  POKER_CATEGORY_PAYOUTS,
  pokerSimulateRtp,
  holdemSimulateRtp,
  STOCK_SELL_FEE,
  stockBuyThenSellRtp,
  type BjStrategy,
  type PokerStrategy,
} from "./casino/game-models.js";

export {
  CHINCHIRO_MAX_ROLLS,
  CHINCHIRO_HOUSE_EDGE,
  CHINCHIRO_WIN_MULT,
  CHINCHIRO_MAX_LOSS_MULT,
  CHINCHIRO_LOSS_MULT_BASE,
  CHINCHIRO_DEALER_POLICY,
  chinchiroRoll,
  chinchiroEvaluate,
  chinchiroRank,
  chinchiroWinMult,
  chinchiroLossMult,
  chinchiroIsTerminal,
  chinchiroCompare,
  chinchiroPayout,
  chinchiroPlayerLoss,
  chinchiroMaxPlayerLoss,
  chinchiroMaxPayout,
  chinchiroPlayTurn,
  chinchiroSimulateRtp,
  type Dice as ChinchiroDice,
  type Hand as ChinchiroHand,
  type ChinchiroCompare,
  type ChinchiroPolicy,
  type ChinchiroRtpResult,
} from "./casino/chinchiro-model.js";

export {
  slotsLiability,
  slotsPaidSpinLiability,
  chohanLiability,
  crashLiability,
  pokerLiability,
  holdemLiability,
  blackjackLiability,
  blackjackNoDoubleLiability,
  chinchiroLiability,
  rouletteIncrementalLiability,
  rouletteTableLiability,
  liabilityModelFor,
  LIABILITY_MODELS,
  HOLDEM_CALL_ROUNDS,
  HOLDEM_MAX_TOTAL_BET_MULT,
  HOLDEM_MAX_PAYOUT_MULT,
  BLACKJACK_MAX_PAYOUT_MULT,
  BLACKJACK_NO_DOUBLE_MAX_PAYOUT_MULT,
  LiabilityError,
  MAX_SAFE_LIABILITY_BET,
  type LiabilityErrorCode,
  type LiabilityContext,
  type GameLiabilityModel,
  type ChainMode,
  type RouletteBet,
} from "./casino/liability.js";

export {
  HouseReservations,
  RESERVATION_STALE_SEC,
  type ReservationRow,
  type ReservationResult,
} from "./casino/reservations.js";
