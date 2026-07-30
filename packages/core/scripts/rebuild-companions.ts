import { openDb } from "../src/db/bootstrap.js";
import { VcTracker } from "../src/vc/service.js";

/**
 * 同席台帳（vc_companions）の全再計算を単体で走らせる運用コマンド。
 *
 * 使い方:
 *   DB_PATH=/var/lib/meigokujo/meigokujo.db pnpm --filter @meigokujo/core companions:rebuild
 *
 * 起動時にも必要なら自動で走るが、次のような場合はこちらを使う。
 *   - デプロイ前に済ませて、Bot起動を最短にしたい
 *   - 集計のズレを疑って手動でやり直したい
 *
 * 何度実行しても同じ結果になる。Botを止めずに実行してもデータは壊れないが、
 * 実行中に閉じたセグメントの増分と競合して二重計上を招く可能性があるため、
 * Botを停止した状態で走らせることを推奨する。
 */

const dbPath = process.env.DB_PATH;
if (!dbPath) {
  console.error("DB_PATH が未設定です。例: DB_PATH=/var/lib/meigokujo/meigokujo.db");
  process.exit(1);
}

const db = openDb(dbPath);
const vc = new VcTracker(db);

const segments = vc.segmentCount();
const before = vc.companionRowCount();
const reason = vc.companionsRebuildReason();
console.log(`セグメント ${segments.toLocaleString("ja-JP")}件 / 既存の同席行 ${before.toLocaleString("ja-JP")}件`);
console.log(`再計算の必要性: ${reason ?? "なし（明示実行として続行）"}`);

const startedAt = Date.now();
const pairs = vc.rebuildCompanions();
const elapsed = Date.now() - startedAt;

console.log(`完了: ${pairs.toLocaleString("ja-JP")}組 / ${vc.companionRowCount().toLocaleString("ja-JP")}行 / ${elapsed}ms`);
db.close();
