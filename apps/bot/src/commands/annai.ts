import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  ChipLedgerError,
  type OpeningPhase,
  type UserChipAssets,
} from "@meigokujo/core";
import { fmtEther, fmtLd } from "../format.js";
import { C_MAMMON, C_JACKPOT, E, HR_THIN, fmtSignedEther } from "../casino/ui.js";
import { openingNotice, openingPhase } from "../casino/opening.js";
import { isSeatOccupied } from "../casino/common.js";
import type { Services } from "../services.js";

/**
 * /案内 — マモンの賭場ホーム画面。
 * setFields で情報を6セクションに分けて視覚階層を明確に:
 * ① 財布   ② 賭場相場   ③ 福分けと日々の稼ぎ
 * ④ 戦績   ⑤ 遊び方入口   ⑥ 経済・投資入口
 */
export const annaiCommand = new SlashCommandBuilder()
  .setName("案内")
  .setDescription("🏛 マモンの賭場のホーム画面")
  .setDMPermission(false);

export async function handleAnnaiCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  await interaction.reply({ ...renderHome(interaction.user.id, services, interaction.guild?.name), flags: MessageFlags.Ephemeral });
}

export async function handleAnnaiButton(interaction: import("discord.js").ButtonInteraction, services: Services): Promise<void> {
  if (interaction.customId === "annai:refresh") {
    await interaction.update(renderHome(interaction.user.id, services, interaction.guild?.name));
    return;
  }
  if (interaction.customId === "casino:leave") {
    if (isSeatOccupied(interaction.user.id)) {
      await interaction.reply({ content: "進行中の勝負が終わってから賭場を出てください。", flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      const result = services.chipFlow.leaveCasino(interaction.user.id, `leave:${interaction.id}`);
      // 進行中の所有で見送った場合を「返還可能額なし」と表示しない（監査ブロッカーA）。
      // 資金は賭場に残っているので、解消後に押し直せば返せると伝える
      const content = result.skipped === "active_ownership"
        ? "進行中の勝負・預託・板があるため、いまは返還できません。終わってからもう一度押してください。"
        : result.redeemed > 0
          ? `${fmtLd(result.land)} をLandへ返還しました。`
          : "返還できる自由チップはありません。";
      await interaction.update({
        ...renderHome(interaction.user.id, services, interaction.guild?.name),
        content,
      });
    } catch {
      await interaction.reply({ content: "チップ帳簿または進行状態を確認できないため返還できません。", flags: MessageFlags.Ephemeral });
    }
  }
}

export interface WalletDisplayInput {
  phase: OpeningPhase;
  heldLand: number;
  assets: UserChipAssets | null;
  assetError: boolean;
  isVip: boolean;
  vipDaysLeft: number;
}

/**
 * PR13: 「所持 = 通常Land + 自由チップ」へ統合した財布表示（正本 §4.3）。
 *
 * 正式開業前・未知版・チップ帳簿エラー時は、自由チップ・預け中資金を
 * 利用可能額へ含めない（資産分類を誤らない・fail-closed）。
 * 拘束中資金（卓・板への預け）があるときだけ補助行を出す。
 */
export function renderWalletValue(input: WalletDisplayInput): string {
  const vipLine = input.isVip ? `${E.jp} **VIP** 残り${input.vipDaysLeft}日` : "";
  if (input.phase === "unknown") {
    return [
      "⚠️ **賭場の版が異常です**",
      "自由チップ・預け中資金は確認できません（利用可能額へ含めません）",
      `所持 ${fmtLd(input.heldLand)}（通常Landのみ）`,
      vipLine,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (input.phase !== "formal") {
    return [
      "🚧 **正式開業準備中**",
      "既存チップ残高は保持中です（正式開業まで利用可能額へ含めません）",
      `所持 ${fmtLd(input.heldLand)}（通常Landのみ）`,
      vipLine,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (input.assetError || !input.assets) {
    return [
      "⚠️ **チップ帳簿を確認できません**",
      "破損値を0として表示せず、自由チップ・預け中資金の表示を停止しています",
      `所持 ${fmtLd(input.heldLand)}（通常Landのみ）`,
      vipLine,
    ]
      .filter(Boolean)
      .join("\n");
  }
  // 利用可能額 = 通常Land + 自由チップ。卓・板への預け中は別枠（二重加算しない）
  const total = input.heldLand + input.assets.freeChips;
  if (!Number.isSafeInteger(total)) {
    return [
      "⚠️ **残高の合算に失敗しました**",
      "チップ帳簿またはLand口座の値が異常です（利用可能額へ含めません）",
      `所持 ${fmtLd(input.heldLand)}（通常Landのみ）`,
      vipLine,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    `所持 **${fmtLd(total)}**`,
    input.assets.escrowed > 0 ? `卓・板に預け中 ${fmtLd(input.assets.escrowed)}` : "",
    vipLine,
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderCasinoStatusLine(status: string, reason: string): string {
  return status === "open" ? "" : `⛔ **${status}** — ${reason}`;
}

function renderHome(userId: string, services: Services, serverName?: string) {
  const stats = services.casino.stats(userId);
  const ether = services.chips;
  const daily = services.daily;
  const phase = openingPhase(services);
  const heldLand = services.ledger.balanceOf(`user:${userId}`);
  let assets: UserChipAssets | null = null;
  let assetError = false;
  // 正式開業前・未知版では、自由チップを通常利用可能な資産として読んだり表示したりしない。
  if (phase === "formal") {
    try {
      assets = services.chipAssets.forUser(userId);
    } catch (error) {
      if (!(error instanceof ChipLedgerError)) throw error;
      assetError = true;
    }
  }

  const jp = services.casino.jackpotPool();
  const houseBal = services.casino.houseBalance();
  // 未知版では準備口座が決まらず pool() が例外になる。案内所ごと落とすと
  // 「異常であること」も伝わらないので、読めない事実として出す（PR8監査・項目8）
  const pool = phase === "unknown" ? null : ether.pool();
  const outstanding = ether.outstanding();
  const casinoStatus = services.casinoStatus.current();

  const isVip = services.vip.isVip(userId);
  const vipDaysLeft = isVip ? services.vip.daysLeft(userId) : 0;

  const nextClaim = daily.nextClaimAt(userId);
  const dailyReady = nextClaim === 0 || nextClaim <= Math.floor(Date.now() / 1000);
  const streak = daily.currentStreak(userId);

  const winRate = stats.games > 0 ? (stats.wins / stats.games) * 100 : 0;
  const streakLine = stats.current_win_streak >= 2 ? `${E.fire} ${stats.current_win_streak}連勝中` : "";
  const loseStreakLine = stats.current_lose_streak >= 3 ? `${E.lose} ${stats.current_lose_streak}連敗` : "";
  // 通算損益 = 賭場で**確定した**ゲーム損益の総和（PR3）。
  //
  // 含む: ソロゲーム（連鎖ボーナス・福の重み込み）、フリースピン、JP当選、
  //       対人戦（場代込み）、競馬、板。いずれも確定精算のときに一度だけ足す。
  // 含まない: 預託中の資金、返金・無効試合、VIP、商店、通常送金、元手投入・売上精算。
  //
  // 以前は total_earned − total_wagered で出しており、total_earned が既に賭け額を
  // 引いた純益なので、勝った回の賭け額を二重に引いていた。
  const netLifetime = stats.total_earned - stats.total_lost;

  const walletValue = renderWalletValue({
    phase,
    heldLand,
    assets,
    assetError,
    isVip,
    vipDaysLeft,
  });

  // 「1 チップ = 1 Ld」は opening_v1 が確定してからの約束。それ以前に出すと、
  // 押しても必ず断られる交換をできると言うことになる（PR8監査・項目8）
  const rateLine =
    phase === "formal"
      ? `**1 チップ = 1 Ld**   （準備 ${pool!.toLocaleString()} Ld ／ 発行 ${outstanding.toLocaleString()} チップ）`
      : phase === "unknown"
        ? `⚠️ 版が異常（準備口座を特定できません／全操作停止）`
        : `🚧 **正式開業準備中**（預入・返還は停止中／1:1交換は opening_v1 確定後）　準備 ${pool!.toLocaleString()} Ld ／ 発行 ${outstanding.toLocaleString()} チップ`;
  const marketValue = [
    renderCasinoStatusLine(casinoStatus.status, casinoStatus.reason),
    rateLine,
    `${E.jp} JPプール **${fmtEther(jp)}**`,
    `胴元残 ${fmtEther(houseBal)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const dailyValue = dailyReady
    ? `${E.sparkle} **今すぐ受け取れる** → \`/福分け\``
    : `次は <t:${nextClaim}:R>  ／  連続 ${streak}日  ${streak >= 7 ? `**+${Math.min(200, Math.floor(streak / 7) * 50)} Ldボーナス**` : ""}`;

  const statsValue = [
    `${E.chart} 総 **${stats.games}** ／ 勝 ${stats.wins} 負 ${stats.losses}  勝率 **${winRate.toFixed(1)}%**`,
    `${E.up} 最大単勝 ${fmtEther(stats.biggest_win)}  ／  総獲得 ${fmtEther(stats.total_earned)}`,
    `${E.down} 総ベット ${fmtEther(stats.total_wagered)}  ／  通算 **${fmtSignedEther(netLifetime)}**`,
    `${E.streak} 連勝 ${stats.current_win_streak}／最長 ${stats.best_win_streak}${streakLine || loseStreakLine ? `  ${streakLine}${loseStreakLine}` : ""}`,
  ].join("\n");

  const playValue = [
    `${E.demon} \`/遊ぶ\` — スロット・丁半・クラッシュ・チンチロ・ルーレット・BJ・ポーカー・ホールデム`,
    `⚔ \`/勝負\` — 丁半(卓)・チンチロ・BJ・サシ・インディアン`,
    `🃏 \`/賭場商店\` — お守り（勝ちボーナス／敗北保護／二度振り）`,
  ].join("\n");

  const economyValue = [
    `🏇 \`/競馬\` — 冥馬6頭・単勝/複勝パリミュチュエル`,
    `📋 \`/板\` — 何でも賭けられる公開市場`,
    `✨ \`/流れ星\` — 1日5回の占い（初回無料）`,
    `${E.jp} \`/vip\` — 月額${fmtEther(services.vip.price())} で賭け上限×${services.vip.betCapMult()}`,
    // 株は停止中（PR6・正本 §1.3）。導線からは外すが、持っている建玉には触れていないので
    // 「消えた」と誤解されないよう1行だけ残す
    `🚫 \`/株\` — **停止中**（持っている株はそのまま。扱いが決まったら知らせる）`,
  ].join("\n");

  const detailValue = [
    `${E.paytable} \`/通行証\` — 戦績カード`,
    `🏅 \`/賭場番付\` — Top10（残高/勝率/最大単勝/連勝など）`,
    `${HR_THIN}`,
    `賭場では自由チップを内部で使いますが、表示と利用者資産はLandです。`,
    ...(phase === "formal"
      ? [`　入退場は自動で **1:1**（ゲーム開始時に預入・「賭場を出る」で返還／変動比率・焼却なし）`]
      : [`　${openingNotice(services).split("\n").join("\n　")}`]),
  ].join("\n");

  const walletFooter =
    phase === "formal"
      ? assets
        ? `自由チップ ${fmtEther(assets.freeChips)}`
        : "チップ帳簿エラー"
      : phase === "unknown"
        ? "賭場の版が異常"
        : "正式開業準備中";
  const embed = new EmbedBuilder()
    .setAuthor({ name: `${serverName ?? "冥獄城"} · マモンの賭場` })
    .setTitle(`${E.home} 案内所`)
    .setColor(jp > 100_000 ? C_JACKPOT : C_MAMMON)
    .addFields(
      { name: `👛 財布`, value: walletValue, inline: true },
      { name: `${E.chart} 相場・胴元`, value: marketValue, inline: true },
      { name: `📅 福分け`, value: dailyValue, inline: false },
      { name: `${E.chart} 戦績`, value: statsValue, inline: false },
      { name: `🎮 遊び`, value: playValue, inline: false },
      { name: `💹 経済・投資`, value: economyValue, inline: false },
      { name: `${E.paytable} 記録・入口`, value: detailValue, inline: false },
    )
    .setFooter({ text: `${walletFooter}${isVip ? ` · ${E.jp} VIP` : ""}${stats.current_win_streak >= 2 ? ` · ${E.fire}${stats.current_win_streak}連勝` : ""}` });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("annai:refresh").setLabel("更新").setEmoji("🔁").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("casino:leave").setLabel("賭場を出る").setEmoji("🚪").setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}
