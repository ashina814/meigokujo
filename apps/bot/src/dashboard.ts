import { EmbedBuilder, type Client, type TextChannel } from "discord.js";
import { fmtLd } from "./format.js";
import type { Services } from "./services.js";

const TREASURY = "sys:treasury";
const ETHER_RESERVE = "sys:escrow:ether";
const LEGACY_CHIPS = "sys:escrow:chips";
const ESCROW_QUARANTINE = "sys:escrow:quarantine";
const ACTIVE_MARKET_STATUSES = ["open", "closed", "reported", "disputed"] as const;
const UNRESOLVED_MARKET_STATUSES = [...ACTIVE_MARKET_STATUSES, "frozen"] as const;

export interface LandSystemBreakdown {
  departmentTotal: number;
  etherReserve: number;
  otherSystem: number;
  legacyChips: number;
}

export interface EconomyHealthSummary {
  landMismatchCount: number;
  sessionEscrowMismatchCount: number;
  sessionEscrowMismatchDiff: number;
  marketEscrowMismatchCount: number;
  marketEscrowMismatchDiff: number;
  frozenMarketCount: number;
  unsettledMarketCount: number;
  unknownFundModeCount: number;
  quarantineBalance: number;
  activeLegacyHouseMarketCount: number;
}

export interface DashboardUpdateResult {
  ok: boolean;
  action: "edited" | "created" | "skipped" | "failed" | "joined";
  messageId?: string;
  reason?: string;
}

let dashboardUpdateInFlight: Promise<DashboardUpdateResult> | null = null;

