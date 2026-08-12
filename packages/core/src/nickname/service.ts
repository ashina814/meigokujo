import type Database from "better-sqlite3";
import { EventLog } from "../events/service.js";
import {
  NICKNAME_POLICY_VERSION,
  checkNicknameShape,
  nicknameKey,
  normalizeNickname,
  type NicknameRejection,
} from "./policy.js";

const now = (): number => Math.floor(Date.now() / 1000);

export type NameState = "registered" | "legacy" | "conflict";
export type NameSetVia = "entry" | "shop" | "staff";

export interface MemberNameRow {
  user_id: string;
  nickname: string;
  name_key: string;
  state: NameState;
  policy_version: string | null;
  locked_at: number | null;
  set_via: NameSetVia;
  created_at: number;
  updated_at: number;
}

export interface NicknameReservationRow {
  name_key: string;
  kind: "member" | "legacy_conflict";
  user_id: string | null;
  display: string;
  created_at: number;
  updated_at: number;
}

export type ClaimRejection =
  | NicknameRejection
  | { code: "taken"; by: "member" | "legacy_conflict" }
  | { code: "locked" };

/** Discord 側の設定に失敗したときへ戻すための控え */
export interface NameSnapshot {
  userId: string;
  previousName: MemberNameRow | null;
  previousReservation: NicknameReservationRow | null;
  claimedKey: string;
}

export type ClaimResult =
  | { ok: true; nickname: string; key: string; flagged: string | null; snapshot: NameSnapshot }
  | { ok: false; rejection: ClaimRejection };

/** 入城の可否に使う、いまの名前の状態 */
export type NameStatus =
  | { kind: "ok"; nickname: string; flagged: string | null }
  | { kind: "violation"; nickname: string; reason: string }
  | { kind: "unset" };

class Taken extends Error {
  constructor(readonly by: "member" | "legacy_conflict") {
    super("nickname taken");
  }
}

/**
 * 名前の正本。
 *
 * ## 唯一性をどこで担保するか
 *
 * `nickname_reservations.name_key` の主キー**だけ**が正本。アプリ側の事前チェックは
 * 利用者へ理由を返すためのもので、同時登録の競合はここで必ず落ちる。
 *
 * ## 既存の重複を「誰のものでもない予約」にする理由
 *
 * 制度導入前から同じ名前の人が複数いる。当人たちは改名させない一方、その名前を
 * 新規が取れてしまうと重複が増える。かといって片方を代表所有者にすると、
 * **その人が改名・退出した瞬間に予約が外れ**、まだ同じ名前で残っている人がいるのに
 * 新規へ開放されてしまう。so legacy_conflict は user_id を持たない。
 */
export class Nicknames {
  constructor(
    private readonly db: Database.Database,
    private readonly events: EventLog,
  ) {}

  get(userId: string): MemberNameRow | null {
    return (this.db.prepare("SELECT * FROM member_names WHERE user_id = ?").get(userId) as MemberNameRow) ?? null;
  }

  reservation(key: string): NicknameReservationRow | null {
    return (
      (this.db.prepare("SELECT * FROM nickname_reservations WHERE name_key = ?").get(key) as NicknameReservationRow) ?? null
    );
  }

  /** 同じ名前の人（既存重複の追跡用） */
  holdersOf(key: string): MemberNameRow[] {
    return this.db
      .prepare("SELECT * FROM member_names WHERE name_key = ? ORDER BY created_at")
      .all(key) as MemberNameRow[];
  }

  /** 予約が誰のものでもない＝解消待ちの重複 */
  listConflicts(): Array<{ key: string; display: string; users: string[] }> {
    const rows = this.db
      .prepare("SELECT name_key, display FROM nickname_reservations WHERE kind = 'legacy_conflict' ORDER BY name_key")
      .all() as Array<{ name_key: string; display: string }>;
    return rows.map((r) => ({
      key: r.name_key,
      display: r.display,
      users: this.holdersOf(r.name_key).map((m) => m.user_id),
    }));
  }

  // ---- 禁止語 ----

