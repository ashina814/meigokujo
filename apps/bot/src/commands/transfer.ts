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

interface TransferRetryPayload {
  kind: "transfer";
  toUserId: string;
  amount: number;
  memo: string | null;
}

/** 確認待ちの送金（ボタン押下まで金は動かないので、再起動で消えても安全＝再入力してもらうだけ） */
const pending = new Map<string, PendingTransfer>();
/** 二重送信ガード: 直近に成立した from:to:amount → 時刻 */
const recentDone = new Map<string, number>();
/** レート制限: userId → 成立時刻のリスト */
const rateBucket = new Map<string, number[]>();

const DUPE_WINDOW_MS = 60_000;
const RATE_LIMIT = 3;
const CONFIRM_TTL_MS = 2 * 60_000;

function cleanupPending(): void {
  const nowMs = Date.now();
  for (const [key, value] of pending) if (value.expiresAt < nowMs) pending.delete(key);
}

function encodeRetryPayload(payload: TransferRetryPayload): string {
  return `transfer:${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

function decodeRetryPayload(value: string): TransferRetryPayload {
  if (!value.startsWith("transfer:")) throw new Error("送金の再試行情報が壊れています");
  const decoded = JSON.parse(Buffer.from(value.slice("transfer:".length), "base64url").toString("utf8")) as
    Partial<TransferRetryPayload>;
  if (
    decoded.kind !== "transfer"
    || typeof decoded.toUserId !== "string"
    || !Number.isSafeInteger(decoded.amount)
    || Number(decoded.amount) <= 0
    || (decoded.memo !== null && typeof decoded.memo !== "string")
  ) {
    throw new Error("送金の再試行情報が壊れています");
  }
  return decoded as TransferRetryPayload;
}

function transferConfirmation(
  key: string,
  fromUserId: string,
  toUserId: string,
  amount: number,
  memo: string | null,
  balance: number,
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const nowMs = Date.now();
  const dupeKey = `${fromUserId}:${toUserId}:${amount}`;
  const isDupe = (recentDone.get(dupeKey) ?? 0) > nowMs - DUPE_WINDOW_MS;
  pending.set(key, { fromUserId, toUserId, amount, memo, expiresAt: nowMs + CONFIRM_TTL_MS });

  const embed = new EmbedBuilder()
    .setTitle("💸 送金の確認")
    .setDescription(
      [
        `送り先: <@${toUserId}>`,
        `金額: **${fmtLd(amount)}**`,
        `送金後の残高: ${fmtLd(balance - amount)}`,
        memo ? `メモ: 『${memo}』（公開ログに載ります）` : "メモ: なし",
        isDupe ? "\n⚠️ **さっき同じ相手に同額を送ったばかりです。** 二重送信ではありませんか？" : "",
      ].filter(Boolean).join("\n"),
    )
    .setColor(isDupe ? 0xf59e0b : 0x6b21a8);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`tf:ok:${key}`).setLabel("送る").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`tf:no:${key}`).setLabel("やめる").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

function chipReturnConfirmation(
  confirmationId: string,
  currentLand: number,
  requiredLand: number,
  freeChips: number,
) {
  return {
    content: [
      `Landが足りません（所持 ${fmtLd(currentLand)} / 必要 ${fmtLd(requiredLand)}）。`,
      `賭場に **${fmtLd(freeChips)}** あります。`,
      "押した場合だけ自由チップをLandへ戻し、同じ送金操作を一度だけ続けます。",
    ].join("\n"),
    embeds: [],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`tf:chips:${confirmationId}`)
          .setLabel("Landへ戻して続ける")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`tf:chips-no:${confirmationId}`)
          .setLabel("やめる")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
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

  const nowMs = Date.now();
  const times = (rateBucket.get(me.id) ?? []).filter((time) => time > nowMs - 60_000);
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
    const freeChips = services.chips.freeChips(me.id);
    if (freeChips <= 0) {
      await interaction.reply({
        content: `残高が足りません（所持: ${fmtLd(balance)} / 必要: ${fmtLd(amount)}）。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    try {
      const confirmation = services.chipFlow.createExternalConfirmation({
        id: interaction.id,
        userId: me.id,
        operationKind: encodeRetryPayload({ kind: "transfer", toUserId: target.id, amount, memo }),
        operationId: interaction.id,
        requiredLand: amount - balance,
        chipAmount: freeChips,
        expiresAt: Math.floor((Date.now() + CONFIRM_TTL_MS) / 1_000),
      });
      await interaction.reply({
        ...chipReturnConfirmation(confirmation.id, balance, amount, freeChips),
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      await interaction.reply({
        content: `❌ ${error instanceof Error ? error.message : "Landへ戻す確認を作成できません"}`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  const threshold = services.settings.getNumber("approval_threshold");
  if (amount > threshold) {
    await requestApproval(interaction, services, target.id, amount, memo);
    return;
  }

  const key = interaction.id;
  await interaction.reply({
    ...transferConfirmation(key, me.id, target.id, amount, memo, balance),
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleTransferButton(
  interaction: ButtonInteraction,
  services: Services,
): Promise<void> {
  const [, action, key] = interaction.customId.split(":");
  if (!action || !key) return;

  if (action === "chips-no") {
    const cancelled = services.chipFlow.cancelExternalConfirmation(key, interaction.user.id);
    await interaction.update({
      content: cancelled ? "操作をやめました。賭場の自由チップは変更していません。" : "この確認は取り消せません。",
      embeds: [],
      components: [],
    });
    return;
  }

  if (action === "chips") {
    const confirmation = services.chipFlow.externalConfirmation(key);
    if (!confirmation || confirmation.userId !== interaction.user.id) {
      await interaction.reply({ content: "この確認は利用できません。", flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      const payload = decodeRetryPayload(confirmation.operationKind);
      let row = confirmation;
      if (row.status === "pending") row = services.chipFlow.beginExternalConfirmation(key, interaction.user.id);
      if (row.status !== "executing") throw new Error("この確認は既に処理されています");
      services.chipFlow.redeemExactFreeChips(
        interaction.user.id,
        row.chipAmount,
        `external:${key}`,
        "賭場外の送金を続けるための返還",
        true,
      );

      const balance = services.ledger.balanceOf(`user:${interaction.user.id}`);
      if (balance < payload.amount) {
        throw new Error(`Landへ戻した後も残高が足りません（所持 ${fmtLd(balance)} / 必要 ${fmtLd(payload.amount)}）`);
      }

      const threshold = services.settings.getNumber("approval_threshold");
      if (payload.amount > threshold) {
        await requestApproval(interaction, services, payload.toUserId, payload.amount, payload.memo);
      } else {
        const retryKey = `ext-${key}`;
        await interaction.update(
          transferConfirmation(
            retryKey,
            interaction.user.id,
            payload.toUserId,
            payload.amount,
            payload.memo,
            balance,
          ),
        );
      }
      if (!services.chipFlow.completeExternalConfirmation(key, interaction.user.id)) {
        throw new Error("返還確認の完了記録に失敗しました");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "送金の再開に失敗しました";
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: `❌ ${message}`, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.update({ content: `❌ ${message}`, embeds: [], components: [] });
      }
    }
    return;
  }

  const pendingTransfer = pending.get(key);
  if (!pendingTransfer || pendingTransfer.expiresAt < Date.now()) {
    pending.delete(key);
    await interaction.update({
      content: "⌛ 確認の期限が切れました。もう一度 `/送金` からどうぞ。",
      embeds: [],
      components: [],
    });
    return;
  }
  if (interaction.user.id !== pendingTransfer.fromUserId) return;

  if (action === "no") {
    pending.delete(key);
    await interaction.update({ content: "送金をやめました。", embeds: [], components: [] });
    return;
  }

  pending.delete(key);
  try {
    const result = services.ledger.transfer({
      from: `user:${pendingTransfer.fromUserId}`,
      to: `user:${pendingTransfer.toUserId}`,
      amount: pendingTransfer.amount,
      type: "transfer",
      actor: `user:${pendingTransfer.fromUserId}`,
      reason: pendingTransfer.memo ?? undefined,
      idempotencyKey: `transfer:${key}`,
    });
    recentDone.set(
      `${pendingTransfer.fromUserId}:${pendingTransfer.toUserId}:${pendingTransfer.amount}`,
      Date.now(),
    );
    const times = rateBucket.get(pendingTransfer.fromUserId) ?? [];
    times.push(Date.now());
    rateBucket.set(pendingTransfer.fromUserId, times.slice(-10));

    const after = services.ledger.balanceOf(`user:${pendingTransfer.fromUserId}`);
    await interaction.update({
      content: `✅ <@${pendingTransfer.toUserId}> に **${fmtLd(pendingTransfer.amount)}** を送りました（tx#${result.tx.id}）。残高: ${fmtLd(after)}`,
      embeds: [],
      components: [],
    });
  } catch (error) {
    const ledgerError = error as LedgerError;
    const message =
      ledgerError instanceof LedgerError && ledgerError.code === "ERR_INSUFFICIENT"
        ? `残高が足りません（所持: ${fmtLd(Number(ledgerError.details.balance))} / 必要: ${fmtLd(Number(ledgerError.details.required))}）。`
        : "送金に失敗しました。時間をおいて再度お試しください。";
    await interaction.update({ content: `❌ ${message}`, embeds: [], components: [] });
  }
}

async function requestApproval(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
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
    const content = `**${fmtLd(amount)}** は高額送金のため運営の承認が必要ですが、#決裁 チャンネルが未設定です。運営に連絡してください。`;
    if (interaction.isButton()) await interaction.update({ content, embeds: [], components: [] });
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    return;
  }

  const requestId = interaction.id;
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
      .setCustomId(`apv:ok:${interaction.user.id}:${toUserId}:${amount}:${requestId}`)
      .setLabel("承認して実行")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`apv:no:${interaction.user.id}:${toUserId}:${amount}:${requestId}`)
      .setLabel("却下")
      .setStyle(ButtonStyle.Danger),
  );
  await kessai.send({ embeds: [embed], components: [row] });
  const content = `**${fmtLd(amount)}** は高額送金のため、運営の承認待ちに回しました。承認されると公開ログに流れます。`;
  if (interaction.isButton()) await interaction.update({ content, embeds: [], components: [] });
  else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
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
  } catch (error) {
    const ledgerError = error as LedgerError;
    const detail =
      ledgerError instanceof LedgerError && ledgerError.code === "ERR_INSUFFICIENT"
        ? `申請者の残高不足（所持: ${fmtLd(Number(ledgerError.details.balance))} / 必要: ${fmtLd(Number(ledgerError.details.required))}）`
        : "台帳エラー";
    await interaction.update({
      embeds: interaction.message.embeds,
      components: [],
      content: `❌ 実行に失敗: ${detail}`,
    });
  }
}
