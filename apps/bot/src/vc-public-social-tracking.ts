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

function reconcileChannel(channel: GuildBasedChannel, services: Services, observedAt: number): void {
  const eligible = isEligiblePublicSocialVoiceChannel(channel, services);
  const humanUserIds =
    channel.type === ChannelType.GuildVoice
      ? [...channel.members.values()].filter((member) => !member.user.bot).map((member) => member.id)
      : [];
  services.vcPublicSocial.reconcileChannel({
    guildId: channel.guildId,
    channelId: channel.id,
    eligible,
    humanUserIds,
    observedAt,
  });
}

function mainGuild(services: Services, guild: Guild): boolean {
  const mainGuildId = services.settings.getString("guild:main");
  return Boolean(mainGuildId && guild.id === mainGuildId);
}

function reconcileGuildVoiceChannels(guild: Guild, services: Services, observedAt: number): void {
  if (!mainGuild(services, guild)) return;
  for (const channel of guild.channels.cache.values()) {
    if (channel.type === ChannelType.GuildVoice) reconcileChannel(channel, services, observedAt);
  }
}

/** VoiceStateUpdate後のcache snapshotでold/new両channelを全human分収束させる。 */
export function trackVcPublicSocialPresence(
  oldState: VoiceState,
  newState: VoiceState,
  services: Services,
  now: () => number = nowSeconds,
): boolean {
  const observedAt = now();
  try {
    const channels = new Map<string, GuildBasedChannel>();
    if (oldState.channel) channels.set(oldState.channel.id, oldState.channel);
    if (newState.channel) channels.set(newState.channel.id, newState.channel);
    for (const channel of channels.values()) reconcileChannel(channel, services, observedAt);
    return channels.size > 0;
  } catch (error) {
    console.error("[vc-public-social] voice observation failed", error);
    return false;
  }
}

/** Voice channel自身またはcategoryのpermission transitionをcacheだけで再収束する。 */
export function trackVcPublicSocialChannelUpdate(
  channel: GuildBasedChannel,
  services: Services,
  now: () => number = nowSeconds,
): boolean {
  const observedAt = now();
  try {
    if (!mainGuild(services, channel.guild)) return false;
    if (channel.type === ChannelType.GuildVoice) {
      reconcileChannel(channel, services, observedAt);
      return true;
    }
    if (channel.type !== ChannelType.GuildCategory) return false;
    for (const child of channel.guild.channels.cache.values()) {
      if (child.type === ChannelType.GuildVoice && child.parentId === channel.id) {
        reconcileChannel(child, services, observedAt);
      }
    }
    return true;
  } catch (error) {
    console.error("[vc-public-social] channel permission reconciliation failed", error);
    return false;
  }
}

/** main guild @everyone role transitionだけが全voice visibilityを変え得る正本。 */
export function trackVcPublicSocialEveryoneRoleUpdate(
  role: Role,
  services: Services,
  now: () => number = nowSeconds,
): boolean {
  const observedAt = now();
  try {
    if (!mainGuild(services, role.guild) || role.id !== role.guild.roles.everyone.id) return false;
    reconcileGuildVoiceChannels(role.guild, services, observedAt);
    return true;
  } catch (error) {
    console.error("[vc-public-social] everyone permission reconciliation failed", error);
    return false;
  }
}

/** restart後は履歴をfetchせず、ready時点のmain guild cacheから新しい観測だけを開始する。 */
export function initializeVcPublicSocialPresence(
  client: Client,
  services: Services,
  now: () => number = nowSeconds,
): boolean {
  const observedAt = now();
  try {
    const mainGuildId = services.settings.getString("guild:main");
    if (!mainGuildId) return false;
    const guild = client.guilds.cache.get(mainGuildId);
    if (!guild) return false;
    reconcileGuildVoiceChannels(guild, services, observedAt);
    return true;
  } catch (error) {
    console.error("[vc-public-social] startup observation failed", error);
    return false;
  }
}
