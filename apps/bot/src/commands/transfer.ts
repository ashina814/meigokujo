import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type TextChannel,
} from "discord.js";
import { LedgerError } from "@meigokujo/core";
import { fmtLd } from "../format.js";
import { isAdmin } from "../permissions.js";
import type { Services } from "../services.js";

export const transferCommand = new SlashCommandBuilder()
  .setName("送金")
  .setDescription("Land を送る（どこからでも使えます）")
  .setDMPermission(false)
  .addUserOption((o) => o.setName("相手").setDescription("送金先").setRequired(true))
  .addIntegerOption((o) =>
    o.setName("金額").setDescription("送る Land").setRequired(true).setMinValue(1),
  )
  .addStringOption((o) =>
    o.setName("メモ").setDescription("ひとこと（公開ログに載ります）").setMaxLength(100),
  );

interface PendingTransfer {
  fromUserId: string;
  toUserId: string;
  amount: number;
  memo: string | null;
  expiresAt: number;
}

/** 確認待ちの送金（ボタン押下まで金は動かないので、再起動で消えても安全＝再入力してもらうだけ） */
const pending = new Map<string, PendingTransfer>();
/** 二重送信ガード: 直近に成立した from:to:amount → 時刻 */
const recentDone = new Map<string, number>();
/** レート制限: userId → 成立時刻のリスト */
const rateBucket = new Map<string, number[]>();

const DUPE_WINDOW_MS = 60_000;
const RATE_LIMIT = 3; // 1分あたり
const CONFIRM_TTL_MS = 2 * 60_000;

function cleanupPending(): void {
  const now = Date.now();
  for (const [key, p] of pending) if (p.expiresAt < now) pending.delete(key);
}

