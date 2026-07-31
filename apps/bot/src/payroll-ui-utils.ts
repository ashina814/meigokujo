import { createHash } from "node:crypto";
import type { ExecutionReport, PayoutRunRow } from "@meigokujo/core";

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseExecutionReport(raw: string | null): ExecutionReport | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (
    !isNonNegativeSafeInteger(parsed.succeeded) ||
    !isNonNegativeSafeInteger(parsed.skippedAsPaid) ||
    !isNonNegativeSafeInteger(parsed.totalPaid) ||
    !Array.isArray(parsed.failed)
  ) {
    return undefined;
  }

  const failed: ExecutionReport["failed"] = [];
  for (const item of parsed.failed) {
    if (!isRecord(item) || typeof item.userId !== "string" || typeof item.code !== "string" || !isRecord(item.details)) {
      return undefined;
    }
    failed.push({ userId: item.userId, code: item.code, details: item.details });
  }

  return {
    succeeded: parsed.succeeded,
    skippedAsPaid: parsed.skippedAsPaid,
    failed,
    totalPaid: parsed.totalPaid,
  };
}

export function reportOf(run: PayoutRunRow): ExecutionReport | undefined {
  return parseExecutionReport(run.report_json);
}

export function jstPeriod(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("JSTの対象月を計算できませんでした");
  return `${year}-${month}`;
}

function shiftPeriod(period: string, offset: number): string {
  const match = PERIOD_RE.exec(period);
  if (!match) throw new Error(`対象月が不正です: ${period}`);
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + offset, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function manualPayrollPeriods(date = new Date()): { current: string; previous: string } {
  const current = jstPeriod(date);
  return { current, previous: shiftPeriod(current, -1) };
}

export function isManualPayrollPeriod(period: string, date = new Date()): boolean {
  const { current, previous } = manualPayrollPeriods(date);
  return period === current || period === previous;
}

export function planHash(run: PayoutRunRow): string {
  return createHash("sha256").update(run.plan_json).digest("hex").slice(0, 12);
}

export function shorten(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function safeText(value: string): string {
  return value.replace(/[\r\n\t]+/gu, " ").trim();
}
