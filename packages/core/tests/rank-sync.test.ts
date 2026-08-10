import { describe, expect, it } from "vitest";
import {
  decideGhostRoleAdd,
  decideRankSync,
  desiredStatusFromRoles,
  isAutoSyncableTransition,
  type SoulStatus,
} from "../src/index.js";

/**
 * Discord の階級ロール → `souls.status` の判定。
 *
 * ここは純粋関数なので、Discord のイベント順序に依らず全パターンを直接押さえられる。
 * 「途中状態を見て巻き戻す」事故を防ぐ設計の中核なので、優先順位と
 * 自動同期してよい遷移の線引きを網羅する。
 */

const snap = (ladder: string[], meirei = false) =>
  ({ ladder: ladder as never, meirei }) as Parameters<typeof desiredStatusFromRoles>[0];

describe("ロール構成から階級を決める", () => {
  it("通常階級は上位を採る（魔族 > 眷魔 > 魔人 > 亡霊）", () => {
    expect(desiredStatusFromRoles(snap(["ghost"])).status).toBe("ghost");
    expect(desiredStatusFromRoles(snap(["majin"])).status).toBe("majin");
    expect(desiredStatusFromRoles(snap(["kenma"])).status).toBe("kenma");
    expect(desiredStatusFromRoles(snap(["mazoku"])).status).toBe("mazoku");
    // 剥がし漏れで複数付いていても、最上位に寄せる
    expect(desiredStatusFromRoles(snap(["ghost", "majin"])).status).toBe("majin");
    expect(desiredStatusFromRoles(snap(["majin", "kenma"])).status).toBe("kenma");
    expect(desiredStatusFromRoles(snap(["ghost", "majin", "kenma", "mazoku"])).status).toBe("mazoku");
  });

  it("順不同でも同じ結論になる（イベント順に依存しない）", () => {
    expect(desiredStatusFromRoles(snap(["mazoku", "ghost"])).status).toBe(
      desiredStatusFromRoles(snap(["ghost", "mazoku"])).status,
    );
  });

  it("迷霊は通常階級を上書きする（最上位ではなく別状態）", () => {
    expect(desiredStatusFromRoles(snap([], true)).status).toBe("meirei");
    // 魔族が残っていても懲罰を優先する。剥がし漏れで懲罰が無効化されない
    expect(desiredStatusFromRoles(snap(["mazoku"], true)).status).toBe("meirei");
  });

  it("ロール構成の異常は記録用に報せる", () => {
    expect(desiredStatusFromRoles(snap(["majin", "kenma"])).anomalies).toContain("multiple_ladder_roles:majin+kenma");
    expect(desiredStatusFromRoles(snap(["mazoku"], true)).anomalies).toContain("meirei_with_ladder:mazoku");
    expect(desiredStatusFromRoles(snap(["majin"])).anomalies).toEqual([]);
  });

  it("階級ロールが1つも無ければ判定材料なし（null）", () => {
    expect(desiredStatusFromRoles(snap([])).status).toBeNull();
  });
});

describe("自動同期してよい遷移の線引き", () => {
  it("上位階級どうしの横移動は同期してよい", () => {
    for (const [from, to] of [
      ["majin", "kenma"],
      ["kenma", "mazoku"],
      ["mazoku", "majin"],
      ["kenma", "majin"],
    ] as Array<[SoulStatus, SoulStatus]>) {
      expect(isAutoSyncableTransition(from, to)).toBe(true);
    }
  });

  it("降格（→迷霊）と復帰（迷霊→上位）は同期してよい", () => {
    expect(isAutoSyncableTransition("majin", "meirei")).toBe(true);
    expect(isAutoSyncableTransition("ghost", "meirei")).toBe(true);
    expect(isAutoSyncableTransition("meirei", "majin")).toBe(true);
    expect(isAutoSyncableTransition("meirei", "mazoku")).toBe(true);
  });

  it("入城処理を迂回する遷移は同期しない", () => {
    // waiting/departed から階級を生やさない
    for (const to of ["majin", "kenma", "mazoku", "meirei"] as SoulStatus[]) {
      expect(isAutoSyncableTransition("waiting", to)).toBe(false);
      expect(isAutoSyncableTransition("departed", to)).toBe(false);
    }
    // 亡霊化は ghostify の担当
    expect(isAutoSyncableTransition("waiting", "ghost")).toBe(false);
  });

  it("亡霊への差し戻しと、亡霊からの昇格は同期しない", () => {
    // 評価期間の再設定を伴うので自動ではやらない
    expect(isAutoSyncableTransition("majin", "ghost")).toBe(false);
    expect(isAutoSyncableTransition("mazoku", "ghost")).toBe(false);
    expect(isAutoSyncableTransition("meirei", "ghost")).toBe(false);
    // 昇格の意味論（評価締切のクリア）は専用経路の担当
    expect(isAutoSyncableTransition("ghost", "majin")).toBe(false);
    expect(isAutoSyncableTransition("ghost", "kenma")).toBe(false);
  });

  it("同じ階級への遷移は対象外", () => {
    expect(isAutoSyncableTransition("majin", "majin")).toBe(false);
  });
});

