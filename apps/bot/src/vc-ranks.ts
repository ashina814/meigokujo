import type { Client } from "discord.js";
import type { Services } from "./services.js";

/**
 * 位階（VCロール）。報酬(Land)とは別軸の"功績"。
 * どのVCでも累計時間が閾値を超えると、その位階ロールを付与する。
 * 累計は減らないので降格はなし。常に「現在の位階」だけを身につける（下位ラダーは外す）。
 */
export interface RankTier {
  hours: number;
  roleId: string;
}

/** 全メンバーの累計VC時間から位階ロールを付け直す（刻時盤から毎日1回） */
export async function applyVcRanks(client: Client, services: Services): Promise<void> {
  const ladder = services.settings.getJson<RankTier[]>("vc_rank_ladder", []);
  if (ladder.length === 0) return;
  const sorted = [...ladder].sort((a, b) => a.hours - b.hours);
  const ladderRoleIds = new Set(sorted.map((t) => t.roleId));

  const guildId = services.settings.getString("guild:main") ?? client.guilds.cache.first()?.id;
  if (!guildId) return;
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;
  const members = await guild.members.fetch().catch(() => null);
  if (!members) return;

  const totals = new Map(services.vc.totalsByUser(36_500).map((t) => [t.userId, t.seconds]));

  for (const [userId, member] of members) {
    if (member.user.bot) continue;
    const hours = (totals.get(userId) ?? 0) / 3600;
    let target: string | null = null;
    for (const t of sorted) if (hours >= t.hours) target = t.roleId; // 到達した最上位

    for (const roleId of ladderRoleIds) {
      const has = member.roles.cache.has(roleId);
      if (roleId === target && !has) await member.roles.add(roleId).catch(() => undefined);
      else if (roleId !== target && has) await member.roles.remove(roleId).catch(() => undefined);
    }
  }
}
