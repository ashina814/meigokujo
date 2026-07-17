import { once } from "node:events";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
} from "discord.js";
import { openDb } from "@meigokujo/core";
import { config } from "./config.js";

type JsonValue = unknown;

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return TRUE_VALUES.has(value.trim().toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function timestampForPath(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  return value;
}

function plain(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value, jsonReplacer)) as JsonValue;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

class JsonlWriter {
  private readonly stream;
  private closed = false;

  constructor(path: string) {
    this.stream = createWriteStream(path, { encoding: "utf8" });
  }

  async write(value: JsonValue): Promise<void> {
    if (this.closed) throw new Error("writer is already closed");
    const line = `${JSON.stringify(value, jsonReplacer)}\n`;
    if (!this.stream.write(line)) await once(this.stream, "drain");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stream.end();
    await once(this.stream, "finish");
  }
}

const startedAt = new Date();
const outputRoot = resolve(process.env.SCAN_OUTPUT_DIR ?? "./data/scans");
const outputDir = join(outputRoot, timestampForPath(startedAt));
mkdirSync(outputDir, { recursive: true });
mkdirSync(join(outputDir, "db"), { recursive: true });

const writers = new Map<string, JsonlWriter>();
const counts: Record<string, number> = {};
const omissions: Array<{ scope: string; targetId?: string; reason: string }> = [];

function writer(name: string): JsonlWriter {
  const existing = writers.get(name);
  if (existing) return existing;
  const created = new JsonlWriter(join(outputDir, name));
  writers.set(name, created);
  return created;
}

function addCount(key: string, amount = 1): void {
  counts[key] = (counts[key] ?? 0) + amount;
}

async function recordError(scope: string, targetId: string | undefined, error: unknown): Promise<void> {
  const reason = errorMessage(error);
  omissions.push({ scope, targetId, reason });
  await writer("errors.jsonl").write({
    scope,
    target_id: targetId ?? null,
    reason,
    recorded_at: Date.now(),
  });
  addCount("errors");
}

function serializeRole(role: any): JsonValue {
  return {
    id: role.id,
    name: role.name,
    position: role.position,
    raw_position: role.rawPosition,
    color: role.color,
    colors: plain(role.colors),
    hoist: role.hoist,
    managed: role.managed,
    mentionable: role.mentionable,
    permissions: role.permissions.bitfield.toString(),
    tags: plain(role.tags),
    icon: role.icon,
    unicode_emoji: role.unicodeEmoji,
    created_at: role.createdAt?.toISOString?.() ?? null,
  };
}

function serializeOverwrite(overwrite: any): JsonValue {
  return {
    id: overwrite.id,
    type: overwrite.type,
    allow: overwrite.allow.bitfield.toString(),
    deny: overwrite.deny.bitfield.toString(),
  };
}

function serializeChannel(channel: any): JsonValue {
  return {
    id: channel.id,
    name: channel.name ?? null,
    type: channel.type,
    type_name: ChannelType[channel.type] ?? String(channel.type),
    parent_id: channel.parentId ?? null,
    position: channel.position ?? null,
    raw_position: channel.rawPosition ?? null,
    topic: channel.topic ?? null,
    nsfw: channel.nsfw ?? null,
    rate_limit_per_user: channel.rateLimitPerUser ?? null,
    default_thread_rate_limit_per_user: channel.defaultThreadRateLimitPerUser ?? null,
    default_auto_archive_duration: channel.defaultAutoArchiveDuration ?? null,
    bitrate: channel.bitrate ?? null,
    user_limit: channel.userLimit ?? null,
    rtc_region: channel.rtcRegion ?? null,
    video_quality_mode: channel.videoQualityMode ?? null,
    available_tags: plain(channel.availableTags ?? []),
    default_reaction_emoji: plain(channel.defaultReactionEmoji ?? null),
    permission_overwrites: channel.permissionOverwrites?.cache
      ? [...channel.permissionOverwrites.cache.values()].map(serializeOverwrite)
      : [],
    flags: channel.flags?.bitfield?.toString?.() ?? null,
    created_at: channel.createdAt?.toISOString?.() ?? null,
  };
}

