import type Database from "better-sqlite3";
import type { EventLog } from "../events/service.js";
import type { CasinoIntegrity } from "./integrity.js";
import type { CasinoStatus } from "./status.js";
import type { ChipTx } from "./chip-tx.js";
import type { Escrow } from "./escrow.js";
import type { HouseReservations } from "./reservations.js";

/**
 * 登録型の復旧レジストリ（大型UPD PR7・正本 §8.1）。
 *
 * 起動時の掃除は「台帳に残っている預託を全部返す」ではいけない。板や（PR20 以降の）対人卓は
 * 再起動をまたいで生きているので、返してしまうと卓は資金を失ったまま残る。
 * かといって掃除の実装の中に板テーブルを直接読む分岐を足していくと、
 * 種類が増えるたびに掃除そのものを触ることになる。
 *
 * そこで**所有元の側が「いま生きている預託holder」を申告する**形にする。
 * 掃除は登録された申告だけを見て、それ以外を孤児として扱う。
 *
 * 競馬は登録しない（意図的）。永続テーブルが無く、再起動でレース自体が消えるので、
 * その預託は「所有元が存在しない孤児」= 返金するのが正しい挙動になる。
 */
export interface RecoverySource {
  /** 種別（`market` / 将来 `table` など）。ログと診断に使う */
  readonly type: string;
  /** いま生きている（＝返金してはいけない）エスクロー保有者ID */
  listLiveEscrowHolders(): string[];
}

export class RecoveryRegistry {
  private readonly sources: RecoverySource[] = [];

  register(source: RecoverySource): void {
    if (this.sources.some((s) => s.type === source.type)) {
      throw new Error(`RecoveryRegistry: 種別 ${source.type} は既に登録済み`);
    }
    this.sources.push(source);
  }

  types(): string[] {
    return this.sources.map((s) => s.type);
  }

