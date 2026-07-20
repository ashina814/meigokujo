import { EmbedBuilder, type Client, type TextChannel } from "discord.js";
import { fmtLd } from "./format.js";
import { jstNow } from "./scheduler.js";
import type { Services } from "./services.js";

const TREASURY = "sys:treasury";

/** JSTの当月の開始・終了 unix秒（発行/回収の月次集計用） */
function monthBounds(): { start: number; end: number } {
  const n = jstNow();
  // JST基準の月初 00:00 を UTC unix に。JST = UTC+9
  const start = Date.UTC(n.year, n.month - 1, 1) / 1000 - 9 * 3600;
  const nextMonth = n.month === 12 ? 1 : n.month + 1;
  const nextYear = n.month === 12 ? n.year + 1 : n.year;
  const end = Date.UTC(nextYear, nextMonth - 1, 1) / 1000 - 9 * 3600;
  return { start, end };
}

/** 計器盤用の月次運用フロー。移行投入は月内の経済活動ではないため除外する。 */
function operationalFlowBetween(
  services: Services,
  fromTs: number,
  toTs: number,
): { issued: number; collected: number; net: number } {
  const row = services.db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN from_account = ? THEN amount ELSE 0 END), 0) AS issued,
         COALESCE(SUM(CASE WHEN to_account = ? THEN amount ELSE 0 END), 0) AS collected
       FROM transactions
       WHERE created_at >= ?
         AND created_at < ?
         AND (from_account = ? OR to_account = ?)
         AND actor_id != 'system:migration'
         AND type != 'opening'`,
    )
    .get(TREASURY, TREASURY, fromTs, toTs, TREASURY, TREASURY) as { issued: number; collected: number };

  return { issued: row.issued, collected: row.collected, net: row.issued - row.collected };
}

export function buildDashboardEmbed(services: Services): EmbedBuilder {
  const nowTs = Math.floor(Date.now() / 1000);
  const DAY = 86_400;

  // 経済
  const supply = services.ledger.moneySupply();
  const { start, end } = monthBounds();
  const flow = operationalFlowBetween(services, start, end);
  const escrow = services.ledger.escrowTotal();

  // 入城
  const q = services.entry.queueSummary();
  const oldestDays = q.oldestBookedAt ? Math.floor((nowTs - q.oldestBookedAt) / DAY) : 0;

  // 評価・カロン
  const dueSoon = services.evaluation.dueBetween(nowTs, nowTs + 2 * DAY).length;
  const overdue = services.evaluation.overdue(nowTs).length;

  // 治安・運用
  const openTickets = services.tickets.countOpen();
  const staleTickets = services.tickets.staleOpen(24).length;
  const openRooms = services.rooms.listOpen().length;

  const economy = [
    `通貨発行残高: **${fmtLd(supply)}**`,
    `今月 発行 ${fmtLd(flow.issued)} / 回収 ${fmtLd(flow.collected)} / 純増 **${flow.net >= 0 ? "+" : ""}${fmtLd(flow.net)}**（移行除外）`,
    `エスクロー・部署預り: ${fmtLd(escrow)}`,
  ].join("\n");

  const entry = [
    `説明会 予約待ち: **${q.booked}名**${q.booked > 0 ? `（最古 ${oldestDays}日前）` : ""}`,
    `入城案内待ち（未申請含む）: ${q.waiting}名`,
  ].join("\n");

  const evaluation = [
    `審判が近い（2日以内）: **${dueSoon}名**`,
    overdue > 0 ? `⚠️ 期限切れ・印不足: **${overdue}名**（#決裁で承認待ち）` : "期限切れ: なし",
  ].join("\n");

  const ops = [
    `対応中チケット: ${openTickets}件${staleTickets > 0 ? ` / ⚠️ 24h無応答 **${staleTickets}件**` : ""}`,
    `稼働中の部屋: ${openRooms}室`,
  ].join("\n");

  // 賭場（エテル経済圏の健全性監視。壊れ・exploit の早期検知用）
  const fmtE = (n: number) => `${n.toLocaleString("ja-JP")}◈`;
  const housePool = services.casino.houseBalance();
  const jpPool = services.casino.jackpotPool();
  const reliefPool = services.ether.balanceOf("relief");
  const etherOutstanding = services.ether.outstanding();
  const reservePool = services.ether.pool();
  const etherRate = services.ether.rate();
  const escrowRows = services.db.prepare("SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS c FROM casino_escrow").get() as { s: number; c: number };
  const casinoField = [
    `胴元: **${fmtE(housePool)}** / JP: ${fmtE(jpPool)} / 救済: ${fmtE(reliefPool)}`,
    `発行エテル: ${fmtE(etherOutstanding)} ⇄ 準備Land: ${fmtLd(reservePool)}（1Ld=${etherRate.toFixed(2)}◈）`,
    escrowRows.c > 0 ? `進行中の卓の預かり: ${fmtE(escrowRows.s)}（${escrowRows.c}口）` : "進行中の卓の預かり: なし",
  ].join("\n");

  // 部署口座（残高のある／登録済みの部署を上位から）
  const depts = services.departments
    .listWithBalance()
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 12);
  const deptField = depts.length > 0 ? depts.map((d) => `${d.name}: ${fmtLd(d.balance)}`).join("\n") : null;

  const alerts: string[] = [];
  if (overdue > 0) alerts.push(`迷霊落ち承認 ${overdue}名`);
  if (staleTickets > 0) alerts.push(`無応答チケット ${staleTickets}件`);
  if (oldestDays >= 3) alerts.push(`面接待ちが${oldestDays}日滞留`);

  const embed = new EmbedBuilder()
    .setTitle("🏰 城の計器盤")
    .setColor(alerts.length > 0 ? 0xf59e0b : 0x6b21a8)
    .addFields(
      { name: "💰 経済", value: economy },
      { name: "🚪 入城", value: entry },
      { name: "⚖️ 審判", value: evaluation },
      { name: "🛡 治安・運用", value: ops },
      { name: "🎰 賭場", value: casinoField },
      ...(deptField ? [{ name: "🏦 部署口座", value: deptField }] : []),
    )
    .setFooter({ text: `最終更新: ${jstNow().dateStr} ${String(jstNow().hour).padStart(2, "0")}:${String(jstNow().minute).padStart(2, "0")} JST` });
  if (alerts.length > 0) embed.setDescription(`🔔 **要対応:** ${alerts.join(" / ")}`);
  return embed;
}

