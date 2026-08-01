import { workerData, parentPort } from "node:worker_threads";
import { createRequire } from "node:module";

/**
 * 別スレッド・別接続から同じ業務グループを実行する（PR1の競合テスト用）。
 *
 * 本体は TypeScript なので、ここでは同じ SQL を素の better-sqlite3 で書く。
 * 「先に INSERT できた側だけが資金を動かし、負けた側は保存済みの結果を受け取る」
 * という runGroup の約束を、実際に別接続から確かめるのが目的。
 */
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const { dbPath, groupKey, kind, actorId, from, to, amount, reason, startAt } = workerData;
const db = new Database(dbPath, { timeout: 5_000 });
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");

const now = () => Math.floor(Date.now() / 1000);

function runGroup() {
  const existing = db.prepare("SELECT * FROM casino_tx_groups WHERE group_key = ?").get(groupKey);
  if (existing) return { outcome: "replayed", result: existing.result_json };

  const tx = db.transaction(() => {
    const ts = now();
    db.prepare(
      `INSERT INTO casino_tx_groups (group_key, kind, status, actor_id, created_at) VALUES (?, ?, 'settled', ?, ?)`,
    ).run(groupKey, kind, actorId, ts);
    db.prepare("UPDATE ether_balances SET amount = amount - ?, updated_at = ? WHERE user_id = ?").run(amount, ts, from);
    db.prepare(
      "INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, 0, ?) ON CONFLICT(user_id) DO NOTHING",
    ).run(to, ts);
    db.prepare("UPDATE ether_balances SET amount = amount + ?, updated_at = ? WHERE user_id = ?").run(amount, ts, to);
    db.prepare(
      `INSERT INTO casino_tx
         (group_key, seq, tx_kind, from_holder, to_holder, amount, reason, actor_id, created_at)
       VALUES (?, 1, 'internal_transfer', ?, ?, ?, ?, ?, ?)`,
    ).run(groupKey, from, to, amount, reason, actorId, ts);
    db.prepare("UPDATE casino_tx_groups SET result_json = ?, settled_at = ? WHERE group_key = ?").run(
      JSON.stringify({ moved: amount }),
      now(),
      groupKey,
    );
    return { outcome: "executed", result: JSON.stringify({ moved: amount }) };
  });

  try {
    return tx.immediate();
  } catch (e) {
    if (String(e?.code ?? "").startsWith("SQLITE_CONSTRAINT")) {
      const settled = db.prepare("SELECT * FROM casino_tx_groups WHERE group_key = ?").get(groupKey);
      if (settled) return { outcome: "replayed", result: settled.result_json };
    }
    return { outcome: "error", error: `${e?.code ?? ""}:${e?.message ?? e}` };
  }
}

// 全スレッドを同じ瞬間に走らせて、実際に衝突させる。
// ビジーループで待つとCPUを食い合ってテスト全体を不安定にするので、寝て待つ。
const waitMs = startAt - Date.now();
if (waitMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
const result = runGroup();
db.close();
parentPort.postMessage(result);