export async function handleTransfer(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  cleanupPending();
  const target = interaction.options.getUser("相手", true);
  const amount = interaction.options.getInteger("金額", true);
  const memo = interaction.options.getString("メモ");
  const me = interaction.user;

  if (target.bot) {
    await interaction.reply({ content: "Bot に Land は送れません。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (target.id === me.id) {
    await interaction.reply({ content: "自分自身への送金はできません。", flags: MessageFlags.Ephemeral });
    return;
  }

  const now = Date.now();
  const times = (rateBucket.get(me.id) ?? []).filter((t) => t > now - 60_000);
  if (times.length >= RATE_LIMIT) {
    await interaction.reply({
      content: "送金が続きすぎています。少し待ってからもう一度どうぞ。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const fromAccount = `user:${me.id}`;
  services.ledger.ensureAccount(fromAccount, "user");
  services.ledger.ensureAccount(`user:${target.id}`, "user");
  const balance = services.ledger.balanceOf(fromAccount);
  if (balance < amount) {
    await interaction.reply({
      content: `残高が足りません（所持: ${fmtLd(balance)} / 必要: ${fmtLd(amount)}）。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // 高額送金は #決裁 の承認フローへ（経済設計.md §4）
  const threshold = services.settings.getNumber("approval_threshold");
  if (amount > threshold) {
    await requestApproval(interaction, services, target.id, amount, memo);
    return;
  }

  const dupeKey = `${me.id}:${target.id}:${amount}`;
  const isDupe = (recentDone.get(dupeKey) ?? 0) > now - DUPE_WINDOW_MS;

  const confirmKey = interaction.id;
  pending.set(confirmKey, {
    fromUserId: me.id,
    toUserId: target.id,
    amount,
    memo,
    expiresAt: now + CONFIRM_TTL_MS,
  });

  const embed = new EmbedBuilder()
    .setTitle("💸 送金の確認")
    .setDescription(
      [
        `送り先: <@${target.id}>`,
        `金額: **${fmtLd(amount)}**`,
        `送金後の残高: ${fmtLd(balance - amount)}`,
        memo ? `メモ: 『${memo}』（公開ログに載ります）` : "メモ: なし",
        isDupe ? "\n⚠️ **さっき同じ相手に同額を送ったばかりです。** 二重送信ではありませんか？" : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .setColor(isDupe ? 0xf59e0b : 0x6b21a8);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`tf:ok:${confirmKey}`).setLabel("送る").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`tf:no:${confirmKey}`).setLabel("やめる").setStyle(ButtonStyle.Secondary),
  );
  await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
}

export async function handleTransferButton(
  interaction: ButtonInteraction,
  services: Services,
): Promise<void> {
  const [, action, key] = interaction.customId.split(":");
  if (!action || !key) return;

  const p = pending.get(key);
  if (!p || p.expiresAt < Date.now()) {
    pending.delete(key);
    await interaction.update({ content: "⌛ 確認の期限が切れました。もう一度 `/送金` からどうぞ。", embeds: [], components: [] });
    return;
  }
  if (interaction.user.id !== p.fromUserId) return;

  if (action === "no") {
    pending.delete(key);
    await interaction.update({ content: "送金をやめました。", embeds: [], components: [] });
    return;
  }

  pending.delete(key);
  try {
    const result = services.ledger.transfer({
      from: `user:${p.fromUserId}`,
      to: `user:${p.toUserId}`,
      amount: p.amount,
      type: "transfer",
      actor: `user:${p.fromUserId}`,
      reason: p.memo ?? undefined,
      idempotencyKey: `transfer:${key}`,
    });
    recentDone.set(`${p.fromUserId}:${p.toUserId}:${p.amount}`, Date.now());
    const times = rateBucket.get(p.fromUserId) ?? [];
    times.push(Date.now());
    rateBucket.set(p.fromUserId, times.slice(-10));

    const after = services.ledger.balanceOf(`user:${p.fromUserId}`);
    await interaction.update({
      content: `✅ <@${p.toUserId}> に **${fmtLd(p.amount)}** を送りました（tx#${result.tx.id}）。残高: ${fmtLd(after)}`,
      embeds: [],
      components: [],
    });
  } catch (e) {
    const err = e as LedgerError;
    const message =
      err instanceof LedgerError && err.code === "ERR_INSUFFICIENT"
        ? `残高が足りません（所持: ${fmtLd(Number(err.details.balance))} / 必要: ${fmtLd(Number(err.details.required))}）。`
        : "送金に失敗しました。時間をおいて再度お試しください。";
    await interaction.update({ content: `❌ ${message}`, embeds: [], components: [] });
  }
}

// ---- 高額送金の承認フロー（#決裁） ----

async function requestApproval(
  interaction: ChatInputCommandInteraction,
  services: Services,
  toUserId: string,
  amount: number,
  memo: string | null,
): Promise<void> {
  const kessaiId = services.settings.getString("channel:kessai");
  const kessai = kessaiId
    ? ((await interaction.client.channels.fetch(kessaiId).catch(() => null)) as TextChannel | null)
    : null;
  if (!kessai?.isTextBased()) {
    await interaction.reply({
      content: `**${fmtLd(amount)}** は高額送金のため運営の承認が必要ですが、#決裁 チャンネルが未設定です。運営に連絡してください。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("⚖️ 高額送金の承認申請")
    .setDescription(
      [
        `申請者: <@${interaction.user.id}>`,
        `送り先: <@${toUserId}>`,
        `金額: **${fmtLd(amount)}**`,
        memo ? `メモ: 『${memo}』` : "メモ: なし",
      ].join("\n"),
    )
    .setColor(0xdc2626);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`apv:ok:${interaction.user.id}:${toUserId}:${amount}:${interaction.id}`)
      .setLabel("承認して実行")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`apv:no:${interaction.user.id}:${toUserId}:${amount}:${interaction.id}`)
      .setLabel("却下")
      .setStyle(ButtonStyle.Danger),
  );
  await kessai.send({ embeds: [embed], components: [row] });
  await interaction.reply({
    content: `**${fmtLd(amount)}** は高額送金のため、運営の承認待ちに回しました。承認されると公開ログに流れます。`,
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleApprovalButton(
  interaction: ButtonInteraction,
  services: Services,
): Promise<void> {
  if (!isAdmin(interaction, services)) {
    await interaction.reply({ content: "承認は運営のみ可能です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const parts = interaction.customId.split(":");
  const action = parts[1];
  const fromUserId = parts[2];
  const toUserId = parts[3];
  const amount = Number(parts[4]);
  const requestId = parts[5];
  if (!action || !fromUserId || !toUserId || !Number.isSafeInteger(amount) || !requestId) return;

  // メモは承認パネルの embed から復元する
  const description = interaction.message.embeds[0]?.description ?? "";
  const memoMatch = /メモ: 『(.+)』/.exec(description);
  const memo = memoMatch?.[1];

  if (action === "no") {
    await interaction.update({
      embeds: interaction.message.embeds,
      components: [],
      content: `❌ <@${interaction.user.id}> が却下しました。`,
    });
    return;
  }

  try {
    const result = services.ledger.transfer({
      from: `user:${fromUserId}`,
      to: `user:${toUserId}`,
      amount,
      type: "transfer",
      actor: `user:${fromUserId}`,
      reason: memo,
      idempotencyKey: `transfer-apv:${requestId}`,
      approvedBy: `user:${interaction.user.id}`,
    });
    await interaction.update({
      embeds: interaction.message.embeds,
      components: [],
      content: `✅ <@${interaction.user.id}> が承認し、実行しました（tx#${result.tx.id}）。`,
    });
  } catch (e) {
    const err = e as LedgerError;
    const detail =
      err instanceof LedgerError && err.code === "ERR_INSUFFICIENT"
        ? `申請者の残高不足（所持: ${fmtLd(Number(err.details.balance))} / 必要: ${fmtLd(Number(err.details.required))}）`
        : "台帳エラー";
    await interaction.update({
      embeds: interaction.message.embeds,
      components: [],
      content: `❌ 実行に失敗: ${detail}`,
    });
  }
}
