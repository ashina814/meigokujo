import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Client,
  type Message,
  type ThreadChannel,
} from "discord.js";
import { MarketError, type Market, type MarketSettleResult, type PayoutMode } from "@meigokujo/core";
import { fmtEther } from "../format.js";
import { MAX_BET, MIN_BET } from "../casino/common.js";
import { C_JACKPOT, C_LOSE, C_MAMMON, C_WIN, E, bar } from "../casino/ui.js";
import { isAdmin } from "../permissions.js";
import type { Services } from "../services.js";

/**
 * /板 — 賭場の板（公開賭け市場・casino-bot 完全準拠版）。
 * 立てる → 賭ける → 締切(手動/自動) → 結果報告 → 承認/異議 → 精算。
 * 承認全員 or 5分無異議で自動精算。異議が出たら管理者裁定。
 */
const OPTION_MARKS = ["①", "②", "③", "④"] as const;
const BIG_BET_THRESHOLD = 10_000;
const DEFAULT_FEE = 500;

const STATUS_LABEL: Record<Market["status"], string> = {
  open: "🟢 受付中",
  closed: "🔒 締切",
  reported: "📣 結果報告 — 承認待ち",
  disputed: "⚖️ 異議あり — 裁定待ち",
  settled: "✅ 精算済み",
  void: "♻️ 無効・返金済み",
  frozen: "🧊 資金不整合・凍結中（運営調査待ち）",
};

export const itaCommand = new SlashCommandBuilder()
  .setName("板")
  .setDescription("📋 賭場の板（公開賭け市場）")
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName("立てる")
      .setDescription("板を立てる（議題 + 選択肢2〜4 + 締切分・議題手数料500◈）")
      .addStringOption((o) => o.setName("議題").setDescription("何に賭ける？").setRequired(true).setMaxLength(120))
      .addStringOption((o) =>
        o
          .setName("選択肢")
          .setDescription("カンマ/読点区切りで 2〜4個")
          .setRequired(true)
          .setMaxLength(200),
      )
      .addIntegerOption((o) =>
        o.setName("締切分").setDescription("何分後に締切るか（1〜1440）").setRequired(true).setMinValue(1).setMaxValue(1440),
      )
      .addStringOption((o) =>
        o
          .setName("方式")
          .setDescription("配分方式（省略でパリミュ）")
          .setRequired(false)
          .addChoices(
            { name: "パリミュ（賭け額比例で山分け）", value: "parimutuel" },
            { name: "総取り（的中者で均等頭割り）", value: "winner_take_all" },
          ),
      ),
  )
  .addSubcommand((sub) => sub.setName("一覧").setDescription("進行中の板一覧"));

export async function handleItaCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === "立てる") return runCreate(interaction, services);
  if (sub === "一覧") return runList(interaction, services);
}

