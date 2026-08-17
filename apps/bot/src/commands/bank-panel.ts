import {
  ActionRowBuilder,
  AutocompleteInteraction,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Message,
  type MessageCreateOptions,
  type TextChannel,
  PermissionFlagsBits,
} from "discord.js";
import { fmtLd, formatHistLine } from "../format.js";
import { isAdmin } from "../permissions.js";
import { entryPanelMessage, entryFlexPanelMessage } from "./entry.js";
import { rankPanelMessage } from "./rank-panel.js";
import { shopPanelMessage } from "./shop-panel.js";
import { shopAdminPanelMessage } from "./shokan.js";
import { takutatePanelMessage } from "./takutate-panel.js";
import { ticketPanelMessage } from "./tickets.js";
import { confessionPanelMessage } from "./confession.js";
import { casinoFacilityPanelMessage, casinoPanelMessage } from "./casino-home.js";
import {
  casinoItaPanelMessage,
  casinoKeibaPanelMessage,
  casinoPvpPanelMessage,
  casinoSoloPanelMessage,
} from "./casino-dedicated-panels.js";
import { roomPanelMessage } from "./rooms.js";
import { deptAccount, LedgerError } from "@meigokujo/core";
import {
  PANEL_KINDS,
  installablePanelChoices,
  panelKindMeta,
  panelLabel,
  removablePanelChoices,
  type PanelKind,
} from "./panel-kinds.js";
import type { Services } from "../services.js";

/**
 * 種別ごとのパネル本文。
 *
 * 「どの種別があるか」は {@link PANEL_KINDS}（`panel-kinds.ts`）が唯一の正本で、
 * ここは**その全 key に対する描画**だけを持つ。`Record<PanelKind, ...>` にしてあるので、
 * 表へ種別を足して描画を書き忘れると**型エラーになる**。
 */
const PANEL_MESSAGES: Record<PanelKind, (services: Services, channelId: string) => MessageCreateOptions> = {
  casino: (s) => casinoPanelMessage(s),
  casino_games: (s) => casinoSoloPanelMessage(s),
  casino_pvp: (s) => casinoPvpPanelMessage(s),
  casino_keiba: (s) => casinoKeibaPanelMessage(s),
  casino_ita: (s) => casinoItaPanelMessage(s),
  casino_facility: (s) => casinoFacilityPanelMessage(s),
  bank: () => bankPanelMessage(),
  entry: (s) => entryPanelMessage(s),
  entry_flex: (s) => entryFlexPanelMessage(s),
  rank: () => rankPanelMessage(),
  shop: (s) => shopPanelMessage(s),
  shop_admin: (s) => shopAdminPanelMessage(s),
  takutate: () => takutatePanelMessage(),
  ticket_return: (s) => ticketPanelMessage("return", s),
  ticket_consult: (s) => ticketPanelMessage("consult", s),
  confession: () => confessionPanelMessage(),
  room_normal: (s) => roomPanelMessage("normal", s),
  room_mitsugetsu: (s) => roomPanelMessage("mitsugetsu", s),
  room_oborozuki: (s) => roomPanelMessage("oborozuki", s),
  room_game: (s) => roomPanelMessage("game", s),
  dept: (s, channelId) => deptPanelMessage(s, s.settings.getString(`dept_panel_channel:${channelId}`) ?? ""),
};

export const panelCommand = new SlashCommandBuilder()
  .setName("パネル設置")
  .setDescription("常設パネルをこのチャンネルに設置する（運営専用）")
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((o) =>
    o.setName("種別").setDescription("設置するパネル").setRequired(true).addChoices(...installablePanelChoices()),
  )
  .addStringOption((o) =>
    o.setName("部署").setDescription("部署パネルの対象（種別=部署運用のとき必須）").setAutocomplete(true),
  );

/** /パネル撤去 — このチャンネルに置いた指定種別のパネルを削除する */
export const panelRemoveCommand = new SlashCommandBuilder()
  .setName("パネル撤去")
  .setDescription("このチャンネルに設置した常設パネルを削除する（運営専用）")
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((o) =>
    o.setName("種別").setDescription("撤去するパネル").setRequired(true).addChoices(...removablePanelChoices()),
  );

