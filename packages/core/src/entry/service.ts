import type Database from "better-sqlite3";
import { Ledger, TREASURY } from "../ledger/service.js";
import { Settings } from "../settings/service.js";
import { EventLog } from "../events/service.js";

export type BookingStatus = "booked" | "attended" | "ghosted" | "dropped";
export type InviterSource = "user" | "disboard" | "lumina" | "none";

export interface BookingRow {
  user_id: string;
  slot: string; // 'YYYY-MM-DD HH' (JST) または 'flex'（時間外・個別希望）
  status: BookingStatus;
  inviter_user_id: string | null;
  inviter_source: InviterSource;
  no_show_count: number;
  created_at: number;
  updated_at: number;
}

export interface SoulRow {
  user_id: string;
  status: "waiting" | "ghost" | "majin" | "mazoku" | "meirei" | "departed";
  joined_at: number | null;
  ghost_at: number | null;
  eval_deadline_at: number | null;
  eval_extension_days: number;
  inviter_user_id: string | null;
  inviter_source: string | null;
  updated_at: number;
}

export interface GhostifyResult {
  userId: string;
  granted: number; // 初期発行額（既発行なら 0）
  evalDeadlineAt: number;
  inviterExtendedDays: number; // 招待者の評価期限を何日延長したか
}

const now = () => Math.floor(Date.now() / 1000);
const DAY = 86_400;

/**
 * 入城導線（ボット設計.md 説明会予約制）。
 * 予約 → 出席 → 一括亡霊化（ロール変更はbot側、記帳・期限・招待実績はここ）。
 */
export class Entry {
  constructor(
    private readonly db: Database.Database,
    private readonly ledger: Ledger,
    private readonly settings: Settings,
    private readonly events: EventLog,
  ) {}

