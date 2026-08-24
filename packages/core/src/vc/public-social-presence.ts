import type Database from "better-sqlite3";

export type VcPublicSocialPresenceEndQuality = "observed" | "recovered_estimate" | null;

export interface ReconcileVcPublicSocialChannelInput {
  readonly guildId: string;
  readonly channelId: string;
  /** main guild / GuildVoice / @everyone ViewChannel+Connectをcallerが全て証明したか。 */
  readonly eligible: boolean;
  /** channel cacheで現在観測できるhuman member IDs。bot identityはcallerで除く。 */
  readonly humanUserIds: readonly string[];
  /** Gateway healthy中のhandler entryで固定したunix seconds。replayはcallerが除外する。 */
  readonly observedAt: number;
}

export interface VcPublicSocialPresenceReconcileResult {
  readonly opened: number;
  readonly closed: number;
}

export interface ResumeVcPublicSocialGuildInput {
  readonly guildId: string;
  /** Gateway observationを失ったことをliveに検知したunix seconds。 */
  readonly suspendedAt: number;
  /** replay完了またはfresh ready後にcurrent cacheを観測したunix seconds。 */
  readonly observedAt: number;
  readonly channels: ReadonlyArray<Omit<ReconcileVcPublicSocialChannelInput, "guildId" | "observedAt">>;
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

interface TrustFences {
  readonly channels: Map<string, number>;
  readonly guilds: Map<string, number>;
}

const trustFences = new WeakMap<Database.Database, TrustFences>();

function fencesFor(db: Database.Database): TrustFences {
  let fences = trustFences.get(db);
  if (!fences) {
    fences = { channels: new Map(), guilds: new Map() };
    trustFences.set(db, fences);
  }
  return fences;
}

function channelKey(guildId: string, channelId: string): string {
  return `${guildId}\u0000${channelId}`;
}

function setEarlierFence(target: Map<string, number>, key: string, observedAt: number): void {
  const current = target.get(key);
  if (current === undefined || observedAt < current) target.set(key, observedAt);
}

/**
 * DB write自体が失敗してpersisted open rowを直ちに閉じられない間も、同一processの
 * title readerが失敗時刻より後をtrustedとして伸ばさないためのfail-closed boundary。
 * 通常は直後のsuspend writeで同じ境界がdurableになり、reconcile成功時に解除される。
 */
export function getVcPublicSocialTrustFence(
  db: Database.Database,
  guildId: string,
  channelId: string,
): number | undefined {
  const fences = trustFences.get(db);
  if (!fences) return undefined;
  const guildFence = fences.guilds.get(guildId);
  const channelFence = fences.channels.get(channelKey(guildId, channelId));
  if (guildFence === undefined) return channelFence;
  if (channelFence === undefined) return guildFence;
  return Math.min(guildFence, channelFence);
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
    const result = this.reconcileChannelBatch([input]);
    return result;
  }

  /** writer failure中に保持したlive observationを、順序を保った1 transactionで再適用する。 */
  reconcileChannelBatch(
    inputs: readonly ReconcileVcPublicSocialChannelInput[],
  ): VcPublicSocialPresenceReconcileResult {
    if (inputs.length === 0) return { opened: 0, closed: 0 };
    const normalized = inputs.map((input) => this.normalizeInput(input));
    const first = normalized[0]!;
    if (normalized.some((input) => input.guildId !== first.guildId || input.channelId !== first.channelId)) {
      throw new Error("reconcileChannelBatch requires one guild/channel");
    }
    const key = channelKey(first.guildId, first.channelId);
    try {
      const result = this.db.transaction(() => {
        let opened = 0;
        let closed = 0;
        for (const input of normalized) {
          const applied = this.applyReconcile(input);
          opened += applied.opened;
          closed += applied.closed;
        }
        return { opened, closed };
      })();
      fencesFor(this.db).channels.delete(key);
      return result;
    } catch (error) {
      setEarlierFence(fencesFor(this.db).channels, key, first.observedAt);
      throw error;
    }
  }