async function runCreate(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  const title = interaction.options.getString("議題", true).trim();
  const rawOptions = interaction.options.getString("選択肢", true);
  const durationMin = interaction.options.getInteger("締切分", true);
  const payoutMode = (interaction.options.getString("方式") as PayoutMode | null) ?? "parimutuel";

  const options = rawOptions.split(/[,、，]/).map((s) => s.trim()).filter(Boolean);
  if (options.length < 2 || options.length > 4) {
    await interaction.reply({ content: "選択肢は 2〜4 個で（カンマ/読点区切り）。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (services.ether.balanceOf(interaction.user.id) < DEFAULT_FEE) {
    await interaction.reply({
      content: `議題を立てるには手数料 ${fmtEther(DEFAULT_FEE)} かかる。残高が足りない。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    const m = services.markets.create({
      guildId: interaction.guildId ?? "",
      creatorId: interaction.user.id,
      title,
      options,
      durationMin,
      payoutMode,
      fee: DEFAULT_FEE,
    });
    await interaction.reply({
      content: `議題 #${m.id} を立てた。手数料 ${fmtEther(DEFAULT_FEE)} を JPプールに納めた。`,
      flags: MessageFlags.Ephemeral,
    });
    // パネル投下（同一チャンネル）
    const channel = interaction.channel;
    if (channel && "send" in channel) {
      const panel = renderPanel(services, m.id);
      if (!panel) return;
      const msg = (await channel.send(panel)) as Message;
      services.markets.setMessage(m.id, msg.channelId, msg.id);
      // 自動スレッド生成（best-effort）
      if (channel.type === ChannelType.GuildText) {
        try {
          const thread = await msg.startThread({
            name: `📋 ${title}`.slice(0, 90),
            autoArchiveDuration: 1440,
          });
          services.markets.setThread(m.id, thread.id);
          await thread.send(`議題「${title}」の板が立った。さあ、どこに賭ける？`);
        } catch {
          /* スレッド権限なし等は無視 */
        }
      }
    }
  } catch (e) {
    await interaction.reply({
      content: `❌ ${e instanceof MarketError ? e.code : "作成に失敗した"}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function runList(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  const rows = services.markets.listOpen();
  if (rows.length === 0) {
    await interaction.reply({ content: "進行中の板はない。", flags: MessageFlags.Ephemeral });
    return;
  }
  const lines = rows
    .slice(0, 15)
    .map((m) => `**#${m.id}**  ${m.title}\n　${STATUS_LABEL[m.status]}  ·  <@${m.creator_id}>  ·  ${m.payout_mode === "parimutuel" ? "パリミュ" : "総取り"}`)
    .join("\n\n");
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setAuthor({ name: "マモンの賭場 · 板" })
        .setColor(C_MAMMON)
        .setTitle(`📋  進行中の板  ${rows.length}件`)
        .setDescription(lines),
    ],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

/**
 * 現在の板状態からパネル embed + 適切なボタン群を生成する。
 * 状態が settled/void なら結果表示のみ・ボタン無し。
 */
function renderPanel(
  services: Services,
  marketId: number,
): { embeds: EmbedBuilder[]; components: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>> } | null {
  const m = services.markets.get(marketId);
  if (!m) return null;
  const embed = buildMarketEmbed(services, m);
  const components: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>> = [];
  const options = JSON.parse(m.options_json) as string[];

  if (m.status === "open") {
    // 賭けるボタン（1行目・選択肢ごと）
    const betRow = new ActionRowBuilder<ButtonBuilder>();
    for (let i = 0; i < options.length; i++) {
      betRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`ita:bet:${m.id}:${i}`)
          .setLabel(`${OPTION_MARKS[i]} ${options[i]}`.slice(0, 78))
          .setStyle(ButtonStyle.Primary),
      );
    }
    components.push(betRow as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>);
    // 締切るボタン（creator or admin）
    const ctlRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`ita:close:${m.id}`)
        .setLabel("締切る")
        .setEmoji("🔒")
        .setStyle(ButtonStyle.Secondary),
    );
    components.push(ctlRow as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>);
  } else if (m.status === "closed") {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`ita:report:${m.id}`)
        .setLabel("結果を報告する")
        .setEmoji("📢")
        .setStyle(ButtonStyle.Success),
    );
    components.push(row as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>);
  } else if (m.status === "reported") {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`ita:approve:${m.id}`)
        .setLabel("承認")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`ita:dispute:${m.id}`)
        .setLabel("異議あり")
        .setEmoji("⚠️")
        .setStyle(ButtonStyle.Danger),
    );
    components.push(row as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>);
  } else if (m.status === "disputed") {
    const sel = new StringSelectMenuBuilder()
      .setCustomId(`ita:admin_resolve:${m.id}`)
      .setPlaceholder("管理者裁定: 勝ちを選ぶ");
    options.forEach((opt, i) => sel.addOptions({ label: `${OPTION_MARKS[i]} ${opt}`.slice(0, 90), value: String(i) }));
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sel));
    const voidRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`ita:admin_void:${m.id}`)
        .setLabel("無効にして全額返金（管理者）")
        .setStyle(ButtonStyle.Danger),
    );
    components.push(voidRow as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>);
  }

  return { embeds: [embed], components };
}

