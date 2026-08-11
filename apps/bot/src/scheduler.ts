import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client, type TextChannel } from "discord.js";
import { addJstDays, TREASURY } from "@meigokujo/core";
import { createAndPostDraft } from "./payday.js";
import { threadTitleFor } from "./commands/evaluation.js";
import { checkBumpCooldowns } from "./bump.js";
import { scanRooms } from "./rooms-lifecycle.js";
import { scanDens } from "./dens.js";
import { refreshEvalStats } from "./eval-daily.js";
import { updateDashboard } from "./dashboard.js";
import { updateWaitersBoard } from "./waiters-board.js";
import { tickVoiceXp } from "./rank-tracker.js";
import { fmtLd } from "./format.js";
import { announceAutoClose, announceSettle, refreshMarketPanel } from "./commands/ita.js";
import { ticketStaffRoleIds } from "./commands/tickets.js";
import { isSeatOccupied } from "./casino/common.js";
import { retryPendingRankedTableMessages } from "./casino/ranked-table-ui.js";
import type { Services } from "./services.js";
import {
  cleanupCompletedChunkBatches,
  finalizeChunkBatch,
  pendingChunkBatch,
  runSchedulerTaskOnce,
  sendChunkedLinesResumable,
} from "./scheduler-utils.js";
import {
  expireOverduePurchases,
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

// ── 説明会の開催予定 ──
// 通常枠（settings）と日付ごとの例外（entry_session_overrides）の合成は core の
// SessionCalendar が持つ。刻時盤・DM・パネル・`/説明会`・門番用ボードは全部そこを見る。

/** 開始の何分前に通知するか（notifyMinute = 60 - これ） */
const SESSION_NOTIFY_LEAD_MIN = 5;

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
 * 次の説明会の開始時刻（休止・臨時追加を織り込んだ実際の予定）。8日先まで見て無ければ null。
 * 入城案内で「次は何時か」を具体的に出すために使う（抽象的な「21/22/23時です」だけだと
 * 参加直後の人が次の機会をいつまで待つのか分からず、そのまま抜けてしまうため）。
 */
export function nextSessionStart(services: Pick<Services, "sessions">, from = new Date()): Date | null {
  return services.sessions.nextOccurrence(from)?.at ?? null;
}

/**
 * 刻時盤（Scheduler）: 時間駆動タスクの土台。毎分tickし、各タスクは
 * settings のマーカーで「実行済みか」を自分で判定する（再起動しても二重実行しない）。
 */
export function startScheduler(client: Client, services: Services, intervalMs = 60_000): NodeJS.Timeout {
  async function tick(): Promise<void> {
    const now = jstNow();

    // PR10: every minute, return only verified-user free chips idle for ten minutes.
    // redeemInactive rechecks activity immediately before each redemption and isolates failures.
    //
    // 正式開業済み **かつ** 営業中のときだけ動かす（監査項目9）。
    // 以前は状態を見ずに毎分呼んでいたので、legacy_pre_reset・opening_reset・
    // manual_halt・recovery_halt・startup_check・未知状態では、対象者ごとに
    // 資金操作が拒否され、毎分 failed イベントだけが積み上がっていた。
    // 期限切れの域外確認票の回収は資金を動かさないので、営業状態に関わらず毎分回す。
    // executing のまま残った票（返還済み・元操作未完了）を永久に放置しない
    services.chipFlow.expireStaleConfirmations();

    if (services.chipTx.openingPhase() === "formal" && services.casinoStatus.current().status === "open") {
      const idleCutoff = Math.floor(Date.now() / 1000) - 10 * 60;
      const idle = services.chipFlow.redeemInactive(
        idleCutoff,
        `scheduler:${idleCutoff}`,
        {
          activeGameUsers: (userIds) => userIds.filter(isSeatOccupied),
          processingGroup: () => services.chipTx.isActive(),
          integrityBlocked: () => {
            const state = services.casinoStatus.current().status;
            return state === "integrity_halt" || state === "recovery_halt";
          },
        },
      );
      // skip は毎分ふつうに起きる（進行中の客）。異常として記録するのは失敗だけにする
      if (idle.failed.length > 0) {
        services.events.log("casino_idle_redeem_scan", {
          actor: "system:scheduler",
          payload: { cutoff: idleCutoff, failed: idle.failed, skipped: idle.skipped },
        });
      }
    }

    processRankedTableTimeoutsForScheduler(services, Math.floor(Date.now() / 1000));
    await retryPendingRankedTableMessages(client, services).catch((e) =>
      console.error("[casino-ranked] canonical message sync retry failed:", e),
    );

    if (now.hour === 3 && now.minute < 3 && services.chipTx.openingPhase() === "formal") {
      const marker = `casino_metrics:maintenance:${now.dateStr}`;
      if (!services.settings.getString(marker)) {
        await runSchedulerTaskOnce(services, marker, "system:scheduler", () => {
          const result = services.casinoMetrics.runDailyMaintenance({ maxDays: 90 });
          if (result.skipped) throw new Error("casino_metrics:maintenance_skipped");
          console.log(`[casino-metrics] maintenance dates=${result.dates.length} chipEvents=${result.chipEvents} pruned=${result.pruned}`);
        }).catch((e) => console.error("[casino-metrics] maintenance failed", e));
      }
    }

    // ── 説明会の案内: 実際の開催予定の 5分前に入城案内chへ通知 ──
    // 通常枠は settings、休止・臨時追加は entry_session_overrides。合成は SessionCalendar が持ち、
    // ここは「その枠が本当に開催されるか」だけを訊く（休止した枠を案内しない・臨時枠は案内する）。
    //
    // 30分前の予告は廃止した。案内待ちロールへのメンションが 1日6回・週30回になり、
    // まだ城の中を何も見ていない新規にとって離脱要因になっていたため（直前の1回だけに絞る）。
    {
      const schedule = services.sessions.schedule();
      const notifyMinute = 60 - SESSION_NOTIFY_LEAD_MIN; // 例: 21時会は 20:55
      // 通常枠に加えて、今日・明日に臨時追加された枠も通知の候補にする
      const candidates = new Set([
        ...schedule.hours,
        ...services.sessions
          .listOverrides(now.dateStr, addJstDays(now.dateStr, 1))
          .filter((o) => o.kind === "add" && o.hour !== null)
          .map((o) => o.hour as number),
      ]);
      for (const start of candidates) {
        if (!isSessionNotificationDue(now, start, notifyMinute)) continue;
        // 0時開催だけは前日の23:55に通知するので、開催の有無は「開催日」で見る
        const sessionDate = start === 0 ? addJstDays(now.dateStr, 1) : now.dateStr;
        if (!services.sessions.isOccurring(sessionDate, start, schedule)) continue;
        const marker = `session:notify:${sessionDate}:${start}:5m`;
        if (!services.settings.getString(marker)) {
          // 成否を事件録に残す。実行済みマーカーは成功時にしか付かないので、それだけでは
          // 「失敗した」のか「まだ通知時刻前」なのかを門番用ボードから区別できない
          await runSchedulerTaskOnce(services, marker, "system:scheduler", async () => {
            await sendSessionNotification(client, services, start, "5m");
            services.events.log("session_notified", {
              actor: "system:scheduler",
              payload: { date: sessionDate, hour: start, kind: "5m" },
            });
          }).catch((e) => {
            console.error("[説明会] 通知失敗:", e);
            services.events.log("session_notify_failed", {
              actor: "system:scheduler",
              payload: { date: sessionDate, hour: start, kind: "5m", error: e instanceof Error ? e.message : String(e) },
            });
          });
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
      // 門番用の待ち人ボードも同じ間隔で追従させる（未設置なら何もしない）
      await updateWaitersBoard(client, services).catch((e) => console.error("[待ち人ボード] 更新失敗:", e));
    }

    // ── ボイスXP tick（5分ごと・複数人VC滞在者に加算）──
    if (now.minute % 5 === 0) {
      await tickVoiceXp(client, services).catch((e) => console.error("[rank] ボイスXP tick失敗:", e));
    }

    // ── 胴元債務予約の漏れ検出（毎時5分・PR5 / 正本 §11.2）──
    // 24時間残っている予約は解放し忘れ。放っておくと胴元の受注可能額を永久に食う
    if (now.minute === 5) {
      try {
        const swept = services.reservations.sweepStale();
        if (swept.count > 0) {
          console.warn(
            `[casino] 24時間以上残った胴元債務予約 ${swept.count}件（計 ${swept.total.toLocaleString("ja-JP")}◈）を警告つきで解放: ` +
              swept.rows.map((r) => `${r.game}/${r.userId}`).slice(0, 10).join(", "),
          );
        }
      } catch (e) {
        console.error("[casino] 胴元債務予約の掃除に失敗:", e);
      }
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

    // 賭場が停止していれば、資金を動かす tick は丸ごと飛ばす。
    // （資金層でも弾かれるが、毎分例外を出し続けないようにここでも見る）
    const casinoClosed = services.casinoStatus.denyMessage() !== null;
    if (casinoClosed) console.log("[賭場] 停止中のため通常板の tick を飛ばします");

    // ── イベントLand板: 自動締切だけは casino 稼働状態と独立して常に動かす ──
    // casinoStatus（賭場チップ経済の稼働状態）は生Ledgerのイベント板Land決済とは
    // 別レイヤーの概念であり、連動させない方針（追加アーキ指針§E）。仕様上も
    // 「自動締切はイベント板でも動かす」と明記されているため、賭場チップ経済が
    // 何らかの理由で停止していてもイベント板の締切は止めない。
    // イベント板は reported へ遷移しないため listPastDisputeWindow/finalizeIfNoDispute の対象には
    // 構造上出現せず、ここでは autoClose だけを扱えばよい。
    try {
      const pending = services.markets.listPastDeadline();
      for (const m of pending) {
        if (m.market_mode !== "event") continue;
        services.markets.autoClose(m.id);
        await announceAutoClose(client, services, m.id).catch(() => undefined);
      }
    } catch (e) {
      console.error("[event-market] auto-close tick失敗:", e);
    }

    // ── 賭場の板（通常板）: 締切を過ぎた open を closed へ + reported の5分無異議で自動精算 ──
    if (!casinoClosed) try {
      const pending = services.markets.listPastDeadline();
      for (const m of pending) {
        if (m.market_mode === "event") continue; // 上のブロックで処理済み
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

    // ── マモンの株式市場: 停止中（PR6・正本 §1.3）──
    // 価格更新も期限切れ強制売却も行わない。**建玉には一切触れない**。
    // 「試験データと確認できた建玉の初期化」は PR12 の正式開業初期化の仕事で、
    // ここで清算すると、正式資産だった場合の補償基準（時価）を自分で壊すことになる。

    // ── 公式ショップ: 期限切れの失効（自動課金はしない）──
    // 月額の一括再課金は廃止した。期限が来たら失効させ、権利を剥がすところまでを
    // **課金と無関係に**毎分回す。以前は失効判定が月次請求の中にしか無かったので、
    // 請求を止めると期限切れが来なくなる構造だった。
    try {
      const expired = expireOverduePurchases(services, "system:shop-expiry");
      if (expired.length > 0) {
        console.log(`[ショップ] 期限切れ ${expired.length}件を失効`);
        // 黙って権利が消えないようにする（旧・月次処理にも本人通知があった）。
        // 届かなくても失効自体は確定済みなので best effort でよい
        for (const purchase of expired) {
          const item = services.shop.getItem(purchase.item_id);
          const user = await client.users.fetch(purchase.user_id).catch(() => null);
          await user
            ?.send(
              `🛒 **${item?.name ?? `商品#${purchase.item_id}`}** の期限が切れました。自動での再課金は行いません。続ける場合は公式ショップから延長してください。`,
            )
            .catch(() => undefined);
        }
      }
    } catch (e) {
      console.error("[ショップ] 失効スイープ失敗:", e);
    }

    // 失効購入のロール剥奪は失効処理と分離し、購入ID単位で毎分自己修復する。
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
export function processRankedTableTimeoutsForScheduler(services: Services, nowSec: number): void {
  try {
    if (services.chipTx.openingPhase() !== "formal" || services.casinoStatus.current().status !== "open") return;
  } catch (e) {
    services.events.log("casino_ranked_timeout_scan_failed", {
      actor: "system:scheduler",
      payload: { error: e instanceof Error ? e.message : String(e) },
    });
    return;
  }

  try {
    const result = services.rankedTables.processDueTables(nowSec);
    const disputes = services.rankedDisputes.processEvidenceDeadlines(nowSec);
    if (result.processed > 0 || result.refunded > 0 || result.disputed > 0) {
      services.events.log("casino_ranked_timeout_scan", {
        actor: "system:scheduler",
        payload: result,
      });
    }
    if (disputes.closed > 0 || disputes.autoRefunded > 0 || disputes.failed > 0) {
      services.events.log("casino_ranked_dispute_deadline_scan", {
        actor: "system:scheduler",
        payload: disputes,
      });
    }
  } catch (e) {
    services.events.log("casino_ranked_timeout_scan_failed", {
      actor: "system:scheduler",
      payload: { error: e instanceof Error ? e.message : String(e) },
    });
  }
}

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
