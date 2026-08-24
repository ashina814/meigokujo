import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type Role,
  type VoiceChannel,
  type VoiceState,
} from "discord.js";
import type { ReconcileVcPublicSocialChannelInput } from "@meigokujo/core";
import type { Services } from "./services.js";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * 称号用public VC eligibility。current room設定や名前では推測せず、main guildの
 * GuildVoiceかつ@everyoneがViewChannelとConnectを両方持つことだけをcanonicalにする。
 * permission解決不能・例外はfail-closed。
 */
export function isEligiblePublicSocialVoiceChannel(
  channel: GuildBasedChannel,
  services: Services,
): channel is VoiceChannel {
  try {
    const mainGuildId = services.settings.getString("guild:main");
    if (!mainGuildId || channel.guildId !== mainGuildId || channel.type !== ChannelType.GuildVoice) return false;
    const permissions = channel.permissionsFor(channel.guild.roles.everyone);
    return Boolean(
      permissions?.has(PermissionFlagsBits.ViewChannel) &&
        permissions.has(PermissionFlagsBits.Connect),
    );
  } catch {
    return false;
  }
}

function mainGuild(services: Services, guild: Guild): boolean {
  try {
    const mainGuildId = services.settings.getString("guild:main");
    return Boolean(mainGuildId && guild.id === mainGuildId);
  } catch {
    return false;
  }
}

function snapshotChannel(
  channel: GuildBasedChannel,
  services: Services,
  observedAt: number,
): ReconcileVcPublicSocialChannelInput {
  const eligible = isEligiblePublicSocialVoiceChannel(channel, services);
  const humanUserIds =
    channel.type === ChannelType.GuildVoice
      ? [...channel.members.values()].filter((member) => !member.user.bot).map((member) => member.id)
      : [];
  return { guildId: channel.guildId, channelId: channel.id, eligible, humanUserIds, observedAt };
}

interface PendingChannel {
  readonly suspendedAt: number;
  readonly observations: ReconcileVcPublicSocialChannelInput[];
}

/**
 * Gateway/guild lossとwriter failureをsource-localに隔離するstate。
 * Gateway suspended中のreplayは捨て、writer failure中のlive observationだけはmemoryへ保留して
 * 次の正常writeで順序どおりatomic replayする。process restart後の推測やfetchは行わない。
 */
class VcPublicSocialTrackingState {
  readonly suspendedShards = new Set<number>();
  readonly suspendedGuilds = new Map<string, number>();
  readonly pendingChannels = new Map<string, PendingChannel>();

  constructor(private readonly services: Services) {}

  private channelKey(guildId: string, channelId: string): string {
    return `${guildId}\u0000${channelId}`;
  }

  reconcile(channel: GuildBasedChannel, observedAt: number): boolean {
    try {
      return this.reconcileObservedChannel(channel, observedAt);
    } catch (error) {
      console.error("[vc-public-social] channel snapshot failed", error);
      return false;
    }
  }

  private reconcileObservedChannel(channel: GuildBasedChannel, observedAt: number): boolean {
    if (this.suspendedGuilds.has(channel.guildId)) return false;
    const input = snapshotChannel(channel, this.services, observedAt);
    const key = this.channelKey(input.guildId, input.channelId);
    const pending = this.pendingChannels.get(key);
    if (pending) {
      pending.observations.push(input);
      try {
        this.services.vcPublicSocial.reconcileChannelBatch(pending.observations);
        this.pendingChannels.delete(key);
        return true;
      } catch (error) {
        this.closeChannelAtTrustLoss(input.guildId, input.channelId, pending.suspendedAt);
        console.error("[vc-public-social] pending observation reconciliation failed", error);
        return false;
      }
    }

    try {
      // Keep this exact call shape in the restricted-source contract audit.
      this.services.vcPublicSocial.reconcileChannel({
        guildId: input.guildId,
        channelId: input.channelId,
        eligible: input.eligible,
        humanUserIds: input.humanUserIds,
        observedAt: input.observedAt,
      });
      return true;
    } catch (error) {
      this.pendingChannels.set(key, { suspendedAt: observedAt, observations: [input] });
      this.closeChannelAtTrustLoss(input.guildId, input.channelId, observedAt);
      console.error("[vc-public-social] channel observation write failed", error);
      return false;
    }
  }

  private closeChannelAtTrustLoss(guildId: string, channelId: string, suspendedAt: number): void {
    try {
      this.services.vcPublicSocial.suspendChannel(guildId, channelId, suspendedAt);
    } catch (error) {
      // Coreのin-process fenceはこのwriteも失敗した場合にopen rowをclipする。
      console.error("[vc-public-social] channel trust-boundary write failed", error);
    }
  }

  suspendGuild(guild: Guild, observedAt: number): boolean {
    if (!mainGuild(this.services, guild)) return false;
    const current = this.suspendedGuilds.get(guild.id);
    const suspendedAt = current === undefined ? observedAt : Math.min(current, observedAt);
    this.suspendedGuilds.set(guild.id, suspendedAt);
    try {
      this.services.vcPublicSocial.suspendGuild(guild.id, suspendedAt);
      return true;
    } catch (error) {
      console.error("[vc-public-social] guild trust-boundary write failed", error);
      return false;
    }
  }

