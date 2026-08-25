import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildRegistrationPayload } from "../src/commands/slash-command-registration.js";

/**
 * 賭場の利用者向け入口は `/賭場` に集約する。
 *
 * 個別機能はハブから到達できるため、重複する slash command は登録しない。
 * 実装本体・handler は既存メッセージや将来の再利用のため削除しない。
 */
describe("賭場の重複 shortcut slash commands を登録しない", () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
  const registrationNames = () => buildRegistrationPayload().map(({ name }) => name);

  it("退役対象8コマンドを Discord command registration に含めない", () => {
    for (const name of ["遊ぶ", "福分け", "賭場番付", "賭場商店", "競馬", "案内", "vip", "流れ星"])
      expect(registrationNames()).not.toContain(name);
  });

  it("正本の /賭場 と残す /通行証・/板 は登録したまま", () => {
    expect(registrationNames()).toEqual(expect.arrayContaining(["賭場", "通行証", "板"]));
  });

  it("退役した個別入口の機能は /賭場 ハブから到達できる", () => {
    const home = read("../src/commands/casino-home.ts");
    for (const customId of [
      "casino:home:games",
      "casino:daily:claim",
      "casino:home:banzuke",
      "casino:home:shop",
      "casino:home:keiba",
      "casino:home:vip",
      "casino:home:hoshi",
    ]) {
      expect(home).toContain(customId);
    }
  });

  it("内部実装は削除しない", () => {
    for (const rel of [
      "../src/commands/asobu.ts",
      "../src/commands/daily.ts",
      "../src/commands/banzuke.ts",
      "../src/commands/bakuten.ts",
      "../src/commands/keiba.ts",
      "../src/commands/annai.ts",
      "../src/commands/vip.ts",
      "../src/commands/nagareboshi.ts",
    ]) {
      expect(existsSync(new URL(rel, import.meta.url)), `${rel} が削除されている`).toBe(true);
    }
  });

  it("住人向け案内は旧 /案内 ではなく /賭場 を示す", () => {
    const help = read("../src/commands/help.ts");
    expect(help).toContain("マモンの賭場全体は `/賭場` から");
    expect(help).not.toContain("マモンの賭場全体は `/案内` から");
  });
});
