import type Database from "better-sqlite3";
import { EventLog } from "../events/service.js";
import { Ledger, TREASURY, type TransferResult } from "../ledger/service.js";
import { Settings } from "../settings/service.js";

export type RoomKind = "normal" | "mitsugetsu" | "oborozuki" | "game";
export type RoomOwnershipSlot = "normal" | "special";
export type RoomStatus = "open" | "closed";
export type RoomCloseReason =
  | "manual"
  | "empty"
  | "unused"
  | "expired"
  | "recruit_expired"
  | "recruit_cancelled"
  | "channel_missing"
  | string;

export type RoomErrorCode =
  | "ERR_ALREADY_OWNS"
  | "ERR_INVALID_ROOM"
  | "ERR_ROOM_CLOSED"
  | "ERR_ROOM_EXPIRED"
  | "ERR_CAPACITY_LIMIT"
  | "ERR_CAPACITY_CHANGED"
  | "ERR_PRICE_CHANGED"
  | "ERR_RECRUIT_CLOSED"
  | "ERR_RECRUIT_CLAIMED"
  | "ERR_INVITE_PENDING"
  | "ERR_INVITE_CLOSED"
  | "ERR_INVITE_EXPIRED";

export class RoomError extends Error {
  constructor(readonly code: RoomErrorCode, readonly meta: Record<string, unknown> = {}) {
    super(code);
    this.name = "RoomError";
  }
}

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
  status: RoomStatus;
  pending_delete: number;
  delete_attempts: number;
  next_delete_retry_at: number | null;
  close_reason: string | null;
  close_actor_id: string | null;
  closed_at: number | null;
  unused_refund_tx_id: number | null;
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
  matched_user_id: string | null;
  refund_tx_id: number | null;
  updated_at: number | null;
  created_at: number;
  expires_at: number;
}

export interface OborozukiInviteRow {
  id: number;
  requester_id: string;
  target_id: string;
  status: "pending" | "accepted" | "declined" | "expired" | "cancelled";
  token: string;
  price: number;
  expires_at: number;
  room_id: number | null;
  channel_id: string | null;
  created_at: number;
  updated_at: number;
  decided_at: number | null;
}

export interface RoomPanelValues {
  slotPrice: number;
  mitsugetsuPrice: number;
  oborozukiPrice: number;
  gameTiers: Array<[number, number]>;
  recruitExpireHours: number;
  recruitRefund: number;
  emptyGraceMinutes: number;
  unusedGraceMinutes: number;
  loveRoomTtlHours: number;
  normalMaxCapacity: number;
}

const now = () => Math.floor(Date.now() / 1000);

const DEFAULT_GAME_TIERS: Array<[number, number]> = [
  [2, 6_000],
  [3, 8_000],
  [5, 13_000],
  [10, 27_000],
];

export function roomOwnershipSlot(kind: RoomKind): RoomOwnershipSlot {
  return kind === "normal" ? "normal" : "special";
}