function serializeThread(thread: any): JsonValue {
  return {
    ...serializeChannel(thread),
    parent_id: thread.parentId ?? null,
    owner_id: thread.ownerId ?? null,
    archived: thread.archived ?? null,
    locked: thread.locked ?? null,
    invitable: thread.invitable ?? null,
    archive_timestamp: thread.archiveTimestamp?.toISOString?.() ?? null,
    auto_archive_duration: thread.autoArchiveDuration ?? null,
    member_count: thread.memberCount ?? null,
    message_count: thread.messageCount ?? null,
    total_message_sent: thread.totalMessageSent ?? null,
    applied_tags: thread.appliedTags ?? [],
  };
}

function serializeMember(member: any): JsonValue {
  return {
    id: member.id,
    username: member.user.username,
    global_name: member.user.globalName ?? null,
    display_name: member.displayName,
    nickname: member.nickname ?? null,
    bot: member.user.bot,
    system: member.user.system ?? false,
    discriminator: member.user.discriminator,
    avatar: member.user.avatar,
    guild_avatar: member.avatar,
    banner: member.user.banner ?? null,
    accent_color: member.user.accentColor ?? null,
    flags: member.user.flags?.bitfield?.toString?.() ?? null,
    joined_at: member.joinedAt?.toISOString?.() ?? null,
    premium_since: member.premiumSince?.toISOString?.() ?? null,
    pending: member.pending,
    communication_disabled_until: member.communicationDisabledUntil?.toISOString?.() ?? null,
    roles: [...member.roles.cache.keys()],
    created_at: member.user.createdAt?.toISOString?.() ?? null,
  };
}

function serializeMessage(message: any): JsonValue {
  return {
    id: message.id,
    guild_id: message.guildId,
    channel_id: message.channelId,
    thread_parent_id: message.channel?.isThread?.() ? message.channel.parentId : null,
    author: {
      id: message.author.id,
      username: message.author.username,
      global_name: message.author.globalName ?? null,
      bot: message.author.bot,
      system: message.author.system ?? false,
    },
    member_display_name: message.member?.displayName ?? null,
    content: message.content,
    clean_content: message.cleanContent,
    created_at: message.createdAt?.toISOString?.() ?? null,
    edited_at: message.editedAt?.toISOString?.() ?? null,
    type: message.type,
    flags: message.flags?.bitfield?.toString?.() ?? null,
    pinned: message.pinned,
    tts: message.tts,
    nonce: message.nonce ?? null,
    reference: plain(message.reference ?? null),
    attachments: [...message.attachments.values()].map((attachment: any) => ({
      id: attachment.id,
      name: attachment.name,
      description: attachment.description ?? null,
      content_type: attachment.contentType ?? null,
      size: attachment.size,
      url: attachment.url,
      proxy_url: attachment.proxyURL,
      width: attachment.width ?? null,
      height: attachment.height ?? null,
      duration: attachment.duration ?? null,
      waveform: attachment.waveform ?? null,
      flags: attachment.flags?.bitfield?.toString?.() ?? null,
    })),
    embeds: message.embeds.map((embed: any) => embed.toJSON()),
    components: message.components.map((component: any) => component.toJSON()),
    stickers: [...message.stickers.values()].map((sticker: any) => plain(sticker)),
    reactions: [...message.reactions.cache.values()].map((reaction: any) => ({
      emoji: reaction.emoji.toString(),
      emoji_id: reaction.emoji.id,
      emoji_name: reaction.emoji.name,
      count: reaction.count,
      count_details: plain(reaction.countDetails ?? null),
      me: reaction.me,
    })),
    mentions: {
      everyone: message.mentions.everyone,
      users: [...message.mentions.users.keys()],
      roles: [...message.mentions.roles.keys()],
      channels: [...message.mentions.channels.keys()],
      replied_user_id: message.mentions.repliedUser?.id ?? null,
    },
    poll: plain(message.poll?.toJSON?.() ?? message.poll ?? null),
    interaction_metadata: plain(message.interactionMetadata ?? null),
    webhook_id: message.webhookId ?? null,
    application_id: message.applicationId ?? null,
  };
}

async function fetchAllArchivedThreads(parent: any, type: "public" | "private", threadMap: Map<string, any>): Promise<void> {
  let before: string | undefined;
  while (true) {
    const result = await parent.threads.fetchArchived({ type, limit: 100, before });
    if (result.threads.size === 0) break;
    for (const thread of result.threads.values()) threadMap.set(thread.id, thread);
    if (!result.hasMore) break;
    const oldest = result.threads.last();
    if (!oldest || oldest.id === before) break;
    before = oldest.id;
  }
}

