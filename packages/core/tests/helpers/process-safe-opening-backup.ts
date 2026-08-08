import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  TestFilesystemOpeningBackupAdapter,
  type ManifestVerificationExpectation,
  type OpeningBackupAdapter,
  type OpeningBackupManifest,
  type OpeningBackupRequest,
  type OpeningBackupVerificationResult,
} from "../../src/casino/opening-backup.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * TestFilesystemOpeningBackupAdapter を別Nodeプロセス間で共有するときの協調ラッパー。
 *
 * 同一planHashへのbackupは1 workerだけが書き込み権を取得し、manifest公開後は
 * 後続workerがそのmanifestを読み取って同じ永続証拠を再利用する。
 * planHashが同じでも createdAt やSQLite snapshot hashは各呼び出しで同一とは限らないため、
 * 複数workerが同じ最終ファイル名へ上書きし合うことを禁止する。
 *
 * production backup adapterではなく、OpeningResetの実プロセス競合テスト専用。
 */
export class ProcessSafeTestOpeningBackupAdapter implements OpeningBackupAdapter {
  readonly durability = "persistent" as const;
  private readonly delegate: TestFilesystemOpeningBackupAdapter;

  constructor(
    private readonly directory: string,
    private readonly waitTimeoutMs = 15_000,
  ) {
    this.delegate = new TestFilesystemOpeningBackupAdapter(directory);
  }

  async backup(request: OpeningBackupRequest): Promise<OpeningBackupManifest> {
    const prefix = `casino-opening-${request.planHash}`;
    const manifestPath = join(this.directory, `${prefix}-manifest.json`);
    const lockPath = join(this.directory, `${prefix}.lock`);
    const deadline = Date.now() + this.waitTimeoutMs;

    for (;;) {
      if (existsSync(manifestPath)) return readManifest(manifestPath, request.planHash);

      let lockFd: number | null = null;
      try {
        lockFd = openSync(lockPath, "wx", 0o600);
      } catch (e) {
        if (!isAlreadyExists(e)) throw e;
      }

      if (lockFd !== null) {
        closeSync(lockFd);
        try {
          // lock取得直前に別workerが公開を完了していた場合も、既存証拠を優先する。
          if (existsSync(manifestPath)) return readManifest(manifestPath, request.planHash);
          return await this.delegate.backup(request);
        } finally {
          try {
            unlinkSync(lockPath);
          } catch (e) {
            if (!isNotFound(e)) throw e;
          }
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(`opening backup lock timeout: planHash=${request.planHash}`);
      }
      await sleep(10);
    }
  }

  verifyPersistedBackup(
    manifest: OpeningBackupManifest,
    expectation: ManifestVerificationExpectation,
  ): Promise<OpeningBackupVerificationResult> {
    return this.delegate.verifyPersistedBackup(manifest, expectation);
  }
}

function readManifest(path: string, expectedPlanHash: string): OpeningBackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`published opening backup manifest is unreadable: ${path}`, { cause: e });
  }
  if (!parsed || typeof parsed !== "object" || (parsed as { planHash?: unknown }).planHash !== expectedPlanHash) {
    throw new Error(`published opening backup manifest has unexpected planHash: ${path}`);
  }
  return parsed as OpeningBackupManifest;
}

function isAlreadyExists(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === "EEXIST";
}

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === "ENOENT";
}
