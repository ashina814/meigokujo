import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // config.ts が import 時に必須 env を要求するため、テスト本体より先に埋める
    setupFiles: ["./tests/setup-env.ts"],
  },
});