  addDenyWord(pattern: string, actor: string, opts: { action?: "reject" | "flag"; note?: string } = {}): void {
    const key = nicknameKey(pattern);
    if (!key) return;
    this.db
      .prepare(
        `INSERT INTO nickname_denylist (pattern, action, note, added_by, created_at) VALUES (?,?,?,?,?)
         ON CONFLICT(pattern) DO UPDATE SET action = excluded.action, note = excluded.note`,
      )
      .run(key, opts.action ?? "reject", opts.note ?? null, actor, now());
    this.events.log("nickname_denyword_added", { actor, payload: { pattern: key, action: opts.action ?? "reject" } });
  }

  removeDenyWord(pattern: string, actor: string): boolean {
    const key = nicknameKey(pattern);
    const changed = this.db.prepare("DELETE FROM nickname_denylist WHERE pattern = ?").run(key).changes;
    if (changed > 0) this.events.log("nickname_denyword_removed", { actor, payload: { pattern: key } });
    return changed > 0;
  }

  listDenyWords(): Array<{ pattern: string; action: "reject" | "flag"; note: string | null }> {
    return this.db.prepare("SELECT pattern, action, note FROM nickname_denylist ORDER BY pattern").all() as Array<{
      pattern: string;
      action: "reject" | "flag";
      note: string | null;
    }>;
  }

  /** 禁止語に触れているか。判定は**正規化済みの鍵に対する部分一致**だけ */
  private matchDenylist(key: string): { pattern: string; action: "reject" | "flag" } | null {
    for (const row of this.listDenyWords()) {
      if (row.pattern && key.includes(row.pattern)) return { pattern: row.pattern, action: row.action };
    }
    return null;
  }

  /**
   * 形式 → 禁止語 まで見る（同名は見ない）。
   * **入城パネルも商館もここを通す。** 片方だけ規則が緩い状態を作らない。
   */
  evaluate(
    input: string,
  ): { ok: true; nickname: string; key: string; flagged: string | null } | { ok: false; rejection: NicknameRejection } {
    const shape = checkNicknameShape(input);
    if (!shape.ok) return shape;
    const hit = this.matchDenylist(shape.key);
    if (hit?.action === "reject") return { ok: false, rejection: { code: "denylisted", pattern: hit.pattern } };
    return { ok: true, nickname: shape.nickname, key: shape.key, flagged: hit?.pattern ?? null };
  }

  // ---- 登録 ----

