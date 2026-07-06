import type Database from "better-sqlite3";
import { Ledger, TREASURY } from "../ledger/service.js";
import { Settings } from "../settings/service.js";
import { EventLog } from "../events/service.js";

export type RoomKind = "normal" | "mitsugetsu" | "oborozuki" | "game";

export type RoomErrorCode = "ERR_ALREADY_OWNS";
export class RoomError extends Error {
  constructor(readonly code: RoomErrorCode, readonly meta: Record<string, unknown> = {}) {
    super(code);
    this.name = "RoomError";
  }
}

/** 蜜月・朧月の自動クローズまでの時間（12時間） */
const LOVE_ROOM_TTL_S = 12 * 3600;

export interface RoomRow {
  id: number;
  kind: RoomKind;
  channel_id: string;
  owner_id: string;
  capacity: number;
  expires_at: number | null;
  warned_at: number | null;
  activated_at: number | null;
  empty_since: number | null;
  status: "open" | "closed";
  created_at: number;
  updated_at: number;
}

export interface RecruitRow {
  id: number;
  room_id: number;
  owner_id: string;
  target_gender: "male" | "female";
  purpose: string;
  message: string | null;
  panel_channel_id: string | null;
  panel_message_id: string | null;
  status: "open" | "matched" | "expired" | "cancelled";
  created_at: number;
  expires_at: number;
}

const now = () => Math.floor(Date.now() / 1000);

/** ゲーム部屋の料金表（時間, Ld）。設定 room_game_tiers で上書き可能 */
const DEFAULT_GAME_TIERS: Array<[number, number]> = [
  [2, 6_000],
  [3, 8_000],
  [5, 13_000],
  [10, 27_000],
];

/**
 * 部屋システム（ボット設計.md）。チャンネル操作はbot側、課金・台帳・状態はここ。
 * 全部屋「全員退出で削除」の使い切り方式。支払いは room_fee、規定返金は room_refund。
 */
export class Rooms {
  constructor(
    private readonly db: Database.Database,
    private readonly ledger: Ledger,
    private readonly settings: Settings,
    private readonly events: EventLog,
  ) {}

  gameTiers(): Array<[number, number]> {
    return this.settings.getJson<Array<[number, number]>>("room_game_tiers", DEFAULT_GAME_TIERS);
  }

  priceFor(kind: RoomKind, hours?: number): number {
    if (kind === "normal") return 0;
    if (kind === "mitsugetsu") return this.settings.getNumber("room_mitsugetsu_price");
    if (kind === "oborozuki") return this.settings.getNumber("room_oborozuki_price");
    const tier = this.gameTiers().find(([h]) => h === hours);
    if (!tier) throw new Error(`unknown game tier: ${hours}`);
    return tier[1];
  }

