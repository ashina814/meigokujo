import { describe, expect, it } from "vitest";

/**
 * /管理 ハブの並びが Discord の制約を守っているか。
 *
 * ActionRow は**1行5個まで**で、6個目を足した瞬間にメッセージの構築が落ちる。
 * 型では防げず、ボタンを1つ足すだけで `/管理` 全体が開かなくなるので、
 * 実際に構築して数える。回収ボタンを足したときに実際これを踏んだ。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";

const hubModule = import("../src/commands/admin-hub.js");

describe("/管理 ハブの構成", () => {
  it("どの行も5個を超えない（超えると描画自体が落ちる）", async () => {
    const { renderHub } = await hubModule;
    const hub = renderHub();
    expect(hub.components.length).toBeGreaterThan(0);
    for (const row of hub.components) {
      expect(row.components.length).toBeLessThanOrEqual(5);
      expect(row.components.length).toBeGreaterThan(0);
    }
  });

  it("JSONへ変換できる（discord.js のバリデーションを通る）", async () => {
    const { renderHub } = await hubModule;
    const hub = renderHub();
    expect(() => hub.components.map((row) => row.toJSON())).not.toThrow();
  });

  it("回収の導線が出ている", async () => {
    const { renderHub } = await hubModule;
    const ids = renderHub()
      .components.flatMap((row) => row.toJSON().components)
      .map((c) => (c as { custom_id?: string }).custom_id);
    expect(ids).toContain("mgmt:recover");
  });
});
