import {
  decisionModal as subDecisionModal,
  activeSubAccountPanel,
  handleSubAccountApprove,
  handleSubAccountDeactivation,
  handleSubAccountDecision,
  subAccountDeactivationConfirm,
  subAccountReviewPanel,
} from "./sub-account-admin.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  RoleSelectMenuBuilder,
  RoleSelectMenuInteraction,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
  type Client,
  type GuildMember,
  type MessageCreateOptions,
} from "discord.js";
import { createHash } from "node:crypto";
import { ShopError, type ManualCompletionReason, type PurchaseRow, type ShopItemRow } from "@meigokujo/core";
import { fmtLd } from "../format.js";
import { isAdmin } from "../permissions.js";
import { requirementLabel } from "../rank-requirement.js";
import { redeliverPurchase } from "../shop-delivery.js";
import {
  decisionModal,
  handleOriginalRoleApprove,
  handleOriginalRoleDecision,
  originalRoleReviewPanel,
} from "./original-role-admin.js";
import type { Services } from "../services.js";

/**
 * 冥界商館スタッフの常設パネルと `/商館`。
 *
 * **通知を仕事の正本にしない。** 以前は手動配送の依頼が #決裁 へ流れ、その
 * メッセージの「配送完了」ボタンだけが完了手段だった。流れて見失うと復旧できず、
 * 実際に購入 #1 が1か月放置された。ここでは「いま何が残っているか」を常設パネルから
 * 必ず引けるようにし、通知は**変化を知らせるだけ**にする。
 *
 * 出すのは「これからやる仕事」だけ。本日完了・差し戻し中のような
 * 見て終わりの一覧は置かない。
 */
export const shokanCommand = new SlashCommandBuilder()
  .setName("商館")
  .setDescription("冥界商館の管理（要対応・商品設定）")
  .setDMPermission(false);

const SHOKAN_DEPT_KEY = "冥界商館";
const HISTORY_PAGE = 20;
const REEVAL_COMPENSATION_PAGE = 25;
const REEVAL_COMPENSATION_AUTH_MESSAGE =
  "例外補償の確定は獄卒判断として、運営権限を持つ方だけが実行できます。";
/** 1画面に出す件数。出したものには必ず操作ボタンを付ける（数だけ見せて押せない、を作らない） */
const QUEUE_DISPLAY = 8;

function canOperate(
  interaction:
    | ButtonInteraction
    | ChatInputCommandInteraction
    | StringSelectMenuInteraction
    | RoleSelectMenuInteraction
    | ModalSubmitInteraction,
  services: Services,
): boolean {
  if (isAdmin(interaction, services)) return true;
  const dept = services.departments.get(SHOKAN_DEPT_KEY);
  if (!dept?.role_id) return false;
  const member = interaction.member as GuildMember | null;
  return member?.roles.cache.has(dept.role_id) ?? false;
}

/**
 * 手動対応の作業キュー。
 *
 * 除外は**Shop側がpurchase固有の証拠で行う**。ここで現在の設定（再評価商品ID等）を
 * 渡してはいけない——普通の商品を後から専用商品に指定しただけで、過去の普通の購入まで
 * キューから消えてしまう。
 */
function pendingManual(services: Services): Array<PurchaseRow & { item_name: string }> {
  return services.shop.listPendingManual({ limit: QUEUE_DISPLAY });
}

/** 自動配送が終わっていない購入（＝Botが自力で終われなかったもの） */
function failedAuto(services: Services): Array<PurchaseRow & { item_name: string }> {
  return services.shop.listUndeliveredAuto(QUEUE_DISPLAY);
}

/** 残件数。**表示上限で数えない**（11件目以降も正しく出す） */
function queueCounts(services: Services): {
  pending: number;
  failed: number;
  stuck: number;
  refundOpen: number;
  blockedRevocations: number;
} {
  return {
    pending: services.shop.countPendingManual(),
    failed: services.shop.countUndeliveredAuto(),
    // 提供できたか確認できていない案件（外部配送の未確定 + 旧購入の不明）。
    // **どちらも「開いて決着させる」同じ作業**なので、1つのキューにまとめる。
    // 旧購入だけを別に見せる導線は持たない——同じ案件が「操作できる場所」と
    // 「見るだけの場所」の2箇所に出ると、どちらが正本か分からなくなる。
    stuck: services.shop.countUnresolvedCases(),
    // **返金しようとして失敗した購入。** 「配れなかったので配り直す」ではなく
    // 「返せなかったので返し直す」案件なので、処理失敗とは別に数える
    refundOpen: services.shop.countRefundFailures(),
    // **どの巡回も触らない剥奪。** worker は pending しか拾わないので、
    // blocked として failed に落ちた行は人が見るまで永久に残る
    blockedRevocations: services.shop.countBlockedRoleRevocations(),
  };
}

/**
 * **商館スタッフが実際に手を動かす仕事の総数。**
 *
 * ここに入らないものは「仕事はありません」を覆さない。逆にここへ入れたものは
 * 必ず商館から辿れて、商館スタッフの権限で終わらせられること。
 * 剥奪の `blocked` は商館では処理できない（運営判断が要る）ので**含めない**。
 */
function merchantWorkTotal(c: { pending: number; failed: number; stuck: number; refundOpen: number }): number {
  return c.pending + c.failed + c.stuck + c.refundOpen;
}

/** 表示しきれなかった分の注記。押せないボタンを並べる代わりに件数で伝える */
function overflowNote(shown: number, total: number): string[] {
  return total > shown ? ["", `-# ほか **${total - shown}件**（対応すると次が出ます）`] : [];
}

function backButton() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("shokan:hub").setLabel("← 商館ハブ").setStyle(ButtonStyle.Secondary),
  );
}

