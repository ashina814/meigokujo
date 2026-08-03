import type Database from "better-sqlite3";
import { Ledger, TREASURY } from "../ledger/service.js";
import { ChipTx, LEGACY_OPENING_VERSION, FORMAL_OPENING_VERSION } from "./chip-tx.js";
import { ETHER_APPROVER, ChipLedger, HOUSE_HOLDER, POOL_SWEEP_REASON } from "./chip-ledger.js";
import { Escrow, ESCROW_QUARANTINE } from "./escrow.js";
import { JACKPOT_HOLDER, RELIEF_HOLDER } from "./service.js";
import { FREE_SPIN_JACKPOT_CLAIMS_HOLDER } from "./free-spins.js";

/**
 * 賭場の検算A〜D（大型UPD PR2）。
 *
 * PR1 で「いつ・誰が・なぜ動かしたか」が残るようになったので、ここでは
 * **記録と実体が合っているか**を4つの角度から確かめる。1つでも合わなければ賭場を止める。
 *
 * | | 何を確かめるか |
 * |---|---|
 * | A | 記録どおりの残高か（開始残高 + その版の取引 == 実残高） |
 * | B | チップに Land の裏付けがあるか（準備口座の出入りが**全件**説明できるか） |
 * | C | 預かっている資金が帳簿と合っているか（卓・板のエスクロー） |
 * | D | すべてのチップが**実在する**保有者に帰属しているか |
 *
 * A〜C が通れば D は自動的に成立するはずだが、**D は独立に実装する**
 * （A〜C のどれかにバグがあっても D で気づける・仕様書2.2）。
 *
 * ## 読み取り専用・単一スナップショット
 * 検算は**何も書き換えない**。基準の確定は `ChipTx.establishOpeningLandBaseline()` という
 * 別の明示的な移行操作に分けてある（検算の中で自動確定すると、初回が必ず通り、
 * それまでの不正移動を出発点へ取り込んでしまう）。
 * A〜D は1つの読み取りトランザクションの中で走らせ、途中で別接続の取引が挟まって
 * 「Aは古い値・Cは新しい値」で見えることによる誤検知を防ぐ。
 */

export type CasinoCheckId = "A" | "B" | "C" | "D";

export interface CasinoCheckMismatch {
  /** 何が合わないか（保有者ID・セッションID・Land取引ID など） */
  subject: string;
  expected: number;
  actual: number;
  /** 追加の説明（不明な Land 取引の型など） */
  note?: string;
}

export interface CasinoCheckResult {
  id: CasinoCheckId;
  name: string;
  ok: boolean;
  /** 人が読む1行。ダッシュボード・監査通知にそのまま出す */
  detail: string;
  mismatches: CasinoCheckMismatch[];
}

export interface CasinoIntegrityReport {
  ok: boolean;
  /** Land 台帳そのものの健全性（仕様書 S1）。検算A〜Dより先に見る */
  ledger: { ok: boolean; detail: string };
  checks: CasinoCheckResult[];
  /** NG だった検算のID（停止理由の組み立てに使う） */
  failed: CasinoCheckId[];
  checkedAt: number;
}

/** 賭場が持つ「利用者ではない」保有者。帰属先が決まっているのでDの分類に含める */
const SYSTEM_HOLDERS: ReadonlySet<string> = new Set([
  HOUSE_HOLDER,
  JACKPOT_HOLDER,
  RELIEF_HOLDER,
  ESCROW_QUARANTINE,
  FREE_SPIN_JACKPOT_CLAIMS_HOLDER,
]);

/** 差分を最大何件まで持ち回るか（通知が壊れないように） */
const MAX_MISMATCHES = 20;