  /**
   * 名前を確保する。**Discord へ設定する前に呼ぶ。**
   *
   * 先に予約を取ってから Discord を叩く。逆にすると、設定は通ったのに予約が
   * 取れない（＝重複が成立する）順序が生まれる。Discord 側が失敗したら
   * `rollback()` で元へ戻す。
   */
  claim(input: {
    userId: string;
    nickname: string;
    setVia: NameSetVia;
    actor: string;
    /** 入城後の固定を越えて変更してよいか。**商館の正式改名だけ true** */
    allowLocked?: boolean;
  }): ClaimResult {
    const evaluated = this.evaluate(input.nickname);
    if (!evaluated.ok) return { ok: false, rejection: evaluated.rejection };
    const { nickname, key, flagged } = evaluated;

    const run = this.db.transaction((): ClaimResult => {
      const previousName = this.get(input.userId);
      if (previousName?.locked_at && !input.allowLocked) {
        return { ok: false, rejection: { code: "locked" } };
      }
      const previousReservation = previousName ? this.reservation(previousName.name_key) : null;
      const existing = this.reservation(key);
      // 他人の予約・誰のものでもない予約（既存重複）は取れない
      if (existing && !(existing.kind === "member" && existing.user_id === input.userId)) {
        throw new Taken(existing.kind);
      }
      // 自分の古い予約を外してから取り直す。**1人が2つの名前を予約したままにしない**
      if (previousName && previousName.name_key !== key) {
        this.db
          .prepare("DELETE FROM nickname_reservations WHERE name_key = ? AND kind = 'member' AND user_id = ?")
          .run(previousName.name_key, input.userId);
      }
      const ts = now();
      this.db
        .prepare(
          `INSERT INTO nickname_reservations (name_key, kind, user_id, display, created_at, updated_at)
           VALUES (?, 'member', ?, ?, ?, ?)
           ON CONFLICT(name_key) DO UPDATE SET display = excluded.display, updated_at = excluded.updated_at
            WHERE nickname_reservations.kind = 'member' AND nickname_reservations.user_id = excluded.user_id`,
        )
        .run(key, input.userId, nickname, ts, ts);
      // ON CONFLICT の条件が偽なら1行も動かない＝他人が持っている。ここで検める
      const after = this.reservation(key);
      if (!after || after.kind !== "member" || after.user_id !== input.userId) throw new Taken(after?.kind ?? "member");
      this.db
        .prepare(
          `INSERT INTO member_names (user_id, nickname, name_key, state, policy_version, locked_at, set_via, created_at, updated_at)
           VALUES (?,?,?,'registered',?,?,?,?,?)
           ON CONFLICT(user_id) DO UPDATE SET
             nickname = excluded.nickname, name_key = excluded.name_key, state = 'registered',
             policy_version = excluded.policy_version, set_via = excluded.set_via, updated_at = excluded.updated_at`,
        )
        .run(
          input.userId,
          nickname,
          key,
          NICKNAME_POLICY_VERSION,
          previousName?.locked_at ?? null,
          input.setVia,
          previousName?.created_at ?? ts,
          ts,
        );
      this.events.log("nickname_registered", {
        actor: input.actor,
        target: input.userId,
        payload: { nickname, key, setVia: input.setVia, flagged, previous: previousName?.nickname ?? null },
      });
      return {
        ok: true,
        nickname,
        key,
        flagged,
        snapshot: { userId: input.userId, previousName, previousReservation, claimedKey: key },
      };
    });

    try {
      return run.immediate();
    } catch (e) {
      if (e instanceof Taken) return { ok: false, rejection: { code: "taken", by: e.by } };
      throw e;
    }
  }

