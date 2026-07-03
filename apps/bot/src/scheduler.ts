import type { Client } from "discord.js";
import { createAndPostDraft } from "./payday.js";
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