/**
 * 準備口座を動かしてよい Land 取引の型と形（PR8監査・ブロッカーD）。
 *
 * `ether_*` は PR8 以前（ChipLedger 導入前）の旧 EtherExchange が作った**純粋な歴史データ**。
 * ChipLedger 導入後は legacy_pre_reset の間もopening_v1の間も、新規の預入・返還・元手・精算は
 * すべて `chip_*` 型で記録される（reserveHolder が版によって ETHER_ESCROW / CHIP_ESCROW に
 * 変わるだけで、Land取引の型そのものは版で変わらない）。
 *
 * したがって:
 * - `ether_*` は legacy_pre_reset の窓の中にしか存在してはいけない（新規に作られる経路が無い）。
 *   opening_v1 の窓でこの型を見つけたら、それだけで許可されない取引として弾く。
 * - `chip_*` はどちらの窓でも作られうるが、**必ず1:1の厳密対応**を要求する
 *   （版によって緩めない・legacy_pre_reset だからと大目に見ない）。
 */
interface PoolTxRule {
  /** 準備口座から見た向き */
  direction: "in" | "out";
  /** 相手口座の形 */
  counterparty: "user" | "system" | "treasury";
  /** 実行者の制約（null なら相手口座の利用者 or 任意の運営） */
  actor?: string;
  /** 冪等キーの末尾（chip グループ名に付く接尾辞） */
  keySuffix?: ":burn" | ":sweep";
  /** 理由文の制約（旧焼却・端数回収の識別に使う） */
  reason?: string;
}

/**
 * legacy_pre_reset の窓でだけ許可する**歴史専用**の旧 EtherExchange 取引型。
 * これらは PR8 以降、新規に作られることが無い（作る経路が存在しない）。
 */
const LEGACY_ETHER_TX_RULES: Record<string, PoolTxRule[]> = {
  // 入場（利用者が Land を払ってチップを買う）
  ether_buy: [{ direction: "in", counterparty: "user" }],
  // 胴元の元手（部署 → 準備口座）
  ether_house_fund: [{ direction: "in", counterparty: "system", actor: ETHER_APPROVER }],
  // 退場（チップを Land に戻す）
  ether_sell: [{ direction: "out", counterparty: "user" }],
  // 収益精算（準備口座 → 部署などのシステム口座）
  ether_settle: [{ direction: "out", counterparty: "system" }],
  // 旧制度の奉納・端数回収。履歴監査のため正当な旧取引として残す。
  // `:sweep` は端数回収固有の理由文（POOL_SWEEP_REASON）を必須にする（PR8監査・復元）。
  ether_burn: [
    { direction: "out", counterparty: "treasury", keySuffix: ":burn" },
    { direction: "out", counterparty: "treasury", keySuffix: ":sweep", reason: POOL_SWEEP_REASON },
  ],
};

/** チップ側の kind（deposit/redeem）を Land 側の取引型から決める（`chip_*` の厳密照合） */
const CHIP_TX_KIND: Record<string, "deposit" | "redeem"> = {
  chip_deposit: "deposit",
  chip_fund: "deposit",
  chip_redeem: "redeem",
  chip_settle: "redeem",
};

type OpeningVersionKind = "legacy" | "formal" | "unknown";

/** fail-closed（PR8監査・ブロッカーC/D）。既知の2版との厳密一致でしか分類しない。 */
function classifyOpeningVersion(version: string): OpeningVersionKind {
  if (version === LEGACY_OPENING_VERSION) return "legacy";
  if (version === FORMAL_OPENING_VERSION) return "formal";
  return "unknown";
}

interface PoolTxRow {
  id: number;
  idempotency_key: string;
  from_account: string;
  to_account: string;
  amount: number;
  type: string;
  reason: string | null;
  actor_id: string;
  ref_type: string | null;
  ref_id: string | null;
  approved_by: string | null;
}

interface ChipTxDetailRow {
  group_key: string;
  tx_kind: string;
  from_holder: string | null;
  to_holder: string | null;
  amount: number;
  land_amount: number | null;
  ledger_tx_id: number | null;
  opening_version: string;
}

const now = () => Math.floor(Date.now() / 1000);

export class CasinoIntegrity {
  private readonly chipTx: ChipTx;

  constructor(
    private readonly db: Database.Database,
    private readonly ledger: Ledger,
    private readonly ether: ChipLedger,
    private readonly escrow: Escrow,
  ) {
    this.chipTx = ether.chipTx;
  }

