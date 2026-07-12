import type Database from "better-sqlite3";
import { EventLog } from "../events/service.js";

/**
 * 卓建て（複製VC）。casino-bot 準拠のシンプル版。
 * パネルのボタンから種類別に一時VCを生成し、最後の1人が退出したら自動削除。
 * casino-bot にあった VC デポジット制度・link 追跡は省略。
 *
 * 追跡テーブル: casino_temp_vcs（再起動を跨いでも掃除できる）
 */
const now = () => Math.floor(Date.now() / 1000);

export interface TableTypeDef {
  key: string;
  name: string;
  emoji: string;
  userLimit: number;
}

export const TABLE_TYPES: readonly TableTypeDef[] = [
  { key: "sashi", name: "サシ卓", emoji: "⚔", userLimit: 2 },
  { key: "mahjong", name: "麻雀卓", emoji: "🀄", userLimit: 4 },
  { key: "duel", name: "対戦卓", emoji: "🎲", userLimit: 4 },
  { key: "watch", name: "観戦席", emoji: "👀", userLimit: 8 },
  { key: "zatsu", name: "雑談卓", emoji: "💬", userLimit: 6 },
];

export interface TempVc {
  channel_id: string;
  guild_id: string;
  owner_id: string;
  table_type: string;
  created_at: number;
}

export class Takutate {
  constructor(
    private readonly db: Database.Database,
    private readonly events: EventLog,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_temp_vcs (
        channel_id TEXT PRIMARY KEY,
        guild_id   TEXT NOT NULL,
        owner_id   TEXT NOT NULL,
        table_type TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  track(channelId: string, guildId: string, ownerId: string, tableType: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO casino_temp_vcs (channel_id, guild_id, owner_id, table_type, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(channelId, guildId, ownerId, tableType, now());
    this.events.log("takutate_create", { actor: ownerId, payload: { channelId, tableType } });
  }

  untrack(channelId: string): void {
    this.db.prepare("DELETE FROM casino_temp_vcs WHERE channel_id = ?").run(channelId);
  }

  list(): TempVc[] {
    return this.db.prepare("SELECT * FROM casino_temp_vcs").all() as TempVc[];
  }

  isTracked(channelId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM casino_temp_vcs WHERE channel_id = ?").get(channelId);
  }
}
