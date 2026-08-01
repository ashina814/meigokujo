import { EmbedBuilder, type Client, type Guild, type TextChannel } from "discord.js";
import { addJstDays, formatJstDate, jstDateStr } from "@meigokujo/core";
import type { Services } from "./services.js";

/**
 * 門番用の待ち人ボード。
 *
 * 統計画面ではなく、**門番がいま対応すべきことを見る作業キュー**として置く（設計案 11節(1)）。
 * 新規投稿は増やさず、同じメッセージを編集し続ける（計器盤と同じ方式）。
 * 表示する予定は SessionCalendar の合成結果なので、休止した枠が並ぶことはない。
 */

export const WAITERS_BOARD_CHANNEL_KEY = "channel:waiters_board";
export const WAITERS_BOARD_MESSAGE_KEY = "waiters_board:message_id";
/** 予定欄に出す日数 */
const BOARD_SCHEDULE_DAYS = 5;

export interface WaitersBoardUpdateResult {
  ok: boolean;
  action: "edited" | "created" | "skipped" | "failed" | "joined";
  messageId?: string;
  reason?: string;
}

/** Discord 側からしか分からない実況値（取れなければ null で「取得できず」と出す） */
interface LiveCounts {
  /** 説明会VCにいる案内待ちの人数。1つでも取得に失敗したら人数を確定させない */
  vcPresent: { count: number; missing: number } | null;
  flexOpen: number | null;
  flexFallback: boolean;
}

let boardUpdateInFlight: Promise<WaitersBoardUpdateResult> | null = null;

/**
 * ボードの更新。起動時・予定変更時・入城状態の変化時・10分ごとに呼ばれる。
 * 失敗しても呼び出し元の処理は止めない（ボードは補助表示なので、握り潰さずログだけ残す）。
 */
export async function updateWaitersBoard(client: Client, services: Services): Promise<WaitersBoardUpdateResult> {
  if (boardUpdateInFlight) {
    const result = await boardUpdateInFlight;
    return { ...result, action: "joined" };
  }
  boardUpdateInFlight = performUpdate(client, services);
  try {
    return await boardUpdateInFlight;
  } finally {
    boardUpdateInFlight = null;
  }
}

/** 予定変更・状態変化のついでに呼ぶ用。結果を待たず、失敗はログだけ残す */
export function refreshWaitersBoard(client: Client, services: Services): void {
  void updateWaitersBoard(client, services).catch((e) => console.error("[待ち人ボード] 更新に失敗:", e));
}

async function performUpdate(client: Client, services: Services): Promise<WaitersBoardUpdateResult> {
  const channelId = services.settings.getString(WAITERS_BOARD_CHANNEL_KEY);
  if (!channelId) {
    // 未設置は正常な状態（運営が設置するまで何もしない）
    return { ok: false, action: "skipped", reason: `${WAITERS_BOARD_CHANNEL_KEY} が未設定です` };
  }
  const channel = (await client.channels.fetch(channelId).catch(() => null)) as TextChannel | null;
  if (!channel?.isTextBased()) {
    const reason = `チャンネル ${channelId} を取得できません`;
    console.error(`[待ち人ボード] ${reason}（削除/権限不足の可能性）`);
    return { ok: false, action: "failed", reason };
  }

  const embed = buildWaitersBoardEmbed(services, await collectLiveCounts(channel.guild, services));
  const savedId = services.settings.getString(WAITERS_BOARD_MESSAGE_KEY);

  if (savedId) {
    let fetchError: unknown;
    const msg = await channel.messages.fetch(savedId).catch((e) => {
      fetchError = e;
      return null;
    });
    if (msg) {
      try {
        await msg.edit({ embeds: [embed] });
      } catch (e) {
        console.error("[待ち人ボード] 既存メッセージの更新に失敗:", e);
        return { ok: false, action: "failed", messageId: savedId, reason: "既存メッセージの編集に失敗しました" };
      }
      return { ok: true, action: "edited", messageId: savedId };
    }
    const code = typeof fetchError === "object" && fetchError && "code" in fetchError ? (fetchError as { code?: unknown }).code : undefined;
    if (fetchError && code !== 10008) {
      console.error("[待ち人ボード] 保存済みメッセージの取得に失敗:", fetchError);
      return { ok: false, action: "failed", messageId: savedId, reason: "保存済みメッセージの取得に失敗しました" };
    }
    console.warn(`[待ち人ボード] 保存済みメッセージ ${savedId} が見つかりません。新規投稿します`);
  }
  try {
    const sent = await channel.send({ embeds: [embed] });
    await sent.pin().catch(() => undefined);
    services.settings.set(WAITERS_BOARD_MESSAGE_KEY, sent.id, "system:waiters-board");
    console.log(`[待ち人ボード] 新規投稿しました: ${sent.id}`);
    return { ok: true, action: "created", messageId: sent.id };
  } catch (e) {
    console.error("[待ち人ボード] 新規投稿に失敗（送信権限を確認してください）:", e);
    return { ok: false, action: "failed", reason: "新規投稿に失敗しました" };
  }
}

