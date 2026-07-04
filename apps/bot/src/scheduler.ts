import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client, type TextChannel } from "discord.js";
import { TREASURY } from "@meigokujo/core";
import { createAndPostDraft } from "./payday.js";
import { threadTitleFor } from "./commands/evaluation.js";
import { checkBumpCooldowns } from "./bump.js";
import { scanRooms } from "./rooms-lifecycle.js";
import { fmtLd } from "./format.js";
import type { Services } from "./services.js";

/** JSTの現在時刻の分解値。VPSのTZに依存しないよう明示的に変換する */
export function jstNow(date = new Date()): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  period: string;
  dateStr: string; // 'YYYY-MM-DD'
} {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const year = get("year");
  const month = get("month");
  const day = get("day");
  return {
    year,
    month,
    day,
    hour: get("hour") % 24,
    minute: get("minute"),
    period: `${year}-${String(month).padStart(2, "0")}`,
    dateStr: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

/**
 * 刻時盤（Scheduler）: 時間駆動タスクの土台。毎分tickし、各タスクは
 * settings のマーカーで「実行済みか」を自分で判定する（再起動しても二重実行しない）。
 */
export function startScheduler(client: Client, services: Services, intervalMs = 60_000): NodeJS.Timeout {
  async function tick(): Promise<void> {
    const now = jstNow();

    // ── 説明会の1時間前リマインド（毎日 20/21/22 時 = 21/22/23 時の各会の1時間前）──
    if ([20, 21, 22].includes(now.hour) && now.minute < 2) {
      const slot = `${now.dateStr} ${now.hour + 1}`;
      const marker = `entry:reminded:${slot}`;
      if (!services.settings.getString(marker)) {
        services.settings.set(marker, "1", "system:scheduler");
        const bookings = services.entry.listBySlot(slot).filter((b) => b.status === "booked");
        const guideId = services.settings.getString("channel:entry_guide");
        if (bookings.length > 0 && guideId) {
          const channel = await client.channels.fetch(guideId).catch(() => null);
          if (channel?.isTextBased() && "send" in channel) {
            await channel.send(
              `⏰ ${bookings.map((b) => `<@${b.user_id}>`).join(" ")} 説明会は **1時間後（${now.hour + 1}時）** です。時間になったら説明会場VCへどうぞ。`,
            );
          }
        }
      }
    }

    // ── 24時間無応答チケットのリマインド（毎時0分にチェック）──
    if (now.minute < 2) {
      const stale = services.tickets.staleOpen(24);
      if (stale.length > 0) {
        const kessaiId = services.settings.getString("channel:kessai");
        const staffRoleId = services.settings.getString("role:ticket_staff");
        const channel = kessaiId ? await client.channels.fetch(kessaiId).catch(() => null) : null;
        if (channel?.isTextBased() && "send" in channel) {
          await channel.send(
            [
              `📮 ${staffRoleId ? `<@&${staffRoleId}> ` : ""}**24時間以上応答のないチケットが ${stale.length} 件あります**:`,
              ...stale.map((t) => `・<#${t.thread_id}>（${t.kind === "return" ? "出戻り" : "相談"}）`),
            ].join("\n"),
          );
          for (const t of stale) services.tickets.markReminded(t.thread_id);
        }
      }
    }

    // ── 部屋のライフサイクル（在室スキャン・削除・期限・募集失効）──
    await scanRooms(client, services);

    // ── bump/up クールタイム終了通知 ──
    await checkBumpCooldowns(client, services);

    // ── VC浮上報酬: 毎日 05:00 台に前日分を支給 ──
    if (now.hour === 5) {
      const yesterday = jstNow(new Date(Date.now() - 86_400_000)).dateStr;
      const marker = `vc_reward:paid:${yesterday}`;
      if (!services.settings.getString(marker)) {
        services.settings.set(marker, "1", "system:scheduler");
        await payVcRewards(client, services, yesterday);
      }
    }

    // ── カロン: 毎日 09:00 台に期限リスト・演出通知・迷霊落ち承認パネル ──
    if (now.hour === 9 && !services.settings.getString(`charon:daily:${now.dateStr}`)) {
      services.settings.set(`charon:daily:${now.dateStr}`, "1", "system:scheduler");
      await runCharonDaily(client, services);
    }

    // ── 給与の自動ドラフト: 毎月1日 09:00 JST 以降、その月にまだ投稿していなければ ──
    const marker = `payroll:draft_posted:${now.period}`;
    if (now.day === 1 && now.hour >= 9 && !services.settings.getString(marker)) {
      const result = await createAndPostDraft(client, services, now.period, "system:scheduler");
      if (result.ok) {
        services.settings.set(marker, "1", "system:scheduler");
        console.log(`[刻時盤] ${now.period} の給与支給案を #決裁 に投稿しました (#${result.runId})`);
      } else {
        // 設定不足（#決裁未設定・給与表が空など）の間は毎分再試行せず、1時間に1回だけ警告
        const warnMarker = `payroll:draft_warned:${now.period}:${now.hour}`;
        if (!services.settings.getString(warnMarker)) {
          services.settings.set(warnMarker, "1", "system:scheduler");
          console.warn(`[刻時盤] 給与ドラフト投稿を保留: ${result.message}`);
        }
      }
    }
  }

  return setInterval(() => void tick().catch((e) => console.error("[刻時盤] tick失敗:", e)), intervalMs);
}

/** VC浮上報酬の日次支給: 前日分を計算して1人1取引で発行し、本人にDMで通知 */
export async function payVcRewards(client: Client, services: Services, dateStr: string): Promise<void> {
  const rewards = services.vcRewards.computeDay(dateStr);
  if (rewards.length === 0) return;

  let total = 0;
  for (const r of rewards) {
    const accountId = `user:${r.userId}`;
    services.ledger.ensureAccount(accountId, "user");
    const seconds = r.normalSeconds + r.sleepSeconds;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const result = services.ledger.transfer({
      from: TREASURY,
      to: accountId,
      amount: r.amount,
      type: "vc_reward",
      actor: "system:scheduler",
      reason: `${dateStr} の浮上 ${h}時間${m}分`,
      idempotencyKey: `vc_reward:${dateStr}:user:${r.userId}`,
    });
    if (result.duplicate) continue;
    total += r.amount;
    const user = await client.users.fetch(r.userId).catch(() => null);
    await user
      ?.send(`🌙 昨夜の浮上 **${h}時間${m}分** → **+${fmtLd(r.amount)}**。今宵も評価対象の場で会おう。`)
      .catch(() => undefined);
  }

  const keikibanId = services.settings.getString("channel:keikiban");
  if (keikibanId && total > 0) {
    const channel = await client.channels.fetch(keikibanId).catch(() => null);
    if (channel?.isTextBased() && "send" in channel) {
      await channel.send(`🌙 浮上報酬（${dateStr}分）: **${rewards.length}名 / 計 ${fmtLd(total)}** を支給しました。`);
    }
  }
  console.log(`[刻時盤] 浮上報酬 ${dateStr}: ${rewards.length}名 / ${total} Ld`);
}

/** カロンの日次業務: 期限リスト（計器盤）・本人への演出通知・期限切れの承認パネル（#決裁）・スレ題名の同期 */
export async function runCharonDaily(client: Client, services: Services): Promise<void> {
  const nowTs = Math.floor(Date.now() / 1000);
  const DAY = 86_400;

  const fetchText = async (settingKey: string): Promise<TextChannel | null> => {
    const id = services.settings.getString(settingKey);
    if (!id) return null;
    const ch = await client.channels.fetch(id).catch(() => null);
    return ch?.isTextBased() && "send" in ch ? (ch as TextChannel) : null;
  };

  // ① 期限が近い者のリスト → #城の計器盤
  const dueSoon = services.evaluation.dueBetween(nowTs, nowTs + 2 * DAY);
  const keikiban = await fetchText("channel:keikiban");
  if (keikiban && dueSoon.length > 0) {
    const lines = dueSoon.map((r) => {
      const p = services.evaluation.promotionScore(r.user_id);
      const d = services.evaluation.demotionCount(r.user_id);
      return `・<@${r.user_id}> 期限 <t:${r.eval_deadline_at}:R> — 昇格印 ${p.total}/5・低評価印 ${d}/4・評価 ${services.evaluation.evaluationCount(r.user_id)}件`;
    });
    await keikiban.send({
      content: `🛶 **カロンの帳簿** — 審判が近い魂:\n${lines.join("\n")}`,
      allowedMentions: { parse: [] },
    });
  }

  // ② 本人への演出通知（3日前・前日・当日、各1回）
  const upcoming = services.evaluation.dueBetween(nowTs, nowTs + 4 * DAY);
  for (const r of upcoming) {
    const daysLeft = Math.floor((r.eval_deadline_at - nowTs) / DAY);
    if (![3, 1, 0].includes(daysLeft)) continue;
    const marker = `charon:notified:${r.user_id}:${daysLeft}`;
    if (services.settings.getString(marker)) continue;
    services.settings.set(marker, "1", "system:charon");
    const user = await client.users.fetch(r.user_id).catch(() => null);
    await user
      ?.send(
        daysLeft === 0
          ? "🛶 **汝の審判は今日である。** 冥獄の魂たちは汝の姿を見ているか。"
          : `🛶 **汝の審判まで、あと${daysLeft}日。** 評価対象の場に姿を見せよ。`,
      )
      .catch(() => undefined);
  }

  // ③ 期限切れ（昇格印不足）→ #決裁 に承認パネル
  const overdue = services.evaluation.overdue(nowTs);
  const kessai = await fetchText("channel:kessai");
  if (kessai && overdue.length > 0) {
    const lines = overdue.slice(0, 20).map((r) => {
      const p = services.evaluation.promotionScore(r.user_id);
      return `・<@${r.user_id}>（昇格印 ${p.total}/5・期限 <t:${r.eval_deadline_at}:D>）`;
    });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("charon:drop").setLabel(`${overdue.length}名を迷霊に落とす`).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("charon:cancel").setLabel("今日は見送る").setStyle(ButtonStyle.Secondary),
    );
    await kessai.send({
      content: `⚖️ **カロンの上申** — 評価期限が到達し昇格印が不足している魂 **${overdue.length}名**:\n${lines.join("\n")}`,
      components: [row],
      allowedMentions: { parse: [] },
    });
  }

  // ④ 評価スレッドの題名を実際の期限に同期（招待延長でズレた分の自己修復）
  const guildId = services.settings.getString("guild:main");
  const guild = guildId ? await client.guilds.fetch(guildId).catch(() => null) : null;
  if (guild) {
    for (const r of [...dueSoon, ...upcoming]) {
      const threadId = services.evaluation.threadFor(r.user_id);
      if (!threadId) continue;
      const thread = await client.channels.fetch(threadId).catch(() => null);
      if (!thread?.isThread()) continue;
      const member = await guild.members.fetch(r.user_id).catch(() => null);
      const expected = threadTitleFor(member?.displayName ?? r.user_id, r.eval_deadline_at);
      if (thread.name !== expected) await thread.setName(expected).catch(() => undefined);
    }
  }
}
