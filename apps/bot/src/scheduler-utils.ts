import type { ActionRowBuilder, ButtonBuilder, TextChannel } from "discord.js";
import type { Services } from "./services.js";

const schedulerInFlightMarkers = new Set<string>();

export async function runSchedulerTaskOnce(
  services: Pick<Services, "settings">,
  marker: string,
  actor: string,
  task: () => Promise<void> | void,
): Promise<boolean> {
  if (services.settings.getString(marker)) return false;
  if (schedulerInFlightMarkers.has(marker)) return false;

  schedulerInFlightMarkers.add(marker);
  try {
    await task();
    services.settings.set(marker, "1", actor);
    return true;
  } finally {
    schedulerInFlightMarkers.delete(marker);
  }
}

/** Discordの1メッセージあたりの content 上限 */
const DISCORD_CONTENT_MAX = 2000;

export interface SchedulerChunkBatchRow {
  batch_key: string;
  kind: string;
  status: "pending" | "completed";
  target_ids_json: string;
  role_ids_json: string;
  chunks_json: string | null;
  sent_chunks_json: string;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
  completed_at: number | null;
}

export interface ResumableChunkSnapshot {
  batchKey: string;
  kind: string;
  header: string;
  lines: string[];
  targetIds: string[];
  roleIds: string[];
  metadata?: Record<string, unknown>;
}

const now = () => Math.floor(Date.now() / 1000);

