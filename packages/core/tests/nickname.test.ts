import { describe, expect, it } from "vitest";
import { EventLog, Nicknames, openDb } from "../src/index.js";

/**
 * 名前の規則と正本。
 *
 * 冥獄城の規則は3つ:
 * - 他人と同じサーバーニックネームは禁止
 * - 記号を含む名前は禁止（使えるのは文字と数字だけ）
 * - 過度な下ネタは禁止（語彙はDBで運用・コードに焼き込まない）
 *
 * 城独自の文字数上限は設けない（Discordの技術上限32文字に従う）。
 */

function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const names = new Nicknames(db, events);
  return { db, events, names };
}

const A = "111111111111111111";
const B = "222222222222222222";
const C = "333333333333333333";

describe("使える文字（ホワイトリスト）", () => {
  it("漢字・かな・カナ・英字・数字・長音符は通る", () => {
    const { db, names } = setup();
    for (const ok of ["冥獄", "こはく", "ミラーボール", "Alice", "alice2", "来世", "ヨルシカ", "ー"]) {
      expect(names.evaluate(ok).ok, ok).toBe(true);
    }
    db.close();
  });

  it("記号・空白・絵文字・句読点は通らない", () => {
    const { db, names } = setup();
    for (const ng of ["山田 太郎", "山田・太郎", "★星", "a★", "😀", "こんにちは！", "a_b", "a-b", "。"]) {
      const r = names.evaluate(ng);
      expect(r.ok, ng).toBe(false);
      if (!r.ok) expect(r.rejection.code).toBe("illegal_chars");
    }
    db.close();
  });

  it("空・32文字超は通らない（城独自の上限は設けない＝Discordの上限）", () => {
    const { db, names } = setup();
    expect(names.evaluate("   ").ok).toBe(false);
    expect(names.evaluate("あ".repeat(32)).ok).toBe(true);
    const over = names.evaluate("あ".repeat(33));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.rejection.code).toBe("too_long");
    db.close();
  });

  it("NFKC正規化してから判定する（半角カナ・全角英字・丸数字は通る）", () => {
    const { db, names } = setup();
    const r = names.evaluate("ａｌｉｃｅ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.nickname).toBe("alice"); // 正規化した形で登録する
    expect(names.evaluate("ﾊﾝｶｸ").ok).toBe(true);
    expect(names.evaluate("①番").ok).toBe(true);
    db.close();
  });
});

