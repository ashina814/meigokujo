/**
 * 旧ボットの残高ランキングダンプのパーサー（経済設計.md §9）。
 * 形式: `NN | 表示名: 合計 Ld (手:X / 預:Y / 業:Z)`
 * 手+預+業 を合算して1本の残高にする（2026-07-04 決定）。
 */

export interface DumpEntry {
  rank: number;
  displayName: string;
  total: number; // 手+預+業（検算済み）
  cash: number;
  deposit: number;
  business: number;
}

export interface DumpIssue {
  line: string;
  reason: "malformed" | "sum_mismatch" | "unsafe_amount";
  detail?: string;
}

export interface ParsedDump {
  entries: DumpEntry[];
  issues: DumpIssue[];
  /** 同じ表示名が複数回出た名前（メンバー照合で手動割当が必要） */
  duplicateNames: string[];
  totalAmount: number;
}

const LINE_RE =
  /^(\d+)\s*\|\s*(.+?):\s*([\d,]+)\s*Ld\s*\(手:([\d,]+)\s*\/\s*預:([\d,]+)\s*\/\s*業:([\d,]+)\)/;

const num = (s: string) => Number(s.replaceAll(",", ""));

export function parseBalanceDump(text: string): ParsedDump {
  const entries: DumpEntry[] = [];
  const issues: DumpIssue[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const m = LINE_RE.exec(line);
    if (!m) {
      issues.push({ line, reason: "malformed" });
      continue;
    }
    const [, rank, name, total, cash, deposit, business] = m;
    const entry: DumpEntry = {
      rank: num(rank!),
      displayName: name!.trim(),
      total: num(total!),
      cash: num(cash!),
      deposit: num(deposit!),
      business: num(business!),
    };
    // JSの安全な整数（約900兆）を超える金額は精度が壊れるため自動移行させない。
    // 実データで京クラス＝管理者の任意発行が確認されており、どのみち運営協議行き
    if (
      ![entry.total, entry.cash, entry.deposit, entry.business].every((v) => Number.isSafeInteger(v))
    ) {
      issues.push({ line, reason: "unsafe_amount", detail: "金額が大きすぎて精度が保証できない（手動対応）" });
      continue;
    }
    const sum = entry.cash + entry.deposit + entry.business;
    if (sum !== entry.total) {
      // 合計欄が壊れていても3成分から復元できるなら復元する
      if (Number.isSafeInteger(sum)) {
        entry.total = sum;
        issues.push({ line, reason: "sum_mismatch", detail: `表記合計と3成分の和が不一致 → 和 ${sum} を採用` });
      } else {
        issues.push({ line, reason: "malformed", detail: "金額が大きすぎて安全に扱えない" });
        continue;
      }
    }
    entries.push(entry);
  }

  const seen = new Map<string, number>();
  for (const e of entries) seen.set(e.displayName, (seen.get(e.displayName) ?? 0) + 1);
  const duplicateNames = [...seen.entries()].filter(([, c]) => c > 1).map(([n]) => n);

  return {
    entries,
    issues,
    duplicateNames,
    totalAmount: entries.reduce((s, e) => s + e.total, 0),
  };
}

export interface MigrationPlanOptions {
  /** これを超える残高はキャップ超過として自動移行から外し、運営協議に回す */
  cap: number;
}

export interface MigrationSplit {
  /** そのまま opening 発行してよい分 */
  auto: DumpEntry[];
  /** キャップ超過 = 運営協議行き */
  overCap: DumpEntry[];
  /** 同名衝突 = 手動割当が必要 */
  ambiguous: DumpEntry[];
}

export function splitForMigration(dump: ParsedDump, opts: MigrationPlanOptions): MigrationSplit {
  const dupes = new Set(dump.duplicateNames);
  const auto: DumpEntry[] = [];
  const overCap: DumpEntry[] = [];
  const ambiguous: DumpEntry[] = [];
  for (const e of dump.entries) {
    if (dupes.has(e.displayName)) ambiguous.push(e);
    else if (e.total > opts.cap) overCap.push(e);
    else auto.push(e);
  }
  return { auto, overCap, ambiguous };
}
