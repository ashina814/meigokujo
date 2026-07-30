import { writeFileSync } from "node:fs";
import { TITLE_RULES } from "../src/titles/catalog.js";

/**
 * 称号の命名ワークシートを docs/titles-naming.md に書き出す。
 * カタログを増減させたら `pnpm --filter @meigokujo/core titles:worksheet` で再生成する。
 */

const LABEL: Record<string, string> = {
  kizuna: "縁・同席",
  toki: "時と刻",
  bakuchi: "賭場",
  kane: "銭",
  shiro: "城の営み",
  kiwami: "極み",
  dan: "段位",
};

const ORDER = ["kizuna", "toki", "bakuchi", "kane", "shiro", "kiwami", "dan"];

const unique = TITLE_RULES.filter((r) => r.category !== "dan").length;
const secret = TITLE_RULES.filter((r) => r.secret).length;

const lines: string[] = [
  "# 称号 命名ワークシート",
  "",
  "> このファイルは `titles-worksheet.ts` の生成物。手で増減させず、カタログ側を直して再生成する。",
  "",
  "`key` は永続IDなので **変更しないこと**（付与済み実績との対応が切れる）。",
  "命名は「仮の名」を差し替えるだけでよい。🔒 は隠し称号（獲得するまで名前も条件も伏せる）。",
  "",
  `- 総数 **${TITLE_RULES.length}**`,
  `- うち段位以外（ユニーク） **${unique}**`,
  `- うち隠し **${secret}**`,
  "",
];

for (const cat of ORDER) {
  const rules = TITLE_RULES.filter((r) => r.category === cat);
  if (rules.length === 0) continue;
  lines.push(`## ${LABEL[cat]}（${rules.length}）`, "");
  lines.push("| key | 仮の名 | 獲得条件 | 隠し |");
  lines.push("| --- | --- | --- | :-: |");
  for (const r of rules) {
    lines.push(`| \`${r.key}\` | ${r.emoji} ${r.name} | ${r.desc} | ${r.secret ? "🔒" : ""} |`);
  }
  lines.push("");
}

const out = new URL("../../../docs/titles-naming.md", import.meta.url);
writeFileSync(out, lines.join("\n"), "utf8");
console.log(`書き出し: ${out.pathname} (${TITLE_RULES.length}件)`);