export function buildWaitersBoardEmbed(services: Services, live: LiveCounts): EmbedBuilder {
  const now = new Date();
  const summary = services.entry.waitingSummary();
  const delivery = services.entry.guideDeliverySummary();
  const next = services.sessions.nextOccurrence(now);
  const nextTs = next ? Math.floor(next.at.getTime() / 1000) : null;

  return new EmbedBuilder()
    .setTitle("🚪 待ち人ボード")
    .setColor(0x6b21a8)
    .setDescription("門番がいま対応することだけを載せています。10分ごとと、予定・入城状態が変わったときに更新します。")
    .addFields(
      {
        name: "🕯️ 次の説明会",
        value: nextTs ? `<t:${nextTs}:F>\n<t:${nextTs}:R>${next?.extra ? "（臨時）" : ""}` : "予定がありません",
        inline: true,
      },
      { name: "🎧 いま説明会VC", value: renderVcPresent(live.vcPresent), inline: true },
      {
        name: "⏰ 時間外希望",
        value:
          live.flexOpen === null
            ? "取得できず"
            : live.flexFallback
              ? `**${live.flexOpen}**件（直近7日の受付）`
              : `**${live.flexOpen}**件（未クローズ）`,
        inline: true,
      },
      { name: "📣 直前の5分前通知", value: renderNotification(services, now) },
      { name: "📅 今後の予定", value: renderUpcoming(services, now) },
      {
        name: "👥 案内待ち",
        value: [
          `**${summary.waiting}**人（7日以上 **${summary.stale}**人）`,
          `直近24時間の参加 ${summary.recentJoins}人`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "📮 案内の配送（直近7日）",
        value: [`DM ${delivery.dm}件`, `代替の投稿 ${delivery.channel}件`, `**不達 ${delivery.none}件**`].join("\n"),
        inline: true,
      },
      {
        name: "🔍 招待経路の未検出",
        value: [
          `**${summary.missingInviterHint}**人`,
          "※合格を止める条件ではありません。未検出のままでも `/審判 判定` で通せます",
          "（必要なときだけ `/審判 招待` で後から補えます）",
        ].join("\n"),
      },
    )
    .setFooter({ text: `更新 ${jstStamp(now)}` });
}

function renderVcPresent(present: LiveCounts["vcPresent"]): string {
  if (present === null) return "取得できず";
  if (present.missing > 0) {
    // 取れなかったVCがある以上、0人と断定しない（人が居ないのか見えていないのか区別が付く形にする）
    return present.count > 0
      ? `**${present.count}**人＋（${present.missing}か所を取得できず）`
      : `一部取得できず（${present.missing}か所）`;
  }
  return `**${present.count}**人`;
}

/**
 * 直前の枠に5分前通知が出たか。運用の切替（手書き告知をやめてよいか）の判断材料。
 * 「送信済み」「未送信・失敗」「まだ通知時刻前」を区別できる形にする。
 */
function renderNotification(services: Services, now: Date): string {
  const lead = 5 * 60_000;
  const startDate = jstDateStr(new Date(now.getTime() - 86_400_000));
  // 昨日と今日の枠から、すでに通知時刻を過ぎたもののうち直近を見る
  const passed = services.sessions
    .occurrences({ from: new Date(new Date(`${startDate}T00:00:00Z`).getTime() - 1), days: 3 })
    .filter((o) => o.at.getTime() - lead <= now.getTime());
  const last = passed[passed.length - 1];
  const next = services.sessions.nextOccurrence(now);

  const lines: string[] = [];
  if (!last) {
    lines.push("直近に終わった枠はまだありません");
  } else {
    const state = services.sessions.notificationStatus(last.date, last.hour);
    const label = `${formatJstDate(last.date)} ${last.hour}:00`;
    if (state.status === "sent") lines.push(`✅ ${label} 送信済み（<t:${state.at}:t>）`);
    else if (state.status === "failed") lines.push(`❌ ${label} 失敗${state.error ? `（${state.error}）` : ""}`);
    else lines.push(`⚠️ ${label} 未送信（通知が出ていません）`);
  }
  if (next) {
    const notifyTs = Math.floor((next.at.getTime() - lead) / 1000);
    lines.push(
      next.at.getTime() - lead > now.getTime()
        ? `🕔 次は <t:${notifyTs}:t> に通知予定（まだ通知時刻前）`
        : `🕔 次の枠は通知時刻を過ぎています`,
    );
  }
  return lines.join("\n");
}

/** 今後の予定を1行に畳む。休止した枠は載せない（載っている＝開催する、で読めるように） */
function renderUpcoming(services: Services, from: Date): string {
  const occurrences = services.sessions.occurrences({ from, days: BOARD_SCHEDULE_DAYS });
  if (occurrences.length === 0) return "予定がありません";
  const startDate = jstDateStr(from);
  const lines: string[] = [];
  for (let offset = 0; offset < BOARD_SCHEDULE_DAYS; offset++) {
    const date = addJstDays(startDate, offset);
    const hours = occurrences.filter((o) => o.date === date);
    if (hours.length === 0) continue;
    lines.push(`\`${formatJstDate(date)}\` ${hours.map((o) => `${o.hour}:00${o.extra ? "＋" : ""}`).join(" / ")}`);
  }
  return lines.join("\n") || "予定がありません";
}

function jstStamp(date: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/**
 * Discord 側からしか取れない値を集める。
 * 取得に失敗しても数字を0と偽らず「取得できず」と出す（門番が判断を誤らないように）。
 */
async function collectLiveCounts(guild: Guild, services: Services): Promise<LiveCounts> {
  return {
    vcPresent: await countVcPresent(guild, services),
    ...(await countFlexRequests(guild, services)),
  };
}

/**
 * 説明会VCにいる案内待ちの人数。判定と違い、ここでは魂の修復はしない（表示専用）。
 * 設定済みのVCを取れなかった場合は 0 人と断定せず、取れなかった数を返して表示で断る。
 */
async function countVcPresent(
  guild: Guild,
  services: Services,
): Promise<{ count: number; missing: number } | null> {
  const vcIds = [services.settings.getString("channel:session_vc"), services.settings.getString("channel:session_vc2")].filter(
    (v): v is string => !!v,
  );
  if (vcIds.length === 0) return null;
  const waitRoleId = services.settings.getString("role:queue_wait");
  const ids = new Set<string>();
  let missing = 0;
  for (const vcId of vcIds) {
    const ch = await guild.channels.fetch(vcId).catch(() => null);
    if (!ch?.isVoiceBased()) {
      // 権限不足・削除・一時的な失敗。人数に数えず「取れなかった」として持ち上げる
      missing++;
      console.warn(`[待ち人ボード] 説明会場VC ${vcId} を取得できませんでした`);
      continue;
    }
    for (const [, member] of ch.members) {
      if (member.user.bot) continue;
      const hasWaitRole = !!(waitRoleId && member.roles.cache.has(waitRoleId));
      if (hasWaitRole || services.entry.getSoul(member.id)?.status === "waiting") ids.add(member.id);
    }
  }
  return { count: ids.size, missing };
}

/**
 * 時間外希望の件数。受付は入城案内chの非公開スレッドなので、生きているスレッド数を数える。
 * スレッドを取れないときは、記録した受付件数（直近7日）で代替する。
 */
async function countFlexRequests(
  guild: Guild,
  services: Services,
): Promise<{ flexOpen: number | null; flexFallback: boolean }> {
  const guideId = services.settings.getString("channel:entry_guide");
  const guide = guideId ? await guild.channels.fetch(guideId).catch(() => null) : null;
  if (guide?.isTextBased() && "threads" in guide) {
    const active = await guide.threads.fetchActive().catch(() => null);
    if (active) {
      const open = active.threads.filter((t) => t.name.startsWith("時間外希望-") && !t.archived).size;
      return { flexOpen: open, flexFallback: false };
    }
  }
  const since = Math.floor(Date.now() / 1000) - 7 * 86_400;
  const row = services.db
    .prepare("SELECT COUNT(*) AS c FROM events WHERE type = 'entry_flex_opened' AND created_at >= ?")
    .get(since) as { c: number } | undefined;
  return { flexOpen: row?.c ?? 0, flexFallback: true };
}
