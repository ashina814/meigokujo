import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { fmtLd } from "../format.js";
import { C_JACKPOT, C_MAMMON, E, casinoHomeBackRow, h2, withCasinoHomeBack } from "../casino/ui.js";
import { checkRetry, isSeatOccupied } from "../casino/common.js";
import { renderCasinoGameSelect } from "../casino/amount-picker.js";
import { CASINO_SOLO_GAME_EMOJI, isCasinoSoloGame } from "../casino/games.js";
import { recordCasinoMetricBestEffort } from "../casino/metrics.js";
import { openingNotice, openingPhase, operatingLabel } from "../casino/opening.js";
import { readAvailableWallet } from "../casino/wallet.js";
import { renderShop } from "./bakuten.js";
import { renderBanzuke } from "./banzuke.js";
import { buildPassportAttachment } from "./passport.js";
import type { Services } from "../services.js";

const DEFAULT_GAME = "スロット";
const DEFAULT_BET = 100;

export const casinoHomeCommand = new SlashCommandBuilder()
  .setName("賭場")
  .setDescription("🏛 マモンの賭場ホーム")
  .setDMPermission(false);

export async function handleCasinoHomeCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  await interaction.reply({
    ...renderCasinoHome(interaction.user.id, services, interaction.guild?.name),
    flags: MessageFlags.Ephemeral,
  });
  recordCasinoMetricBestEffort(services, {
    eventKey: `home_open:${interaction.id}`,
    eventType: "home_open",
    userId: interaction.user.id,
    operationId: interaction.id,
    payload: { source: "command" },
  });
}

