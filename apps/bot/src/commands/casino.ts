import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { CasinoError, type RouletteBet } from "@meigokujo/core";
import { isAdmin } from "../permissions.js";
import type { Services } from "../services.js";

const chip = (n: number) => `${n.toLocaleString()} チップ`;

export const casinoCommand = new SlashCommandBuilder()
  .setName("カジノ")
  .setDescription("冥獄カジノ（チップで遊ぶ）")
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName("コイン")
      .setDescription("コイン投げ。当たれば1.95倍")
      .addIntegerOption((o) => o.setName("賭け").setDescription("賭けるチップ").setRequired(true).setMinValue(1))
      .addStringOption((o) => o.setName("面").setDescription("表 or 裏").setRequired(true).addChoices({ name: "表", value: "表" }, { name: "裏", value: "裏" })),
  )
  .addSubcommand((sub) =>
    sub.setName("スロット").setDescription("スロット。7揃いで50倍").addIntegerOption((o) => o.setName("賭け").setDescription("賭けるチップ").setRequired(true).setMinValue(1)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("ルーレット")
      .setDescription("ルーレット。色/偶奇は2倍、数字的中は36倍")
      .addIntegerOption((o) => o.setName("賭け").setDescription("賭けるチップ").setRequired(true).setMinValue(1))
      .addStringOption((o) => o.setName("対象").setDescription("赤 / 黒 / 偶 / 奇 / 0〜36 の数字").setRequired(true).setMaxLength(3)),
  )
  .addSubcommand((sub) => sub.setName("残高").setDescription("自分のチップと胴元の状況"))
  .addSubcommand((sub) =>
    sub.setName("資金").setDescription("胴元にチップを入れる（運営）").addIntegerOption((o) => o.setName("チップ").setDescription("入れるチップ").setRequired(true).setMinValue(1)),
  )
  .addSubcommand((sub) =>
    sub.setName("回収").setDescription("胴元の売上を引き出す（運営）").addIntegerOption((o) => o.setName("チップ").setDescription("引き出すチップ").setRequired(true).setMinValue(1)),
  );

function parseRoulette(raw: string): RouletteBet | null {
  const t = raw.trim();
  if (t === "赤" || t === "黒") return { kind: "color", value: t };
  if (t === "偶" || t === "奇") return { kind: "parity", value: t };
  if (/^\d{1,2}$/.test(t)) {
    const n = Number(t);
    if (n >= 0 && n <= 36) return { kind: "straight", value: n };
  }
  return null;
}

function betErr(e: unknown): string {
  if (e instanceof CasinoError && e.code === "ERR_INSUFFICIENT_CHIPS") return `チップが足りません（保有 ${chip(Number(e.meta.held))}）。/為替 両替 で増やせます。`;
  if (e instanceof CasinoError && e.code === "ERR_HOUSE_SHORT") return "胴元の資金が不足しています（大きすぎる賭け）。運営に開帳資金の補充を頼んでください。";
  if (e instanceof CasinoError && e.code === "ERR_BAD_PICK") return "賭け対象が正しくありません。";
  return "処理に失敗しました。";
}

export async function handleCasinoCommand(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  const sub = interaction.options.getSubcommand();
  const uid = interaction.user.id;

  if (sub === "残高") {
    await interaction.reply({
      content: `🎰 あなたのチップ: **${chip(services.chips.balanceOf(uid))}** ／ 胴元の資金: ${chip(services.casino.houseBalance())}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === "資金" || sub === "回収") {
    if (!isAdmin(interaction, services)) {
      await interaction.reply({ content: "胴元の資金操作は運営のみ可能です。", flags: MessageFlags.Ephemeral });
      return;
    }
    const amount = interaction.options.getInteger("チップ", true);
    try {
      if (sub === "資金") services.casino.fundHouse(uid, amount);
      else services.casino.withdrawHouse(uid, amount);
      await interaction.reply({ content: `✅ 胴元${sub === "資金" ? "へ入金" : "から回収"}: ${chip(amount)}（胴元残 ${chip(services.casino.houseBalance())}）。`, flags: MessageFlags.Ephemeral });
    } catch (e) {
      await interaction.reply({ content: `❌ ${betErr(e)}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  const bet = interaction.options.getInteger("賭け", true);
  try {
    if (sub === "コイン") {
      const pick = interaction.options.getString("面", true) as "表" | "裏";
      const r = services.casino.coin(uid, bet, pick);
      await interaction.reply({
        embeds: [resultEmbed("🪙 コイン投げ", `結果は **${r.outcome}**！ あなたは ${r.pick} に ${chip(bet)}`, r.win, r.net, services.chips.balanceOf(uid))],
      });
      return;
    }
    if (sub === "スロット") {
      const r = services.casino.slot(uid, bet);
      const line = `[ ${r.reels.join(" | ")} ]`;
      const tag = r.multiplier >= 50 ? "🎉 **JACKPOT!!**" : r.multiplier >= 10 ? "✨ 大当たり！" : r.multiplier > 0 ? "当たり" : "ハズレ";
      await interaction.reply({
        embeds: [resultEmbed("🎰 スロット", `${line}\n${tag}${r.multiplier > 0 ? `（×${r.multiplier}）` : ""}`, r.multiplier >= 1 && r.net >= 0, r.net, services.chips.balanceOf(uid))],
      });
      return;
    }
    // ルーレット
    const target = parseRoulette(interaction.options.getString("対象", true));
    if (!target) {
      await interaction.reply({ content: "対象は 赤 / 黒 / 偶 / 奇 か 0〜36 の数字で指定してください。", flags: MessageFlags.Ephemeral });
      return;
    }
    const r = services.casino.roulette(uid, bet, target);
    const colorMark = r.color === "赤" ? "🔴" : r.color === "黒" ? "⚫" : "🟢";
    await interaction.reply({
      embeds: [resultEmbed("🎡 ルーレット", `出目は ${colorMark} **${r.number}**（${r.color}）！ あなたは「${r.target}」に ${chip(bet)}`, r.win, r.net, services.chips.balanceOf(uid))],
    });
  } catch (e) {
    await interaction.reply({ content: `❌ ${betErr(e)}`, flags: MessageFlags.Ephemeral });
  }
}

function resultEmbed(title: string, body: string, win: boolean, net: number, balance: number): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(win ? 0xf0b429 : 0x52525b)
    .setDescription([body, "", win ? `➕ **${chip(net)}** の勝ち！` : `➖ ${chip(-net)} の負け…`, `残り ${chip(balance)}`].join("\n"));
}
