import type Database from "better-sqlite3";
import { Ledger, TREASURY } from "../ledger/service.js";
import { ChipTx, LEGACY_OPENING_VERSION, FORMAL_OPENING_VERSION } from "./chip-tx.js";
import { ETHER_APPROVER, ChipLedger, HOUSE_HOLDER, POOL_SWEEP_REASON } from "./chip-ledger.js";
import { Escrow, ESCROW_QUARANTINE } from "./escrow.js";
import {
  CasinoChipAssets,
  type EscrowAssetInspection,
  type EscrowAssetMismatch,
  type EscrowAssetMismatchCode,
} from "./chip-assets.js";
import { JACKPOT_HOLDER, RELIEF_HOLDER } from "./service.js";
import { FREE_SPIN_JACKPOT_CLAIMS_HOLDER } from "./free-spins.js";

export type CasinoCheckId = "A" | "B" | "C" | "D";

export interface CasinoCheckMismatch {
  subject: string;
  expected: number;
  actual: number;
  note?: string;
}

export interface CasinoCheckResult {
  id: CasinoCheckId;
  name: string;
  ok: boolean;
  detail: string;
  mismatches: CasinoCheckMismatch[];
}

export interface CasinoIntegrityReport {
  ok: boolean;
  ledger: { ok: boolean; detail: string };
  checks: CasinoCheckResult[];
  failed: CasinoCheckId[];
  checkedAt: number;
}

const SYSTEM_HOLDERS: ReadonlySet<string> = new Set([
  HOUSE_HOLDER,
  JACKPOT_HOLDER,
  RELIEF_HOLDER,
  ESCROW_QUARANTINE,
  FREE_SPIN_JACKPOT_CLAIMS_HOLDER,
]);

const D_ASSET_CODES: ReadonlySet<EscrowAssetMismatchCode> = new Set([
  "invalid_legacy_source",
  "duplicate_ownership",
  "invalid_user_id",
  "unknown_escrow_holder",
]);

const MAX_MISMATCHES = 20;

interface PoolTxRule {
  direction: "in" | "out";
  counterparty: "user" | "system" | "treasury";
  actor?: string;
  keySuffix?: ":burn" | ":sweep";
  reason?: string;
}

const LEGACY_ETHER_TX_RULES: Record<string, PoolTxRule[]> = {
  ether_buy: [{ direction: "in", counterparty: "user" }],
  ether_house_fund: [{ direction: "in", counterparty: "system", actor: ETHER_APPROVER }],
  ether_sell: [{ direction: "out", counterparty: "user" }],
  ether_settle: [{ direction: "out", counterparty: "system" }],
  ether_burn: [
    { direction: "out", counterparty: "treasury", keySuffix: ":burn" },
    { direction: "out", counterparty: "treasury", keySuffix: ":sweep", reason: POOL_SWEEP_REASON },
  ],
};

interface ChipPoolTxRule {
  direction: "in" | "out";
  counterparty: "user" | "system";
  reason: string;
  groupKind: "deposit" | "redeem";
  chipTxKind: "deposit" | "redeem";
  holderSide: "to" | "from";
  actor: "user" | "approver" | "any";
}

/**
 * 内側から預入・返還を起こしてよい業務グループの種別。
 *
 * **call-site 監査の結果をそのまま写したもの**（2026-08-11）。ここに無い種別の中で
 * Land が動いていたら、設計外の経路なので検算Bで止める。
 * - `shop` … 賭場商店の購入で不足分を自動預入（`shop:buy:*`）
 * - `table_hold` … ランク卓の着席で不足分を自動預入（`ranked:join:*`）
 * - `remittance` … 月次納付。胴元チップを精算してLandへ戻す
 * - `bailout` … 補填。Landを胴元チップへ replenish する
 *
 * 新しい入れ子を作るときは、ここへ足すことが設計判断の記録になる。
 */
const NESTED_CHIP_GROUP_KINDS = new Set(["shop", "table_hold", "remittance", "bailout"]);

/** `user:123` と `123` を同じ人として比べる（グループの actor 表記が経路で揺れている） */
function principalOf(actor: string): string {
  return actor.startsWith("user:") ? actor.slice("user:".length) : actor;
}

const CHIP_POOL_TX_RULES: Record<string, ChipPoolTxRule> = {
  chip_deposit: {
    direction: "in", counterparty: "user", reason: "賭場チップ預入",
    groupKind: "deposit", chipTxKind: "deposit", holderSide: "to", actor: "user",
  },
  chip_redeem: {
    direction: "out", counterparty: "user", reason: "賭場チップ返還",
    groupKind: "redeem", chipTxKind: "redeem", holderSide: "from", actor: "user",
  },
  chip_fund: {
    direction: "in", counterparty: "system", reason: "胴元の元手",
    groupKind: "deposit", chipTxKind: "deposit", holderSide: "to", actor: "approver",
  },
  chip_settle: {
    direction: "out", counterparty: "system", reason: "賭場収益の精算",
    groupKind: "redeem", chipTxKind: "redeem", holderSide: "from", actor: "any",
  },
};

