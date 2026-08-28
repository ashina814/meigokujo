import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * generic `Shop.purchase()` を呼ぶ側が、必ず先に契約を見せていることを固定する。
 *
 * TypeScriptの必須引数だけでは「`as never` を挟む」「テストfixtureだけ例外にする」で
 * 崩せてしまう。ここではソースを直接見て、**すべての呼び出しが `expectedTermsToken` を
 * 渡していること**を確かめる。テストfixtureにも例外を作らない。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

/** 型を迂回するcaller自体を再現するための実行体。ここだけは意図的に生の値を渡す。 */
const INTENTIONAL_RAW_CALLERS = [
  "packages/core/tests/helpers/generic-purchase-terms-runner.ts",
  "packages/core/tests/shop-generic-purchase-terms.test.ts",
  // この検査自身。コメントや説明文の中に同じ並びが出るだけで呼び出しではない。
  "packages/core/tests/shop-generic-purchase-callers.test.ts",
];

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

/** `.purchase({` から対応する `}` までを返す。文字列・テンプレートの中の括弧は数えない。 */
function objectLiteralAt(text: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const quote = c;
      i += 1;
      while (i < text.length && text[i] !== quote) i += text[i] === "\\" ? 2 : 1;
    } else if (c === "`") {
      i += 1;
      while (i < text.length && text[i] !== "`") i += text[i] === "\\" ? 2 : 1;
    } else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(openIdx, i + 1);
    }
  }
  throw new Error("unbalanced object literal");
}

describe("generic購入の呼び出し側", () => {
  it("すべての .purchase({...}) が表示した契約を渡している", () => {
    const roots = [join(REPO, "packages", "core"), join(REPO, "apps", "bot")];
    const offenders: string[] = [];
    let checked = 0;

    for (const root of roots) {
      for (const file of sourceFiles(root)) {
        const rel = file.slice(REPO.length + 1).replace(/\\/g, "/");
        if (INTENTIONAL_RAW_CALLERS.includes(rel)) continue;
        const text = readFileSync(file, "utf8");
        const needle = ".purchase({";
        let from = 0;
        for (;;) {
          const at = text.indexOf(needle, from);
          if (at === -1) break;
          from = at + needle.length;
          const openIdx = at + needle.length - 1;
          let literal: string;
          try {
            literal = objectLiteralAt(text, openIdx);
          } catch {
            continue; // 文字列の中に現れた同じ並び（contract needle等）
          }
          checked += 1;
          if (!literal.includes("expectedTermsToken")) {
            const line = text.slice(0, at).split("\n").length;
            offenders.push(`${rel}:${line}`);
          }
        }
      }
    }

    expect(checked).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });
});