  /**
   * チャンネル作成後に呼ぶ: 課金して部屋を登録する。
   * 課金が失敗（残高不足等）で throw した場合、呼び出し側がチャンネルを片付ける。
   */
  /** そのオーナーが今オープン中の部屋を持っているか（一人一部屋の制限用） */
  ownerHasOpenRoom(ownerId: string): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM rooms WHERE owner_id = ? AND status = 'open'")
      .get(ownerId) as { c: number };
    return row.c > 0;
  }

  register(input: {
    kind: RoomKind;
    channelId: string;
    ownerId: string;
    hours?: number; // game のみ
  }): RoomRow {
    // 一人一部屋の制限は bot 側（作成前）に ownerHasOpenRoom() で弾く。
    // ここは台帳の記録層なので強制はしない（運営操作や将来の例外に備える）。
    const price = this.priceFor(input.kind, input.hours);
    if (price > 0) {
      const account = `user:${input.ownerId}`;
      this.ledger.ensureAccount(account, "user");
      this.ledger.transfer({
        from: account,
        to: TREASURY,
        amount: price,
        type: "room_fee",
        actor: account,
        reason: `${input.kind} 部屋の利用料`,
        refType: `room:${input.kind}`,
        refId: input.channelId,
        idempotencyKey: `room:create:${input.channelId}`,
      });
    }
    const ts = now();
    const expiresAt =
      input.kind === "game" && input.hours
        ? ts + input.hours * 3600
        : input.kind === "mitsugetsu" || input.kind === "oborozuki"
          ? ts + LOVE_ROOM_TTL_S // 蜜月・朧月は12時間で自動クローズ
          : null;
    const result = this.db
      .prepare(
        `INSERT INTO rooms (kind, channel_id, owner_id, capacity, expires_at, status, created_at, updated_at)
         VALUES (?, ?, ?, 2, ?, 'open', ?, ?)`,
      )
      .run(input.kind, input.channelId, input.ownerId, expiresAt, ts, ts);
    this.events.log("room_created", {
      actor: input.ownerId,
      payload: { kind: input.kind, channelId: input.channelId, price, hours: input.hours },
    });
    return this.get(Number(result.lastInsertRowid));
  }

  get(id: number): RoomRow {
    const row = this.db.prepare("SELECT * FROM rooms WHERE id = ?").get(id) as RoomRow | undefined;
    if (!row) throw new Error(`room not found: ${id}`);
    return row;
  }

  byChannel(channelId: string): RoomRow | undefined {
    return this.db.prepare("SELECT * FROM rooms WHERE channel_id = ?").get(channelId) as
      | RoomRow
      | undefined;
  }

  listOpen(): RoomRow[] {
    return this.db.prepare("SELECT * FROM rooms WHERE status = 'open'").all() as RoomRow[];
  }

  /** 通常宿の人数枠+1（押した人がその場で払う枠課金） */
  addSlot(roomId: number, payerId: string): RoomRow {
    const room = this.get(roomId);
    const price = this.settings.getNumber("room_slot_price");
    const account = `user:${payerId}`;
    this.ledger.ensureAccount(account, "user");
    this.ledger.transfer({
      from: account,
      to: TREASURY,
      amount: price,
      type: "room_fee",
      actor: account,
      reason: "宿の人数枠+1",
      refType: "room:slot",
      refId: room.channel_id,
      idempotencyKey: `room:slot:${roomId}:${room.capacity + 1}`,
    });
    this.db
      .prepare("UPDATE rooms SET capacity = capacity + 1, updated_at = ? WHERE id = ?")
      .run(now(), roomId);
    return this.get(roomId);
  }

  /** ゲーム部屋の延長（同じ料金表から時間を買い足す） */
  extendGame(roomId: number, hours: number, payerId: string): RoomRow {
    const room = this.get(roomId);
    if (room.kind !== "game" || !room.expires_at) throw new Error("not a game room");
    const price = this.priceFor("game", hours);
    const account = `user:${payerId}`;
    this.ledger.ensureAccount(account, "user");
    this.ledger.transfer({
      from: account,
      to: TREASURY,
      amount: price,
      type: "room_fee",
      actor: account,
      reason: `ゲーム部屋の延長 +${hours}時間`,
      refType: "room:game_extend",
      refId: room.channel_id,
      idempotencyKey: `room:extend:${roomId}:${room.expires_at}`,
    });
    this.db
      .prepare("UPDATE rooms SET expires_at = expires_at + ?, warned_at = NULL, updated_at = ? WHERE id = ?")
      .run(hours * 3600, now(), roomId);
    return this.get(roomId);
  }

  /** 在室状況の更新（刻時盤の毎分スキャンから）。空→在室で activated、在室→空で empty_since 起算 */
  markOccupancy(roomId: number, occupied: boolean): void {
    const ts = now();
    if (occupied) {
      this.db
        .prepare(
          "UPDATE rooms SET empty_since = NULL, activated_at = COALESCE(activated_at, ?), updated_at = ? WHERE id = ?",
        )
        .run(ts, ts, roomId);
    } else {
      this.db
        .prepare("UPDATE rooms SET empty_since = COALESCE(empty_since, ?), updated_at = ? WHERE id = ?")
        .run(ts, ts, roomId);
    }
  }

  /**
   * 削除対象:
   * - 一度使われて（activated）全員退出から猶予分経過した部屋
   * - 一度も使われないまま1時間放置された部屋（蜜月は募集失効側で処理するため除外）
   */
  dueForDeletion(graceMinutes: number): RoomRow[] {
    const ts = now();
    return this.db
      .prepare(
        `SELECT * FROM rooms WHERE status = 'open' AND (
           (activated_at IS NOT NULL AND empty_since IS NOT NULL AND empty_since < ?)
           OR (activated_at IS NULL AND kind != 'mitsugetsu' AND created_at < ?)
         )`,
      )
      .all(ts - graceMinutes * 60, ts - 300) as RoomRow[]; // 未入室のまま5分放置で撤去
  }

  /** ゲーム部屋: 期限10分前で未警告のもの */
  gamesNeedingWarning(): RoomRow[] {
    const ts = now();
    return this.db
      .prepare(
        `SELECT * FROM rooms WHERE status = 'open' AND kind = 'game' AND warned_at IS NULL
         AND expires_at IS NOT NULL AND expires_at <= ? AND expires_at > ?`,
      )
      .all(ts + 600, ts) as RoomRow[];
  }

  markWarned(roomId: number): void {
    this.db.prepare("UPDATE rooms SET warned_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), roomId);
  }

  /** 期限切れの部屋（ゲームの利用期限・蜜月/朧月の12時間上限） */
  expiredRooms(): RoomRow[] {
    return this.db
      .prepare("SELECT * FROM rooms WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at < ?")
      .all(now()) as RoomRow[];
  }

  close(roomId: number, reason: string): void {
    const room = this.get(roomId);
    this.db.prepare("UPDATE rooms SET status = 'closed', updated_at = ? WHERE id = ?").run(now(), roomId);
    this.events.log("room_closed", {
      target: room.owner_id,
      payload: { kind: room.kind, channelId: room.channel_id, reason },
    });
  }

  // ---- 蜜月の匿名募集 ----

  createRecruit(input: {
    roomId: number;
    ownerId: string;
    targetGender: "male" | "female";
    purpose: string;
    message?: string;
  }): RecruitRow {
    const ts = now();
    const hours = this.settings.getNumber("room_recruit_expire_hours");
    const result = this.db
      .prepare(
        `INSERT INTO recruits (room_id, owner_id, target_gender, purpose, message, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(input.roomId, input.ownerId, input.targetGender, input.purpose, input.message ?? null, ts, ts + hours * 3600);
    this.events.log("recruit_opened", { actor: input.ownerId, payload: { roomId: input.roomId } });
    return this.getRecruit(Number(result.lastInsertRowid));
  }

  getRecruit(id: number): RecruitRow {
    const row = this.db.prepare("SELECT * FROM recruits WHERE id = ?").get(id) as RecruitRow | undefined;
    if (!row) throw new Error(`recruit not found: ${id}`);
    return row;
  }

  setRecruitPanel(recruitId: number, channelId: string, messageId: string): void {
    this.db
      .prepare("UPDATE recruits SET panel_channel_id = ?, panel_message_id = ? WHERE id = ?")
      .run(channelId, messageId, recruitId);
  }

  /** 参加成立（先着1名で締切） */
  matchRecruit(recruitId: number, joinerId: string): RecruitRow {
    const recruit = this.getRecruit(recruitId);
    if (recruit.status !== "open") return recruit;
    this.db.prepare("UPDATE recruits SET status = 'matched' WHERE id = ?").run(recruitId);
    this.events.log("recruit_matched", { actor: joinerId, target: recruit.owner_id, payload: { recruitId } });
    return this.getRecruit(recruitId);
  }

  /** 失効処理: 半額返金して expired にする。返された行のVC/パネル片付けはbot側 */
  expireRecruits(): Array<{ recruit: RecruitRow; room: RoomRow; refunded: number }> {
    const rows = this.db
      .prepare("SELECT * FROM recruits WHERE status = 'open' AND expires_at < ?")
      .all(now()) as RecruitRow[];
    const results: Array<{ recruit: RecruitRow; room: RoomRow; refunded: number }> = [];
    for (const recruit of rows) {
      const refund = this.settings.getNumber("room_recruit_refund");
      const account = `user:${recruit.owner_id}`;
      this.ledger.ensureAccount(account, "user");
      const result = this.ledger.transfer({
        from: TREASURY,
        to: account,
        amount: refund,
        type: "room_refund",
        actor: "system:rooms",
        reason: "蜜月の募集が無応募のまま失効（半額返金）",
        refType: "recruit",
        refId: String(recruit.id),
        idempotencyKey: `room:recruit-refund:${recruit.id}`,
      });
      this.db.prepare("UPDATE recruits SET status = 'expired' WHERE id = ?").run(recruit.id);
      const room = this.get(recruit.room_id);
      this.events.log("recruit_expired", { target: recruit.owner_id, payload: { recruitId: recruit.id } });
      results.push({ recruit: this.getRecruit(recruit.id), room, refunded: result.duplicate ? 0 : refund });
    }
    return results;
  }
}