describe("同名禁止", () => {
  it("2人目は取れない", () => {
    const { db, names } = setup();
    expect(names.claim({ userId: A, nickname: "こはく", setVia: "entry", actor: "t" }).ok).toBe(true);
    const second = names.claim({ userId: B, nickname: "こはく", setVia: "entry", actor: "t" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.rejection).toEqual({ code: "taken", by: "member" });
    db.close();
  });

  it("全角半角・大文字小文字の違いだけでは別名にならない", () => {
    const { db, names } = setup();
    names.claim({ userId: A, nickname: "Alice", setVia: "entry", actor: "t" });
    for (const variant of ["alice", "ALICE", "ａｌｉｃｅ", "Ａｌｉｃｅ"]) {
      const r = names.claim({ userId: B, nickname: variant, setVia: "entry", actor: "t" });
      expect(r.ok, variant).toBe(false);
    }
    db.close();
  });

  it("**アプリの判定をすり抜けてもDBが落とす**（同名が成立しない最後の砦）", () => {
    const { db, names } = setup();
    names.claim({ userId: A, nickname: "ヨル", setVia: "entry", actor: "t" });
    // 事前チェックを通さず直接書きにいく＝並行登録が競合した場合と同じ
    expect(() =>
      db
        .prepare(
          "INSERT INTO nickname_reservations (name_key, kind, user_id, display, created_at, updated_at) VALUES (?,?,?,?,?,?)",
        )
        .run("よる".normalize("NFKC"), "member", B, "ヨル", 0, 0),
    ).not.toThrow(); // 別の鍵なので通る（鍵が同じ場合との対比）
    expect(() =>
      db
        .prepare(
          "INSERT INTO nickname_reservations (name_key, kind, user_id, display, created_at, updated_at) VALUES (?,?,?,?,?,?)",
        )
        .run("ヨル", "member", C, "ヨル", 0, 0),
    ).toThrow(); // 同じ鍵は主キー違反
    db.close();
  });

  it("自分の名前は変えられる。古い予約は残さない", () => {
    const { db, names } = setup();
    names.claim({ userId: A, nickname: "まえ", setVia: "entry", actor: "t" });
    expect(names.claim({ userId: A, nickname: "あと", setVia: "entry", actor: "t" }).ok).toBe(true);
    expect(names.reservation("まえ")).toBeNull();
    expect(names.reservation("あと")?.user_id).toBe(A);
    // 手放した名前は他の人が取れる
    expect(names.claim({ userId: B, nickname: "まえ", setVia: "entry", actor: "t" }).ok).toBe(true);
    db.close();
  });
});

describe("既存の重複（legacy conflict）", () => {
  function withLegacyDuplicate() {
    const ctx = setup();
    const result = ctx.names.importLegacy(
      [
        { userId: A, nickname: "来世" },
        { userId: B, nickname: "来世" },
        { userId: C, nickname: "ひとり" },
      ],
      "staff",
    );
    return { ...ctx, result };
  }

  it("重複は誰も改名させず、conflict として記録する", () => {
    const { db, names, result } = withLegacyDuplicate();
    expect(result.imported).toBe(1); // ひとり だけが単独で取り込まれる
    expect(result.conflicted).toBe(2);
    expect(names.get(A)?.state).toBe("conflict");
    expect(names.get(B)?.state).toBe("conflict");
    expect(names.get(C)?.state).toBe("legacy");
    db.close();
  });

  it("重複した名前の予約は**誰の持ち物でもない**", () => {
    const { db, names } = withLegacyDuplicate();
    const reservation = names.reservation("来世");
    expect(reservation?.kind).toBe("legacy_conflict");
    expect(reservation?.user_id).toBeNull();
    db.close();
  });

  it("新規はその名前を取れない", () => {
    const { db, names } = withLegacyDuplicate();
    const r = names.claim({ userId: "444444444444444444", nickname: "来世", setVia: "entry", actor: "t" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection).toEqual({ code: "taken", by: "legacy_conflict" });
    db.close();
  });

  it("**片方が改名しても予約は外れない**（代表者を立てない理由）", () => {
    const { db, names } = withLegacyDuplicate();
    // 重複していた1人が商館で正式に改名した
    expect(names.claim({ userId: A, nickname: "あたらしい", setVia: "shop", actor: "t", allowLocked: true }).ok).toBe(true);
    // まだ B が「来世」で残っているので、新規には開放されない
    expect(names.reservation("来世")?.kind).toBe("legacy_conflict");
    const other = names.claim({ userId: "444444444444444444", nickname: "来世", setVia: "entry", actor: "t" });
    expect(other.ok).toBe(false);
    db.close();
  });

  it("**片方が退出しても予約は外れない**", () => {
    const { db, names } = withLegacyDuplicate();
    db.prepare("DELETE FROM member_names WHERE user_id = ?").run(A); // 退出でレコードを消した想定
    expect(names.reservation("来世")?.kind).toBe("legacy_conflict");
    expect(names.claim({ userId: "444444444444444444", nickname: "来世", setVia: "entry", actor: "t" }).ok).toBe(false);
    db.close();
  });

  it("何度取り込んでも同じ結果になる", () => {
    const { db, names } = withLegacyDuplicate();
    const again = names.importLegacy(
      [
        { userId: A, nickname: "来世" },
        { userId: B, nickname: "来世" },
        { userId: C, nickname: "ひとり" },
      ],
      "staff",
    );
    expect(again.imported).toBe(0);
    expect(again.skipped).toBe(3);
    expect(names.listConflicts()).toHaveLength(1);
    db.close();
  });

  it("**後日の再取り込みで legacy_conflict の名前を持つ人が来ても conflict にする**", () => {
    const { db, names } = withLegacyDuplicate();
    expect(names.reservation("来世")?.kind).toBe("legacy_conflict");

    // 初回取り込みの後に参加した人が、たまたま同じ名前を使っていた
    const later = "444444444444444444";
    const result = names.importLegacy([{ userId: later, nickname: "来世", locked: false }], "staff");

    expect(names.get(later)?.state).toBe("conflict"); // legacy にしない
    expect(names.status(later).kind).toBe("violation"); // 名前ゲートを通さない
    expect(result.conflicted).toBe(1);
    expect(result.imported).toBe(0);
    // 予約は誰の持ち物でもないまま
    expect(names.reservation("来世")?.kind).toBe("legacy_conflict");
    expect(names.reservation("来世")?.user_id).toBeNull();
    db.close();
  });

  it("後日の再取り込みで、他人の個人予約と同じ名前でも conflict にする", () => {
    const { db, names } = setup();
    names.claim({ userId: A, nickname: "ひとり", setVia: "entry", actor: "t" });
    expect(names.reservation("ひとり")?.kind).toBe("member");

    names.importLegacy([{ userId: B, nickname: "ひとり", locked: true }], "staff");

    expect(names.get(B)?.state).toBe("conflict");
    // 先に持っていた人も conflict へ落ちる（同じ名前が2人いる事実は変わらない）
    expect(names.get(A)?.state).toBe("conflict");
    expect(names.reservation("ひとり")?.kind).toBe("legacy_conflict");
    db.close();
  });

  it("既存の名前に記号が入っていても取り込む（取りこぼすと新規に取られる）", () => {
    const { db, names } = setup();
    const r = names.importLegacy([{ userId: A, nickname: "★星★" }], "staff");
    expect(r.imported).toBe(1);
    // 新規は同じ名前を取れない（そもそも記号は形式で落ちる）
    expect(names.reservation("★星★")).not.toBeNull();
    db.close();
  });
});

describe("取り込み時の固定", () => {
  it("入城済みは固定、案内待ちは未固定で取り込む", () => {
    const { db, names } = setup();
    names.importLegacy(
      [
        { userId: A, nickname: "にゅうじょうずみ", locked: true },
        { userId: B, nickname: "あんないまち", locked: false },
        { userId: C, nickname: "していなし" },
      ],
      "staff",
    );
    expect(names.get(A)?.locked_at).not.toBeNull();
    expect(names.get(B)?.locked_at).toBeNull();
    expect(names.get(C)?.locked_at).toBeNull(); // 既定は未固定
    db.close();
  });

  it("固定して取り込んだ人は、本人からは変更できない", () => {
    const { db, names } = setup();
    names.importLegacy([{ userId: A, nickname: "にゅうじょうずみ", locked: true }], "staff");
    const r = names.claim({ userId: A, nickname: "べつめい", setVia: "entry", actor: "t" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection).toEqual({ code: "locked" });
    // 商館の正式な改名は通る
    expect(names.claim({ userId: A, nickname: "べつめい", setVia: "shop", actor: "t", allowLocked: true }).ok).toBe(true);
    db.close();
  });

  it("重複していても入城済みなら固定する", () => {
    const { db, names } = setup();
    const r = names.importLegacy(
      [
        { userId: A, nickname: "かぶり", locked: true },
        { userId: B, nickname: "かぶり", locked: true },
      ],
      "staff",
    );
    expect(r.conflicted).toBe(2);
    expect(r.locked).toBe(2);
    expect(names.get(A)?.locked_at).not.toBeNull();
    expect(names.get(B)?.locked_at).not.toBeNull();
    db.close();
  });
});

describe("不適切名（denylist）", () => {
  it("既定では語彙を持たない（勝手に作らない）", () => {
    const { db, names } = setup();
    expect(names.listDenyWords()).toHaveLength(0);
    db.close();
  });

  it("reject は登録できない・部分一致で効く", () => {
    const { db, names } = setup();
    names.addDenyWord("ngword", "staff");
    const r = names.claim({ userId: A, nickname: "あngwordい", setVia: "entry", actor: "t" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.code).toBe("denylisted");
    db.close();
  });

  it("flag は登録を止めないが、**自動では通さない**（門番の確認待ちになる）", () => {
    const { db, names } = setup();
    names.addDenyWord("あやしい", "staff", { action: "flag" });
    const r = names.claim({ userId: A, nickname: "あやしい人", setVia: "entry", actor: "t" });
    expect(r.ok).toBe(true);
    const status = names.status(A);
    expect(status.kind).toBe("review");
    if (status.kind === "review") expect(status.flagged).toBe("あやしい");
    db.close();
  });

  it("門番が確認して初めて通る", () => {
    const { db, names } = setup();
    names.addDenyWord("あやしい", "staff", { action: "flag" });
    names.claim({ userId: A, nickname: "あやしい人", setVia: "entry", actor: "t" });

    expect(names.approveFlagged(A, "user:judge")).toBe(true);

    expect(names.status(A).kind).toBe("ok");
    expect(names.get(A)?.flag_ok_by).toBe("user:judge");
    db.close();
  });

  it("確認が要らない名前を承認しても何も起きない（空振りの承認を残さない）", () => {
    const { db, names } = setup();
    names.claim({ userId: A, nickname: "ふつう", setVia: "entry", actor: "t" });
    expect(names.approveFlagged(A, "user:judge")).toBe(false);
    expect(names.get(A)?.flag_ok_at).toBeNull();
    db.close();
  });

  it("**名前を変えたら承認は消える**（別の名前は見ていない）", () => {
    const { db, names } = setup();
    names.addDenyWord("あやしい", "staff", { action: "flag" });
    names.claim({ userId: A, nickname: "あやしい人", setVia: "entry", actor: "t" });
    names.approveFlagged(A, "user:judge");
    expect(names.status(A).kind).toBe("ok");

    names.claim({ userId: A, nickname: "あやしい者", setVia: "entry", actor: "t" });

    expect(names.status(A).kind).toBe("review");
    expect(names.get(A)?.flag_ok_at).toBeNull();
    db.close();
  });

  it("**あとから別の要確認語を足したら、承認は無効に戻る**（見ていない語で通さない）", () => {
    const { db, names } = setup();
    names.addDenyWord("あやしい", "staff", { action: "flag" });
    names.claim({ userId: A, nickname: "あやしいことば", setVia: "entry", actor: "t" });
    names.approveFlagged(A, "user:judge");
    expect(names.status(A).kind).toBe("ok");

    // 門番が見ていない語を追加。同じ名前にも当たる
    names.addDenyWord("ことば", "staff", { action: "flag" });

    expect(names.status(A).kind).toBe("review");
    db.close();
  });

  it("当たらない要確認語を足しても、既存の承認は生きたまま", () => {
    const { db, names } = setup();
    names.addDenyWord("あやしい", "staff", { action: "flag" });
    names.claim({ userId: A, nickname: "あやしいことば", setVia: "entry", actor: "t" });
    names.approveFlagged(A, "user:judge");

    names.addDenyWord("まったくべつ", "staff", { action: "flag" });

    expect(names.status(A).kind).toBe("ok"); // 無関係な語で再確認を強いない
    db.close();
  });

  it("承認済みの語を消したときも、承認は無効に戻る", () => {
    const { db, names } = setup();
    names.addDenyWord("あやしい", "staff", { action: "flag" });
    names.addDenyWord("ことば", "staff", { action: "flag" });
    names.claim({ userId: A, nickname: "あやしいことば", setVia: "entry", actor: "t" });
    names.approveFlagged(A, "user:judge");
    expect(names.status(A).kind).toBe("ok");

    names.removeDenyWord("ことば", "staff");

    // 当たっている語の集合が変わったので、いったん保留へ戻る
    expect(names.status(A).kind).toBe("review");
    names.approveFlagged(A, "user:judge");
    expect(names.status(A).kind).toBe("ok");
    db.close();
  });

  it("要確認語が全部消えたら、承認の有無に関わらず通る", () => {
    const { db, names } = setup();
    names.addDenyWord("あやしい", "staff", { action: "flag" });
    names.claim({ userId: A, nickname: "あやしい人", setVia: "entry", actor: "t" });
    expect(names.status(A).kind).toBe("review");

    names.removeDenyWord("あやしい", "staff");

    expect(names.status(A).kind).toBe("ok");
    db.close();
  });

  it("要確認語が拒否語に変わったら、承認済みでも違反になる", () => {
    const { db, names } = setup();
    names.addDenyWord("あやしい", "staff", { action: "flag" });
    names.claim({ userId: A, nickname: "あやしい人", setVia: "entry", actor: "t" });
    names.approveFlagged(A, "user:judge");
    expect(names.status(A).kind).toBe("ok");

    names.addDenyWord("あやしい", "staff", { action: "reject" }); // 同じ語の区分を変える

    expect(names.status(A).kind).toBe("violation");
    db.close();
  });

  it("同じ名前を出し直しただけなら承認は残る", () => {
    const { db, names } = setup();
    names.addDenyWord("あやしい", "staff", { action: "flag" });
    names.claim({ userId: A, nickname: "あやしい人", setVia: "entry", actor: "t" });
    names.approveFlagged(A, "user:judge");

    names.claim({ userId: A, nickname: "あやしい人", setVia: "entry", actor: "t" });

    expect(names.status(A).kind).toBe("ok");
    db.close();
  });

  it("**reject と flag の両方に当たったら reject**（最初に見つかった1件で決めない）", () => {
    const { db, names } = setup();
    // 一覧は pattern 順に並ぶので、flag が先に来る並びをわざと作る
    names.addDenyWord("あいてむ", "staff", { action: "flag" });
    names.addDenyWord("ばつ", "staff", { action: "reject" });
    const listed = names.listDenyWords().map((w) => w.pattern);
    expect(listed.indexOf("あいてむ")).toBeLessThan(listed.indexOf("ばつ")); // flag が先

    const r = names.claim({ userId: A, nickname: "あいてむばつ", setVia: "entry", actor: "t" });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection).toEqual({ code: "denylisted", pattern: "ばつ" });
    db.close();
  });

  it("reject が後ろに並んでいても拒否する（登録済みの名前の見直しでも同じ）", () => {
    const { db, names } = setup();
    names.claim({ userId: A, nickname: "あいてむばつ", setVia: "entry", actor: "t" });
    names.addDenyWord("あいてむ", "staff", { action: "flag" });
    expect(names.status(A).kind).toBe("review");

    names.addDenyWord("ばつ", "staff", { action: "reject" });

    expect(names.status(A).kind).toBe("violation"); // flag ではなく違反として見える
    db.close();
  });

  it("**あとから禁止語を足すと、既に登録済みの名前も違反として見える**", () => {
    const { db, names } = setup();
    names.claim({ userId: A, nickname: "ばつわーど", setVia: "entry", actor: "t" });
    expect(names.status(A).kind).toBe("ok");
    names.addDenyWord("ばつわーど", "staff");
    expect(names.status(A).kind).toBe("violation");
    db.close();
  });
});

describe("入城後の固定", () => {
  it("固定後は本人からは変更できない", () => {
    const { db, names } = setup();
    names.claim({ userId: A, nickname: "こはく", setVia: "entry", actor: "t" });
    names.lock(A, "staff");
    const r = names.claim({ userId: A, nickname: "べつめい", setVia: "entry", actor: "t" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection).toEqual({ code: "locked" });
    db.close();
  });

  it("商館の正式な改名だけが固定を越えられる", () => {
    const { db, names } = setup();
    names.claim({ userId: A, nickname: "こはく", setVia: "entry", actor: "t" });
    names.lock(A, "staff");
    expect(names.claim({ userId: A, nickname: "べつめい", setVia: "shop", actor: "t", allowLocked: true }).ok).toBe(true);
    expect(names.get(A)?.nickname).toBe("べつめい");
    expect(names.get(A)?.locked_at).not.toBeNull(); // 固定は外れない
    db.close();
  });
});

describe("状態（入城の可否に使う）", () => {
  it("未登録・違反・通過を見分ける", () => {
    const { db, names } = setup();
    expect(names.status(A).kind).toBe("unset");
    names.claim({ userId: A, nickname: "こはく", setVia: "entry", actor: "t" });
    expect(names.status(A).kind).toBe("ok");
    names.importLegacy(
      [
        { userId: B, nickname: "かぶり" },
        { userId: C, nickname: "かぶり" },
      ],
      "staff",
    );
    expect(names.status(B).kind).toBe("violation"); // 既存の重複は通さない
    db.close();
  });
});

describe("Discord側が失敗したときの巻き戻し", () => {
  it("予約を残さない（誰も名乗っていない名前が取れなくなる、を防ぐ）", () => {
    const { db, names } = setup();
    const claimed = names.claim({ userId: A, nickname: "こはく", setVia: "entry", actor: "t" });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    names.rollback(claimed.snapshot, "t");
    expect(names.reservation("こはく")).toBeNull();
    expect(names.get(A)).toBeNull();
    // 他の人が取れる
    expect(names.claim({ userId: B, nickname: "こはく", setVia: "entry", actor: "t" }).ok).toBe(true);
    db.close();
  });

  it("改名の途中で失敗したら、前の名前へ戻る", () => {
    const { db, names } = setup();
    names.claim({ userId: A, nickname: "まえ", setVia: "entry", actor: "t" });
    const claimed = names.claim({ userId: A, nickname: "あと", setVia: "entry", actor: "t" });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    names.rollback(claimed.snapshot, "t");
    expect(names.get(A)?.nickname).toBe("まえ");
    expect(names.reservation("まえ")?.user_id).toBe(A);
    expect(names.reservation("あと")).toBeNull();
    db.close();
  });
});
