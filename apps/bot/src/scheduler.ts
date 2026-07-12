import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client, type TextChannel } from "discord.js";
import { TREASURY } from "@meigokujo/core";
import { createAndPostDraft } from "./payday.js";
import { threadTitleFor } from "./commands/evaluation.js";
import { checkBumpCooldowns } from "./bump.js";
import { scanRooms } from "./rooms-lifecycle.js";
import { scanDens } from "./dens.js";
import { refreshEvalStats } from "./eval-daily.js";
import { applyVcRanks } from "./vc-ranks.js";
import { updateDashboard } from "./dashboard.js";
import { tickVoiceXp } from "./rank-tracker.js";
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

    // ── 説明会の案内: 月・木を除く 21/22/23 時の 30分前・5分前に入城案内chへ通知 ──
    // JST の new Date().getDay(): 0=日, 1=月, 4=木
    {
      const jstDate = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
      const dow = jstDate.getDay();
      const isMonOrThu = dow === 1 || dow === 4;
      const sessions = [
        { start: 21, minute: 30, kind: "30m" as const },
        { start: 21, minute: 55, kind: "5m" as const },
        { start: 22, minute: 30, kind: "30m" as const },
        { start: 22, minute: 55, kind: "5m" as const },
        { start: 23, minute: 30, kind: "30m" as const },
        { start: 23, minute: 55, kind: "5m" as const },
      ];
      // 20:30/55, 21:30/55, 22:30/55 = 21時会前・22時会前・23時会前の 30min/5min 前
      // すなわち session.start は 21/22/23、通知時刻は start-1 時 30/55 分
      if (!isMonOrThu) {
        for (const s of sessions) {
          const notifyHour = s.start - 1;
          if (now.hour === notifyHour && now.minute === s.minute) {
            const marker = `session:notify:${now.dateStr}:${s.start}:${s.kind}`;
            if (!services.settings.getString(marker)) {
              services.settings.set(marker, "1", "system:scheduler");
              const guideId = services.settings.getString("channel:entry_guide");
              const waitRoleId = services.settings.getString("role:queue_wait");
              const ch = guideId ? await client.channels.fetch(guideId).catch(() => null) : null;
              if (ch?.isTextBased() && "send" in ch) {
                const rolePart = waitRoleId ? `<@&${waitRoleId}> ` : "";
                const timing = s.kind === "30m" ? "**30分後**" : "**まもなく**";
                await ch
                  .send({
                    content: `📣 ${rolePart}${timing}（**${s.start}時**）に説明会があります。**説明会場VC**に来てお待ちください。`,
                    allowedMentions: { roles: waitRoleId ? [waitRoleId] : [] },
                  })
                  .catch(() => undefined);
              }
            }
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
        services.settings.set(marker, "1", "system:scheduler");
        await payVcRewards(client, services, yesterday);
      }
    }

    // ── 評価スレッドの実績サマリ更新（毎日 05:30 頃）──
    if (now.hour === 5 && now.minute >= 30 && now.minute < 33) {
      const marker = `eval_stats:refreshed:${now.dateStr}`;
      if (!services.settings.getString(marker)) {
        services.settings.set(marker, "1", "system:scheduler");
        await refreshEvalStats(client, services).catch((e) => console.error("[評価] 実績更新失敗:", e));
      }
    }

    // ── 位階（VCロール）: 毎日 06:00 台に累計VC時間で付け直す ──
    if (now.hour === 6 && !services.settings.getString(`vc_rank:applied:${now.dateStr}`)) {
      services.settings.set(`vc_rank:applied:${now.dateStr}`, "1", "system:scheduler");
      await applyVcRanks(client, services).catch((e) => console.error("[位階] 付与失敗:", e));
    }

    // ── カロン: 毎日 09:00 台に期限リスト・演出通知・迷霊落ち承認パネル ──
    if (now.hour === 9 && !services.settings.getString(`charon:daily:${now.dateStr}`)) {
      services.settings.set(`charon:daily:${now.dateStr}`, "1", "system:scheduler");
      await runCharonDaily(client, services);
    }

    // ── 14日経ってフォーラム未作成の亡霊は自動で迷霊に落とす（毎日 09:15）──
    if (now.hour === 9 && now.minute >= 15 && now.minute < 18) {
      const marker = `autodrop:noeval:${now.dateStr}`;
      if (!services.settings.getString(marker)) {
        services.settings.set(marker, "1", "system:scheduler");
        await autoDropNoEvalGhosts(client, services).catch((e) => console.error("[自動迷霊] 失敗:", e));
      }
    }

    // ── マモンの株式市場: 1時間ごとの価格更新 & 期限切れ強制売却 ──
    try {
      services.stocks.updateAll();
      const forced = services.stocks.forceSellExpired();
      if (forced.length > 0) console.log(`[stocks] 期限切れ強制売却: ${forced.length}件`);
    } catch (e) {
      console.error("[stocks] tick失敗:", e);
    }

    // ── 公式ショップの月額一括請求: 毎月1日 08:00 JST ──
    if (now.day === 1 && now.hour === 8) {
      const shopMarker = `shop:monthly:${now.period}`;
      if (!services.settings.getString(shopMarker)) {
        services.settings.set(shopMarker, "1", "system:scheduler");
        try {
          const { charged, lapsed } = services.shop.chargeMonthlySubscriptions("system:shop-monthly");
          console.log(`[ショップ] 月額一括: 課金 ${charged.length}件 / 失効 ${lapsed.length}件`);
          // 失効ユーザーへのDM＆ロール剥奪
          for (const l of lapsed) {
            const user = await client.users.fetch(l.purchase.user_id).catch(() => null);
            await user
              ?.send(`🛒 **${l.item.name}** の月額更新が失敗しました（${l.reason}）。当月末で権利が失効します。再購入は公式ショップから。`)
              .catch(() => undefined);
            // add_role の場合はロールを剥奪
            if (l.item.delivery_kind === "add_role" && l.item.delivery_data) {
              try {
                const data = JSON.parse(l.item.delivery_data) as { role_id?: string };
                if (data.role_id) {
                  const guildId = services.settings.getString("guild:main");
                  const guild = guildId ? await client.guilds.fetch(guildId).catch(() => null) : null;
                  const member = guild ? await guild.members.fetch(l.purchase.user_id).catch(() => null) : null;
                  await member?.roles.remove(data.role_id).catch(() => undefined);
                }
              } catch {
                /* noop */
              }
            }
          }
        } catch (e) {
          console.error("[ショップ] 月額一括処理失敗:", e);
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

  // ② 本人への演出通知（3日前・前日・当日、各1回）— DM＋通知チャンネルの両方
  //   通知チャンネルは channel:charon_notify のみ（集令は階級変動専用のためフォールバックしない）
  const notifyChId = services.settings.getString("channel:charon_notify");
  const notifyCh = notifyChId ? await client.channels.fetch(notifyChId).catch(() => null) : null;
  const upcoming = services.evaluation.dueBetween(nowTs, nowTs + 4 * DAY);
  for (const r of upcoming) {
    const daysLeft = Math.floor((r.eval_deadline_at - nowTs) / DAY);
    if (![3, 1, 0].includes(daysLeft)) continue;
    const marker = `charon:notified:${r.user_id}:${daysLeft}`;
    if (services.settings.getString(marker)) continue;
    services.settings.set(marker, "1", "system:charon");
    // 本人DM
    const user = await client.users.fetch(r.user_id).catch(() => null);
    await user
      ?.send(
        daysLeft === 0
          ? "🛶 **汝の審判は今日である。** 冥獄の魂たちは汝の姿を見ているか。"
          : `🛶 **汝の審判まで、あと${daysLeft}日。** 評価対象の場に姿を見せよ。`,
      )
      .catch(() => undefined);
    // チャンネル通知（本人メンション付き）
    if (notifyCh?.isTextBased() && "send" in notifyCh) {
      const p = services.evaluation.promotionScore(r.user_id);
      const line =
        daysLeft === 0
          ? `🛶 <@${r.user_id}> **審判の刻限は本日** <t:${r.eval_deadline_at}:t>。昇格印 **${p.total}/5**（残り時間で挽回するか、迷霊落ちを覚悟せよ）。`
          : `🛶 <@${r.user_id}> **審判まであと${daysLeft}日**（<t:${r.eval_deadline_at}:R>）。昇格印 **${p.total}/5**・評価対象VCで姿を示せ。`;
      await notifyCh
        .send({ content: line, allowedMentions: { users: [r.user_id] } })
        .catch(() => undefined);
    }
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

/**
 * 14日の評価期限を過ぎ、評価フォーラムのスレッドが1本も無い（＝誰にも評価されず）
 * 亡霊を自動で迷霊に落とす。フォーラムがある人はカロンの承認パスに委ねる（自動落とし対象外）。
 */
export async function autoDropNoEvalGhosts(client: Client, services: Services): Promise<void> {
  const guildId = services.settings.getString("guild:main");
  const guild = guildId ? await client.guilds.fetch(guildId).catch(() => null) : null;
  if (!guild) return;
  const ghostRoleId = services.settings.getString("role:ghost");
  const meireiRoleId = services.settings.getString("role:meirei");
  const nowTs = Math.floor(Date.now() / 1000);
  const ghosts = services.entry.listSouls("ghost");
  let dropped = 0;
  for (const soul of ghosts) {
    if (!soul.eval_deadline_at || soul.eval_deadline_at > nowTs) continue;
    if (services.evaluation.threadFor(soul.user_id)) continue; // フォーラム有り→カロンへ
    services.evaluation.demoteToMeirei(soul.user_id, "system:auto-drop", "14日以内に評価が付かなかった（フォーラム未作成）");
    const member = await guild.members.fetch(soul.user_id).catch(() => null);
    if (member) {
      if (ghostRoleId) await member.roles.remove(ghostRoleId).catch(() => undefined);
      if (meireiRoleId) await member.roles.add(meireiRoleId).catch(() => undefined);
    }
    dropped++;
  }
  if (dropped > 0) console.log(`[自動迷霊] ${dropped}名を落としました（フォーラム未作成・期限超過）`);
}
