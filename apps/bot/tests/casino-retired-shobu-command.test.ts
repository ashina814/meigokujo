import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildRegistrationPayload } from "../src/commands/slash-command-registration.js";

/**
 * `/勝負` は 2026-08-17 に利用者向け slash command から退役。
 *
 * 現在の公開対人入口は `賭場 · みんなで勝負` 常設パネルを正本にする。
 * 指名対戦を将来追加する可能性はあるため、対人ゲーム本体はこの退役で削除しない。
 */
describe("退役した /勝負 を再登録しない", () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

  it("Discord command registration に /勝負 を含めない", () => {
    expect(buildRegistrationPayload().map(({ name }) => name)).not.toContain("勝負");
  });

  it("現在の公開対人入口は専用常設パネルにある", () => {
    const panel = read("../src/commands/casino-dedicated-panels.ts");
    expect(panel).toContain('setCustomId("casino:home:pvp")');
    expect(panel).toContain("みんなで勝負");
  });

  it("将来の指名対戦で再利用できる対人ゲーム本体は削除しない", () => {
    for (const rel of [
      "../src/casino/chinchiro-duel.ts",
      "../src/casino/bj-duel.ts",
      "../src/casino/sashi.ts",
      "../src/casino/indian.ts",
      "../src/casino/poker-duel.ts",
      "../src/casino/chohan-multi.ts",
    ]) {
      expect(existsSync(new URL(rel, import.meta.url)), `${rel} が削除されている`).toBe(true);
    }
  });
});
