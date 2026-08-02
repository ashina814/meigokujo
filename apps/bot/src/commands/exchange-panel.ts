import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { ChipLedgerError, LedgerError } from "@meigokujo/core";
import { fmtLd, fmtEther } from "../format.js";
import { C_MAMMON, E, HR_THIN } from "../casino/ui.js";
import type { Services } from "../services.js";

/**
 * マモンの両替所（Land⇄賭場チップ）。預入・返還とも常に1:1。
 */

function ratePanel(services: Services): EmbedBuilder {
  const pool = services.chips.pool();
  const outstanding = services.chips.outstanding();

  // 直感的にわかる例示 (10,000 Ld で何エテル？ / 10,000 ◈ で何 Ld？)
  const sampleBuy = services.chips.quoteDeposit(10_000);
  const sampleSell = services.chips.quoteRedeem(100_000);

  return new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · 両替所" })
    .setTitle(`${E.jp} 賭場チップ  1 Ld ＝ 1 ${E.ether}`)
    .setColor(C_MAMMON)
    .setDescription(
      [
        "**預入・返還は常に1:1**",
        `　預入 ${E.win} Landと同額のチップを受け取る`,
        `　返還 ${E.lose} チップと同額のLandを受け取る`,
        "",
        HR_THIN,
        `**目安**`,
        `　${E.up} 入場: 10,000 Ld → **${sampleBuy.output.toLocaleString()} ${E.ether}**`,
        `　${E.down} 返還: 100,000 ${E.ether} → **${sampleSell.output.toLocaleString()} Ld**`,
      ].join("\n"),
    )
    .addFields(
      { name: `${E.chart} 準備プール`, value: `${fmtLd(pool)}`, inline: true },
      { name: `${E.chart} 発行エテル`, value: `${outstanding.toLocaleString()} ${E.ether}`, inline: true },
      { name: `${E.chart} 交換比率`, value: `1 ${E.ether} = 1 Ld`, inline: true },
    )
    .setFooter({ text: "変動レート・奉納・焼却はありません" });
}

export function exchangePanelMessage(services: Services) {
  const embed = ratePanel(services);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ether:buy").setLabel("入場（Land → エテル）").setEmoji("🔸").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ether:sell").setLabel("退場（エテル → Land）").setEmoji("🔹").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ether:balance").setLabel("財布").setEmoji("👛").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ether:refresh").setLabel("更新").setEmoji("🔁").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

export async function handleEtherButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  const action = interaction.customId.split(":")[1];

  if (action === "refresh") {
    await interaction.update(exchangePanelMessage(services));
    return;
  }


  if (action === "balance") {
    const uid = interaction.user.id;
    const ether = services.chips.balanceOf(uid);
    const land = services.ledger.balanceOf(`user:${uid}`);
    const q = ether > 0 ? services.chips.quoteRedeem(ether) : null;
    const embed = new EmbedBuilder()
      .setAuthor({ name: "マモンの賭場 · 財布" })
      .setColor(C_MAMMON)
      .addFields(
        { name: `${E.ether} 所持エテル`, value: `**${fmtEther(ether)}**`, inline: true },
        { name: "🪙 所持 Land", value: `**${fmtLd(land)}**`, inline: true },
        ...(q
          ? [
              {
                name: "💱 今すぐ換金すると",
                value: `**${fmtLd(q.output)}** を1:1で受け取る`,
                inline: false,
              },
            ]
          : []),
      );
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === "buy") {
    const modal = new ModalBuilder()
      .setCustomId("ether:modal:buy")
      .setTitle("入場: Land → エテル")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("amount")
            .setLabel("両替する Land")
            .setPlaceholder("例: 10000")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(12),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  if (action === "sell") {
    const modal = new ModalBuilder()
      .setCustomId("ether:modal:sell")
      .setTitle("返還: 賭場チップ → Land（1:1）")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("amount")
            .setLabel("換金するエテル")
            .setPlaceholder("例: 100000")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(15),
        ),
      );
    await interaction.showModal(modal);
    return;
  }
}

export async function handleEtherModal(interaction: ModalSubmitInteraction, services: Services): Promise<void> {
  const mode = interaction.customId.split(":")[2] as "buy" | "sell";
  const amt = Number(interaction.fields.getTextInputValue("amount").replaceAll(",", "").trim());
  if (!Number.isInteger(amt) || amt <= 0) {
    await interaction.reply({ content: "金額は正の整数で入力してくれ。", flags: MessageFlags.Ephemeral });
    return;
  }
  const uid = interaction.user.id;

  try {
    if (mode === "buy") {
      const q = services.chips.deposit(uid, amt, `chip:deposit:${interaction.id}`);
      const embed = new EmbedBuilder()
        .setAuthor({ name: "マモンの賭場 · 両替所" })
        .setColor(0x22c55e)
        .setTitle(`${E.win} 入場完了`)
        .addFields(
          { name: "支払い", value: `**${fmtLd(amt)}**`, inline: true },
          { name: "受取", value: `**${fmtEther(q.output)}**`, inline: true },
        )
        .setFooter({
          text: `所持 ${fmtEther(services.chips.balanceOf(uid))} · ${fmtLd(services.ledger.balanceOf(`user:${uid}`))}`,
        });
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }
    const q = services.chips.redeem(uid, amt, `chip:redeem:${interaction.id}`);
    const embed = new EmbedBuilder()
      .setAuthor({ name: "マモンの賭場 · 両替所" })
      .setColor(0x991b1b)
      .setTitle(`${E.lose} 返還完了`)
      .addFields(
        { name: "換金", value: `**${fmtEther(amt)}**`, inline: true },
        { name: "着地", value: `**${fmtLd(q.output)}**`, inline: true },
      )
      .setFooter({
        text: `所持 ${fmtEther(services.chips.balanceOf(uid))} · ${fmtLd(services.ledger.balanceOf(`user:${uid}`))}`,
      });
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  } catch (e) {
    let msg = "処理に失敗した。";
    if (e instanceof ChipLedgerError) {
      msg =
        e.code === "ERR_INSUFFICIENT_ETHER"
          ? `エテルが足りない（所持 ${fmtEther(Number(e.meta.held ?? 0))}）。`
          : e.code === "ERR_DUPLICATE"
            ? "この操作はすでに処理済みだ。"
            : "金額が不正だ。";
    } else if (e instanceof LedgerError) {
      msg =
        e.code === "ERR_INSUFFICIENT"
          ? `Land が足りない（所持 ${fmtLd(services.ledger.balanceOf(`user:${uid}`))}）。`
          : `台帳エラー: ${e.code}`;
    }
    await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
  }
}
