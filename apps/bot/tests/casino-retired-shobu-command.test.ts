import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `/勝負` は 2026-08-17 に利用者向け slash command から退役。
 *
 * 現在の対人入口は `/賭場` → 「みんなで勝負」の公開募集を正本にする。
 * 指名対戦を将来追加する可能性はあるため、対人ゲーム本体はこの退役で削除しない。
 */
describe("退役した /勝負 を再登録しない", () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

  it("Discord command registration に /勝負 を含めない", () => {
    const source = read("../src/register-commands.ts");
    expect(source).not.toContain('from "./commands/shobu.js"');
    expect(source).not.toContain("shobuCommand.toJSON()");
  });

  it("現在の公開対人入口は /賭場 側に残る", () => {
    const home = read("../src/commands/casino-home.ts");
    expect(home).toContain('setCustomId("casino:home:pvp")');
    expect(home).toContain("みんなで勝負");
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
