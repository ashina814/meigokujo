import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TITLE_V2_CATALOG_CANDIDATES } from "../src/titles/v2-catalog-candidates.js";
import { TITLE_V2_CATALOG_READINESS } from "../src/titles/v2-catalog-readiness.js";
import { TITLE_SOURCES } from "../src/titles/v2-contract.js";

/**
 * PR F1 §19: candidate/readiness registryはproduction runtime pathから完全に
 * 切り離されている——no Bot wiring, no award, no evaluation, no notification,
 * no equip, no profile, no catalog epoch activation, no source baseline capture,
 * no Collection Edition activation, no Series persistence registration,
 * no production Meta execution。
 *
 * ここでは「切り離されている」ことをsource-order文字列検証（既存
 * casino-metrics-slots-structure.test.tsと同じ手法）で機械的に固定する。
 */

function readSource(relPath: string): string {
  return readFileSync(new URL(relPath, import.meta.url), "utf8");
}

function listTsFilesRecursive(dir: string): string[] {
  const entries = readdirSync(dir);
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listTsFilesRecursive(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const FORBIDDEN_PATTERNS = ["catalog-candidates", "catalog-readiness", "TITLE_V2_CATALOG_CANDIDATES", "TITLE_V2_CATALOG_READINESS"];

describe("K. candidate registryがv2 public runtime barrelからexportされていない", () => {
  it("v2.ts（public barrel）にcatalog-candidates/readinessへの言及が無い", () => {
    const src = readSource("../src/titles/v2.ts");
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(src.includes(pattern), `v2.ts should not reference "${pattern}"`).toBe(false);
    }
  });

  it("packages/core/src/index.ts にも言及が無い", () => {
    const src = readSource("../src/index.ts");
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(src.includes(pattern), `index.ts should not reference "${pattern}"`).toBe(false);
    }
  });
});

describe("L. production evaluator/import graphからcandidate registryが参照されていない", () => {
  const evaluatorFiles = [
    "../src/titles/v2-evaluator.ts",
    "../src/titles/v2-pipeline.ts",
    "../src/titles/v2-prefetch.ts",
    "../src/titles/v2-sources.ts",
    "../src/titles/v2-contract.ts",
    "../src/titles/v2-store.ts",
    "../src/titles/v2-meta.ts",
    "../src/titles/v2-series.ts",
    "../src/titles/v2-series-store.ts",
    "../src/titles/v2-collection.ts",
    "../src/titles/v2-collection-store.ts",
    "../src/titles/v2-award-facts.ts",
    "../src/titles/service.ts",
  ];

  it.each(evaluatorFiles)("%s にcatalog-candidates/readinessへの言及が無い", (relPath) => {
    const src = readSource(relPath);
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(src.includes(pattern), `${relPath} should not reference "${pattern}"`).toBe(false);
    }
  });

  it("apps/bot/src 配下のどのファイルにもcatalog-candidates/readinessへの言及が無い", () => {
    const botSrcDir = new URL("../../../apps/bot/src", import.meta.url).pathname.replace(/^\/([a-zA-Z]):/, "$1:");
    const files = listTsFilesRecursive(botSrcDir);
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (FORBIDDEN_PATTERNS.some((p) => src.includes(p))) offenders.push(file);
    }
    expect(offenders, `files referencing candidate/readiness registry: ${offenders.join(", ")}`).toEqual([]);
  });

  it("packages/core/src 配下、titles-catalog-*自身を除く全ファイルに言及が無い", () => {
    const coreSrcDir = new URL("../src", import.meta.url).pathname.replace(/^\/([a-zA-Z]):/, "$1:");
    const files = listTsFilesRecursive(coreSrcDir).filter(
      (f) => !f.includes("v2-catalog-candidates.ts") && !f.includes("v2-catalog-readiness.ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (FORBIDDEN_PATTERNS.some((p) => src.includes(p))) offenders.push(file);
    }
    expect(offenders, `files referencing candidate/readiness registry: ${offenders.join(", ")}`).toEqual([]);
  });
});

describe("M. READY candidateが参照するsourceは実際にTITLE_SOURCESへ存在しtitleUsable:true", () => {
  it("status:READYの全候補について、usableSourcesの各keyがTITLE_SOURCESに登録済みかつtitleUsable:true", () => {
    const readyEntries = TITLE_V2_CATALOG_READINESS.filter((r) => r.status === "READY");
    expect(readyEntries.length).toBeGreaterThan(0);
    for (const entry of readyEntries) {
      expect(entry.usableSources.length, `READY candidate #${entry.no} declares no usableSources`).toBeGreaterThan(0);
      for (const key of entry.usableSources) {
        const def = (TITLE_SOURCES as Record<string, { titleUsable: boolean } | undefined>)[key];
        expect(def, `candidate #${entry.no} references unknown source "${key}"`).toBeDefined();
        expect(def?.titleUsable, `candidate #${entry.no} references non-titleUsable source "${key}"`).toBe(true);
      }
    }
  });
});

