import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 別プロセス同士のレースを**決定的に**組むためのファイルバリア。
 *
 * 壁時計（`Date.now() + 2000` で申し合わせる方式）をやめるために作った。
 * 壁時計だと「その時刻までに子の準備が終わっている」ことを祈るだけなので、
 * 遅い環境では片方の子が DB open や service 構築の途中で解放時刻を過ぎ、
 * 意図した競合窓と違う場所で衝突する。待ち時間を伸ばしても確率が下がるだけで
 * 消えないうえ、テストは遅くなる。
 *
 * ここでは「準備完了を子が申告し、全員そろってから親が解放する」ことで、
 * **解放の瞬間に全員が同じ地点に立っている**ことを保証する。
 * 順序を固定したい場合は、親が解放する順番と `await` で決める。
 */

/** 子が同期的に眠るための待機。busy-spin は 2〜3 コアの CI/VPS で相手を圧迫するので使わない */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function createBarrier(dir: string): string {
  const barrierDir = join(dir, "barrier");
  mkdirSync(barrierDir, { recursive: true });
  return barrierDir;
}

const readyPath = (barrierDir: string, name: string) => join(barrierDir, `ready-${name}`);
const releasePath = (barrierDir: string, name: string) => join(barrierDir, `release-${name}`);

// ── 子プロセス側 ───────────────────────────────────────────

/**
 * 準備完了を申告して、親の解放を待つ（同期）。
 * **DB open・service 構築・事前読み込みを全て終えてから**呼ぶこと。
 * ここより後に重い初期化を残すと、バリアの意味が無くなる。
 */
export function barrierReadyAndWait(barrierDir: string, name: string, timeoutMs = 30_000): void {
  writeFileSync(readyPath(barrierDir, name), "ready");
  const release = releasePath(barrierDir, name);
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(release)) {
    if (Date.now() > deadline) throw new Error(`barrier timeout: ${name} was never released`);
    sleepSync(1);
  }
}

// ── 親プロセス側 ───────────────────────────────────────────

/** 指定した子が全員 ready を出すまで待つ */
export async function waitAllReady(barrierDir: string, names: readonly string[], timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (names.every((name) => existsSync(readyPath(barrierDir, name)))) return;
    if (Date.now() > deadline) {
      const seen = readdirSync(barrierDir).join(", ");
      throw new Error(`barrier timeout: ready was not signalled by all of [${names.join(", ")}] (saw: ${seen})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/**
 * 解放する。複数名を渡すと**同時**に解放する＝真の競合。
 * 順序を固定したいときは1名ずつ呼び、間で対象の完了を `await` する。
 */
export function release(barrierDir: string, ...names: readonly string[]): void {
  for (const name of names) writeFileSync(releasePath(barrierDir, name), "go");
}