function fmtJstDate(unixSec: number): string {
  const d = new Date((unixSec + 9 * 3600) * 1000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCFullYear()}/${mm}/${dd} ${hh}:${mi}`;
}

/**
 * 商館スタッフの常設パネル。
 * 個人ごとの情報は載せない（押した後の ephemeral で出す）ので、そのまま設置できる。
 */
export function shopAdminPanelMessage(services: Services): MessageCreateOptions {
  const counts = queueCounts(services);
  const work = merchantWorkTotal(counts);
  const oroleLegacy = services.originalRoles.countByStatus("pending");
  const subPending = services.subAccounts.countByStatus("pending");
  const embed = new EmbedBuilder()
    .setTitle("🛠 冥界商館 管理")
    .setColor(work > 0 ? 0xdc2626 : counts.blockedRevocations > 0 ? 0xf59e0b : 0x64748b)
    .setDescription(
      [
        work > 0 ? `**対応が必要な仕事: ${work}件**` : "対応が必要な仕事はありません。",
        // **商館スタッフの仕事には数えないが、存在は必ず見せる。**
        // 自動では進まず、人へ渡さない限り永久に止まるので、トップから発見できないと
        // 「誰も知らないまま止まり続ける」になる
        counts.blockedRevocations > 0
          ? `🧭 運営判断が必要: ${counts.blockedRevocations}件（商館では処理できません → 「対応が必要」で内容を確認）`
          : "",
        oroleLegacy > 0 ? `オリジナルロールのカルテ移行待ち: ${oroleLegacy}件` : "",
        subPending > 0 ? `サブ垢の審査待ち: ${subPending}件` : "",
        "",
        "-# 通知はお知らせです。やることは必ずここから開けます。",
      ]
        .filter((line, i, all) => line !== "" || i === all.length - 2)
        .join("\n"),
    );
  // **仕事の入口は1つ。** 中で種類ごとに分かれていても、現場が最初に押す場所は増やさない
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("shokan:work")
      .setLabel(work > 0 ? `対応が必要 ${work}` : counts.blockedRevocations > 0 ? "対応が必要（運営判断あり）" : "対応が必要")
      .setEmoji("📥")
      .setStyle(work > 0 || counts.blockedRevocations > 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("shokan:list").setLabel("商品設定").setEmoji("📦").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("shokan:orole")
      .setLabel(oroleLegacy > 0 ? `旧オリロ移行 ${oroleLegacy}` : "オリジナルロール")
      .setEmoji("🎨")
      .setStyle(oroleLegacy > 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("shokan:sub")
      .setLabel(subPending > 0 ? `サブ垢 ${subPending}` : "サブ垢")
      .setEmoji("👥")
      .setStyle(subPending > 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("shokan:history:0").setLabel("購入履歴").setEmoji("📜").setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("shokan:reeval-comp").setLabel("再評価の例外補償").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row, row2] };
}

/**
 * 「対応が必要」の中身。**非0のものだけを、やることの言葉で出す。**
 *
 * `failed` / `uncertain` / `claim` のような内部の状態名は出さない。
 * 商館スタッフが読むのは「何をするか」だけでよい。
 */
function renderWorkHub(services: Services) {
  const c = queueCounts(services);
  const work = merchantWorkTotal(c);
  const entries: Array<{ id: string; emoji: string; label: string; count: number; what: string }> = [
    { id: "shokan:pending", emoji: "🔴", label: "手動で対応する", count: c.pending, what: "スタッフが手で提供する購入です。" },
    { id: "shokan:failed", emoji: "🔁", label: "配送をやり直す", count: c.failed, what: "自動で配れなかった購入です。もう一度配ります。" },
    {
      id: "shokan:stuck-delivery:0",
      emoji: "🔎",
      label: "提供状況を確認する",
      count: c.stuck,
      what: "提供できたか分からない購入です。事実を確認して決着させます。",
    },
    {
      id: "shokan:refund-open:0",
      emoji: "💰",
      label: "返金をやり直す",
      count: c.refundOpen,
      what: "返金しようとして失敗した購入です。お金がまだ戻っていません。",
    },
  ];
  const open = entries.filter((e) => e.count > 0);
  const embed = new EmbedBuilder()
    .setTitle("📥 対応が必要")
    .setColor(work > 0 ? 0xdc2626 : 0x16a34a)
    .setDescription(
      work === 0
        ? "対応が必要な仕事はありません。"
        : open.map((e) => `${e.emoji} **${e.label}　${e.count}件**\n-# ${e.what}`).join("\n\n"),
    );
  if (c.blockedRevocations > 0) {
    // 商館では処理できない。**数字だけ出して終わりにしない**ので、誰へ渡すかまで書く
    embed.addFields({
      name: "🧭 運営判断が必要（商館では処理できません）",
      value: [
        `期限切れの後片付け ${c.blockedRevocations}件 が自動では進みません。`,
        "購入時に何を渡したのか証明できないため、商館側から取り消す操作は用意していません。",
        "**運営へ「商館の期限切れ後片付けが止まっている」と伝えてください。**",
      ].join("\n"),
      inline: false,
    });
  }
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  if (open.length > 0) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...open.map((e) =>
          new ButtonBuilder()
            .setCustomId(e.id)
            .setLabel(`${e.label} ${e.count}`)
            .setEmoji(e.emoji)
            .setStyle(ButtonStyle.Primary),
        ),
      ),
    );
  }
  rows.push(backButton());
  return { embeds: [embed], components: rows };
}

/**
 * 設置済みの管理パネルを、いまの残件数で描き直す。
 *
 * 仕事が増減したときだけ呼ぶ。届かなくても実害は無い（数字が古くなるだけで、
 * 押せば必ず最新が出る）ので best effort でよい。
 */
export async function refreshShopAdminPanels(client: Client, services: Services): Promise<void> {
  const rows = services.db
    .prepare("SELECT key, value FROM settings WHERE key LIKE 'panel:shop_admin:%'")
    .all() as Array<{ key: string; value: string }>;
  if (rows.length === 0) return;
  const payload = shopAdminPanelMessage(services);
  for (const row of rows) {
    const channelId = row.key.split(":")[2];
    if (!channelId) continue;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased() || !("messages" in channel)) continue;
    const message = await channel.messages.fetch(row.value).catch(() => null);
    await message?.edit({ embeds: payload.embeds, components: payload.components }).catch(() => undefined);
  }
}

/**
 * 表示した案件のぶんだけボタンを作る。
 * **一覧に出したものには必ず操作を付ける**（数だけ見せて押せない、を作らない）。
 */
function queueButtons(
  rows: Array<{ id: number }>,
  build: (id: number) => ButtonBuilder,
): ActionRowBuilder<ButtonBuilder>[] {
  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  for (const row of rows) {
    const last = components.at(-1);
    if (last && last.components.length < 2) last.addComponents(build(row.id));
    else components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(build(row.id)));
  }
  return components;
}

/**
 * 完了にできなかった理由を運営へ伝える。**内部の状態名やエラーコードは出さない。**
 * 「何が起きたか」と「次に何をすればいいか」だけを書く。
 */
function manualCompletionMessage(id: number, reason: ManualCompletionReason): string {
  switch (reason) {
    case "already_delivered":
      return `購入 #${id} はすでに対応済みです。`;
    case "not_active":
      return `購入 #${id} は現在、対応完了にできる状態ではありません。一覧を更新してください。`;
    case "legacy_unknown":
      return [
        `購入 #${id} は旧購入のため、購入時の提供方式を自動で判定できません。`,
        "提供状況を確認してください。",
      ].join("\n");
    case "not_manual":
      return `購入 #${id} はここで完了にする対象ではありません。専用の手続きから進めてください。`;
    default:
      return `購入 #${id} は完了にできませんでした。一覧を更新してください。`;
  }
}


function renderPending(services: Services) {
  const rows = pendingManual(services);
  const total = services.shop.countPendingManual();
  const embed = new EmbedBuilder().setTitle("🔴 要対応").setColor(0xdc2626);
  if (rows.length === 0) {
    embed.setDescription("対応待ちはありません。");
    return { embeds: [embed], components: [backButton()], allowedMentions: { parse: [] as never[] } };
  }
  embed.setDescription(
    [
      ...rows.map((p) => `\`#${p.id}\` **${p.item_name}** — <@${p.user_id}>（${fmtJstDate(p.purchased_at)}）`),
      ...overflowNote(rows.length, total),
    ].join("\n"),
  );
  embed.setFooter({ text: `対応が終わったら「完了」を押してください（全 ${total}件）。` });
  const components = queueButtons(rows, (id) =>
    new ButtonBuilder().setCustomId(`shokan:deliver:${id}`).setLabel(`#${id} 完了`).setEmoji("📦").setStyle(ButtonStyle.Success),
  );
  return { embeds: [embed], components: [...components, backButton()], allowedMentions: { parse: [] as never[] } };
}

function renderFailed(services: Services) {
  const rows = failedAuto(services);
  const total = services.shop.countUndeliveredAuto();
  const embed = new EmbedBuilder().setTitle("⚠️ 処理失敗").setColor(0xdc2626);
  if (rows.length === 0) {
    embed.setDescription("Botが終われなかった処理はありません。");
    return { embeds: [embed], components: [backButton()], allowedMentions: { parse: [] as never[] } };
  }
  embed.setDescription(
    [
      ...rows.map(
        (p) =>
          `\`#${p.id}\` **${p.item_name}** — <@${p.user_id}>\n　${p.delivery_error ? `理由: ${p.delivery_error.slice(0, 80)}` : "未実行"}（${p.delivery_attempts}回試行）`,
      ),
      ...overflowNote(rows.length, total),
    ].join("\n"),
  );
  embed.setFooter({ text: `原因を直してから再試行してください。二度配ることはありません（全 ${total}件）。` });
  const components = queueButtons(rows, (id) =>
    new ButtonBuilder().setCustomId(`shokan:retry:${id}`).setLabel(`#${id} 再試行`).setEmoji("🔁").setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [...components, backButton()], allowedMentions: { parse: [] as never[] } };
}