/**
 * 計器盤の更新: 既存メッセージがあれば編集、なければ投稿してIDを保存。
 * 毎回投稿せず同じメッセージを書き換えることでチャンネルを汚さない。
 */
export async function updateDashboard(client: Client, services: Services): Promise<void> {
  const channelId = services.settings.getString("channel:keikiban");
  if (!channelId) {
    console.warn("[計器盤] channel:keikiban が未設定のため更新をスキップしました");
    return;
  }
  const channel = (await client.channels.fetch(channelId).catch(() => null)) as TextChannel | null;
  if (!channel?.isTextBased()) {
    console.error(`[計器盤] チャンネル ${channelId} を取得できません（削除/権限不足の可能性）`);
    return;
  }

  const embed = buildDashboardEmbed(services);
  const savedId = services.settings.getString("dashboard:message_id");

  if (savedId) { // 空文字は false 扱い（/計器盤 設置 で新規投稿させるためクリアされる）
    const msg = await channel.messages.fetch(savedId).catch(() => null);
    if (msg) {
      // 失敗を握り潰すと「静かに止まる」ため必ずログに出す（原因調査が不能になるのを防ぐ）
      try {
        await msg.edit({ embeds: [embed] });
      } catch (e) {
        console.error("[計器盤] 既存メッセージの更新に失敗:", e);
      }
      return;
    }
    console.warn(`[計器盤] 保存済みメッセージ ${savedId} が見つかりません。新規投稿します`);
  }
  try {
    const sent = await channel.send({ embeds: [embed] });
    await sent.pin().catch(() => undefined);
    services.settings.set("dashboard:message_id", sent.id, "system:dashboard");
    console.log(`[計器盤] 新規投稿しました: ${sent.id}`);
  } catch (e) {
    console.error("[計器盤] 新規投稿に失敗（送信権限を確認してください）:", e);
  }
}
