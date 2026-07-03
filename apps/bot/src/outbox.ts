import type { Client, TextChannel } from "discord.js";
import type { Services } from "./services.js";

interface TxPayload {
  txId: number;
  type: string;
  from: string;
  to: string;
  amount: number;
  reason: string | null;
  actor: string;
  refType: string | null;
  refId: string | null;
}

function mention(accountId: string): string {
  // 'user:<discordId>' → メンション、システム勘定はそのままラベル表示
  if (accountId.startsWith("user:")) return `<@${accountId.slice(5)}>`;
  if (accountId === "sys:treasury") return "🏛 国庫";
  return `⚙️ ${accountId}`;
}

function formatPublic(p: TxPayload): string {
  const memo = p.reason ? `『${p.reason}』` : "";
  return `💸 ${mention(p.from)} → ${mention(p.to)} **${p.amount.toLocaleString()} Ld** ${memo}`;
}

function formatAudit(kind: string, raw: string): string {
  try {
    const p = JSON.parse(raw) as Partial<TxPayload> & { event?: string };
    if (p.event) {
      // 設定変更・給与実行などのイベント系
      return `📋 \`${p.event}\` ${raw.length > 300 ? raw.slice(0, 300) + "…" : raw}`;
    }
    return `📋 tx#${p.txId} \`${p.type}\` ${mention(p.from ?? "?")} → ${mention(p.to ?? "?")} ${p.amount?.toLocaleString()} Ld（actor: ${p.actor}${p.reason ? ` / ${p.reason}` : ""}）`;
  } catch {
    return `📋 ${kind}: ${raw}`;
  }
}

/**
 * outbox ワーカー: 取引と同一コミットで積まれた通知を Discord に配送する（経済設計.md §7）。
 * 配送先チャンネル未設定・API障害時はエントリが残り、次のループで再試行される。
 */
export function startOutboxWorker(client: Client, services: Services, intervalMs = 5_000): NodeJS.Timeout {
  const { ledger, settings } = services;

  async function channelFor(kind: string): Promise<TextChannel | undefined> {
    const channelKind = kind === "public_log" ? "public_log" : "audit_log";
    const id = settings.getString(`channel:${channelKind}`);
    if (!id) return undefined;
    const channel = await client.channels.fetch(id).catch(() => null);
    return channel?.isTextBased() ? (channel as TextChannel) : undefined;
  }

  async function tick(): Promise<void> {
    const pending = ledger.pendingOutbox(20);
    for (const entry of pending) {
      try {
        const channel = await channelFor(entry.kind);
        if (!channel) {
          // 配送先未設定の間は attempts を増やさず待つ（設定されたら一気に流れる）
          continue;
        }
        const content =
          entry.kind === "public_log"
            ? formatPublic(JSON.parse(entry.payload) as TxPayload)
            : formatAudit(entry.kind, entry.payload);
        await channel.send({ content, allowedMentions: { parse: ["users"] } });
        ledger.markOutboxDelivered(entry.id);
      } catch (err) {
        ledger.incrementOutboxAttempts(entry.id);
        console.error(`[outbox] 配送失敗 id=${entry.id}`, err);
      }
    }
  }

  return setInterval(() => void tick(), intervalMs);
}