  /** サーバー参加の記録（魂台帳に waiting で登録） */
  recordJoin(userId: string): void {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO souls (user_id, status, joined_at, updated_at) VALUES (?, 'waiting', ?, ?)
         ON CONFLICT(user_id) DO NOTHING`,
      )
      .run(userId, ts, ts);
    this.events.log("join", { target: userId });
  }

  getSoul(userId: string): SoulRow | undefined {
    return this.db.prepare("SELECT * FROM souls WHERE user_id = ?").get(userId) as SoulRow | undefined;
  }

  /** 指定ステータスの魂を列挙（評価スレッド日次更新等の一括処理用） */
  listSouls(status: SoulRow["status"]): SoulRow[] {
    return this.db.prepare("SELECT * FROM souls WHERE status = ? ORDER BY ghost_at").all(status) as SoulRow[];
  }

  /**
   * 魂を「案内待ち」にリセット（亡霊ロールが剥奪された時など）。
   * ghost_at・eval_deadline_at・eval_extension_days を消し、招待延長フラグも掃除する。
   * 台帳の初期発行は残るので、次回 ghostify では二重発行されない。
   */
  resetToWaiting(userId: string, actor: string): void {
    const ts = now();
    this.db
      .prepare(
        "UPDATE souls SET status='waiting', ghost_at=NULL, eval_deadline_at=NULL, eval_extension_days=0, updated_at=? WHERE user_id=?",
      )
      .run(ts, userId);
    // 招待延長の後追い適用フラグを掃除（次に亡霊化した時にまた延長を受け付けられるように）
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(`invite_ext_applied:${userId}`);
    this.events.log("ghost_reset", { actor, target: userId });
  }

  getBooking(userId: string): BookingRow | undefined {
    return this.db.prepare("SELECT * FROM entry_bookings WHERE user_id = ?").get(userId) as
      | BookingRow
      | undefined;
  }

  /** 説明会枠の予約（再予約は上書き）。ghosted 済みは受け付けない */
  book(userId: string, slot: string, inviter: { userId?: string; source: InviterSource }): BookingRow {
    const existing = this.getBooking(userId);
    if (existing?.status === "ghosted") return existing;
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO entry_bookings (user_id, slot, status, inviter_user_id, inviter_source, no_show_count, created_at, updated_at)
         VALUES (?, ?, 'booked', ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           slot = excluded.slot, status = 'booked',
           inviter_user_id = excluded.inviter_user_id, inviter_source = excluded.inviter_source,
           updated_at = excluded.updated_at`,
      )
      .run(userId, slot, inviter.userId ?? null, inviter.source, existing?.no_show_count ?? 0, ts, ts);
    this.events.log("entry_booked", { target: userId, payload: { slot, inviter } });
    return this.getBooking(userId)!;
  }

  /** VC入室から出席を記録（booked → attended） */
  markAttended(userId: string): boolean {
    const changed = this.db
      .prepare("UPDATE entry_bookings SET status = 'attended', updated_at = ? WHERE user_id = ? AND status = 'booked'")
      .run(now(), userId);
    return changed.changes > 0;
  }

  /** 指定枠の判定材料: 出席済みと欠席（bookedのまま）を分けて返す */
  judgeSlot(slot: string): { attended: BookingRow[]; absent: BookingRow[] } {
    const rows = this.db
      .prepare("SELECT * FROM entry_bookings WHERE slot = ? AND status IN ('booked','attended')")
      .all(slot) as BookingRow[];
    return {
      attended: rows.filter((r) => r.status === "attended"),
      absent: rows.filter((r) => r.status === "booked"),
    };
  }

  listBySlot(slot: string): BookingRow[] {
    return this.db
      .prepare("SELECT * FROM entry_bookings WHERE slot = ? AND status IN ('booked','attended') ORDER BY created_at")
      .all(slot) as BookingRow[];
  }

  /** 計器盤用のサマリー: 予約待ち人数・最古の予約日時・入城案内待ち（未申請含む）人数 */
  queueSummary(): { booked: number; oldestBookedAt: number | null; waiting: number } {
    const booked = (
      this.db.prepare("SELECT COUNT(*) AS c FROM entry_bookings WHERE status = 'booked'").get() as { c: number }
    ).c;
    const oldest = (
      this.db.prepare("SELECT MIN(created_at) AS t FROM entry_bookings WHERE status = 'booked'").get() as {
        t: number | null;
      }
    ).t;
    const waiting = (
      this.db.prepare("SELECT COUNT(*) AS c FROM souls WHERE status = 'waiting'").get() as { c: number }
    ).c;
    return { booked, oldestBookedAt: oldest, waiting };
  }

  /**
   * 亡霊化の一括処理（判定ボタンの本体）:
   * 魂台帳更新・評価期限起算・初期発行・招待実績の記帳と招待者の期限延長・事件録。
   * 冪等: 既に ghost なら何もしない。初期発行は台帳の冪等キーが守る。
   */
  ghostify(
    userId: string,
    actor: string,
    opts: { inviteeGender?: "male" | "female" | null } = {},
  ): GhostifyResult {
    const ts = now();
    const baseDays = this.settings.getNumber("eval_base_period_days");
    const soul = this.getSoul(userId);

    if (soul?.status === "ghost") {
      return {
        userId,
        granted: 0,
        evalDeadlineAt: soul.eval_deadline_at ?? ts,
        inviterExtendedDays: 0,
      };
    }

    const deadline = ts + baseDays * DAY;
    this.db
      .prepare(
        `INSERT INTO souls (user_id, status, joined_at, ghost_at, eval_deadline_at, updated_at)
         VALUES (?, 'ghost', ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           status = 'ghost', ghost_at = excluded.ghost_at,
           eval_deadline_at = excluded.eval_deadline_at, updated_at = excluded.updated_at`,
      )
      .run(userId, ts, ts, deadline, ts);

    // 初期発行（冪等キーで二重発行不可）
    const grant = this.settings.getNumber("initial_grant");
    const accountId = `user:${userId}`;
    this.ledger.ensureAccount(accountId, "user");
    const grantResult = this.ledger.transfer({
      from: TREASURY,
      to: accountId,
      amount: grant,
      type: "initial",
      actor,
      reason: "入城時の初期発行",
      idempotencyKey: `initial:user:${userId}`,
    });

    // 招待実績: 予約に記録された招待者を魂台帳に写し、招待者の評価期限を延長する
    const booking = this.getBooking(userId);
    let extended = 0;
    if (booking?.inviter_user_id) {
      this.db
        .prepare("UPDATE souls SET inviter_user_id = ?, inviter_source = ?, updated_at = ? WHERE user_id = ?")
        .run(booking.inviter_user_id, booking.inviter_source, ts, userId);
      this.db
        .prepare("INSERT INTO invites (inviter_id, invitee_id, credited_at) VALUES (?, ?, ?) ON CONFLICT(invitee_id) DO NOTHING")
        .run(booking.inviter_user_id, userId, ts);
      extended = this.extendInviterDeadline(booking.inviter_user_id, opts.inviteeGender ?? null);
      this.events.log("invite_credited", {
        actor: booking.inviter_user_id,
        target: userId,
        payload: { extendedDays: extended },
      });
    }

    if (booking) {
      this.db
        .prepare("UPDATE entry_bookings SET status = 'ghosted', updated_at = ? WHERE user_id = ?")
        .run(ts, userId);
    }

    this.events.log("ghosted", { actor, target: userId, payload: { deadline, granted: grantResult.duplicate ? 0 : grant } });
    return {
      userId,
      granted: grantResult.duplicate ? 0 : grant,
      evalDeadlineAt: deadline,
      inviterExtendedDays: extended,
    };
  }

  /**
   * 性別ロールが後付けされた被招待者について、招待者の期限延長を後追い適用する。
   * 既に適用済みなら 0 を返す（冪等・二重延長なし）。
   */
  applyInviteeGenderExtension(inviteeUserId: string, gender: "male" | "female"): number {
    const soul = this.getSoul(inviteeUserId);
    if (!soul || !soul.inviter_user_id) return 0;
    const flagKey = `invite_ext_applied:${inviteeUserId}`;
    if (this.settings.getString(flagKey)) return 0;
    const extended = this.extendInviterDeadline(soul.inviter_user_id, gender);
    if (extended > 0) {
      this.settings.set(flagKey, "1", "system:invite-ext");
      this.events.log("invite_ext_deferred", {
        actor: soul.inviter_user_id,
        target: inviteeUserId,
        payload: { gender, extendedDays: extended },
      });
    }
    return extended;
  }

  /** 招待者の評価期限延長（男+1日/女+2日、累計上限あり。評価期間中の招待者のみ） */
  private extendInviterDeadline(inviterId: string, inviteeGender: "male" | "female" | null): number {
    if (!inviteeGender) return 0;
    const soul = this.getSoul(inviterId);
    const ts = now();
    if (!soul || soul.status !== "ghost" || !soul.eval_deadline_at || soul.eval_deadline_at < ts) return 0;

    const perDays = this.settings.getNumber(
      inviteeGender === "male" ? "invite_extend_days_male" : "invite_extend_days_female",
    );
    const cap = this.settings.getNumber("invite_extend_cap_days");
    const add = Math.max(0, Math.min(perDays, cap - soul.eval_extension_days));
    if (add === 0) return 0;

    this.db
      .prepare(
        `UPDATE souls SET eval_deadline_at = eval_deadline_at + ?, eval_extension_days = eval_extension_days + ?, updated_at = ?
         WHERE user_id = ?`,
      )
      .run(add * DAY, add, ts, inviterId);
    return add;
  }

  /**
   * 見送り: 出席していたが今回は通さない判断。予約を dropped にしてキューから外す。
   * 亡霊化はしない（初期発行も無し）。再挑戦は本人が再予約すれば可能。
   */
  skipBooking(userId: string, actor: string): boolean {
    const changed = this.db
      .prepare("UPDATE entry_bookings SET status = 'dropped', updated_at = ? WHERE user_id = ? AND status IN ('booked','attended')")
      .run(now(), userId);
    if (changed.changes > 0) this.events.log("entry_skipped", { actor, target: userId });
    return changed.changes > 0;
  }

  /**
   * 移行時の階級バックフィル。現在のロールから判定した階級を魂台帳へ写す。
   * 冪等: 既存の ghost_at / 評価期限は維持する（再実行しても期限リセットしない）。
   * 亡霊は期限が無ければ移行日から periodDays を付与、魔人/魔族は期限なし(NULL)。
   */
  backfillStatuses(
    entries: Array<{ userId: string; status: SoulRow["status"] }>,
    periodDays: number,
  ): { applied: Record<string, number>; ghostDeadlinesSet: number } {
    const ts = now();
    const applied: Record<string, number> = {};
    let ghostDeadlinesSet = 0;
    const upsert = this.db.prepare(
      `INSERT INTO souls (user_id, status, joined_at, ghost_at, eval_deadline_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         status = excluded.status, ghost_at = excluded.ghost_at,
         eval_deadline_at = excluded.eval_deadline_at, updated_at = excluded.updated_at`,
    );
    const run = this.db.transaction(() => {
      for (const e of entries) {
        applied[e.status] = (applied[e.status] ?? 0) + 1;
        const existing = this.getSoul(e.userId);
        let ghostAt = existing?.ghost_at ?? null;
        let deadline = existing?.eval_deadline_at ?? null;
        if (e.status === "ghost") {
          ghostAt = ghostAt ?? ts;
          if (deadline === null) {
            deadline = ts + periodDays * DAY;
            ghostDeadlinesSet++;
          }
        } else if (e.status === "majin" || e.status === "mazoku") {
          ghostAt = ghostAt ?? ts;
          deadline = null;
        }
        upsert.run(e.userId, e.status, existing?.joined_at ?? ts, ghostAt, deadline, ts);
      }
    });
    run();
    this.events.log("backfill_status", { payload: { count: entries.length, applied } });
    return { applied, ghostDeadlinesSet };
  }

  /** 欠席処理: 3回連続でキューから外す（自動キックはしない） */
  recordNoShow(userId: string): { count: number; dropped: boolean } {
    const ts = now();
    const booking = this.getBooking(userId);
    if (!booking) return { count: 0, dropped: false };
    const count = booking.no_show_count + 1;
    const dropped = count >= 3;
    this.db
      .prepare("UPDATE entry_bookings SET no_show_count = ?, status = ?, updated_at = ? WHERE user_id = ?")
      .run(count, dropped ? "dropped" : "booked", ts, userId);
    this.events.log("entry_no_show", { target: userId, payload: { count, dropped } });
    return { count, dropped };
  }
}
