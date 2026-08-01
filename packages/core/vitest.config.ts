import { defineConfig } from "vitest/config";

/**
 * 通常のテスト。
 *
 * 別プロセスを5つ同時に起こす競合テスト（`*.serial.test.ts`）はここから外し、
 * `vitest.serial.config.ts` で**単独・直列**に走らせる。
 * 他のテストと並行に走ると CPU を取り合い、子プロセスの起動が遅れて
 * 「同じ瞬間に叩く」という前提が崩れ、まれに落ちるため。
 */
export default defineConfig({
  test: {
    // 賭場のRTPシミュレーション（数万回の試行）があるため、既定の5秒では足りない
    testTimeout: 30_000,
    hookTimeout: 30_000,
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.serial.test.ts"],
  },
});
