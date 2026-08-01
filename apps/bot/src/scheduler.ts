import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client, type TextChannel } from "discord.js";
import { TREASURY, type Settings } from "@meigokujo/core";
import { createAndPostDraft } from "./payday.js";
import { threadTitleFor } from "./commands/evaluation.js";
import { checkBumpCooldowns } from "./bump.js";
import { scanRooms } from "./rooms-lifecycle.js";
import { scanDens } from "./dens.js";
import { refreshEvalStats } from "./eval-daily.js";
import { updateDashboard } from "./dashboard.js";
import { tickVoiceXp } from "./rank-tracker.js";
import { fmtLd } from "./format.js";
import { announceAutoClose, announceSettle, refreshMarketPanel } from "./commands/ita.js";
import { ticketStaffRoleIds } from "./commands/tickets.js";
import type { Services } from "./services.js";
import {
  cleanupCompletedChunkBatches,
  finalizeChunkBatch,
  pendingChunkBatch,
  runSchedulerTaskOnce,
  sendChunkedLinesResumable,
} from "./scheduler-utils.js";
import {
  chargeMonthlySubscriptionsAtomically,
  processShopRoleRevocations,
  recoverAutoDropNoEvalGhosts,
} from "./scheduler-recovery.js";

export { processShopRoleRevocations } from "./scheduler-recovery.js";

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

/** JSTでの曜日（0=日 … 6=土）。VPSのTZに依存しないよう jstNow 経由で出す */
export function jstDayOfWeek(date = new Date()): number {
  const jst = jstNow(date);
  return new Date(Date.UTC(jst.year, jst.month - 1, jst.day)).getUTCDay();
}

// ── 説明会の開催枠 ──
// 「月・木を除く 21/22/23時」は運用の取り決めであってコードの都合ではないので settings に置く。
// 既定値は現行運用そのままなので、設定していないサーバーの挙動は変わらない。
// 日単位の休止・臨時追加（`/説明会 休止・追加`）は、この枠の上に後から重ねる。

export const DEFAULT_SESSION_HOURS = [21, 22, 23];
export const DEFAULT_SESSION_SKIP_DOW = [1, 4]; // 0=日, 1=月, 4=木
export const SESSION_HOURS_KEY = "entry:session_hours";
export const SESSION_SKIP_DOW_KEY = "entry:session_skip_dow";
/** 開始の何分前に通知するか（notifyMinute = 60 - これ） */
const SESSION_NOTIFY_LEAD_MIN = 5;

export type SessionSchedule = {
  /** 開催時刻（JST・時のみ）。昇順・重複なし */
  hours: number[];
  /** 休みの曜日（0=日 … 6=土）。昇順・重複なし。空なら毎日開催 */
  skipDow: number[];
};

const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

/** 同じ誤設定で毎分警告を出さないための既出記録 */
const warnedSettingValues = new Set<string>();

function warnOnce(key: string, raw: string, message: string): void {
  const seen = `${key}=${raw}`;
  if (warnedSettingValues.has(seen)) return;
  warnedSettingValues.add(seen);
  console.warn(`[説明会] ${key} の設定値を解釈できませんでした（${raw}）: ${message}`);
}

/** 10進の整数「文字列」だけを通す。`Number()` に任せると "" や "0x10" まで拾ってしまう */
const INTEGER_TEXT = /^[+-]?\d+$/;

/**
 * 設定値のトークンを整数に変換する。**number型の整数**と**空でない10進整数文字列**だけを認め、
 * `true` / `null` / `[]` / `{}` / 小数 / 空文字などは弾く（`Number(true)===1` を通さない）。
 */