function renderHistory(services: Services, offset: number) {
  const total = services.shop.countPurchases();
  const rows = services.shop.listRecentPurchases(HISTORY_PAGE, offset);
  const embed = new EmbedBuilder().setTitle("📜 購入履歴").setColor(0xdb2777);
  if (total === 0) {
    embed.setDescription("購入履歴はまだありません。");
    return { embeds: [embed], components: [backButton()] };
  }
  const lines = rows.map((p) => {
    const priceStr = p.paid_land !== null ? fmtLd(p.paid_land) : p.paid_alt_kind ? `${p.paid_alt_kind} ${p.paid_alt_amount}` : "—";
    const pendingManualRow = p.item_delivery === "manual" && p.delivered_at === null && p.status === "active";
    const statusIcon = p.status === "expired" ? "⚫" : pendingManualRow ? "📦" : p.delivered_at ? "✅" : "🟢";
    return `${statusIcon} \`#${p.id}\` ${fmtJstDate(p.purchased_at)} — <@${p.user_id}> **${p.item_name}** — ${priceStr}`;
  });
  embed.setDescription(lines.join("\n"));
  embed.setFooter({ text: `${offset + 1}〜${offset + rows.length} / 全 ${total} 件（📦=手動対応待ち, ✅=対応済, 🟢=自動処理済/契約中, ⚫=期限切れ）` });
  const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`shokan:history:${Math.max(0, offset - HISTORY_PAGE)}`)
      .setLabel("新しい方へ")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(offset === 0),
    new ButtonBuilder()
      .setCustomId(`shokan:history:${offset + HISTORY_PAGE}`)
      .setLabel("古い方へ")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(offset + rows.length >= total),
  );
  return { embeds: [embed], components: [nav, backButton()], allowedMentions: { parse: [] as never[] } };
}

function renderList(services: Services) {
  const items = services.shop.listItems();
  const embed = new EmbedBuilder().setTitle("📦 商品設定").setColor(0xdb2777);
  if (items.length === 0) {
    embed.setDescription("商品がありません。");
    return { embeds: [embed], components: [backButton()] };
  }
  // 商品の新規作成はここから行わない。Botが処理方法を知らない商品を作れてしまうと、
  // 必ず「買えるが誰も終わらせられない」手動対応に戻る
  embed.setDescription(
    [
      ...items.slice(0, 25).map((it) => {
        const price = it.price_land !== null ? fmtLd(it.price_land) : "—";
        const mark = it.enabled ? "🟢" : services.shop.isSalesLocked(it) ? "🔒" : "⚫";
        return `${mark} \`#${it.id}\` **${it.name}** — ${price} / ${it.duration_days ? `${it.duration_days}日間` : "単発"}`;
      }),
      "",
      "-# 変更できるのは 名前・価格・説明・階級要件・販売のON/OFF です。",
    ].join("\n"),
  );
  const menu = new StringSelectMenuBuilder()
    .setCustomId("shokan:pick")
    .setPlaceholder("編集する商品を選ぶ")
    .addOptions(
      items.slice(0, 25).map((it) => ({
        label: `${it.enabled ? "" : "[停止中] "}${it.name}`.slice(0, 100),
        value: String(it.id),
        description: `${it.price_land !== null ? fmtLd(it.price_land) : "—"} / ${it.duration_days ? `${it.duration_days}日間` : "単発"}`.slice(0, 100),
      })),
    );
  return { embeds: [embed], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), backButton()] };
}

function renderItem(item: ShopItemRow, services: Services) {
  const embed = new EmbedBuilder()
    .setTitle(`📦 ${item.name}`)
    .setColor(item.enabled ? 0xdb2777 : 0x6b7280)
    .addFields(
      { name: "説明", value: item.description ?? "（説明なし）" },
      { name: "価格 (Land)", value: item.price_land !== null ? fmtLd(item.price_land) : "—", inline: true },
      { name: "代替価格", value: item.price_alt_kind ? `${item.price_alt_kind} ${item.price_alt_amount}` : "—", inline: true },
      { name: "期間", value: item.duration_days ? `${item.duration_days}日間` : "単発", inline: true },
      { name: "階級要件", value: requirementLabel(services.settings, item.require_role_id), inline: true },
      { name: "配送", value: item.delivery === "auto" ? "自動" : "手動（スタッフ対応）", inline: true },
      { name: "在庫", value: stockLabel(item, services), inline: true },
      {
        name: "状態",
        value: item.enabled ? "🟢 販売中" : services.shop.isSalesLocked(item) ? "🔒 移行待ち（再開不可）" : "⚫ 停止中",
        inline: true,
      },
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`shokan:edit-basic:${item.id}`).setLabel("名前・価格・説明").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`shokan:edit-role:${item.id}`).setLabel("階級要件").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`shokan:edit-stock:${item.id}`).setLabel("在庫").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`shokan:toggle:${item.id}`)
      .setLabel(item.enabled ? "販売を止める" : services.shop.isSalesLocked(item) ? "移行待ち" : "販売する")
      .setStyle(item.enabled ? ButtonStyle.Danger : ButtonStyle.Success)
      .setDisabled(!item.enabled && services.shop.isSalesLocked(item)),
  );
  return { embeds: [embed], components: [row, backButton()] };
}

export async function handleShokanCommand(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  if (!canOperate(interaction, services)) {
    await interaction.reply({
      content: "この操作には運営または「冥界商館」部署の担当ロールが必要です。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.reply({ ...shopAdminPanelMessage(services), flags: MessageFlags.Ephemeral });
}

/**
 * 在庫の表示。**未処理の返金在庫があるなら必ず一緒に出す。**
 * 数字だけ見せると、有限在庫を確定するときに何が起きるか運営が判断できない。
 */
function stockLabel(item: ShopItemRow, services: Services): string {
  const pending = services.shop.pendingStockRestorations(item.id);
  const base = item.stock === null ? "無制限" : `${item.stock}個`;
  return pending.quantity > 0 ? `${base}\n未処理の返金在庫: ${pending.quantity}個` : base;
}

function stockModal(id: number, item: ShopItemRow): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`shokan:edit-stock:${id}`)
    .setTitle(`#${id} 在庫`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("stock")
          .setLabel("在庫数（空欄で無制限）")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue(item.stock === null ? "" : String(item.stock)),
      ),
    );
}

/**
 * 有限在庫を確定するとき、未処理の返金在庫をどう扱うかを**運営に選ばせる**。
 * 現在すでに有限で義務だけ残っている商品もあるので、「戻す」とは限らない。
 * 黙って上乗せもしないし、黙って握りつぶしもしない。
 */
function stockReconciliationPrompt(quote: ReturnType<Services["shop"]["quoteStockChange"]>, itemName: string) {
  const n = quote.requestedStock ?? 0;
  const x = quote.pending.quantity;
  const embed = new EmbedBuilder()
    .setTitle("未処理の返金在庫があります")
    .setColor(0xf59e0b)
    .setDescription(
      [
        // **現在の在庫は quote が持っている事実をそのまま出す。**
        // 未処理義務は無制限のあいだにしか作られないが、そのあと運営が有限へ戻して
        // 義務だけ残っている商品もある（Phase F 以前からの持ち越し）。決め打ちで
        // 「現在 無制限」と書くと、そういう商品で表示が事実と食い違う。
        `**${itemName}** の現在の在庫: **${quote.currentStock === null ? "無制限" : `${quote.currentStock}個`}**`,
        `未処理の返金在庫: **${x}個**`,
        `入力した **${n}** をどう扱うか選んでください。`,
      ].join("\n"),
    )
    .addFields(
      { name: "入力値を最終在庫にする", value: `販売可能数は **${n}個**（返金分${x}個はこの中に含める）`, inline: false },
      { name: "返金分を上乗せする", value: `販売可能数は **${n + x}個**（${n} + 返金分${x}）`, inline: false },
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`shokan:stock-fix:final_stock:${quote.itemId}:${n}:${quote.tokens.final_stock}`)
      .setLabel(`最終在庫 ${n}個にする`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`shokan:stock-fix:add_restorations:${quote.itemId}:${n}:${quote.tokens.add_restorations}`)
      .setLabel(`${n} + ${x} = ${n + x}個にする`)
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row], flags: MessageFlags.Ephemeral };
}

