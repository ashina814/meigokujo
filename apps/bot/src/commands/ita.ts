import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import { MarketError } from "@meigokujo/core";
import { fmtEther } from "../format.js";
import { MAMMON_COLOR, MAX_BET, MIN_BET } from "../casino/common.js";
import { isAdmin } from "../permissions.js";
import type { Services } from "../services.js";

/**
 * /板 — 賭場の板（公開賭け市場）。casino-bot /板 のシンプル版。
 * 立てる → 参加者が張る → 締切 → 作成者が結果報告 → parimutuel 精算。
 * 場代3%は JP プールへ。
 */
export const itaCommand = new SlashCommandBuilder()
  .setName("板")
  .setDescription("📋 賭場の板（公開賭け市場）")
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName("立てる")
      .setDescription("板を立てる（題目 + 選択肢2〜4 + 締切分）")
      .addStringOption((o) => o.setName("題目").setDescription("賭けの題目").setRequired(true).setMaxLength(120))
      .addStringOption((o) => o.setName("選択肢1").setDescription("選択肢1").setRequired(true).setMaxLength(60))
      .addStringOption((o) => o.setName("選択肢2").setDescription("選択肢2").setRequired(true).setMaxLength(60))
      .addIntegerOption((o) =>
        o.setName("締切分").setDescription("何分後に締切るか（1〜1440）").setRequired(true).setMinValue(1).setMaxValue(1440),
      )
      .addStringOption((o) => o.setName("選択肢3").setDescription("選択肢3（任意）").setRequired(false).setMaxLength(60))
      .addStringOption((o) => o.setName("選択肢4").setDescription("選択肢4（任意）").setRequired(false).setMaxLength(60)),
  )
  .addSubcommand((sub) => sub.setName("一覧").setDescription("開催中の板一覧"))
  .addSubcommand((sub) =>
    sub
      .setName("裁定")
      .setDescription("運営裁定で強制返金（板ID指定・運営専用）")
      .addIntegerOption((o) => o.setName("板id").setDescription("板ID").setRequired(true)),
  );

export async function handleItaCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === "立てる") return runCreate(interaction, services);
  if (sub === "一覧") return runList(interaction, services);
  if (sub === "裁定") return runAdjudicate(interaction, services);
}

async function runCreate(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  const title = interaction.options.getString("題目", true);
  const opt1 = interaction.options.getString("選択肢1", true);
  const opt2 = interaction.options.getString("選択肢2", true);
  const opt3 = interaction.options.getString("選択肢3") ?? null;
  const opt4 = interaction.options.getString("選択肢4") ?? null;
  const durationMin = interaction.options.getInteger("締切分", true);
  const options = [opt1, opt2, ...(opt3 ? [opt3] : []), ...(opt4 ? [opt4] : [])];

  try {
    const m = services.markets.create({
      guildId: interaction.guildId ?? "",
      creatorId: interaction.user.id,
      title,
      options,
      durationMin,
    });
    const embed = buildMarketEmbed(services, m.id);
    const row = buildMarketRow(m.id, options.length);
    await interaction.reply({ embeds: [embed], components: [row] });
    const reply = (await interaction.fetchReply()) as Message;
    services.markets.setMessage(m.id, reply.channelId, reply.id);
  } catch (e) {
    await interaction.reply({ content: `❌ ${e instanceof MarketError ? e.code : "作成に失敗した"}`, flags: MessageFlags.Ephemeral });
  }
}