type OpeningVersionKind = "legacy" | "formal" | "unknown";

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
  /** この明細を動かした操作の冪等キー（入れ子なら内側）。Land取引の冪等キーと1:1 */
  op_key: string | null;
  /** その操作の実行者。入れ子では外側グループの actor と異なりうる */
  op_actor_id: string | null;
  tx_kind: string;
  from_holder: string | null;
  to_holder: string | null;
  amount: number;
  land_amount: number | null;
  ledger_tx_id: number | null;
  opening_version: string;
  actor_id: string;
}

interface ChipGroupAuditRow {
  group_key: string;
  kind: string;
  actor_id: string;
  status: string;
}

const now = () => Math.floor(Date.now() / 1000);

export class CasinoIntegrity {
  private readonly chipTx: ChipTx;
  private readonly chipAssets: CasinoChipAssets;

  constructor(
    private readonly db: Database.Database,
    private readonly ledger: Ledger,
    private readonly ether: ChipLedger,
    _escrow: Escrow,
    chipAssets?: CasinoChipAssets,
  ) {
    this.chipTx = ether.chipTx;
    this.chipAssets = chipAssets ?? new CasinoChipAssets(db, ether);
  }

  runFull(): CasinoIntegrityReport {
    const snapshot = this.db.transaction((): CasinoIntegrityReport => {
      const ledger = this.checkLedger();
      const escrowAssets = this.chipAssets.inspectEscrowed();
      const checks = [
        this.checkA(),
        this.checkB(),
        this.checkCFromInspection(escrowAssets),
        this.checkDFromInspection(escrowAssets),
      ];
      const failed = checks.filter((c) => !c.ok).map((c) => c.id);
      return { ok: ledger.ok && failed.length === 0, ledger, checks, failed, checkedAt: now() };
    });
    return snapshot.deferred();
  }

  /** 起動前検は復旧対象であるC/Dを含めず、Land台帳+A/Bだけを維持する。 */
  runStartupPrecheck(): CasinoIntegrityReport {
    const snapshot = this.db.transaction((): CasinoIntegrityReport => {
      const ledger = this.checkLedger();
      const checks = [this.checkA(), this.checkB()];
      const failed = checks.filter((c) => !c.ok).map((c) => c.id);
      return { ok: ledger.ok && failed.length === 0, ledger, checks, failed, checkedAt: now() };
    });
    return snapshot.deferred();
  }

  static describeFailure(report: CasinoIntegrityReport): string {
    const parts: string[] = [];
    if (!report.ledger.ok) parts.push(report.ledger.detail);
    for (const c of report.checks) if (!c.ok) parts.push(`検算${c.id}(${c.name}): ${c.detail}`);
    return parts.length === 0 ? "検算はすべて正常" : parts.join(" / ");
  }

  checkLedger(): { ok: boolean; detail: string } {
    const r = this.ledger.verifyIntegrity();
    return {
      ok: r.ok,
      detail: r.ok ? "Land台帳は正常" : `Land台帳の残高キャッシュが ${r.mismatches.length}件 不一致`,
    };
  }

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

  checkB(): CasinoCheckResult {
    const version = this.chipTx.currentVersion();
    const kind = classifyOpeningVersion(version);
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

  private classifyPoolTxRow(row: PoolTxRow, version: string, kind: "legacy" | "formal"): string | null {
    if (row.type.startsWith("chip_")) {
      if (kind !== "formal") return `tx_type_not_allowed_for_version:${row.type}`;
      return this.classifyChipPoolTx(row, version);
    }
    if (row.type.startsWith("ether_")) {
      if (kind !== "legacy") return `tx_type_not_allowed_for_version:${row.type}`;
      return this.classifyLegacyEtherPoolTx(row, version);
    }
    return `tx_type_not_allowed_for_version:${row.type}`;
  }

  private classifyLegacyEtherPoolTx(row: PoolTxRow, version: string): string | null {
    const rules = LEGACY_ETHER_TX_RULES[row.type];
    if (!rules) return `tx_type_not_allowed_for_version:${row.type}`;
    const direction: "in" | "out" = row.to_account === this.ether.reserveHolder() ? "in" : "out";
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
    const suffix = rule.keySuffix;
    if (suffix && !row.idempotency_key.endsWith(suffix)) return "missing_key_suffix";
    const groupKey = suffix ? row.idempotency_key.slice(0, -suffix.length) : row.idempotency_key;
    if (!this.chipTx.hasGroup(groupKey)) return "no_chip_group";
    if (!this.groupBelongsToVersion(groupKey, version)) return "group_version_mismatch";
    return null;
  }

  private groupBelongsToVersion(groupKey: string, version: string): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM casino_tx WHERE group_key = ? AND opening_version = ?")
      .get(groupKey, version) as { c: number };
    return row.c > 0;
  }