export async function handleCasinoHomeButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  if (interaction.customId === "casino:daily:claim") {
    await claimDailyFromHome(interaction, services);
    return;
  }
  if (interaction.customId === "casino:home:games") {
    await interaction.reply({
      ...renderCasinoGameSelect(),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.customId === "casino:home:back") {
    await interaction.update(renderCasinoHome(interaction.user.id, services, interaction.guild?.name));
    return;
  }
  if (interaction.customId === "casino:home:pvp") {
    await interaction.reply({ ...renderPvpGuide(services), flags: MessageFlags.Ephemeral });
    return;
  }
  // ハブから開いた子画面には戻る導線を足す。単体コマンド（/賭場商店 など）で
  // 開いたときは付かないので、そちらの見た目は変わらない
  if (interaction.customId === "casino:home:shop") {
    await interaction.reply({ ...withCasinoHomeBack(renderShop(interaction.user.id, services)), flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.customId === "casino:home:banzuke") {
    await interaction.reply({
      ...withCasinoHomeBack(renderBanzuke(services, "balance", interaction.user.id)),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.customId === "casino:home:passport") {
    // 画像生成に時間がかかるので先に defer する
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply({
      files: [await buildPassportAttachment(interaction, services)],
      components: [casinoHomeBackRow()],
    });
    return;
  }
  const link = SIDE_GAME_GUIDE[interaction.customId];
  if (link) {
    await interaction.reply({ content: link, flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.customId === "casino:home:first") {
    await interaction.reply({ ...renderGuide(services), flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.customId === "casino:home:leave") {
    await leaveCasinoFromHome(interaction, services);
    return;
  }
}

/**
 * 賭場に置いている分を Land へ引き出す。判定は core（chipFlow.leaveCasino）が持ち、
 * ここは結果を言葉にするだけ。進行中の預託がある場合は core が見送るので、
 * 「引き出せる額が無い」と混ぜずにその理由を出す。
 *
 * 利用者向けの文面では内部台帳の語（チップ・自由チップ・チップ帳簿）を出さない。
 */
async function leaveCasinoFromHome(interaction: ButtonInteraction, services: Services): Promise<void> {
  if (isSeatOccupied(interaction.user.id)) {
    await interaction.reply({ content: "進行中の勝負が終わってからにしてください。", flags: MessageFlags.Ephemeral });
    return;
  }
  let content: string;
  try {
    const result = services.chipFlow.leaveCasino(interaction.user.id, `leave:${interaction.id}`);
    content =
      result.skipped === "active_ownership"
        ? "進行中の勝負や板があるため、いまは引き出せません。終わってからもう一度押してください。"
        : result.redeemed > 0
          ? `${fmtLd(result.land)} をLandへ引き出しました。`
          : "いま引き出せる分はありません。";
  } catch {
    content = "残高または進行状態を確認できないため、いまは引き出せません。";
  }
  await interaction.update({ ...renderCasinoHome(interaction.user.id, services, interaction.guild?.name), content });
}

/**
 * チャンネルに公開の卓を立てる遊びは、本人にだけ見えるハブからは開けない。
 * ここは「何ができるか」と「どのコマンドか」を示すだけにする。
 */
const SIDE_GAME_GUIDE: Readonly<Record<string, string>> = {
  "casino:home:keiba": "🏇 **競馬** — 冥馬6頭のパリミュチュエル（単勝・複勝）。\nチャンネルで `/競馬` を実行すると発走します。",
  "casino:home:ita": "📋 **板** — 議題を立てて何にでも賭けられる公開市場。\nチャンネルで `/板 立てる` を実行します。進行中は `/板 一覧`。",
  "casino:home:vip": "💎 **VIP** — 月額で賭け上限が上がります。`/vip` で条件と期限を確認できます。",
  "casino:home:hoshi": "✨ **流れ星** — 1日5回の占い（初回無料）。`/流れ星` で引けます。",
};

/**
 * 対人戦の案内。
 *
 * 以前は「永続卓と従業員導線は PR20 以降です」と書いたまま固定されていたが、
 * 順位卓・従業員運営・異議処理は 2026-08-16 に廃止した。
 */
function renderPvpGuide(services: Services) {
  const phase = openingPhase(services);
  const status = services.casinoStatus.current();
  const open = phase === "formal" && status.status === "open";
  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · みんなで勝負" })
    .setColor(open ? C_MAMMON : 0x78716c)
    .setTitle("⚔  みんなで勝負")
    .setDescription(
      [
        "**その場で始める**（相手を指名、または募集）",
        "`/勝負 チンチロ` `/勝負 bj` `/勝負 サシ` `/勝負 インディアン` `/勝負 ポーカー`",
        "`/勝負 丁半` は多人数戦（60秒受付・両側そろえば成立）",
      ].join("\n"),
    );
  if (!open) {
    embed.addFields({
      name: "▸ いまは受け付けていません",
      value: phase !== "formal" ? openingNotice(services) : `賭場を停止中です（${status.reason}）`,
      inline: false,
    });
  }
  return { embeds: [embed], components: [casinoHomeBackRow()] };
}

/** 遊び方。旧「はじめて」を、賭場全体の地図として使えるところまで広げる */
function renderGuide(services: Services) {
  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · 遊び方" })
    .setColor(C_MAMMON)
    .setTitle("📖  賭場の歩き方")
    .setDescription(
      [
        "**覚えるのは `/賭場` だけでいい。** ここから全部に行けます。",
        "",
        "**お金の単位**",
        "すべて Land（Ld）で数えます。遊ぶときに必要な分は自動で賭場へ移り、**1 Ld はそのまま 1 Ld** です。",
        "「Landへ引き出す」で、賭場に置いている分をいつでも手元へ戻せます。",
        "卓に預けている担保は、勝負が終わるまで所持額に含みません。",
        "",
        "**遊ぶ**",
        "ひとりで遊ぶなら「遊びを選ぶ」。スロット・丁半・クラッシュ・チンチロ・ルーレット・BJ・ポーカー・ホールデム。",
        "誰かと遊ぶなら「みんなで勝負」。",
        "",
        "**続けるために**",
        "「福分け」は1日1回受け取れます。連続日数でボーナスが増えます。",
        "「商店」のお守りは、買って装備すると条件を満たしたときに自動で効きます。",
        "",
        "**記録**",
        "「通行証・戦績」は自分の成績カード、「番付」は上位10人です。",
        "",
        // 株は導線から外しているが、建玉を持っている人が「消えた」と誤解しないよう
        // 停止していることだけは必ず残す（旧 /案内 から引き継いだ告知）
        "**株式市場は現在 停止中** です。持っている株はそのままで、購入も売却もできません。`/株` で詳細を出せます。",
        "",
        "-# 停止中や正式開業前は、押しても資金は動きません。現在の状態と理由はホームの先頭に出ています。",
      ].join("\n"),
    );
  return { embeds: [embed], components: [casinoHomeBackRow()] };
}

export function renderCasinoHome(userId: string, services: Services, serverName?: string) {
  const phase = openingPhase(services);
  const status = services.casinoStatus.current();
  const daily = dailyState(userId, services, phase, status.status);
  const wallet = casinoHomeWallet(userId, services);
  const jp = phase === "unknown" ? null : services.casino.jackpotPool();
  const primary = phase === "formal" && status.status === "open" ? primaryAction(userId, services) : defaultPrimaryAction();
  const actionsDisabled = phase !== "formal" || status.status !== "open";
  const jpLabel = jp === null ? `${E.jp} JP 確認停止` : `${E.jp} JP ${fmtLd(jp)}`;

  const lines = [
    operatingLabel(services),
    "",
    wallet.lines.join("\n"),
    daily.label,
    jpLabel,
  ];
  if (phase !== "formal") lines.push("", openingNotice(services));
  else if (status.status !== "open") lines.push("", `資金操作停止中: ${status.reason}`);

  const embed = new EmbedBuilder()
    .setAuthor({ name: `${serverName ?? "冥獄城"} · マモンの賭場` })
    .setColor(jp !== null && jp >= 100_000 ? C_JACKPOT : C_MAMMON)
    .setDescription(lines.filter((line, index, arr) => line !== "" || arr[index - 1] !== "").join("\n"))
    .setFooter({ text: wallet.footer });

  // 段は役割で分ける。1段目=遊ぶ / 2段目=賭場の設備 / 3段目=別系統の賭け / 4段目=受け取りと案内。
  // 「/賭場 だけ覚えていれば全部に届く」ことを、段の並びで示す
  const playRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(primary.customId)
      .setLabel(primary.label)
      .setEmoji(primary.emoji)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(actionsDisabled),
    new ButtonBuilder()
      .setCustomId("casino:home:games")
      .setLabel("遊びを選ぶ")
      .setEmoji("🎲")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(actionsDisabled),
    new ButtonBuilder()
      .setCustomId("casino:home:pvp")
      .setLabel("みんなで勝負")
      .setEmoji("⚔")
      .setStyle(ButtonStyle.Secondary),
  );
  const facilityRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("casino:home:shop")
      .setLabel("商店")
      .setEmoji("🛍")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(actionsDisabled),
    new ButtonBuilder()
      .setCustomId("casino:home:passport")
      .setLabel("通行証・戦績")
      .setEmoji("🎫")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("casino:home:banzuke")
      .setLabel("番付")
      .setEmoji("🏅")
      .setStyle(ButtonStyle.Secondary),
  );
  const otherRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("casino:home:keiba").setLabel("競馬").setEmoji("🏇").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("casino:home:ita").setLabel("板").setEmoji("📋").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("casino:home:vip").setLabel("VIP").setEmoji("💎").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("casino:home:hoshi").setLabel("流れ星").setEmoji("✨").setStyle(ButtonStyle.Secondary),
  );
  const guideRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("casino:daily:claim")
      .setLabel("福分け")
      .setEmoji("🎁")
      .setStyle(daily.ready ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(actionsDisabled || !daily.ready),
    new ButtonBuilder()
      .setCustomId("casino:home:first")
      .setLabel("遊び方")
      .setEmoji("📖")
      .setStyle(ButtonStyle.Secondary),
    // 賭場に置いている分を Land へ引き出す導線。旧 /案内 にボタンだけあったが customId が
    // どこにもルーティングされておらず、押しても無反応の死んだ導線だった。
    // 正規ハブへ繋ぎ直す（core の leaveCasino はそのまま使う）
    new ButtonBuilder()
      .setCustomId("casino:home:leave")
      .setLabel("Landへ引き出す")
      .setEmoji("🚪")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(actionsDisabled),
  );

  return { embeds: [embed], components: [playRow, facilityRow, otherRow, guideRow] };
}


function casinoHomeWallet(userId: string, services: Services): { lines: string[]; footer: string } {
  const wallet = readAvailableWallet(services, userId);
  if (wallet.status === "unknown") {
    return {
      lines: [`所持 ${fmtLd(wallet.land)}（手元のLandのみ）`, "賭場に置いている分・卓に預けている分を確認できません"],
      footer: "賭場の版が異常",
    };
  }
  if (wallet.status === "pre_opening") {
    return {
      lines: [`手元のLand ${fmtLd(wallet.land)}`, "賭場での利用は正式開業後に始まります"],
      footer: "正式開業準備中",
    };
  }
  if (wallet.status === "ledger_error") {
    return {
      lines: [`所持 ${fmtLd(wallet.land)}（手元のLandのみ）`, "賭場に置いている分を確認できません"],
      footer: "賭場の残高を確認できません",
    };
  }
  if (wallet.status === "overflow") {
    return {
      lines: [`所持 ${fmtLd(wallet.land)}（手元のLandのみ）`, "残高の合算に失敗しました"],
      footer: "残高合算エラー",
    };
  }
  // ホームで真っ先に読みたいのは「いくら持っているか」の一点。
  // 内訳と同じ字送りで並べると探す手間が生まれるので、額だけ見出しへ上げる
  return {
    lines: [
      h2(`所持 ${fmtLd(wallet.available)}`),
      wallet.escrowed! > 0 ? `預け中 ${fmtLd(wallet.escrowed!)}` : "",
    ].filter(Boolean),
    footer: `手元 ${fmtLd(wallet.land)} · 賭場に置いている分 ${fmtLd(wallet.freeChips!)} · 卓に預け中 ${fmtLd(wallet.escrowed!)}`,
  };
}

function dailyState(
  userId: string,
  services: Services,
  phase: ReturnType<typeof openingPhase>,
  casinoStatus: string,
): { ready: boolean; label: string } {
  if (phase === "unknown") {
    return { ready: false, label: "福分け 確認停止" };
  }
  if (phase !== "formal") {
    return { ready: false, label: "福分けは正式開業後に利用できます" };
  }
  if (casinoStatus !== "open") {
    return { ready: false, label: "福分けは現在停止中" };
  }
  const nextClaim = services.daily.nextClaimAt(userId);
  const ready = nextClaim === 0 || nextClaim <= Math.floor(Date.now() / 1000);
  return {
    ready,
    label: ready ? "今日の福分けが受け取れる" : `今日の福分けはまだ（次は <t:${nextClaim}:R>）`,
  };
}

function primaryAction(userId: string, services: Services): { label: string; emoji: string; customId: string } {
  const pref = services.casino.homePreference(userId);
  if (pref && isCasinoSoloGame(pref.last_game)) {
    const retry = checkRetry(services, userId, pref.last_amount, pref.last_game);
    if (retry.ok) {
      return {
        label: `${pref.last_game} ${pref.last_amount.toLocaleString("ja-JP")} Ldでもう一度`,
        emoji: CASINO_SOLO_GAME_EMOJI[pref.last_game] ?? "🎰",
        customId: `casino:primary:${pref.last_game}:${pref.last_amount}`,
      };
    }
  }
  return defaultPrimaryAction();
}

function defaultPrimaryAction(): { label: string; emoji: string; customId: string } {
  return {
    label: `${DEFAULT_BET.toLocaleString("ja-JP")} Ldで遊ぶ`,
    emoji: "🎰",
    customId: `casino:primary:${DEFAULT_GAME}:${DEFAULT_BET}`,
  };
}

async function claimDailyFromHome(interaction: ButtonInteraction, services: Services): Promise<void> {
  const r = services.daily.claim(interaction.user.id, interaction.id);
  if (!r.ok) {
    await interaction.reply({
      content: `今日の福分けは受け取り済みです。次は <t:${r.nextClaimAt}:R>。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.reply({
    content: `福分けを受け取りました: +${fmtLd(r.claim.total)}`,
    flags: MessageFlags.Ephemeral,
  });
}
