import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PANEL_KINDS,
  installablePanelChoices,
  removablePanelChoices,
  retiredPanelChoices,
} from "../src/commands/panel-kinds.js";
import { panelCommand, panelRemoveCommand } from "../src/commands/bank-panel.js";

/**
 * パネル種別の3経路（実装の描画 / `/パネル設置` / `/管理 → パネル`）が
 * 単一の表から生成されていることを固定する。
 *
 * かつて3箇所を手書きしていてドリフトし、`confession` が `/パネル設置` から選べず、
 * `shop_admin` はどの導線からも設置できないのに更新処理だけ生きていた。
 */
describe("パネル種別は単一の表から生成される", () => {
  const choiceValues = (cmd: typeof panelCommand) => {
    const json = cmd.toJSON();
    const opt = json.options?.find((o) => o.name === "種別") as { choices?: Array<{ value: string }> } | undefined;
    return (opt?.choices ?? []).map((c) => c.value);
  };

  it("/パネル設置 の選択肢が installable と一致する", () => {
    expect(choiceValues(panelCommand)).toEqual(installablePanelChoices().map((c) => c.value));
  });

  it("/パネル撤去 の選択肢が installable + 廃止済み と一致する", () => {
    expect(choiceValues(panelRemoveCommand)).toEqual(removablePanelChoices().map((c) => c.value));
  });

  it("描画マップが表の全 key を網羅する", () => {
    const source = readFileSync(new URL("../src/commands/bank-panel.ts", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("const PANEL_MESSAGES"), source.indexOf("export const panelCommand"));
    for (const { key } of PANEL_KINDS) {
      expect(body, `${key} の描画が無い`).toContain(`${key}:`);
    }
  });

  it("かつて落ちていた種別が設置経路に載っている", () => {
    const installable = installablePanelChoices().map((c) => c.value);
    // confession は /パネル設置 から選べなかった
    expect(installable).toContain("confession");
    // shop_admin はどの導線からも設置できなかった
    expect(installable).toContain("shop_admin");
  });

  it("廃止済み種別は設置できず撤去だけできる", () => {
    const installable = installablePanelChoices().map((c) => c.value);
    const removable = removablePanelChoices().map((c) => c.value);
    for (const { value } of retiredPanelChoices()) {
      expect(installable, `${value} が設置できてしまう`).not.toContain(value);
      expect(removable, `${value} が撤去できない`).toContain(value);
    }
    expect(retiredPanelChoices().map((c) => c.value)).toEqual(["entry_flex"]);
  });
});
