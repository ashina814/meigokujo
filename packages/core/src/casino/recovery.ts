import type Database from "better-sqlite3";
import type { EventLog } from "../events/service.js";
import type { CasinoIntegrity } from "./integrity.js";
import type { CasinoStatus } from "./status.js";
import type { ChipTx } from "./chip-tx.js";
import type { Escrow } from "./escrow.js";
import type { HouseReservations } from "./reservations.js";
import type { CasinoChipFlow, InactiveRedeemResult } from "./chip-flow.js";

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
    // type は登録の一意キーであり、失敗ログ・診断の識別子でもある。
    // 空・空白のみは「どの登録元か分からない」ことになるので、登録自体を拒否する（fail-closed・PR7監査）
    if (typeof source.type !== "string" || !source.type.trim()) {
      throw new Error("RecoveryRegistry: type は空にできない");
    }
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
   *
   * **申告の中身も検証する**（PR7監査）。配列でない・要素が空/空白/string以外の
   * holder IDを1件でも含む申告は、その登録元ぶんを丸ごと failed 扱いにする。
   * 「一部だけ取り込んで残りを黙って捨てる」と、壊れた申告を
   * 「生存holderなし」と誤解して孤児返金へ進めてしまいかねないため、
   * 部分採用はせず登録元単位で all-or-nothing にする。
   */
  liveHolders(): { holders: Set<string>; failed: Array<{ type: string; error: string }> } {
    const holders = new Set<string>();
    const failed: Array<{ type: string; error: string }> = [];
    for (const s of this.sources) {
      try {
        const raw = s.listLiveEscrowHolders();
        if (!Array.isArray(raw)) {
          throw new Error(`listLiveEscrowHolders() が配列を返さなかった: ${typeof raw}`);
        }
        const collected: string[] = [];
        for (const h of raw) {
          if (typeof h !== "string" || !h.trim()) {
            throw new Error(`不正な holder ID: ${JSON.stringify(h)}`);
          }
          collected.push(h);
        }
        for (const h of collected) holders.add(h);
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
  /** PR10 S10. Required so startup can never silently skip free-chip redemption. */
  chipFlow: CasinoChipFlow;
}

export interface RecoverCasinoResult {
  /**
   * どこまで進んだか。
   *
   * - `opened`: S12 まで通って営業を開けた
   * - `halted`: 検算 NG で `integrity_halt`（以降を実行していない）
   * - `source_failed`: 所有元の申告が取れなかったので掃除も再開もしていない。
   *   **`recovery_halt`** にする（通常の「再点検」では開けられない・PR7 レビュー指摘）
   * - `refund_failed`: 孤児返金が技術的に失敗したセッションが残っている（`failedSessions`）。
   *   帳簿と保有者残高は一致したまま維持されるため postflight A〜D はたまたま通り得るが、
   *   復旧そのものは完了していない。**`recovery_halt`** にして再実行を求める（PR7監査）。
   *   postflight 自体が別件で NG でも、この判定を postflight の成否より優先する
   *   （PR7監査・二次レビュー：postflight が先に integrity_halt を確定させ、
   *   failedSessions の再試行義務が消えるのを防ぐ）
   * - `exception_failed`: S1〜S12 の途中で予期しない例外が発生した（PR7監査・二次レビュー）。
   *   どこまで安全に完了したか保証できないので、**必ず `recovery_halt`** にする。
   *   startup_check のまま例外を外へ漏らすと、次回起動時に「recovery_halt から
   *   再実行していた」文脈が失われ、通常の再点検から開いてしまいうるため。
   * - `held`: 人が止めている状態なので触っていない
   * - `manual`: `integrity_halt` のまま。運営の再点検待ち
   */
  outcome: "opened" | "halted" | "source_failed" | "refund_failed" | "chip_redeem_failed" | "exception_failed" | "held" | "manual";
  /** 実行したステップ（診断用） */
  steps: string[];
  keptHolders: number;
  refundedSessions: number;
  refundedTotal: number;
  quarantined: number;
  /** 帳簿と保有者残高が合わないセッション。凍結してあり、賭場全体も停止する（運営判断） */
  mismatched: Array<{ sessionId: string; expected: number; actual: number }>;
  /**
   * 孤児返金が**技術的に失敗**したセッション（PR7 レビュー指摘）。
   *
   * 1件の失敗で他の復旧は止めないが、失敗そのものが起動ログから消えてはいけない。
   * 帳簿と残高はそのまま維持してある。
   */
  failedSessions: Array<{ sessionId: string; expected: number; actual: number; error: string }>;
  /** ソロ予約の解放結果。`released: false` なら**解放を実行していない** */
  releasedReservations: { released: boolean; count: number; total: number };
  /** PR10 S10 partial result. Only verified Land-user free-chip holders are candidates. */
  redeemedFreeChips: InactiveRedeemResult;
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
 * **S11（永続卓のメッセージ復旧）は存在しない。** 対人順位卓を 2026-08-16 に廃止し、
 * 再起動をまたいで生存する卓が無くなったため、復旧は S1〜S10・S12 だけを同期で通す。
 * 再起動をまたぐ所有元は `RecoveryRegistry` へ登録する（板など）。
 *
 * 「分からないときは動かさない」を全ステップで徹底する。自動返金は
 * 「所有元が確実に存在しない」と証明できた場合だけ。
 */
export function recoverCasino(deps: RecoverCasinoDeps): RecoverCasinoResult {
  const { status, integrity, chipTx, escrow, reservations, registry, events, chipFlow } = deps;
  const steps: string[] = [];
  const empty: Omit<RecoverCasinoResult, "outcome" | "steps" | "reason"> = {
    keptHolders: 0,
    refundedSessions: 0,
    refundedTotal: 0,
    quarantined: 0,
    mismatched: [],
    failedSessions: [],
    // 予約解放は S9。ここへ到達していない時点では **実行していない**
    releasedReservations: { released: false, count: 0, total: 0 },
    redeemedFreeChips: { redeemed: [], skipped: [], failed: [] },
  };

  const held = status.current();
  // S1 で startup_check へ移ると `held.status` は上書きされて見えなくなる。
  // postflight・不一致・孤児返金の技術失敗を「recovery_halt からの再実行中」に見つけたとき、
  // 通常の integrity_halt へすり替えず recovery_halt を維持するために先に控えておく（PR7監査）。
  const recoveringFromHalt = held.status === "recovery_halt";

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

  // `recovery_halt`（前回の復旧が完了しなかった）からは**やり直す**。
  // これがこの状態の唯一の出口なので、ここで止めると二度と開けられない（PR7）

  // S1 以降・S12 までを丸ごと保護する（PR7監査・二次レビュー）。
  // ここから先で予期しない例外（例: reservations.releaseAll() 内の totalReserved() が
  // DB破損で throw する等）が外へ抜けると、status は S1 で書き換えた startup_check の
  // ままDBに残ってしまう。すると次回起動時 held.status が recovery_halt に見えなくなり、
  // 「recovery_halt から再実行していた」文脈が失われて通常の再点検から開いてしまいうる。
  // どこまで安全に完了したか保証できない以上、例外時も必ず recovery_halt へ着地させる。
  let sweptSoFar: Pick<
    RecoverCasinoResult,
    "keptHolders" | "refundedSessions" | "refundedTotal" | "quarantined" | "mismatched" | "failedSessions"
  > = {
    keptHolders: 0,
    refundedSessions: 0,
    refundedTotal: 0,
    quarantined: 0,
    mismatched: [],
    failedSessions: [],
  };
  // S10 は runMaintenance の中で**グループごとに確定**する（runMaintenance は
  // 深さカウンタでありトランザクションではない）。後続の postflight や
  // event 記録が例外になっても、実際に動いた資金の記録を捨ててはいけない（監査項目8）。
  let redeemedSoFar: InactiveRedeemResult = { redeemed: [], skipped: [], failed: [] };
  try {
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
      // S9 が例外になっても、ここまでの結果を報告できるよう控えておく
      sweptSoFar = {
        keptHolders: swept.kept,
        refundedSessions: swept.refundedSessions,
        refundedTotal: swept.refundedTotal,
        quarantined: swept.quarantined,
        mismatched: swept.mismatched,
        failedSessions: swept.failed,
      };
      steps.push("S5:照合", "S6:維持", "S7:孤児返金", "S8:隔離");

      // S9: ソロゲームの債務予約を全解放（進行中のソロはプロセス内状態なので存在しない）
      const releasedReservations = reservations.releaseAll("起動時の復旧");
      steps.push("S9:予約解放");

      // S10: S4-S9 after ownership recovery, before postflight. The flow joins Land user
      // accounts and never targets escrow/system/orphan holders.
      const redeemedFreeChips =
        chipTx.openingPhase() === "formal"
          ? chipFlow.redeemAllFreeChips("startup")
          : {
              redeemed: [],
              skipped: [{ userId: null, amount: 0, reason: "opening_not_formal" as const }],
              failed: [],
            };
      redeemedSoFar = redeemedFreeChips;
      steps.push("S10:自由チップ返還");

      return {
        keptHolders: swept.kept,
        refundedSessions: swept.refundedSessions,
        refundedTotal: swept.refundedTotal,
        quarantined: swept.quarantined,
        mismatched: swept.mismatched,
        failedSessions: swept.failed,
        releasedReservations: { released: true, ...releasedReservations },
        redeemedFreeChips,
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
      failedSessions: result.failedSessions,
      releasedReservations: result.releasedReservations,
      redeemedFreeChips: result.redeemedFreeChips,
    };

    // **所有元の申告が取れなかったら営業を再開しない**（PR7 レビュー指摘）。
    //
    // 以前はここを素通りして runFull → finishStartupCheck まで進んでいたので、
    // 「所有元が分からないまま open へ戻る」状態になっていた。掃除を見送った以上、
    // 復旧が完了したとは判断できない。運営の確認が必要な状態で止める。
    if (result.skipped) {
      const reason = result.reason ?? "生存中エスクローの収集に失敗";
      // **専用の停止状態**にする。通常の「再点検」（reopenAfterIntegrity）では開かない。
      // 出口は「復旧を再実行」して S4〜S12 を通すことだけ
      status.haltForRecovery(`復旧中断: ${reason}（掃除・予約解放とも未実行。運営の確認が必要）`);
      events.log("casino_recovery_halted", {
        actor: "system:recovery",
        payload: { steps, reason, reservationsReleased: false },
      });
      return { outcome: "source_failed", steps, ...summary, reason };
    }

    return completeRecovery({
      status,
      integrity,
      events,
      steps,
      summary,
      result,
      recoveringFromHalt,
      heldReason: held.reason,
    });
  } catch (e) {
    // S1〜S12 のどこかで予期しない例外。安全性を保証できないので必ず recovery_halt にする
    // （PR7監査・二次レビュー）。S5〜S8 まで確認できていれば、その結果だけは報告する。
    const message = e instanceof Error ? e.message : String(e);
    const failedStep = steps[steps.length - 1] ?? "S1:startup_check";
    const reason = `復旧処理中に予期しない例外（${failedStep}の直後）: ${message}`;
    events.log("casino_recovery_exception", {
      actor: "system:recovery",
      payload: { steps, error: message },
    });
    status.haltForRecovery(recoveringFromHalt ? appendReason(held.reason, reason) : reason);
    const summary = {
      ...sweptSoFar,
      releasedReservations: { released: false, count: 0, total: 0 },
      // 実際に返還した利用者・失敗した利用者・額を消さない。ここを空へ戻すと
      // 「誰にいくら返し終えたか」が失われ、再実行の義務も見えなくなる（監査項目8）
      redeemedFreeChips: redeemedSoFar,
    };
    return { outcome: "exception_failed", steps, ...summary, reason };
  }
}

/**
 * recovery_halt の理由へ追記するとき、同じ文言を無限に重複させない（PR7監査・二次レビュー）。
 * 同一の失敗で再実行を繰り返しても、その行が既にあれば足さない。新しい異常だけ追記し、
 * 元の recovery_halt 理由（1行目以降の履歴）は保持する。
 */
type RecoverySummary = Pick<
  RecoverCasinoResult,
  | "keptHolders"
  | "refundedSessions"
  | "refundedTotal"
  | "quarantined"
  | "mismatched"
  | "failedSessions"
  | "releasedReservations"
  | "redeemedFreeChips"
>;

function completeRecovery(input: {
  status: CasinoStatus;
  integrity: CasinoIntegrity;
  events: EventLog;
  steps: string[];
  summary: RecoverySummary;
  result: RecoverySummary & { skipped: false; reason?: string };
  recoveringFromHalt: boolean;
  heldReason: string;
}): RecoverCasinoResult {
  const { status, integrity, events, steps, summary, result, recoveringFromHalt, heldReason } = input;

  steps.push("S12:後検");
  const post = integrity.runFull();
  const postReason = post.ok ? undefined : describeFailure(post);
  if (!post.ok) {
    events.log("casino_integrity_failed", {
      actor: "system:recovery",
      payload: { phase: "recover_post", ledgerOk: post.ledger.ok, failed: post.failed },
    });
  }

  const outstanding: string[] = [];
  if (result.redeemedFreeChips.failed.length > 0) {
    outstanding.push(
      `S10自由チップ返還失敗 ${result.redeemedFreeChips.failed.length}件: ` +
        result.redeemedFreeChips.failed.map((failure) => `${failure.userId}(${failure.amount}): ${failure.error}`).join(", "),
    );
  }
  if (result.failedSessions.length > 0) {
    outstanding.push(`escrow refund failed: ${result.failedSessions.length}: ${result.failedSessions.map((f) => `${f.sessionId}: ${f.error}`).join(", ")}`);
  }
  if (result.mismatched.length > 0) outstanding.push(`escrow balance mismatch: ${result.mismatched.length}`);
  if (!post.ok) outstanding.push(`後検NG: ${postReason ?? "不明"}`);

  if (result.redeemedFreeChips.failed.length > 0) {
    const reason = outstanding.join(" / ");
    events.log("casino_recovery_halted", {
      actor: "system:recovery",
      payload: {
        steps,
        reason,
        outstanding,
        redeemedFreeChips: result.redeemedFreeChips,
        failedSessions: result.failedSessions,
        mismatched: result.mismatched,
        postflightOk: post.ok,
      },
    });
    status.haltForRecovery(recoveringFromHalt ? appendReason(heldReason, reason) : reason);
    return { outcome: "chip_redeem_failed", steps, ...summary, reason };
  }

  if (result.failedSessions.length > 0) {
    const refundReason =
      `escrow refund failed: ${result.failedSessions.length}: ` +
      result.failedSessions.map((f) => `${f.sessionId}(expected ${f.expected}/actual ${f.actual}): ${f.error}`).join(", ");
    const reason = postReason ? `${refundReason} / 検算NG: ${postReason}` : refundReason;
    events.log("casino_recovery_halted", {
      actor: "system:recovery",
      payload: { steps, reason, failedSessions: result.failedSessions, postflightOk: post.ok },
    });
    status.haltForRecovery(recoveringFromHalt ? appendReason(heldReason, reason) : reason);
    return { outcome: "refund_failed", steps, ...summary, reason };
  }

  if (!post.ok) {
    const reason = postReason!;
    if (recoveringFromHalt) {
      status.haltForRecovery(appendReason(heldReason, `検算NG(復旧再実行後の全点検): ${reason}`));
    } else {
      status.haltForIntegrity(reason);
    }
    return { outcome: "halted", steps, ...summary, reason };
  }

  if (result.mismatched.length > 0) {
    const reason =
      `escrow balance mismatch: ${result.mismatched.length}: ` +
      result.mismatched.map((m) => `${m.sessionId}(expected ${m.expected}/actual ${m.actual})`).join(", ");
    events.log("casino_recovery_halted", {
      actor: "system:recovery",
      payload: { steps, reason, mismatched: result.mismatched },
    });
    if (recoveringFromHalt) {
      status.haltForRecovery(appendReason(heldReason, reason));
    } else {
      status.haltForIntegrity(reason);
    }
    return { outcome: "halted", steps, ...summary, reason };
  }

  status.finishStartupCheck("system:recovery");
  steps.push("S12:再開");
  events.log("casino_recovered", { actor: "system:recovery", payload: { steps, ...summary } });
  return { outcome: "opened", steps, ...summary, reason: result.reason };
}

function appendReason(base: string, addition: string): string {
  const lines = base.split("\n");
  if (lines.includes(addition)) return base;
  return `${base}\n${addition}`;
}

function describeFailure(report: ReturnType<CasinoIntegrity["runFull"]>): string {
  const bits: string[] = [];
  if (!report.ledger.ok) bits.push(`Land台帳: ${report.ledger.detail}`);
  for (const c of report.checks) if (!c.ok) bits.push(`検算${c.id}(${c.name}): ${c.detail}`);
  return bits.join(" / ") || "不明な検算NG";
}