async function applyStockChangeFromModal(
  interaction: ModalSubmitInteraction,
  services: Services,
  itemId: number,
  requestedStock: number | null,
  token: string,
): Promise<void> {
  try {
    const result = services.shop.applyStockChange({
      itemId,
      requestedStock,
      reconciliationMode: "none",
      expectedToken: token,
      actor: `user:${interaction.user.id}`,
    });
    await interaction.reply({
      content: `✅ 商品 #${itemId} の在庫を **${result.newStock === null ? "無制限" : `${result.newStock}個`}** にしました。`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    const code = error instanceof ShopError ? error.code : undefined;
    await interaction.reply({
      content: code === "ERR_STOCK_TERMS_CHANGED" ? STOCK_STALE_MESSAGE : `⚠️ 在庫を変更できませんでした（${code ?? "不明なエラー"}）。`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

const STOCK_STALE_MESSAGE =
  "⚠️ 表示したあとに在庫か返金の状況が変わりました。**何も変更していません。** もう一度「在庫」からやり直してください。";

async function applyStockFix(
  interaction: ButtonInteraction,
  services: Services,
  mode: "final_stock" | "add_restorations" | "none",
  itemId: number,
  requestedStock: number | null,
  token: string,
): Promise<void> {
  try {
    const result = services.shop.applyStockChange({
      itemId,
      requestedStock,
      reconciliationMode: mode,
      expectedToken: token,
      actor: `user:${interaction.user.id}`,
    });
    const settled = result.settledQuantity > 0 ? `（返金在庫 ${result.settledQuantity}個を${mode === "add_restorations" ? "上乗せ" : "この数に含めて"}処理）` : "";
    await interaction.reply({
      content: `✅ 商品 #${itemId} の在庫を **${result.newStock === null ? "無制限" : `${result.newStock}個`}** にしました。${settled}`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    const code = error instanceof ShopError ? error.code : undefined;
    await interaction.reply({
      content: code === "ERR_STOCK_TERMS_CHANGED" ? STOCK_STALE_MESSAGE : `⚠️ 在庫を変更できませんでした（${code ?? "不明なエラー"}）。`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

/**
 * 決着していない外部配送の一覧。
 *
 * **内部のtokenや状態名は出さない。** 運営が知りたいのは「誰の何が、いつから
 * 宙ぶらりんで、なぜ自動返金されていないのか」だけ。危険なワンクリック操作は置かない。
 */
const CASE_PAGE = 5;

function renderStuckDeliveries(services: Services, offset = 0) {
  const total = services.shop.countUnresolvedCases();
  // **全件を辿れるようにする。** 先頭を保留し続けても後ろへ進める
  const start = total === 0 ? 0 : Math.min(Math.max(0, offset), Math.max(0, total - 1));
  const cases = services.shop.listUnresolvedCases({ limit: CASE_PAGE, offset: start });
  const embed = new EmbedBuilder()
    .setTitle("🛰 確認待ちの案件")
    .setColor(total > 0 ? 0xdc2626 : 0x64748b)
    .setDescription(
      total === 0
        ? "確認待ちの案件はありません。"
        : [
            "**提供できたか確認できていないため、自動では返金も完了もしていません。**",
            "提供済みなのに返金する／未提供なのに提供済みにする、のどちらも避けています。",
            "",
            "-# 事実を確認したら「開く」から決着させてください。",
          ].join("\n"),
    );
  if (total > 0) {
    embed.setFooter({ text: `${start + 1}〜${start + cases.length} / ${total}件` });
  }
  for (const row of cases) {
    embed.addFields({
      name: `購入 #${row.purchaseId} — ${row.itemName}`,
      value: [
        `利用者: <@${row.userId}>`,
        `提供方式: ${deliveryKindLabel(row.deliveryKind)}`,
        `購入: ${fmtJstDate(row.purchasedAt)}`,
        `止まっている理由: ${stuckReasonLabel(row.reason)}`,
        `止まってから: ${fmtJstDate(row.stuckSince)}`,
      ].join("\n"),
      inline: false,
    });
  }
  const open = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...cases.map((row) =>
      new ButtonBuilder()
        .setCustomId(`shokan:case:${row.purchaseId}`)
        .setLabel(`#${row.purchaseId} を開く`)
        .setStyle(ButtonStyle.Primary),
    ),
  );
  const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`shokan:stuck-delivery:${Math.max(0, start - CASE_PAGE)}`)
      .setLabel("← 前へ")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(start === 0),
    new ButtonBuilder()
      .setCustomId(`shokan:stuck-delivery:${start + CASE_PAGE}`)
      .setLabel("次へ →")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(start + cases.length >= total),
    new ButtonBuilder().setCustomId("shokan:hub").setLabel("← 商館ハブ").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: cases.length > 0 ? [open, nav] : [backButton()] };
}

function stuckReasonLabel(reason: string): string {
  if (reason.startsWith("external_")) return "外部（Discord）の状態を確認できていない";
  if (reason === "legacy_unknown") return "購入時の記録が無く、提供したか判断できない";
  return reason;
}

const DECISION_LABEL: Record<string, string> = {
  delivered: "提供済みだった",
  no_effect: "提供されていなかった",
  still_unknown: "まだ判断できない",
};

/**
 * 案件の詳細。**ここまでは何も変えない。**
 * 決着は「選ぶ → 何が起きるか見る → 確定」の3段にする。
 */
function renderCase(services: Services, purchaseId: number) {
  const quote = services.shop.quoteOperatorResolution(purchaseId);
  const history = services.shop.operatorResolutions(purchaseId);
  const embed = new EmbedBuilder()
    .setTitle(`案件 購入 #${purchaseId}`)
    .setColor(quote.kind === null ? 0x16a34a : 0xf59e0b)
    .addFields(
      { name: "利用者", value: `<@${quote.userId}>`, inline: true },
      { name: "商品", value: quote.itemName, inline: true },
      { name: "購入", value: fmtJstDate(quote.purchasedAt), inline: true },
      { name: "提供方式", value: deliveryKindLabel(quote.deliveryKind), inline: true },
      { name: "購入の状態", value: purchaseStatusLabel(quote.status), inline: true },
      { name: "支払い", value: fmtLd(quote.refundableAmount), inline: true },
      {
        name: "止まっている理由",
        value: quote.kind === null ? "決着済みです。" : stuckReasonLabel(quote.reason),
        inline: false,
      },
    );
  if (history.length > 0) {
    embed.addFields({
      name: "これまでの判断",
      value: history
        .slice(0, 3)
        .map((row) => `${fmtJstDate(row.resolved_at)} ${DECISION_LABEL[row.decision] ?? row.decision}${row.note ? ` — ${row.note}` : ""}`)
        .join("\n"),
      inline: false,
    });
  }
  if (quote.kind === null) {
    return { embeds: [embed], components: [backToCasesRow()] };
  }
  const t = quote.token;
  // **「もう一度配れる」と証明できるときだけ、返金しない選択を出す。**
  // 購入時の配送内容が残っていない旧購入では、何を配り直せばよいか誰も分からない。
  // 現在の商品設定から推測して配ることは禁止なので、その選択肢は出さない。
  const canRetryDelivery = quote.deliveryKind !== null;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`shokan:case-pre:delivered:0:${purchaseId}:${t}`)
      .setLabel("提供できていた")
      .setStyle(ButtonStyle.Success),
    ...(quote.refundSupported
      ? [
          new ButtonBuilder()
            .setCustomId(`shokan:case-pre:no_effect:1:${purchaseId}:${t}`)
            .setLabel("提供できていない → 返金する")
            .setStyle(ButtonStyle.Danger),
        ]
      : []),
    ...(canRetryDelivery
      ? [
          new ButtonBuilder()
            .setCustomId(`shokan:case-pre:no_effect:0:${purchaseId}:${t}`)
            .setLabel("提供できていない → もう一度配る")
            .setStyle(ButtonStyle.Secondary),
        ]
      : []),
    new ButtonBuilder()
      .setCustomId(`shokan:case-pre:still_unknown:0:${purchaseId}:${t}`)
      .setLabel("まだ分からない")
      .setStyle(ButtonStyle.Secondary),
  );
  const notes: string[] = [];
  if (!quote.refundSupported) {
    notes.push("この購入は商館からは返金できません（支払い方法が対象外です）。運営へ渡してください。");
  }
  if (!canRetryDelivery) {
    notes.push("購入時の記録が無いため、**もう一度配ることはできません。**");
  }
  if (notes.length > 0) embed.addFields({ name: "できないこと", value: notes.join("\n"), inline: false });
  return { embeds: [embed], components: [row, backToCasesRow()] };
}

/** 終わったあとに、入口を探し直させない */
function afterActionRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("shokan:stuck-delivery:0").setLabel("次の案件へ").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("shokan:work").setLabel("← 対応が必要").setStyle(ButtonStyle.Secondary),
  );
}

function backToCasesRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("shokan:stuck-delivery:0").setLabel("← 確認待ちの案件").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("shokan:hub").setLabel("← 商館ハブ").setStyle(ButtonStyle.Secondary),
  );
}

/** 確定前に**実際に起きる変更**を出す。ここでもまだ何も変えない。 */
function renderCasePreview(
  services: Services,
  purchaseId: number,
  decision: "delivered" | "no_effect" | "still_unknown",
  refund: boolean,
  token: string,
) {
  const quote = services.shop.quoteOperatorResolution(purchaseId);
  const stale = quote.token !== token || quote.kind === null;
  const changes =
    decision === "delivered"
      ? ["この購入を**提供できていた**ものとして確定します。", "返金はしません。", "対応一覧から消えます。"]
      : decision === "no_effect"
        ? [
            "この購入を**提供できていない**ものとして確定します。",
            refund
              ? `**${fmtLd(quote.refundableAmount)} を返金します。**`
              : "返金はしません。もう一度配れる状態に戻します。",
            "対応一覧から消えます。",
          ]
        : ["**何も変更しません。**", "対応一覧に残ります。", "「確認したが分からなかった」ことだけ記録します。"];
  const embed = new EmbedBuilder()
    .setTitle(`確認: ${DECISION_LABEL[decision]}`)
    .setColor(stale ? 0xdc2626 : 0x0ea5e9)
    .setDescription(
      stale
        ? "⚠️ 表示したあとに状況が変わりました。**何も変更していません。** 一覧を開き直してください。"
        : [`購入 #${purchaseId} / <@${quote.userId}>`, "", "**これから起きること**", ...changes.map((c) => `・${c}`)].join("\n"),
    );
  if (stale) return { embeds: [embed], components: [backToCasesRow()] };
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`shokan:case-note:${decision}:${refund ? 1 : 0}:${purchaseId}:${token}`)
      .setLabel("根拠を入力して確定")
      .setStyle(decision === "no_effect" && refund ? ButtonStyle.Danger : ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`shokan:case:${purchaseId}`).setLabel("やめる").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

function deliveryKindLabel(kind: string | null): string {
  if (kind === null) return "記録なし（判断できません）";
  if (kind === "add_role") return "ロール付与";
  if (kind === "set_nickname") return "名前の変更";
  if (kind === "create_original_role") return "オリジナルロール作成";
  if (kind === "activate_sub_account") return "サブ垢の有効化";
  return kind;
}

function purchaseStatusLabel(status: string): string {
  if (status === "active") return "有効";
  if (status === "refunded") return "返金済み";
  if (status === "expired") return "期限切れ";
  return status;
}

/**
 * 決着の根拠を書いてもらう。
 *
 * **人の確認を authority として採用する以上、「何を確認したのか」が残らないと
 * 監査台帳の意味が無い。** 判断が分かれる決着（提供済み／提供なし）では必須にする。
 * 保留も「何を見て判断できなかったか」を残せるようにする。
 */
function caseNoteModal(
  decision: "delivered" | "no_effect" | "still_unknown",
  refund: boolean,
  purchaseId: number,
  token: string,
): ModalBuilder {
  const required = decision !== "still_unknown";
  return new ModalBuilder()
    .setCustomId(`shokan:case-note:${decision}:${refund ? 1 : 0}:${purchaseId}:${token}`)
    .setTitle(`#${purchaseId} ${DECISION_LABEL[decision]}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("note")
          .setLabel(required ? "何を確認しましたか（必須）" : "何を確認しましたか（任意）")
          .setPlaceholder("例: Discordでロールが付いていることを確認")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(required)
          .setMaxLength(500),
      ),
    );
}

/**
 * 決着の確定。**staleなら1つも書かずに止める。**
 * 内部のエラーコードや token は運営画面にも出さない（意味のある言葉だけ返す）。
 */
async function resolveCase(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  services: Services,
  decision: "delivered" | "no_effect" | "still_unknown",
  refund: boolean,
  purchaseId: number,
  token: string,
  note: string,
): Promise<void> {
  try {
    const result = services.shop.resolveOperatorCase({
      purchaseId,
      decision,
      expectedToken: token,
      actor: `user:${interaction.user.id}`,
      refund,
      note,
    });
    const done =
      decision === "delivered"
        ? `✅ 購入 #${purchaseId} を**提供済み**として確定しました。`
        : decision === "no_effect"
          ? result.refunded
            ? `✅ 購入 #${purchaseId} を**未提供**として確定し、${fmtLd(result.refundedAmount)}を返金しました。`
            : `✅ 購入 #${purchaseId} を**未提供**として確定しました（返金はしていません）。`
          : `ℹ️ 購入 #${purchaseId} は**判断保留**として記録しました。状態は変えていません。`;
    await interaction.reply({
      content: done,
      components: [afterActionRow()],
      flags: MessageFlags.Ephemeral,
    });
    await refreshShopAdminPanels(interaction.client, services).catch(() => undefined);
  } catch (error) {
    const code = error instanceof ShopError ? error.code : undefined;
    await interaction.reply({
      content:
        code === "ERR_RESOLUTION_STALE"
          ? "⚠️ 表示したあとに状況が変わりました。**何も変更していません。** 一覧を開き直してください。"
          : code === "ERR_RESOLUTION_NOT_APPLICABLE"
            ? "ℹ️ この案件は既に決着しています。**何も変更していません。**"
            : "⚠️ 決着できませんでした。何も変更していません。",
      flags: MessageFlags.Ephemeral,
    });
  }
}

/**
 * 返金できていない購入の作業キュー。
 *
 * **配送の再試行とは別の仕事。** ここに出るのは「返金を実際に試したが完了できなかった」
 * 購入だけで、「提供できたか確認できていない」ものは確認待ちの案件へ行く。
 */
function renderRefundFailures(services: Services, offset = 0) {
  const total = services.shop.countRefundFailures();
  const start = total === 0 ? 0 : Math.min(Math.max(0, offset), Math.max(0, total - 1));
  const rows = services.shop.listRefundFailures({ limit: CASE_PAGE, offset: start });
  const embed = new EmbedBuilder()
    .setTitle("💸 返金の未完了")
    .setColor(total > 0 ? 0xdc2626 : 0x64748b)
    .setDescription(
      total === 0
        ? "返金の未完了はありません。"
        : [
            "**返金を試しましたが完了できていません。** 利用者の残高は戻っていません。",
            "配送のやり直しではなく、返金のやり直しです。",
          ].join("\n"),
    );
  if (total > 0) embed.setFooter({ text: `${start + 1}〜${start + rows.length} / ${total}件` });
  for (const row of rows) {
    embed.addFields({
      name: `購入 #${row.purchaseId} — ${row.itemName}`,
      value: [
        `利用者: <@${row.userId}>`,
        `返金予定額: ${fmtLd(row.amount)}`,
        `状況: 返金が完了していません（${refundFailureLabel(row.reason)}）`,
        `発生: ${fmtJstDate(row.failedAt)}`,
      ].join("\n"),
      inline: false,
    });
  }
  const open = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...rows.map((row) =>
      new ButtonBuilder()
        .setCustomId(`shokan:refund-pre:${row.purchaseId}`)
        .setLabel(`#${row.purchaseId} を返金`)
        .setStyle(ButtonStyle.Danger),
    ),
  );
  const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`shokan:refund-open:${Math.max(0, start - CASE_PAGE)}`)
      .setLabel("← 前へ")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(start === 0),
    new ButtonBuilder()
      .setCustomId(`shokan:refund-open:${start + CASE_PAGE}`)
      .setLabel("次へ →")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(start + rows.length >= total),
    new ButtonBuilder().setCustomId("shokan:hub").setLabel("← 商館ハブ").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: rows.length > 0 ? [open, nav] : [backButton()] };
}