async function runList(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  const rows = services.markets.listOpen();
  if (rows.length === 0) {
    await interaction.reply({ content: "開催中の板はない。", flags: MessageFlags.Ephemeral });
    return;
  }
  const lines = rows
    .slice(0, 15)
    .map((m) => `**#${m.id}** ${m.title} — 締切 <t:${m.deadline_at}:R>（<@${m.creator_id}>）`)
    .join("\n");
  await interaction.reply({
    embeds: [new EmbedBuilder().setTitle("📋 開催中の板").setColor(MAMMON_COLOR).setDescription(lines)],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function runAdjudicate(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  if (!isAdmin(interaction, services)) {
    await interaction.reply({ content: "運営専用。", flags: MessageFlags.Ephemeral });
    return;
  }
  const id = interaction.options.getInteger("板id", true);
  try {
    services.markets.refund(id, `user:${interaction.user.id}`);
    await interaction.reply({ content: `✅ 板 #${id} を強制返金 & void 化。`, flags: MessageFlags.Ephemeral });
  } catch {
    await interaction.reply({ content: `❌ 処理失敗（板が見つからない or 既に精算済）。`, flags: MessageFlags.Ephemeral });
  }
}

function buildMarketEmbed(services: Services, marketId: number): EmbedBuilder {
  const m = services.markets.get(marketId)!;
  const options = JSON.parse(m.options_json) as string[];
  const bets = services.markets.bets(marketId);
  const totalByOption = new Map<number, number>();
  for (const b of bets) totalByOption.set(b.option_index, (totalByOption.get(b.option_index) ?? 0) + b.amount);
  const pot = bets.reduce((s, b) => s + b.amount, 0);
  const optionLines = options.map((opt, i) => {
    const total = totalByOption.get(i) ?? 0;
    const pct = pot > 0 ? ((total / pot) * 100).toFixed(1) : "0.0";
    return `**${i + 1}. ${opt}** — ${fmtEther(total)}（${pct}%）`;
  });
  return new EmbedBuilder()
    .setTitle(`📋 板 #${m.id} — ${m.title}`)
    .setColor(MAMMON_COLOR)
    .setDescription(
      [
        `作成者: <@${m.creator_id}>／状態: **${m.status}**`,
        `締切: <t:${m.deadline_at}:F>（<t:${m.deadline_at}:R>）`,
        `場代: 3% → JPプール`,
        "",
        ...optionLines,
        "",
        `**総額**: ${fmtEther(pot)}`,
        m.status === "settled" && m.result_option !== null
          ? `\n**結果**: ${options[m.result_option]}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
}

function buildMarketRow(marketId: number, optionCount: number): ActionRowBuilder<ButtonBuilder> {
  const buttons: ButtonBuilder[] = [];
  for (let i = 0; i < optionCount; i++) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`ita:bet:${marketId}:${i}`)
        .setLabel(`${i + 1} に張る`)
        .setStyle(ButtonStyle.Primary),
    );
  }
  buttons.push(
    new ButtonBuilder().setCustomId(`ita:report:${marketId}`).setLabel("結果報告").setEmoji("📢").setStyle(ButtonStyle.Success),
  );
  return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
}

export async function handleItaButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  const parts = interaction.customId.split(":");
  const action = parts[1];
  const marketId = Number(parts[2]);
  if (action === "bet") {
    const optionIndex = Number(parts[3]);
    const m = services.markets.get(marketId);
    if (!m) {
      await interaction.reply({ content: "板が見つからない。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (m.status !== "open" || m.deadline_at <= Math.floor(Date.now() / 1000)) {
      await interaction.reply({ content: "この板は既に締切られている。", flags: MessageFlags.Ephemeral });
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId(`ita:amt:${marketId}:${optionIndex}:${interaction.id}`)
      .setTitle(`板 #${marketId} — 選択肢 ${optionIndex + 1} に張る`)
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
    return;
  }
  if (action === "report") {
    const m = services.markets.get(marketId);
    if (!m) {
      await interaction.reply({ content: "板が見つからない。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (m.creator_id !== interaction.user.id) {
      await interaction.reply({ content: "結果報告できるのは作成者だけ。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (m.deadline_at > Math.floor(Date.now() / 1000)) {
      await interaction.reply({ content: "まだ締切前だ。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (m.status === "settled" || m.status === "void") {
      await interaction.reply({ content: "この板は既に精算済み。", flags: MessageFlags.Ephemeral });
      return;
    }
    const options = JSON.parse(m.options_json) as string[];
    const select = new StringSelectMenuBuilder()
      .setCustomId(`ita:pick:${marketId}`)
      .setPlaceholder("勝ちの選択肢を選ぶ")
      .addOptions(options.map((opt, i) => ({ label: `${i + 1}. ${opt}`.slice(0, 100), value: String(i) })));
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle(`📢 板 #${marketId} — 結果報告`).setColor(MAMMON_COLOR).setDescription("勝ちの選択肢を選ぶ")],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
}

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
    services.markets.bet(marketId, interaction.user.id, optionIndex, amt);
    await interaction.reply({ content: `✅ 板 #${marketId} 選択肢 ${optionIndex + 1} に ${fmtEther(amt)} を張った。`, flags: MessageFlags.Ephemeral });
    // 板の embed を更新
    const m = services.markets.get(marketId);
    if (m && m.channel_id && m.message_id) {
      try {
        const ch = await interaction.client.channels.fetch(m.channel_id).catch(() => null);
        if (ch?.isTextBased() && "messages" in ch) {
          const msg = await ch.messages.fetch(m.message_id).catch(() => null);
          if (msg) {
            const options = JSON.parse(m.options_json) as string[];
            await msg.edit({ embeds: [buildMarketEmbed(services, marketId)], components: [buildMarketRow(marketId, options.length)] });
          }
        }
      } catch {
        /* ignore */
      }
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
  const parts = interaction.customId.split(":"); // ita:pick:marketId
  const marketId = Number(parts[2]);
  const winningOption = Number(interaction.values[0]);
  try {
    const result = services.markets.reportAndSettle(marketId, interaction.user.id, winningOption);
    const m = services.markets.get(marketId)!;
    const options = JSON.parse(m.options_json) as string[];
    await interaction.reply({
      content: [
        `✅ **板 #${marketId} 精算完了** — 勝ち: ${options[winningOption]}`,
        `総額 ${fmtEther(result.pot)}／場代 ${fmtEther(result.houseCut)}／分配 ${fmtEther(result.distributable)}／的中 ${result.winnerCount}人`,
      ].join("\n"),
    });
    // 元の板 embed も更新
    if (m.channel_id && m.message_id) {
      try {
        const ch = await interaction.client.channels.fetch(m.channel_id).catch(() => null);
        if (ch?.isTextBased() && "messages" in ch) {
          const msg = await ch.messages.fetch(m.message_id).catch(() => null);
          if (msg) await msg.edit({ embeds: [buildMarketEmbed(services, marketId)], components: [] });
        }
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    await interaction.reply({ content: `❌ ${e instanceof MarketError ? e.code : "精算失敗"}`, flags: MessageFlags.Ephemeral });
  }
}