  /**
   * **全点検**（Land台帳 + 検算A〜D）。起動時・営業再開・再点検・計器盤はすべてこれを使う。
   * 単一の読み取りトランザクションで走り、何も書き換えない。
   */
  runFull(): CasinoIntegrityReport {
    // deferred トランザクション = 最初の読み取りでスナップショットを取り、閉じるまで同じ景色を見る。
    // 途中で別接続が確定させた取引が混ざって「Aは古い・Cは新しい」になる誤検知を防ぐ
    const snapshot = this.db.transaction((): CasinoIntegrityReport => {
      const ledger = this.checkLedger();
      const checks = [this.checkA(), this.checkB(), this.checkC(), this.checkD()];
      const failed = checks.filter((c) => !c.ok).map((c) => c.id);
      return { ok: ledger.ok && failed.length === 0, ledger, checks, failed, checkedAt: now() };
    });
    return snapshot.deferred();
  }

  /**
   * **起動時の前検（Land台帳 + 検算A・B のみ）**。正本 §8.2 の S2・S3 に対応する。
   *
   * ここで C（エスクロー）と D（系全体）を見ないのは、**それらが落ちている状態こそ
   * 復旧が直しにいく対象**だから。孤児残高や帳簿不一致は検算C を落とすので、
   * 全点検を前検に使うと「掃除するべき状態を理由に掃除を中止する」ことになる。
   *
   * A（記録と残高）と B（準備金）は掃除では直らない種類の壊れ方なので、
   * ここで NG なら以降のステップを実行してはいけない。
   */
  runStartupPrecheck(): CasinoIntegrityReport {
    const snapshot = this.db.transaction((): CasinoIntegrityReport => {
      const ledger = this.checkLedger();
      const checks = [this.checkA(), this.checkB()];
      const failed = checks.filter((c) => !c.ok).map((c) => c.id);
      return { ok: ledger.ok && failed.length === 0, ledger, checks, failed, checkedAt: now() };
    });
    return snapshot.deferred();
  }

  /** 停止理由の1行（監査通知・状態の reason に入れる） */
  static describeFailure(report: CasinoIntegrityReport): string {
    const parts: string[] = [];
    if (!report.ledger.ok) parts.push(report.ledger.detail);
    for (const c of report.checks) if (!c.ok) parts.push(`検算${c.id}(${c.name}): ${c.detail}`);
    return parts.length === 0 ? "検算はすべて正常" : parts.join(" / ");
  }

  /** Land 台帳そのものの健全性（仕様書 S1） */
  checkLedger(): { ok: boolean; detail: string } {
    const r = this.ledger.verifyIntegrity();
    return {
      ok: r.ok,
      detail: r.ok ? "Land台帳は正常" : `Land台帳の残高キャッシュが ${r.mismatches.length}件 不一致`,
    };
  }

  // ── A: 記録と残高 ──────────────────────────────────────

  /** 開始残高 + その版の取引 == いまのチップ残高（1 Ld の差も見逃さない） */
  checkA(): CasinoCheckResult {
    const r = this.chipTx.verifyBalances();
    return {
      id: "A",
      name: "記録と残高",
      ok: r.ok,
      detail: r.ok
        ? "開始残高と取引から現在残高を再現できる"
        : `${r.mismatches.length}件の保有者で記録と残高が食い違う`,
      mismatches: r.mismatches.slice(0, MAX_MISMATCHES).map((m) => ({
        subject: m.holder,
        expected: m.expected,
        actual: m.actual,
      })),
    };
  }

  // ── B: チップの裏付け（経路監査） ───────────────────────

