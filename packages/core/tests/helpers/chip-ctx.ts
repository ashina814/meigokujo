import { randomUUID } from "node:crypto";
import type { Ledger } from "../../src/ledger/service.js";
import type { ChipTx } from "../../src/casino/chip-tx.js";
import { FORMAL_OPENING_VERSION } from "../../src/casino/chip-tx.js";
import { CHIP_ESCROW, type ChipLedger } from "../../src/casino/exchange.js";

/**
 * テストからチップを直接動かすための補助。
 *
 * 本番コードではチップ移動を必ず業務グループの中で行う（理由と実行者が残らない移動を作らない）。
 * テストでも同じ規律を通すが、毎回グループを書くと本題が読みにくくなるので、ここでまとめる。
 */

/**
 * 正式開業（`opening_v1`）を確定させる（PR8監査・ブロッカーA）。
 *
 * `ChipLedger` の正式開業ロックは外せないので、資金操作を伴うテストは
 * **必ずこれを通してから**新APIを使う。「ロックを解除するオプション」は存在しない。
 *
 * 資金を1 Ldも動かす前に呼ぶこと。開始残高を空で確定するので、以後の全残高は
 * `casino_tx` から再現でき、準備Landも新準備口座（`sys:escrow:casino`）に揃う。
 */
export function openFormally(chipTx: ChipTx, ledger: Ledger): void {
  chipTx.captureOpening(FORMAL_OPENING_VERSION, [], {
    poolLand: ledger.balanceOf(CHIP_ESCROW),
    fromLedgerTxId: ledger.lastTransactionId(),
  });
}

/**
 * 正式開業前（`legacy_pre_reset`）の窓に資金を作る（PR8監査・ブロッカーA）。
 *
 * 正式開業ロックの**唯一の例外**である `runMaintenance()` 区間を通す。復旧と
 * 正式開業初期化（PR12）が実際に使う経路と同じで、「ロックを解除するオプション」では
 * ないことがコード上に必ず残る。旧版の窓を作るテストはこれか DB fixture を使うこと。
 */
export function inMaintenance<T>(chipTx: ChipTx, body: () => T, reason = "テスト: 復旧・正式開業初期化相当"): T {
  return chipTx.runMaintenance(reason, body);
}

/** 使い捨てのグループでチップ移動を1回だけ行う（残高の作り込みや、不整合を作る細工に使う） */
export function testTransfer(
  ether: ChipLedger,
  from: string,
  to: string,
  amount: number,
  reason = "テストの残高調整",
): void {
  ether.runGroup({ groupKey: `test:${randomUUID()}`, kind: "opening_reset", actorId: "system:test" }, () =>
    ether.transfer(from, to, amount, { reason }),
  );
}

/** 複数の移動をまとめて1グループで行う（グループ単位の記録を確認したいとき） */
export function inTestGroup<T>(ether: ChipLedger, body: () => T, kind = "opening_reset"): T {
  return ether.runGroup({ groupKey: `test:${randomUUID()}`, kind, actorId: "system:test" }, body);
}

/**
 * テスト用の操作ID。本番では「同じ操作の再試行で同じ値になるもの」（Discordの操作IDなど）を
 * 渡すが、テストでは1回ごとに別のゲームなので連番で十分。
 */
let opCounter = 0;
export function opId(prefix = "test-op"): string {
  return `${prefix}-${++opCounter}`;
}