function dashboardJstNow(date = new Date()): {
  year: number;
  month: number;
  hour: number;
  minute: number;
  dateStr: string;
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
    hour: get("hour") % 24,
    minute: get("minute"),
    dateStr: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

function tableExists(services: Services, table: string): boolean {
  const row = services.db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { ok: number } | undefined;
  return Boolean(row);
}

function scalar(services: Services, sql: string, ...params: unknown[]): number {
  const row = services.db.prepare(sql).get(...params) as { value: number } | undefined;
  return row?.value ?? 0;
}

export function getLandSystemBreakdown(services: Services): LandSystemBreakdown {
  const departmentTotal = scalar(
    services,
    "SELECT COALESCE(SUM(amount),0) AS value FROM balances WHERE account_id LIKE 'sys:dept:%'",
  );
  const etherReserve = services.ledger.balanceOf(ETHER_RESERVE);
  const legacyChips = services.ledger.balanceOf(LEGACY_CHIPS);
  const otherSystem = scalar(
    services,
    `SELECT COALESCE(SUM(amount),0) AS value
       FROM balances
      WHERE account_id LIKE 'sys:%'
        AND account_id != ?
        AND account_id NOT LIKE 'sys:dept:%'
        AND account_id NOT IN (?, ?)`,
    TREASURY,
    ETHER_RESERVE,
    LEGACY_CHIPS,
  );
  return { departmentTotal, etherReserve, otherSystem, legacyChips };
}

export function getEconomyHealthSummary(services: Services): EconomyHealthSummary {
  const land = services.ledger.verifyIntegrity();
  const session = services.escrow.verify();
  const sessionEscrowMismatchDiff = session.mismatches.reduce(
    (sum, m) => sum + Math.abs(m.expected - m.actual),
    0,
  );

  let marketEscrowMismatchCount = 0;
  let marketEscrowMismatchDiff = 0;
  let frozenMarketCount = 0;
  let unsettledMarketCount = 0;
  let unknownFundModeCount = 0;
  let activeLegacyHouseMarketCount = 0;
  if (tableExists(services, "casino_markets") && tableExists(services, "casino_market_bets")) {
    const unresolved = services.db
      .prepare(
        `SELECT
           m.id,
           m.status,
           m.fund_mode,
           COALESCE(SUM(b.amount), 0) AS pot,
           COALESCE(eb.amount, 0) AS escrow_balance
         FROM casino_markets m
         LEFT JOIN casino_market_bets b ON b.market_id = m.id
         LEFT JOIN ether_balances eb ON eb.user_id = 'escrow:market:' || m.id
         WHERE m.status IN (${UNRESOLVED_MARKET_STATUSES.map(() => "?").join(",")})
         GROUP BY m.id`,
      )
      .all(...UNRESOLVED_MARKET_STATUSES) as Array<{
      id: number;
      status: string;
      fund_mode: string;
      pot: number;
      escrow_balance: number;
    }>;

    for (const m of unresolved) {
      if (m.status === "frozen") frozenMarketCount++;
      if ((ACTIVE_MARKET_STATUSES as readonly string[]).includes(m.status)) unsettledMarketCount++;
      if (m.fund_mode !== "escrow" && m.fund_mode !== "legacy_house") unknownFundModeCount++;
      if (m.fund_mode === "legacy_house") activeLegacyHouseMarketCount++;
      if (m.fund_mode === "escrow" && m.pot !== m.escrow_balance) {
        marketEscrowMismatchCount++;
        marketEscrowMismatchDiff += Math.abs(m.pot - m.escrow_balance);
      }
    }
  }

  return {
    landMismatchCount: land.mismatches.length,
    sessionEscrowMismatchCount: session.mismatches.length,
    sessionEscrowMismatchDiff,
    marketEscrowMismatchCount,
    marketEscrowMismatchDiff,
    frozenMarketCount,
    unsettledMarketCount,
    unknownFundModeCount,
    quarantineBalance: services.ether.balanceOf(ESCROW_QUARANTINE),
    activeLegacyHouseMarketCount,
  };
}

function hasEconomyHealthAlert(summary: EconomyHealthSummary): boolean {
  return (
    summary.landMismatchCount > 0 ||
    summary.sessionEscrowMismatchCount > 0 ||
    summary.marketEscrowMismatchCount > 0 ||
    summary.frozenMarketCount > 0 ||
    summary.unknownFundModeCount > 0 ||
    summary.quarantineBalance > 0 ||
    summary.activeLegacyHouseMarketCount > 0
  );
}

function formatEconomyHealth(summary: EconomyHealthSummary, updatedAt: ReturnType<typeof dashboardJstNow>): string {
  const fmtE = (n: number) => `${n.toLocaleString("ja-JP")}◈`;
  const marketIssues: string[] = [];
  if (summary.marketEscrowMismatchCount > 0) {
    marketIssues.push(`pot不一致 ${summary.marketEscrowMismatchCount}件（差額 ${fmtE(summary.marketEscrowMismatchDiff)}）`);
  }
  if (summary.frozenMarketCount > 0) marketIssues.push(`frozen ${summary.frozenMarketCount}件`);
  if (summary.unknownFundModeCount > 0) marketIssues.push(`未知fund_mode ${summary.unknownFundModeCount}件`);
  if (summary.activeLegacyHouseMarketCount > 0) marketIssues.push(`legacy未精算 ${summary.activeLegacyHouseMarketCount}件`);

  return [
    summary.landMismatchCount === 0
      ? "会計検算: 正常"
      : `⚠️ 会計検算: 残高キャッシュ不一致 ${summary.landMismatchCount}件`,
    summary.sessionEscrowMismatchCount === 0
      ? "Escrow: 正常"
      : `⚠️ Escrow: session不一致 ${summary.sessionEscrowMismatchCount}件（差額 ${fmtE(summary.sessionEscrowMismatchDiff)}）`,
    marketIssues.length === 0 ? "市場異常: なし" : `⚠️ 市場異常: ${marketIssues.join(" / ")}`,
    `未精算市場: ${summary.unsettledMarketCount}件`,
    summary.quarantineBalance === 0 ? "隔離資金: なし" : `⚠️ 隔離資金: ${fmtE(summary.quarantineBalance)}`,
    `最終更新成功: ${updatedAt.dateStr} ${String(updatedAt.hour).padStart(2, "0")}:${String(updatedAt.minute).padStart(2, "0")} JST`,
  ].join("\n");
}

/** JSTの当月の開始・終了 unix秒（発行/回収の月次集計用） */
function monthBounds(): { start: number; end: number } {
  const n = dashboardJstNow();
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
  const updatedAt = dashboardJstNow();

  // 経済
  const supply = services.ledger.moneySupply();
  const { start, end } = monthBounds();
  const flow = operationalFlowBetween(services, start, end);
  const landBreakdown = getLandSystemBreakdown(services);
  const health = getEconomyHealthSummary(services);

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
    `部署口座合計: ${fmtLd(landBreakdown.departmentTotal)} / Ether準備Land: ${fmtLd(landBreakdown.etherReserve)}`,
    `その他システム口座: ${fmtLd(landBreakdown.otherSystem)} / ${landBreakdown.legacyChips > 0 ? "⚠️ " : ""}旧chips: ${fmtLd(landBreakdown.legacyChips)}`,
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
  if (landBreakdown.legacyChips > 0) alerts.push(`旧chips口座 ${fmtLd(landBreakdown.legacyChips)}`);
  if (hasEconomyHealthAlert(health)) alerts.push("経済健全性に要確認項目あり");

  const embed = new EmbedBuilder()
    .setTitle("🏰 城の計器盤")
    .setColor(alerts.length > 0 ? 0xf59e0b : 0x6b21a8)
    .addFields(
      { name: "💰 経済", value: economy },
      { name: "🧭 経済健全性", value: formatEconomyHealth(health, updatedAt) },
      { name: "🚪 入城", value: entry },
      { name: "⚖️ 審判", value: evaluation },
      { name: "🛡 治安・運用", value: ops },
      { name: "🎰 賭場", value: casinoField },
      ...(deptField ? [{ name: "🏦 部署口座", value: deptField }] : []),
    )
    .setFooter({ text: `最終更新: ${updatedAt.dateStr} ${String(updatedAt.hour).padStart(2, "0")}:${String(updatedAt.minute).padStart(2, "0")} JST` });
  if (alerts.length > 0) embed.setDescription(`🔔 **要対応:** ${alerts.join(" / ")}`);
  return embed;
}

/**
 * 計器盤の更新: 既存メッセージがあれば編集、なければ投稿してIDを保存。
 * 毎回投稿せず同じメッセージを書き換えることでチャンネルを汚さない。
 */
export async function updateDashboard(client: Client, services: Services): Promise<DashboardUpdateResult> {
  if (dashboardUpdateInFlight) {
    const result = await dashboardUpdateInFlight;
    return { ...result, action: "joined" };
  }
  dashboardUpdateInFlight = performDashboardUpdate(client, services);
  try {
    return await dashboardUpdateInFlight;
  } finally {
    dashboardUpdateInFlight = null;
  }
}

async function performDashboardUpdate(client: Client, services: Services): Promise<DashboardUpdateResult> {
  const channelId = services.settings.getString("channel:keikiban");
  if (!channelId) {
    const reason = "channel:keikiban が未設定です";
    console.warn(`[計器盤] ${reason}`);
    return { ok: false, action: "skipped", reason };
  }
  const channel = (await client.channels.fetch(channelId).catch(() => null)) as TextChannel | null;
  if (!channel?.isTextBased()) {
    const reason = `チャンネル ${channelId} を取得できません`;
    console.error(`[計器盤] ${reason}（削除/権限不足の可能性）`);
    return { ok: false, action: "failed", reason };
  }

  const embed = buildDashboardEmbed(services);
  const savedId = services.settings.getString("dashboard:message_id");

  if (savedId) { // 空文字は false 扱い（/計器盤 設置 で新規投稿させるためクリアされる）
    let fetchError: unknown;
    const msg = await channel.messages.fetch(savedId).catch((e) => {
      fetchError = e;
      return null;
    });
    if (msg) {
      // 失敗を握り潰すと「静かに止まる」ため必ずログに出す（原因調査が不能になるのを防ぐ）
      try {
        await msg.edit({ embeds: [embed] });
      } catch (e) {
        console.error("[計器盤] 既存メッセージの更新に失敗:", e);
        return { ok: false, action: "failed", messageId: savedId, reason: "既存メッセージの編集に失敗しました" };
      }
      return { ok: true, action: "edited", messageId: savedId };
    }
    const code = typeof fetchError === "object" && fetchError && "code" in fetchError ? (fetchError as { code?: unknown }).code : undefined;
    if (fetchError && code !== 10008) {
      console.error("[計器盤] 保存済みメッセージの取得に失敗:", fetchError);
      return { ok: false, action: "failed", messageId: savedId, reason: "保存済みメッセージの取得に失敗しました" };
    }
    console.warn(`[計器盤] 保存済みメッセージ ${savedId} が見つかりません。新規投稿します`);
  }
  try {
    const sent = await channel.send({ embeds: [embed] });
    await sent.pin().catch(() => undefined);
    services.settings.set("dashboard:message_id", sent.id, "system:dashboard");
    console.log(`[計器盤] 新規投稿しました: ${sent.id}`);
    return { ok: true, action: "created", messageId: sent.id };
  } catch (e) {
    console.error("[計器盤] 新規投稿に失敗（送信権限を確認してください）:", e);
    return { ok: false, action: "failed", reason: "新規投稿に失敗しました" };
  }
}
