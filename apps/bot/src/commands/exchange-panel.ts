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
import { EtherError, LedgerError } from "@meigokujo/core";
import { fmtLd, fmtEther } from "../format.js";
import { C_MAMMON, E, HR_THIN } from "../casino/ui.js";
import type { Services } from "../services.js";

/**
 * マモンの両替所（Land⇄エテル 変動為替パネル）。
 * - 入場（Land→エテル）はフェアレート・手数料なし
 * - 退場（エテル→Land）は 20% 奉納（80%着地 / 10%焼却=Landシンク / 10%プール残留）
 */

function ratePanel(services: Services): EmbedBuilder {
  const rate = services.ether.rate();
  const pool = services.ether.pool();
  const outstanding = services.ether.outstanding();

  // 直感的にわかる例示 (10,000 Ld で何エテル？ / 10,000 ◈ で何 Ld？)
  const sampleBuy = services.ether.quoteBuy(10_000);
  const sampleSell = services.ether.quoteSell(100_000);

  return new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · 両替所" })
    .setTitle(`${E.jp} 現在レート  1 Ld ＝ ${rate.toFixed(2)} ${E.ether}`)
    .setColor(C_MAMMON)
    .setDescription(
      [
        "**入場フェア／退場二割奉納**",
        `　入る側 ${E.win} 手数料ゼロで満額エテル化`,
        `　出る側 ${E.lose} 20%奉納（80%着地／10%焼却／10%プール残留）`,
        "",
        HR_THIN,
        `**目安**`,
        `　${E.up} 入場: 10,000 Ld → **${sampleBuy.output.toLocaleString()} ${E.ether}**`,
        `　${E.down} 退場: 100,000 ${E.ether} → **${sampleSell.output.toLocaleString()} Ld**（焼却 ${sampleSell.burned.toLocaleString()} Ld）`,
      ].join("\n"),
    )
    .addFields(
      { name: `${E.chart} 準備プール`, value: `${fmtLd(pool)}`, inline: true },
      { name: `${E.chart} 発行エテル`, value: `${outstanding.toLocaleString()} ${E.ether}`, inline: true },
      { name: `${E.chart} 実効レート`, value: `1 ${E.ether} ≈ ${(1 / Math.max(rate, 0.0001)).toFixed(4)} Ld`, inline: true },
    )
    .setFooter({ text: "レートは変動制。他人が退場すると残った人のエテルが少し肥える" });
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
    const ether = services.ether.balanceOf(uid);
    const land = services.ledger.balanceOf(`user:${uid}`);
    const q = ether > 0 ? services.ether.quoteSell(ether) : null;
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
                value: `**${fmtLd(q.output)}** 着地（焼却 ${fmtLd(q.burned)}）`,
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
      .setTitle("退場: エテル → Land（二割奉納）")
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
      const q = services.ether.buy(uid, amt, `ether:buy:${interaction.id}`);
      const embed = new EmbedBuilder()
        .setAuthor({ name: "マモンの賭場 · 両替所" })
        .setColor(0x22c55e)
        .setTitle(`${E.win} 入場完了`)
        .addFields(
          { name: "支払い", value: `**${fmtLd(amt)}**`, inline: true },
          { name: "受取", value: `**${fmtEther(q.output)}**`, inline: true },
        )
        .setFooter({
          text: `所持 ${fmtEther(services.ether.balanceOf(uid))} · ${fmtLd(services.ledger.balanceOf(`user:${uid}`))}`,
        });
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }
    const q = services.ether.sell(uid, amt, `ether:sell:${interaction.id}`);
    const embed = new EmbedBuilder()
      .setAuthor({ name: "マモンの賭場 · 両替所" })
      .setColor(0x991b1b)
      .setTitle(`${E.lose} 退場完了（二割奉納済）`)
      .addFields(
        { name: "換金", value: `**${fmtEther(amt)}**`, inline: true },
        { name: "着地", value: `**${fmtLd(q.output)}**`, inline: true },
        { name: "焼却", value: `${fmtLd(q.burned)}`, inline: true },
      )
      .setFooter({
        text: `所持 ${fmtEther(services.ether.balanceOf(uid))} · ${fmtLd(services.ledger.balanceOf(`user:${uid}`))}`,
      });
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  } catch (e) {
    let msg = "処理に失敗した。";
    if (e instanceof EtherError) {
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
          : e.code === "ERR_MINOR_BLOCKED"
            ? "未成年は賭場に入れない。掟だ。"
            : `台帳エラー: ${e.code}`;
    }
    await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
  }
}
