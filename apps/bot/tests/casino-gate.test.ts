import { describe, expect, it, vi } from "vitest";
import type { Interaction } from "discord.js";
import type { Services } from "../src/services.js";
import { denyIfCasinoClosed, isCasinoInteraction } from "../src/casino/gate.js";

/**
 * 賭場が停止しているあいだ、チップが動きうる操作をひとつも通さないこと。
 * 読むだけの導線と運営卓は止めない（止めると原因調査も復旧もできなくなる）。
 */
function fakeServices(deny: string | null): Services {
  return { casinoStatus: { denyMessage: () => deny } } as unknown as Services;
}

function command(name: string): Interaction & { reply: ReturnType<typeof vi.fn> } {
  return {
    isChatInputCommand: () => true,
    commandName: name,
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
  it("チップが動く操作を対象にし、読むだけの導線と運営卓は対象にしない", () => {
    for (const name of ["遊ぶ", "勝負", "福分け", "賭場商店", "株", "競馬", "vip", "流れ星", "板"]) {
      expect(isCasinoInteraction(command(name))).toBe(true);
    }
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
});
