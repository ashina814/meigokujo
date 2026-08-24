import type Database from "better-sqlite3";
import { EventLog } from "../events/service.js";

const systemNow = () => Math.floor(Date.now() / 1000);

export interface TableTypeDef { key: string; name: string; emoji: string; userLimit: number }
export const TABLE_TYPES: readonly TableTypeDef[] = [
  { key: "sashi", name: "サシ卓", emoji: "⚔", userLimit: 2 },
  { key: "mahjong", name: "麻雀卓", emoji: "🀄", userLimit: 4 },
  { key: "duel", name: "対戦卓", emoji: "🎲", userLimit: 4 },
  { key: "watch", name: "観戦席", emoji: "👀", userLimit: 8 },
  { key: "zatsu", name: "雑談卓", emoji: "💬", userLimit: 6 },
];

/** UI一覧から自動拡張しない、No.70/71の明示allowlist。 */
export const TITLE_ELIGIBLE_CASINO_TABLE_TYPES = ["sashi", "mahjong", "duel", "watch", "zatsu"] as const;
export type TitleEligibleCasinoTableType = (typeof TITLE_ELIGIBLE_CASINO_TABLE_TYPES)[number];

export interface TempVc { channel_id: string; guild_id: string; owner_id: string; table_type: string; created_at: number }
export interface TakuGuestObservation {
  readonly userId: string;
  /** falseだけがcanonical human。true/unknownは新規intervalを開かない。 */
  readonly isBot: boolean | undefined;
  readonly oldChannelId: string | null;
  readonly newChannelId: string | null;
  readonly observedAt?: number;
}

/** current-state卓管理と、append-only instance / guest presence正本。 */
export class Takutate {
  constructor(
    private readonly db: Database.Database,
    private readonly events: EventLog,
    private readonly clock: () => number = systemNow,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_temp_vcs (
        channel_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        table_type TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS casino_table_instances (
        channel_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        table_type TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS casino_table_instances_no_update
      BEFORE UPDATE ON casino_table_instances BEGIN SELECT RAISE(ABORT, 'casino_table_instances is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS casino_table_instances_no_delete
      BEFORE DELETE ON casino_table_instances BEGIN SELECT RAISE(ABORT, 'casino_table_instances is append-only'); END;
      CREATE TABLE IF NOT EXISTS casino_table_guest_presence (
        id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, user_id TEXT NOT NULL,
        is_human INTEGER NOT NULL CHECK(is_human = 1), started_at INTEGER NOT NULL,
        ended_at INTEGER, end_quality TEXT CHECK(end_quality IN ('observed','observation_ended','recovered_unknown')),
        CHECK((ended_at IS NULL AND end_quality IS NULL) OR
              (ended_at IS NOT NULL AND end_quality IS NOT NULL AND ended_at >= started_at))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_casino_table_guest_open
        ON casino_table_guest_presence(channel_id, user_id) WHERE ended_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_casino_table_guest_user_time
        ON casino_table_guest_presence(user_id, started_at, ended_at);
      CREATE TRIGGER IF NOT EXISTS casino_table_guest_no_delete
      BEFORE DELETE ON casino_table_guest_presence BEGIN SELECT RAISE(ABORT, 'casino_table_guest_presence is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS casino_table_guest_close_once
      BEFORE UPDATE ON casino_table_guest_presence
      WHEN NOT (
        OLD.id = NEW.id AND OLD.channel_id = NEW.channel_id AND OLD.user_id = NEW.user_id AND
        OLD.is_human = NEW.is_human AND OLD.started_at = NEW.started_at AND
        OLD.ended_at IS NULL AND OLD.end_quality IS NULL AND NEW.ended_at IS NOT NULL AND
        NEW.ended_at >= OLD.started_at AND NEW.end_quality IN ('observed','observation_ended','recovered_unknown')
      ) BEGIN SELECT RAISE(ABORT, 'casino_table_guest_presence may only be closed once'); END;
    `);
    // Restart gap is unknown. Preserve the audit occurrence, but trust zero seconds.
    this.db.prepare(`UPDATE casino_table_guest_presence SET ended_at = started_at,
      end_quality = 'recovered_unknown' WHERE ended_at IS NULL`).run();
  }

  track(channelId: string, guildId: string, ownerId: string, tableType: string): void {
    const createdAt = this.clock();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO casino_temp_vcs
        (channel_id,guild_id,owner_id,table_type,created_at) VALUES (?,?,?,?,?)`)
        .run(channelId, guildId, ownerId, tableType, createdAt);
      this.db.prepare(`INSERT INTO casino_table_instances
        (channel_id,guild_id,owner_id,table_type,created_at) VALUES (?,?,?,?,?)`)
        .run(channelId, guildId, ownerId, tableType, createdAt);
      this.events.log("takutate_create", { actor: ownerId, payload: { channelId, tableType } });
    })();
  }

  untrack(channelId: string, observedAt = this.clock()): void {
    this.db.transaction(() => {
      this.closeChannelGuestObservations(channelId, observedAt);
      this.db.prepare("DELETE FROM casino_temp_vcs WHERE channel_id = ?").run(channelId);
    })();
  }

  observeGuestTransition(input: TakuGuestObservation): void {
    const observedAt = input.observedAt ?? this.clock();
    this.db.transaction(() => {
      if (input.oldChannelId && input.oldChannelId !== input.newChannelId)
        this.closeGuest(input.oldChannelId, input.userId, observedAt);
      if (input.newChannelId && input.newChannelId !== input.oldChannelId && input.isBot === false)
        this.openGuest(input.newChannelId, input.userId, observedAt);
    })();
  }

  /** Startup/current cache: historical backfillをせず、この観測時刻からだけ開始する。 */
  observeCurrentGuest(channelId: string, userId: string, isBot: boolean | undefined, observedAt = this.clock()): void {
    if (isBot === false) this.openGuest(channelId, userId, observedAt);
  }

  closeChannelGuestObservations(channelId: string, observedAt = this.clock(), quality: "observed" | "observation_ended" = "observed"): void {
    this.db.prepare(`UPDATE casino_table_guest_presence SET ended_at = MAX(started_at, ?), end_quality = ?
      WHERE channel_id = ? AND ended_at IS NULL`).run(observedAt, quality, channelId);
  }

  closeAllGuestObservations(observedAt = this.clock()): void {
    this.db.prepare(`UPDATE casino_table_guest_presence SET ended_at = MAX(started_at, ?),
      end_quality = 'observation_ended' WHERE ended_at IS NULL`).run(observedAt);
  }

  list(): TempVc[] { return this.db.prepare("SELECT * FROM casino_temp_vcs").all() as TempVc[] }
  isTracked(channelId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM casino_temp_vcs WHERE channel_id = ?").get(channelId);
  }

  private openGuest(channelId: string, userId: string, observedAt: number): void {
    const table = this.db.prepare("SELECT owner_id FROM casino_temp_vcs WHERE channel_id = ?")
      .get(channelId) as { owner_id: string } | undefined;
    if (!table || table.owner_id === userId) return;
    this.db.prepare(`INSERT OR IGNORE INTO casino_table_guest_presence
      (channel_id,user_id,is_human,started_at,ended_at,end_quality) VALUES (?,?,1,?,NULL,NULL)`)
      .run(channelId, userId, observedAt);
  }

  private closeGuest(channelId: string, userId: string, observedAt: number): void {
    this.db.prepare(`UPDATE casino_table_guest_presence SET ended_at = MAX(started_at, ?), end_quality = 'observed'
      WHERE channel_id = ? AND user_id = ? AND ended_at IS NULL`).run(observedAt, channelId, userId);
  }
}
