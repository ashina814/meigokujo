import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type InteractionReplyOptions,
  type ModalSubmitInteraction,
} from "discord.js";
import { fmtLd } from "../format.js";
import type { Services } from "../services.js";
import { isSeatOccupied, MAX_BET, MIN_BET } from "./common.js";
import { closeChallengeCard, postChallenge } from "./pvp-card.js";
import { getOpenChallengeForChallenger } from "./pvp-challenge.js";
import { PVP_GAMES, pvpGame, type PvpGameKey } from "./pvp-games.js";
import { openingNotice, openingPhase } from "./opening.js";
import { C_MAMMON, withCasinoHomeBack } from "./ui.js";
import { parseStrictPositiveInteger } from "./wager-input.js";

export const PVP_GAME_PREFIX = "casino:home:pvpopen-game:";
export const PVP_POST_PREFIX = "casino:home:pvpopen-post:";
export const PVP_CUSTOM_PREFIX = "casino:home:pvpopen-custom:";
/** 既存の `casino:amount:modal:` ルートへ乗せる。amount-picker 側が先にこの接頭辞を委譲する。 */
export const PVP_AMOUNT_MODAL_PREFIX = "casino:amount:modal:pvp:";

const FIXED_AMOUNTS = [100, 500, 2_000, 10_000] as const;

type PvpPostInteraction = ButtonInteraction | ModalSubmitInteraction;

type PvpAvailability =
  | { ok: true; balance: number; maxBet: number }
  | { ok: false; balance: number | null; maxBet: number | null; reason: string };

/**
 * 「みんなで勝負」の実入口。旧 `/勝負` 一覧を見せるだけの画面ではなく、
 * ここからゲーム → 金額 → 公開募集まで完結させる。
 */
export function renderPvpOpenGameSelect(): InteractionReplyOptions {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...PVP_GAMES.map((game) =>
      new ButtonBuilder()
        .setCustomId(`${PVP_GAME_PREFIX}${game.key}`)
        .setLabel(game.label)
        .setEmoji(game.emoji)
        .setStyle(ButtonStyle.Secondary),
    ),
  );
  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · みんなで勝負" })
    .setColor(C_MAMMON)
    .setTitle("⚔  公開1v1を募集する")
    .setDescription(
      [
        "ゲームを選ぶと、次に賭け金を決めます。",
        "募集はこのチャンネルに **3分間** 公開され、最初に「受ける」を押した1人と勝負します。",
        "",
        "**募集中はLandを預かりません。** 成立した瞬間に双方を確認し、同額を一括で預かります。",
        "-# 丁半・ポーカーは既存の多人数受付を使うため、ここでは募集しません。",
      ].join("\n"),
    );
  return withCasinoHomeBack({ embeds: [embed], components: [row] });
}

/** 金額選択。表示は事前確認であり、相手を含む最終判定は受諾時の collectStakes が正本。 */
export function renderPvpOpenAmountPicker(
  userId: string,
  game: PvpGameKey,
  services: Services,
): InteractionReplyOptions {
  const g = pvpGame(game);
  const availability = pvpAvailability(userId, services);
  const fixed = FIXED_AMOUNTS.map((amount) => {
    const disabled = pvpAmountDenial(amount, availability) !== null;
    return new ButtonBuilder()
      .setCustomId(`${PVP_POST_PREFIX}${game}:${amount}`)
      .setLabel(amount.toLocaleString("ja-JP"))
      .setStyle(disabled ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(disabled);
  });
  const custom = new ButtonBuilder()
    .setCustomId(`${PVP_CUSTOM_PREFIX}${game}`)
    .setLabel("自由入力")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(pvpAmountDenial(MIN_BET, availability) !== null);

  const lines = [
    `${g?.emoji ?? "⚔"} **${g?.label ?? game}**`,
    pvpAvailabilityLabel(availability),
    "",
    "募集を出した時点では何も預かりません。受諾された瞬間に双方の残高・日次上限・参加状況を再確認します。",
  ];
  if (!availability.ok) lines.push("", `**いまは募集できません:** ${availability.reason}`);

  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · 公開1v1" })
    .setColor(availability.ok ? C_MAMMON : 0x78716c)
    .setTitle("賭け金を選ぶ")
    .setDescription(lines.join("\n"));

  return withCasinoHomeBack({
    embeds: [embed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...fixed, custom)],
  });
}

