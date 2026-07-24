import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { confessionPanelMessage } from "../src/commands/confession.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(testDir, "../src/commands/confession.ts"), "utf8");

describe("トートの耳・返信不要案件の専用クローズ", () => {
  it("利用者向けの返信元表記を冥教会へ統一する", () => {
    const panel = confessionPanelMessage();
    const firstEmbed = panel.embeds?.[0];
    const json = firstEmbed && typeof firstEmbed === "object" && "toJSON" in firstEmbed
      ? (firstEmbed as { toJSON: () => { description?: string } }).toJSON()
      : (firstEmbed as { description?: string } | undefined);

    expect(json?.description).toContain("冥教会から返信がある場合は");
    expect(json?.description).not.toContain("運営から返信がある場合は");
    expect(source).toContain("② 冥教会からの返信を希望する？");
    expect(source).toContain("— 冥教会より");
  });

  it("返信不要案件だけに受領確認ボタンを追加し、押下時にも条件を再検証する", () => {
    expect(source).toContain('row.reply_wish === "no"');
    expect(source).toContain("mimi:voice_received:${id}");
    expect(source).toContain('row.reply_wish !== "no"');
    expect(source).toContain('VOICE_RECEIVED_REASON as CloseReason');
  });

  it("専用DMで受領を伝えて静かに閉じる", () => {
    expect(source).toContain("あなたの声は、たしかに届きました。");
    expect(source).toContain("返信は不要とのことでしたので、この件はここでそっと閉じます。");
    expect(source).toContain("伝えてくれて、ありがとう。");
  });
});