describe("同期判定の総合", () => {
  it("既に一致していれば何もしない（Botの操作で発火しても二重処理しない）", () => {
    expect(decideRankSync("majin", snap(["majin"]))).toEqual({ kind: "noop", reason: "already_in_sync", anomalies: [] });
    // 昇格直後（魔人付与済み・亡霊剥奪済み）に来たイベントも noop になる
    expect(decideRankSync("meirei", snap([], true)).kind).toBe("noop");
  });

  it("status が一致していても、ロール構成の異常は結果に載せる（記録できるように）", () => {
    // DB迷霊 + ロール迷霊/魔族。status は合っているがロールの剥がし漏れ
    const meirei = decideRankSync("meirei", snap(["mazoku"], true));
    expect(meirei).toMatchObject({ kind: "noop" });
    expect(meirei.anomalies).toContain("meirei_with_ladder:mazoku");

    // DB眷魔 + ロール魔人/眷魔。上位を採るので眷魔と一致するが、通常階級が2つ付いている
    const kenma = decideRankSync("kenma", snap(["majin", "kenma"]));
    expect(kenma).toMatchObject({ kind: "noop" });
    expect(kenma.anomalies).toContain("multiple_ladder_roles:majin+kenma");
  });

  it("自動同期を禁じた遷移でも、ロール構成の異常は結果に載せる", () => {
    // waiting からは階級を生やさない。それとは別に迷霊と通常階級が同居している
    const decision = decideRankSync("waiting", snap(["mazoku"], true));
    expect(decision.kind).toBe("ambiguous");
    expect(decision.anomalies).toContain("meirei_with_ladder:mazoku");
  });

  it("横移動は更新する", () => {
    expect(decideRankSync("majin", snap(["kenma"]))).toEqual({
      kind: "update",
      to: "kenma",
      from: "majin",
      anomalies: [],
    });
  });

  it("階級ロールが無くなってもDBは変えない（ambiguous）", () => {
    const decision = decideRankSync("majin", snap([]));
    expect(decision.kind).toBe("ambiguous");
    expect(decision).toMatchObject({ reason: "no_rank_role", from: "majin" });
  });

  it("入城処理を迂回する遷移は ambiguous として弾く", () => {
    const decision = decideRankSync("waiting", snap(["mazoku"]));
    expect(decision.kind).toBe("ambiguous");
    expect((decision as { reason: string }).reason).toContain("transition_not_auto_syncable");
  });

  it("迷霊と通常階級が同居していたら、迷霊にしつつ異常として報せる", () => {
    const decision = decideRankSync("majin", snap(["majin"], true));
    expect(decision).toMatchObject({ kind: "update", to: "meirei", from: "majin" });
    expect((decision as { anomalies: string[] }).anomalies).toContain("meirei_with_ladder:majin");
  });

  it("階級ロールが1つも無いときも anomalies の形は保つ", () => {
    expect(decideRankSync("majin", snap([])).anomalies).toEqual([]);
  });

  it("昇格の途中状態を見ても、亡霊へ巻き戻さない", () => {
    // 「魔人を付けたが亡霊がまだ残っている」瞬間。最上位を採るので majin へ寄る
    expect(decideRankSync("ghost", snap(["ghost", "majin"]))).toMatchObject({ kind: "ambiguous" });
    // 「亡霊を外したが魔人がまだ付いていない」瞬間。DBは触らない
    expect(decideRankSync("ghost", snap([])).kind).toBe("ambiguous");
  });
});

describe("亡霊ロールの手動付与で ghostify してよいか", () => {
  it("入城前（waiting）と、台帳に居ない人は ghostify する", () => {
    // 本来の入城
    expect(decideGhostRoleAdd("waiting")).toEqual({ kind: "ghostify", reason: "waiting" });
    // 台帳より先にロールが付いた人。巻き戻す既存 status がそもそも無いので従来どおり作る
    expect(decideGhostRoleAdd(null)).toEqual({ kind: "ghostify", reason: "no_soul_row" });
  });

  it("既に亡霊なら何もしない", () => {
    expect(decideGhostRoleAdd("ghost")).toEqual({ kind: "noop", reason: "already_ghost" });
  });

  it("上位階級・迷霊・離脱済みは ghostify しない（評価前へ巻き戻さない）", () => {
    // ghostify() は評価期限と評価スナップショットを作り直すので、ここを通してはいけない
    for (const from of ["majin", "kenma", "mazoku", "meirei", "departed"] as SoulStatus[]) {
      expect(decideGhostRoleAdd(from)).toEqual({ kind: "blocked", reason: `ghost_role_add_on:${from}`, from });
    }
  });

  it("遷移表（上位階級 → ghost は自動同期しない）と同じ線引きになっている", () => {
    for (const from of ["majin", "kenma", "mazoku", "meirei", "departed"] as SoulStatus[]) {
      expect(isAutoSyncableTransition(from, "ghost")).toBe(false);
      expect(decideGhostRoleAdd(from).kind).toBe("blocked");
    }
  });
});