function buildMarketEmbed(services: Services, m: Market): EmbedBuilder {
  const options = JSON.parse(m.options_json) as string[];
  const bets = services.markets.bets(m.id);
  const totalByOption = new Map<number, number>();
  const countByOption = new Map<number, number>();
  for (const b of bets) {
    totalByOption.set(b.option_index, (totalByOption.get(b.option_index) ?? 0) + b.amount);
    countByOption.set(b.option_index, (countByOption.get(b.option_index) ?? 0) + 1);
  }
  const pot = bets.reduce((s, b) => s + b.amount, 0);
  const settled = m.status === "settled" && m.result_option !== null;
  const voided = m.status === "void";

  const optionLines = options.map((opt, i) => {
    const total = totalByOption.get(i) ?? 0;
    const count = countByOption.get(i) ?? 0;
    const pct = pot > 0 ? Math.round((total / pot) * 100) : 0;
    const win = settled && i === m.result_option;
    const mark = win ? "🏆" : OPTION_MARKS[i] ?? `${i + 1}.`;
    const gauge = bar(pct, 100, 10);
    // parimutuel: 概算オッズ、winner_take_all: 参加者数
    let extra = "";
    if (m.payout_mode === "parimutuel" && total > 0 && pot > 0) {
      const odds = pot / total;
      extra = `  ·  ×${odds.toFixed(2)}`;
    } else if (m.payout_mode === "winner_take_all" && count > 0) {
      extra = `  ·  ${count}人`;
    }
    return `${mark}  **${opt}**\n　\`${gauge}\`  ${pct}%  ·  ${fmtEther(total).replace(" ◈", "◈")}${extra}`;
  });
  const color = voided
    ? C_LOSE
    : settled
      ? C_JACKPOT
      : m.status === "disputed"
        ? C_LOSE
        : m.status === "reported"
          ? C_WIN
          : C_MAMMON;
  const modeLabel = m.payout_mode === "parimutuel" ? "パリミュ（賭け額比例）" : "総取り（均等頭割り）";
  const uniqueBettors = new Set(bets.map((b) => b.user_id)).size;
  const embed = new EmbedBuilder()
    .setAuthor({ name: `マモンの賭場 · 板 #${m.id}` })
    .setColor(color)
    .setTitle(`📋  ${m.title}`)
    .addFields(
      {
        name: "▸ 情報",
        value: [
          `作成者 <@${m.creator_id}>  ·  状態 **${STATUS_LABEL[m.status]}**`,
          `方式 **${modeLabel}**  ·  参加 ${uniqueBettors}人`,
          m.status === "open"
            ? `締切 <t:${m.deadline_at}:F>  ·  <t:${m.deadline_at}:R>`
            : `締切 <t:${m.deadline_at}:F>（過ぎた）`,
        ].join("\n"),
        inline: false,
      },
      { name: "▸ 選択肢", value: optionLines.join("\n\n"), inline: false },
    )
    .setFooter({
      text: `総額 ${fmtEther(pot).replace(" ◈", "◈")}  ·  場代 3% → JPプール  ·  1人1口（張り直しは上書き）`,
    });
  if (settled) {
    embed.setDescription(`🏆 **結果**: ${options[m.result_option!]}`);
  } else if (voided) {
    embed.setDescription("♻️ この板は無効化・全額返金された。");
  }
  return embed;
}

async function refreshPanel(client: Client, services: Services, marketId: number): Promise<void> {
  const m = services.markets.get(marketId);
  if (!m || !m.channel_id || !m.message_id) return;
  try {
    const ch = await client.channels.fetch(m.channel_id).catch(() => null);
    if (!ch || !("messages" in ch)) return;
    const msg = await ch.messages.fetch(m.message_id).catch(() => null);
    if (!msg) return;
    const panel = renderPanel(services, marketId);
    if (!panel) return;
    await msg.edit({ embeds: panel.embeds, components: panel.components as unknown as Message["components"] });
  } catch {
    /* ignore */
  }
}

async function postToThread(client: Client, m: Market, content: string): Promise<void> {
  if (!m.thread_id) return;
  try {
    const ch = await client.channels.fetch(m.thread_id).catch(() => null);
    if (ch && ch.isThread()) await (ch as ThreadChannel).send(content).catch(() => undefined);
  } catch {
    /* ignore */
  }
}

