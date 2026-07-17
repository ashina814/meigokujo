import type { AnyThreadChannel, Client, Guild } from "discord.js";
import { fmtLd } from "./format.js";
import type { Services } from "./services.js";

/**
 * 亡霊の評価スレッドの「1件目メッセージ（起点メッセージ）」を最新の実績で書き換える。
 * 別Embedを追加投稿するのではなく、既にスレッドを開いた時に見えるメッセージを更新する。
 * スレッドの起点メッセージ ID はスレッド ID と同じ（Forum の仕様）。
 */
function buildStarterContent(
  displayName: string,
  soul: { ghost_at: number | null; eval_deadline_at: number | null; eval_extension_days: number },
  presenceHours: number,
  presenceMins: number,
  presenceDays: number,
  balance: number,
  basePeriodDays: number,
): string {
  // 延長合計は期限から逆算する（招待 eval_extension_days だけでなく、
  // ショップ購入・運営手動の延長も漏れなく表示するため）
  const totalExtDays =
    soul.ghost_at && soul.eval_deadline_at
      ? Math.round((soul.eval_deadline_at - soul.ghost_at) / 86_400) - basePeriodDays
      : 0;
  const extBits: string[] = [];
  if (soul.eval_extension_days > 0) extBits.push(`招待 +${soul.eval_extension_days}日`);
  const otherExt = totalExtDays - soul.eval_extension_days;
  if (otherExt > 0) extBits.push(`購入・運営 +${otherExt}日`);
  const extLine = totalExtDays > 0 ? `**+${totalExtDays}日**（${extBits.join("・") || "内訳不明"}）` : "延長なし";
  return [
    `📄 **${displayName}** の評価スレッド`,
    `入城: ${soul.ghost_at ? `<t:${soul.ghost_at}:D>` : "—"} / 審判期限: ${soul.eval_deadline_at ? `<t:${soul.eval_deadline_at}:D>（<t:${soul.eval_deadline_at}:R>）` : "—"}`,
    `期限の延長: ${extLine}`,
    `**浮上実績（直近14日・評価対象VC）**: ${presenceHours}時間${presenceMins}分 / 出現${presenceDays}日`,
    `通算残高: ${fmtLd(balance)}`,
    `-# 実績部は毎日05:30に自動更新されます`,
  ].join("\n");
}

async function refreshOne(guild: Guild, services: Services, userId: string): Promise<boolean> {
  const soul = services.entry.getSoul(userId);
  if (!soul) return false;
  const threadId = services.evaluation.threadFor(userId);
  if (!threadId) return false;
  const thread = (await guild.client.channels.fetch(threadId).catch(() => null)) as AnyThreadChannel | null;
  if (!thread?.isThread()) return false;
  if (thread.archived) await thread.setArchived(false).catch(() => undefined);
  const member = await guild.members.fetch(userId).catch(() => null);
  const displayName = member?.displayName ?? userId;
  const presence = services.vc.presence(userId, 14);
  const hours = Math.floor(presence.totalSeconds / 3600);
  const mins = Math.floor((presence.totalSeconds % 3600) / 60);
  const balance = services.ledger.balanceOf(`user:${userId}`);
  const basePeriodDays = services.settings.getNumber("eval_base_period_days");
  const content = buildStarterContent(displayName, soul, hours, mins, presence.daysSeen, balance, basePeriodDays);

  // Forum スレッドの起点メッセージ ID はスレッド ID と同じ
  const starter = await thread.messages.fetch(threadId).catch(() => null);
  if (starter) {
    await starter.edit({ content, embeds: [] }).catch((e) => console.error(`[評価] 起点メッセージ更新失敗 ${userId}:`, e));
    return true;
  }
  // 起点が取れない場合は末尾に投稿（保険）
  await thread.send({ content }).catch(() => undefined);
  return true;
}

/** 対象1人のスレッド起点メッセージを即座に更新（スレッド作成直後・亡霊化直後などに呼ぶ） */
export async function refreshEvalStatsForUser(guild: Guild, services: Services, userId: string): Promise<void> {
  await refreshOne(guild, services, userId);
}

/** 全亡霊のスレッド起点メッセージを更新（毎日05:30のバッチ用） */
export async function refreshEvalStats(client: Client, services: Services): Promise<void> {
  const guildId = services.settings.getString("guild:main");
  const guild = guildId ? await client.guilds.fetch(guildId).catch(() => null) : null;
  if (!guild) return;
  const ghosts = services.entry.listSouls("ghost");
  for (const soul of ghosts) {
    await refreshOne(guild, services, soul.user_id);
  }
}
