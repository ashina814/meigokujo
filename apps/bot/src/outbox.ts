import type { Client, TextChannel } from "discord.js";
import { mention } from "./format.js";
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

function formatPublic(p: TxPayload): string {
  const memo = p.reason ? `『${p.reason}』` : "";
  return `💸 ${mention(p.from)} → ${mention(p.to)} **${p.amount.toLocaleString()} Ld** ${memo}`;
}

function parsePayload(raw: string): (Partial<TxPayload> & { event?: string }) | null {
  try {
    return JSON.parse(raw) as Partial<TxPayload> & { event?: string };
  } catch {
    return null;
  }
}

function shouldSuppressAudit(raw: string): boolean {
  const p = parsePayload(raw);
  // 浮上報酬は人数分の個別auditが流れて視認性を壊すため、Discordには出さない。
  // DB上の audit/outbox/transactions には残るので監査性は維持する。
  return p?.type === "vc_reward";
}

function formatAudit(kind: string, raw: string): string {
  const p = parsePayload(raw);
  if (!p) return `📋 ${kind}: ${raw}`;

  if (p.event) {
    // 設定変更・給与実行などのイベント系
    return `📋 \`${p.event}\` ${raw.length > 300 ? raw.slice(0, 300) + "…" : raw}`;
  }

  const amount = typeof p.amount === "number" ? `${p.amount.toLocaleString()} Ld` : "? Ld";
  const actor = p.actor ? `actor: ${p.actor}` : "actor: ?";
  const reason = p.reason ? ` / ${p.reason}` : "";

  return [
    `📋 tx#${p.txId ?? "?"}｜\`${p.type ?? kind}\`｜${mention(p.from ?? "?")} → ${mention(p.to ?? "?")}｜${amount}`,
    `${actor}${reason}`,
  ].join("\n");
}

/**
 * outbox ワーカー: 取引と同一コミットで積まれた通知を Discord に配送する（経済設計.md §7）。
 * 配送先チャンネル未設定・API障害時はエントリが残り、次のループで再試行される。
 */
export function startOutboxWorker(client: Client, services: Services, intervalMs = 5_000): NodeJS.Timeout {
  const { ledger, settings } = services;
  let running = false;

  async function channelFor(kind: string): Promise<TextChannel | undefined> {
    const channelKind = kind === "public_log" ? "public_log" : "audit_log";
    const id = settings.getString(`channel:${channelKind}`);
    if (!id) return undefined;
    const channel = await client.channels.fetch(id).catch(() => null);
    return channel?.isTextBased() ? (channel as TextChannel) : undefined;
  }

  async function tick(): Promise<void> {
    if (running) return;
    running = true;

    try {
      const pending = ledger.pendingOutbox(20);
      for (const entry of pending) {
        try {
          if (entry.kind === "audit_log" && shouldSuppressAudit(entry.payload)) {
            ledger.markOutboxDelivered(entry.id);
            continue;
          }

          const channel = await channelFor(entry.kind);
          if (!channel) {
            // 配送先未設定の間は attempts を増やさず待つ（設定されたら一気に流れる）
            continue;
          }

          const content =
            entry.kind === "public_log"
              ? formatPublic(JSON.parse(entry.payload) as TxPayload)
              : formatAudit(entry.kind, entry.payload);

          await channel.send({
            content,
            allowedMentions: entry.kind === "public_log" ? { parse: ["users"] } : { parse: [] },
          });
          ledger.markOutboxDelivered(entry.id);
        } catch (err) {
          ledger.incrementOutboxAttempts(entry.id);
          console.error(`[outbox] 配送失敗 id=${entry.id}`, err);
        }
      }
    } finally {
      running = false;
    }
  }

  return setInterval(() => void tick().catch((err) => console.error("[outbox] tick失敗:", err)), intervalMs);
}