// ─── button dispatch ─────────────────────────────────
export async function handleItaButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  const parts = interaction.customId.split(":");
  const action = parts[1];
  const marketId = Number(parts[2]);
  const m = services.markets.get(marketId);
  if (!m) {
    await interaction.reply({ content: "その板はもう無い。", flags: MessageFlags.Ephemeral });
    return;
  }
  switch (action) {
    case "bet":
      return openBetModal(interaction, m, Number(parts[3]));
    case "close":
      return runClose(interaction, services, m);
    case "report":
      return runReport(interaction, services, m);
    case "approve":
      return runApprove(interaction, services, m);
    case "dispute":
      return runDispute(interaction, services, m);
    case "admin_void":
      return runAdminVoid(interaction, services, m);
  }
}

async function openBetModal(interaction: ButtonInteraction, m: Market, opt: number): Promise<void> {
  if (m.status !== "open" || m.deadline_at <= Math.floor(Date.now() / 1000)) {
    await interaction.reply({ content: "この板は既に締切られている。", flags: MessageFlags.Ephemeral });
    return;
  }
  const options = JSON.parse(m.options_json) as string[];
  const modal = new ModalBuilder()
    .setCustomId(`ita:amt:${m.id}:${opt}:${interaction.id}`)
    .setTitle(`【${options[opt] ?? ""}】に張る`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("amount")
          .setLabel(`額（${MIN_BET}〜${MAX_BET.toLocaleString()}）`)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(9),
      ),
    );
  await interaction.showModal(modal);
}