  /**
   * 準備口座の Land が「賭場の経路を通った取引**だけ**」で動いているか。
   *
   * 差引が合うかだけを見ると、**500 抜いて 500 戻す**と通ってしまう。そこで
   * 版の Land 境界より後に準備口座へ出入りした取引を**1件ずつ**確かめる:
   *
   * - 型が `POOL_TX_RULES` に載っているか
   * - 向き（入る/出る）が型と合っているか
   * - 相手口座の形（利用者 / システム / 国庫）が合っているか
   * - 実行者が型の制約を満たすか
   * - 冪等キーが**実在する chip グループ**を指しているか（理由文だけ真似ても通らない）
   * - そのグループがこの版の窓に属するか（版をまたいだ二重計上を防ぐ）
   *
   * そのうえで「開始プール + 入 − 出 == いまのプール」を確かめる。
   * 基準（`pool_land` / `from_ledger_tx_id`）が無い版は**自動で埋めずに NG**にする。
   */
  checkB(): CasinoCheckResult {
    const version = this.chipTx.currentVersion();
    const kind = classifyOpeningVersion(version);

    // **fail-closed**（PR8監査・ブロッカーC）。未知版では準備口座そのものが決まらないので、
    // 「正常」と誤認させず、ここで明確に検算Bを落とす（`reserveHolder()`の例外に頼らない）。
    if (kind === "unknown") {
      return {
        id: "B",
        name: "チップの裏付け",
        ok: false,
        detail: `未知のopening_version「${version}」。準備口座を決定できないため検算不能`,
        mismatches: [{ subject: version, expected: 0, actual: 0, note: "unknown_opening_version" }],
      };
    }

    const baseline = this.chipTx.openingLandBaseline(version);
    if (!baseline) {
      return {
        id: "B",
        name: "チップの裏付け",
        ok: false,
        detail: `版 ${version} の Land 基準（開始プール・境界取引ID）が未設定。運営の明示的な基準確定が要る`,
        mismatches: [{ subject: version, expected: 0, actual: this.ether.pool(), note: "baseline_missing" }],
      };
    }

    const upperBound = this.chipTx.nextOpeningLandBoundary(version);
    const rows = this.poolTransactions(baseline.fromLedgerTxId, upperBound);
    const mismatches: CasinoCheckMismatch[] = [];
    let inflow = 0;
    let outflow = 0;
    for (const row of rows) {
      const problem = this.classifyPoolTxRow(row, version, kind);
      if (problem) {
        mismatches.push({ subject: `tx#${row.id}`, expected: 0, actual: row.amount, note: problem });
        continue;
      }
      if (row.to_account === this.ether.reserveHolder()) inflow += row.amount;
      else outflow += row.amount;
    }

    const actual = this.ether.pool();
    const expected = baseline.poolLand + inflow - outflow;
    if (expected !== actual) {
      mismatches.push({ subject: this.ether.reserveHolder(), expected, actual, note: "balance_mismatch" });
    }

    // **100%準備の直接検算**（PR8監査・ブロッカーF）。opening_v1 では「準備Land ==
    // 発行済み全chip」が不変条件。上のA〜Cの経路監査が正しくても、この等式を
    // 直接照合しない限り「経路は正しいのに総量がずれている」を見逃しうる。
    // legacy_pre_reset は旧変動レート制度なのでこの1:1照合は適用しない。
    if (kind === "formal") {
      const outstanding = this.ether.outstanding();
      if (actual !== outstanding) {
        mismatches.push({ subject: "100%準備", expected: outstanding, actual, note: "reserve_not_fully_backed" });
      }
    }

    const ok = mismatches.length === 0;
    return {
      id: "B",
      name: "チップの裏付け",
      ok,
      detail: ok
        ? `準備プール ${actual.toLocaleString()} Ld は経路どおり（監査 ${rows.length}件 / 入 ${inflow.toLocaleString()} / 出 ${outflow.toLocaleString()}）`
        : this.describeBFailure(mismatches),
      mismatches: mismatches.slice(0, MAX_MISMATCHES),
    };
  }