  /**
   * `claim()` を取り消す。**Discord への設定が失敗したときだけ使う。**
   * 予約だけ残ると、誰も名乗っていない名前が永久に取れなくなる。
   */
  rollback(snapshot: NameSnapshot, actor: string): void {
    const run = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM nickname_reservations WHERE name_key = ? AND user_id = ?")
        .run(snapshot.claimedKey, snapshot.userId);
      this.db.prepare("DELETE FROM member_names WHERE user_id = ?").run(snapshot.userId);
      const p = snapshot.previousName;
      if (p) {
        this.db
          .prepare(
            `INSERT INTO member_names (user_id, nickname, name_key, state, policy_version, locked_at, set_via, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
          )
          .run(p.user_id, p.nickname, p.name_key, p.state, p.policy_version, p.locked_at, p.set_via, p.created_at, p.updated_at);
      }
      const r = snapshot.previousReservation;
      if (r) {
        this.db
          .prepare(
            `INSERT INTO nickname_reservations (name_key, kind, user_id, display, created_at, updated_at)
             VALUES (?,?,?,?,?,?) ON CONFLICT(name_key) DO NOTHING`,
          )
          .run(r.name_key, r.kind, r.user_id, r.display, r.created_at, r.updated_at);
      }
    });
    run.immediate();
    this.events.log("nickname_rollback", { actor, target: snapshot.userId, payload: { key: snapshot.claimedKey } });
  }

  /** 入城完了で名前を固定する */
  lock(userId: string, actor: string): boolean {
    const ts = now();
    const changed = this.db
      .prepare("UPDATE member_names SET locked_at = ?, updated_at = ? WHERE user_id = ? AND locked_at IS NULL")
      .run(ts, ts, userId).changes;
    if (changed > 0) this.events.log("nickname_locked", { actor, target: userId });
    return changed > 0;
  }

  /**
   * いまの名前の状態。**入城の可否はこれで決める。**
   *
   * 保存時に通ったかどうかではなく、**呼ばれた時点の規則で**見直す。
   * 禁止語を足したあとに入城しようとした人を、古い合格のまま通さないため。
   */
  status(userId: string): NameStatus {
    const row = this.get(userId);
    if (!row) return { kind: "unset" };
    if (row.state === "conflict") {
      return { kind: "violation", nickname: row.nickname, reason: "他の人と同じ名前です（制度導入前からの重複）" };
    }
    const evaluated = this.evaluate(row.nickname);
    if (!evaluated.ok) return { kind: "violation", nickname: row.nickname, reason: "名前の規則に合いません" };
    return { kind: "ok", nickname: row.nickname, flagged: evaluated.flagged };
  }

  // ---- 移行 ----

  /**
   * 制度導入前からの名前を取り込む。**誰も改名させない。**
   *
   * 重複していた名前は `legacy_conflict` として予約だけ立て、当人たちは
   * `conflict` のまま記録に残す。予約は誰の持ち物でもないので、片方が改名・退出しても
   * 新規へ開放されない。既に取り込み済みの人は飛ばす（何度実行しても同じ結果）。
   *
   * **形式検査は通さない。** 既存の名前に記号が入っていても、それは制度以前の事実で、
   * ここで弾くと取り込めず、結果としてその名前が新規に取られてしまう。
   */
  importLegacy(
    entries: ReadonlyArray<{ userId: string; nickname: string }>,
    actor: string,
  ): { imported: number; conflicted: number; skipped: number; conflicts: Array<{ display: string; users: string[] }> } {
    const run = this.db.transaction(() => {
      const groups = new Map<string, Array<{ userId: string; nickname: string }>>();
      let skipped = 0;
      for (const e of entries) {
        const nickname = normalizeNickname(e.nickname);
        if (!nickname) continue;
        if (this.get(e.userId)) {
          skipped += 1;
          continue;
        }
        const key = nicknameKey(nickname);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push({ userId: e.userId, nickname });
      }
      let imported = 0;
      let conflicted = 0;
      const conflicts: Array<{ display: string; users: string[] }> = [];
      const ts = now();
      for (const [key, members] of groups) {
        const existing = this.reservation(key);
        const collides = members.length > 1 || (existing !== null && existing.kind === "member");
        if (!collides) {
          const m = members[0]!;
          this.db
            .prepare(
              `INSERT INTO nickname_reservations (name_key, kind, user_id, display, created_at, updated_at)
               VALUES (?, 'member', ?, ?, ?, ?) ON CONFLICT(name_key) DO NOTHING`,
            )
            .run(key, m.userId, m.nickname, ts, ts);
          this.writeName(m.userId, m.nickname, key, "legacy", ts);
          imported += 1;
          continue;
        }
        // 重複。**所有者を立てず**、名前そのものを予約する
        this.db
          .prepare(
            `INSERT INTO nickname_reservations (name_key, kind, user_id, display, created_at, updated_at)
             VALUES (?, 'legacy_conflict', NULL, ?, ?, ?)
             ON CONFLICT(name_key) DO UPDATE SET kind = 'legacy_conflict', user_id = NULL, updated_at = excluded.updated_at`,
          )
          .run(key, members[0]?.nickname ?? key, ts, ts);
        for (const m of members) {
          this.writeName(m.userId, m.nickname, key, "conflict", ts);
          conflicted += 1;
        }
        // 先に単独で取り込まれていた人も conflict へ落とす
        this.db.prepare("UPDATE member_names SET state = 'conflict', updated_at = ? WHERE name_key = ?").run(ts, key);
        conflicts.push({ display: members[0]?.nickname ?? key, users: this.holdersOf(key).map((r) => r.user_id) });
      }
      return { imported, conflicted, skipped, conflicts };
    });
    const result = run.immediate();
    this.events.log("nickname_legacy_imported", {
      actor,
      payload: { imported: result.imported, conflicted: result.conflicted, skipped: result.skipped },
    });
    return result;
  }

  private writeName(userId: string, nickname: string, key: string, state: NameState, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO member_names (user_id, nickname, name_key, state, policy_version, locked_at, set_via, created_at, updated_at)
         VALUES (?,?,?,?,NULL,NULL,'staff',?,?)
         ON CONFLICT(user_id) DO UPDATE SET nickname = excluded.nickname, name_key = excluded.name_key,
           state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(userId, nickname, key, state, ts, ts);
  }
}
