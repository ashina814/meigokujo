import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ButtonInteraction,
  type InteractionReplyOptions,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { chinchiroMaxPlayerLoss } from "@meigokujo/core";
import { fmtLd } from "../format.js";
import type { Services } from "../services.js";
import { effectiveMaxBet, MIN_BET } from "./common.js";
import {
  CASINO_SOLO_GAME_DESCRIPTIONS,
  CASINO_SOLO_GAME_EMOJI,
  CASINO_SOLO_GAMES,
  isCasinoSoloGame,
  type CasinoSoloGame,
} from "./games.js";
import { openingNotice, openingPhase } from "./opening.js";
import { readAvailableWallet, type AvailableWalletSnapshot } from "./wallet.js";
import { parseStrictPositiveInteger } from "./wager-input.js";

export const CASINO_GAME_SELECT_CUSTOM_ID = "casino:home:game-select";
export const CASINO_AMOUNT_CUSTOM_PREFIX = "casino:amount:custom:";
export const CASINO_AMOUNT_MODAL_PREFIX = "casino:amount:modal:";

const FIXED_AMOUNTS = [100, 500, 2_000, 10_000] as const;

type AmountAvailability =
  | { ok: true; wallet: FormalWalletSnapshot; maxBet: number }
  | { ok: false; wallet: AvailableWalletSnapshot; maxBet: number | null; reason: string };

type FormalWalletSnapshot = AvailableWalletSnapshot & {
  status: "formal";
  freeChips: number;
  escrowed: number;
};

export function renderCasinoGameSelect(): InteractionReplyOptions {
  const select = new StringSelectMenuBuilder()
    .setCustomId(CASINO_GAME_SELECT_CUSTOM_ID)
    .setPlaceholder("遊びを選ぶ")
    .addOptions(
      CASINO_SOLO_GAMES.map((game) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(game)
          .setDescription(CASINO_SOLO_GAME_DESCRIPTIONS[game])
          .setEmoji(CASINO_SOLO_GAME_EMOJI[game])
          .setValue(game),
      ),
    );

  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · 遊びを選ぶ" })
    .setDescription("遊びを選ぶと、次に金額を選べます。")
    .setColor(0x8b5cf6);

  return {
    embeds: [embed],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
  };
}

