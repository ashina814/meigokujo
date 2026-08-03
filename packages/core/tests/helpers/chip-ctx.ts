import { randomUUID } from "node:crypto";
import type { ChipLedger } from "../../src/casino/exchange.js";

/**
 * テストからチップを直接動かすための補助。
 *
 * 本番コードではチップ移動を必ず業務グループの中で行う（理由と実行者が残らない移動を作らない）。
 * テストでも同じ規律を通すが、毎回グループを書くと本題が読みにくくなるので、ここでまとめる。
 */

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