  private classifyChipPoolTx(row: PoolTxRow, version: string): string | null {
    const rule = CHIP_POOL_TX_RULES[row.type];
    if (!rule) return `tx_type_not_allowed_for_version:${row.type}`;
    if (row.from_account === row.to_account) return "self_transfer";
    const direction: "in" | "out" = row.to_account === this.ether.reserveHolder() ? "in" : "out";
    if (direction !== rule.direction) return `wrong_direction:${row.type}`;

    const other = direction === "in" ? row.from_account : row.to_account;
    if (rule.counterparty === "user" && !other.startsWith("user:")) return `wrong_counterparty:${other}`;
    if (rule.counterparty === "system" && (!other.startsWith("sys:") || other === TREASURY)) {
      return `wrong_counterparty:${other}`;
    }
    if (row.approved_by !== ETHER_APPROVER) return "wrong_approver";
    if (row.ref_type !== "casino_chip") return "wrong_ref_type";
    if (!row.ref_id || !row.ref_id.trim()) return "missing_ref_id";
    if (row.reason !== rule.reason) return "wrong_reason";
    if (rule.counterparty === "user" && other !== `user:${row.ref_id}`) return `wrong_counterparty:${other}`;
    if (rule.actor === "approver" && row.actor_id !== ETHER_APPROVER) return `wrong_actor:${row.actor_id}`;
    if (rule.actor === "user" && row.actor_id !== `user:${row.ref_id}`) return `wrong_actor:${row.actor_id}`;

    const details = this.db
      .prepare(
        `SELECT group_key, tx_kind, from_holder, to_holder, amount, land_amount, ledger_tx_id, opening_version,
                actor_id, op_key, op_actor_id
           FROM casino_tx WHERE ledger_tx_id = ?`,
      )
      .all(row.id) as ChipTxDetailRow[];
    if (details.length === 0) return "no_matching_chip_tx";
    if (details.length > 1) return "multiple_matching_chip_tx";
    const detail = details[0]!;
    // 操作キーが正本。入れ子で動いた明細は外側グループへ合流するので group_key では特定できない
    if (!detail.op_key) return "missing_op_key";
    if (detail.op_key !== row.idempotency_key) return "op_key_mismatch";
    const sameOpKey = this.db
      .prepare("SELECT COUNT(*) AS c FROM casino_tx WHERE op_key = ? AND ledger_tx_id IS NOT NULL")
      .get(detail.op_key) as { c: number };
    if (sameOpKey.c !== 1) return "op_key_not_unique";
    if (detail.opening_version !== version) return "chip_tx_version_mismatch";
    if (detail.tx_kind !== rule.chipTxKind) return "tx_kind_mismatch";
    if (detail.land_amount !== row.amount) return "land_amount_mismatch";
    if (detail.amount !== row.amount) return "chip_amount_mismatch";
    if ((detail.op_actor_id ?? detail.actor_id) !== row.actor_id) return "chip_tx_actor_mismatch";
    const holder = rule.holderSide === "to" ? detail.to_holder : detail.from_holder;
    if (holder !== row.ref_id) return "holder_mismatch";

    return this.classifyChipGroup(row, detail, rule);
  }

  /**
   * この明細が属するグループを検める。
   *
   * **単独の操作**（`op_key === group_key`）は従来どおり厳密に見る。
   * **入れ子**（正規の業務操作の中で自動預入・精算が動いた場合）は、外側グループの
   * 種別まで deposit/redeem を求めると必ず落ちる。入れ子を許すのは
   * 「そこから資金移動を起こしてよい」と設計上決めた業務種別だけに限り、
   * 誰の資金かは `op_actor_id` と holder で押さえる。
   */
  private classifyChipGroup(row: PoolTxRow, detail: ChipTxDetailRow, rule: ChipPoolTxRule): string | null {
    const group = this.db
      .prepare("SELECT group_key, kind, actor_id, status FROM casino_tx_groups WHERE group_key = ?")
      .get(detail.group_key) as ChipGroupAuditRow | undefined;
    if (!group) return "no_chip_group";
    if (group.status !== "settled") return `group_not_settled:${group.status}`;

    const nested = detail.op_key !== detail.group_key;
    if (nested) {
      if (!NESTED_CHIP_GROUP_KINDS.has(group.kind)) return `group_kind_not_nestable:${group.kind}`;
      // 利用者の資金は、その利用者の業務操作の中でしか動かせない
      // （`user:` の有無は呼び出し側で揺れているため、principal を揃えて比べる）
      if (rule.actor === "user" && principalOf(group.actor_id) !== principalOf(row.actor_id)) {
        return "group_actor_mismatch";
      }
    } else {
      if (group.kind !== rule.groupKind) return "group_kind_mismatch";
      if (group.actor_id !== row.actor_id) return "group_actor_mismatch";
    }

    // 明細の actor は必ず所属グループの actor（`record()` がそう書く）。
    // ここが崩れているなら、明細かグループのどちらかが後から書き換えられている
    if (detail.actor_id !== group.actor_id) return "chip_tx_actor_mismatch";
    return null;
  }

