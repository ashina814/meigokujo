import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type MessageCreateOptions,
} from "discord.js";
import { getRoleIds } from "../church-roles.js";
import { C_MAMMON } from "../casino/ui.js";
import type { Services } from "../services.js";

/**
 * 常設パネルは「そのチャンネルで何をするか」を一枚で伝える。
 * `/賭場` はどこからでも使える総合入口として残すが、カテゴリ内では用途ごとに分散する。
 */
export function casinoSoloPanelMessage(_services: Services): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場" })
    .setTitle("🎲  遊ぶ")
    .setColor(C_MAMMON)
    .setDescription(
      [
        "賭場の基本ゲームを遊ぶ場所です。",
        "操作画面は基本的に本人だけに開きますが、**ルーレットだけは30秒間みんなが参加できる公開卓**です。",
        "",
        "🎰 スロット / 🎲 丁半 / 📈 クラッシュ / 🎲 チンチロ",
        "🎡 ルーレット / 🃏 BJ / 🃏 ポーカー / 🃏 ホールデム",
        "",
        "下のボタンからゲームと賭け金を選んでください。",
        "-# 対人募集・競馬・板は、それぞれの専用パネルから行います。",
      ].join("\n"),
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("casino:home:games")
      .setLabel("遊びを選ぶ")
      .setEmoji("🎲")
      .setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

export function casinoPvpPanelMessage(services: Services): MessageCreateOptions {
  const roleIds = getRoleIds(services, "casino_pvp_notify");
  const notifyLine =
    roleIds.length > 0
      ? `募集時は ${roleIds.map((id) => `<@&${id}>`).join(" ")} に通知します。1人につき3募集連続まで通知し、その後5分間だけCDに入ります。`
      : "募集通知ロールは未設定です。運営は `/管理 → 設定 → 機関ロール` から最大5ロールまで設定できます。";
  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場" })
    .setTitle("⚔  みんなで勝負")
    .setColor(C_MAMMON)
    .setDescription(
      [
        "公開1v1の**募集専用**パネルです。",
        "ゲームと賭け金を決めると、このチャンネルに3分間の募集カードを出します。",
        "最初に「受ける」を押した1人と勝負します。",
        "",
        notifyLine,
        "-# 通知がCD中でも募集カード自体は通常どおり投稿されます。別の人の募集通知には影響しません。",
        "-# 募集中はLandを預かりません。成立した瞬間に双方を確認して預かります。",
      ].join("\n"),
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("casino:home:pvp")
      .setLabel("対戦相手を募集する")
      .setEmoji("⚔")
      .setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

export function casinoKeibaPanelMessage(_services: Services): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場" })
    .setTitle("🏇  競馬")
    .setColor(C_MAMMON)
    .setDescription(
      [
        "競馬を立てるための専用パネルです。",
        "冥馬6頭のレースをこのチャンネルに公開し、**60秒間** みんなの賭けを受け付けます。",
        "",
        "下のボタンからレースを開始してください。",
      ].join("\n"),
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("casino:home:keiba")
      .setLabel("競馬を立てる")
      .setEmoji("🏇")
      .setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

export function casinoItaPanelMessage(_services: Services): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場" })
    .setTitle("📋  賭け板")
    .setColor(C_MAMMON)
    .setDescription(
      [
        "公開の賭けを立てるための専用パネルです。",
        "イベント予想・勝敗予想など、議題を作ってみんなに賭けてもらえます。",
        "",
        "下のボタンから板を作成してください。",
      ].join("\n"),
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("casino:home:ita")
      .setLabel("板を立てる")
      .setEmoji("📋")
      .setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}