/** 内部の例外文をそのまま出さない。運営が読める粒度にする */
function refundFailureLabel(reason: string): string {
  if (reason === "retry_failed") return "やり直しにも失敗";
  return "自動返金が通らなかった";
}

/** 返金やり直しの確認。ここではまだ何も動かさない。 */
function renderRefundPreview(services: Services, purchaseId: number) {
  const quote = services.shop.quoteRefundRetry(purchaseId);
  const embed = new EmbedBuilder()
    .setTitle(`確認: 購入 #${purchaseId} を返金`)
    .setColor(quote.open ? 0x0ea5e9 : 0xdc2626)
    .setDescription(
      quote.open
        ? [
            `<@${quote.userId}> / ${quote.itemName}`,
            "",
            "**これから起きること**",
            `・**${fmtLd(quote.amount)} を返金します。**`,
            "・この購入は返金済みになります。",
            "・返金の未完了一覧から消えます。",
          ].join("\n")
        : "⚠️ 表示したあとに状況が変わりました。**何も変更していません。** 一覧を開き直してください。",
    );
  if (!quote.open) {
    return {
      embeds: [embed],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("shokan:refund-open:0").setLabel("← 返金の未完了").setStyle(ButtonStyle.Secondary),
        ),
      ],
    };
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`shokan:refund-do:${purchaseId}:${quote.token}`)
      .setLabel("この内容で返金する")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("shokan:refund-open:0").setLabel("やめる").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

