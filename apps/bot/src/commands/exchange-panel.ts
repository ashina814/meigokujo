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
import type { Services } from "../services.js";

/**
 * マモンの両替所（Land⇄エテル 変動為替パネル）。
 * - 入場（Land→エテル）はフェアレート・手数料なし
 * - 退場（エテル→Land）は 20% 奉納（80%着地 / 10%焼却=Landシンク / 10%プール残留）
 * レート = 発行エテル ÷ 準備プールLand で自動変動する。
 */

const MAMMON_COLOR = 0xc9a227; // 強欲の金

/** マモンの口上（両替所トップ） */
const MAMMON_GREETING = [
  "「よく来たな。ここは俺の両替所だ。」",
  "",
  "**入るのはタダ**にしといてやる。だが出るときは**二割置いていけ**——それが賭場の掟だ。",
  "レートは生き物でな、賭場に残った奴のエテルは他人の退場でちょっとずつ肥える。",
].join("\n");

function rateLines(services: Services): string {
  const rate = services.ether.rate();
  const pool = services.ether.pool();
  const outstanding = services.ether.outstanding();
  const landPerEther = rate > 0 ? 1 / rate : 0;
  return [
    `**現在レート**: 1 Ld = **${rate.toFixed(2)} ◈** （1 ◈ ≈ ${landPerEther.toFixed(4)} Ld）`,
    `**準備プール**: ${fmtLd(pool)} ／ **発行エテル**: ${fmtEther(outstanding)}`,
  ].join("\n");
}

export function exchangePanelMessage(services: Services) {
  const embed = new EmbedBuilder()
    .setTitle("💰 マモンの両替所")
    .setColor(MAMMON_COLOR)
    .setDescription([MAMMON_GREETING, "", rateLines(services)].join("\n"));
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ether:buy").setLabel("Land → エテル").setEmoji("🔸").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ether:sell").setLabel("エテル → Land").setEmoji("🔹").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ether:balance").setLabel("残高").setEmoji("👛").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ether:refresh").setLabel("相場更新").setEmoji("🔁").setStyle(ButtonStyle.Secondary),
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
    await interaction.reply({
      content: [
        `👛 所持エテル: **${fmtEther(ether)}** ／ 所持 Land: **${fmtLd(land)}**`,
        q ? `今すべて換金すると **${fmtLd(q.output)}** になる（二割は奉納）。` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === "buy") {
    const modal = new ModalBuilder()
      .setCustomId("ether:modal:buy")
      .setTitle("Land → エテル（入場・手数料なし）")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("amount").setLabel("両替する Land").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  if (action === "sell") {
    const modal = new ModalBuilder()
      .setCustomId("ether:modal:sell")
      .setTitle("エテル → Land（退場・二割奉納）")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("amount").setLabel("換金するエテル").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(15),
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
    await interaction.reply({ content: "金額は正の整数で入力してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  const uid = interaction.user.id;

  try {
    if (mode === "buy") {
      const q = services.ether.buy(uid, amt, `ether:buy:${interaction.id}`);
      await interaction.reply({
        content: [
          `🔸 **${fmtLd(amt)}** を **${fmtEther(q.output)}** に両替した。`,
          `「まいど。せいぜい派手に散らしてくれ。」`,
          `👛 所持エテル: **${fmtEther(services.ether.balanceOf(uid))}**`,
        ].join("\n"),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const q = services.ether.sell(uid, amt, `ether:sell:${interaction.id}`);
    await interaction.reply({
      content: [
        `🔹 **${fmtEther(amt)}** を換金して **${fmtLd(q.output)}** を受け取った（焼却 ${fmtLd(q.burned)}）。`,
        `「二割は置いていけよ。約束だからな。」`,
        `👛 所持エテル: **${fmtEther(services.ether.balanceOf(uid))}** ／ 所持 Land: **${fmtLd(services.ledger.balanceOf(`user:${uid}`))}**`,
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
    });
  } catch (e) {
    let msg = "処理に失敗しました。";
    if (e instanceof EtherError) {
      msg =
        e.code === "ERR_INSUFFICIENT_ETHER"
          ? `エテルが足りない（所持 ${fmtEther(Number(e.meta.held ?? 0))}）。`
          : e.code === "ERR_DUPLICATE"
            ? "この操作はすでに処理済みです。"
            : "金額が不正です。";
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
