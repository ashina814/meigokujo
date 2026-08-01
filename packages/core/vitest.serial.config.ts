import { defineConfig } from "vitest/config";

/**
 * 重い競合テスト専用。**単独プロセス・直列**で走らせる。
 *
 * `casino-chip-tx-concurrency.serial.test.ts` は本番コードを別プロセスで5つ起こし、
 * 「同じ瞬間に同じ group_key を叩く」ことを確かめる。他のテストと並行に走ると
 * CPU を取り合って起動が遅れ、競合そのものが再現しなくなる（＝まれに落ちる）。
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.serial.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