  private normalizeInput(input: ReconcileVcPublicSocialChannelInput): {
    guildId: string;
    channelId: string;
    desired: Set<string>;
    observedAt: number;
  } {
    const guildId = requireText(input.guildId, "guildId");
    const channelId = requireText(input.channelId, "channelId");
    const observedAt = requireTimestamp(input.observedAt);
    const humans = [...new Set(input.humanUserIds.map((id) => requireText(id, "humanUserId")))];
    const desired = new Set(input.eligible && humans.length >= 2 ? humans : []);
    return { guildId, channelId, desired, observedAt };
  }

  private applyReconcile(input: {
    guildId: string;
    channelId: string;
    desired: Set<string>;
    observedAt: number;
  }): VcPublicSocialPresenceReconcileResult {
    const { guildId, channelId, desired, observedAt } = input;
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
  }

  /**
   * channel-local observationを失った境界でpersisted open rowを閉じる。これは在室終了の
   * 推測ではなく「ここより後は称号用に証明しない」というobserved trust boundary。
   * fenceは次の正常なreconcile/batch成功まで残す。
   */
  suspendChannel(guildIdValue: string, channelIdValue: string, observedAtValue: number): number {
    const guildId = requireText(guildIdValue, "guildId");
    const channelId = requireText(channelIdValue, "channelId");
    const observedAt = requireTimestamp(observedAtValue);
    setEarlierFence(fencesFor(this.db).channels, channelKey(guildId, channelId), observedAt);
    return this.db
      .prepare(
        `UPDATE vc_public_social_presence
            SET ended_at = ?, end_quality = 'observed'
          WHERE guild_id = ? AND channel_id = ? AND ended_at IS NULL`,
      )
      .run(observedAt, guildId, channelId).changes;
  }

  /** shard/guild observation lossをmain-guild単位で閉じ、他guildへ波及させない。 */
  suspendGuild(guildIdValue: string, observedAtValue: number): number {
    const guildId = requireText(guildIdValue, "guildId");
    const observedAt = requireTimestamp(observedAtValue);
    setEarlierFence(fencesFor(this.db).guilds, guildId, observedAt);
    return this.db
      .prepare(
        `UPDATE vc_public_social_presence
            SET ended_at = ?, end_quality = 'observed'
          WHERE guild_id = ? AND ended_at IS NULL`,
      )
      .run(observedAt, guildId).changes;
  }

  /**
   * replayを使わず、loss boundaryでstale rowを閉じたうえでready時点のcurrent cacheだけを
   * 1 transactionで開始する。transaction失敗中はguild fenceが残る。
   */
  resumeGuild(input: ResumeVcPublicSocialGuildInput): VcPublicSocialPresenceReconcileResult {
    const guildId = requireText(input.guildId, "guildId");
    const suspendedAt = requireTimestamp(input.suspendedAt);
    const observedAt = requireTimestamp(input.observedAt);
    const normalized = input.channels.map((channel) =>
      this.normalizeInput({ ...channel, guildId, observedAt }),
    );
    try {
      const result = this.db.transaction(() => {
        this.db
          .prepare(
            `UPDATE vc_public_social_presence
                SET ended_at = ?, end_quality = 'observed'
              WHERE guild_id = ? AND ended_at IS NULL`,
          )
          .run(suspendedAt, guildId);
        let opened = 0;
        let closed = 0;
        for (const channel of normalized) {
          const applied = this.applyReconcile(channel);
          opened += applied.opened;
          closed += applied.closed;
        }
        return { opened, closed };
      })();
      const fences = fencesFor(this.db);
      fences.guilds.delete(guildId);
      for (const channel of normalized) fences.channels.delete(channelKey(guildId, channel.channelId));
      return result;
    } catch (error) {
      setEarlierFence(fencesFor(this.db).guilds, guildId, suspendedAt);
      throw error;
    }
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
