import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TITLE_RULES } from "../src/titles/catalog.js";
import { knownTxTypes, registerDefaultTxTypes } from "../src/ledger/registry.js";
import { openDb } from "../src/db/bootstrap.js";

registerDefaultTxTypes();

/**
 * 称号が参照しているデータ源が「実際に生成されるもの」かをソースから機械的に検証する。
 *
 * 存在しないイベント型や取引種別を条件に書くと、永久に解除されない称号ができる。
 * カタログを増やすときに一番やりがちな事故なので、判定式を走査して突き合わせる。
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const SOURCE_DIRS = [join(REPO_ROOT, "packages", "core", "src"), join(REPO_ROOT, "apps", "bot", "src")];

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectSourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

const sources = SOURCE_DIRS.flatMap(collectSourceFiles).map((f) => readFileSync(f, "utf8"));
const allSource = sources.join("\n");

/** events.log("...") で実際に記録されているイベント型 */
function loggedEventTypes(): Set<string> {
  const found = new Set<string>();
  for (const m of allSource.matchAll(/events\.log\(\s*["']([a-z_0-9]+)["']/g)) found.add(m[1]!);
  return found;
}

/** casino_stats の実在カラム（テーブルは Casino が遅延生成するのでDDLから読む） */
function casinoStatsColumns(): Set<string> {
  const ddl = /CREATE TABLE IF NOT EXISTS casino_stats \(([\s\S]*?)\)/.exec(allSource);
  expect(ddl, "casino_stats の DDL が見つからない").not.toBeNull();
  const cols = new Set<string>();
  for (const line of ddl![1]!.split("\n")) {
    const m = /^\s*([a-z_]+)\s+(INTEGER|TEXT|REAL)/.exec(line);
    if (m) cols.add(m[1]!);
  }
  return cols;
}

/** 判定式から accessor("引数") の引数を抜き出す */
function referenced(method: string): Map<string, string[]> {
  const byType = new Map<string, string[]>();
  const pattern = new RegExp(`${method}\\(\\s*["']([a-zA-Z_0-9]+)["']`, "g");
  for (const rule of TITLE_RULES) {
    for (const m of rule.check.toString().matchAll(pattern)) {
      const type = m[1]!;
      const list = byType.get(type) ?? [];
      list.push(rule.key);
      byType.set(type, list);
    }
  }
  return byType;
}

describe("称号が参照するデータ源の実在性", () => {
  it("ソース収集が機能している（前提の自己検査）", () => {
    expect(sources.length).toBeGreaterThan(50);
    expect(allSource).toContain("registerTxType");
  });

  it("参照している事件録のイベント型はすべて実際に記録されている", () => {
    const logged = loggedEventTypes();
    expect(logged.size).toBeGreaterThan(30);
    const missing: string[] = [];
    for (const [type, rules] of [...referenced("asActor"), ...referenced("asTarget")]) {
      if (!logged.has(type)) missing.push(`${type} (${rules.join(", ")})`);
    }
    expect(missing, "記録されないイベント型を参照している").toEqual([]);
  });

  it("参照している取引種別はすべて取引登録簿にある", () => {
    const known = new Set(knownTxTypes());
    const missing: string[] = [];
    for (const method of ["txOutCount", "txOutSum", "txInCount", "txInSum"]) {
      for (const [type, rules] of referenced(method)) {
        if (!known.has(type)) missing.push(`${type} (${method}: ${rules.join(", ")})`);
      }
    }
    expect(missing, "登録簿に無い取引種別を参照している").toEqual([]);
  });

  it("参照している賭場戦績のカラムはすべて実在する", () => {
    const cols = casinoStatsColumns();
    expect(cols.has("games")).toBe(true);
    const missing: string[] = [];
    for (const [field, rules] of referenced("casinoStat")) {
      if (!cols.has(field)) missing.push(`${field} (${rules.join(", ")})`);
    }
    expect(missing, "casino_stats に無いカラムを参照している").toEqual([]);
  });

  it("冥府税・年金は登録簿にあり、実際に生成される", () => {
    // PR説明で「実在しない」と誤記していた箇所の回帰。fiscal が三項演算子で作るため
    // 単純な文字列検索では見つからなかった。
    const known = new Set(knownTxTypes());
    expect(known.has("tax")).toBe(true);
    expect(known.has("pension")).toBe(true);
    expect(allSource).toMatch(/type:\s*isTax\s*\?\s*["']tax["']\s*:\s*["']pension["']/);
  });

  it("遊技の種類数を要求する称号が、実在する種目数で解除できる", () => {
    // casino.settle(userId, game, ...) の第2引数が casino_game の payload.game になる。
    // ここに現れない遊技（差し・デュエル・競馬は escrow.settle 経由）は数えられない。
    const games = new Set<string>();
    for (const m of allSource.matchAll(/casino\.settle\(\s*[^,]+,\s*["']([^"']+)["']/g)) games.add(m[1]!);
    expect(games.size, "settle 呼び出しの抽出に失敗している").toBeGreaterThan(3);

    // distinctCasinoGames を使う称号の閾値を判定式から取り出す
    const thresholds: Array<{ key: string; threshold: number }> = [];
    for (const rule of TITLE_RULES) {
      const m = /distinctCasinoGames\(\)\s*>=\s*(\d+)/.exec(rule.check.toString());
      if (m) thresholds.push({ key: rule.key, threshold: Number(m[1]) });
    }
    expect(thresholds.length).toBeGreaterThan(0);

    const unreachable = thresholds.filter((t) => t.threshold > games.size);
    expect(
      unreachable.map((t) => `${t.key} は${t.threshold}種類を要求するが実在は${games.size}種類`),
      "到達不可能な遊技種類称号がある",
    ).toEqual([]);
  });

  it("スナップショットが読むテーブルは主要スキーマに存在する", () => {
    // 遅延生成テーブル（casino_*, race_bets 等）は safeGet/safeAll が守るので対象外。
    // bootstrap が必ず作るものだけを確認する。
    const db = openDb(":memory:");
    const names = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    for (const t of [
      "events",
      "transactions",
      "souls",
      "vc_segments",
      "vc_companions",
      "titles",
      "title_equips",
      "title_key_migrations",
      "rooms",
      "invites",
      "marks",
      "evaluations",
      "bump_counts",
      "shop_purchases",
      "settings",
    ]) {
      expect(names.has(t), `${t} が bootstrap で作られていない`).toBe(true);
    }
    db.close();
  });
});
