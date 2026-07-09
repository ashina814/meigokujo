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

interface DigestItem {
  type: string;
  from: string;
  to: string;
  amount: number;
}

interface DigestBucket {
  count: number;
  total: number;
  issued: number;
  collected: number;
  moved: number;
}

const TREASURY = "sys:treasury";
const AUDIT_DIGEST_INTERVAL_MS = 10 * 60 * 1000;
const AUDIT_DIGEST_MAX_ITEMS = 50;

const DIGEST_AUDIT_TYPES = new Set(["vc_reward", "room_fee", "room_refund", "initial"]);

const DIGEST_TYPE_LABELS: Record<string, string> = {
  vc_reward: "浮上報酬",
  room_fee: "部屋代",
  room_refund: "部屋返金",
  initial: "初期支給",
};

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

function digestibleAuditPayload(raw: string): DigestItem | null {
  const p = parsePayload(raw);
  if (!p?.type || !DIGEST_AUDIT_TYPES.has(p.type)) return null;
  if (typeof p.amount !== "number" || !p.from || !p.to) return null;
  return { type: p.type, from: p.from, to: p.to, amount: p.amount };
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

function formatDigestLine(type: string, bucket: DigestBucket): string {
  const label = DIGEST_TYPE_LABELS[type] ?? type;

  if (bucket.issued > 0 && bucket.collected === 0 && bucket.moved === 0) {
    return `・${label}: ${bucket.count}件 / 発行 ${bucket.issued.toLocaleString()} Ld`;
  }
  if (bucket.collected > 0 && bucket.issued === 0 && bucket.moved === 0) {
    return `・${label}: ${bucket.count}件 / 回収 ${bucket.collected.toLocaleString()} Ld`;
  }
  if (bucket.moved > 0 && bucket.issued === 0 && bucket.collected === 0) {
    return `・${label}: ${bucket.count}件 / 移動 ${bucket.moved.toLocaleString()} Ld`;
  }

  return `・${label}: ${bucket.count}件 / 計 ${bucket.total.toLocaleString()} Ld`;
}

function formatAuditDigest(items: DigestItem[], startedAtMs: number, endedAtMs: number): string {
  const buckets = new Map<string, DigestBucket>();

  for (const item of items) {
    const bucket = buckets.get(item.type) ?? { count: 0, total: 0, issued: 0, collected: 0, moved: 0 };
    bucket.count += 1;
    bucket.total += item.amount;

    if (item.from === TREASURY) bucket.issued += item.amount;
    else if (item.to === TREASURY) bucket.collected += item.amount;
    else bucket.moved += item.amount;

    buckets.set(item.type, bucket);
  }

  const started = Math.floor(startedAtMs / 1000);
  const ended = Math.floor(endedAtMs / 1000);
  const lines = [...buckets.entries()].map(([type, bucket]) => formatDigestLine(type, bucket));

  return [`📋 **取引サマリ** <t:${started}:t>〜<t:${ended}:t>`, ...lines, `合計: ${items.length}件`].join("\n");
}

/**
 * outbox ワーカー: 取引と同一コミットで積まれた通知を Discord に配送する（経済設計.md §7）。
 * 配送先チャンネル未設定・API障害時はエントリが残り、次のループで再試行される。
 */
export function startOutboxWorker(client: Client, services: Services, intervalMs = 5_000): NodeJS.Timeout {
  const { ledger, settings } = services;
  let running = false;
  let auditDigestItems: DigestItem[] = [];
  let auditDigestStartedAt = Date.now();

  async function channelFor(kind: string): Promise<TextChannel | undefined> {
    const channelKind = kind === "public_log" ? "public_log" : "audit_log";
    const id = settings.getString(`channel:${channelKind}`);
    if (!id) return undefined;
    const channel = await client.channels.fetch(id).catch(() => null);
    return channel?.isTextBased() ? (channel as TextChannel) : undefined;
  }

  async function flushAuditDigest(channel: TextChannel, force = false): Promise<void> {
    if (auditDigestItems.length === 0) return;

    const now = Date.now();
    const due = now - auditDigestStartedAt >= AUDIT_DIGEST_INTERVAL_MS;
    const full = auditDigestItems.length >= AUDIT_DIGEST_MAX_ITEMS;
    if (!force && !due && !full) return;

    const items = auditDigestItems;
    const content = formatAuditDigest(items, auditDigestStartedAt, now);

    try {
      await channel.send({ content, allowedMentions: { parse: [] } });
      auditDigestItems = [];
      auditDigestStartedAt = Date.now();
    } catch (err) {
      console.error("[outbox] audit digest 配送失敗:", err);
    }
  }

  async function tick(): Promise<void> {
    if (running) return;
    running = true;

    try {
      const pending = ledger.pendingOutbox(50);
      for (const entry of pending) {
        try {
          if (entry.kind === "audit_log") {
            const digestItem = digestibleAuditPayload(entry.payload);
            if (digestItem) {
              const channel = await channelFor(entry.kind);
              if (!channel) continue;

              if (auditDigestItems.length === 0) auditDigestStartedAt = Date.now();
              auditDigestItems.push(digestItem);
              ledger.markOutboxDelivered(entry.id);
              await flushAuditDigest(channel);
              continue;
            }
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

      if (auditDigestItems.length > 0) {
        const channel = await channelFor("audit_log");
        if (channel) await flushAuditDigest(channel);
      }
    } finally {
      running = false;
    }
  }

  return setInterval(() => void tick().catch((err) => console.error("[outbox] tick失敗:", err)), intervalMs);
}
