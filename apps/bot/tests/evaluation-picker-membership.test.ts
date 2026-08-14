import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../src/commands/evaluation.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

describe("evaluation picker membership UX", () => {
  it("常設入口は1択selectではなく何度でも押せるbutton", () => {
    const panelStart = source.indexOf("function panelRow");
    const panelEnd = source.indexOf("export async function handleEvaluationCommand", panelStart);
    const panel = source.slice(panelStart, panelEnd);
    expect(panel).toContain("ActionRowBuilder<ButtonBuilder>");
    expect(panel).toContain('setCustomId("eval:open")');
    expect(panel).toContain('setLabel("評価する亡霊を選択")');
    expect(panel).not.toContain("StringSelectMenuBuilder");
    expect(indexSource).toContain('interaction.customId === "eval:open"');
    expect(indexSource).toContain("handleEvaluationButton(interaction, services)");
  });

  it("DB評価中とGuild在籍の積集合だけを表示しIDへフォールバックしない", () => {
    expect(source).toContain("const members = await guild.members.fetch();");
    expect(source).toContain("memberIds.has(cycle.userId)");
    expect(source).toContain("member.displayName.slice(0, 100)");
    expect(source).not.toContain("member?.displayName ?? cycle.userId");
    expect(source).toContain("メンバー一覧の取得に失敗しました。もう一度押してください。");
  });

  it("選択確定時も在籍を再確認し、成功後に残り一覧を消さない", () => {
    expect(source).toContain("if (!menus.memberIds.has(targetId))");
    expect(source).toContain("現在サーバーに在籍していないため、評価対象一覧から外れました");
    expect(source).toContain("**続けて別の亡霊も選択できます。**");
    expect(source).toContain("components: menus.rows");
    expect(source).toContain("if (!member) return null;");
    expect(source).not.toContain('name: threadTitleFor(member?.displayName ?? targetId)');
  });
});