  /**
   * 全登録元から生存中の保有者を集める。
   * 1つの申告が落ちても他を止めない（片方の壊れたテーブルで全部を返金させない）。
   */
  liveHolders(): { holders: Set<string>; failed: Array<{ type: string; error: string }> } {
    const holders = new Set<string>();
    const failed: Array<{ type: string; error: string }> = [];
    for (const s of this.sources) {
      try {
        for (const h of s.listLiveEscrowHolders()) holders.add(h);
      } catch (e) {
        failed.push({ type: s.type, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { holders, failed };
  }
}

export interface RecoverCasinoDeps {
  db: Database.Database;
  status: CasinoStatus;
  integrity: CasinoIntegrity;
  chipTx: ChipTx;
  escrow: Escrow;
  reservations: HouseReservations;
  registry: RecoveryRegistry;
  events: EventLog;
}

export interface RecoverCasinoResult {
  /** どこまで進んだか。`halted` は S2/S3 で止めた（以降を実行していない） */
  outcome: "opened" | "halted" | "held" | "manual";
  /** 実行したステップ（診断用） */
  steps: string[];
  keptHolders: number;
  refundedSessions: number;
  refundedTotal: number;
  quarantined: number;
  mismatched: Array<{ sessionId: string; expected: number; actual: number }>;
  releasedReservations: { count: number; total: number };
  reason?: string;
}

/**
 * 起動・復旧シーケンス（正本 §8.2）。
 *
 * ```text
 * S1  startup_check へ移行
 * S2  Land台帳の検算
 * S3  チップの検算A・B
 * S4  recoveryRegistry から生存中エスクローを収集
 * S5  帳簿と holder 残高を照合
 * S6  生存中かつ一致する預託は維持
 * S7  所有元が確実に存在しない孤児だけ返金
 * S8  帳簿なし残高は quarantine へ隔離
 * S9  ソロゲームの債務予約を解放
 * S12 問題がなければ、元の状態が startup_check の場合だけ open へ戻す
 * ```
 *
 * **S10（自由チップの Land 返還）は PR10、S11（永続卓のメッセージ復旧）は PR20** の範囲なので
 * ここには入っていない。両方ともこの関数へ足す形で追加する。
 *
 * 「分からないときは動かさない」を全ステップで徹底する。自動返金は
 * 「所有元が確実に存在しない」と証明できた場合だけ。
 */
export function recoverCasino(deps: RecoverCasinoDeps): RecoverCasinoResult {
  const { status, integrity, chipTx, escrow, reservations, registry, events } = deps;
  const steps: string[] = [];
  const empty: Omit<RecoverCasinoResult, "outcome" | "steps" | "reason"> = {
    keptHolders: 0,
    refundedSessions: 0,
    refundedTotal: 0,
    quarantined: 0,
    mismatched: [],
    releasedReservations: { count: 0, total: 0 },
  };

  const held = status.current();

  // S2/S3 は状態に関わらず先に走らせる。人が止めていても「壊れているか」は知りたい。
  // **前検は Land台帳 + 検算A・B だけ**（正本 §8.2）。C（エスクロー）と D（系全体）は
  // 孤児や不一致で落ちるが、それはまさにこれから掃除する対象なので、前検に含めると
  // 「掃除すべき状態を理由に掃除を中止する」ことになる
  const report = integrity.runStartupPrecheck();
  steps.push("S2:Land台帳", "S3:チップ検算AB");
  if (!report.ok) {
    events.log("casino_integrity_failed", {
      actor: "system:recovery",
      payload: { phase: "recover", ledgerOk: report.ledger.ok, failed: report.failed },
    });
  }

  // 人が止めている状態（manual_halt / maintenance / opening_reset）は触らない。
  // 資金を1 Ld も動かさず、状態も上書きしない（止めた理由が検算の話にすり替わる）
  if (held.status === "manual_halt" || held.status === "maintenance" || held.status === "opening_reset") {
    return { outcome: "held", steps, ...empty, reason: `${held.status}: ${held.reason}` };
  }

  if (!report.ok) {
    // S2 or S3 が NG → 以降のステップを実行しない（チップも Land も動かさない）
    const reason = describeFailure(report);
    status.haltForIntegrity(reason);
    return { outcome: "halted", steps, ...empty, reason };
  }

  if (held.status === "integrity_halt") {
    // 検算は通っているが、人がまだ確認していない。掃除も再開も自動ではしない
    return { outcome: "manual", steps, ...empty, reason: "integrity_halt のまま（運営の再点検待ち）" };
  }

  // S1: ここから資金を動かす区間へ入る
  status.beginStartupCheck();
  steps.push("S1:startup_check");

  const result = chipTx.runMaintenance("起動時の復旧（recoverCasino）", () => {
    // S4: 生存中の預託を所有元から集める
    const live = registry.liveHolders();
    steps.push("S4:生存収集");
    if (live.failed.length > 0) {
      // 申告に失敗した種別がある = その種別の預託を孤児と誤認しうる。
      // 分からないときは動かさないので、掃除そのものを見送る
      events.log("casino_recovery_source_failed", { actor: "system:recovery", payload: { failed: live.failed } });
      return {
        ...empty,
        skipped: true as const,
        reason: `生存中エスクローの収集に失敗（${live.failed.map((f) => f.type).join(",")}）`,
      };
    }

    // S5〜S8: 照合 → 維持 → 孤児返金 → 帳簿なし残高の隔離
    const swept = escrow.recoverSessions("system:recovery", live.holders);
    steps.push("S5:照合", "S6:維持", "S7:孤児返金", "S8:隔離");

    // S9: ソロゲームの債務予約を全解放（進行中のソロはプロセス内状態なので存在しない）
    const releasedReservations = reservations.releaseAll("起動時の復旧");
    steps.push("S9:予約解放");

    return {
      keptHolders: swept.kept,
      refundedSessions: swept.refundedSessions,
      refundedTotal: swept.refundedTotal,
      quarantined: swept.quarantined,
      mismatched: swept.mismatched,
      releasedReservations,
      skipped: false as const,
      reason: undefined as string | undefined,
    };
  });

  const summary = {
    keptHolders: result.keptHolders,
    refundedSessions: result.refundedSessions,
    refundedTotal: result.refundedTotal,
    quarantined: result.quarantined,
    mismatched: result.mismatched,
    releasedReservations: result.releasedReservations,
  };

  // 掃除のあとに**全点検（A〜D）**。ここで初めて C・D まで見る
  // （掃除が終わっていれば孤児も不一致も解消しているはず）
  const post = integrity.runFull();
  if (!post.ok) {
    const reason = describeFailure(post);
    events.log("casino_integrity_failed", {
      actor: "system:recovery",
      payload: { phase: "recover_post", ledgerOk: post.ledger.ok, failed: post.failed },
    });
    status.haltForIntegrity(reason);
    return { outcome: "halted", steps, ...summary, reason };
  }

  // S12: 元の状態が startup_check のときだけ open へ戻す
  status.finishStartupCheck("system:recovery");
  steps.push("S12:再開");
  events.log("casino_recovered", { actor: "system:recovery", payload: { steps, ...summary, skipped: result.skipped } });
  return { outcome: "opened", steps, ...summary, reason: result.reason };
}

function describeFailure(report: ReturnType<CasinoIntegrity["runFull"]>): string {
  const bits: string[] = [];
  if (!report.ledger.ok) bits.push(`Land台帳: ${report.ledger.detail}`);
  for (const c of report.checks) if (!c.ok) bits.push(`検算${c.id}(${c.name}): ${c.detail}`);
  return bits.join(" / ") || "不明な検算NG";
}
