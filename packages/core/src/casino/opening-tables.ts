/**
 * PR12: 現行main（`dbc4d19`時点、PR1〜PR11・#93マージ後）の賭場関連テーブル分類表。
 *
 * 旧#51（`backup/pr12-stacked-before-rebuild`）は固定のテーブル一覧を推測で持っていたが、
 * それはPR7〜PR11導入前の古いschemaを前提にしていて現行mainとは一致しない
 * （CLAUDE.md §3「現行schemaを調べずに固定したarchive対象一覧／reset対象一覧」は禁止）。
 * ここは `packages/core/src/db/bootstrap.ts` と各 `casino/*.ts` サービスの
 * `CREATE TABLE IF NOT EXISTS` を実地に読んで作った一覧である。
 *
 * kind:
 * - "core_ledger"      Land台帳の中核。PR12は一切変更しない
 * - "core_required"     現行mainの賭場機能に必須（存在しなければblocker）
 * - "optional_feature"  機能テーブル。存在しなくても致命的ではないが、存在すれば分類に従う
 * - "legacy_test_data"  旧試験制度のデータ。blocker=0を証明できて初めてreset対象
 * - "unknown"           この一覧に無いテーブル。安全側でblocker
 *
 * archive: backup（SQLiteスナップショット＋CSV）に含めるか
 * resetOnApply: R6/R9でDELETEするか（"casino_tx"/"casino_tx_groups"/"ether_balances"はR9、
 *   その他の legacy_test_data は R6。いずれも「backup検証後・blocker=0を確認できた場合だけ」）
 * preserve: 一切変更しない（削除もUPDATEもしない）
 */
export type CasinoTableKind = "core_ledger" | "core_required" | "optional_feature" | "legacy_test_data" | "unknown";

export interface CasinoTableClassification {
  table: string;
  purpose: string;
  kind: CasinoTableKind;
  archive: boolean;
  resetOnApply: boolean;
  preserve: boolean;
  /** R6 と R9 のどちらでDELETEするか（resetOnApply=false なら該当なし） */
  resetPhase?: "R6" | "R9";
  /** このテーブルにデータが残っている場合、何がblockerになるか（人間可読） */
  blockerCondition: string;
  /** 分類の根拠（現行mainのどのファイル・コメントに基づくか） */
  rationale: string;
  /**
   * plan hashの入力に含めるか（既定true）。PR12自身のbookkeeping table
   * （casino_opening_executions）は、acquire()のINSERT自体がrow countを変化させてしまい、
   * 「planを確定した直後に自分自身の書き込みでplanがstale化する」自己参照を起こすため除外する。
   */
  includeInPlanHash?: boolean;
}

const T = (row: CasinoTableClassification): CasinoTableClassification => row;

