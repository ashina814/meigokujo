import type Database from "better-sqlite3";

export type VcPublicSocialPresenceEndQuality = "observed" | "recovered_estimate" | null;

export interface ReconcileVcPublicSocialChannelInput {
  readonly guildId: string;
  readonly channelId: string;
  /** main guild / GuildVoice / @everyone ViewChannel+Connectをcallerが全て証明したか。 */
  readonly eligible: boolean;
  /** channel cacheで現在観測できるhuman member IDs。bot identityはcallerで除く。 */
  readonly humanUserIds: readonly string[];
  /** handler entryで固定したunix seconds。event timeとknowledge timeは同じlive observation。 */
  readonly observedAt: number;
}

export interface VcPublicSocialPresenceReconcileResult {
  readonly opened: number;
  readonly closed: number;
}

interface OpenRow {
  readonly user_id: string;
}

function requireText(value: string, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function requireTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`observedAt must be a non-negative safe integer unix second: ${value}`);
  }
  return value;
}

/**
 * public social VC intervalのcanonical writer。
 *
 * occupancyをpairへ展開しない。eligible channelにhumanが2人以上いる間、各humanへ
 * 1本だけuser-level intervalを開くため、3人同時でもwall-clock secondsはpair-sumに
 * ならない。Discord cache/permissionの解釈はbot sidecarの責務で、このserviceは
 * その時点の完全なchannel snapshotをtransactionで収束させる。
 */
export class VcPublicSocialPresence {
  constructor(private readonly db: Database.Database) {}

  reconcileChannel(input: ReconcileVcPublicSocialChannelInput): VcPublicSocialPresenceReconcileResult {
    const guildId = requireText(input.guildId, "guildId");
    const channelId = requireText(input.channelId, "channelId");
    const observedAt = requireTimestamp(input.observedAt);
    const humans = [...new Set(input.humanUserIds.map((id) => requireText(id, "humanUserId")))];
    const desired = new Set(input.eligible && humans.length >= 2 ? humans : []);

    return this.db.transaction(() => {
      const openRows = this.db
        .prepare(
          `SELECT user_id
             FROM vc_public_social_presence
            WHERE guild_id = ? AND channel_id = ? AND ended_at IS NULL`,
        )
        .all(guildId, channelId) as OpenRow[];
      const open = new Set(openRows.map((row) => row.user_id));
      let closed = 0;
      let opened = 0;

      const closeStatement = this.db.prepare(
        `UPDATE vc_public_social_presence
            SET ended_at = ?, end_quality = 'observed'
          WHERE user_id = ? AND guild_id = ? AND channel_id = ? AND ended_at IS NULL`,
      );
      for (const userId of open) {
        if (desired.has(userId)) continue;
        closed += closeStatement.run(observedAt, userId, guildId, channelId).changes;
      }

      const openStatement = this.db.prepare(
        `INSERT INTO vc_public_social_presence
           (user_id, guild_id, channel_id, started_at, ended_at, end_quality)
         VALUES (?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(user_id, guild_id, channel_id) WHERE ended_at IS NULL DO NOTHING`,
      );
      for (const userId of desired) {
        if (open.has(userId)) continue;
        opened += openStatement.run(userId, guildId, channelId, observedAt).changes;
      }
      return { opened, closed };
    })();
  }

  /** graceful shutdownで現在までをobservedとして閉じる。 */
  closeAllObserved(observedAt: number): number {
    return this.db
      .prepare(
        `UPDATE vc_public_social_presence
            SET ended_at = ?, end_quality = 'observed'
          WHERE ended_at IS NULL`,
      )
      .run(requireTimestamp(observedAt)).changes;
  }

  /**
   * crash後のdangling intervalをuntrustedとして閉じる。readerはこの品質の行を除外するため、
   * 最後のeventから起動時刻までをobservedと偽ることも、downtimeをtrusted backfillすることもない。
   */
  recoverDangling(observedAt: number): number {
    return this.db
      .prepare(
        `UPDATE vc_public_social_presence
            SET ended_at = ?, end_quality = 'recovered_estimate'
          WHERE ended_at IS NULL`,
      )
      .run(requireTimestamp(observedAt)).changes;
  }
}
