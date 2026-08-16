import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type MessageCreateOptions,
} from "discord.js";
import { fmtLd } from "../format.js";
import { C_JACKPOT, C_MAMMON, E, casinoHomeBackRow, h2, withCasinoHomeBack } from "../casino/ui.js";
import { checkRetry, isSeatOccupied } from "../casino/common.js";
import { renderCasinoGameSelect } from "../casino/amount-picker.js";
import { CASINO_SOLO_GAME_EMOJI, isCasinoSoloGame } from "../casino/games.js";
import { recordCasinoMetricBestEffort } from "../casino/metrics.js";
import { openingNotice, openingPhase, operatingLabel } from "../casino/opening.js";
import { isPvpCardButton, handlePvpCardButton } from "../casino/pvp-route.js";
import { readAvailableWallet } from "../casino/wallet.js";
import { renderShop } from "./bakuten.js";
import { itaCreateModal } from "./ita.js";
import { handleNagareboshiCommand } from "./nagareboshi.js";
import { renderStatus as renderVipStatus } from "./vip.js";
import { playKeiba } from "../casino/keiba.js";
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
  // 公開募集カードの accept/cancel は同じ casino:home: 配下だが、通常の本人限定ハブとは
  // ライフサイクルが別。accept はこの先で同期 claim するので、ここでも呼び出し前に await を置かない。
  if (isPvpCardButton(interaction.customId)) {
    await handlePvpCardButton(interaction, services);
    return;
  }
  if (interaction.customId === CASINO_PANEL_OPEN) {
    await interaction.reply({
      ...renderCasinoHome(interaction.user.id, services, interaction.guild?.name),
      flags: MessageFlags.Ephemeral,
    });
    recordCasinoMetricBestEffort(services, {
      eventKey: `home_open:${interaction.id}`,
      eventType: "home_open",
      userId: interaction.user.id,
      operationId: interaction.id,
      payload: { source: "panel" },
    });
    return;
  }
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
    await respondWithHome(interaction, services);
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
  // 競馬・板・VIP・流れ星は、かつて「チャンネルで /競馬 を実行してください」と
  // 案内するだけの行き止まりだった。ハブやパネルまで来た人をコマンドへ突き返さない
  if (interaction.customId === "casino:home:keiba") {
    await playKeiba(interaction, services);
    return;
  }
  if (interaction.customId === "casino:home:ita") {
    await interaction.showModal(itaCreateModal());
    return;
  }
  if (interaction.customId === "casino:home:vip") {
    await interaction.reply({ ...withCasinoHomeBack(renderVipStatus(interaction.user.id, services)), flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.customId === "casino:home:hoshi") {
    await handleNagareboshiCommand(interaction, services);
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
  await respondWithHome(interaction, services, content);
}

/**
 * ホームを返す。**押されたメッセージが公開か本人限定かで返し方を変える。**
 *
 * `/賭場` のホームは ephemeral なので `update()` で差し替えてよい。しかし常設パネルは
 * **チャンネルに公開された1枚**なので、そこで `update()` すると看板そのものが
 * 押した人の残高・所持額・福分け状態入りのホームへ化ける
 * ——個人情報の公開と、常設パネルの破壊が同時に起きる。
 * 公開メッセージから押されたときは元メッセージへ一切触れず、本人にだけ返す。
 */
async function respondWithHome(interaction: ButtonInteraction, services: Services, content?: string): Promise<void> {
  const home = renderCasinoHome(interaction.user.id, services, interaction.guild?.name);
  // content を渡さないときは既存の本文へ触れない（`content: ""` は消去になってしまう）
  const payload = content === undefined ? home : { ...home, content };
  // 判定できないときは公開扱いにする。誤って公開看板を書き換えるより、
  // 本人にだけ返して看板を残すほうが安全（fail-closed の向き）
  if (interaction.message?.flags?.has(MessageFlags.Ephemeral) === true) {
    await interaction.update(payload);
    return;
  }
  await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
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

/**
 * 賭場の常設パネル（`/管理 → パネル → マモンの賭場` で設置）。
 *
 * `/賭場` はコマンドを知っている人しか辿り着けない。チャンネルに常駐する看板を置いて、
 * 目に入った人がそのまま入れるようにする。銀行・ショップ・ランクのパネルと同じ型で、
 * **この1枚は全員が見る**ので個人の残高・福分けの可否・稼働状態は出さない。
 * 状態は押した時点の {@link renderCasinoHome} が最新値を返す。
 */
/**
 * 常設パネルは「賭ける場所」と「それ以外の施設」で分ける。
 *
 * 玄関1枚だと結局そこから探す手数が増えるだけで、「目に入ってすぐ入れる」という
 * 常設パネルの目的が半分しか達成されない。**#賭場 と #賭場施設 のように置き分けられる**
 * ようにして、チャンネルの役割とパネルを一致させる。
 *
 * どちらも**全員が見る1枚**なので、個人の残高・福分けの可否・営業状態は載せない
 * （常設パネルは再投稿時にしか描き直されないキャッシュ済みメッセージなので、
 * 状態を載せると停止中でも「営業中」と出し続けてしまう）。
 * ボタンは既存の `casino:home:*` をそのまま使うので、押した先の挙動は
 * `/賭場` ハブと完全に同じ経路を通る。
 */
export function casinoGamesPanelMessage(_services: Services): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場" })
    .setTitle("🎲  遊ぶ")
    .setColor(C_MAMMON)
    .setDescription(
      [
        "Land を賭けて遊ぶ場所。**操作画面は本人だけに開きます。**",
        "競馬と板は、立てた卓だけがこのチャンネルへ公開されます。",
        "",
        "🎲 **ひとり遊び** — スロット・丁半・クラッシュ・チンチロ・ルーレット・BJ・ポーカー",
        "⚔ **みんなで勝負** — 相手を指名、または募集して対人戦",
        "🏇 **競馬** — 冥馬6頭のレースをこのチャンネルに立てる（60秒受付）",
        "📋 **板** — 議題を立てて何にでも賭けられる公開市場",
        "",
        "-# 賭けは任意参加です。引き際は自分で決めてください。",
      ].join("\n"),
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("casino:home:games").setLabel("ひとり遊び").setEmoji("🎲").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("casino:home:pvp").setLabel("みんなで勝負").setEmoji("⚔").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("casino:home:keiba").setLabel("競馬").setEmoji("🏇").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("casino:home:ita").setLabel("板を立てる").setEmoji("📋").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

/** 賭けない側。商店・通行証・番付・福分け・VIP・流れ星・引き出し */
export function casinoFacilityPanelMessage(_services: Services): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場" })
    .setTitle("🏛  賭場の施設")
    .setColor(C_MAMMON)
    .setDescription(
      [
        "遊ぶ以外の窓口。**押すとあなたにだけ開きます。**",
        "",
        "🛍 **商店** — お守りなどを Land で買う",
        "🎫 **通行証** — 自分の戦績カード",
        "🏅 **番付** — 賭場の順位",
        "🎁 **福分け** — 24時間に1回受け取れる",
        "💎 **VIP** — 月額で賭け上限が上がる",
        "✨ **流れ星** — 1日5回の占い（初回無料）",
        "🚪 **Landへ引き出す** — 賭場に置いている分を戻す",
      ].join("\n"),
    );
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("casino:home:shop").setLabel("商店").setEmoji("🛍").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("casino:home:passport").setLabel("通行証").setEmoji("🎫").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("casino:home:banzuke").setLabel("番付").setEmoji("🏅").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("casino:daily:claim").setLabel("福分け").setEmoji("🎁").setStyle(ButtonStyle.Success),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("casino:home:vip").setLabel("VIP").setEmoji("💎").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("casino:home:hoshi").setLabel("流れ星").setEmoji("✨").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("casino:home:leave").setLabel("Landへ引き出す").setEmoji("🚪").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row1, row2] };
}

export function casinoPanelMessage(_services: Services): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場" })
    .setTitle("🏛  マモンの賭場")
    .setColor(C_MAMMON)
    .setDescription(
      [
        "Land を賭けて遊ぶ場所。**ここから賭場へ入れます。**",
        "スロット・丁半・ポーカーなどのひとり遊びから、対人の勝負、競馬、板、商店まで、",
        "下のボタンを押すとあなたにだけ見える形で開きます。",
        "",
        "-# 賭けは任意参加です。引き際は自分で決めてください。",
      ].join("\n"),
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(CASINO_PANEL_OPEN).setLabel("賭場へ入る").setEmoji("🎰").setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

/**
 * 常設パネルの入口ボタン。
 *
 * `casino:home:` 接頭辞に揃えてあるので、index.ts のルーティングを増やさずに
 * 既存の賭場ハブ経路へ乗る。
 */
export const CASINO_PANEL_OPEN = "casino:home:panel-open";

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
  // 競馬・板・流れ星は押した時点で資金や卓が動くので、停止中は押せなくする。
  // VIP は状態表示なので停止中も開ける（加入の `vip:` 側が別途ガードされる）
  const otherRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("casino:home:keiba").setLabel("競馬").setEmoji("🏇").setStyle(ButtonStyle.Secondary).setDisabled(actionsDisabled),
    new ButtonBuilder().setCustomId("casino:home:ita").setLabel("板").setEmoji("📋").setStyle(ButtonStyle.Secondary).setDisabled(actionsDisabled),
    new ButtonBuilder().setCustomId("casino:home:vip").setLabel("VIP").setEmoji("💎").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("casino:home:hoshi").setLabel("流れ星").setEmoji("✨").setStyle(ButtonStyle.Secondary).setDisabled(actionsDisabled),
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