export const CASINO_TABLE_CLASSIFICATION: readonly CasinoTableClassification[] = [
  // ---- Land台帳の中核（絶対に変更しない）----
  T({
    table: "accounts",
    purpose: "Land台帳の口座マスタ",
    kind: "core_ledger",
    archive: false,
    resetOnApply: false,
    preserve: true,
    blockerCondition: "該当なし（変更対象外）",
    rationale: "bootstrap.ts。CLAUDE.md §21「利用者の通常Landまたは賭場外データへ変更が発生」で停止する対象",
  }),
  T({
    table: "transactions",
    purpose: "Land台帳の唯一の真実源（追記専用）",
    kind: "core_ledger",
    archive: false,
    resetOnApply: false,
    preserve: true,
    blockerCondition: "該当なし（変更対象外）",
    rationale: "bootstrap.ts。append-only。R7/R8はここへ新しい行を2件追記するだけで、既存行は一切変更しない",
  }),
  T({
    table: "balances",
    purpose: "口座別キャッシュ残高（transactionsから再計算可能）",
    kind: "core_ledger",
    archive: false,
    resetOnApply: false,
    preserve: true,
    blockerCondition: "該当なし（変更対象外）",
    rationale: "bootstrap.ts。R7/R8のLedger.transfer()が内部で更新するが、PR12が直接触るわけではない",
  }),
  T({
    table: "outbox",
    purpose: "監査ログ配送キュー",
    kind: "core_ledger",
    archive: false,
    resetOnApply: false,
    preserve: true,
    blockerCondition: "該当なし（変更対象外）",
    rationale: "bootstrap.ts。status変更・settings変更で追記されるのみ",
  }),
  T({
    table: "settings",
    purpose: "運営設定KVS（開業設定6キー含む）",
    kind: "core_ledger",
    archive: false,
    resetOnApply: false,
    preserve: true,
    blockerCondition: "該当なし",
    rationale:
      "bootstrap.ts。テーブル全体は保持。casino_opening_capital等7キーのみR11で書き込む（他の運営設定には触れない）",
  }),
  T({
    table: "departments",
    purpose: "部署口座マスタ（sys:dept:賭博場を含む）",
    kind: "core_required",
    archive: false,
    resetOnApply: false,
    preserve: true,
    blockerCondition: "key='賭博場' の行が存在しない場合はblocker（R7/R8の送金先が無い）",
    rationale: "departments/service.ts。行自体は削除しない。preflightで存在確認のみ行う",
  }),

  // ---- 賭場チップ監査基盤（R9で初期化）----
  T({
    table: "ether_balances",
    purpose: "賭場チップ残高（全holder）",
    kind: "core_required",
    archive: true,
    resetOnApply: true,
    resetPhase: "R9",
    preserve: false,
    blockerCondition:
      "isPlayerHolder()な保有者に正の残高があれば、compensation candidateとして個別報告し、全件補償完了までblocker",
    rationale:
      "exchange.ts/chip-tx.ts。R9でDELETE後、house/jackpot/reliefの3行だけをopening_v1として再構築する",
  }),
  T({
    table: "casino_tx",
    purpose: "チップ移動明細（1移動=1行）",
    kind: "core_required",
    archive: true,
    resetOnApply: true,
    resetPhase: "R9",
    preserve: false,
    blockerCondition: "該当なし（内容ではなく検算Aの結果がblocker要因）",
    rationale:
      "bootstrap.ts。opening_version列で版分離される設計だが、bootstrap.tsのコメント" +
      "「開業初期化でcasino_txを初期化した場合（新版のIDが旧版より小さくなる）」が" +
      "R9でのDELETEを前提にしていることを直接示す。退避先はbackupのSQLite+CSVのみ" +
      "（DB内に旧取引を残さない）。version_seqはこの巻き戻りに耐えるためだけの機構であり、" +
      "旧取引をDB内へ永久保存する機構ではない",
  }),
  T({
    table: "casino_tx_groups",
    purpose: "チップ移動の業務操作単位（冪等キー）",
    kind: "core_required",
    archive: true,
    resetOnApply: true,
    resetPhase: "R9",
    preserve: false,
    blockerCondition: "該当なし",
    rationale:
      "bootstrap.ts。casino_tx.group_keyがこのテーブルを外部キー参照する（foreign_keys=ON）ため、" +
      "DELETE順序はcasino_tx→casino_tx_groupsの順を厳守する。旧group_keyを残すと、" +
      "正式開業後の新操作が同名キーで誤ってreplayされうる（chip-tx.tsコメント）",
  }),
  T({
    table: "casino_chip_opening_versions",
    purpose: "開始残高の版一覧（legacy_pre_reset, opening_v1, ...）",
    kind: "core_required",
    archive: true,
    resetOnApply: false,
    preserve: true,
    blockerCondition: "既にopening_v1行が存在すればblocker（二重開業防止）",
    rationale:
      "bootstrap.ts。casino_tx/casino_tx_groupsとは別分類。旧versionのmetadata行" +
      "（legacy_pre_reset, version_seq, from_tx_id, pool_land, from_ledger_tx_id）は" +
      "無条件削除しない — R10はここへopening_v1の新しい1行をINSERTするだけ",
  }),
  T({
    table: "casino_opening_executions",
    purpose: "正式開業初期化apply自体の永続execution状態機械(PR12が新設)",
    kind: "core_required",
    archive: false,
    resetOnApply: false,
    preserve: true,
    blockerCondition: "該当なし（自分自身の実行記録なので初期化対象にもarchive対象にもしない）",
    rationale:
      "opening-execution.ts。preflightのunknown table検出を自己検出しないよう明示的に分類表へ含める。" +
      "plan hashにも含めない（自分自身の状態が変わるたびにplan hashが変わってしまうと再検査が機能しない）",
    includeInPlanHash: false,
  }),
  T({
    table: "casino_chip_opening_balances",
    purpose: "版ごとのholder別開始残高",
    kind: "core_required",
    archive: true,
    resetOnApply: false,
    preserve: true,
    blockerCondition: "該当なし",
    rationale:
      "bootstrap.ts。legacy_pre_resetの開始残高行は、preflightの検算A監査を事後に再現できる" +
      "唯一のDB内記録として保持する（casino_txが消えた後は、この行がpreflight結果の" +
      "『何を出発点にしたか』を示す）。R10がopening_v1向けの新しい行を追加するだけ",
  }),

  // ---- 稼働状態（本PRのR0/R14が使う。テーブル自体は削除しない）----
  T({
    table: "casino_status",
    purpose: "賭場の稼働状態（1行）",
    kind: "core_required",
    archive: false,
    resetOnApply: false,
    preserve: true,
    blockerCondition: "status='opening_reset'でなければapplyのdestructive transactionへ進めない",
    rationale: "status.ts。行のUPDATEはR0/R14で行うが、テーブル自体はarchive/reset対象ではない",
  }),
  T({
    table: "casino_status_history",
    purpose: "状態遷移履歴（追記専用）",
    kind: "core_required",
    archive: false,
    resetOnApply: false,
    preserve: true,
    blockerCondition: "該当なし",
    rationale: "status.ts。追記専用。PR12のR0/R14がここへ行を追記するのみ",
  }),

  // ---- 胴元債務予約・エスクロー（R5で0件確認、R6でクリア）----
  T({
    table: "casino_house_reservations",
    purpose: "胴元債務予約（進行中ゲームの最大配当予約）",
    kind: "core_required",
    archive: true,
    resetOnApply: true,
    resetPhase: "R6",
    preserve: false,
    blockerCondition: "1件でも残っていればblocker（進行中ゲームがある証拠）",
    rationale: "reservations.ts。R5で0件を確認してからR6でクリアする（本来0件のはず）",
  }),
  T({
    table: "casino_escrow",
    purpose: "対人卓・板・チンチロ事前預託の預り金台帳",
    kind: "core_required",
    archive: true,
    resetOnApply: true,
    resetPhase: "R6",
    preserve: false,
    blockerCondition:
      "1件でも残っていればblocker（進行中の卓・チンチロ事前預託が終わっていない証拠。PR11はこのテーブルを再利用しており専用テーブルを持たない）",
    rationale:
      "escrow.ts。PR11のチンチロ事前預託は専用テーブルを持たず、このテーブルの通常行として扱われる" +
      "（apps/bot/src/casino/chinchiro.tsのコメント）。R5の『進行中エスクローが0』チェックで" +
      "PR11未完了義務も同時にカバーされる",
  }),

  // ---- PR10: 自由チップ自動預入・返還 ----
  T({
    table: "casino_chip_activity",
    purpose: "利用者の最終アクティブ時刻（自動返還の起点）",
    kind: "optional_feature",
    archive: true,
    resetOnApply: true,
    resetPhase: "R6",
    preserve: false,
    blockerCondition: "該当なし（義務ではなく単なるアクティビティ記録）",
    rationale: "chip-flow.ts。金銭債務ではないため、それ自体はblockerにならない",
  }),
  T({
    table: "casino_chip_external_confirmations",
    purpose: "賭場外Land不足時の10分確認ボタン状態",
    kind: "optional_feature",
    archive: true,
    resetOnApply: true,
    resetPhase: "R6",
    preserve: false,
    blockerCondition: "status IN ('pending','executing') の行が1件でもあればblocker",
    rationale: "chip-flow.ts。'completed'/'cancelled'/'expired'のみならreset可",
  }),
  T({
    table: "casino_chip_refund_sagas",
    purpose: "緊急返還サガ（全員/個人）",
    kind: "optional_feature",
    archive: true,
    resetOnApply: true,
    resetPhase: "R6",
    preserve: false,
    blockerCondition: "status IN ('draft','executing') の行が1件でもあればblocker",
    rationale: "chip-flow.ts。'completed'/'blocked'/'cancelled'のみならreset可",
  }),
  T({
    table: "casino_chip_refund_saga_targets",
    purpose: "サガの対象者別実行状況",
    kind: "optional_feature",
    archive: true,
    resetOnApply: true,
    resetPhase: "R6",
    preserve: false,
    blockerCondition: "status='pending' の行が1件でもあればblocker（親サガの未完了と連動）",
    rationale: "chip-flow.ts",
  }),

  // ---- 保護資産の可能性があるテーブル（5.1節）----
  T({
    table: "casino_vip",
    purpose: "VIP有効期限",
    kind: "optional_feature",
    archive: true,
    resetOnApply: true,
    resetPhase: "R6",
    preserve: false,
    blockerCondition: "expires_at > now の行が1件でもあれば、正式な保護対象としてblocker（個別補償が必要）",
    rationale: "vip.ts。期限切れ行のみならreset可",
  }),
  T({
    table: "casino_stocks",
    purpose: "株マスタ（PR6で新規取引停止済み）",
    kind: "optional_feature",
    archive: true,
    resetOnApply: true,
    resetPhase: "R6",
    preserve: false,
    blockerCondition: "該当なし（マスタ自体は保有者の権利を持たない。権利はcasino_holdings側）",
    rationale: "stocks.ts。PR6で新規売買停止済み",
  }),
  T({
    table: "casino_holdings",
    purpose: "株保有（利用者別）",
    kind: "optional_feature",
    archive: true,
    resetOnApply: true,
    resetPhase: "R6",
    preserve: false,
    blockerCondition: "shares > 0 の行が1件でもあれば、正式な保護対象としてblocker（個別補償が必要）",
    rationale: "stocks.ts",
  }),
  T({
    table: "casino_stats",
    purpose: "利用者別戦績",
    kind: "optional_feature",
    archive: true,
    resetOnApply: true,
    resetPhase: "R6",
    preserve: false,
    blockerCondition:
      "games>0 または total_wagered>0 または total_earned>0 または total_lost>0 または " +
      "biggest_win>0 または best_win_streak>0 の行が1件でもあれば、保全対象候補としてblocker" +
      "（運営が『保全不要（試験データ）』と明示的に判断するまで初期化しない）",
    rationale:
      "service.ts。CLAUDE.md §5.1が「保全対象となる非ゼロ戦績」を明示的に保護対象へ含めているため、" +
      "安全側でblocker化する。旧opening-reset.tsもprotectedFindings.casinoStatsとして同様に扱っていた",
  }),
  T({
    table: "casino_items",
    purpose: "利用者所持アイテム",
    kind: "optional_feature",
    archive: true,
    resetOnApply: true,
    resetPhase: "R6",
    preserve: false,
    blockerCondition: "quantity > 0 の行が1件でもあればblocker（利用者に帰属するitemsとして5.1節の保護対象）",
    rationale: "items.ts",
  }),
  T({
    table: "casino_active_effects",
    purpose: "利用者の有効効果",
    kind: "optional_feature",
    archive: true,
    resetOnApply: true,
    resetPhase: "R6",
    preserve: false,
    blockerCondition: "行が1件でもあればblocker（5.1節の『effects』）",
    rationale: "items.ts",
  }),
  T({
    table: "casino_daily",
    purpose: "デイリー福分け請求記録",
    kind: "optional_feature",
    archive: true,
    resetOnApply: true,
    resetPhase: "R6",
    preserve: false,
    blockerCondition: "該当なし（Land実損に関与しない履歴記録。5.1節に明示的な列挙なし）",
    rationale: "daily.ts。念のためarchive対象には含めるが、blocker化はしない",
  }),
  T({
    table: "casino_pending_free_spins",
    purpose: "無料スピン永続化・JP請求",
    kind: "optional_feature",
    archive: true,
    resetOnApply: true,
    resetPhase: "R6",
    preserve: false,
    blockerCondition: "status != 'settled' の行が1件でもあればblocker（pending jackpot claim / free-spin権利）",
    rationale: "free-spins.ts。'settled'のみならreset可",
  }),
  T({
    table: "casino_markets",
    purpose: "板（予測市場）マスタ",
    kind: "optional_feature",
    archive: true,
    resetOnApply: true,
    resetPhase: "R6",
    preserve: false,
    blockerCondition: "statusがlive系（open/reported等の未終局状態）の行が1件でもあればblocker",
    rationale: "market.ts。settled/void/cancelled等の終局状態のみならreset可",
  }),
  T({
    table: "casino_market_bets",
    purpose: "板の賭け明細",
    kind: "optional_feature",
    archive: true,
    resetOnApply: true,
    resetPhase: "R6",
    preserve: false,
    blockerCondition: "親casino_marketsがlive系ならblocker（親子で連動判定）",
    rationale: "market.ts",
  }),
  T({
    table: "casino_market_approvals",
    purpose: "板の承認投票",
    kind: "optional_feature",
    archive: true,
    resetOnApply: true,
    resetPhase: "R6",
    preserve: false,
    blockerCondition: "親casino_marketsがlive系ならblocker",
    rationale: "market.ts",
  }),
  T({
    table: "casino_temp_vcs",
    purpose: "一時VC追跡（非資金）",
    kind: "optional_feature",
    archive: true,
    resetOnApply: true,
    resetPhase: "R6",
    preserve: false,
    blockerCondition: "該当なし（Discord実削除はR3相当・本PRはfake interfaceのみで実施しない）",
    rationale: "takutate.ts。行の初期化はDB内のみ。実際のDiscord VC削除は本PR範囲外",
  }),
] as const;

/** 分類表に載っているテーブル名の集合 */
export const KNOWN_CASINO_TABLE_NAMES: ReadonlySet<string> = new Set(
  CASINO_TABLE_CLASSIFICATION.map((t) => t.table),
);

export function classificationFor(table: string): CasinoTableClassification | undefined {
  return CASINO_TABLE_CLASSIFICATION.find((t) => t.table === table);
}