async function runClose(interaction: ButtonInteraction, services: Services, m: Market): Promise<void> {
  if (!canManage(interaction, services, m)) {
    await interaction.reply({ content: "締切れるのは立て主か運営だけ。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (m.status !== "open") {
    await interaction.reply({ content: "もう受付中じゃない。", flags: MessageFlags.Ephemeral });
    return;
  }
  try {
    services.markets.close(m.id, interaction.user.id);
    await interaction.deferUpdate();
    await refreshPanel(interaction.client, services, m.id);
    const fresh = services.markets.get(m.id);
    if (fresh) await postToThread(interaction.client, fresh, "🔒 受付を締め切った。立てた人は結果を報告してくれ。");
  } catch (e) {
    await interaction.reply({
      content: `❌ ${e instanceof MarketError ? e.code : "締切に失敗した"}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function runReport(interaction: ButtonInteraction, services: Services, m: Market): Promise<void> {
  if (!canManage(interaction, services, m)) {
    await interaction.reply({ content: "結果報告できるのは立て主か運営だけ。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (m.status !== "closed") {
    await interaction.reply({ content: "先に締切ってから。", flags: MessageFlags.Ephemeral });
    return;
  }
  const options = JSON.parse(m.options_json) as string[];
  const select = new StringSelectMenuBuilder()
    .setCustomId(`ita:pick:${m.id}`)
    .setPlaceholder("勝ちの選択肢を選ぶ")
    .addOptions(options.map((opt, i) => ({ label: `${OPTION_MARKS[i]} ${opt}`.slice(0, 100), value: String(i) })));
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setAuthor({ name: `マモンの賭場 · 板 #${m.id}` })
        .setColor(C_MAMMON)
        .setTitle("📢  結果報告")
        .setDescription("勝ちの選択肢を選ぶ"),
    ],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

async function runApprove(interaction: ButtonInteraction, services: Services, m: Market): Promise<void> {
  try {
    const { settled, approvalCount, bettorCount } = services.markets.approve(m.id, interaction.user.id);
    await interaction.reply({
      content: settled
        ? `✅ 承認した。全員承認で精算が走った（${approvalCount}/${bettorCount}）。`
        : `✅ 承認した（${approvalCount}/${bettorCount}）。`,
      flags: MessageFlags.Ephemeral,
    });
    await refreshPanel(interaction.client, services, m.id);
    if (settled) {
      const fresh = services.markets.get(m.id);
      if (fresh) await announceSettle(interaction.client, fresh, settled);
    }
  } catch (e) {
    await interaction.reply({
      content: `❌ ${e instanceof MarketError ? e.code : "承認に失敗した"}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function runDispute(interaction: ButtonInteraction, services: Services, m: Market): Promise<void> {
  try {
    services.markets.dispute(m.id, interaction.user.id);
    await interaction.reply({ content: "⚖️ 異議を受け付けた。運営の裁定を待て。", flags: MessageFlags.Ephemeral });
    await refreshPanel(interaction.client, services, m.id);
    const fresh = services.markets.get(m.id);
    if (fresh) await postToThread(interaction.client, fresh, `⚖️ 板 #${fresh.id} に異議が出た。運営の裁定を待つ。`);
  } catch (e) {
    await interaction.reply({
      content: `❌ ${e instanceof MarketError ? e.code : "異議に失敗した"}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function runAdminVoid(interaction: ButtonInteraction, services: Services, m: Market): Promise<void> {
  if (!isAdmin(interaction, services) && !hasAdminPerm(interaction)) {
    await interaction.reply({ content: "運営専用。", flags: MessageFlags.Ephemeral });
    return;
  }
  try {
    services.markets.adminVoid(m.id, interaction.user.id);
    await interaction.reply({ content: "♻️ 無効化・全額返金した。", flags: MessageFlags.Ephemeral });
    await refreshPanel(interaction.client, services, m.id);
    const fresh = services.markets.get(m.id);
    if (fresh) await postToThread(interaction.client, fresh, "♻️ 管理者の裁定により、この板は無効。全額返金した。");
  } catch (e) {
    await interaction.reply({
      content: `❌ ${e instanceof MarketError ? e.code : "処理失敗"}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

// ─── modal / select dispatch ────────────────────────
export async function handleItaModal(interaction: ModalSubmitInteraction, services: Services): Promise<void> {
  const parts = interaction.customId.split(":"); // ita:amt:marketId:optionIndex:btnId
  const marketId = Number(parts[2]);
  const optionIndex = Number(parts[3]);
  const amt = Number(interaction.fields.getTextInputValue("amount").replaceAll(",", "").trim());
  if (!Number.isInteger(amt) || amt < MIN_BET || amt > MAX_BET) {
    await interaction.reply({ content: `賭け額は ${MIN_BET}〜${MAX_BET.toLocaleString()} ◈ で。`, flags: MessageFlags.Ephemeral });
    return;
  }
  try {
    const result = services.markets.bet(marketId, interaction.user.id, optionIndex, amt);
    const options = JSON.parse(services.markets.get(marketId)!.options_json) as string[];
    const optLabel = options[optionIndex];
    const msg =
      result.previous !== null
        ? `✅ 【${optLabel}】に ${fmtEther(amt)} で **張り直した**（前額 ${fmtEther(result.previous)} を返金）。`
        : `✅ 【${optLabel}】に ${fmtEther(amt)} を張った。`;
    await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    // 板の embed を更新
    await refreshPanel(interaction.client, services, marketId);
    // スレッド通知
    const fresh = services.markets.get(marketId);
    if (fresh) {
      const bigLabel = amt >= BIG_BET_THRESHOLD ? "🔥 大口！ " : "";
      await postToThread(
        interaction.client,
        fresh,
        `${bigLabel}🎲 <@${interaction.user.id}> が【${optLabel}】に ${fmtEther(amt).replace(" ◈", "◈")} を投じた${
          result.previous !== null ? `（張り直し・前額 ${fmtEther(result.previous).replace(" ◈", "◈")} を返金）` : ""
        }`,
      );
    }
  } catch (e) {
    const msg =
      e instanceof MarketError && e.code === "ERR_INSUFFICIENT_ETHER"
        ? "エテル残高が足りない。"
        : e instanceof MarketError
          ? e.code
          : "処理失敗。";
    await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
  }
}

export async function handleItaSelect(interaction: StringSelectMenuInteraction, services: Services): Promise<void> {
  const parts = interaction.customId.split(":");
  const action = parts[1];
  const marketId = Number(parts[2]);
  const winningOption = Number(interaction.values[0]);
  const m = services.markets.get(marketId);
  if (!m) {
    await interaction.reply({ content: "その板はもう無い。", flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === "pick") {
    // 結果報告
    if (!canManage(interaction, services, m)) {
      await interaction.reply({ content: "結果報告できるのは立て主か運営だけ。", flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      services.markets.report(m.id, interaction.user.id, winningOption, isAdmin(interaction, services));
      const options = JSON.parse(m.options_json) as string[];
      await interaction.update({
        content: `📣 結果を【${options[winningOption]}】で報告した。参加者の承認を待つ（5分無異議で自動確定）。`,
        components: [],
        embeds: [],
      });
      await refreshPanel(interaction.client, services, m.id);
      const fresh = services.markets.get(m.id);
      if (fresh) {
        await postToThread(
          interaction.client,
          fresh,
          `📣 結果報告: 勝ちは【${options[winningOption]}】。参加者は **✅承認 / ⚠️異議** をどうぞ（5分後に自動確定）。`,
        );
      }
    } catch (e) {
      await interaction.reply({
        content: `❌ ${e instanceof MarketError ? e.code : "結果報告に失敗した"}`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  if (action === "admin_resolve") {
    if (!isAdmin(interaction, services) && !hasAdminPerm(interaction)) {
      await interaction.reply({ content: "運営専用。", flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      const settled = services.markets.adminResolve(m.id, interaction.user.id, winningOption);
      const options = JSON.parse(m.options_json) as string[];
      await interaction.update({
        content: `⚖️ 裁定を確定した（勝ち: ${options[winningOption]}）。精算完了。`,
        components: [],
        embeds: [],
      });
      await refreshPanel(interaction.client, services, m.id);
      const fresh = services.markets.get(m.id);
      if (fresh) await announceSettle(interaction.client, fresh, settled);
    } catch (e) {
      await interaction.reply({
        content: `❌ ${e instanceof MarketError ? e.code : "裁定に失敗した"}`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }
}

/**
 * scheduler が 5分経過した reported を自動精算する時にも呼ぶ通知。
 * export して scheduler から呼び出す想定。
 */
export async function announceSettle(client: Client, m: Market, settled: MarketSettleResult): Promise<void> {
  const options = JSON.parse(m.options_json) as string[];
  if (settled.void) {
    await postToThread(client, m, `🌀 板 #${m.id} — 的中者ゼロ。全額返金した。`);
    return;
  }
  const resultLabel = settled.resultOption !== null ? options[settled.resultOption] : "?";
  const payoutLines = settled.payouts
    .slice(0, 20)
    .map((p) => `<@${p.userId}>  +${p.amount.toLocaleString("ja-JP")}◈`)
    .join("\n");
  const modeLabel = settled.mode === "parimutuel" ? "パリミュ" : "総取り";
  const extra =
    settled.payouts.length > 20 ? `\n…他 ${settled.payouts.length - 20}人` : "";
  await postToThread(
    client,
    m,
    [
      `🎉 板 #${m.id} 精算完了！ 勝ちは【${resultLabel}】（${modeLabel}）`,
      `プール ${settled.pot.toLocaleString("ja-JP")}◈ ・ 場代 ${settled.houseCut.toLocaleString("ja-JP")}◈ → JP`,
      "",
      payoutLines + extra || "（配当なし）",
    ].join("\n"),
  );
}

/** scheduler が autoClose した時のスレッド通知を出せるように export */
export async function announceAutoClose(client: Client, services: Services, marketId: number): Promise<void> {
  const m = services.markets.get(marketId);
  if (!m) return;
  await refreshPanel(client, services, marketId);
  await postToThread(client, m, "⏰ 受付を締め切った。立てた人は結果を報告してくれ。");
}

/** scheduler から市場パネルを再描画する用 */
export async function refreshMarketPanel(client: Client, services: Services, marketId: number): Promise<void> {
  await refreshPanel(client, services, marketId);
}

// ─── helpers ─────────────────────────────────────────
function canManage(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  services: Services,
  m: Market,
): boolean {
  if (interaction.user.id === m.creator_id) return true;
  if (isAdmin(interaction, services)) return true;
  return hasAdminPerm(interaction);
}

function hasAdminPerm(interaction: ButtonInteraction | StringSelectMenuInteraction): boolean {
  return !!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}