async function doRefundRetry(
  interaction: ButtonInteraction,
  services: Services,
  purchaseId: number,
  token: string,
): Promise<void> {
  try {
    const result = services.shop.retryRefund({ purchaseId, expectedToken: token, actor: `user:${interaction.user.id}` });
    await interaction.reply({
      content: result.refunded
        ? `✅ 購入 #${purchaseId} の ${fmtLd(result.amount)} を返金しました。`
        : `ℹ️ 購入 #${purchaseId} は既に返金済みです。**何も変更していません。**`,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("shokan:refund-open:0").setLabel("次の返金へ").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("shokan:work").setLabel("← 対応が必要").setStyle(ButtonStyle.Secondary),
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    await refreshShopAdminPanels(interaction.client, services).catch(() => undefined);
  } catch (error) {
    const code = error instanceof ShopError ? error.code : undefined;
    await interaction.reply({
      content:
        code === "ERR_RESOLUTION_STALE"
          ? "⚠️ 表示したあとに状況が変わりました。**何も変更していません。** 一覧を開き直してください。"
          : code === "ERR_RESOLUTION_NOT_APPLICABLE"
            ? "ℹ️ この購入はもう返金の対象ではありません。**何も変更していません。**"
            : "⚠️ 返金できませんでした。記録は残っているので、あとでやり直せます。",
      flags: MessageFlags.Ephemeral,
    });
    await refreshShopAdminPanels(interaction.client, services).catch(() => undefined);
  }
}

export async function handleShokanButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  if (!canOperate(interaction, services)) {
    await interaction.reply({ content: "権限がありません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const parts = interaction.customId.split(":");
  const action = parts[1];
  const arg = parts[2];

  if (action?.startsWith("reeval-comp") && !isAdmin(interaction, services)) {
    await interaction.reply({ content: REEVAL_COMPENSATION_AUTH_MESSAGE, flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === "orole") return void (await interaction.update(originalRoleReviewPanel(services)));
  if (action === "sub") return void (await interaction.update(subAccountReviewPanel(services)));
  if (action === "sub-active") {
    const page = arg === undefined ? 0 : Number(arg);
    return void (await interaction.update(activeSubAccountPanel(services, page)));
  }
  if (action === "sub-active-view" && arg) {
    return void (await interaction.update(subAccountDeactivationConfirm(services, Number(arg), Number(parts[3] ?? 0))));
  }
  if (action === "sub-deactivate" && arg) {
    return void (await handleSubAccountDeactivation(interaction, services, Number(arg), Number(parts[3] ?? 0)));
  }
  if (action === "sub-approve" && arg) return void (await handleSubAccountApprove(interaction, services, Number(arg)));
  if (action === "sub-return" && arg) return void (await interaction.showModal(subDecisionModal("returned", Number(arg))));
  if (action === "sub-reject" && arg) return void (await interaction.showModal(subDecisionModal("rejected", Number(arg))));
  if (action === "orole-approve" && arg) return void (await handleOriginalRoleApprove(interaction, services, Number(arg)));
  if (action === "orole-return" && arg) return void (await interaction.showModal(decisionModal("returned", Number(arg))));
  if (action === "orole-reject" && arg) return void (await interaction.showModal(decisionModal("rejected", Number(arg))));

  // 常設パネルのボタンは**元のパネルを書き換えない**（全員に見えるため）。
  // 押した人にだけ ephemeral で出す
  const fromPanel = interaction.message.flags?.has?.(MessageFlags.Ephemeral) === false;
  const show = async (view: Parameters<ButtonInteraction["reply"]>[0]) => {
    if (fromPanel) await interaction.reply({ ...(view as object), flags: MessageFlags.Ephemeral });
    else await interaction.update(view as never);
  };

  if (action === "hub") return void (await show(shopAdminPanelMessage(services) as never));
  if (action === "work") return void (await show(renderWorkHub(services) as never));
  if (action === "pending") return void (await show(renderPending(services) as never));
  if (action === "failed") return void (await show(renderFailed(services) as never));
  if (action === "stuck-delivery") {
    return void (await show(renderStuckDeliveries(services, Math.max(0, Number(arg ?? 0))) as never));
  }
  if (action === "refund-open") {
    return void (await show(renderRefundFailures(services, Math.max(0, Number(arg ?? 0))) as never));
  }
  if (action === "refund-pre" && arg) return void (await show(renderRefundPreview(services, Number(arg)) as never));
  if (action === "refund-do" && arg) {
    return void (await doRefundRetry(interaction, services, Number(arg), parts[3] ?? ""));
  }
  if (action === "case" && arg) return void (await show(renderCase(services, Number(arg)) as never));
  if (action === "case-pre" && arg) {
    // customId: shokan:case-pre:<decision>:<refund01>:<purchaseId>:<token>
    const decision = arg as "delivered" | "no_effect" | "still_unknown";
    return void (await show(
      renderCasePreview(services, Number(parts[4]), decision, parts[3] === "1", parts[5] ?? "") as never,
    ));
  }
  if (action === "case-note" && arg) {
    // customId: shokan:case-note:<decision>:<refund01>:<purchaseId>:<token>
    const decision = arg as "delivered" | "no_effect" | "still_unknown";
    return void (await interaction.showModal(
      caseNoteModal(decision, parts[3] === "1", Number(parts[4]), parts[5] ?? ""),
    ));
  }
  if (action === "list") return void (await show(renderList(services) as never));
  if (action === "history") return void (await show(renderHistory(services, Math.max(0, Number(arg ?? 0))) as never));
  if (action === "reeval-comp") {
    return void (await show(renderReevalCompensations(services, Math.max(0, Number(arg ?? 0))) as never));
  }
  if (action === "edit-basic" && arg) return void (await interaction.showModal(editBasicModal(Number(arg), services)));
  if (action === "edit-role" && arg) return void (await show(roleEditor(Number(arg)) as never));
  if (action === "edit-stock" && arg) {
    const item = services.shop.getItem(Number(arg));
    if (!item) return;
    return void (await interaction.showModal(stockModal(item.id, item)));
  }
  if (action === "stock-fix" && arg) {
    // customId: shokan:stock-fix:<mode>:<itemId>:<requested>:<token>
    const mode = arg === "add_restorations" ? "add_restorations" : "final_stock";
    return void (await applyStockFix(interaction, services, mode, Number(parts[3]), Number(parts[4]), parts[5] ?? ""));
  }
  if (action === "toggle" && arg) {
    const id = Number(arg);
    const item = services.shop.getItem(id);
    if (!item) return;
    // 移行待ちの商品は再販売できない（契約の実体をBotが知らないまま売らない）
    if (!item.enabled && services.shop.isSalesLocked(item)) {
      await interaction.reply({
        content: `⚠️ **${item.name}** は移行待ちのため販売を再開できません（専用台帳へ移すまで停止）。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    services.shop.setEnabled(id, !item.enabled, `user:${interaction.user.id}`);
    return void (await show(renderItem(services.shop.getItem(id)!, services) as never));
  }

  if (action === "deliver" && arg) {
    const id = Number(arg);
    // **古い画面から押されうる。** ボタンを作った時点ではなく、いまの状態で判断する
    const purchase = services.shop.getPurchase(id);
    if (!purchase) {
      await interaction.reply({ content: `購入 #${id} が見つかりません。`, flags: MessageFlags.Ephemeral });
      return;
    }
    // 再評価チャレンジはここで完了させない。買ったのは面談を受ける権利で、
    // 消費するのは既存の再評価面談フローだけ。ここで配送済みにすると
    // 未使用の権利が消え、面談前に 500,000 Ld が失われる（購入 #44 で起きた形）
    // 判定は**この購入の実績**で行う。現在 shop:reeval_item_id に指定されているか
    // どうかでは決めない——普通の商品を後からその設定に入れただけで、過去の普通の購入が
    // 「再評価権」に化けてしまう。
    if (services.shop.isReevaluationPurchase(purchase.id)) {
      await interaction.reply({
        content: [
          `⚠️ 購入 #${id} は**再評価を受ける権利**です。ここでは完了にできません。`,
          "面談の結果を記録すると権利が消費されます（再評価面談チケットの承認・見送り）。",
        ].join("\n"),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // **判定と書き込みはCoreの1文の中で行う。** ここで status を先に見てから
    // 書きに行くと、その隙に返金が入って「返金済みなのに配送済み」を作れる。
    const outcome = services.shop.completeManualDelivery(id, `user:${interaction.user.id}`);
    if (!outcome.completed) {
      // **理由だけを返す。** ここで一覧を出し直すと説明が消えるうえ、同じ操作に対して
      // 二度返信することになる。常設パネルの件数だけ最新へ寄せておく。
      await interaction.reply({ content: manualCompletionMessage(id, outcome.reason), flags: MessageFlags.Ephemeral });
      await refreshShopAdminPanels(interaction.client, services).catch(() => undefined);
      return;
    }
    await show(renderPending(services) as never);
    await refreshShopAdminPanels(interaction.client, services).catch(() => undefined);
    return;
  }

  if (action === "retry" && arg) {
    const id = Number(arg);
    // 再配送の可否判定は `redeliverPurchase` が持っている。
    // **購入時スナップショット**と現在の status を見るので、expired/refunded/cancelled や
    // 撤回済みの配送種別は古いボタンから実行できない
    const outcome = await redeliverPurchase(services, interaction.guild, id, `user:${interaction.user.id}`);
    await interaction.reply({
      content: `${outcome.state === "failed" ? "⚠️" : outcome.state === "delivered" ? "✅" : "ℹ️"} 購入 #${id}: ${outcome.message}`,
      flags: MessageFlags.Ephemeral,
    });
    await refreshShopAdminPanels(interaction.client, services).catch(() => undefined);
    return;
  }
}

export async function handleShokanSelect(
  interaction: StringSelectMenuInteraction | RoleSelectMenuInteraction,
  services: Services,
): Promise<void> {
  if (!canOperate(interaction, services)) {
    await interaction.reply({ content: "権限がありません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const parts = interaction.customId.split(":");
  const action = parts[1];

  if (action?.startsWith("reeval-comp") && !isAdmin(interaction, services)) {
    await interaction.reply({ content: REEVAL_COMPENSATION_AUTH_MESSAGE, flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === "pick" && interaction.isStringSelectMenu()) {
    const item = services.shop.getItem(Number(interaction.values[0]));
    if (!item) return;
    return void (await interaction.update(renderItem(item, services)));
  }
  if (action === "role-set" && interaction.isRoleSelectMenu()) {
    const id = Number(parts[2]);
    services.shop.updateItem(id, { require_role_id: interaction.values[0] }, `user:${interaction.user.id}`);
    return void (await interaction.update(renderItem(services.shop.getItem(id)!, services)));
  }
  if (action === "role-clear" && interaction.isStringSelectMenu()) {
    const id = Number(parts[2]);
    services.shop.updateItem(id, { require_role_id: null }, `user:${interaction.user.id}`);
    return void (await interaction.update(renderItem(services.shop.getItem(id)!, services)));
  }
  if (action === "reeval-comp-purchase" && interaction.isStringSelectMenu()) {
    const purchaseId = Number(interaction.values[0]);
    return void (await interaction.update(renderReevalCompensationDepartments(services, purchaseId)));
  }
  if (action === "reeval-comp-dept" && interaction.isStringSelectMenu()) {
    const purchaseId = Number(parts[2]);
    const departmentKey = interaction.values[0];
    if (!departmentKey) return;
    return void (await interaction.showModal(reevalCompensationModal(purchaseId, departmentKey)));
  }
}

export async function handleShokanModal(interaction: ModalSubmitInteraction, services: Services): Promise<void> {
  if (!canOperate(interaction, services)) return;
  const parts = interaction.customId.split(":");
  if (parts[1] === "sub-decide") {
    await handleSubAccountDecision(interaction, services);
    return;
  }
  if (parts[1] === "orole-decide") {
    await handleOriginalRoleDecision(interaction, services);
    return;
  }
  if (parts[1] === "reeval-comp-submit") {
    await handleReevalCompensation(interaction, services);
    return;
  }
  if (parts[1] === "case-note") {
    const decision = parts[2] as "delivered" | "no_effect" | "still_unknown";
    const note = interaction.fields.getTextInputValue("note").trim();
    if (decision !== "still_unknown" && note.length === 0) {
      await interaction.reply({
        content: "根拠を入力してください。**何も変更していません。**",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await resolveCase(interaction, services, decision, parts[3] === "1", Number(parts[4]), parts[5] ?? "", note);
    return;
  }
  if (parts[1] === "edit-stock") {
    const id = Number(parts[2]);
    const item = services.shop.getItem(id);
    if (!item) return;
    const raw = interaction.fields.getTextInputValue("stock").replaceAll(",", "").trim();
    const requestedStock = raw === "" ? null : Number(raw);
    if (requestedStock !== null && (!Number.isInteger(requestedStock) || requestedStock < 0)) {
      await interaction.reply({ content: "在庫は 0以上の整数 か、空欄（無制限）で入れてください。", flags: MessageFlags.Ephemeral });
      return;
    }
    const quote = services.shop.quoteStockChange(id, requestedStock);
    // 未処理の返金在庫があるなら、**必ず運営に選ばせてから**確定する
    if (quote.requiresReconciliation) {
      await interaction.reply(stockReconciliationPrompt(quote, item.name) as never);
      return;
    }
    await applyStockChangeFromModal(interaction, services, id, requestedStock, quote.tokens.none ?? "");
    return;
  }
  if (parts[1] !== "edit-basic") return;

  const id = Number(parts[2]);
  const name = interaction.fields.getTextInputValue("name").trim();
  const price = Number(interaction.fields.getTextInputValue("price").replaceAll(",", "").trim());
  const desc = interaction.fields.getTextInputValue("desc").trim() || null;
  if (!name || !Number.isFinite(price) || price < 0) {
    await interaction.reply({ content: "名前と 0以上の価格 を入れてください。", flags: MessageFlags.Ephemeral });
    return;
  }
  // 期間・配送方法はここから変えない。Botの処理内容と結びついているため、
  // 変えるならコード側の対応が要る
  services.shop.updateItem(id, { name, description: desc, price_land: price }, `user:${interaction.user.id}`);
  await interaction.reply({ content: `✅ 商品 #${id} を更新しました。`, flags: MessageFlags.Ephemeral });
}

function renderReevalCompensations(services: Services, offset = 0) {
  // 現在の商品IDではなく「再評価権として発行され、面談で消費済み」というsemanticで出す。
  // A→B差し替え後の旧Aも、設定を消していても補償候補として見える。
  const total = services.shop.countCompensableReevaluationPurchases();
  const rows = services.shop.listCompensableReevaluationPurchases({
    limit: REEVAL_COMPENSATION_PAGE,
    offset,
  });
  const embed = new EmbedBuilder()
    .setTitle("再評価チャレンジ 例外補償")
    .setColor(0xb45309)
    .setDescription(
      rows.length === 0
        ? "補償可能な消費済み再評価権はありません。"
        : [
            "対象を選び、支出する部署・金額・理由を確認します。",
            "元購入、面談結果、招待使用履歴は変更されません。",
          ].join("\n"),
    );
  if (rows.length > 0) {
    embed.addFields(
      rows.slice(0, 10).map((row) => ({
        name: `購入 #${row.id} / <@${row.user_id}>`,
        value: `${row.paid_land !== null ? fmtLd(row.paid_land) : `${row.paid_alt_kind} ${row.paid_alt_amount}`} / <t:${row.purchased_at}:f>`,
      })),
    );
  }
  const components: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> = [];
  if (rows.length > 0) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("shokan:reeval-comp-purchase")
          .setPlaceholder("補償対象の購入を選択")
          .addOptions(
            rows.map((row) => ({
              label: `購入 #${row.id}`,
              description: `${row.user_id} / ${row.paid_land !== null ? `${row.paid_land}Ld` : "招待5件"}`.slice(0, 100),
              value: String(row.id),
            })),
          ),
      ),
    );
  }
  if (total > REEVAL_COMPENSATION_PAGE) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`shokan:reeval-comp:${Math.max(0, offset - REEVAL_COMPENSATION_PAGE)}`)
          .setLabel("前へ")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(offset === 0),
        new ButtonBuilder()
          .setCustomId(`shokan:reeval-comp:${offset + REEVAL_COMPENSATION_PAGE}`)
          .setLabel("次へ")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(offset + REEVAL_COMPENSATION_PAGE >= total),
      ),
    );
  }
  components.push(backButton());
  return { embeds: [embed], components, allowedMentions: { parse: [] as never[] } };
}

function renderReevalCompensationDepartments(services: Services, purchaseId: number) {
  // 現在の商品設定ではなく、その購入が再評価権として発行されたかで判断する。
  const purchase = services.shop.getPurchase(purchaseId);
  const already = services.shop.getReevalCompensation(purchaseId);
  if (
    !purchase ||
    !services.shop.isReevaluationPurchase(purchase.id) ||
    purchase.status !== "active" ||
    purchase.delivered_at === null ||
    purchase.delivery_state !== "delivered" ||
    already
  ) {
    return {
      content: "この購入は補償対象ではないか、既に補償済みです。",
      embeds: [],
      components: [backButton()],
    };
  }
  const departments = services.departments.listWithBalance().slice(0, 25);
  const embed = new EmbedBuilder()
    .setTitle(`購入 #${purchase.id} の例外補償`)
    .setColor(0xb45309)
    .setDescription(
      [`対象: <@${purchase.user_id}>`, `購入: ${purchase.paid_land !== null ? fmtLd(purchase.paid_land) : "確定招待5件"}`, "支出部署を選んでください。"].join("\n"),
    );
  const components: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> = [];
  if (departments.length > 0) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`shokan:reeval-comp-dept:${purchase.id}`)
          .setPlaceholder("支出部署を選択")
          .addOptions(
            departments.map((department) => ({
              label: department.name.slice(0, 100),
              description: `残高 ${fmtLd(department.balance)}`.slice(0, 100),
              value: department.key,
            })),
          ),
      ),
    );
  } else {
    embed.addFields({ name: "支出不可", value: "部署口座が登録されていません。" });
  }
  components.push(backButton());
  return { embeds: [embed], components, allowedMentions: { parse: [] as never[] } };
}

function departmentToken(departmentKey: string): string {
  return createHash("sha256").update(departmentKey, "utf8").digest("hex").slice(0, 24);
}

function reevalCompensationModal(purchaseId: number, departmentKey: string) {
  const modal = new ModalBuilder()
    .setCustomId(`shokan:reeval-comp-submit:${purchaseId}:${departmentToken(departmentKey)}`)
    .setTitle(`再評価補償 #${purchaseId}`);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("amount")
        .setLabel("補償額（Ld）")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(15),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("reason")
        .setLabel("例外補償の理由")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(500),
    ),
  );
  return modal;
}

async function handleReevalCompensation(interaction: ModalSubmitInteraction, services: Services): Promise<void> {
  if (!isAdmin(interaction, services)) {
    await interaction.reply({ content: REEVAL_COMPENSATION_AUTH_MESSAGE, flags: MessageFlags.Ephemeral });
    return;
  }
  const parts = interaction.customId.split(":");
  const purchaseId = Number(parts[2]);
  const token = parts[3] ?? "";
  const matchingDepartments = services.departments.list().filter((department) => departmentToken(department.key) === token);
  const departmentKey = matchingDepartments.length === 1 ? matchingDepartments[0]!.key : null;
  const amount = Number(interaction.fields.getTextInputValue("amount").replaceAll(",", "").trim());
  const reason = interaction.fields.getTextInputValue("reason").trim();
  if (!departmentKey) {
    await interaction.reply({ content: "支出部署を一意に確認できません。選択からやり直してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!Number.isSafeInteger(purchaseId) || !Number.isSafeInteger(amount) || amount <= 0 || !reason) {
    await interaction.reply({ content: "補償内容を確認できません。", flags: MessageFlags.Ephemeral });
    return;
  }
  try {
    const row = services.shop.compensateReevaluation({
      purchaseId,
      departmentKey,
      amount,
      reason,
      actor: `user:${interaction.user.id}`,
      approvedBy: `user:${interaction.user.id}`,
      idempotencyKey: `shop:reeval:compensation:${purchaseId}`,
    });
    await interaction.reply({
      content: `購入 #${purchaseId} へ ${fmtLd(row.amount)} を ${departmentKey} から例外補償しました。`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    const message = error instanceof ShopError && error.code === "ERR_REEVAL_ALREADY_COMPENSATED"
      ? "この購入は既に補償済みです。"
      : `補償できませんでした: ${error instanceof Error ? error.message : String(error)}`;
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }
}

// ---- Modals & Selects ----

function editBasicModal(id: number, services: Services) {
  const item = services.shop.getItem(id);
  const modal = new ModalBuilder().setCustomId(`shokan:edit-basic:${id}`).setTitle(`#${id} 名前・価格・説明`);
  const inputs = [
    new TextInputBuilder()
      .setCustomId("name")
      .setLabel("商品名")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(80)
      .setValue(item?.name ?? ""),
    new TextInputBuilder()
      .setCustomId("price")
      .setLabel("価格（Land）")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(15)
      .setValue(item?.price_land != null ? String(item.price_land) : "0"),
    new TextInputBuilder()
      .setCustomId("desc")
      .setLabel("説明")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(500)
      .setValue(item?.description ?? ""),
  ];
  modal.addComponents(...inputs.map((i) => new ActionRowBuilder<TextInputBuilder>().addComponents(i)));
  return modal;
}

function roleEditor(id: number) {
  const embed = new EmbedBuilder()
    .setTitle(`#${id} 階級要件`)
    .setColor(0xdb2777)
    .setDescription("要件ロールを選ぶか、「解除」で無条件にします。");
  const picker = new RoleSelectMenuBuilder().setCustomId(`shokan:role-set:${id}`).setPlaceholder("要件ロールを選ぶ");
  const clear = new StringSelectMenuBuilder()
    .setCustomId(`shokan:role-clear:${id}`)
    .setPlaceholder("階級要件を解除する")
    .addOptions({ label: "階級要件なしにする", value: "clear" });
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(picker),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(clear),
      backButton(),
    ],
  };
}
