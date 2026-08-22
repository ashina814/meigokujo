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

/**
 * PR #164レビュー: semantic false-positiveの再発防止テスト。
 *
 * counterexample: casino_activity_daysが証明するのは「successful funded
 * participation commitment」であって「completed game」ではない——PVP経路
 * （pvp-accept.ts等）はrunner実行前にwriterが発火するため、写像を誤ると
 * 参加しただけの未精算roundを「初勝負」READYとして扱ってしまう。同様に
 * economy_safe_peer_actionsのreversal非除外、vc_social_safeの時間的分布
 * 欠如も、「似たsourceがある」だけでREADYへ倒す典型的な失敗パターン。
 * このdescribeは、その3クラスのfalse-positiveが再発したら機械的に検出する。
 */
function readinessFor(no: number) {
  const entry = TITLE_V2_CATALOG_READINESS.find((r) => r.no === no);
  if (!entry) throw new Error(`no readiness entry for candidate #${no}`);
  return entry;
}

describe("semantic false-positive再監査（casino participation vs completion）", () => {
  it("No.58「ほんの気持ち」はreversal semanticsが現sourceと食い違うためREADYではない", () => {
    // xlsx Blocker欄「reversal済取引は無効」に対し、computeSafeEconomyPeerActions()は
    // reversalされた後もoriginal tipのfactを消さない（reversal_of IS NULLは
    // reversal行自身を除外するだけ）。
    const entry = readinessFor(58);
    expect(entry.status).not.toBe("READY");
    expect(entry.status).toBe("PARTIAL");
    expect(entry.blockerKinds).toContain("source_semantic_mismatch");
  });

  it("No.66「初勝負」はsourceがparticipationしか証明せずcompletionを証明しないためREADYではない", () => {
    // counterexample: PVP経路（pvp-accept.ts collectAndStartFunded）はcollectStakes
    // 成功直後・deps.runners[game](...)実行前にwriterが発火する。runnerが例外/中断
    // しても書き込み済みのcasino_activity_days factは残る（chohan-multi.tsの
    // 「🎴 中断」embedが実際に中断ケースを持つことを示す）。
    const entry = readinessFor(66);
    expect(entry.status).not.toBe("READY");
    expect(entry.status).toBe("PARTIAL");
    expect(entry.blockerKinds).toContain("source_semantic_mismatch");
  });

  it("No.67「つまみ食い」も同じparticipation-not-completion理由でREADYではない", () => {
    const entry = readinessFor(67);
    expect(entry.status).not.toBe("READY");
    expect(entry.status).toBe("PARTIAL");
    expect(entry.blockerKinds).toContain("source_semantic_mismatch");
  });

  it("No.68「賭場通」はsemanticSpecが「利用する」でありcompletion保証を要求しないためREADYのまま", () => {
    // No.66/67と一括変更しない——semanticSpec文言が「正常完了する」ではなく
    // 「複数日に利用する」なので、casino_activity_daysのparticipation commitment
    // 保証のままで意味を満たせる。
    const entry = readinessFor(68);
    expect(entry.status).toBe("READY");
  });

  it("No.69「何でもござれ」のblockerはmissing_manifestとsource_semantic_mismatchの両方を含む", () => {
    // manifestが後日完成しても、completion proof不足（No.66/67と同根）は
    // 別に残るため、missing_manifest単独では不十分。
    const entry = readinessFor(69);
    expect(entry.status).toBe("BLOCKED");
    expect(entry.blockerKinds).toContain("missing_manifest");
    expect(entry.blockerKinds).toContain("source_semantic_mismatch");
  });
});

describe("semantic false-positive再監査（VC social breadthの時間的分布）", () => {
  it("No.22「顔馴染み」はdistinctCoPresentUsersだけで意味を満たすためREADYのまま", () => {
    // semanticSpecが時間的な広がりを要求しない（「成立する」であって
    // 「複数日に広がる」ではない）ため、単一windowの累積distinct数で十分。
    const entry = readinessFor(22);
    expect(entry.status).toBe("READY");
  });

  it("No.23-25はいずれも「複数日/十分な期間/長期」という時間的持続性を要求するがsourceは単一累積値しか無いためREADYではない", () => {
    // counterexample: day1に100人と会い、day2〜30はAlice1人だけの場合でも
    // distinctCoPresentUsers/maxRepeatedDaysWithOneCounterpartは大きいままにでき、
    // 「複数日に広がる/続く/長期にわたる」という時間分布を証明できない。
    for (const no of [23, 24, 25]) {
      const entry = readinessFor(no);
      expect(entry.status, `candidate #${no}`).not.toBe("READY");
      expect(entry.status, `candidate #${no}`).toBe("PARTIAL");
      expect(entry.blockerKinds, `candidate #${no}`).toContain("source_semantic_mismatch");
    }
  });
});

describe("semantic false-positive再監査（public event completion保証）", () => {
  it("No.80/81はpublic_eventsにstatus/lifecycle列が無くevent completedを保証できないためREADYではない", () => {
    // public_eventsテーブルはevent_key/name/event_date/recorded_by/recorded_atのみ
    // ——status・state・phase・completed_at等のlifecycle列は存在しない。event_dateも
    // 「今」と比較されず、recordFinalizedEvent()呼び出しはstaffの手動判断のみに依存する。
    for (const no of [80, 81]) {
      const entry = readinessFor(no);
      expect(entry.status, `candidate #${no}`).not.toBe("READY");
      expect(entry.status, `candidate #${no}`).toBe("PARTIAL");
      expect(entry.blockerKinds, `candidate #${no}`).toContain("source_semantic_mismatch");
    }
  });
});

/**
 * PR F2a: computeLastOccupant()のsame-second/0-second visit tie bug修正
 * （packages/core/src/vc/derived.ts）に伴うreadiness registryの追従を固定する。
 */
describe("PR F2a: vc_last_occupant tie bug修正後のreadiness", () => {
  it("No.6/7/9はtie bug修正によりREADY・blockerKinds:[\"none\"]", () => {
    for (const no of [6, 7, 9]) {
      const entry = readinessFor(no);
      expect(entry.status, `candidate #${no}`).toBe("READY");
      expect(entry.blockerKinds, `candidate #${no}`).toEqual(["none"]);
      expect(entry.blockerKinds, `candidate #${no}`).not.toContain("known_bug");
    }
  });

  it("No.8はarea/categoryタクソノミー不足が別の理由で残るためBLOCKEDのまま（tie bug修正だけではREADY化しない）", () => {
    const entry = readinessFor(8);
    expect(entry.status).toBe("BLOCKED");
    expect(entry.blockerKinds).toContain("missing_derived_source");
    expect(entry.blockerKinds).not.toContain("known_bug");
  });

  it("known_bugを持つBehavior候補はrepo全体で0件（tie bug修正によりcatalog全体から消えている）", () => {
    const knownBugEntries = TITLE_V2_CATALOG_READINESS.filter(
      (r) => r.status !== "META" && r.blockerKinds.includes("known_bug"),
    );
    expect(knownBugEntries).toEqual([]);
  });
});
