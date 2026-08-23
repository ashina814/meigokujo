import {
  ChannelType,
  PermissionFlagsBits,
  type GuildBasedChannel,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js";
import type { TcSurfaceKind } from "@meigokujo/core";
import type { Services } from "./services.js";

interface EligibleSurface {
  readonly surfaceId: string;
  readonly areaId: string;
  readonly surfaceKind: TcSurfaceKind;
  readonly threadOwnerId: string | null;
  readonly threadCreatedAtMs: number | null;
}

function isExcluded(services: Services, ids: readonly (string | null | undefined)[]): boolean {
  const excluded = new Set(services.settings.getJson<string[]>("xp_excluded_channels", []));
  return ids.some((id) => id !== null && id !== undefined && excluded.has(id));
}

function everyoneCanView(channel: GuildBasedChannel, message: Message<true>): boolean {
  if (!("permissionsFor" in channel) || typeof channel.permissionsFor !== "function") return false;
  const permissions = channel.permissionsFor(message.guild.roles.everyone);
  return Boolean(permissions?.has(PermissionFlagsBits.ViewChannel));
}

/**
 * text_active_daysとは別の、会話構造観測用public TC policy。
 * public thread/forum postは親areaへ畳み、PrivateThread・role-gated・unknownをfail-closedする。
 */
export function classifyTitleTcMessage(message: Message<true>, services: Services): EligibleSurface | null {
  const channel = message.channel;
  if (channel.isThread()) {
    if (channel.type === ChannelType.PrivateThread) return null;
    if (channel.type !== ChannelType.PublicThread && channel.type !== ChannelType.AnnouncementThread) return null;
    const parent = channel.parent;
    if (!parent || !channel.parentId) return null;
    if (
      parent.type !== ChannelType.GuildText &&
      parent.type !== ChannelType.GuildAnnouncement &&
      parent.type !== ChannelType.GuildForum
    ) {
      return null;
    }
    if (!everyoneCanView(parent, message) || !everyoneCanView(channel, message)) return null;
    if (isExcluded(services, [channel.id, channel.parentId, "parentId" in parent ? parent.parentId : null])) return null;
    const surfaceKind: TcSurfaceKind =
      parent.type === ChannelType.GuildForum
        ? "forum_post"
        : channel.type === ChannelType.AnnouncementThread
          ? "announcement_thread"
          : "public_thread";
    return {
      surfaceId: channel.id,
      areaId: channel.parentId,
      surfaceKind,
      threadOwnerId: channel.ownerId ?? null,
      threadCreatedAtMs: channel.createdTimestamp ?? null,
    };
  }

  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) return null;
  if (!everyoneCanView(channel, message)) return null;
  const parentId = "parentId" in channel ? channel.parentId : null;
  if (isExcluded(services, [channel.id, parentId])) return null;
  return {
    surfaceId: channel.id,
    areaId: channel.id,
    surfaceKind: "channel",
    threadOwnerId: null,
    threadCreatedAtMs: null,
  };
}

/** MessageCreate sidecar。本文を一切渡さず、event timeとknowledge timeを分離する。 */
export async function trackTitleTcMessage(
  message: Message,
  services: Services,
  now: () => number = Date.now,
): Promise<boolean> {
  const observedAtMs = now(); // handler entryで1回だけsnapshot
  if (message.author.bot || message.webhookId !== null || message.system) return false;
  if (!message.inGuild()) return false;
  const mainGuildId = services.settings.getString("guild:main");
  if (!mainGuildId || message.guildId !== mainGuildId) return false;
  if (!message.content && message.attachments.size === 0) return false;
  const surface = classifyTitleTcMessage(message, services);
  if (!surface) return false;
  const result = services.tcSocial.recordMessage({
    messageId: message.id,
    authorId: message.author.id,
    surfaceId: surface.surfaceId,
    areaId: surface.areaId,
    surfaceKind: surface.surfaceKind,
    replyToMessageId: message.reference?.messageId ?? null,
    createdAtMs: message.createdTimestamp,
    observedAtMs,
    threadOwnerId: surface.threadOwnerId,
    threadCreatedAtMs: surface.threadCreatedAtMs,
  });
  return result.recorded;
}

/** ReactionAdd sidecar。partial fetch/writer failureはlogだけで、Discord操作へ伝播させない。 */
export async function trackTitleTcReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  services: Services,
  now: () => number = Date.now,
): Promise<boolean> {
  const observedAtMs = now(); // Discordにoccurrence timestampが無いので観測時刻を1回だけsnapshot
  try {
    const resolvedReaction = reaction.partial ? await reaction.fetch() : reaction;
    const resolvedUser = user.partial ? await user.fetch() : user;
    if (resolvedUser.bot) return false;
    const mainGuildId = services.settings.getString("guild:main");
    if (!mainGuildId || resolvedReaction.message.guildId !== mainGuildId) return false;
    return services.tcSocial.recordReaction(resolvedReaction.message.id, resolvedUser.id, observedAtMs).recorded;
  } catch (error) {
    console.error("[tc-social] reaction observation failed", error);
    return false;
  }
}
