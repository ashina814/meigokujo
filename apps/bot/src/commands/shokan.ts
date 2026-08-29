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
function queueCounts(services: Services): { pending: number; failed: number; legacy: number; stuck: number } {
  return {
    pending: services.shop.countPendingManual(),
    failed: services.shop.countUndeliveredAuto(),
    // 外部（Discord）へ投げたが結果が分からない購入。**自動では返金していない**
    stuck: services.shop.countUnresolvedExternalDeliveries(),
    // 購入時の提供方式が分からない旧購入と、方式は分かるが結末が分からない旧購入。
    // どちらも仕事として数えるが、要対応とは別枠にする。
    legacy: services.shop.countLegacyUnknownFulfillment() + services.shop.countLegacyAutoOutcomeUnknown(),
  };
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
  const { pending, failed, legacy, stuck } = queueCounts(services);
  const embed = new EmbedBuilder()
    .setTitle("🛠 冥界商館 管理")
    .setColor(pending + failed > 0 ? 0xdc2626 : 0x64748b)
    .setDescription(
      [
        pending + failed > 0
          ? `**残っている仕事: 要対応 ${pending}件 / 処理失敗 ${failed}件**`
          : "残っている仕事はありません。",
        legacy > 0 ? `**要確認（旧購入） ${legacy}件** — 購入時の提供方式を自動判定できません。` : "",
        stuck > 0
          ? `**確認待ちの配送 ${stuck}件** — 外部の状態を確認できていないため、自動返金していません。`
          : "",
        services.originalRoles.countByStatus("pending") > 0
          ? `**旧方式オリジナルロール ${services.originalRoles.countByStatus("pending")}件** がカルテ移行待ちです。`
          : "",
        "",
        "-# 通知は変化のお知らせです。仕事の一覧は必ずここから開けます。",
      ].join("\n"),
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("shokan:pending")
      .setLabel(pending > 0 ? `要対応 ${pending}` : "要対応")
      .setEmoji("🔴")
      .setStyle(pending > 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("shokan:failed")
      .setLabel(failed > 0 ? `処理失敗 ${failed}` : "処理失敗")
      .setEmoji("⚠️")
      .setStyle(failed > 0 ? ButtonStyle.Danger : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("shokan:list").setLabel("商品設定").setEmoji("📦").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("shokan:orole")
      .setLabel(
        services.originalRoles.countByStatus("pending") > 0
          ? `旧オリロ移行 ${services.originalRoles.countByStatus("pending")}`
          : "オリジナルロール",
      )
      .setEmoji("🎨")
      .setStyle(services.originalRoles.countByStatus("pending") > 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("shokan:history:0").setLabel("購入履歴").setEmoji("📜").setStyle(ButtonStyle.Secondary),
  );
  // 1行は5個まで。増えたぶんは行を足す（超えると描画そのものが落ちる）
  const subPending = services.subAccounts.countByStatus("pending");
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("shokan:sub")
      .setLabel(subPending > 0 ? `サブ垢 ${subPending}` : "サブ垢")
      .setEmoji("👥")
      .setStyle(subPending > 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("shokan:reeval-comp")
      .setLabel("再評価の例外補償")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("shokan:stuck-delivery")
      .setLabel(stuck > 0 ? `確認待ちの配送 ${stuck}` : "確認待ちの配送")
      .setEmoji("🛰")
      .setStyle(stuck > 0 ? ButtonStyle.Danger : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("shokan:legacy-unknown")
      .setLabel(legacy > 0 ? `要確認（旧購入） ${legacy}` : "要確認（旧購入）")
      .setEmoji("🕓")
      .setStyle(legacy > 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row, row2] };
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

/**
 * 購入時の提供方式が分からない旧購入。
 *
 * 普通の作業キューへは混ぜない（ワンクリックで完了にすると、実際には自動配送で
 * 提供済みだったものまで「人が対応した」ことにしてしまう）。かといって消すと、
 * 本当に人の対応が要る購入が見えなくなる。別枠で出して確認してもらう。
 */
function renderLegacyUnknown(services: Services) {
  const modeRows = services.shop.listLegacyUnknownFulfillment({ limit: QUEUE_DISPLAY });
  const modeTotal = services.shop.countLegacyUnknownFulfillment();
  const outcomeRows = services.shop.listLegacyAutoOutcomeUnknown({ limit: QUEUE_DISPLAY });
  const outcomeTotal = services.shop.countLegacyAutoOutcomeUnknown();
  const embed = new EmbedBuilder().setTitle("🕓 要確認（旧購入）").setColor(0xd97706);
  if (modeTotal + outcomeTotal === 0) {
    embed.setDescription("確認が必要な旧購入はありません。");
    return { embeds: [embed], components: [backButton()], allowedMentions: { parse: [] as never[] } };
  }
  const line = (p: { id: number; item_name: string; user_id: string; purchased_at: number }) =>
    `\`#${p.id}\` **${p.item_name}** — <@${p.user_id}>（${fmtJstDate(p.purchased_at)}）`;
  const body: string[] = ["どちらも提供状況を確認してから判断してください。"];
  if (modeTotal > 0) {
    body.push(
      "",
      `**提供方式を確認できない（${modeTotal}件）**`,
      ...modeRows.map(line),
      ...overflowNote(modeRows.length, modeTotal),
    );
  }
  if (outcomeTotal > 0) {
    body.push(
      "",
      `**自動提供だったが完了結果を確認できない（${outcomeTotal}件）**`,
      ...outcomeRows.map(line),
      ...overflowNote(outcomeRows.length, outcomeTotal),
    );
  }
  embed.setDescription(body.join("\n"));
  // どちらもワンクリックの操作は置かない。前者を「完了」にすると提供済みを人の対応に、
  // 後者を「再試行」にすると古いロール付与や期限延長を流し直すことになる。
  embed.setFooter({ text: "ここからワンクリックでの完了・再試行はできません。" });
  return { embeds: [embed], components: [backButton()], allowedMentions: { parse: [] as never[] } };
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
function renderStuckDeliveries(services: Services) {
  const rows = services.shop.listUnresolvedExternalDeliveries(QUEUE_DISPLAY);
  const total = services.shop.countUnresolvedExternalDeliveries();
  const embed = new EmbedBuilder()
    .setTitle("🛰 確認待ちの配送")
    .setColor(total > 0 ? 0xdc2626 : 0x64748b)
    .setDescription(
      total === 0
        ? "確認待ちの配送はありません。"
        : [
            "**外部（Discord）の状態を確認できていないため、自動返金していません。**",
            "提供済みなのに返金する／未提供なのに提供済みにする、のどちらも避けています。",
            "",
            "-# ロールが付いているかを確認できれば、次の巡回で自動的に決着します。",
          ].join("\n"),
    );
  for (const row of rows) {
    embed.addFields({
      name: `購入 #${row.purchase_id} — ${deliveryKindLabel(row.delivery_kind)}`,
      value: [
        `利用者: <@${row.user_id}>`,
        `購入の状態: ${purchaseStatusLabel(row.status)}`,
        `未確定になってから: ${fmtJstDate(row.started_at)} から`,
      ].join("\n"),
      inline: false,
    });
  }
  return {
    embeds: [embed],
    components: [backButton()],
    ...(total > rows.length ? { content: `ほか ${total - rows.length}件` } : {}),
  };
}

function deliveryKindLabel(kind: string): string {
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
  if (action === "pending") return void (await show(renderPending(services) as never));
  if (action === "failed") return void (await show(renderFailed(services) as never));
  if (action === "legacy-unknown") return void (await show(renderLegacyUnknown(services) as never));
  if (action === "stuck-delivery") return void (await show(renderStuckDeliveries(services) as never));
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
