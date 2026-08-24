import type { Client, Guild, GuildMember, PartialGuildMember } from "discord.js";
import { buildPublicDepartmentRoleFamilyManifest } from "@meigokujo/core";
import type { Services } from "./services.js";

const CHECKPOINT_MS = 30_000;
interface SnapshotRefresh {
  readonly generation: number;
  readonly promise: Promise<boolean>;
}
const refreshes = new WeakMap<Services, SnapshotRefresh>();
const generations = new WeakMap<Services, number>();
const initialized = new WeakSet<Services>();
const checkpointTimers = new WeakMap<Services, ReturnType<typeof setInterval>>();
const nowSeconds = () => Math.floor(Date.now() / 1000);

function currentGeneration(services: Services): number {
  return generations.get(services) ?? 0;
}

function invalidateInFlightObservations(services: Services): number {
  const generation = currentGeneration(services) + 1;
  generations.set(services, generation);
  return generation;
}

function mainGuildId(services: Services): string | null {
  return services.settings.getString("guild:main") ?? null;
}

function isMainGuild(guildId: string, services: Services): boolean {
  return mainGuildId(services) === guildId;
}

function snapshot(member: GuildMember) {
  return {
    userId: member.id,
    bot: member.user.bot,
    roleIds: [...member.roles.cache.keys()],
  } as const;
}

/**
 * Full member fetch completion is the only startup/resume anchor. Cache state before the await is
 * never backdated into the fetch gap.
 */
export function refreshRoleFamilyGuildSnapshot(
  guild: Guild,
  services: Services,
  now: () => number = nowSeconds,
): Promise<boolean> {
  if (!isMainGuild(guild.id, services) || guild.available === false) return Promise.resolve(false);
  const running = refreshes.get(services);
  if (running?.generation === currentGeneration(services)) return running.promise;
  // A refresh itself is an observation gap. An already-suspended session is left unchanged.
  services.roleFamilyTemporal.suspendGuild(guild.id, now(), "shutdown");
  const generation = invalidateInFlightObservations(services);
  let refresh!: SnapshotRefresh;
  const run = (async () => {
    const members = await guild.members.fetch();
    // A disconnect/unavailable/delete/manifest change that happened during the await invalidates
    // this cache result. A later lifecycle callback must perform its own fresh full fetch.
    if (currentGeneration(services) !== generation || guild.available === false || !isMainGuild(guild.id, services)) {
      return false;
    }
    const observedAt = now();
    const manifest = buildPublicDepartmentRoleFamilyManifest(services.db);
    services.roleFamilyTemporal.startObservationSession(
      guild.id,
      manifest,
      [...members.values()].map(snapshot),
      observedAt,
    );
    return true;
  })().catch((error) => {
    console.error("[role-family] full member snapshot failed", error);
    return false;
  }).finally(() => {
    if (refreshes.get(services) === refresh) refreshes.delete(services);
  });
  refresh = { generation, promise: run };
  refreshes.set(services, refresh);
  return run;
}

export async function initializeRoleFamilyTracking(
  client: Client,
  services: Services,
  now: () => number = nowSeconds,
): Promise<boolean> {
  const guildId = mainGuildId(services);
  if (!guildId) return false;
  services.roleFamilyTemporal.recoverDangling(guildId);
  if (!initialized.has(services)) {
    initialized.add(services);
    services.departments.onRoleMappingChanged(() => {
      invalidateInFlightObservations(services);
      const guild = client.guilds.cache.get(guildId);
      if (guild && guild.available !== false) void refreshRoleFamilyGuildSnapshot(guild, services, now);
    });
    const timer = setInterval(() => {
      services.roleFamilyTemporal.checkpoint(guildId, now());
    }, CHECKPOINT_MS);
    if (typeof timer.unref === "function") timer.unref();
    checkpointTimers.set(services, timer);
  }
  const guild = client.guilds.cache.get(guildId);
  if (!guild || guild.available === false) return false;
  return refreshRoleFamilyGuildSnapshot(guild, services, now);
}

