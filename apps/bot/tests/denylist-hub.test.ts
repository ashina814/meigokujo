import { describe, expect, it, vi } from "vitest";
import { EventLog, Nicknames, Settings, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import type { Services } from "../src/services.js";

/**
 * 禁止語の管理UI。
 *
 * 語彙はコードに持たず運営が入れる。判定は**部分一致だけ**（正規表現なし）。
 * 追加時に「登録済みの名前が何件当たるか」を出すのは、短い語で関係ない人まで
 * 巻き込むのを気づけるようにするため。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const hubModule = import("../src/commands/denylist-hub.js");
const ADMIN = "900000000000000001";

function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const nicknames = new Nicknames(db, events);
  const services = { db, settings: new Settings(db), events, nicknames } as unknown as Services;
  return { db, events, nicknames, services };
}

let modalSeq = 0;
function modal(action: "reject" | "flag", pattern: string, note = "", userId = ADMIN) {
  const reply = vi.fn(async () => undefined);
  const id = `int-${++modalSeq}`;
  return {
    id,
    interaction: {
      id,
      customId: `mgmt:denyword:save:${action}`,
      user: { id: userId },
      fields: { getTextInputValue: (f: string) => (f === "pattern" ? pattern : note) },
      reply,
    } as never,
    reply,
  };
}

/** 確認画面のボタンから、その画面に紐づく鍵を取り出す */
function tokenOf(reply: ReturnType<typeof vi.fn>): string {
  const payload = (reply.mock.calls.at(-1) as never[])[0] as {
    components: { toJSON(): { components: { custom_id: string }[] } }[];
  };
  return payload.components.flatMap((r) => r.toJSON().components)[0]!.custom_id.split(":")[3]!;
}

function press(customId: string, userId = ADMIN) {
  const update = vi.fn(async () => undefined);
  return { interaction: { customId, user: { id: userId }, update } as never, update };
}

const contentOf = (fn: ReturnType<typeof vi.fn>) => String((fn.mock.calls.at(-1) as never[])[0]?.content ?? "");
const descOf = (payload: { embeds: { data: { description: string } }[] }) => payload.embeds[0]!.data.description;

describe("一覧", () => {
  it("語が無ければ「なし」と出る", async () => {
    const { denylistHome } = await hubModule;
    const ctx = setup();

    const home = denylistHome(ctx.services) as never as { embeds: { data: { description: string } }[]; components: unknown[] };

    expect(descOf(home)).toContain("拒否 0件");
    expect(descOf(home)).toContain("要確認 0件");
    expect(home.components).toHaveLength(2); // 追加ボタン + 戻る（削除セレクトは出さない）
    ctx.db.close();
  });

  it("拒否と要確認を分けて出し、当たる名前の件数も出す", async () => {
    const { denylistHome } = await hubModule;
    const ctx = setup();
    ctx.nicknames.importLegacy(
      [
        { userId: "u1", nickname: "ばつことば" },
        { userId: "u2", nickname: "ふつう" },
      ],
      "staff",
    );
    ctx.nicknames.addDenyWord("ばつ", "staff", { action: "reject", note: "メモ" });
    ctx.nicknames.addDenyWord("ようかくにん", "staff", { action: "flag" });

    const home = denylistHome(ctx.services) as never as { embeds: { data: { description: string } }[]; components: unknown[] };

    expect(descOf(home)).toContain("拒否 1件");
    expect(descOf(home)).toContain("要確認 1件");
    expect(descOf(home)).toContain("登録済みの名前 1件に一致"); // ばつことば が当たる
    expect(descOf(home)).toContain("メモ");
    expect(home.components).toHaveLength(3); // 追加 + 削除セレクト + 戻る
    ctx.db.close();
  });
});

describe("追加", () => {
  it("拒否語を追加できる", async () => {
    const { handleDenywordModal } = await hubModule;
    const ctx = setup();
    const m = modal("reject", "ばつ");

    await handleDenywordModal(m.interaction, ctx.services);

    expect(ctx.nicknames.listDenyWords()).toEqual([{ pattern: "ばつ", action: "reject", note: null }]);
    expect(contentOf(m.reply)).toContain("拒否");
    ctx.db.close();
  });

  it("要確認語を追加できる", async () => {
    const { handleDenywordModal } = await hubModule;
    const ctx = setup();

    await handleDenywordModal(modal("flag", "あやしい", "様子見").interaction, ctx.services);

    expect(ctx.nicknames.listDenyWords()).toEqual([{ pattern: "あやしい", action: "flag", note: "様子見" }]);
    ctx.db.close();
  });

  it("**正規化して保存する**（全角・大文字で二重登録されない）", async () => {
    const { handleDenywordModal } = await hubModule;
    const ctx = setup();
    const m = modal("reject", "ＮＧ");

    await handleDenywordModal(m.interaction, ctx.services);

    expect(ctx.nicknames.listDenyWords()[0]!.pattern).toBe("ng");
    expect(contentOf(m.reply)).toContain("正規化");
    // 同じ語を別表記で入れても増えない
    await handleDenywordModal(modal("reject", "ng").interaction, ctx.services);
    expect(ctx.nicknames.listDenyWords()).toHaveLength(1);
    ctx.db.close();
  });

  it("**既存の名前に当たる語は、確認するまで保存しない**", async () => {
    const { handleDenywordModal } = await hubModule;
    const ctx = setup();
    ctx.nicknames.importLegacy(
      [
        { userId: "u1", nickname: "あかり" },
        { userId: "u2", nickname: "あかつき" },
        { userId: "u3", nickname: "ほのか" },
      ],
      "staff",
    );
    const m = modal("reject", "あか");

    await handleDenywordModal(m.interaction, ctx.services);

    expect(ctx.nicknames.listDenyWords()).toHaveLength(0); // まだ入れていない
    expect(contentOf(m.reply)).toContain("2件");
    expect(contentOf(m.reply)).toContain("まだ登録していません");
    ctx.db.close();
  });

  it("確認ボタンを押して初めて保存される", async () => {
    const { handleDenywordModal, handleDenywordButton } = await hubModule;
    const ctx = setup();
    ctx.nicknames.importLegacy([{ userId: "u1", nickname: "あかり" }], "staff");
    const m = modal("reject", "あか");
    await handleDenywordModal(m.interaction, ctx.services);
    const p = press(`mgmt:denyword:confirm:${tokenOf(m.reply)}`);

    await handleDenywordButton(p.interaction, ctx.services);

    expect(ctx.nicknames.listDenyWords()).toEqual([{ pattern: "あか", action: "reject", note: null }]);
    expect(String((p.update.mock.calls.at(-1) as never[])[0]?.content)).toContain("登録しました");
    ctx.db.close();
  });

  it("やめるを押したら保存しない", async () => {
    const { handleDenywordModal, handleDenywordButton } = await hubModule;
    const ctx = setup();
    ctx.nicknames.importLegacy([{ userId: "u1", nickname: "あかり" }], "staff");
    const m = modal("reject", "あか");
    await handleDenywordModal(m.interaction, ctx.services);
    const token = tokenOf(m.reply);

    await handleDenywordButton(press(`mgmt:denyword:cancel:${token}`).interaction, ctx.services);

    expect(ctx.nicknames.listDenyWords()).toHaveLength(0);
    // 確認が消えているので、同じボタンを押しても入らない
    await handleDenywordButton(press(`mgmt:denyword:confirm:${token}`).interaction, ctx.services);
    expect(ctx.nicknames.listDenyWords()).toHaveLength(0);
    ctx.db.close();
  });

  it("**誰にも当たらない語は確認なしで保存する**", async () => {
    const { handleDenywordModal } = await hubModule;
    const ctx = setup();
    ctx.nicknames.importLegacy([{ userId: "u1", nickname: "ほのか" }], "staff");
    const m = modal("reject", "まったくべつ");

    await handleDenywordModal(m.interaction, ctx.services);

    expect(ctx.nicknames.listDenyWords()).toHaveLength(1);
    expect(contentOf(m.reply)).toContain("登録しました");
    ctx.db.close();
  });

  it("空の語は登録しない", async () => {
    const { handleDenywordModal } = await hubModule;
    const ctx = setup();
    const m = modal("reject", "   ");

    await handleDenywordModal(m.interaction, ctx.services);

    expect(ctx.nicknames.listDenyWords()).toHaveLength(0);
    expect(contentOf(m.reply)).toContain("空");
    ctx.db.close();
  });
});

describe("削除", () => {
  it("選んだ語を消し、一覧を更新する", async () => {
    const { handleDenywordRemove } = await hubModule;
    const ctx = setup();
    ctx.nicknames.addDenyWord("ばつ", "staff", { action: "reject" });
    const update = vi.fn(async () => undefined);
    const followUp = vi.fn(async () => undefined);

    await handleDenywordRemove(
      { customId: "mgmt:denyword:remove", values: ["ばつ"], user: { id: ADMIN }, update, followUp } as never,
      ctx.services,
    );

    expect(ctx.nicknames.listDenyWords()).toHaveLength(0);
    expect(update).toHaveBeenCalled();
    expect(String((followUp.mock.calls.at(-1) as never[])[0]?.content)).toContain("削除");
    ctx.db.close();
  });
});

describe("要確認語を足したときの承認の扱い", () => {
  it("**門番が見ていない語を足したら、承認済みの名前も確認へ戻る**", async () => {
    const { handleDenywordModal } = await hubModule;
    const ctx = setup();
    ctx.nicknames.addDenyWord("あやしい", "staff", { action: "flag" });
    ctx.nicknames.claim({ userId: "u1", nickname: "あやしいことば", setVia: "entry", actor: "t" });
    ctx.nicknames.approveFlagged("u1", "user:judge");
    expect(ctx.nicknames.status("u1").kind).toBe("ok");

    // UI から新しい要確認語を足す。既存の名前に当たるので確認を挟む
    const { handleDenywordButton } = await hubModule;
    const m = modal("flag", "ことば");
    await handleDenywordModal(m.interaction, ctx.services);
    expect(contentOf(m.reply)).toContain("まだ登録していません");
    expect(ctx.nicknames.status("u1").kind).toBe("ok"); // 確認前は何も変わらない

    await handleDenywordButton(press(`mgmt:denyword:confirm:${tokenOf(m.reply)}`).interaction, ctx.services);

    expect(ctx.nicknames.status("u1").kind).toBe("review");
    ctx.db.close();
  });

  it("当たらない語を足しても、承認は生きたまま", async () => {
    const { handleDenywordModal } = await hubModule;
    const ctx = setup();
    ctx.nicknames.addDenyWord("あやしい", "staff", { action: "flag" });
    ctx.nicknames.claim({ userId: "u1", nickname: "あやしいことば", setVia: "entry", actor: "t" });
    ctx.nicknames.approveFlagged("u1", "user:judge");

    await handleDenywordModal(modal("flag", "まったくべつ").interaction, ctx.services);

    expect(ctx.nicknames.status("u1").kind).toBe("ok");
    ctx.db.close();
  });
});

describe("確認画面と中身の紐づけ", () => {
  /** 同じ管理者が確認待ちを2件（A→B）作る */
  async function twoPending(ctx: ReturnType<typeof setup>) {
    const { handleDenywordModal } = await hubModule;
    ctx.nicknames.importLegacy(
      [
        { userId: "u1", nickname: "あかり" },
        { userId: "u2", nickname: "ほのか" },
      ],
      "staff",
    );
    const a = modal("reject", "あか");
    await handleDenywordModal(a.interaction, ctx.services);
    const b = modal("reject", "ほの");
    await handleDenywordModal(b.interaction, ctx.services);
    expect(ctx.nicknames.listDenyWords()).toHaveLength(0);
    return { tokenA: tokenOf(a.reply), tokenB: tokenOf(b.reply) };
  }

  it("**AのconfirmはAだけを登録する**（新しいBを確定しない）", async () => {
    const { handleDenywordButton } = await hubModule;
    const ctx = setup();
    const { tokenA } = await twoPending(ctx);

    await handleDenywordButton(press(`mgmt:denyword:confirm:${tokenA}`).interaction, ctx.services);

    expect(ctx.nicknames.listDenyWords().map((w) => w.pattern)).toEqual(["あか"]);
    ctx.db.close();
  });

  it("**AのcancelはBを消さない**（Bはそのまま確定できる）", async () => {
    const { handleDenywordButton } = await hubModule;
    const ctx = setup();
    const { tokenA, tokenB } = await twoPending(ctx);

    await handleDenywordButton(press(`mgmt:denyword:cancel:${tokenA}`).interaction, ctx.services);
    await handleDenywordButton(press(`mgmt:denyword:confirm:${tokenB}`).interaction, ctx.services);

    expect(ctx.nicknames.listDenyWords().map((w) => w.pattern)).toEqual(["ほの"]);
    // Aは取り消したので、あとから押しても入らない
    await handleDenywordButton(press(`mgmt:denyword:confirm:${tokenA}`).interaction, ctx.services);
    expect(ctx.nicknames.listDenyWords().map((w) => w.pattern)).toEqual(["ほの"]);
    ctx.db.close();
  });

  it("他の管理者の確認は動かせない", async () => {
    const { handleDenywordModal, handleDenywordButton } = await hubModule;
    const ctx = setup();
    ctx.nicknames.importLegacy([{ userId: "u1", nickname: "あかり" }], "staff");
    const m = modal("reject", "あか");
    await handleDenywordModal(m.interaction, ctx.services);
    const token = tokenOf(m.reply);

    // 別の管理者が同じボタンIDを押しても効かない
    await handleDenywordButton(press(`mgmt:denyword:confirm:${token}`, "999999999999999999").interaction, ctx.services);
    expect(ctx.nicknames.listDenyWords()).toHaveLength(0);

    // 本人が押せば入る
    await handleDenywordButton(press(`mgmt:denyword:confirm:${token}`).interaction, ctx.services);
    expect(ctx.nicknames.listDenyWords()).toHaveLength(1);
    ctx.db.close();
  });

  it("**確認前後で件数が変わったら、そのまま保存しない**", async () => {
    const { handleDenywordModal, handleDenywordButton } = await hubModule;
    const ctx = setup();
    ctx.nicknames.importLegacy([{ userId: "u1", nickname: "あかり" }], "staff");
    const m = modal("reject", "あか");
    await handleDenywordModal(m.interaction, ctx.services);
    expect(contentOf(m.reply)).toContain("1件");
    const token = tokenOf(m.reply);

    // 見せてから押すまでの間に、同じ語に当たる人が増えた
    ctx.nicknames.importLegacy([{ userId: "u2", nickname: "あかつき" }], "staff");
    const first = press(`mgmt:denyword:confirm:${token}`);
    await handleDenywordButton(first.interaction, ctx.services);

    expect(ctx.nicknames.listDenyWords()).toHaveLength(0); // 保存していない
    const shown = String((first.update.mock.calls.at(-1) as never[])[0]?.content);
    expect(shown).toContain("1件 → 2件");
    expect(shown).toContain("まだ登録していません");

    // 新しい件数で改めて確定すれば入る
    await handleDenywordButton(press(`mgmt:denyword:confirm:${token}`).interaction, ctx.services);
    expect(ctx.nicknames.listDenyWords().map((w) => w.pattern)).toEqual(["あか"]);
    ctx.db.close();
  });
});

describe("確認の期限", () => {
  it("**15分を過ぎた確認は、押しても登録されない**（新しい確認が作られなくても切れる）", async () => {
    const { handleDenywordModal, handleDenywordButton } = await hubModule;
    const ctx = setup();
    ctx.nicknames.importLegacy([{ userId: "u1", nickname: "あかり" }], "staff");
    const m = modal("reject", "あか");
    await handleDenywordModal(m.interaction, ctx.services);
    const token = tokenOf(m.reply);

    // 誰も新しい確認を作らないまま16分が過ぎた
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 16 * 60_000));
    const p = press(`mgmt:denyword:confirm:${token}`);
    await handleDenywordButton(p.interaction, ctx.services);
    vi.useRealTimers();

    expect(ctx.nicknames.listDenyWords()).toHaveLength(0);
    expect(String((p.update.mock.calls.at(-1) as never[])[0]?.content)).toContain("期限切れ");
    ctx.db.close();
  });

  it("15分以内なら押せる", async () => {
    const { handleDenywordModal, handleDenywordButton } = await hubModule;
    const ctx = setup();
    ctx.nicknames.importLegacy([{ userId: "u1", nickname: "あかり" }], "staff");
    const m = modal("reject", "あか");
    await handleDenywordModal(m.interaction, ctx.services);
    const token = tokenOf(m.reply);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 14 * 60_000));
    await handleDenywordButton(press(`mgmt:denyword:confirm:${token}`).interaction, ctx.services);
    vi.useRealTimers();

    expect(ctx.nicknames.listDenyWords().map((w) => w.pattern)).toEqual(["あか"]);
    ctx.db.close();
  });
});
