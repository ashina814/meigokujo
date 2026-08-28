/**
 * F5c3 operator entry point (task #192 §6): produce the aggregate decision-evidence artifact from
 * a real DB snapshot, for the human F6 threshold review.
 *
 * Planning/operator-only and deliberately hosted inside `packages/core` rather than the Bot: the
 * F5c modules are package-internal (absent from `src/index.ts` and from every `exports` subpath in
 * package.json), and adding a public subpath just to run a script would weaken exactly the
 * planning-only boundary this layer depends on.
 *
 * Guarantees:
 *   - the database is opened **read-only at the driver level** (`readonly: true`), so the run
 *     physically cannot write, migrate, or create anything — pass a snapshot copy, not live prod
 *   - the cohort, window and coverage attestation are all explicit arguments; nothing is defaulted
 *   - **restricted subject identities never enter argv** — the cohort is supplied as a file (or on
 *     stdin), so no identity reaches shell history, `ps`/process inspection, or command auditing;
 *     the ids stay transient in memory and are never echoed or logged
 *   - output is deterministic aggregate JSON; no subject id, raw evidence, or source payload is
 *     ever emitted (the artifact is asserted subject-id-free before being written/printed)
 *   - it fails closed when the collection's catalog/readiness provenance no longer matches the
 *     live contracts (see `buildF5cDecisionEvidence`)
 *
 * Usage. Do NOT add a `--` separator: this repository's pnpm forwards `--` through to the
 * script, where the strict argument allowlist correctly rejects it as an unrecognized
 * argument.
 *   pnpm --filter @meigokujo/core evidence:f5c3 \
 *     --db=/path/to/snapshot.sqlite \
 *     --cohort-key=2026-08-review \
 *     --subject-ids-file=/path/to/cohort.txt \
 *     --window-start=1756000000 --window-end=1758592000 --observed-at=1758592000 \
 *     [--coverage-window-validated] \
 *     [--out=/path/to/f5c3-evidence.json]
 *
 * `--subject-ids-file` is one subject id per line (blank lines ignored); pass `-` to read the list
 * from stdin instead, which keeps the cohort off disk entirely:
 *
 *   ... --subject-ids-file=- < cohort.txt
 *
 * `--coverage-window-validated` is an **operator attestation**, not something this script can
 * verify: pass it only if the window genuinely starts after every source used by READY-76's probes
 * was rolled out AND you accept the residual untracked-gap risk each safe source documents.
 * Omitting it is always safe — the evidence is simply marked not decision-grade.
 */
import { readFileSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { buildF5cDecisionEvidence } from "../src/titles/v2-decision-evidence.js";
import { collectF5cCalibrationMeasurements } from "../src/titles/v2-calibration.js";

interface Args {
  readonly db: string;
  readonly cohortKey: string;
  /** where to READ the cohort from — never the ids themselves (PR #192レビュー第1ラウンド§5). */
  readonly subjectIdsFile: string;
  readonly window: { readonly start: number; readonly end: number; readonly observedAt: number };
  readonly coverageWindowValidated: boolean;
  readonly out: string | null;
}

function requireInteger(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer unix timestamp, got ${JSON.stringify(raw)}`);
  return value;
}

/**
 * Every accepted `--key=value` argument. Unknown keys are rejected rather than ignored: a silently
 * dropped typo would hand the reviewer an artifact computed over a different cohort or window than
 * they believe they asked for.
 */
const VALUE_ARG_KEYS: ReadonlySet<string> = new Set([
  "db", "cohort-key", "subject-ids-file", "window-start", "window-end", "observed-at", "out",
]);

/**
 * Arguments that were once valid and must now fail LOUDLY rather than as a generic "unrecognized
 * argument". An operator reaching for the old inline form deserves to be told why it is gone, not
 * left guessing at a typo — and must never have it silently accepted.
 */
const REJECTED_ARG_KEYS: ReadonlyMap<string, string> = new Map([
  ["subject-ids", "--subject-ids is not accepted: command-line arguments are visible through shell history, process inspection, and command auditing. Use --subject-ids-file=<path> (one id per line), or --subject-ids-file=- to read the cohort from stdin."],
]);

export function parseArgs(argv: readonly string[]): Args {
  const single = new Map<string, string>();
  let coverageWindowValidated = false;
  for (const arg of argv) {
    if (arg === "--coverage-window-validated") { coverageWindowValidated = true; continue; }
    const eq = arg.indexOf("=");
    if (!arg.startsWith("--") || eq === -1) throw new Error(`unrecognized argument: ${arg}`);
    const key = arg.slice(2, eq);
    const rejected = REJECTED_ARG_KEYS.get(key);
    if (rejected !== undefined) throw new Error(rejected);
    if (!VALUE_ARG_KEYS.has(key)) throw new Error(`unrecognized argument: --${key}`);
    if (single.has(key)) throw new Error(`duplicate --${key}`);
    single.set(key, arg.slice(eq + 1));
  }
  const need = (key: string): string => {
    const value = single.get(key);
    if (value === undefined || value === "") throw new Error(`--${key} is required`);
    return value;
  };
  const start = requireInteger(need("window-start"), "--window-start");
  const end = requireInteger(need("window-end"), "--window-end");
  const observedAt = requireInteger(need("observed-at"), "--observed-at");
  return {
    db: need("db"),
    cohortKey: need("cohort-key"),
    subjectIdsFile: need("subject-ids-file"),
    window: { start, end, observedAt },
    coverageWindowValidated,
    out: single.get("out") ?? null,
  };
}

/**
 * Reads the cohort from a file (or stdin, via `-`). The ids exist only as this returned array —
 * they are never printed, logged, or written back out, and `assertNoSubjectIdentity` re-checks the
 * artifact against them before anything leaves the process.
 *
 * Fails closed on an empty cohort and on duplicates: a duplicate silently doubles one subject's
 * weight in every percentile boundary the evidence is built from, and `buildF5cDecisionEvidence`
 * refuses such a collection anyway — better to say so at the input, in the operator's own terms.
 */
export function readSubjectUserIds(source: string): readonly string[] {
  const raw = source === "-" ? readFileSync(0, "utf8") : readFileSync(source, "utf8");
  const ids = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  if (ids.length === 0) throw new Error("subject id input is empty: at least one subject id is required");
  // a comma almost certainly means the old inline comma-separated list was pasted into the file;
  // treating "a,b" as a single id would quietly produce an artifact over a cohort of nobody.
  const comma = ids.find((id) => id.includes(","));
  if (comma !== undefined) throw new Error("subject id input contains a comma: list one subject id per line");
  if (new Set(ids).size !== ids.length) throw new Error("subject id input contains duplicate ids");
  return ids;
}

/**
 * Belt-and-suspenders: the artifact type is aggregate-only by construction and a dedicated test
 * asserts that, but an operator run is the one place where a leak would actually escape the
 * process — so re-verify against the real cohort ids before anything is written or printed.
 */
function assertNoSubjectIdentity(serialized: string, subjectUserIds: readonly string[]): void {
  for (const id of subjectUserIds) {
    if (serialized.includes(id)) throw new Error("refusing to emit F5c3 evidence: serialized artifact contains a subject identifier");
  }
  if (serialized.includes("subjectUserId")) throw new Error("refusing to emit F5c3 evidence: serialized artifact contains a subject id field");
}

/**
 * The one place the operator run's database connection is constructed, exported so a test can
 * prove the SAME construction the run uses is genuinely read-only — rather than asserting it about
 * a separately-built handle and hoping the two stay in step.
 *
 * `readonly` means this connection cannot write, migrate, or create anything; `fileMustExist`
 * means it will not conjure an empty database when the path is wrong.
 */
export function openSnapshotReadOnly(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

export function main(argv: readonly string[]): void {
  const args = parseArgs(argv);
  const subjectUserIds = readSubjectUserIds(args.subjectIdsFile);
  const db = openSnapshotReadOnly(args.db);
  try {
    const collection = collectF5cCalibrationMeasurements(db, {
      cohortKey: args.cohortKey,
      subjectUserIds,
      window: args.window,
    });
    const report = buildF5cDecisionEvidence(collection, args.coverageWindowValidated);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    assertNoSubjectIdentity(serialized, subjectUserIds);
    if (args.out === null) process.stdout.write(serialized);
    else {
      writeFileSync(args.out, serialized, "utf8");
      // fingerprint + counts only — never cohort membership.
      process.stdout.write(`F5c3 evidence written to ${args.out}\n  fingerprint: ${report.reportFingerprint}\n  candidates: ${report.sensitivity.length}  overlapPairs: ${report.overlap.length}  coverageWindowValidated: ${report.provenance.coverageWindowValidated}\n`);
    }
  } finally {
    db.close();
  }
}

// executed directly (tsx scripts/f5c3-decision-evidence.ts ...), not when imported by a test.
if (process.argv[1] !== undefined && process.argv[1].endsWith("f5c3-decision-evidence.ts")) {
  main(process.argv.slice(2));
}