function ensureColumn(db: Services["db"], table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function ensureChunkBatchTable(db: Services["db"]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduler_chunk_batches (
      batch_key       TEXT PRIMARY KEY,
      kind            TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed')),
      target_ids_json TEXT NOT NULL,
      role_ids_json   TEXT NOT NULL,
      chunks_json     TEXT,
      sent_chunks_json TEXT NOT NULL DEFAULT '[]',
      metadata_json   TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      sent_at         INTEGER,
      completed_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_scheduler_chunk_batches_kind ON scheduler_chunk_batches(kind, status, created_at);
  `);
  ensureColumn(db, "scheduler_chunk_batches", "sent_at", "INTEGER");
}

function buildChunks(header: string, lines: string[]): string[] {
  const chunks: string[] = [];
  let cur = header;
  for (const raw of lines) {
    const line = raw.length > DISCORD_CONTENT_MAX ? `${raw.slice(0, DISCORD_CONTENT_MAX - 1)}…` : raw;
    if (`${cur}\n${line}`.length > DISCORD_CONTENT_MAX) {
      chunks.push(cur);
      cur = line;
    } else {
      cur = cur ? `${cur}\n${line}` : line;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function pendingChunkBatch(
  services: Pick<Services, "db">,
  kind: string,
): SchedulerChunkBatchRow | undefined {
  ensureChunkBatchTable(services.db);
  return services.db
    .prepare("SELECT * FROM scheduler_chunk_batches WHERE kind=? AND status='pending' ORDER BY created_at LIMIT 1")
    .get(kind) as SchedulerChunkBatchRow | undefined;
}

export function cleanupCompletedChunkBatches(services: Pick<Services, "db">, olderThanSec = 86_400): void {
  ensureChunkBatchTable(services.db);
  services.db
    .prepare("DELETE FROM scheduler_chunk_batches WHERE status='completed' AND completed_at IS NOT NULL AND completed_at < ?")
    .run(now() - olderThanSec);
}

export function finalizeChunkBatch(
  services: Pick<Services, "db">,
  batchKey: string,
  finalize?: () => void,
): boolean {
  ensureChunkBatchTable(services.db);
  const complete = services.db.transaction(() => {
    const row = services.db
      .prepare("SELECT status, sent_at FROM scheduler_chunk_batches WHERE batch_key=?")
      .get(batchKey) as { status: "pending" | "completed"; sent_at: number | null } | undefined;
    if (!row || row.status === "completed") return false;
    if (!row.sent_at) throw new Error(`scheduler_chunk_batch:not_fully_sent:${batchKey}`);
    finalize?.();
    const ts = now();
    const updated = services.db
      .prepare(
        `UPDATE scheduler_chunk_batches
         SET status='completed', chunks_json=NULL, metadata_json=NULL, updated_at=?, completed_at=?
         WHERE batch_key=? AND status='pending' AND sent_at IS NOT NULL`,
      )
      .run(ts, ts, batchKey);
    return updated.changes === 1;
  });
  return complete();
}

export async function sendChunkedLinesResumable(
  services: Pick<Services, "db">,
  channel: TextChannel,
  snapshot: ResumableChunkSnapshot,
  opts: { components?: ActionRowBuilder<ButtonBuilder>[] } = {},
): Promise<{ targetIds: string[]; roleIds: string[]; sent: number; allSent: boolean }> {
  ensureChunkBatchTable(services.db);
  const ts = now();
  const existing = services.db
    .prepare("SELECT * FROM scheduler_chunk_batches WHERE batch_key=?")
    .get(snapshot.batchKey) as SchedulerChunkBatchRow | undefined;
  if (!existing) {
    services.db
      .prepare(
        `INSERT INTO scheduler_chunk_batches
         (batch_key, kind, status, target_ids_json, role_ids_json, chunks_json, sent_chunks_json, metadata_json, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?, ?, '[]', ?, ?, ?)`,
      )
      .run(
        snapshot.batchKey,
        snapshot.kind,
        JSON.stringify(snapshot.targetIds),
        JSON.stringify(snapshot.roleIds),
        JSON.stringify(buildChunks(snapshot.header, snapshot.lines)),
        snapshot.metadata ? JSON.stringify(snapshot.metadata) : null,
        ts,
        ts,
      );
  }
  const row = services.db
    .prepare("SELECT * FROM scheduler_chunk_batches WHERE batch_key=?")
    .get(snapshot.batchKey) as SchedulerChunkBatchRow;
  const targetIds = parseJsonArray(row.target_ids_json);
  const roleIds = parseJsonArray(row.role_ids_json);
  if (row.status === "completed") return { targetIds, roleIds, sent: 0, allSent: true };
  if (row.sent_at) return { targetIds, roleIds, sent: 0, allSent: true };

  const chunks = parseJsonArray(row.chunks_json);
  if (chunks.length === 0) throw new Error(`scheduler_chunk_batch:chunks_missing:${snapshot.batchKey}`);
  const sentChunks = new Set(parseJsonArray(row.sent_chunks_json).map((v) => Number(v)).filter(Number.isInteger));
  let sentNow = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    if (sentChunks.has(i)) continue;
    await channel.send({
      content: chunks[i]!,
      allowedMentions: { parse: [], roles: i === 0 ? roleIds : [] },
      ...(i === chunks.length - 1 && opts.components ? { components: opts.components } : {}),
    });
    sentChunks.add(i);
    sentNow += 1;
    services.db
      .prepare("UPDATE scheduler_chunk_batches SET sent_chunks_json=?, updated_at=? WHERE batch_key=? AND status='pending'")
      .run(JSON.stringify([...sentChunks].sort((a, b) => a - b).map(String)), now(), snapshot.batchKey);
  }

  if (sentChunks.size !== chunks.length) {
    throw new Error(`scheduler_chunk_batch:send_incomplete:${snapshot.batchKey}`);
  }
  services.db
    .prepare("UPDATE scheduler_chunk_batches SET sent_at=COALESCE(sent_at, ?), updated_at=? WHERE batch_key=? AND status='pending'")
    .run(now(), now(), snapshot.batchKey);
  return { targetIds, roleIds, sent: sentNow, allSent: true };
}

/**
 * 見出し＋行リストを 2000 文字以内へ分割して送る。
 *
 * 通常の一括送信用。再起動後の再開が必要なScheduler通知では
 * sendChunkedLinesResumable を使い、本文をsettings監査ログへ保存しない。
 */
export async function sendChunkedLines(
  channel: TextChannel,
  header: string,
  lines: string[],
  opts: { components?: ActionRowBuilder<ButtonBuilder>[]; allowedRoleIds?: string[] } = {},
): Promise<void> {
  const chunks = buildChunks(header, lines);
  for (let i = 0; i < chunks.length; i++) {
    await channel.send({
      content: chunks[i]!,
      allowedMentions: { parse: [], roles: i === 0 ? (opts.allowedRoleIds ?? []) : [] },
      ...(i === chunks.length - 1 && opts.components ? { components: opts.components } : {}),
    });
  }
}