  resumeGuild(guild: Guild, observedAt: number): boolean {
    if (!mainGuild(this.services, guild) || this.suspendedShards.has(guild.shardId)) return false;
    const suspendedAt = this.suspendedGuilds.get(guild.id);
    if (suspendedAt === undefined) return false;
    try {
      const channels = [...guild.channels.cache.values()]
        .filter((channel): channel is VoiceChannel => channel.type === ChannelType.GuildVoice)
        .map((channel) => {
          const snapshot = snapshotChannel(channel, this.services, observedAt);
          return {
            channelId: snapshot.channelId,
            eligible: snapshot.eligible,
            humanUserIds: snapshot.humanUserIds,
          };
        });
      this.services.vcPublicSocial.resumeGuild({ guildId: guild.id, suspendedAt, observedAt, channels });
      this.suspendedGuilds.delete(guild.id);
      for (const key of this.pendingChannels.keys()) {
        if (key.startsWith(`${guild.id}\u0000`)) this.pendingChannels.delete(key);
      }
      return true;
    } catch (error) {
      console.error("[vc-public-social] current guild observation recovery failed", error);
      return false;
    }
  }
}

const trackingStates = new WeakMap<Services, VcPublicSocialTrackingState>();

function trackingState(services: Services): VcPublicSocialTrackingState {
  let state = trackingStates.get(services);
  if (!state) {
    state = new VcPublicSocialTrackingState(services);
    trackingStates.set(services, state);
  }
  return state;
}

function findMainGuild(client: Client, services: Services): Guild | undefined {
  try {
    const mainGuildId = services.settings.getString("guild:main");
    return mainGuildId ? client.guilds.cache.get(mainGuildId) : undefined;
  } catch (error) {
    console.error("[vc-public-social] main guild lookup failed", error);
    return undefined;
  }
}

function reconcileGuildVoiceChannels(guild: Guild, services: Services, observedAt: number): boolean {
  if (!mainGuild(services, guild)) return false;
  let ok = true;
  for (const channel of guild.channels.cache.values()) {
    if (channel.type === ChannelType.GuildVoice) {
      ok = trackingState(services).reconcile(channel, observedAt) && ok;
    }
  }
  return ok;
}

/** VoiceStateUpdate後のcache snapshotでold/new両channelを全human分収束させる。 */
export function trackVcPublicSocialPresence(
  oldState: VoiceState,
  newState: VoiceState,
  services: Services,
  now: () => number = nowSeconds,
): boolean {
  const observedAt = now();
  const channels = new Map<string, GuildBasedChannel>();
  if (oldState.channel) channels.set(oldState.channel.id, oldState.channel);
  if (newState.channel) channels.set(newState.channel.id, newState.channel);
  let ok = channels.size > 0;
  for (const channel of channels.values()) ok = trackingState(services).reconcile(channel, observedAt) && ok;
  return ok;
}

/** Voice channel自身またはcategoryのpermission transitionをcacheだけで再収束する。 */
export function trackVcPublicSocialChannelUpdate(
  channel: GuildBasedChannel,
  services: Services,
  now: () => number = nowSeconds,
): boolean {
  const observedAt = now();
  if (!mainGuild(services, channel.guild)) return false;
  if (channel.type === ChannelType.GuildVoice) return trackingState(services).reconcile(channel, observedAt);
  if (channel.type !== ChannelType.GuildCategory) return false;
  let ok = true;
  for (const child of channel.guild.channels.cache.values()) {
    if (child.type === ChannelType.GuildVoice && child.parentId === channel.id) {
      ok = trackingState(services).reconcile(child, observedAt) && ok;
    }
  }
  return ok;
}

/** main guild @everyone role transitionだけが全voice visibilityを変え得る正本。 */
export function trackVcPublicSocialEveryoneRoleUpdate(
  role: Role,
  services: Services,
  now: () => number = nowSeconds,
): boolean {
  const observedAt = now();
  if (!mainGuild(services, role.guild) || role.id !== role.guild.roles.everyone.id) return false;
  return reconcileGuildVoiceChannels(role.guild, services, observedAt);
}

/** restart後は履歴をfetchせず、ready時点のmain guild cacheから新しい観測だけを開始する。 */
export function initializeVcPublicSocialPresence(
  client: Client,
  services: Services,
  now: () => number = nowSeconds,
): boolean {
  const guild = findMainGuild(client, services);
  if (!guild) return false;
  return reconcileGuildVoiceChannels(guild, services, now());
}

/** recoverable closeはShardDisconnectではなくShardReconnectingにも来るため両eventから呼ぶ。 */
export function suspendVcPublicSocialShard(
  client: Client,
  shardId: number,
  services: Services,
  now: () => number = nowSeconds,
): boolean {
  const state = trackingState(services);
  state.suspendedShards.add(shardId);
  const guild = findMainGuild(client, services);
  if (!guild || guild.shardId !== shardId) return false;
  return state.suspendGuild(guild, now());
}

/** shardResumeはreplay dispatch完了後、ShardReadyはfresh Identifyのguild cache収束後。 */
export function resumeVcPublicSocialShard(
  client: Client,
  shardId: number,
  services: Services,
  now: () => number = nowSeconds,
): boolean {
  const state = trackingState(services);
  state.suspendedShards.delete(shardId);
  const guild = findMainGuild(client, services);
  if (!guild || guild.shardId !== shardId) return false;
  return state.resumeGuild(guild, now());
}

export function suspendVcPublicSocialGuild(
  guild: Guild,
  services: Services,
  now: () => number = nowSeconds,
): boolean {
  return trackingState(services).suspendGuild(guild, now());
}

export function resumeVcPublicSocialGuild(
  guild: Guild,
  services: Services,
  now: () => number = nowSeconds,
): boolean {
  return trackingState(services).resumeGuild(guild, now());
}