/** `casino:home:` 配下の公開募集セットアップ操作だけを拾う。 */
export function isPvpOpenSetupButton(customId: string): boolean {
  return (
    customId.startsWith(PVP_GAME_PREFIX) ||
    customId.startsWith(PVP_POST_PREFIX) ||
    customId.startsWith(PVP_CUSTOM_PREFIX)
  );
}

export async function handlePvpOpenSetupButton(
  interaction: ButtonInteraction,
  services: Services,
): Promise<void> {
  const gamePick = parseGameTail(interaction.customId, PVP_GAME_PREFIX);
  if (gamePick.matched) {
    if (!gamePick.game) return replyInvalid(interaction);
    await interaction.reply({
      ...renderPvpOpenAmountPicker(interaction.user.id, gamePick.game, services),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const custom = parseGameTail(interaction.customId, PVP_CUSTOM_PREFIX);
  if (custom.matched) {
    if (!custom.game) return replyInvalid(interaction);
    const availability = pvpAvailability(interaction.user.id, services);
    const denial = pvpAmountDenial(MIN_BET, availability);
    if (denial) {
      await interaction.reply({ content: `❌ ${denial}`, flags: MessageFlags.Ephemeral });
      return;
    }
    const g = pvpGame(custom.game);
    const modal = new ModalBuilder()
      .setCustomId(`${PVP_AMOUNT_MODAL_PREFIX}${custom.game}`)
      .setTitle(`${g?.label ?? custom.game} の賭け金`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("amount")
            .setLabel(`賭け金（${MIN_BET}〜${MAX_BET.toLocaleString("ja-JP")} Ld）`)
            .setPlaceholder("例: 500")
            .setRequired(true)
            .setStyle(TextInputStyle.Short),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  const post = parsePost(interaction.customId);
  if (!post) return replyInvalid(interaction);
  await postPvpChallenge(interaction, services, post.game, post.amount);
}

/** amount-picker の共通 modal router から委譲される。 */
export async function handlePvpOpenAmountModal(
  interaction: ModalSubmitInteraction,
  services: Services,
): Promise<void> {
  const game = parseGameTail(interaction.customId, PVP_AMOUNT_MODAL_PREFIX);
  if (!game.matched || !game.game) {
    await interaction.reply({ content: "❌ 不明な対戦ゲームです。", flags: MessageFlags.Ephemeral });
    return;
  }
  const parsed = parseStrictPositiveInteger(interaction.fields.getTextInputValue("amount"));
  if (!parsed.ok) {
    await interaction.reply({ content: "❌ 金額は1以上の整数で入力してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  await postPvpChallenge(interaction, services, game.game, parsed.amount);
}

/**
 * 公開カードを立てる直前に再確認する。
 * ここでは資金を動かさない。受諾までの3分で状況は変わり得るので、成立時の collectStakes が最終判定。
 */
async function postPvpChallenge(
  interaction: PvpPostInteraction,
  services: Services,
  game: PvpGameKey,
  amount: number,
): Promise<void> {
  const availability = pvpAvailability(interaction.user.id, services);
  const denial = pvpAmountDenial(amount, availability);
  if (denial) {
    await interaction.reply({ content: `❌ ${denial}`, flags: MessageFlags.Ephemeral });
    return;
  }

  const channel = interaction.channel;
  if (!channel || !("send" in channel) || typeof channel.send !== "function") {
    await interaction.reply({ content: "❌ この場所には公開募集を出せません。", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const g = pvpGame(game);
  let card: Awaited<ReturnType<typeof postChallenge>>;
  try {
    card = await postChallenge({
      channel: channel as Parameters<typeof postChallenge>[0]["channel"],
      challengerId: interaction.user.id,
      game,
      bet: amount,
      onExpire: (_challenge, expiredCard) =>
        closeChallengeCard(expiredCard, "⌛ 3分経過したため、この募集は締め切りました。"),
    });
  } catch (e) {
    // postChallenge は、send 後の登録失敗なら公開済みカードを先に閉じてから投げる。
    if (getOpenChallengeForChallenger(interaction.user.id)) {
      await interaction.editReply({ content: "❌ すでに公開中の募集があります。先にそちらを終わらせてください。" });
      return;
    }
    console.error("[pvp] 公開募集の投稿に失敗:", e);
    await interaction.editReply({ content: "❌ 募集を開始できませんでした。時間を置いてもう一度試してください。" });
    return;
  }

  // ここまで来たら公開カードと challenge は成立済み。確認用の ephemeral 表示だけが
  // 失敗しても、成功済みの募集を「既存募集エラー」へ誤分類したり閉じたりしない。
  try {
    await interaction.editReply({
      content: `${g?.emoji ?? "⚔"} **${g?.label ?? game} / ${fmtLd(amount)}** で募集を出しました。3分以内に誰かが受ければ開始します。\n${card.url}`,
    });
  } catch (e) {
    console.error("[pvp] 募集開始後の確認表示に失敗:", e);
  }
}

function pvpAvailability(userId: string, services: Services): PvpAvailability {
  const phase = openingPhase(services);
  const status = services.casinoStatus.current();
  if (phase === "unknown") return { ok: false, balance: null, maxBet: null, reason: "賭場の状態を確認できません" };
  if (phase !== "formal") return { ok: false, balance: null, maxBet: null, reason: openingNotice(services) };
  if (status.status !== "open") return { ok: false, balance: null, maxBet: null, reason: `賭場は現在停止中です（${status.reason}）` };
  if (getOpenChallengeForChallenger(userId)) {
    return { ok: false, balance: null, maxBet: null, reason: "すでに公開中の募集があります" };
  }
  if (isSeatOccupied(userId)) {
    return { ok: false, balance: null, maxBet: null, reason: "進行中の勝負を終えてから募集してください" };
  }

  let balance: number;
  let riskMax: number;
  try {
    // 公開1v1の collectStakes は escrow.holdAll へ直行するので、ここでは「賭場に置いている分」を見る。
    // 手元のLandを含む available を使うと、表示上は押せるのに成立時は必ず残高不足になりうる。
    balance = services.chips.balanceOf(userId);
    riskMax = services.dailyRisk.maxBetForPlayerLoss(userId, (bet) => bet, MAX_BET);
  } catch {
    return { ok: false, balance: null, maxBet: null, reason: "残高または利用上限を確認できません" };
  }
  const maxBet = Math.min(MAX_BET, balance, riskMax);
  if (!Number.isSafeInteger(maxBet) || maxBet < MIN_BET) {
    return { ok: false, balance, maxBet: Math.max(0, Number.isFinite(maxBet) ? Math.floor(maxBet) : 0), reason: "いま出せる賭け金がありません" };
  }
  return { ok: true, balance, maxBet };
}

function pvpAmountDenial(amount: number, availability: PvpAvailability): string | null {
  if (!availability.ok) return availability.reason;
  if (!Number.isSafeInteger(amount) || amount < MIN_BET || amount > MAX_BET) {
    return `賭け金は ${fmtLd(MIN_BET)}〜${fmtLd(MAX_BET)} の整数にしてください`;
  }
  if (amount > availability.maxBet) {
    return `現在この募集で出せる上限は ${fmtLd(availability.maxBet)} です`;
  }
  return null;
}

function pvpAvailabilityLabel(availability: PvpAvailability): string {
  if (availability.balance === null) return "賭場残高・上限 確認停止";
  const max = availability.maxBet === null ? "確認停止" : fmtLd(availability.maxBet);
  return `賭場に置いている分 ${fmtLd(availability.balance)} · 募集上限 ${max}`;
}

function parseGameTail(customId: string, prefix: string): { matched: boolean; game: PvpGameKey | null } {
  if (!customId.startsWith(prefix)) return { matched: false, game: null };
  const tail = customId.slice(prefix.length);
  if (!tail || tail.includes(":")) return { matched: true, game: null };
  const game = pvpGame(tail);
  return { matched: true, game: game?.key ?? null };
}

function parsePost(customId: string): { game: PvpGameKey; amount: number } | null {
  if (!customId.startsWith(PVP_POST_PREFIX)) return null;
  const [gameRaw, amountRaw, extra] = customId.slice(PVP_POST_PREFIX.length).split(":");
  if (!gameRaw || !amountRaw || extra !== undefined) return null;
  const game = pvpGame(gameRaw);
  const amount = parseStrictPositiveInteger(amountRaw);
  if (!game || !amount.ok) return null;
  return { game: game.key, amount: amount.amount };
}

async function replyInvalid(interaction: ButtonInteraction): Promise<void> {
  await interaction.reply({ content: "❌ 募集情報が壊れています。もう一度選び直してください。", flags: MessageFlags.Ephemeral });
}
