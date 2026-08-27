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
 *   - output is deterministic aggregate JSON; no subject id, raw evidence, or source payload is
 *     ever emitted (the artifact is asserted subject-id-free before being written/printed)
 *   - it fails closed when the collection's catalog/readiness provenance no longer matches the
 *     live contracts (see `buildF5cDecisionEvidence`)
 *
 * Usage:
 *   pnpm --filter @meigokujo/core evidence:f5c3 -- \
 *     --db=/path/to/snapshot.sqlite \
 *     --cohort-key=2026-08-review \
 *     --subject-ids=id1,id2,id3 \
 *     --window-start=1756000000 --window-end=1758592000 --observed-at=1758592000 \
 *     [--coverage-window-validated] \
 *     [--out=/path/to/f5c3-evidence.json]
 *
 * `--coverage-window-validated` is an **operator attestation**, not something this script can
 * verify: pass it only if the window genuinely starts after every source used by READY-76's probes
 * was rolled out AND you accept the residual untracked-gap risk each safe source documents.
 * Omitting it is always safe — the evidence is simply marked not decision-grade.
 */
import { writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { buildF5cDecisionEvidence } from "../src/titles/v2-decision-evidence.js";
import { collectF5cCalibrationMeasurements } from "../src/titles/v2-calibration.js";

interface Args {
  readonly db: string;
  readonly cohortKey: string;
  readonly subjectUserIds: readonly string[];
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
  "db", "cohort-key", "subject-ids", "window-start", "window-end", "observed-at", "out",
]);

export function parseArgs(argv: readonly string[]): Args {
  const single = new Map<string, string>();
  let coverageWindowValidated = false;
  for (const arg of argv) {
    if (arg === "--coverage-window-validated") { coverageWindowValidated = true; continue; }
    const eq = arg.indexOf("=");
    if (!arg.startsWith("--") || eq === -1) throw new Error(`unrecognized argument: ${arg}`);
    const key = arg.slice(2, eq);
    if (!VALUE_ARG_KEYS.has(key)) throw new Error(`unrecognized argument: --${key}`);
    if (single.has(key)) throw new Error(`duplicate --${key}`);
    single.set(key, arg.slice(eq + 1));
  }
  const need = (key: string): string => {
    const value = single.get(key);
    if (value === undefined || value === "") throw new Error(`--${key} is required`);
    return value;
  };
  const subjectUserIds = need("subject-ids").split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (subjectUserIds.length === 0) throw new Error("--subject-ids must list at least one subject");
  if (new Set(subjectUserIds).size !== subjectUserIds.length) throw new Error("--subject-ids contains duplicates");
  const start = requireInteger(need("window-start"), "--window-start");
  const end = requireInteger(need("window-end"), "--window-end");
  const observedAt = requireInteger(need("observed-at"), "--observed-at");
  return {
    db: need("db"),
    cohortKey: need("cohort-key"),
    subjectUserIds,
    window: { start, end, observedAt },
    coverageWindowValidated,
    out: single.get("out") ?? null,
  };
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

export function main(argv: readonly string[]): void {
  const args = parseArgs(argv);
  // readonly + fileMustExist: this run cannot create, migrate, or modify the snapshot.
  const db = new Database(args.db, { readonly: true, fileMustExist: true });
  try {
    const collection = collectF5cCalibrationMeasurements(db, {
      cohortKey: args.cohortKey,
      subjectUserIds: args.subjectUserIds,
      window: args.window,
    });
    const report = buildF5cDecisionEvidence(collection, args.coverageWindowValidated);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    assertNoSubjectIdentity(serialized, args.subjectUserIds);
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
