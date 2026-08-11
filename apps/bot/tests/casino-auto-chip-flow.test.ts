import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isSeatOccupied, acquireSeat, releaseSeat } from "../src/casino/common.js";
import type { Services } from "../src/services.js";

/** 常設順位卓の照会だけを持つ最小の services（着席は順位卓との排他も見る） */
const noLiveTable = { persistentTables: { participantHasLiveTable: () => false } } as unknown as Services;

describe("PR10 process-local ownership gate", () => {
  it("tracks active solo-game ownership for refund and external-confirmation gates", () => {
    expect(isSeatOccupied("alice")).toBe(false);
    expect(acquireSeat(noLiveTable, "alice")).toBe(true);
    expect(isSeatOccupied("alice")).toBe(true);
    releaseSeat("alice");
    expect(isSeatOccupied("alice")).toBe(false);
  });

  it("keeps the persistent emergency refund draft/execute/cancel routes", () => {
    const source = readFileSync(new URL("../src/commands/admin-hub.ts", import.meta.url), "utf8");
    expect(source).toContain("mgmt:casino:refund-user");
    expect(source).toContain("mgmt:casino:refund-all");
    expect(source).toContain("mgmt:casino:refund-execute:");
    expect(source).toContain("mgmt:casino:refund-cancel:");
    expect(source).toContain("createRefundSaga");
    expect(source).toContain("executeRefundSaga");
  });
});

describe("PR10監査: Bot側の導線", () => {
  const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

  it("プロセス内着席を所有判定の正本へ渡している（ショップ域外確認票もこれで守られる）", () => {
    const source = read("../src/services.ts");
    expect(source).toContain("new CasinoChipFlow(db, chips, events, chipAssets, { isSeatOccupied })");
  });

  it("退場表示は active ownership の skip を「返還可能額なし」と誤表示しない", () => {
    // 返還の導線は /案内 から /賭場 ハブへ移した（旧ボタンは customId が
    // どこにもルーティングされておらず、押しても無反応だった）
    const source = read("../src/commands/casino-home.ts");
    expect(source).toContain('result.skipped === "active_ownership"');
    // skip 分岐が「引き出せる分が無い」より前に立っている。
    // 順序が逆になると、預託中の利用者に「残高が無い」と誤表示してしまう
    expect(source.indexOf('result.skipped === "active_ownership"'))
      .toBeLessThan(source.indexOf("いま引き出せる分はありません"));
  });

  it("10分無操作の自動返還は正式開業かつ営業中のときだけ動かす", () => {
    const source = read("../src/scheduler.ts");
    expect(source).toContain('services.chipTx.openingPhase() === "formal"');
    expect(source).toContain('services.casinoStatus.current().status === "open"');
    // 停止中に毎分 failed イベントを積まない（skip だけでは記録しない）
    expect(source).toContain("if (idle.failed.length > 0) {");
    expect(source).not.toContain("idle.failed.length > 0 || idle.skipped.length > 0");
  });

  it("期限切れの域外確認票を毎分回収する（executing の永久放置を作らない）", () => {
    expect(read("../src/scheduler.ts")).toContain("expireStaleConfirmations()");
  });

  it("配送の副作用は二度実行しない（replay分岐ではなく配送状態で守る）", () => {
    // 以前は「replay なら配送そのものを飛ばす」で二重配送を防いでいた。
    // それだと**配送に失敗した購入を二度と配れない**（本番で再評価チャレンジが
    // 課金だけ成立して詰まった）。いまは購入行の配送状態で守るので、
    // replay でも配送を試し、delivered なら中で止まる。
    const panel = read("../src/commands/shop-panel.ts");
    expect(panel).toContain("deliverPurchase(services, interaction.guild, purchase,");
    const delivery = read("../src/shop-delivery.ts");
    // 配送の入口が必ず状態機械を通る
    expect(delivery).toContain("services.shop.beginDelivery(purchase.id)");
    expect(delivery.indexOf("beginDelivery")).toBeLessThan(delivery.indexOf('kind === "add_role"'));
    // 配送内容は購入時スナップショットだけを正本にする（商品の現在定義へ落ちない）
    expect(delivery).toContain("parseDeliverySnapshot(purchase.delivery_snapshot_json)");
    // 実際の副作用の有無は shop-delivery.test.ts で振る舞いとして検証している
  });

  it("返還済み・購入未完了で止まった確認票に再試行導線を残す", () => {
    const source = read("../src/commands/shop-panel.ts");
    expect(source).toContain("retryConfirmComponents");
    expect(source).toContain("自由チップは既にLandへ返還済みです");
    // 購入が成立していれば取り消し扱いにしない
    expect(source).toContain("redeemed && !purchased");
  });

  it("saga の取消ボタンは core が取り消せる状態でだけ出す", () => {
    const source = read("../src/commands/admin-hub.ts");
    // blocked/executing で押しても必ず失敗する死んだボタンを出さない
    expect(source).toContain('...(saga.status === "draft"');
  });

  it("retry の所持判定は free + land を checked add で見る", () => {
    const source = read("../src/casino/common.ts");
    expect(source).toContain("if (!Number.isSafeInteger(total)) {");
  });

  it("自動預入は胴元余力の確認を通ったあと、拘束の直前だけで行う", () => {
    const source = read("../src/casino/common.ts");
    const capacity = source.indexOf("needed > services.casino.availableForLiability()");
    const deposit = source.indexOf("services.chipFlow.ensureFreeChips");
    expect(capacity).toBeGreaterThan(-1);
    expect(deposit).toBeGreaterThan(capacity);
    // 予約・席の確保は validateBet の外（呼び出し側）なので、預入は常にその手前
    expect(source.indexOf("export function reserveHouseLiability")).toBeGreaterThan(deposit);
  });
});
