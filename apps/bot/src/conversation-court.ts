import {
  ChannelType,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type VoiceBasedChannel,
  type VoiceState,
} from "discord.js";
import { jstDayOfWeek, jstNow } from "./jst-time.js";
import { isAdminMember } from "./permissions.js";
import type { Services } from "./services.js";

export const CONVERSATION_COURT_CATEGORY_SETTING_KEY = "category:conversation_court_core_block";
export const DEN_CORE_TIME_START_HOUR = 21;
export const DEN_CORE_TIME_END_HOUR = 23;
export const DEN_CORE_TIME_SKIP_DAYS = new Set([1, 4]);

type RestrictionInactiveReason =
  | "outside_core_time"
  | "category_unset"
  | "category_missing"
  | "category_not_category"
  | "category_guild_mismatch";

export type ConversationCourtRestrictionState =
  | { active: true; categoryId: string }
  | { active: false; reason: RestrictionInactiveReason; categoryId?: string };

const invalidCategoryLogKeys = new Set<string>();

export function isDenCoreTimeActive(date = new Date()): boolean {
  const now = jstNow(date);
  return !DEN_CORE_TIME_SKIP_DAYS.has(jstDayOfWeek(date)) && now.hour >= DEN_CORE_TIME_START_HOUR && now.hour < DEN_CORE_TIME_END_HOUR;
}

function logInvalidCategory(
  services: Services,
  guildId: string,
  categoryId: string | undefined,
  reason: Exclude<RestrictionInactiveReason, "outside_core_time" | "category_unset">,
): void {
  const key = `${guildId}:${categoryId ?? "unset"}:${reason}`;
  if (invalidCategoryLogKeys.has(key)) return;
  invalidCategoryLogKeys.add(key);
  services.events.log("conversation_court_restriction_invalid_category", {
    actor: "system:conversation-court",
    payload: { guildId, categoryId, reason },
  });
  console.warn("[conversation-court] invalid restriction category", { guildId, categoryId, reason });
}

export async function conversationCourtRestrictionState(
  guild: Guild,
  services: Services,
  date = new Date(),
): Promise<ConversationCourtRestrictionState> {
  if (!isDenCoreTimeActive(date)) return { active: false, reason: "outside_core_time" };
  const categoryId = services.settings.getString(CONVERSATION_COURT_CATEGORY_SETTING_KEY);
  if (!categoryId) return { active: false, reason: "category_unset" };

  const channel = await guild.channels.fetch(categoryId).catch(() => null);
  if (!channel) {
    logInvalidCategory(services, guild.id, categoryId, "category_missing");
    return { active: false, reason: "category_missing", categoryId };
  }
  if (channel.type !== ChannelType.GuildCategory) {
    logInvalidCategory(services, guild.id, categoryId, "category_not_category");
    return { active: false, reason: "category_not_category", categoryId };
  }
  if (channel.guildId !== guild.id) {
    logInvalidCategory(services, guild.id, categoryId, "category_guild_mismatch");
    return { active: false, reason: "category_guild_mismatch", categoryId };
  }
  return { active: true, categoryId };
}

function isRestrictedVoiceChannel(channel: GuildBasedChannel | VoiceBasedChannel | null | undefined, categoryId: string): boolean {
  return channel?.type === ChannelType.GuildVoice && channel.parentId === categoryId;
}

async function disconnectIfRestricted(member: GuildMember, services: Services, source: string): Promise<boolean> {
  if (member.user.bot || isAdminMember(member, services)) return false;
  await member.voice.disconnect(`conversation court restricted during all-rank den core time (${source})`);
  services.events.log("conversation_court_restriction_disconnect", {
    actor: "system:conversation-court",
    target: member.id,
    payload: { source },
  });
  return true;
}

export async function enforceConversationCourtRestrictionForGuild(
  guild: Guild,
  services: Services,
  date = new Date(),
  source = "manual",
): Promise<{ active: boolean; disconnected: number; reason?: RestrictionInactiveReason }> {
  const state = await conversationCourtRestrictionState(guild, services, date);
  if (!state.active) return { active: false, disconnected: 0, reason: state.reason };

  await guild.channels.fetch().catch(() => null);
  let disconnected = 0;
  for (const channel of guild.channels.cache.values()) {
    if (!isRestrictedVoiceChannel(channel, state.categoryId)) continue;
    const voice = channel as VoiceBasedChannel;
    for (const member of voice.members.values()) {
      try {
        if (await disconnectIfRestricted(member, services, source)) disconnected += 1;
      } catch (error) {
        console.error("[conversation-court] failed to disconnect member", {
          guildId: guild.id,
          channelId: voice.id,
          memberId: member.id,
          error,
        });
      }
    }
  }
  return { active: true, disconnected };
}

export async function enforceConversationCourtRestrictionForClient(
  client: Client,
  services: Services,
  date = new Date(),
  source = "scheduler",
): Promise<number> {
  let disconnected = 0;
  for (const guild of client.guilds.cache.values()) {
    disconnected += (await enforceConversationCourtRestrictionForGuild(guild, services, date, source)).disconnected;
  }
  return disconnected;
}

export async function handleConversationCourtVoiceUpdate(
  oldState: VoiceState,
  newState: VoiceState,
  services: Services,
  date = new Date(),
): Promise<boolean> {
  if (oldState.channelId === newState.channelId) return false;
  if (!newState.channelId || !newState.member || newState.member.user.bot) return false;

  const state = await conversationCourtRestrictionState(newState.guild, services, date);
  if (!state.active) return false;

  const channel = newState.channel ?? ((await newState.guild.channels.fetch(newState.channelId).catch(() => null)) as GuildBasedChannel | null);
  if (!isRestrictedVoiceChannel(channel, state.categoryId)) return false;

  return disconnectIfRestricted(newState.member, services, "voice_state_update");
}