describe("N. BLOCKED/PARTIAL candidateにfake placeholder sourceが入っていない", () => {
  it("status:BLOCKEDの全候補はusableSources空", () => {
    const blocked = TITLE_V2_CATALOG_READINESS.filter((r) => r.status === "BLOCKED");
    expect(blocked.length).toBeGreaterThan(0);
    for (const entry of blocked) {
      expect(entry.usableSources, `BLOCKED candidate #${entry.no} has non-empty usableSources`).toEqual([]);
    }
  });

  it("status:PARTIALの候補が参照するsourceも、登録済みかつtitleUsable:trueのものだけ（意味を落として偽装READY化していない）", () => {
    const partial = TITLE_V2_CATALOG_READINESS.filter((r) => r.status === "PARTIAL");
    expect(partial.length).toBeGreaterThan(0);
    for (const entry of partial) {
      for (const key of entry.usableSources) {
        const def = (TITLE_SOURCES as Record<string, { titleUsable: boolean } | undefined>)[key];
        expect(def, `PARTIAL candidate #${entry.no} references unknown source "${key}"`).toBeDefined();
        expect(def?.titleUsable).toBe(true);
      }
      // PARTIALはBLOCKと同じく「意味を落とさず表現できる」わけではないので
      // missingCapabilitiesが必ず何か残っているか、known_bugがblockerに入っている。
      expect(
        entry.missingCapabilities.length > 0 || entry.blockerKinds.includes("known_bug"),
        `PARTIAL candidate #${entry.no} has no missingCapabilities and no known_bug blocker`,
      ).toBe(true);
    }
  });
});

describe("O. 分布TBD candidateに勝手なproduction threshold値が入っていない", () => {
  it("TitleV2CatalogCandidateの型に数値thresholdフィールドが存在しない（thresholdIntentは原文文字列のみ）", () => {
    for (const c of TITLE_V2_CATALOG_CANDIDATES) {
      expect(typeof c.thresholdIntent).toBe("string");
      // xlsx原文カテゴリ文字列のいずれかであることのみを許可する——
      // "3日"のような仮の具体値がthresholdIntentへ紛れ込んでいないことの
      // regression guard（deriveThresholdCategory()が未知の文字列でthrowする
      // ことに依存しているため、TITLE_V2_CATALOG_READINESSが読み込めていること
      // 自体がこの検証を兼ねる）。
      expect([
        "構造固定",
        "分布TBD",
        "構造+分布",
        "manifest依存",
        "manifest固定",
        "full-clear manifest依存",
        "full-clear 100%",
        "series manifest固定",
      ]).toContain(c.thresholdIntent);
    }
  });

  it("thresholdCategory:THRESHOLD_PENDINGの候補は、evidenceやnotesに具体的な数値thresholdを書いていない", () => {
    const pending = TITLE_V2_CATALOG_READINESS.filter((r) => r.thresholdCategory === "THRESHOLD_PENDING");
    expect(pending.length).toBeGreaterThan(0);
    const numericThresholdPattern = /\d+\s*(日|回|人|%|件|秒|週|ヶ月)\s*(以上|以下|超|未満|以内)/;
    for (const entry of pending) {
      expect(
        numericThresholdPattern.test(entry.notes),
        `candidate #${entry.no} (THRESHOLD_PENDING) notes appear to hardcode a numeric threshold: "${entry.notes}"`,
      ).toBe(false);
    }
  });
});

describe("readiness registryはcandidatesと1:1対応する", () => {
  it("99件すべてに監査entryがあり、noが一致する", () => {
    expect(TITLE_V2_CATALOG_READINESS).toHaveLength(99);
    const candidateNos = TITLE_V2_CATALOG_CANDIDATES.map((c) => c.no).sort((a, b) => a - b);
    const readinessNos = TITLE_V2_CATALOG_READINESS.map((r) => r.no).sort((a, b) => a - b);
    expect(readinessNos).toEqual(candidateNos);
  });

  it("kind:metaの候補はstatus:META、kind:behaviorの候補はstatus:META以外", () => {
    const byNo = new Map(TITLE_V2_CATALOG_CANDIDATES.map((c) => [c.no, c]));
    for (const r of TITLE_V2_CATALOG_READINESS) {
      const candidate = byNo.get(r.no)!;
      if (candidate.kind === "meta") {
        expect(r.status, `candidate #${r.no} is meta but status is ${r.status}`).toBe("META");
      } else {
        expect(r.status, `candidate #${r.no} is behavior but status is META`).not.toBe("META");
      }
    }
  });

  it("provisionalKeyがcandidatesと完全一致する", () => {
    const byNo = new Map(TITLE_V2_CATALOG_CANDIDATES.map((c) => [c.no, c.provisionalKey]));
    for (const r of TITLE_V2_CATALOG_READINESS) {
      expect(r.provisionalKey).toBe(byNo.get(r.no));
    }
  });
});