function bankPanelMessage() {
  const embed = new EmbedBuilder()
    .setTitle("🏛 冥獄銀行")
    .setDescription(
      ["ボタンの応答はあなたにだけ表示されます。", "", "💸 送金は `/送金` — どのチャンネルからでも使えます。"].join("\n"),
    )
    .setColor(0x6b21a8);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("bank:balance").setLabel("残高照会").setEmoji("💰").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("bank:hist:0").setLabel("取引履歴").setEmoji("📜").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

export async function handlePanelCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  if (!isAdmin(interaction, services)) {
    await interaction.reply({ content: "この操作には城の管理権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const channel = interaction.channel as TextChannel | null;
  if (!channel?.isTextBased()) return;

  const kind = interaction.options.getString("種別", true);
  const meta = panelKindMeta(kind);
  if (!meta?.installable) {
    await interaction.reply({ content: "このパネル種別は新規設置できません。", flags: MessageFlags.Ephemeral });
    return;
  }

  // 部署指定の要否は panel-kinds.ts を正本にする。チャンネルと部署の対応表を持たせる。
  if (meta.needsDepartment) {
    const deptKey = interaction.options.getString("部署");
    if (!deptKey) {
      await interaction.reply({ content: `${meta.label}パネルには「部署」の指定が必要です。`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (!services.departments.get(deptKey)) {
      await interaction.reply({ content: `部署「${deptKey}」がありません。\`/運営 部署 作成\` で作成してから設置してください。`, flags: MessageFlags.Ephemeral });
      return;
    }
    services.settings.set(`dept_panel_channel:${channel.id}`, deptKey, `user:${interaction.user.id}`);
  }

  const sent = await channel.send(panelMessageFor(kind, services, channel.id));
  await sent.pin().catch(() => undefined);
  services.settings.set(`panel:${kind}:${channel.id}`, sent.id, `user:${interaction.user.id}`);
  if (kind === "ticket_return") services.tickets.setPanelMessage("return", channel.id, sent.id, `user:${interaction.user.id}`);
  if (kind === "ticket_consult") services.tickets.setPanelMessage("consult", channel.id, sent.id, `user:${interaction.user.id}`);
  await interaction.reply({
    content: `✅ ${panelLabel(kind)}パネルを設置しました（会話で流れたら自動で貼り直します）。`,
    flags: MessageFlags.Ephemeral,
  });
}

/** /パネル撤去 の本体 */
export async function handlePanelRemove(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  if (!isAdmin(interaction, services)) {
    await interaction.reply({ content: "この操作には城の管理権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const channel = interaction.channel as TextChannel | null;
  if (!channel?.isTextBased()) return;

  const kind = interaction.options.getString("種別", true);
  const settingKey = `panel:${kind}:${channel.id}`;
  const panelMsgId = services.settings.getString(settingKey);
  if (!panelMsgId) {
    await interaction.reply({
      content: `このチャンネルに ${panelLabel(kind)}パネルは設置されていません。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // メッセージを削除（既に削除済みでも設定は掃除する）
  const msg = await channel.messages.fetch(panelMsgId).catch(() => null);
  if (msg) await msg.delete().catch(() => undefined);

  // 設定を消去。部署指定が必要なパネルはチャンネル→部署の紐付けも掃除する。
  const actor = `user:${interaction.user.id}`;
  services.settings.delete(settingKey, actor);
  if (panelKindMeta(kind)?.needsDepartment) services.settings.delete(`dept_panel_channel:${channel.id}`, actor);

  await interaction.reply({
    content: `✅ ${panelLabel(kind)}パネルを撤去しました${msg ? "" : "（メッセージは既に削除されていました）"}。`,
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * `/管理 → パネル` の新規設置から使うヘルパ。
 * stale なセレクトや別経路から直接呼ばれても、正本で新規設置不可なら fail-closed で拒否する。
 */
export function panelMessageForExternal(kind: string, services: Services, channelId: string) {
  const meta = panelKindMeta(kind);
  if (!meta?.installable) throw new Error(`panel kind is not installable: ${kind}`);
  if (meta.needsDepartment && !services.settings.getString(`dept_panel_channel:${channelId}`)) {
    throw new Error(`panel kind requires department selection: ${kind}`);
  }
  return panelMessageFor(kind, services, channelId);
}
export function savePanelSettingExternal(services: Services, kind: string, channelId: string, msgId: string, actor: string): void {
  services.settings.set(`panel:${kind}:${channelId}`, msgId, `user:${actor}`);
  if (kind === "ticket_return") services.tickets.setPanelMessage("return", channelId, msgId, `user:${actor}`);
  if (kind === "ticket_consult") services.tickets.setPanelMessage("consult", channelId, msgId, `user:${actor}`);
}

/**
 * 種別からパネル本文を組み立てる。分岐は持たず {@link PANEL_MESSAGES} を引く。
 * 未知の種別は銀行パネルへ落とさず**呼び出し側へ知らせる**（黙って別のパネルを貼らない）。
 */
function panelMessageFor(kind: string, services: Services, channelId: string) {
  const render = PANEL_MESSAGES[kind as PanelKind];
  if (!render) throw new Error(`unknown panel kind: ${kind}`);
  return render(services, channelId);
}

/** /パネル設置 の「部署」オートコンプリート（種別=dept のとき） */
export async function handlePanelAutocomplete(
  interaction: AutocompleteInteraction,
  services: Services,
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "部署") {
    await interaction.respond([]).catch(() => undefined);
    return;
  }
  const q = focused.value.toString().toLowerCase();
  const choices = services.departments
    .list()
    .filter((d) => !q || d.name.toLowerCase().includes(q) || d.key.toLowerCase().includes(q))
    .slice(0, 25)
    .map((d) => ({ name: d.name, value: d.key }));
  await interaction.respond(choices).catch(() => undefined);
}

/** 部署運用パネル: 部署残高を表示し、自分の残高⇄部署でLandを入れ替える */
function deptPanelMessage(services: Services, deptKey: string) {
  const dept = deptKey ? services.departments.get(deptKey) : undefined;
  if (!dept) {
    const embed = new EmbedBuilder().setTitle("🏛 部署運用パネル").setDescription("この部署は設定されていません。運営に確認してください。").setColor(0x6b7280);
    return { embeds: [embed], components: [] };
  }
  const bal = services.departments.balanceOf(deptKey);
  const embed = new EmbedBuilder()
    .setTitle(`🏛 部署「${dept.name}」の運用`)
    .setDescription(
      [
        "このパネルが見える人は、部署の残高を自分の残高と入れ替えできます。",
        "",
        `**部署残高**: ${fmtLd(bal)}`,
        "",
        "🔵 **入金**: 自分の残高 → 部署（原資積み立て・売上入金）",
        "🟠 **出金**: 部署 → 自分（部署の支出を自分が受け取る形）",
        "",
        "※ 記録はすべて台帳に残ります（監査ログで追跡可）。",
      ].join("\n"),
    )
    .setColor(0x0ea5e9);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`dept:in:${deptKey}`).setLabel("部署に入金").setEmoji("🔵").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`dept:out:${deptKey}`).setLabel("部署から出金").setEmoji("🟠").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`dept:refresh:${deptKey}`).setLabel("残高更新").setEmoji("🔁").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

/** 部署パネル: ボタン → 金額入力モーダル → 実行 */
export async function handleDeptPanelButton(
  interaction: ButtonInteraction,
  services: Services,
): Promise<void> {
  const [, action, deptKey] = interaction.customId.split(":");
  if (!deptKey) return;
  const dept = services.departments.get(deptKey);
  if (!dept) {
    await interaction.reply({ content: "部署が見つかりません。運営に確認してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (action === "refresh") {
    await interaction.update(deptPanelMessage(services, deptKey));
    return;
  }
  const modal = new ModalBuilder()
    .setCustomId(`dept:modal:${action}:${deptKey}`)
    .setTitle(`「${dept.name}」${action === "in" ? "への入金" : "からの出金"}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("amount").setLabel("金額（Land）").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(15),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("reason").setLabel("理由（任意メモ）").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200),
      ),
    );
  await interaction.showModal(modal);
}

export async function handleDeptPanelModal(
  interaction: ModalSubmitInteraction,
  services: Services,
): Promise<void> {
  const parts = interaction.customId.split(":"); // dept:modal:in|out:deptKey
  const action = parts[2] as "in" | "out";
  const deptKey = parts[3]!;
  const dept = services.departments.get(deptKey);
  if (!dept) {
    await interaction.reply({ content: "部署が見つかりません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const amt = Number(interaction.fields.getTextInputValue("amount").replaceAll(",", "").trim());
  if (!Number.isInteger(amt) || amt <= 0) {
    await interaction.reply({ content: "金額は正の整数で入力してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  const reason = interaction.fields.getTextInputValue("reason").trim() || undefined;
  const uid = interaction.user.id;
  const account = `user:${uid}`;
  services.ledger.ensureAccount(account, "user");
  try {
    if (action === "in") {
      services.ledger.transfer({
        from: account,
        to: deptAccount(deptKey),
        amount: amt,
        type: "dept_in",
        actor: account,
        reason: reason ?? `${dept.name} への入金（パネル）`,
        refType: "dept_panel",
        refId: deptKey,
        idempotencyKey: `dept:panel:in:${uid}:${deptKey}:${Date.now()}`,
      });
      await interaction.reply({
        content: `✅ **${dept.name}** に **${fmtLd(amt)}** を入金しました（部署残 ${fmtLd(services.departments.balanceOf(deptKey))}）。`,
        flags: MessageFlags.Ephemeral,
      });
    } else {
      services.ledger.transfer({
        from: deptAccount(deptKey),
        to: account,
        amount: amt,
        type: "dept_out",
        actor: account,
        reason: reason ?? `${dept.name} からの出金（パネル）`,
        refType: "dept_panel",
        refId: deptKey,
        idempotencyKey: `dept:panel:out:${uid}:${deptKey}:${Date.now()}`,
      });
      await interaction.reply({
        content: `✅ **${dept.name}** から **${fmtLd(amt)}** を受け取りました（部署残 ${fmtLd(services.departments.balanceOf(deptKey))}）。`,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (e) {
    const msg =
      e instanceof LedgerError && e.code === "ERR_INSUFFICIENT"
        ? action === "in"
          ? "自分の残高が不足しています。"
          : `部署「${dept.name}」の残高が不足しています。`
        : "処理に失敗しました。";
    await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
  }
}

export async function handleBankButton(
  interaction: ButtonInteraction,
  services: Services,
): Promise<void> {
  const account = `user:${interaction.user.id}`;
  services.ledger.ensureAccount(account, "user");

  if (interaction.customId === "bank:balance") {
    await interaction.reply({
      content: `💰 所持 Land: **${fmtLd(services.ledger.balanceOf(account))}**`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.customId.startsWith("bank:hist:")) {
    const offset = Number(interaction.customId.split(":")[2] ?? 0);
    const pageSize = 10;
    const rows = services.ledger.history(account, { limit: pageSize + 1, offset });
    const hasNext = rows.length > pageSize;
    const page = rows.slice(0, pageSize);

    const lines =
      page.length > 0
        ? page.map((tx) => formatHistLine(tx, account)).join("\n")
        : "まだ取引がありません。";
    const embed = new EmbedBuilder()
      .setTitle("📜 取引履歴")
      .setDescription(lines)
      .setFooter({ text: `${offset + 1}〜${offset + page.length} 件目 / 残高 ${fmtLd(services.ledger.balanceOf(account))}` })
      .setColor(0x6b21a8);

    const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`bank:hist:${Math.max(0, offset - pageSize)}`)
        .setLabel("新しい方へ")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(offset === 0),
      new ButtonBuilder()
        .setCustomId(`bank:hist:${offset + pageSize}`)
        .setLabel("古い方へ")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!hasNext),
    );

    // パネル上のボタン → 新規エフェメラル / エフェメラル内のページ送り → その場で更新
    if (interaction.message.flags.has(MessageFlags.Ephemeral)) {
      await interaction.update({ embeds: [embed], components: [nav] });
    } else {
      await interaction.reply({ embeds: [embed], components: [nav], flags: MessageFlags.Ephemeral });
    }
  }
}

// ---- パネル自動再掲（UX原則8: パネルは埋もれたら貼り直す） ----

const lastRepost = new Map<string, number>();
const REPOST_DEBOUNCE_MS = 30_000;

export async function maybeRepostPanel(message: Message, services: Services): Promise<void> {
  if (message.author.bot) return;
  for (const { key: kind } of PANEL_KINDS) {
    const panelMsgId = services.settings.getString(`panel:${kind}:${message.channelId}`);
    if (!panelMsgId) continue;

    const now = Date.now();
    const key = `${kind}:${message.channelId}`;
    if ((lastRepost.get(key) ?? 0) > now - REPOST_DEBOUNCE_MS) continue;
    lastRepost.set(key, now);

    const channel = message.channel as TextChannel;
    const old = await channel.messages.fetch(panelMsgId).catch(() => null);
    if (old) await old.delete().catch(() => undefined);
    const sent = await channel.send(panelMessageFor(kind, services, channel.id));
    services.settings.set(`panel:${kind}:${channel.id}`, sent.id, "system:panel-repost");
    if (kind === "ticket_return") services.tickets.setPanelMessage("return", channel.id, sent.id, "system:panel-repost");
    if (kind === "ticket_consult") services.tickets.setPanelMessage("consult", channel.id, sent.id, "system:panel-repost");
  }
}
