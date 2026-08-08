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
import { C_JACKPOT, C_MAMMON, E } from "../casino/ui.js";
import { checkRetry } from "../casino/common.js";
import { openingNotice, openingPhase, operatingLabel } from "../casino/opening.js";
import type { Services } from "../services.js";

const DEFAULT_GAME = "スロット";
const DEFAULT_BET = 100;

const GAME_EMOJI: Readonly<Record<string, string>> = {
  スロット: "🎰",
  丁半: "🎲",
  クラッシュ: "📈",
  チンチロ: "🎲",
  ブラックジャック: "🃏",
  ポーカー: "🃏",
  ホールデム: "🃏",
};

const PLAYABLE_HOME_GAMES = new Set(Object.keys(GAME_EMOJI));

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
}

export async function handleCasinoHomeButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  if (interaction.customId === "casino:daily:claim") {
    await claimDailyFromHome(interaction, services);
    return;
  }
  if (interaction.customId === "casino:home:games") {
    await interaction.reply({
      content: [
        "**遊びを選ぶ**",
        "`/遊ぶ スロット` `/遊ぶ 丁半` `/遊ぶ クラッシュ` `/遊ぶ チンチロ` `/遊ぶ ブラックジャック` `/遊ぶ ポーカー` `/遊ぶ ホールデム`",
        "金額選択画面は PR16 で整えます。いまは既存の `/遊ぶ` ルートを使ってください。",
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.customId === "casino:home:pvp") {
    await interaction.reply({
      content: [
        "**みんなで勝負**",
        "`/勝負 丁半` `/勝負 チンチロ` `/勝負 bj` `/勝負 サシ` `/勝負 インディアン` `/勝負 ポーカー`",
        "永続卓と従業員導線は PR20 以降です。現行の安全な対人ルートだけ案内します。",
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.customId === "casino:home:record") {
    await interaction.reply({
      content: "**記録**\n`/通行証` で自分の戦績カード、`/賭場番付` で番付を見られます。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.customId === "casino:home:first") {
    await interaction.reply({
      content: [
        "**はじめて**",
        "表示単位は Land です。正式開業後の賭けは自由チップを 1 chip = 1 Ld として使います。",
        "預け中のチップは所持額に混ぜません。正式開業前や停止中は、ホームからも資金操作は通りません。",
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
}

export function renderCasinoHome(userId: string, services: Services, serverName?: string) {
  const phase = openingPhase(services);
  const status = services.casinoStatus.current();
  const daily = dailyState(userId, services);
  const wallet = casinoHomeWallet(userId, services);
  const jp = services.casino.jackpotPool();
  const primary = phase === "formal" && status.status === "open" ? primaryAction(userId, services) : defaultPrimaryAction();
  const actionsDisabled = phase !== "formal" || status.status !== "open";

  const lines = [
    operatingLabel(services),
    "",
    wallet.lines.join("\n"),
    daily.label,
    `${E.jp} JP ${fmtLd(jp)}`,
  ];
  if (phase !== "formal") lines.push("", openingNotice(services));
  else if (status.status !== "open") lines.push("", `資金操作停止中: ${status.reason}`);

  const embed = new EmbedBuilder()
    .setAuthor({ name: `${serverName ?? "冥獄城"} · マモンの賭場` })
    .setColor(jp >= 100_000 ? C_JACKPOT : C_MAMMON)
    .setDescription(lines.filter((line, index, arr) => line !== "" || arr[index - 1] !== "").join("\n"))
    .setFooter({ text: wallet.footer });

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(primary.customId)
      .setLabel(primary.label)
      .setEmoji(primary.emoji)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(actionsDisabled),
    new ButtonBuilder()
      .setCustomId("casino:home:games")
      .setLabel("遊びを選ぶ")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("casino:home:pvp")
      .setLabel("みんなで勝負")
      .setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("casino:daily:claim")
      .setLabel("福分け")
      .setStyle(daily.ready ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(actionsDisabled || !daily.ready),
    new ButtonBuilder()
      .setCustomId("casino:home:record")
      .setLabel("記録")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("casino:home:first")
      .setLabel("はじめて")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2] };
}

function casinoHomeWallet(userId: string, services: Services): { lines: string[]; footer: string } {
  const phase = openingPhase(services);
  if (phase === "unknown") {
    return {
      lines: ["所持 読み取り停止", "自由チップ・預け中資金は確認できません"],
      footer: "賭場の版が異常",
    };
  }
  if (phase !== "formal") {
    return {
      lines: [`通常Land ${fmtLd(services.ledger.balanceOf(`user:${userId}`))}`, "自由チップは正式開業まで利用できません"],
      footer: "正式開業準備中",
    };
  }
  const assets = services.chipAssets.forUser(userId);
  return {
    lines: [
      `所持 **${fmtLd(assets.freeChips)}**`,
      assets.escrowed > 0 ? `預け中 ${fmtLd(assets.escrowed)}` : "",
    ].filter(Boolean),
    footer: `自由チップ ${fmtLd(assets.freeChips)} · 預け中 ${fmtLd(assets.escrowed)} · 合計 ${fmtLd(assets.total)}`,
  };
}

function dailyState(userId: string, services: Services): { ready: boolean; label: string } {
  const nextClaim = services.daily.nextClaimAt(userId);
  const ready = nextClaim === 0 || nextClaim <= Math.floor(Date.now() / 1000);
  return {
    ready,
    label: ready ? "今日の福分けが受け取れる" : `今日の福分けはまだ（次は <t:${nextClaim}:R>）`,
  };
}

function primaryAction(userId: string, services: Services): { label: string; emoji: string; customId: string } {
  const pref = services.casino.homePreference(userId);
  if (pref && PLAYABLE_HOME_GAMES.has(pref.last_game)) {
    const retry = checkRetry(services, userId, pref.last_amount, pref.last_game);
    if (retry.ok) {
      return {
        label: `${pref.last_game} ${pref.last_amount.toLocaleString("ja-JP")} Ldでもう一度`,
        emoji: GAME_EMOJI[pref.last_game] ?? "🎰",
        customId: `casino:play:${pref.last_game}:${pref.last_amount}`,
      };
    }
  }
  return defaultPrimaryAction();
}

function defaultPrimaryAction(): { label: string; emoji: string; customId: string } {
  return {
    label: `${DEFAULT_BET.toLocaleString("ja-JP")} Ldで遊ぶ`,
    emoji: "🎰",
    customId: `casino:play:${DEFAULT_GAME}:${DEFAULT_BET}`,
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