function isSqliteConstraint(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE";
}

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

  loveRoomTtlSeconds(): number {
    return LOVE_ROOM_TTL_S;
  }

  panelValues(): RoomPanelValues {
    return {
      slotPrice: this.settings.getNumber("room_slot_price"),
      mitsugetsuPrice: this.settings.getNumber("room_mitsugetsu_price"),
      oborozukiPrice: this.settings.getNumber("room_oborozuki_price"),
      gameTiers: this.gameTiers(),
      recruitExpireHours: this.settings.getNumber("room_recruit_expire_hours"),
      recruitRefund: this.settings.getNumber("room_recruit_refund"),
      emptyGraceMinutes: this.settings.getNumber("room_empty_grace_min"),
      unusedGraceMinutes: this.settings.getNumber("room_unused_grace_min"),
      loveRoomTtlHours: LOVE_ROOM_TTL_S / 3600,
      normalMaxCapacity: this.settings.getNumber("room_normal_max_capacity"),
    };
  }

  priceFor(kind: RoomKind, hours?: number): number {
    if (kind === "normal") return 0;
    if (kind === "mitsugetsu") return this.settings.getNumber("room_mitsugetsu_price");
    if (kind === "oborozuki") return this.settings.getNumber("room_oborozuki_price");
    const tier = this.gameTiers().find(([h]) => h === hours);
    if (!tier) throw new Error(`unknown game tier: ${hours}`);
    return tier[1];
  }

  ownerHasOpenRoom(ownerId: string): boolean;
  ownerHasOpenRoom(ownerId: string, slot: RoomOwnershipSlot): boolean;
  ownerHasOpenRoom(ownerId: string, slot?: RoomOwnershipSlot): boolean {
    return this.openRoomForOwner(ownerId, slot) !== undefined;
  }

  openRoomForOwner(ownerId: string, slot?: RoomOwnershipSlot): RoomRow | undefined {
    const slotWhere =
      slot === "normal"
        ? "AND kind = 'normal'"
        : slot === "special"
          ? "AND kind IN ('mitsugetsu','oborozuki','game')"
          : "";
    return this.db
      .prepare(`SELECT * FROM rooms WHERE owner_id = ? AND status = 'open' ${slotWhere} ORDER BY id LIMIT 1`)
      .get(ownerId) as RoomRow | undefined;
  }

  ownershipConflict(ownerId: string, kind: RoomKind): { slot: RoomOwnershipSlot; room: RoomRow } | undefined {
    const slot = roomOwnershipSlot(kind);
    const room = this.openRoomForOwner(ownerId, slot);
    return room ? { slot, room } : undefined;
  }

  register(input: {
    kind: RoomKind;
    channelId: string;
    ownerId: string;
    hours?: number;
    priceOverride?: number;
  }): RoomRow {
    const run = this.db.transaction(() => {
      const conflict = this.ownershipConflict(input.ownerId, input.kind);
      if (conflict) throw new RoomError("ERR_ALREADY_OWNS", conflict);

      const price = input.priceOverride ?? this.priceFor(input.kind, input.hours);
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
            ? ts + LOVE_ROOM_TTL_S
            : null;
      try {
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
      } catch (error) {
        if (isSqliteConstraint(error)) {
          throw new RoomError("ERR_ALREADY_OWNS", {
            slot: roomOwnershipSlot(input.kind),
            room: this.openRoomForOwner(input.ownerId, roomOwnershipSlot(input.kind)),
          });
        }
        throw error;
      }
    });
    return run();
  }

  registerWithRecruit(input: {
    channelId: string;
    ownerId: string;
    targetGender: "male" | "female";
    purpose: string;
    message?: string;
  }): { room: RoomRow; recruit: RecruitRow } {
    const run = this.db.transaction(() => {
      const room = this.register({ kind: "mitsugetsu", channelId: input.channelId, ownerId: input.ownerId });
      const recruit = this.createRecruit({
        roomId: room.id,
        ownerId: input.ownerId,
        targetGender: input.targetGender,
        purpose: input.purpose,
        message: input.message,
      });
      return { room, recruit };
    });
    return run();
  }

  get(id: number): RoomRow {
    const row = this.db.prepare("SELECT * FROM rooms WHERE id = ?").get(id) as RoomRow | undefined;
    if (!row) throw new Error(`room not found: ${id}`);
    return row;
  }

  byChannel(channelId: string): RoomRow | undefined {
    return this.db.prepare("SELECT * FROM rooms WHERE channel_id = ?").get(channelId) as RoomRow | undefined;
  }

  listOpen(): RoomRow[] {
    return this.db.prepare("SELECT * FROM rooms WHERE status = 'open'").all() as RoomRow[];
  }

  listPendingDelete(ts = now()): RoomRow[] {
    return this.db
      .prepare(
        `SELECT * FROM rooms
         WHERE status = 'open' AND pending_delete = 1
           AND (next_delete_retry_at IS NULL OR next_delete_retry_at <= ?)
         ORDER BY next_delete_retry_at, id`,
      )
      .all(ts) as RoomRow[];
  }

  addSlot(
    roomId: number,
    payerId: string,
    opts: { waiveFee?: boolean; expectedCapacity?: number; expectedPrice?: number } = {},
  ): RoomRow {
    const run = this.db.transaction(() => {
      const room = this.get(roomId);
      if (room.status !== "open") throw new RoomError("ERR_ROOM_CLOSED", { roomId });
      if (room.kind !== "normal") throw new RoomError("ERR_INVALID_ROOM", { roomId, kind: room.kind });

      const price = this.settings.getNumber("room_slot_price");
      if (opts.expectedPrice !== undefined && price !== opts.expectedPrice) {
        throw new RoomError("ERR_PRICE_CHANGED", { roomId, expectedPrice: opts.expectedPrice, currentPrice: price });
      }
      if (opts.expectedCapacity !== undefined && room.capacity !== opts.expectedCapacity) {
        throw new RoomError("ERR_CAPACITY_CHANGED", {
          roomId,
          expectedCapacity: opts.expectedCapacity,
          currentCapacity: room.capacity,
        });
      }

      const max = this.settings.getNumber("room_normal_max_capacity");
      if (room.capacity >= max) throw new RoomError("ERR_CAPACITY_LIMIT", { roomId, capacity: room.capacity, max });

      if (price < 0) throw new Error("room slot price must be non-negative");
      if (opts.waiveFee !== true && price > 0) {
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
      }

      const updated = this.db
        .prepare(
          `UPDATE rooms
           SET capacity = capacity + 1, updated_at = ?
           WHERE id = ? AND status = 'open' AND kind = 'normal' AND capacity = ? AND capacity < ?`,
        )
        .run(now(), roomId, room.capacity, max);
      if (updated.changes !== 1) throw new RoomError("ERR_INVALID_ROOM", { roomId });
      return this.get(roomId);
    });
    return run();
  }

  extendGame(roomId: number, hours: number, payerId: string): RoomRow {
    const run = this.db.transaction(() => {
      const room = this.get(roomId);
      const ts = now();
      if (room.status !== "open") throw new RoomError("ERR_ROOM_CLOSED", { roomId });
      if (room.kind !== "game" || !room.expires_at) throw new RoomError("ERR_INVALID_ROOM", { roomId, kind: room.kind });
      if (room.expires_at <= ts) throw new RoomError("ERR_ROOM_EXPIRED", { roomId, expiresAt: room.expires_at });

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

      const updated = this.db
        .prepare(
          `UPDATE rooms
           SET expires_at = expires_at + ?, warned_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'open' AND kind = 'game' AND expires_at = ?`,
        )
        .run(hours * 3600, ts, roomId, room.expires_at);
      if (updated.changes !== 1) throw new RoomError("ERR_INVALID_ROOM", { roomId });
      return this.get(roomId);
    });
    return run();
  }

  markOccupancy(roomId: number, occupied: boolean): void {
    const ts = now();
    if (occupied) {
      this.db
        .prepare(
          "UPDATE rooms SET empty_since = NULL, activated_at = COALESCE(activated_at, ?), updated_at = ? WHERE id = ? AND status = 'open'",
        )
        .run(ts, ts, roomId);
    } else {
      this.db
        .prepare("UPDATE rooms SET empty_since = COALESCE(empty_since, ?), updated_at = ? WHERE id = ? AND status = 'open'")
        .run(ts, ts, roomId);
    }
  }

  dueForDeletion(emptyGraceMinutes: number, unusedGraceMinutes = this.settings.getNumber("room_unused_grace_min")): RoomRow[] {
    const ts = now();
    return this.db
      .prepare(
        `SELECT * FROM rooms WHERE status = 'open' AND pending_delete = 0 AND (
           (activated_at IS NOT NULL AND empty_since IS NOT NULL AND empty_since < ?)
           OR (activated_at IS NULL AND kind != 'mitsugetsu' AND created_at < ?)
         )`,
      )
      .all(ts - emptyGraceMinutes * 60, ts - unusedGraceMinutes * 60) as RoomRow[];
  }

  gamesNeedingWarning(): RoomRow[] {
    const ts = now();
    return this.db
      .prepare(
        `SELECT * FROM rooms WHERE status = 'open' AND pending_delete = 0 AND kind = 'game' AND warned_at IS NULL
         AND expires_at IS NOT NULL AND expires_at <= ? AND expires_at > ?`,
      )
      .all(ts + 600, ts) as RoomRow[];
  }

  markWarned(roomId: number): void {
    this.db.prepare("UPDATE rooms SET warned_at = ?, updated_at = ? WHERE id = ? AND status = 'open'").run(now(), now(), roomId);
  }

  expiredRooms(): RoomRow[] {
    return this.db
      .prepare("SELECT * FROM rooms WHERE status = 'open' AND pending_delete = 0 AND expires_at IS NOT NULL AND expires_at < ?")
      .all(now()) as RoomRow[];
  }

  refundUnusedPaidRoom(roomId: number, actor = "system:rooms"): { refunded: number; result?: TransferResult } {
    const run = this.db.transaction(() => {
      const room = this.get(roomId);
      if (room.unused_refund_tx_id) return { refunded: 0 };
      const wasClosedAsUnused = room.close_reason === "unused";
      if (room.activated_at !== null || room.expires_at === null) return { refunded: 0 };
      if (room.expires_at <= now() && !wasClosedAsUnused) return { refunded: 0 };

      const original = this.ledger.findByIdempotencyKey(`room:create:${room.channel_id}`);
      if (!original || original.amount <= 0) return { refunded: 0 };

      const account = `user:${room.owner_id}`;
      this.ledger.ensureAccount(account, "user");
      const result = this.ledger.transfer({
        from: TREASURY,
        to: account,
        amount: original.amount,
        type: "room_refund",
        actor,
        reason: "未利用の有料部屋がBot整理で削除されたため全額返金",
        refType: "room:unused_refund",
        refId: String(room.id),
        idempotencyKey: `room:unused-refund:${room.id}`,
      });
      this.db
        .prepare("UPDATE rooms SET unused_refund_tx_id = ?, updated_at = ? WHERE id = ?")
        .run(result.tx.id, now(), room.id);
      this.events.log("room_unused_refunded", {
        actor,
        target: room.owner_id,
        payload: { roomId: room.id, channelId: room.channel_id, amount: original.amount, duplicate: result.duplicate },
      });
      return { refunded: result.duplicate ? 0 : original.amount, result };
    });
    return run();
  }

  requestDelete(roomId: number, reason: RoomCloseReason, actor = "system:rooms"): RoomRow {
    const ts = now();
    this.db
      .prepare(
        `UPDATE rooms
         SET pending_delete = 1,
             close_reason = COALESCE(close_reason, ?),
             close_actor_id = COALESCE(close_actor_id, ?),
             updated_at = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(reason, actor, ts, roomId);
    return this.get(roomId);
  }

  markDeleteFailed(roomId: number, error: unknown): RoomRow {
    const room = this.get(roomId);
    const attempts = room.delete_attempts + 1;
    const delay = Math.min(3600, Math.max(60, attempts * 120));
    const ts = now();
    this.db
      .prepare(
        `UPDATE rooms
         SET pending_delete = 1, delete_attempts = ?, next_delete_retry_at = ?, updated_at = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(attempts, ts + delay, ts, roomId);
    this.events.log("room_delete_failed", {
      target: room.owner_id,
      payload: { roomId, channelId: room.channel_id, attempts, error: error instanceof Error ? error.message : String(error) },
    });
    return this.get(roomId);
  }

  markDeletedAndClosed(roomId: number, reason?: RoomCloseReason, actor?: string): boolean {
    const room = this.get(roomId);
    if (room.status === "closed") return false;
    const ts = now();
    const closeReason = reason ?? room.close_reason ?? "channel_missing";
    const closeActor = actor ?? room.close_actor_id ?? "system:rooms";
    const changed = this.db
      .prepare(
        `UPDATE rooms
         SET status = 'closed', pending_delete = 0, close_reason = ?, close_actor_id = ?, closed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(closeReason, closeActor, ts, ts, roomId);
    if (changed.changes === 1) {
      this.events.log("room_closed", {
        actor: closeActor,
        target: room.owner_id,
        payload: { kind: room.kind, channelId: room.channel_id, reason: closeReason },
      });
      return true;
    }
    return false;
  }

  close(roomId: number, reason: string): void {
    this.markDeletedAndClosed(roomId, reason, "system:rooms");
  }

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
        `INSERT INTO recruits (room_id, owner_id, target_gender, purpose, message, status, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      )
      .run(input.roomId, input.ownerId, input.targetGender, input.purpose, input.message ?? null, ts, ts, ts + hours * 3600);
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
      .prepare("UPDATE recruits SET panel_channel_id = ?, panel_message_id = ?, updated_at = ? WHERE id = ?")
      .run(channelId, messageId, now(), recruitId);
  }

  claimRecruitForMatch(recruitId: number, joinerId: string): RecruitRow {
    const ts = now();
    const changed = this.db
      .prepare(
        `UPDATE recruits
         SET matched_user_id = ?, updated_at = ?
         WHERE id = ? AND status = 'open' AND matched_user_id IS NULL AND expires_at > ?`,
      )
      .run(joinerId, ts, recruitId, ts);
    if (changed.changes !== 1) {
      const recruit = this.getRecruit(recruitId);
      if (recruit.status !== "open" || recruit.expires_at <= ts) throw new RoomError("ERR_RECRUIT_CLOSED", { recruitId });
      throw new RoomError("ERR_RECRUIT_CLAIMED", { recruitId, matchedUserId: recruit.matched_user_id });
    }
    return this.getRecruit(recruitId);
  }

  releaseRecruitClaim(recruitId: number, joinerId: string): void {
    this.db
      .prepare("UPDATE recruits SET matched_user_id = NULL, updated_at = ? WHERE id = ? AND status = 'open' AND matched_user_id = ?")
      .run(now(), recruitId, joinerId);
  }

  confirmRecruitMatched(recruitId: number, joinerId: string): RecruitRow {
    const changed = this.db
      .prepare(
        "UPDATE recruits SET status = 'matched', matched_user_id = ?, updated_at = ? WHERE id = ? AND status = 'open' AND matched_user_id = ?",
      )
      .run(joinerId, now(), recruitId, joinerId);
    if (changed.changes !== 1) throw new RoomError("ERR_RECRUIT_CLOSED", { recruitId });
    const recruit = this.getRecruit(recruitId);
    this.events.log("recruit_matched", { actor: joinerId, target: recruit.owner_id, payload: { recruitId } });
    return recruit;
  }

  matchRecruit(recruitId: number, joinerId: string): RecruitRow {
    try {
      const recruit = this.claimRecruitForMatch(recruitId, joinerId);
      return this.confirmRecruitMatched(recruit.id, joinerId);
    } catch (error) {
      if (error instanceof RoomError && (error.code === "ERR_RECRUIT_CLOSED" || error.code === "ERR_RECRUIT_CLAIMED")) {
        return this.getRecruit(recruitId);
      }
      throw error;
    }
  }

  cancelRecruit(recruitId: number, actor: string, reason = "cancelled"): RecruitRow {
    const recruit = this.getRecruit(recruitId);
    if (recruit.status !== "open" || recruit.matched_user_id) throw new RoomError("ERR_RECRUIT_CLOSED", { recruitId });
    this.db
      .prepare("UPDATE recruits SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'open'")
      .run(now(), recruitId);
    this.events.log("recruit_cancelled", { actor, target: recruit.owner_id, payload: { recruitId, reason } });
    return this.getRecruit(recruitId);
  }

  expireRecruits(): Array<{ recruit: RecruitRow; room: RoomRow; refunded: number }> {
    const rows = this.db
      .prepare("SELECT * FROM recruits WHERE status = 'open' AND expires_at < ?")
      .all(now()) as RecruitRow[];
    const results: Array<{ recruit: RecruitRow; room: RoomRow; refunded: number }> = [];
    for (const recruit of rows) {
      const run = this.db.transaction(() => {
        const current = this.getRecruit(recruit.id);
        if (current.status !== "open") return undefined;
        const refund = this.settings.getNumber("room_recruit_refund");
        let refunded = 0;
        let refundTxId: number | null = current.refund_tx_id;
        if (refund > 0 && !current.refund_tx_id) {
          const account = `user:${current.owner_id}`;
          this.ledger.ensureAccount(account, "user");
          const result = this.ledger.transfer({
            from: TREASURY,
            to: account,
            amount: refund,
            type: "room_refund",
            actor: "system:rooms",
            reason: "蜜月の募集が無応募のまま失効",
            refType: "recruit",
            refId: String(current.id),
            idempotencyKey: `room:recruit-refund:${current.id}`,
          });
          refundTxId = result.tx.id;
          refunded = result.duplicate ? 0 : refund;
        }
        this.db
          .prepare("UPDATE recruits SET status = 'expired', refund_tx_id = ?, updated_at = ? WHERE id = ?")
          .run(refundTxId, now(), current.id);
        const room = this.get(current.room_id);
        this.events.log("recruit_expired", { target: current.owner_id, payload: { recruitId: current.id } });
        return { recruit: this.getRecruit(current.id), room, refunded };
      });
      const result = run();
      if (result) results.push(result);
    }
    return results;
  }

  createOborozukiInvite(input: {
    requesterId: string;
    targetId: string;
    token: string;
    ttlSeconds?: number;
  }): OborozukiInviteRow {
    const run = this.db.transaction(() => {
      const pending = this.db
        .prepare("SELECT * FROM oborozuki_invites WHERE requester_id = ? AND status = 'pending' AND expires_at > ?")
        .get(input.requesterId, now()) as OborozukiInviteRow | undefined;
      if (pending) throw new RoomError("ERR_INVITE_PENDING", { inviteId: pending.id });
      const ts = now();
      const price = this.priceFor("oborozuki");
      const result = this.db
        .prepare(
          `INSERT INTO oborozuki_invites (requester_id, target_id, token, price, status, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(input.requesterId, input.targetId, input.token, price, ts + (input.ttlSeconds ?? 15 * 60), ts, ts);
      this.events.log("oborozuki_invite_opened", {
        actor: input.requesterId,
        target: input.targetId,
        payload: { inviteId: result.lastInsertRowid, price },
      });
      return this.getOborozukiInvite(Number(result.lastInsertRowid));
    });
    return run();
  }

  getOborozukiInvite(id: number): OborozukiInviteRow {
    const row = this.db.prepare("SELECT * FROM oborozuki_invites WHERE id = ?").get(id) as OborozukiInviteRow | undefined;
    if (!row) throw new Error(`oborozuki invite not found: ${id}`);
    return row;
  }

  getOborozukiInviteByToken(token: string): OborozukiInviteRow | undefined {
    return this.db.prepare("SELECT * FROM oborozuki_invites WHERE token = ?").get(token) as OborozukiInviteRow | undefined;
  }

  decideOborozukiInvite(token: string, targetId: string, decision: "declined" | "cancelled"): OborozukiInviteRow {
    const invite = this.getOborozukiInviteByToken(token);
    if (!invite || invite.target_id !== targetId || invite.status !== "pending") {
      throw new RoomError("ERR_INVITE_CLOSED", { token });
    }
    const ts = now();
    this.db
      .prepare("UPDATE oborozuki_invites SET status = ?, decided_at = ?, updated_at = ? WHERE id = ?")
      .run(decision, ts, ts, invite.id);
    this.events.log(`oborozuki_invite_${decision}`, {
      actor: targetId,
      target: invite.requester_id,
      payload: { inviteId: invite.id },
    });
    return this.getOborozukiInvite(invite.id);
  }

  acceptOborozukiInvite(input: { token: string; targetId: string; channelId: string }): { invite: OborozukiInviteRow; room: RoomRow } {
    const run = this.db.transaction(() => {
      const invite = this.getOborozukiInviteByToken(input.token);
      const ts = now();
      if (!invite || invite.target_id !== input.targetId || invite.status !== "pending") {
        throw new RoomError("ERR_INVITE_CLOSED", { token: input.token });
      }
      if (invite.expires_at <= ts) {
        this.db
          .prepare("UPDATE oborozuki_invites SET status = 'expired', decided_at = ?, updated_at = ? WHERE id = ?")
          .run(ts, ts, invite.id);
        throw new RoomError("ERR_INVITE_EXPIRED", { inviteId: invite.id });
      }
      const room = this.register({ kind: "oborozuki", channelId: input.channelId, ownerId: invite.requester_id, priceOverride: invite.price });
      this.db
        .prepare(
          `UPDATE oborozuki_invites
           SET status = 'accepted', room_id = ?, channel_id = ?, decided_at = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(room.id, input.channelId, ts, ts, invite.id);
      this.events.log("oborozuki_invite_accepted", {
        actor: input.targetId,
        target: invite.requester_id,
        payload: { inviteId: invite.id, roomId: room.id },
      });
      return { invite: this.getOborozukiInvite(invite.id), room };
    });
    return run();
  }
}
