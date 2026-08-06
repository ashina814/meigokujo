import { describe, expect, it, vi } from "vitest";
import type { Interaction } from "discord.js";
import type { Services } from "../src/services.js";
import { denyIfCasinoClosed, isCasinoInteraction } from "../src/casino/gate.js";

/**
 * 賭場が停止しているあいだ、チップが動きうる操作をひとつも通さないこと。
 * 読むだけの導線と運営卓は止めない（止めると原因調査も復旧もできなくなる）。
 * イベントLand板はチップ賭場とは別経済なので、正式開業前でも止めない。
 */
function fakeServices(deny: string | null, phase: "pre_reset" | "formal" | "unknown" = "formal"): Services {
  return { casinoStatus: { denyMessage: () => deny }, chipTx: { openingPhase: () => phase } } as unknown as Services;
}

function command(name: string, subcommand: string | null = null): Interaction & { reply: ReturnType<typeof vi.fn> } {
  return {
    isChatInputCommand: () => true,
    commandName: name,
    options: { getSubcommand: vi.fn().mockReturnValue(subcommand) },
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Interaction & { reply: ReturnType<typeof vi.fn> };
}

function component(customId: string): Interaction & { reply: ReturnType<typeof vi.fn> } {
  return {
    isChatInputCommand: () => false,
    customId,
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Interaction & { reply: ReturnType<typeof vi.fn> };
}

describe("賭場の入口ガード", () => {
  it("チップが動く操作を対象にし、読むだけの導線とイベントLand板は対象にしない", () => {
    for (const name of ["遊ぶ", "勝負", "福分け", "賭場商店", "株", "競馬", "vip", "流れ星"]) {
      expect(isCasinoInteraction(command(name))).toBe(true);
    }
    // `/板` はサブコマンド単位で判定する。未知・欠落はfail-closed。
    expect(isCasinoInteraction(command("板", "立てる"))).toBe(true);
    expect(isCasinoInteraction(command("板", "イベント立てる"))).toBe(false);
    expect(isCasinoInteraction(command("板", "一覧"))).toBe(false);
    expect(isCasinoInteraction(command("板", "将来追加された未知操作"))).toBe(true);
    expect(isCasinoInteraction(command("板"))).toBe(true);

    for (const name of ["管理", "案内", "賭場番付", "通行証", "あそびかた", "プロフィール"]) {
      expect(isCasinoInteraction(command(name))).toBe(false);
    }
    // 賭場系の customId 接頭辞は全部（対人戦・再戦オファーを含む）
    for (const id of [
      "ether:buy", "bakuten:buy", "stocks:buy", "vip:join", "ita:bet",
      "rl:red", "slots:retry:50", "chinchiro:stop", "keiba:bet", "crash:cashout",
      "chohan:cho", "chm:join", "bj:hit", "holdem:call", "poker:hold:1", "pkr:join",
      "bjd:accept", "ccd:accept", "ind:call", "sashi:accept", "rem:12345",
    ]) {
      expect(isCasinoInteraction(component(id))).toBe(true);
    }
    // イベントLand板は `itaevt:` という別namespaceで、チップ賭場の停止対象ではない。
    for (const id of ["itaevt:bet:1", "itaevt:close:1", "itaevt:settle:1:0", "itaevt:void:1"]) {
      expect(isCasinoInteraction(component(id))).toBe(false);
    }
    // 運営卓は入口では止めない（停止中の資金操作は運営卓のハンドラと資金層で断る）
    for (const id of ["mgmt:casino:fund", "ticket:close", "entry:apply", "rank:next"]) {
      expect(isCasinoInteraction(component(id))).toBe(false);
    }
  });

  it("営業中は素通りする", async () => {
    const services = fakeServices(null);
    const i = command("遊ぶ");
    expect(await denyIfCasinoClosed(i, services)).toBe(false);
    expect(i.reply).not.toHaveBeenCalled();
  });

  it("停止中は理由付きで断り、処理を通さない", async () => {
    const services = fakeServices("賭場は帳簿の食い違いで閉めている。\n（理由: 検算A(記録と残高)）");
    const i = command("遊ぶ");

    expect(await denyIfCasinoClosed(i, services)).toBe(true);
    expect(i.reply).toHaveBeenCalledTimes(1);
    const arg = i.reply.mock.calls[0]![0] as { content: string };
    expect(arg.content).toContain("検算A");
    expect(arg.content).toContain("帳簿の食い違い");
  });

  it("停止中でも賭場以外の操作は素通りする", async () => {
    const services = fakeServices("賭場は改装中だ。");
    const admin = command("管理");
    expect(await denyIfCasinoClosed(admin, services)).toBe(false);
    expect(admin.reply).not.toHaveBeenCalled();
  });

  it("応答に失敗しても処理は通さない", async () => {
    const services = fakeServices("賭場は改装中だ。");
    const i = command("遊ぶ");
    i.reply.mockRejectedValue(new Error("interaction expired"));
    expect(await denyIfCasinoClosed(i, services)).toBe(true);
  });

  // PR8監査・項目8: 稼働状態が open でも、正式開業初期化が終わるまでチップ資金は動かせない
  it("正式開業前は open でもチップ操作を専用の文面で断る", async () => {
    const services = fakeServices(null, "pre_reset");
    for (const i of [command("遊ぶ"), command("板", "立てる"), component("ether:buy"), component("slots:retry:50")]) {
      expect(await denyIfCasinoClosed(i, services)).toBe(true);
      const arg = i.reply.mock.calls[0]![0] as { content: string };
      expect(arg.content).toContain("正式開業準備中");
      expect(arg.content).toContain("既存残高は保持されています");
      // generic な失敗文言へ落としていないこと
      expect(arg.content).not.toContain("処理に失敗");
      expect(arg.content).not.toContain("営業中");
    }
  });

  it("正式開業前でもイベントLand板と板一覧は素通りする", async () => {
    const services = fakeServices(null, "pre_reset");
    for (const i of [
      command("板", "イベント立てる"),
      command("板", "一覧"),
      component("itaevt:bet:1"),
      component("itaevt:close:1"),
    ]) {
      expect(await denyIfCasinoClosed(i, services)).toBe(false);
      expect(i.reply).not.toHaveBeenCalled();
    }
  });

  it("未知版では異常であることを明示してチップ操作を止める", async () => {
    const services = fakeServices(null, "unknown");
    const i = command("遊ぶ");
    expect(await denyIfCasinoClosed(i, services)).toBe(true);
    const arg = i.reply.mock.calls[0]![0] as { content: string };
    expect(arg.content).toContain("版が異常");
  });

  it("正式開業前でも読むだけの導線と運営卓は素通りする", async () => {
    const services = fakeServices(null, "pre_reset");
    for (const i of [command("案内"), command("管理"), command("賭場番付")]) {
      expect(await denyIfCasinoClosed(i, services)).toBe(false);
      expect(i.reply).not.toHaveBeenCalled();
    }
  });

  it("停止理由がある場合は、そちらを優先して見せる", async () => {
    const services = fakeServices("賭場は改装中だ。", "pre_reset");
    const i = command("遊ぶ");
    expect(await denyIfCasinoClosed(i, services)).toBe(true);
    const arg = i.reply.mock.calls[0]![0] as { content: string };
    expect(arg.content).toContain("改装中");
  });
});
