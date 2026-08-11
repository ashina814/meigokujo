import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type StringSelectMenuBuilder } from "discord.js";
import type { TicketRow } from "@meigokujo/core";
import type { Services } from "../services.js";

/**
 * チケットの見た目まわり（状態表示・スレッド名・完了処理）。
 *
 * **受付固有のコードへ依存しない。** ここに `return` / `reeval` の中身を持ち込むと
 * `tickets.ts ↔ entry-return.ts` の循環importになり、片方の定数が読み込み順によって
 * undefined になる（実際にそれで「戻し先の選択が付かない」不具合を作った）。
 * 受付固有の操作行は**引数で受け取る**ことで依存の向きを一方向に保つ。
 */

export type TicketRows = ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];

export type LockableThread = {
  id: string;
  setLocked(locked: boolean, reason?: string): Promise<unknown>;
  setArchived(archived: boolean, reason?: string): Promise<unknown>;
};

export function safeThreadPart(value: string, fallback: string): string {
  const cleaned = value.replace(/[\r\n｜]/gu, " ").replace(/\s+/gu, " ").trim();
  return (cleaned || fallback).slice(0, 24);
}

export function ticketBaseThreadName(name: string): string {
  return name
    .replace(/^🔴未対応｜/u, "")
    .replace(/^🟡[^｜]{1,30}対応中｜/u, "")
    .replace(/^✅完了｜/u, "");
}

export function ticketThreadName(status: "open" | "claimed" | "closed", currentOrBase: string, staffName?: string): string {
  const base = ticketBaseThreadName(currentOrBase);
  const prefix =
    status === "open" ? "🔴未対応｜" : status === "claimed" ? `🟡${safeThreadPart(staffName ?? "担当者", "担当者")}対応中｜` : "✅完了｜";
  return `${prefix}${base}`.slice(0, 90);
}

export function ticketStatusContent(content: string, statusLine: string): string {
  const lines = content
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("🔴 **対応状況:**") && !line.startsWith("🟡 **対応状況:**") && !line.startsWith("✅ **対応状況:**"),
    );
  while (lines.at(-1) === "") lines.pop();
  return [...lines, "", statusLine].join("\n");
}

/**
 * このやり取りの元になったチケット操作メッセージ。
 *
 * ボタンからの操作はそのメッセージ自身、モーダルからの操作も
 * 「どのメッセージのコンポーネントから開いたか」を discord.js が持っている。
 * ここが取れないと**操作UIを完了状態にできない**（実際それで無効化できていなかった）。
 */
export function controlMessageOf(interaction: {
  message?: unknown;
}): { content: string; edit: (payload: unknown) => Promise<unknown> } | null {
  const message = interaction.message as { content?: unknown; edit?: unknown } | null | undefined;
  if (!message || typeof message.content !== "string" || typeof message.edit !== "function") return null;
  return message as { content: string; edit: (payload: unknown) => Promise<unknown> };
}

export function ticketActionRow(status: TicketRow["status"]): ActionRowBuilder<ButtonBuilder> {
  const claim = new ButtonBuilder()
    .setCustomId("ticket:claim")
    .setLabel(status === "open" ? "対応する" : "対応済み")
    .setStyle(status === "open" ? ButtonStyle.Primary : ButtonStyle.Secondary)
    .setDisabled(status !== "open");
  // クローズ済みでも押せるままにしておく。台帳は閉じたのに表示だけ失敗した場合、
  // ここが唯一の修復導線になる（押すと表示だけをやり直す）
  const close = new ButtonBuilder()
    .setCustomId("ticket:close")
    .setLabel(status === "closed" ? "表示を修復" : "クローズ")
    .setStyle(status === "closed" ? ButtonStyle.Secondary : ButtonStyle.Danger);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(claim, close);
}

/**
 * スレッドを閉じる。**失敗を握り潰さず呼び出し側へ返す。**
 * 握ったままだと「ロックだけ失敗した」チケットが修復対象に出てこない。
 */
export async function lockAndArchiveThread(thread: LockableThread, reason: string): Promise<string[]> {
  const problems: string[] = [];
  await thread.setLocked(true, reason).catch((e) => {
    console.warn(`[ticket] スレッドのロックに失敗: ${thread.id}`, e);
    problems.push(`スレッドのロックに失敗: ${(e as Error).message}`);
  });
  await thread.setArchived(true, reason).catch((e) => {
    console.warn(`[ticket] スレッドのアーカイブに失敗: ${thread.id}`, e);
    problems.push(`スレッドのアーカイブに失敗: ${(e as Error).message}`);
  });
  return problems;
}

/**
 * DB上でクローズ済みのチケットを、Discord 側でも完了状態にする。
 *
 * 出戻り・再評価の確定は台帳を先に確定させるので、ここが失敗しても
 * **DBを巻き戻さない**。表示だけの問題として repair event を残し、
 * もう一度呼べば直せる形にしておく。
 */
export async function finalizeTicketDiscordState(
  services: Services,
  thread: { id: string; name: string; setName: (name: string, reason?: string) => Promise<unknown> } & Partial<LockableThread>,
  ticket: TicketRow | undefined,
  opts: {
    controlMessage?: { content: string; edit: (payload: unknown) => Promise<unknown> } | null;
    /** 完了状態の操作行。受付固有の行は呼び出し側が渡す（依存の向きを保つため） */
    components?: TicketRows;
    actor: string;
    reason: string;
  },
): Promise<string[]> {
  const problems: string[] = [];
  if (opts.controlMessage) {
    const content = ticketStatusContent(opts.controlMessage.content, `✅ **対応状況:** 完了（${opts.reason}）`);
    await opts.controlMessage
      .edit({ content, components: opts.components ?? [ticketActionRow("closed")], allowedMentions: { parse: [] } })
      .catch((e) => {
        problems.push(`操作UIの無効化に失敗: ${(e as Error).message}`);
      });
  }
  await thread.setName(ticketThreadName("closed", thread.name), opts.reason).catch((e) => {
    problems.push(`スレッド名の更新に失敗: ${(e as Error).message}`);
  });
  if (thread.setLocked && thread.setArchived) {
    problems.push(...(await lockAndArchiveThread(thread as LockableThread, opts.reason)));
  }
  if (problems.length > 0) {
    services.events.log("ticket_display_repair_needed", {
      actor: opts.actor,
      target: ticket?.user_id,
      payload: { threadId: thread.id, problems, note: "台帳は確定済み。表示だけもう一度直せばよい" },
    });
  }
  return problems;
}