async function scanMessages(channel: any, perChannelLimit: number): Promise<void> {
  if (!("messages" in channel) || !channel.messages?.fetch) return;

  const me = channel.guild?.members?.me;
  if (me && channel.permissionsFor) {
    const permissions = channel.permissionsFor(me);
    if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions.has(PermissionFlagsBits.ReadMessageHistory)) {
      omissions.push({ scope: "messages", targetId: channel.id, reason: "missing ViewChannel or ReadMessageHistory" });
      addCount("message_channels_skipped");
      return;
    }
  }

  let before: string | undefined;
  let scanned = 0;
  while (true) {
    const remaining = perChannelLimit === 0 ? 100 : Math.min(100, perChannelLimit - scanned);
    if (remaining <= 0) break;
    const batch = await channel.messages.fetch({ limit: remaining, before, cache: false });
    if (batch.size === 0) break;

    for (const message of batch.values()) {
      await writer("messages.jsonl").write(serializeMessage(message));
      addCount("messages");
      scanned += 1;
      if (perChannelLimit > 0 && scanned >= perChannelLimit) break;
    }

    const oldest = batch.last();
    if (!oldest || oldest.id === before || (perChannelLimit > 0 && scanned >= perChannelLimit)) break;
    before = oldest.id;
  }

  await writer("message-channel-summary.jsonl").write({
    channel_id: channel.id,
    channel_name: channel.name ?? null,
    scanned_messages: scanned,
    limit: perChannelLimit,
  });
  addCount("message_channels_scanned");
}

async function scanAuditLog(guild: any, maxEntries: number): Promise<void> {
  let before: string | undefined;
  let scanned = 0;
  while (true) {
    const remaining = maxEntries === 0 ? 100 : Math.min(100, maxEntries - scanned);
    if (remaining <= 0) break;
    const logs = await guild.fetchAuditLogs({ limit: remaining, before });
    if (logs.entries.size === 0) break;

    for (const entry of logs.entries.values()) {
      await writer("audit-log.jsonl").write({
        id: entry.id,
        action: entry.action,
        action_type: entry.actionType,
        executor_id: entry.executorId ?? null,
        target_id: entry.targetId ?? null,
        target_type: entry.target?.constructor?.name ?? null,
        reason: entry.reason ?? null,
        changes: plain(entry.changes),
        extra: plain(entry.extra),
        created_at: entry.createdAt?.toISOString?.() ?? null,
      });
      addCount("audit_log_entries");
      scanned += 1;
      if (maxEntries > 0 && scanned >= maxEntries) break;
    }

    const oldest = logs.entries.last();
    if (!oldest || oldest.id === before || (maxEntries > 0 && scanned >= maxEntries)) break;
    before = oldest.id;
  }
}