  private describeBFailure(mismatches: CasinoCheckMismatch[]): string {
    const unknown = mismatches.filter(
      (m) => m.note !== "balance_mismatch" && m.note !== "baseline_missing" && m.note !== "reserve_not_fully_backed",
    );
    const balance = mismatches.find((m) => m.note === "balance_mismatch");
    const reserve = mismatches.find((m) => m.note === "reserve_not_fully_backed");
    const parts: string[] = [];
    if (unknown.length > 0) parts.push(`説明できない準備口座の取引 ${unknown.length}件（${unknown[0]!.subject}: ${unknown[0]!.note}）`);
    if (balance) parts.push(`準備プールが経路と ${(balance.actual - balance.expected).toLocaleString()} Ld ずれている`);
    if (reserve) parts.push(`準備Land ${reserve.actual.toLocaleString()} と発行済み全chip ${reserve.expected.toLocaleString()} が一致しない`);
    return parts.join(" / ");
  }

  /** 版の窓に属する準備口座の出入り（境界の取引IDより後、次の版の境界まで） */
  private poolTransactions(fromLedgerTxId: number, upperBound: number | null): PoolTxRow[] {
    const sql =
      `SELECT id, idempotency_key, from_account, to_account, amount, type, reason, actor_id, ref_type, ref_id, approved_by
         FROM transactions
        WHERE (from_account = ? OR to_account = ?) AND id > ?` +
      (upperBound === null ? "" : " AND id <= ?") +
      " ORDER BY id";
    const reserve = this.ether.reserveHolder();
    const params: unknown[] = [reserve, reserve, fromLedgerTxId];
    if (upperBound !== null) params.push(upperBound);
    return this.db.prepare(sql).all(...params) as PoolTxRow[];
  }

  /**
   * 1件の準備口座取引を、型の接頭辞で振り分けて検査する（PR8監査・ブロッカーD）。
   *
   * - `chip_*`: どちらの版の窓でも作られうるが、常に厳密な1:1対応を要求する
   *   （`classifyChipPoolTx`）。版で緩めない。
   * - `ether_*`: legacy_pre_reset の窓の中でしか許可しない（PR8以降、新規に作られる
   *   経路が無い純粋な歴史データのため）。opening_v1 の窓で見つけたら弾く。
   * - それ以外: 常に不許可。
   */
  private classifyPoolTxRow(row: PoolTxRow, version: string, kind: "legacy" | "formal"): string | null {
    if (row.type.startsWith("chip_")) {
      return this.classifyChipPoolTx(row, version);
    }
    if (row.type.startsWith("ether_")) {
      if (kind !== "legacy") return `tx_type_not_allowed_for_version:${row.type}`;
      return this.classifyLegacyEtherPoolTx(row, version);
    }
    return `tx_type_not_allowed_for_version:${row.type}`;
  }

  /** legacy_pre_reset専用の歴史的 ether_* 取引を検査する。問題なければ null */
  private classifyLegacyEtherPoolTx(row: PoolTxRow, version: string): string | null {
    const rules = LEGACY_ETHER_TX_RULES[row.type];
    if (!rules) return `tx_type_not_allowed_for_version:${row.type}`;
    const direction: "in" | "out" = row.to_account === this.ether.reserveHolder() ? "in" : "out";
    // 準備口座から準備口座への自己送金は Ledger 側が弾くが、念のため
    if (row.from_account === row.to_account) return "self_transfer";

    const reasons: string[] = [];
    for (const rule of rules) {
      const r = this.matchPoolRule(row, rule, direction, version);
      if (r === null) return null;
      reasons.push(r);
    }
    return reasons[0] ?? "no_matching_rule";
  }

  private matchPoolRule(row: PoolTxRow, rule: PoolTxRule, direction: "in" | "out", version: string): string | null {
    if (rule.direction !== direction) return `wrong_direction:${row.type}`;
    const other = direction === "in" ? row.from_account : row.to_account;
    if (rule.counterparty === "user" && !other.startsWith("user:")) return `wrong_counterparty:${other}`;
    if (rule.counterparty === "system" && (!other.startsWith("sys:") || other === TREASURY)) {
      return `wrong_counterparty:${other}`;
    }
    if (rule.counterparty === "treasury" && other !== TREASURY) return `wrong_counterparty:${other}`;
    if (rule.actor && row.actor_id !== rule.actor) return `wrong_actor:${row.actor_id}`;
    if (rule.counterparty === "user" && !rule.actor && row.actor_id !== other) return `wrong_actor:${row.actor_id}`;
    if (rule.reason && row.reason !== rule.reason) return "wrong_reason";

    // 冪等キーは chip グループを指す。理由文だけ真似た手動取引はここで落ちる
    const suffix = rule.keySuffix;
    if (suffix && !row.idempotency_key.endsWith(suffix)) return "missing_key_suffix";
    const groupKey = suffix ? row.idempotency_key.slice(0, -suffix.length) : row.idempotency_key;
    if (!this.chipTx.hasGroup(groupKey)) return "no_chip_group";
    if (!this.groupBelongsToVersion(groupKey, version)) return "group_version_mismatch";
    return null;
  }