  checkC(): CasinoCheckResult {
    return this.checkCFromInspection(this.chipAssets.inspectEscrowed());
  }

  private checkCFromInspection(inspection: EscrowAssetInspection): CasinoCheckResult {
    const mismatches = inspection.mismatches.map((m) => this.assetMismatchToCheck(m));
    const freeSpinClaims = this.freeSpinJackpotClaimMismatch();
    if (freeSpinClaims) mismatches.push(freeSpinClaims);
    const ok = mismatches.length === 0;
    return {
      id: "C",
      name: "預託",
      ok,
      detail: ok
        ? "卓・板の預り金とフリースピンJP請求は共通資産監査どおり"
        : `共通資産監査で ${mismatches.length}件の不一致を検出（${mismatches[0]!.subject}: ${mismatches[0]!.note ?? "detailなし"}）`,
      mismatches: mismatches.slice(0, MAX_MISMATCHES),
    };
  }

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

  checkD(): CasinoCheckResult {
    return this.checkDFromInspection(this.chipAssets.inspectEscrowed());
  }

  private checkDFromInspection(inspection: EscrowAssetInspection): CasinoCheckResult {
    const holders = this.db.prepare("SELECT user_id, amount FROM ether_balances WHERE amount != 0").all() as Array<{
      user_id: string;
      amount: number;
    }>;
    const bookedByHolder = new Map<string, number>(
      inspection.holders.map((row) => [row.holder, row.expected] as const),
    );
    const knownUsers = new Set<string>(inspection.knownUserIds);
    const mismatches = inspection.mismatches
      .filter((m) => D_ASSET_CODES.has(m.code))
      .map((m) => this.assetMismatchToCheck(m));

    let outstanding = 0;
    let classified = 0;
    for (const h of holders) {
      if (!Number.isSafeInteger(h.amount) || h.amount < 0) {
        mismatches.push({ subject: h.user_id, expected: 0, actual: h.amount, note: "corrupt_holder_amount" });
        continue;
      }
      outstanding += h.amount;
      if (!Number.isSafeInteger(outstanding)) {
        mismatches.push({ subject: "発行総量", expected: 0, actual: outstanding, note: "outstanding_overflow" });
        break;
      }
      if (SYSTEM_HOLDERS.has(h.user_id)) {
        classified += h.amount;
        continue;
      }
      if (h.user_id.startsWith("escrow:")) {
        const booked = bookedByHolder.get(h.user_id) ?? 0;
        classified += booked;
        if (booked !== h.amount) {
          mismatches.push({
            subject: h.user_id,
            expected: booked,
            actual: h.amount,
            note: "共通資産監査で本人帰属を確定できない預り所残高",
          });
        }
        continue;
      }
      if (knownUsers.has(h.user_id)) {
        classified += h.amount;
        continue;
      }
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
        ? `発行済み ${outstanding.toLocaleString()} ◈ は共通資産監査を含めすべて実在する帰属先がある`
        : `${mismatches.length}件の帰属不明がある（${mismatches[0]!.subject}: ${mismatches[0]!.note}）`,
      mismatches: mismatches.slice(0, MAX_MISMATCHES),
    };
  }

  private assetMismatchToCheck(mismatch: EscrowAssetMismatch): CasinoCheckMismatch {
    const affected = mismatch.affectedUserIds?.length
      ? ` affected=${mismatch.affectedUserIds.join(",")}`
      : "";
    return {
      subject: mismatch.sourceKind && mismatch.sourceId
        ? `${mismatch.sourceKind}:${mismatch.sourceId}`
        : mismatch.holder,
      expected: mismatch.expected ?? 0,
      actual: mismatch.actual ?? 0,
      note: `${mismatch.code} scope=${mismatch.scope}${affected}${mismatch.detail ? `: ${mismatch.detail}` : ""}`,
    };
  }

  private tableExists(table: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ?").get(table),
    );
  }
}