export async function handleCasinoGameSelect(
  interaction: StringSelectMenuInteraction,
  services: Services,
): Promise<void> {
  const game = interaction.values[0];
  if (!game || !isCasinoSoloGame(game)) {
    await interaction.reply({ content: "❌ 不明な遊びです。", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({
    ...renderCasinoAmountPicker(interaction.user.id, game, services),
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleCasinoAmountButton(interaction: ButtonInteraction, _services: Services): Promise<void> {
  const game = interaction.customId.slice(CASINO_AMOUNT_CUSTOM_PREFIX.length);
  if (!isCasinoSoloGame(game)) {
    await interaction.reply({ content: "❌ 不明な遊びです。", flags: MessageFlags.Ephemeral });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`${CASINO_AMOUNT_MODAL_PREFIX}${game}`)
    .setTitle(`${game} の金額入力`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("amount")
          .setLabel("賭け額（Ld）")
          .setPlaceholder("例: 500")
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
    );
  await interaction.showModal(modal);
}

export async function handleCasinoAmountModal(
  interaction: ModalSubmitInteraction,
  services: Services,
): Promise<void> {
  const game = interaction.customId.slice(CASINO_AMOUNT_MODAL_PREFIX.length);
  if (!isCasinoSoloGame(game)) {
    await interaction.reply({ content: "❌ 不明な遊びです。", flags: MessageFlags.Ephemeral });
    return;
  }

  const parsed = parseStrictPositiveInteger(interaction.fields.getTextInputValue("amount"));
  if (!parsed.ok) {
    await interaction.reply({ content: "❌ 金額は1以上の整数で入力してください。", flags: MessageFlags.Ephemeral });
    return;
  }

  const availability = amountAvailability(interaction.user.id, game, services);
  const denial = availability.ok ? validateAmount(game, parsed.amount, availability) : availability.reason;
  if (denial) {
    await interaction.reply({ content: `❌ ${denial}`, flags: MessageFlags.Ephemeral });
    return;
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`casino:play:${game}:${parsed.amount}`)
      .setLabel(`${fmtLd(parsed.amount)}で遊ぶ`)
      .setEmoji(CASINO_SOLO_GAME_EMOJI[game])
      .setStyle(ButtonStyle.Primary),
  );
  await interaction.reply({
    content: `${game}を ${fmtLd(parsed.amount)} で遊びます。`,
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

export function renderCasinoAmountPicker(
  userId: string,
  game: CasinoSoloGame,
  services: Services,
): InteractionReplyOptions {
  const availability = amountAvailability(userId, game, services);
  const fixedButtons = FIXED_AMOUNTS.map((amount) => {
    const disabled = availability.ok ? validateAmount(game, amount, availability) !== null : true;
    const label = game === "チンチロ"
      ? `${amount.toLocaleString("ja-JP")} / 最大${chinchiroMaxPlayerLoss(amount).toLocaleString("ja-JP")}`
      : amount.toLocaleString("ja-JP");
    return new ButtonBuilder()
      .setCustomId(`casino:play:${game}:${amount}`)
      .setLabel(label)
      .setStyle(disabled ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(disabled);
  });
  const customDisabled = !availability.ok || validateMinimumCustomAmount(game, availability) !== null;
  const custom = new ButtonBuilder()
    .setCustomId(`${CASINO_AMOUNT_CUSTOM_PREFIX}${game}`)
    .setLabel("自由入力")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(customDisabled);

  const lines = [
    `${CASINO_SOLO_GAME_EMOJI[game]} **${game}**`,
    availabilityLabel(game, availability),
  ];
  if (!availability.ok) lines.push(availability.reason);
  if (game === "チンチロ") lines.push("チンチロは最大損失ぶん（賭け額の2倍）を先に確認します。");

  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · 金額を選ぶ" })
    .setDescription(lines.join("\n"))
    .setColor(availability.ok ? 0x22c55e : 0x64748b);

  return {
    embeds: [embed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...fixedButtons, custom)],
  };
}

function amountAvailability(userId: string, game: CasinoSoloGame, services: Services): AmountAvailability {
  const phase = openingPhase(services);
  const status = services.casinoStatus.current();
  const wallet = readAvailableWallet(services, userId);
  let maxBet: number | null = null;
  try {
    maxBet = effectiveMaxBet(services, userId, game);
  } catch {
    return { ok: false, wallet, maxBet: null, reason: "上限確認停止" };
  }

  if (phase === "unknown") return { ok: false, wallet, maxBet, reason: "状態確認停止" };
  if (phase !== "formal") return { ok: false, wallet, maxBet, reason: openingNotice(services) };
  if (status.status !== "open") return { ok: false, wallet, maxBet, reason: "賭場は現在停止中" };
  if (wallet.status !== "formal") return { ok: false, wallet, maxBet, reason: "所持額確認停止" };
  return {
    ok: true,
    wallet: {
      ...wallet,
      status: "formal",
      freeChips: wallet.freeChips ?? 0,
      escrowed: wallet.escrowed ?? 0,
    },
    maxBet,
  };
}

function availabilityLabel(game: CasinoSoloGame, availability: AmountAvailability): string {
  const walletBits = [`所持 ${fmtLd(availability.wallet.land)}`];
  if (availability.ok) {
    walletBits[0] = `所持 ${fmtLd(availability.wallet.available)}`;
    if (availability.wallet.escrowed > 0) walletBits.push(`預け中 ${fmtLd(availability.wallet.escrowed)}`);
  }
  const max = availability.maxBet === null ? "上限 確認停止" : `上限 ${fmtLd(availability.maxBet)}`;
  const chinchiro = game === "チンチロ" ? " / 最大損失は賭け額の2倍" : "";
  return `${walletBits.join(" · ")} · ${max}${chinchiro}`;
}

function validateMinimumCustomAmount(game: CasinoSoloGame, availability: AmountAvailability): string | null {
  if (!availability.ok) return availability.reason;
  return validateAmount(game, MIN_BET, availability);
}

function validateAmount(game: CasinoSoloGame, amount: number, availability: Extract<AmountAvailability, { ok: true }>): string | null {
  if (!Number.isSafeInteger(amount) || amount < MIN_BET) {
    return `金額は ${fmtLd(MIN_BET)} 以上の整数にしてください`;
  }
  if (amount > availability.maxBet) {
    return `この遊びで現在受けられる上限は ${fmtLd(availability.maxBet)} です`;
  }
  const required = game === "チンチロ" ? chinchiroMaxPlayerLoss(amount) : amount;
  if (required > availability.wallet.available) {
    return game === "チンチロ"
      ? `チンチロは最大損失ぶん ${fmtLd(required)} が必要です`
      : `所持額が足りません（所持 ${fmtLd(availability.wallet.available)}）`;
  }
  return null;
}
