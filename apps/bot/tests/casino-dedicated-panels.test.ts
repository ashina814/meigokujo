import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const srcOf = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("賭場の常設パネルを用途別に分離する", () => {
  it("遊ぶ・みんなで勝負・競馬・板を独立した panel kind として設置できる", () => {
    const kinds = srcOf("../src/commands/panel-kinds.ts");
    expect(kinds).toContain('{ key: "casino_games", label: "賭場 · 遊ぶ", installable: true }');
    expect(kinds).toContain('{ key: "casino_pvp", label: "賭場 · みんなで勝負", installable: true }');
    expect(kinds).toContain('{ key: "casino_keiba", label: "賭場 · 競馬", installable: true }');
    expect(kinds).toContain('{ key: "casino_ita", label: "賭場 · 板", installable: true }');
  });

  it("旧 casino_games は混合パネルではなく、基本ゲーム専用 renderer を使う", () => {
    const bank = srcOf("../src/commands/bank-panel.ts");
    expect(bank).toContain("casino_games: (s) => casinoSoloPanelMessage(s)");
    expect(bank).not.toContain("casino_games: (s) => casinoGamesPanelMessage(s)");
    expect(bank).toContain("casino_pvp: (s) => casinoPvpPanelMessage(s)");
    expect(bank).toContain("casino_keiba: (s) => casinoKeibaPanelMessage(s)");
    expect(bank).toContain("casino_ita: (s) => casinoItaPanelMessage(s)");
  });

  it("遊ぶパネルはルーレットだけ公開卓であることを明示する", () => {
    const panels = srcOf("../src/commands/casino-dedicated-panels.ts");
    expect(panels).toContain('setTitle("🎲  遊ぶ")');
    expect(panels).toContain("ルーレットだけは30秒間みんなが参加できる公開卓");
  });

  it("各専用パネルは既存の実処理へ直接つながる", () => {
    const panels = srcOf("../src/commands/casino-dedicated-panels.ts");
    expect(panels).toContain('setCustomId("casino:home:games")');
    expect(panels).toContain('setCustomId("casino:home:pvp")');
    expect(panels).toContain('setCustomId("casino:home:keiba")');
    expect(panels).toContain('setCustomId("casino:home:ita")');
  });
});

describe("みんなで勝負の募集ロール通知", () => {
  it("運営のロール設定に募集通知スロットを持ち、最大5ロールへ丸める", () => {
    const roles = srcOf("../src/church-roles.ts");
    expect(roles).toContain('| "casino_pvp_notify"');
    expect(roles).toContain('label: "みんなで勝負 募集通知ロール"');
    expect(roles).toContain("最大5ロールまで設定可");
    expect(roles).toContain('slot === "casino_pvp_notify" ? 5 : null');
    expect(roles).toContain('"casino_pvp_notify",');
  });

  it("公開募集時に設定ロールを取得し、募集者単位の通知CDを通したIDだけallowedMentionsへ渡す", () => {
    const open = srcOf("../src/casino/pvp-open-ui.ts");
    const card = srcOf("../src/casino/pvp-card.ts");
    expect(open).toContain('mentionRoleIds: getRoleIds(services, "casino_pvp_notify")');
    expect(card).toContain("mentionRoleIds?: string[]");
    expect(card).toContain("takePvpNotifyRoleIds(input.challengerId, input.mentionRoleIds ?? [])");
    expect(card).toContain("allowedMentions: { roles: mentionRoleIds }");
    expect(card).toContain('mentionRoleIds.map((roleId) => `<@&${roleId}>`).join(" ")');
  });
});