export function checkpointRoleFamilyTracking(services: Services, now: () => number = nowSeconds): boolean {
  const guildId = mainGuildId(services);
  return guildId ? services.roleFamilyTemporal.checkpoint(guildId, now()) : false;
}

export function suspendRoleFamilyShard(
  client: Client,
  shardId: number,
  services: Services,
  now: () => number = nowSeconds,
): boolean {
  const guildId = mainGuildId(services);
  const guild = guildId ? client.guilds.cache.get(guildId) : undefined;
  if (!guild || guild.shardId !== shardId) return false;
  invalidateInFlightObservations(services);
  return services.roleFamilyTemporal.suspendGuild(guild.id, now(), "disconnect");
}

export function resumeRoleFamilyShard(
  client: Client,
  shardId: number,
  services: Services,
  unavailableGuilds?: ReadonlySet<string>,
  now: () => number = nowSeconds,
): Promise<boolean> {
  const guildId = mainGuildId(services);
  const guild = guildId ? client.guilds.cache.get(guildId) : undefined;
  if (!guild || guild.shardId !== shardId || guild.available === false || unavailableGuilds?.has(guild.id)) {
    return Promise.resolve(false);
  }
  return refreshRoleFamilyGuildSnapshot(guild, services, now);
}

export function suspendRoleFamilyGuild(
  guild: Guild,
  services: Services,
  quality: "guild_unavailable" | "guild_delete",
  now: () => number = nowSeconds,
): boolean {
  if (!isMainGuild(guild.id, services)) return false;
  invalidateInFlightObservations(services);
  return services.roleFamilyTemporal.suspendGuild(guild.id, now(), quality);
}

export function resumeRoleFamilyGuild(
  guild: Guild,
  services: Services,
  now: () => number = nowSeconds,
): Promise<boolean> {
  return refreshRoleFamilyGuildSnapshot(guild, services, now);
}

export function trackRoleFamilyMemberAdd(
  member: GuildMember,
  services: Services,
  now: () => number = nowSeconds,
): boolean {
  if (!isMainGuild(member.guild.id, services)) return false;
  return services.roleFamilyTemporal.observeMemberSnapshot(member.guild.id, snapshot(member), now());
}

export function trackRoleFamilyMemberRemove(
  member: GuildMember | PartialGuildMember,
  services: Services,
  now: () => number = nowSeconds,
): boolean {
  if (!isMainGuild(member.guild.id, services) || member.user?.bot) return false;
  return services.roleFamilyTemporal.removeMember(member.guild.id, member.id, now());
}

export async function trackRoleFamilyMemberUpdate(
  oldMember: GuildMember | PartialGuildMember,
  newMember: GuildMember,
  services: Services,
  now: () => number = nowSeconds,
): Promise<boolean> {
  if (!isMainGuild(newMember.guild.id, services)) return false;
  if (oldMember.partial) {
    // Past state is unknown. Close it now, then anchor only the forced fresh fetch completion.
    services.roleFamilyTemporal.markMemberUnknown(newMember.guild.id, newMember.id, now());
    const generation = currentGeneration(services);
    const current = await newMember.guild.members.fetch({ user: newMember.id, force: true }).catch(() => null);
    if (!current || generation !== currentGeneration(services) || newMember.guild.available === false) return false;
    return services.roleFamilyTemporal.observeMemberSnapshot(newMember.guild.id, snapshot(current), now());
  }
  return services.roleFamilyTemporal.observeMemberSnapshot(newMember.guild.id, snapshot(newMember), now());
}

export function resetRoleFamilyTrackingForTesting(services?: Services): void {
  if (!services) return;
  const timer = checkpointTimers.get(services);
  if (timer) clearInterval(timer);
  checkpointTimers.delete(services);
  refreshes.delete(services);
  generations.delete(services);
}