function toInteger(token: unknown): number | null {
  if (typeof token === "number") return Number.isInteger(token) ? token : null;
  if (typeof token === "string" && INTEGER_TEXT.test(token.trim())) {
    const n = Number(token.trim());
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

/**
 * 数値リスト設定の読み取り。`[21,22,23]`（JSON）でも `21,22,23`（区切り文字）でも受ける。
 * 未設定・空文字は null（＝既定値を使う）、整数として読めなかったぶんは dropped に数える。
 * `emptyArray` は **JSONの空配列 `[]` を明示的に書いた**ときだけ true（意思表示と誤設定を分けるため）。
 */
function parseNumberList(
  raw: string | undefined,
): { values: number[]; dropped: number; emptyArray: boolean } | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  if (!text) return null;
  let tokens: unknown[];
  let emptyArray = false;
  try {
    const parsed: unknown = JSON.parse(text);
    tokens = Array.isArray(parsed) ? parsed : [parsed];
    emptyArray = Array.isArray(parsed) && parsed.length === 0;
  } catch {
    tokens = text.split(/[,\s、]+/).filter((t) => t !== "");
  }
  const values: number[] = [];
  let dropped = 0;
  for (const token of tokens) {
    const n = toInteger(token);
    if (n === null) dropped++;
    else values.push(n);
  }
  return { values, dropped, emptyArray };
}

function inRangeUnique(values: number[], min: number, max: number): { kept: number[]; dropped: number } {
  const kept: number[] = [];
  let dropped = 0;
  for (const n of values) {
    if (n < min || n > max) dropped++;
    else if (!kept.includes(n)) kept.push(n);
  }
  return { kept: kept.sort((a, b) => a - b), dropped };
}

/**
 * 開催枠を settings から読む。壊れた値は既定値へ落とす（説明会が黙って消えるほうが害が大きい）。
 * 「休みなし」として空を認めるのは `entry:session_skip_dow` に **JSONの `[]` を書いたときだけ**。
 * 区切り文字だけの値（`","` など）は誤設定として扱い、既定値へ落とす。
 */
export function sessionSchedule(services: { settings: Pick<Settings, "getString"> }): SessionSchedule {
  const rawHours = services.settings.getString(SESSION_HOURS_KEY);
  const rawSkip = services.settings.getString(SESSION_SKIP_DOW_KEY);

  let hours = [...DEFAULT_SESSION_HOURS];
  const parsedHours = parseNumberList(rawHours);
  if (parsedHours) {
    const { kept, dropped } = inRangeUnique(parsedHours.values, 0, 23);
    // 開催時刻は空にできない（`[]` を書かれても定例が消えるだけなので既定値へ戻す）
    if (kept.length === 0) warnOnce(SESSION_HOURS_KEY, rawHours!, "0〜23の整数がひとつも無いため既定値を使います");
    else if (dropped + parsedHours.dropped > 0) warnOnce(SESSION_HOURS_KEY, rawHours!, "0〜23の整数以外を無視しました");
    if (kept.length > 0) hours = kept;
  }

  let skipDow = [...DEFAULT_SESSION_SKIP_DOW];
  const parsedSkip = parseNumberList(rawSkip);
  if (parsedSkip) {
    const { kept, dropped } = inRangeUnique(parsedSkip.values, 0, 6);
    const badTokens = dropped + parsedSkip.dropped;
    if (kept.length > 0) {
      if (badTokens > 0) warnOnce(SESSION_SKIP_DOW_KEY, rawSkip!, "0〜6の整数以外を無視しました");
      skipDow = kept;
    } else if (parsedSkip.emptyArray) {
      // `[]` と明示されたときだけ「休みなし」の意思表示として受ける
      skipDow = [];
    } else {
      warnOnce(SESSION_SKIP_DOW_KEY, rawSkip!, "0〜6の整数がひとつも無いため既定値を使います");
    }
  }

  return { hours, skipDow };
}

/** パネル・DMに載せる開催枠の文字列（例: 「月・木を除く 21 / 22 / 23 時」） */
export function describeSessionSchedule(schedule: SessionSchedule): string {
  if (schedule.skipDow.length >= 7 || schedule.hours.length === 0) return "現在は定例の説明会がありません";
  const hours = schedule.hours.join(" / ");
  if (schedule.skipDow.length === 0) return `毎日 ${hours} 時`;
  return `${schedule.skipDow.map((d) => DOW_LABELS[d]).join("・")}を除く ${hours} 時`;
}

export function isSessionNotificationDue(
  now: Pick<ReturnType<typeof jstNow>, "hour" | "minute">,
  sessionStartHour: number,
  notifyMinute: number,
  retryWindowMinutes = 2,
): boolean {
  // 0時開催なら前日23時台に通知する（マーカーは通知時点の日付なので重複しない）
  const notifyHour = (sessionStartHour + 23) % 24;
  return now.hour === notifyHour && now.minute >= notifyMinute && now.minute <= notifyMinute + retryWindowMinutes;
}

/**
 * 次の説明会の開始時刻。8日先まで見て無ければ null。
 * 入城案内で「次は何時か」を具体的に出すために使う（抽象的な「21/22/23時です」だけだと
 * 参加直後の人が次の機会をいつまで待つのか分からず、そのまま抜けてしまうため）。
 */
export function nextSessionStart(schedule: SessionSchedule, from = new Date()): Date | null {
  const jst = jstNow(from);
  for (let offset = 0; offset < 8; offset++) {
    const base = Date.UTC(jst.year, jst.month - 1, jst.day + offset);
    const dow = new Date(base).getUTCDay(); // 0=日 … 6=土
    if (schedule.skipDow.includes(dow)) continue;
    for (const hour of schedule.hours) {
      const at = new Date(base + (hour - 9) * 3_600_000); // JSTは常にUTC+9
      if (at.getTime() > from.getTime()) return at;
    }
  }
  return null;
}

/**
 * 刻時盤（Scheduler）: 時間駆動タスクの土台。毎分tickし、各タスクは
 * settings のマーカーで「実行済みか」を自分で判定する（再起動しても二重実行しない）。
 */
export function startScheduler(client: Client, services: Services, intervalMs = 60_000): NodeJS.Timeout {
  async function tick(): Promise<void> {
    const now = jstNow();

    // ── 説明会の案内: 開催枠（既定は月・木を除く 21/22/23時）の 5分前に入城案内chへ通知 ──
    // 開催枠は settings（entry:session_hours / entry:session_skip_dow）で変えられる。
    //
    // 30分前の予告は廃止した。案内待ちロールへのメンションが 1日6回・週30回になり、
    // まだ城の中を何も見ていない新規にとって離脱要因になっていたため（直前の1回だけに絞る）。
    {
      const schedule = sessionSchedule(services);
      const notifyMinute = 60 - SESSION_NOTIFY_LEAD_MIN; // 例: 21時会は 20:55
      const todayDow = jstDayOfWeek();
      for (const start of schedule.hours) {
        // 0時開催だけは前日の23:55に通知するので、休みの判定は「開催日」の曜日で行う
        const sessionDow = start === 0 ? (todayDow + 1) % 7 : todayDow;
        if (schedule.skipDow.includes(sessionDow)) continue;
        if (!isSessionNotificationDue(now, start, notifyMinute)) continue;
        const marker = `session:notify:${now.dateStr}:${start}:5m`;
        if (!services.settings.getString(marker)) {
          await runSchedulerTaskOnce(services, marker, "system:scheduler", () =>
            sendSessionNotification(client, services, start, "5m"),
          ).catch((e) => console.error("[説明会] 通知失敗:", e));
        }
      }
    }

    // ── 24時間無応答チケットのリマインド（毎時0分にチェック）──
    if (now.minute < 2) {
      await processStaleTicketNotifications(client, services).catch((e) => console.error("[ticket] 24時間通知失敗:", e));
    }
    cleanupCompletedChunkBatches(services);

    // ── 部屋のライフサイクル（在室スキャン・削除・期限・募集失効）──
    await scanRooms(client, services).catch((e) => console.error("[room] スキャン失敗:", e));

    // ── 冥獣の巣: 無人の複製VC撤収・報酬対象の掃除 ──
    await scanDens(client, services).catch((e) => console.error("[den] スキャン失敗:", e));

    // ── 計器盤の更新（10分ごと）──
    if (now.minute % 10 === 0) {
      await updateDashboard(client, services).catch((e) => console.error("[計器盤] 更新失敗:", e));
    }

    // ── ボイスXP tick（5分ごと・複数人VC滞在者に加算）──
    if (now.minute % 5 === 0) {
      await tickVoiceXp(client, services).catch((e) => console.error("[rank] ボイスXP tick失敗:", e));
    }

    // ── bump/up クールタイム終了通知 ──
    await checkBumpCooldowns(client, services);

    // ── VC浮上報酬: 毎日 05:00 台に前日分を支給 ──
    if (now.hour === 5) {
      const yesterday = jstNow(new Date(Date.now() - 86_400_000)).dateStr;
      const marker = `vc_reward:paid:${yesterday}`;
      if (!services.settings.getString(marker)) {
        await runSchedulerTaskOnce(services, marker, "system:scheduler", () =>
          payVcRewards(client, services, yesterday),
        );
      }
    }

    // ── 評価スレッドの実績サマリ更新（毎日 05:30 頃）──
    if (now.hour === 5 && now.minute >= 30 && now.minute < 33) {
      const marker = `eval_stats:refreshed:${now.dateStr}`;
      if (!services.settings.getString(marker)) {
        await runSchedulerTaskOnce(services, marker, "system:scheduler", () =>
          refreshEvalStats(client, services),
        ).catch((e) => console.error("[評価] 実績更新失敗:", e));
      }
    }

    // ── トートの耳: 保存期間を過ぎた相談本文を毎日 04:00 台にpurge（メタ・操作ログは残す）──
    if (now.hour === 4) {
      const marker = `confession_purge:${now.dateStr}`;
      if (!services.settings.getString(marker)) {
        await runSchedulerTaskOnce(services, marker, "system:scheduler", async () => {
          const due = services.confessions.listPurgeable();
          for (const c of due) services.confessions.purgeBody(c.id, "system:scheduler", { auto: true });
          if (due.length > 0) console.log(`[トート] 保存期間切れの相談本文 ${due.length}件 をpurgeしました`);
        }).catch((e) => console.error("[トート] 本文purge失敗:", e));
      }
    }

    // ── カロン: 毎日 09:00 台に期限リスト・演出通知・迷霊落ち承認パネル・題名同期 ──
    if (now.hour === 9) {
      await runSchedulerTaskOnce(services, `charon:due_list:${now.dateStr}`, "system:scheduler", () =>
        postCharonDueList(client, services),
      ).catch((e) => console.error("[カロン] 期限リスト失敗:", e));
      await sendCharonNotifications(client, services).catch((e) => console.error("[カロン] 本人通知失敗:", e));
      await runSchedulerTaskOnce(services, `charon:overdue_panel:${now.dateStr}`, "system:scheduler", () =>
        postCharonOverduePanel(client, services),
      ).catch((e) => console.error("[カロン] 承認パネル失敗:", e));
      await runSchedulerTaskOnce(services, `charon:title_sync:${now.dateStr}`, "system:scheduler", () =>
        syncCharonThreadTitles(client, services),
      ).catch((e) => console.error("[カロン] 題名同期失敗:", e));
    }

    // ── 14日経ってフォーラム未作成の亡霊は自動で迷霊に落とす（毎日 09:15）──
    if (now.hour === 9 && now.minute >= 15 && now.minute < 18) {
      const marker = `autodrop:noeval:${now.dateStr}`;
      if (!services.settings.getString(marker)) {
        await runSchedulerTaskOnce(services, marker, "system:scheduler", () =>
          autoDropNoEvalGhosts(client, services),
        ).catch((e) => console.error("[自動迷霊] 失敗:", e));
      }
    }

    // ── VIP 期限切れ: ロール剥奪 & DB クリア ──
    try {
      const expired = services.vip.expired();
      if (expired.length > 0) {
        const roleId = services.settings.getString("role:casino_vip");
        const guildId = services.settings.getString("guild:main");
        const guild = guildId ? await client.guilds.fetch(guildId).catch(() => null) : null;
        if (guild && roleId) {
          for (const uid of expired) {
            const member = await guild.members.fetch(uid).catch(() => null);
            await member?.roles.remove(roleId).catch(() => undefined);
          }
        }
        services.vip.clearExpired(expired);
        // 失効は本人に見える形で伝える（無言の権利剥奪をしない）
        for (const uid of expired) {
          const user = await client.users.fetch(uid).catch(() => null);
          await user
            ?.send("💎 マモンの賭場 VIP の期限が切れた。賭け上限は通常に戻る。更新は `/vip` から。")
            .catch(() => undefined);
        }
        if (expired.length > 0) console.log(`[vip] 期限切れ ${expired.length}人 のロール剥奪`);
      }
    } catch (e) {
      console.error("[vip] tick失敗:", e);
    }

    // ── 賭場の板: 締切を過ぎた open を closed へ + reported の5分無異議で自動精算 ──
    try {
      const pending = services.markets.listPastDeadline();
      for (const m of pending) {
        services.markets.autoClose(m.id);
        await announceAutoClose(client, services, m.id).catch(() => undefined);
      }
      const disputeExpired = services.markets.listPastDisputeWindow();
      for (const m of disputeExpired) {
        const settled = services.markets.finalizeIfNoDispute(m.id);
        if (settled) {
          const fresh = services.markets.get(m.id);
          if (fresh) {
            await announceSettle(client, fresh, settled).catch(() => undefined);
            await refreshMarketPanel(client, services, m.id).catch(() => undefined);
          }
        }
      }
    } catch (e) {
      console.error("[market] tick失敗:", e);
    }

    // ── マモンの株式市場: 1時間ごとの価格更新 & 期限切れ強制売却 ──
    try {
      services.stocks.updateAll();
      const forced = services.stocks.forceSellExpired();
      if (forced.length > 0) {
        console.log(`[stocks] 期限切れ強制売却: ${forced.length}件`);
        // 資産が勝手に動いた時は必ず本人に通知（無言の強制売却をしない）
        for (const f of forced) {
          const stock = services.stocks.get(f.stockId);
          const user = await client.users.fetch(f.userId).catch(() => null);
          await user
            ?.send(
              `📈 マモンの株式市場: **${stock?.emoji ?? ""}${stock?.name ?? f.stockId}** ${f.shares}株 が保有期限（3日）を超えたため強制売却された。受取 **${f.proceeds.toLocaleString("ja-JP")}◈**（手数料1%控除後）。`,
            )
            .catch(() => undefined);
        }
      }
    } catch (e) {
      console.error("[stocks] tick失敗:", e);
    }

    // ── 公式ショップの月額一括請求: 毎月1日 08:00 JST ──
    if (now.day === 1 && now.hour === 8) {
      const shopMarker = `shop:monthly:${now.period}`;
      if (!services.settings.getString(shopMarker)) {
        await runSchedulerTaskOnce(services, shopMarker, "system:scheduler", async () => {
          const { charged, lapsed } = chargeMonthlySubscriptionsAtomically(services, "system:shop-monthly");
          console.log(`[ショップ] 月額一括: 課金 ${charged.length}件 / 失効 ${lapsed.length}件`);
          // 本人通知はbest effort。Discord上の権利剥奪は購入履歴から別タスクで再試行する。
          for (const l of lapsed) {
            const user = await client.users.fetch(l.purchase.user_id).catch(() => null);
            await user
              ?.send(`🛒 **${l.item.name}** の月額更新が失敗しました（${l.reason}）。当月末で権利が失効します。再購入は公式ショップから。`)
              .catch(() => undefined);
          }
        }).catch((e) => console.error("[ショップ] 月額一括処理失敗:", e));
      }
    }

    // 失効購入のロール剥奪は月次請求と分離し、購入ID単位で毎分自己修復する。
    await processShopRoleRevocations(client, services).catch((e) =>
      console.error("[ショップ] 失効ロール剥奪失敗:", e),
    );

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

  let tickInFlight = false;
  async function runTick(): Promise<void> {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      await tick();
    } finally {
      tickInFlight = false;
    }
  }

  return setInterval(() => void runTick().catch((e) => console.error("[刻時盤] tick失敗:", e)), intervalMs);
}

/** VC浮上報酬の日次支給: 前日分を計算して1人1取引で発行し、本人にDMで通知 */
export async function payVcRewards(client: Client, services: Services, dateStr: string): Promise<void> {
  // ブラックリスト方式: 除外リスト(XPと共用)と寝落ちリストを設定から組み立てて渡す。
  const excludedIds = new Set(services.settings.getJson<string[]>("xp_excluded_channels", []));
  const sleepChannelIds = new Set(services.settings.getJson<string[]>("vc_sleep_list", []));
  const rewards = services.vcRewards.computeDay(dateStr, { excludedIds, sleepChannelIds });
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

export async function sendSessionNotification(
  client: Client,
  services: Services,
  startHour: number,
  kind: "30m" | "5m",
): Promise<void> {
  const guideId = services.settings.getString("channel:entry_guide");
  if (!guideId) throw new Error("session_notify:channel_entry_guide_missing");
  const waitRoleId = services.settings.getString("role:queue_wait");
  const ch = await client.channels.fetch(guideId).catch((e) => {
    throw new Error(`session_notify:channel_fetch_failed:${e instanceof Error ? e.message : String(e)}`);
  });
  if (!ch?.isTextBased() || !("send" in ch)) throw new Error("session_notify:channel_not_sendable");

  const rolePart = waitRoleId ? `<@&${waitRoleId}> ` : "";
  const timing = kind === "30m" ? "**30分後**" : "**まもなく**";
  await ch.send({
    content: `📣 ${rolePart}${timing}（**${startHour}時**）に説明会があります。**説明会場VC**に来てお待ちください。`,
    allowedMentions: { roles: waitRoleId ? [waitRoleId] : [] },
  });
}

function legacyTicketKindLabel(kind: string): string {
  return kind === "return" ? "出戻り" : kind === "consult" ? "相談" : kind;
}

export async function processStaleTicketNotifications(client: Client, services: Services): Promise<void> {
  const existing = pendingChunkBatch(services, "ticket_stale_24h");
  const stale = existing ? [] : services.tickets.staleOpen(24);
  if (!existing && stale.length === 0) return;

  const targetIds = existing ? JSON.parse(existing.target_ids_json) as string[] : stale.map((t) => t.thread_id);
  const staffRoleIds = existing
    ? (JSON.parse(existing.role_ids_json) as string[])
    : [...new Set(stale.flatMap((t) => ticketStaffRoleIds(t, services)))];
  const batchKey = existing?.batch_key ?? `ticket_stale_24h:${Date.now()}`;
  const lines = existing
    ? []
    : stale.map((t) => `・<#${t.thread_id}>（${t.panel_name ?? legacyTicketKindLabel(t.kind)}）`);

  const kessaiId = services.settings.getString("channel:kessai");
  const channel = kessaiId ? await client.channels.fetch(kessaiId).catch(() => null) : null;
  if (!channel?.isTextBased() || !("send" in channel)) throw new Error("ticket_stale:channel_missing_or_not_sendable");

  const result = await sendChunkedLinesResumable(services, channel as TextChannel, {
    batchKey,
    kind: "ticket_stale_24h",
    header: `📮 ${staffRoleIds.length > 0 ? `${staffRoleIds.map((id) => `<@&${id}>`).join(" ")} ` : ""}**24時間以上応答のないチケットが ${targetIds.length} 件あります**:`,
    lines,
    targetIds,
    roleIds: staffRoleIds,
    metadata: { createdBy: "system:scheduler" },
  });
  finalizeChunkBatch(services, batchKey, () => {
    for (const threadId of result.targetIds) services.tickets.markReminded(threadId);
  });
}

async function fetchTextChannel(client: Client, services: Services, settingKey: string): Promise<TextChannel | null> {
  const id = services.settings.getString(settingKey);
  if (!id) return null;
  const ch = await client.channels.fetch(id).catch((e) => {
    throw new Error(`${settingKey}:fetch_failed:${e instanceof Error ? e.message : String(e)}`);
  });
  return ch?.isTextBased() && "send" in ch ? (ch as TextChannel) : null;
}

/** カロン①: 期限が近い者のリストを #城の計器盤 へ投稿 */
export async function postCharonDueList(client: Client, services: Services): Promise<void> {
  const existing = pendingChunkBatch(services, "charon_due_list");
  const nowTs = Math.floor(Date.now() / 1000);
  const dateStr = jstNow().dateStr;
  const DAY = 86_400;
  const dueSoon = existing ? [] : services.evaluation.dueBetween(nowTs, nowTs + 2 * DAY);
  if (!existing && dueSoon.length === 0) return;
  const keikiban = await fetchTextChannel(client, services, "channel:keikiban");
  if (!keikiban) throw new Error("charon_due_list:channel_missing_or_not_sendable");

  const targetIds = existing ? JSON.parse(existing.target_ids_json) as string[] : dueSoon.map((r) => r.user_id);
  const lines = existing
    ? []
    : dueSoon.map((r) => {
      const p = services.evaluation.promotionScore(r.user_id);
      const d = services.evaluation.demotionCount(r.user_id);
      const t = services.evaluation.thresholdsFor(r.user_id);
      return `・<@${r.user_id}> 期限 <t:${r.eval_deadline_at}:R> — 昇格印 ${p.total}/${t.promotionRequired}・低評価印 ${d}/${t.demotionThreshold}・評価 ${services.evaluation.evaluationCount(r.user_id)}件`;
    });
  const batchKey = existing?.batch_key ?? `charon_due_list:${dateStr}`;
  await sendChunkedLinesResumable(services, keikiban, {
    batchKey,
    kind: "charon_due_list",
    header: `🛶 **カロンの帳簿** — 審判が近い魂 ${targetIds.length}名:`,
    lines,
    targetIds,
    roleIds: [],
    metadata: { dateStr },
  });
  finalizeChunkBatch(services, batchKey);
}

/** カロン②: 本人への演出通知（DM と通知チャンネルを個別マーカーで追跡） */
export async function sendCharonNotifications(client: Client, services: Services): Promise<void> {
  const nowTs = Math.floor(Date.now() / 1000);
  const DAY = 86_400;
  const notifyChId = services.settings.getString("channel:charon_notify");
  const notifyCh = notifyChId ? await client.channels.fetch(notifyChId).catch(() => null) : null;
  const upcoming = services.evaluation.dueBetween(nowTs, nowTs + 4 * DAY);
  const failures: string[] = [];

  for (const r of upcoming) {
    const daysLeft = Math.floor((r.eval_deadline_at - nowTs) / DAY);
    if (![3, 1, 0].includes(daysLeft)) continue;

    const legacyMarker = `charon:notified:${r.user_id}:${daysLeft}`;
    const dmMarker = `charon:notified:dm:${r.user_id}:${daysLeft}`;
    const channelMarker = `charon:notified:channel:${r.user_id}:${daysLeft}`;

    if (!services.settings.getString(legacyMarker) && !services.settings.getString(dmMarker)) {
      const user = await client.users.fetch(r.user_id).catch((e) => {
        failures.push(`dm_fetch:${r.user_id}:${e instanceof Error ? e.message : String(e)}`);
        return null;
      });
      if (!user) {
        failures.push(`dm_user_missing:${r.user_id}`);
      } else {
        await user
          .send(
            daysLeft === 0
              ? "🛶 **汝の審判は今日である。** 冥獄の魂たちは汝の姿を見ているか。"
              : `🛶 **汝の審判まで、あと${daysLeft}日。** 評価対象の場に姿を見せよ。`,
          )
          .then(() => services.settings.set(dmMarker, "1", "system:charon"))
          .catch((e) => failures.push(`dm_send:${r.user_id}:${e instanceof Error ? e.message : String(e)}`));
      }
    }

    if (notifyChId && !services.settings.getString(legacyMarker) && !services.settings.getString(channelMarker)) {
      if (!notifyCh?.isTextBased() || !("send" in notifyCh)) {
        failures.push(`channel_unavailable:${r.user_id}`);
        continue;
      }
      const p = services.evaluation.promotionScore(r.user_id);
      const t = services.evaluation.thresholdsFor(r.user_id);
      const line =
        daysLeft === 0
          ? `🛶 <@${r.user_id}> **審判の刻限は本日** <t:${r.eval_deadline_at}:t>。昇格印 **${p.total}/${t.promotionRequired}**（残り時間で挽回するか、迷霊落ちを覚悟せよ）。`
          : `🛶 <@${r.user_id}> **審判まであと${daysLeft}日**（<t:${r.eval_deadline_at}:R>）。昇格印 **${p.total}/${t.promotionRequired}**・評価対象VCで姿を示せ。`;
      await notifyCh
        .send({ content: line, allowedMentions: { users: [r.user_id] } })
        .then(() => services.settings.set(channelMarker, "1", "system:charon"))
        .catch((e) => failures.push(`channel_send:${r.user_id}:${e instanceof Error ? e.message : String(e)}`));
    }
  }
  if (failures.length > 0) throw new Error(`charon_notifications_failed:${failures.join(",")}`);
}

/** カロン③: 期限切れ（昇格印不足）を #決裁 に承認パネルとして投稿 */
export async function postCharonOverduePanel(client: Client, services: Services): Promise<void> {
  const nowTs = Math.floor(Date.now() / 1000);
  const overdue = services.evaluation.overdue(nowTs);
  if (overdue.length === 0) return;
  const kessai = await fetchTextChannel(client, services, "channel:kessai");
  if (!kessai) throw new Error("charon_overdue_panel:channel_missing_or_not_sendable");
  const lines = overdue.slice(0, 20).map((r) => {
    const p = services.evaluation.promotionScore(r.user_id);
    const t = services.evaluation.thresholdsFor(r.user_id);
    return `・<@${r.user_id}>（昇格印 ${p.total}/${t.promotionRequired}・期限 <t:${r.eval_deadline_at}:D>）`;
  });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("charon:drop").setLabel(`${overdue.length}名を迷霊に落とす`).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("charon:cancel").setLabel("今日は見送る").setStyle(ButtonStyle.Secondary),
  );
  await kessai.send({
    content: [
      `⚖️ **カロンの上申** — 評価期限が到達し昇格印が不足している魂 **${overdue.length}名**:`,
      ...lines,
    ].join("\n"),
    components: [row],
    allowedMentions: { parse: [] },
  });
}

/** カロン④: 評価スレッドの題名を実際の期限に同期 */
export async function syncCharonThreadTitles(client: Client, services: Services): Promise<void> {
  const nowTs = Math.floor(Date.now() / 1000);
  const DAY = 86_400;
  const targets = [
    ...services.evaluation.dueBetween(nowTs, nowTs + 2 * DAY),
    ...services.evaluation.dueBetween(nowTs, nowTs + 4 * DAY),
  ];
  const guildId = services.settings.getString("guild:main");
  const guild = guildId ? await client.guilds.fetch(guildId).catch(() => null) : null;
  if (!guild) throw new Error("charon_title_sync:guild_fetch_failed");
  const failures: string[] = [];
  const seen = new Set<string>();
  for (const r of targets) {
    if (seen.has(r.user_id)) continue;
    seen.add(r.user_id);
    const threadId = services.evaluation.threadFor(r.user_id);
    if (!threadId) continue;
    const thread = await client.channels.fetch(threadId).catch((e) => {
      failures.push(`thread_fetch:${r.user_id}:${e instanceof Error ? e.message : String(e)}`);
      return null;
    });
    if (!thread?.isThread()) {
      failures.push(`thread_unavailable:${r.user_id}`);
      continue;
    }
    const member = await guild.members.fetch(r.user_id).catch(() => null);
    const expected = threadTitleFor(member?.displayName ?? r.user_id, r.eval_deadline_at);
    if (thread.name !== expected) {
      await thread.setName(expected).catch((e) => {
        failures.push(`thread_rename:${r.user_id}:${e instanceof Error ? e.message : String(e)}`);
      });
    }
  }
  if (failures.length > 0) throw new Error(`charon_title_sync_failed:${failures.join(",")}`);
}

/** カロンの日次業務: 互換用。Schedulerでは個別マーカー付きサブタスクを直接呼ぶ。 */
export async function runCharonDaily(client: Client, services: Services): Promise<void> {
  await postCharonDueList(client, services);
  await sendCharonNotifications(client, services);
  await postCharonOverduePanel(client, services);
  await syncCharonThreadTitles(client, services);
}

/**
 * 14日の評価期限を過ぎ、評価フォーラムのスレッドが1本も無い（＝誰にも評価されず）
 * 亡霊を自動で迷霊に落とす。ロール同期失敗分は永続キューから自己修復する。
 */
export async function autoDropNoEvalGhosts(client: Client, services: Services): Promise<void> {
  await recoverAutoDropNoEvalGhosts(client, services);
}