async function dumpOperationalDb(): Promise<void> {
  const db = openDb(config.dbPath);
  try {
    const tables = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string; sql: string | null }>;

    writeFileSync(join(outputDir, "db-schema.json"), JSON.stringify(tables, null, 2), "utf8");
    counts.db_tables = tables.length;

    for (const table of tables) {
      const safeName = table.name.replaceAll('"', '""');
      const tableWriter = new JsonlWriter(join(outputDir, "db", `${table.name}.jsonl`));
      let rows = 0;
      for (const row of db.prepare(`SELECT * FROM "${safeName}"`).iterate()) {
        await tableWriter.write(plain(row));
        rows += 1;
      }
      await tableWriter.close();
      counts[`db:${table.name}`] = rows;
    }
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const messageLimit = envInt("SCAN_MESSAGE_LIMIT_PER_CHANNEL", 0);
  const auditLimit = envInt("SCAN_AUDIT_LOG_LIMIT", 0);
  const includeMessages = envBool("SCAN_INCLUDE_MESSAGES", true);
  const includeAuditLog = envBool("SCAN_INCLUDE_AUDIT_LOG", true);
  const includeDatabase = envBool("SCAN_INCLUDE_DATABASE", true);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildInvites,
    ],
  });

  const ready = once(client, Events.ClientReady);
  await client.login(config.token);
  await ready;

  try {
    const configuredGuildId = process.env.SCAN_GUILD_ID ?? process.env.GUILD_ID;
    const guild = configuredGuildId
      ? await client.guilds.fetch(configuredGuildId)
      : client.guilds.cache.size === 1
        ? client.guilds.cache.first()!
        : null;

    if (!guild) {
      throw new Error("SCAN_GUILD_ID または GUILD_ID を設定してください（Botが複数サーバーに参加しています）");
    }

    const fullGuild = await guild.fetch();
    await writer("guild.jsonl").write({
      id: fullGuild.id,
      name: fullGuild.name,
      description: fullGuild.description,
      owner_id: fullGuild.ownerId,
      member_count: fullGuild.memberCount,
      verification_level: fullGuild.verificationLevel,
      explicit_content_filter: fullGuild.explicitContentFilter,
      default_message_notifications: fullGuild.defaultMessageNotifications,
      mfa_level: fullGuild.mfaLevel,
      nsfw_level: fullGuild.nsfwLevel,
      premium_tier: fullGuild.premiumTier,
      premium_subscription_count: fullGuild.premiumSubscriptionCount,
      preferred_locale: fullGuild.preferredLocale,
      features: fullGuild.features,
      icon: fullGuild.icon,
      banner: fullGuild.banner,
      splash: fullGuild.splash,
      discovery_splash: fullGuild.discoverySplash,
      vanity_url_code: fullGuild.vanityURLCode,
      rules_channel_id: fullGuild.rulesChannelId,
      public_updates_channel_id: fullGuild.publicUpdatesChannelId,
      safety_alerts_channel_id: fullGuild.safetyAlertsChannelId,
      system_channel_id: fullGuild.systemChannelId,
      afk_channel_id: fullGuild.afkChannelId,
      afk_timeout: fullGuild.afkTimeout,
      created_at: fullGuild.createdAt.toISOString(),
    });
    counts.guilds = 1;

    const roles = await fullGuild.roles.fetch();
    for (const role of roles.values()) {
      await writer("roles.jsonl").write(serializeRole(role));
      addCount("roles");
    }

    let members = fullGuild.members.cache;
    try {
      members = await fullGuild.members.fetch();
    } catch (error) {
      await recordError("members.fetch", fullGuild.id, error);
    }
    for (const member of members.values()) {
      await writer("members.jsonl").write(serializeMember(member));
      addCount("members");
    }

    const channelMap = new Map<string, any>();
    const channels = await fullGuild.channels.fetch();
    for (const channel of channels.values()) {
      if (!channel) continue;
      channelMap.set(channel.id, channel);
      await writer("channels.jsonl").write(serializeChannel(channel));
      addCount("channels");
    }

    const threadMap = new Map<string, any>();
    try {
      const active = await fullGuild.channels.fetchActiveThreads();
      for (const thread of active.threads.values()) threadMap.set(thread.id, thread);
    } catch (error) {
      await recordError("threads.active", fullGuild.id, error);
    }

    for (const channel of channelMap.values()) {
      if (![ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia].includes(channel.type)) {
        continue;
      }
      if (!("threads" in channel)) continue;
      try {
        await fetchAllArchivedThreads(channel, "public", threadMap);
      } catch (error) {
        await recordError("threads.archived.public", channel.id, error);
      }
      try {
        await fetchAllArchivedThreads(channel, "private", threadMap);
      } catch (error) {
        await recordError("threads.archived.private", channel.id, error);
      }
    }

    for (const thread of threadMap.values()) {
      channelMap.set(thread.id, thread);
      await writer("threads.jsonl").write(serializeThread(thread));
      addCount("threads");
    }

    const emojis = await fullGuild.emojis.fetch();
    for (const emoji of emojis.values()) {
      await writer("emojis.jsonl").write({
        id: emoji.id,
        name: emoji.name,
        animated: emoji.animated,
        available: emoji.available,
        managed: emoji.managed,
        requires_colons: emoji.requiresColons,
        roles: [...emoji.roles.cache.keys()],
        author_id: emoji.author?.id ?? null,
        created_at: emoji.createdAt?.toISOString?.() ?? null,
      });
      addCount("emojis");
    }

    try {
      const stickers = await fullGuild.stickers.fetch();
      for (const sticker of stickers.values()) {
        await writer("stickers.jsonl").write(plain(sticker));
        addCount("stickers");
      }
    } catch (error) {
      await recordError("stickers.fetch", fullGuild.id, error);
    }

    try {
      const scheduledEvents = await fullGuild.scheduledEvents.fetch();
      for (const event of scheduledEvents.values()) {
        await writer("scheduled-events.jsonl").write(plain(event));
        addCount("scheduled_events");
      }
    } catch (error) {
      await recordError("scheduledEvents.fetch", fullGuild.id, error);
    }

    try {
      const invites = await fullGuild.invites.fetch();
      for (const invite of invites.values()) {
        await writer("invites.jsonl").write({
          code: invite.code,
          channel_id: invite.channelId,
          inviter_id: invite.inviterId,
          target_user_id: invite.targetUser?.id ?? null,
          target_application_id: invite.targetApplication?.id ?? null,
          uses: invite.uses,
          max_uses: invite.maxUses,
          max_age: invite.maxAge,
          temporary: invite.temporary,
          created_at: invite.createdAt?.toISOString?.() ?? null,
          expires_at: invite.expiresAt?.toISOString?.() ?? null,
        });
        addCount("invites");
      }
    } catch (error) {
      await recordError("invites.fetch", fullGuild.id, error);
    }

    try {
      const bans = await fullGuild.bans.fetch();
      for (const ban of bans.values()) {
        await writer("bans.jsonl").write({
          user_id: ban.user.id,
          username: ban.user.username,
          global_name: ban.user.globalName ?? null,
          bot: ban.user.bot,
          reason: ban.reason ?? null,
        });
        addCount("bans");
      }
    } catch (error) {
      await recordError("bans.fetch", fullGuild.id, error);
    }

    try {
      const rules = await fullGuild.autoModerationRules.fetch();
      for (const rule of rules.values()) {
        await writer("automod-rules.jsonl").write(plain(rule));
        addCount("automod_rules");
      }
    } catch (error) {
      await recordError("automod.fetch", fullGuild.id, error);
    }

    try {
      const integrations = await fullGuild.fetchIntegrations();
      for (const integration of integrations.values()) {
        await writer("integrations.jsonl").write(plain(integration));
        addCount("integrations");
      }
    } catch (error) {
      await recordError("integrations.fetch", fullGuild.id, error);
    }

    if (includeAuditLog) {
      try {
        await scanAuditLog(fullGuild, auditLimit);
      } catch (error) {
        await recordError("auditLog.fetch", fullGuild.id, error);
      }
    }

    if (includeMessages) {
      for (const channel of channelMap.values()) {
        try {
          await scanMessages(channel, messageLimit);
        } catch (error) {
          await recordError("messages.fetch", channel.id, error);
        }
      }
    }

    if (includeDatabase) {
      try {
        await dumpOperationalDb();
      } catch (error) {
        await recordError("database.dump", undefined, error);
      }
    }

    const finishedAt = new Date();
    const manifest = {
      schema_version: 1,
      guild_id: fullGuild.id,
      guild_name: fullGuild.name,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      output_dir: outputDir,
      settings: {
        include_messages: includeMessages,
        message_limit_per_channel: messageLimit,
        include_audit_log: includeAuditLog,
        audit_log_limit: auditLimit,
        include_database: includeDatabase,
      },
      counts,
      omissions,
      notes: [
        "Botが閲覧できないチャンネル、権限不足の監査ログ等は取得できません。",
        "削除済みメッセージ、DM、過去のVC音声内容はDiscord APIから取得できません。",
        "SCAN_MESSAGE_LIMIT_PER_CHANNEL=0 は取得可能な履歴を最後まで走査します。",
      ],
    };
    writeFileSync(join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    console.log(`✅ 冥獄城の全体スキャン完了: ${outputDir}`);
    console.log(JSON.stringify(counts, null, 2));
  } finally {
    client.destroy();
    for (const stream of writers.values()) await stream.close();
  }
}

main().catch(async (error) => {
  console.error("❌ 全体スキャン失敗:", error);
  try {
    await recordError("scan", undefined, error);
    for (const stream of writers.values()) await stream.close();
  } finally {
    process.exitCode = 1;
  }
});