  /**
   * その chip グループがこの版の窓に属するか。
   * グループの明細は同じ版を持つ（`casino_tx.opening_version`）。明細が1件も無いグループ
   * （0 Ld 返還のような Land だけ動く例はない）は、版を確かめられないので不一致とする。
   */
  private groupBelongsToVersion(groupKey: string, version: string): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM casino_tx WHERE group_key = ? AND opening_version = ?")
      .get(groupKey, version) as { c: number };
    return row.c > 0;
  }

  /**
   * `chip_*` 取引を検査する（PR8監査・ブロッカーE）。legacy_pre_reset / opening_v1 の
   * どちらの窓でも、常にこの厳密対応を要求する（版で緩めない）。
   *
   * 「同じgroupに何か明細がある」だけでは通さない。この Land 取引が
   * `ledger_tx_id` で指す `casino_tx` 明細を**1件だけ**特定し、
   * holder・金額・種別・版・group まで全部を厳密照合する。
   */
  private classifyChipPoolTx(row: PoolTxRow, version: string): string | null {
    const expectedKind = CHIP_TX_KIND[row.type];
    if (!expectedKind) return `tx_type_not_allowed_for_version:${row.type}`;

    const direction: "in" | "out" = row.to_account === this.ether.reserveHolder() ? "in" : "out";
    if (row.from_account === row.to_account) return "self_transfer";
    const expectedDirection: "in" | "out" = expectedKind === "deposit" ? "in" : "out";
    if (direction !== expectedDirection) return `wrong_direction:${row.type}`;

    const other = direction === "in" ? row.from_account : row.to_account;
    if (row.type === "chip_deposit" && !other.startsWith("user:")) return `wrong_counterparty:${other}`;
    if (row.type === "chip_fund" && (!other.startsWith("sys:") || other === TREASURY)) return `wrong_counterparty:${other}`;
    if (row.type === "chip_redeem" && !other.startsWith("user:")) return `wrong_counterparty:${other}`;
    if (row.type === "chip_settle" && (!other.startsWith("sys:") || other === TREASURY)) return `wrong_counterparty:${other}`;
    if (row.type === "chip_fund" && row.actor_id !== ETHER_APPROVER) return `wrong_actor:${row.actor_id}`;

    if (row.approved_by !== ETHER_APPROVER) return "wrong_approver";
    if (row.ref_type !== "casino_chip") return "wrong_ref_type";
    if (!row.ref_id || !row.ref_id.trim()) return "missing_ref_id";

    // ledger_tx_id での厳密な1件特定。internal_transfer は ledger_tx_id を持たない
    // （casino_tx の CHECK 制約）ので、同groupの無関係な内部移動はここで自然に除外される。
    const details = this.db
      .prepare("SELECT group_key, tx_kind, from_holder, to_holder, amount, land_amount, ledger_tx_id, opening_version FROM casino_tx WHERE ledger_tx_id = ?")
      .all(row.id) as ChipTxDetailRow[];
    if (details.length === 0) return "no_matching_chip_tx";
    if (details.length > 1) return "multiple_matching_chip_tx";
    const detail = details[0]!;

    if (detail.group_key !== row.idempotency_key) return "group_key_mismatch";
    if (detail.opening_version !== version) return "chip_tx_version_mismatch";
    if (detail.tx_kind !== expectedKind) return "tx_kind_mismatch";
    if (detail.land_amount !== row.amount) return "land_amount_mismatch";
    if (detail.amount !== row.amount) return "chip_amount_mismatch";

    const holderSide = expectedKind === "deposit" ? detail.to_holder : detail.from_holder;
    if (holderSide !== row.ref_id) return "holder_mismatch";

    return null;
  }

  // ── C: 預託 ────────────────────────────────────────────

  /**
   * 預かっている資金が帳簿と合っているか。
   * - 卓・競馬: `casino_escrow` の合計 == `escrow:session:<sid>` の残高（既存の `escrow.verify()`）
   * - 板: 未確定の板の pot == `escrow:market:<id>` の残高
   */
  checkC(): CasinoCheckResult {
    const session = this.escrow.verify();
    const mismatches: CasinoCheckMismatch[] = session.mismatches.map((m) => ({
      subject: `session:${m.sessionId}`,
      expected: m.expected,
      actual: m.actual,
    }));
    for (const m of this.marketEscrowMismatches()) mismatches.push(m);
    const freeSpinClaims = this.freeSpinJackpotClaimMismatch();
    if (freeSpinClaims) mismatches.push(freeSpinClaims);
    const ok = mismatches.length === 0;
    return {
      id: "C",
      name: "預託",
      ok,
      detail: ok
        ? "卓・板の預り金とフリースピンJP請求は帳簿どおり"
        : freeSpinClaims
          ? `フリースピンJP請求が不一致（${freeSpinClaims.note ?? ""} / 期待 ${freeSpinClaims.expected} / 実残高 ${freeSpinClaims.actual}）`
          : `${mismatches.length}件の預り所で帳簿と残高が食い違う`,
      mismatches: mismatches.slice(0, MAX_MISMATCHES),
    };
  }

  /** pending の確定JP請求額と専用system holderを照合する（旧DBで表が無ければ0件扱い）。 */
  private freeSpinJackpotClaimMismatch(): CasinoCheckMismatch | null {
    if (!this.tableExists("casino_pending_free_spins")) return null;
    const rows = this.db
      .prepare(
        "SELECT id, jackpot_claim FROM casino_pending_free_spins WHERE status != 'settled' AND jackpot_claim != 0 ORDER BY id",
      )
      .all() as Array<{ id: number; jackpot_claim: number }>;
    const expected = rows.reduce((sum, row) => sum + row.jackpot_claim, 0);
    const actual = this.ether.balanceOf(FREE_SPIN_JACKPOT_CLAIMS_HOLDER);
    if (expected === actual) return null;
    const ids = rows.map((row) => `#${row.id}`).join(", ") || "なし";
    return {
      subject: FREE_SPIN_JACKPOT_CLAIMS_HOLDER,
      expected,
      actual,
      note: `pending行 ${ids}`,
    };
  }

  /** 未確定の板について pot と預り所残高を突き合わせる（fund_mode='escrow' のみ） */
  private marketEscrowMismatches(): CasinoCheckMismatch[] {
    if (!this.tableExists("casino_markets") || !this.tableExists("casino_market_bets")) return [];
    const rows = this.db
      .prepare(
        `SELECT m.id AS id,
                COALESCE(SUM(b.amount), 0) AS pot,
                COALESCE(eb.amount, 0) AS escrow_balance
           FROM casino_markets m
           LEFT JOIN casino_market_bets b ON b.market_id = m.id
           LEFT JOIN ether_balances eb ON eb.user_id = 'escrow:market:' || m.id
          WHERE m.status IN ('open','closed','reported','disputed','frozen')
            AND m.fund_mode = 'escrow'
          GROUP BY m.id`,
      )
      .all() as Array<{ id: number; pot: number; escrow_balance: number }>;
    return rows
      .filter((r) => r.pot !== r.escrow_balance)
      .map((r) => ({ subject: `market:${r.id}`, expected: r.pot, actual: r.escrow_balance }));
  }

  // ── D: 帰属 ────────────────────────────────────────────

  /**
   * 発行済みチップが全部「**実在する**誰かのもの」になっているか。
   *
   * 内訳 = 利用者の自由チップ + 卓/板への預託 + 胴元 + JP + 救済 + 隔離
   *
   * 利用者かどうかは ID の形ではなく **Land 台帳に `user:<ID>` の口座があるか**で決める。
   * 形だけで判定すると `houes`（打ち間違い）や `mystery-holder` のような
   * 実在しない保有者がそのまま「利用者」として通ってしまう。
   */
  checkD(): CasinoCheckResult {
    const holders = this.db.prepare("SELECT user_id, amount FROM ether_balances WHERE amount != 0").all() as Array<{
      user_id: string;
      amount: number;
    }>;
    const escrowLedger = this.escrowLedgerByHolder();
    const knownUsers = this.knownUserAccounts();

    let outstanding = 0;
    let classified = 0;
    const mismatches: CasinoCheckMismatch[] = [];
    for (const h of holders) {
      outstanding += h.amount;
      if (SYSTEM_HOLDERS.has(h.user_id)) {
        classified += h.amount;
        continue;
      }
      if (h.user_id.startsWith("escrow:")) {
        // 預り所は「帳簿に載っている預託」だけが帰属先を持つ
        const booked = escrowLedger.get(h.user_id) ?? 0;
        classified += booked;
        if (booked !== h.amount) {
          mismatches.push({ subject: h.user_id, expected: booked, actual: h.amount, note: "帳簿に無い預り所残高" });
        }
        continue;
      }
      if (knownUsers.has(h.user_id)) {
        classified += h.amount;
        continue;
      }
      // Land 台帳に口座が無い＝実在しない保有者。誰にも帰属できない
      mismatches.push({ subject: h.user_id, expected: 0, actual: h.amount, note: "台帳に user 口座が無い保有者" });
    }

    if (classified !== outstanding) {
      mismatches.push({ subject: "発行総量", expected: outstanding, actual: classified, note: "帰属合計が一致しない" });
    }
    const ok = mismatches.length === 0;
    return {
      id: "D",
      name: "帰属",
      ok,
      detail: ok
        ? `発行済み ${outstanding.toLocaleString()} ◈ はすべて実在する帰属先がある`
        : `${mismatches.length}件の帰属不明がある（${mismatches[0]!.subject}: ${mismatches[0]!.note}）`,
      mismatches: mismatches.slice(0, MAX_MISMATCHES),
    };
  }

  /** Land 台帳にある利用者口座のID（`user:` を外したもの） */
  private knownUserAccounts(): Set<string> {
    const rows = this.db.prepare("SELECT id FROM accounts WHERE kind = 'user' AND id LIKE 'user:%'").all() as Array<{
      id: string;
    }>;
    return new Set(rows.map((r) => r.id.slice("user:".length)));
  }

  /** 預り所ごとの「帳簿に載っている預託額」（卓・競馬 + 板） */
  private escrowLedgerByHolder(): Map<string, number> {
    const map = new Map<string, number>();
    const add = (holder: string, amount: number) => map.set(holder, (map.get(holder) ?? 0) + amount);
    if (this.tableExists("casino_escrow")) {
      const rows = this.db
        .prepare("SELECT session_id, SUM(amount) AS s FROM casino_escrow GROUP BY session_id")
        .all() as Array<{ session_id: string; s: number }>;
      for (const r of rows) add(`escrow:session:${r.session_id}`, r.s);
    }
    if (this.tableExists("casino_markets") && this.tableExists("casino_market_bets")) {
      const rows = this.db
        .prepare(
          `SELECT b.market_id AS id, SUM(b.amount) AS s
             FROM casino_market_bets b
             JOIN casino_markets m ON m.id = b.market_id
            WHERE m.status IN ('open','closed','reported','disputed','frozen')
            GROUP BY b.market_id`,
        )
        .all() as Array<{ id: number; s: number }>;
      for (const r of rows) add(`escrow:market:${r.id}`, r.s);
    }
    return map;
  }

  private tableExists(table: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ?").get(table),
    );
  }
}
