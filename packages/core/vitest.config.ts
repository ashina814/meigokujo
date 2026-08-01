import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 賭場のRTPシミュレーション（数万回の試行）と、別プロセスを起こす競合テストがあるため、
    // 既定の5秒では同時実行時にCPUを取り合って落ちることがある。処理そのものは数秒で終わる。
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
