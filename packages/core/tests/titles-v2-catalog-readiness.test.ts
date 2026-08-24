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
  it("status:BLOCKEDの全候補は、usableSourcesが空か、非source系blocker（manifest/role-history）だけが理由のときに限り登録済みsourceを持つ", () => {
    // PR F2b: No.69のように「completion sourceは十分だがmanifestが無い」という
    // 部分的readyのBLOCKED候補が正当に存在する——その場合はusableSourcesを
    // 空にせず記録してよい（reviewの明示指示）。ただしfake placeholderを防ぐため、
    // 非空にできるのはsource capability自体を疑う理由
    // （missing_persisted_source/missing_derived_source/source_semantic_mismatch/
    // missing_event_protocol/known_bug）が一切blockerKindsに含まれない場合だけに限る。
    const SOURCE_CAPABILITY_BLOCKERS = new Set([
      "missing_persisted_source",
      "missing_derived_source",
      "source_semantic_mismatch",
      "missing_event_protocol",
      "known_bug",
    ]);
    const blocked = TITLE_V2_CATALOG_READINESS.filter((r) => r.status === "BLOCKED");
    expect(blocked.length).toBeGreaterThan(0);
    for (const entry of blocked) {
      if (entry.usableSources.length === 0) continue;
      const hasSourceCapabilityBlocker = entry.blockerKinds.some((k) => SOURCE_CAPABILITY_BLOCKERS.has(k));
      expect(
        hasSourceCapabilityBlocker,
        `BLOCKED candidate #${entry.no} has non-empty usableSources but also a source-capability blocker (${entry.blockerKinds.join(",")}) — this looks like a fake placeholder`,
      ).toBe(false);
      for (const key of entry.usableSources) {
        const def = (TITLE_SOURCES as Record<string, { titleUsable: boolean } | undefined>)[key];
        expect(def, `BLOCKED candidate #${entry.no} references unknown source "${key}"`).toBeDefined();
        expect(def?.titleUsable, `BLOCKED candidate #${entry.no} references non-titleUsable source "${key}"`).toBe(true);
      }
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
  it("No.58「ほんの気持ち」はsnapshot-bounded reversal除外によりsource-ready", () => {
    const entry = readinessFor(58);
    expect(entry.status).toBe("READY");
    expect(entry.usableSources).toEqual(["economy_safe_peer_actions"]);
    expect(entry.specializedResolvers).toEqual(["computeSafeEconomyPeerActions"]);
    expect(entry.missingCapabilities).toEqual([]);
    expect(entry.blockerKinds).toEqual(["none"]);
    expect(entry.notes).toContain("evaluation snapshot時点で除外");
    expect(entry.notes).toContain("reversal transaction自身も従来どおり除外");
    expect(entry.notes).toContain("最初のvalid qualifying tip");
    expect(entry.notes).toContain("production release gate");
  });

  it("No.66「初勝負」: PR F2bでcasino_completed_activity_days（真のcompletion正本）が追加されREADYになった", () => {
    // 元counterexample（PVP経路がcollectStakes成功直後・runner実行前にwriterが発火し、
    // runnerが例外/中断しても書き込み済みfactが残る問題）はcasino_activity_days
    // （commitmentのみ）に対して今も成立するが、No.66/67はPR F2bでcasino_completed_
    // activity_days（settlePvp/settleProportional/正常branchのrefundAll成功後にのみ
    // 書かれる別source）へ切り替えたため解消した——source_semantic_mismatchガードは
    // 下のPR F2b describeブロックで固定する。
    const entry = readinessFor(66);
    expect(entry.status).toBe("READY");
    expect(entry.usableSources).toContain("casino_completed_activity_days");
  });

  it("No.67「つまみ食い」も同じ理由でREADYになった（PR F2b）", () => {
    const entry = readinessFor(67);
    expect(entry.status).toBe("READY");
    expect(entry.usableSources).toContain("casino_completed_activity_days");
  });

  it("No.68「賭場通」はsemanticSpecが「利用する」でありcompletion保証を要求しないためREADYのまま", () => {
    // No.66/67と一括変更しない——semanticSpec文言が「正常完了する」ではなく
    // 「複数日に利用する」なので、casino_activity_daysのparticipation commitment
    // 保証のままで意味を満たせる。PR F2bでもcompletion sourceへ切り替えない。
    const entry = readinessFor(68);
    expect(entry.status).toBe("READY");
    expect(entry.usableSources).toEqual(["casino_activity_days"]);
  });

  it("No.69「何でもござれ」: completion proof不足はPR F2bで解消し、missing_manifestのみ残る", () => {
    // manifestが未定義であることだけが残るblocker——completion半分（No.66/67と同根）は
    // casino_completed_activity_daysの追加で解消した。
    const entry = readinessFor(69);
    expect(entry.status).toBe("BLOCKED");
    expect(entry.blockerKinds).toEqual(["missing_manifest"]);
    expect(entry.blockerKinds).not.toContain("source_semantic_mismatch");
  });
});

describe("PR F2f: VC social breadthのJST日次分布追加後のreadiness", () => {
  it("No.22はbreadthを持つがpublic provenanceがないためPARTIAL", () => {
    const entry = readinessFor(22);
    expect(entry).toMatchObject({
      status: "PARTIAL",
      usableSources: ["vc_social_safe"],
      blockerKinds: ["source_semantic_mismatch"],
    });
  });

  it("No.23-25はglobal distinct + dailyBreadth + date spanで時間的持続性を表現できるためREADY", () => {
    // counterexample: day1に100人と会い、day2〜30はBob1人だけの場合も
    // dailyBreadth=[100,1,...]として見えるため、uniformな分布と区別できる。
    for (const no of [23, 24, 25]) {
      const entry = readinessFor(no);
      expect(entry.status, `candidate #${no}`).toBe("READY");
      expect(entry.usableSources, `candidate #${no}`).toEqual(["vc_social_safe"]);
      expect(entry.specializedResolvers, `candidate #${no}`).toEqual(["computeSafeSocialAggregates"]);
      expect(entry.missingCapabilities, `candidate #${no}`).toEqual([]);
      expect(entry.blockerKinds, `candidate #${no}`).toEqual(["none"]);
      expect(entry.thresholdCategory, `candidate #${no}`).toBe("THRESHOLD_PENDING");
    }
  });

  it("No.29/30はpair-specific overlap不足のためPARTIAL、No.31はpair persistence不足でBLOCKEDのまま", () => {
    expect(readinessFor(29)).toMatchObject({
      status: "PARTIAL",
      missingCapabilities: ["特定counterpart（day-repeat最大の相手）に紐づくtrusted overlap秒数"],
      blockerKinds: ["source_semantic_mismatch"],
    });
    expect(readinessFor(30)).toMatchObject({
      status: "PARTIAL",
      missingCapabilities: ["特定counterpartの生timestamp配列（離れた期間かどうかの判定）"],
      blockerKinds: ["source_semantic_mismatch"],
    });
    expect(readinessFor(31)).toMatchObject({
      status: "BLOCKED",
      missingCapabilities: ["特定counterpartのfirst→last span・複数期間・多数日の複合derived"],
      blockerKinds: ["missing_derived_source"],
    });
  });

  it("Theme 7はREADY 3 / PARTIAL 1 / BLOCKED 2、Theme 8はREADY 1 / PARTIAL 2 / BLOCKED 1", () => {
    const counts = (start: number, end: number) => {
      const result = { READY: 0, PARTIAL: 0, BLOCKED: 0 };
      for (const entry of TITLE_V2_CATALOG_READINESS.filter((candidate) => candidate.no >= start && candidate.no <= end)) {
        if (entry.status !== "META") result[entry.status] += 1;
      }
      return result;
    };
    expect(counts(22, 27)).toEqual({ READY: 3, PARTIAL: 1, BLOCKED: 2 });
    expect(counts(28, 31)).toEqual({ READY: 1, PARTIAL: 2, BLOCKED: 1 });
  });
});

describe("PR F2e: VC group-size daily safe source追加後のreadiness", () => {
  it("No.10-21は全件daily 4bucketから日数/share/span/streakを後段評価できるためREADY", () => {
    for (let no = 10; no <= 21; no++) {
      const entry = readinessFor(no);
      expect(entry.status, `candidate #${no}`).toBe("READY");
      expect(entry.usableSources, `candidate #${no}`).toEqual(["vc_group_size_daily_safe"]);
      expect(entry.specializedResolvers, `candidate #${no}`).toEqual(["computeGroupSizeDailySeconds"]);
      expect(entry.missingCapabilities, `candidate #${no}`).toEqual([]);
      expect(entry.blockerKinds, `candidate #${no}`).toEqual(["none"]);
      expect(entry.thresholdCategory, `candidate #${no}`).toBe("THRESHOLD_PENDING");
    }
  });

  it("F2k後の実集計はREADY 59 / PARTIAL 6 / BLOCKED 26 / META 8", () => {
    const counts = new Map<string, number>();
    for (const entry of TITLE_V2_CATALOG_READINESS) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual({ READY: 59, BLOCKED: 26, PARTIAL: 6, META: 8 });
  });

  it("source_semantic_mismatchはpublic provenance 3件を含む6件、missing_derived_sourceは7件", () => {
    expect(TITLE_V2_CATALOG_READINESS.filter((entry) => entry.blockerKinds.includes("source_semantic_mismatch")).map((entry) => entry.no)).toEqual([
      1,
      6,
      22,
      29,
      30,
      48,
    ]);
    expect(TITLE_V2_CATALOG_READINESS.filter((entry) => entry.blockerKinds.includes("missing_derived_source"))).toHaveLength(7);
  });

  it("missing_derived_sourceはF2kのNo.59/61/63解消で10から7へ減る", () => {
    expect(TITLE_V2_CATALOG_READINESS.filter((entry) => entry.blockerKinds.includes("missing_derived_source"))).toHaveLength(7);
  });

  it("Theme 3-6は各3件すべてREADY", () => {
    for (const [start, end] of [[10, 12], [13, 15], [16, 18], [19, 21]] as const) {
      expect(TITLE_V2_CATALOG_READINESS.filter((entry) => entry.no >= start && entry.no <= end).map((entry) => entry.status)).toEqual([
        "READY",
        "READY",
        "READY",
      ]);
    }
  });
});

describe("PR F2k: economy semantic family + shop purchase safe readiness", () => {
  it("No.58は専用reversal-safe peer sourceを維持し、No.59/61/63だけeconomy semantic sourceでREADY", () => {
    expect(readinessFor(58).usableSources).toEqual(["economy_safe_peer_actions"]);
    for (const no of [59, 61, 63]) {
      expect(readinessFor(no)).toMatchObject({
        status: "READY",
        usableSources: ["economy_semantic_safe"],
        specializedResolvers: ["computeEconomySemanticSafe"],
        missingCapabilities: [],
        blockerKinds: ["none"],
      });
    }
    expect(readinessFor(63).notes).toContain("subjectUsedFamilies");
    expect(readinessFor(63).notes).toContain("incoming-only family");
  });

  it("No.62はshop sourceでREADY、No.60/64/65は残るexact blockerだけを保持", () => {
    expect(readinessFor(62)).toMatchObject({
      status: "READY",
      usableSources: ["shop_purchase_safe"],
      specializedResolvers: ["computeShopPurchaseSafe"],
      missingCapabilities: [],
      blockerKinds: ["none"],
    });
    expect(readinessFor(60)).toMatchObject({
      status: "BLOCKED",
      usableSources: [],
      missingCapabilities: ["pair単位のsafe aggregate（「以前くれた相手」判定）"],
      blockerKinds: ["missing_derived_source"],
    });
    expect(readinessFor(64)).toMatchObject({
      status: "BLOCKED",
      usableSources: ["economy_semantic_safe"],
      missingCapabilities: ["role-at-time"],
      blockerKinds: ["missing_role_history"],
    });
    expect(readinessFor(65)).toMatchObject({
      status: "BLOCKED",
      usableSources: ["shop_purchase_safe"],
      missingCapabilities: ["role-at-time"],
      blockerKinds: ["missing_role_history"],
    });
  });

  it("Theme 13はREADY 5 / PARTIAL 0 / BLOCKED 3", () => {
    const entries = TITLE_V2_CATALOG_READINESS.filter((entry) => entry.no >= 58 && entry.no <= 65);
    expect(entries.filter((entry) => entry.status === "READY")).toHaveLength(5);
    expect(entries.filter((entry) => entry.status === "PARTIAL")).toHaveLength(0);
    expect(entries.filter((entry) => entry.status === "BLOCKED")).toHaveLength(3);
  });
});

describe("PR F2g: public room activity safe source追加後のreadiness", () => {
  it("No.50-56はhosted/guest/ownUse aggregateでSOURCE READY", () => {
    for (let no = 50; no <= 56; no++) {
      const entry = readinessFor(no);
      expect(entry.status, `candidate #${no}`).toBe("READY");
      expect(entry.usableSources, `candidate #${no}`).toEqual(["public_room_activity_safe"]);
      expect(entry.specializedResolvers, `candidate #${no}`).toEqual(["computePublicRoomActivitySafe"]);
      expect(entry.missingCapabilities, `candidate #${no}`).toEqual([]);
      expect(entry.blockerKinds, `candidate #${no}`).toEqual(["none"]);
    }
  });

  it("No.57はroom activity側だけ解消しrole-at-time temporal cross-reference待ち", () => {
    const entry = readinessFor(57);
    expect(entry.status).toBe("BLOCKED");
    expect(entry.usableSources).toEqual(["public_room_activity_safe"]);
    expect(entry.specializedResolvers).toEqual(["computePublicRoomActivitySafe"]);
    expect(entry.missingCapabilities).toEqual(["宿屋系role-at-timeとguest visit時点のtemporal cross-reference"]);
    expect(entry.blockerKinds).toEqual(["missing_role_history"]);
    expect(entry.notes).toContain("普通のguestとしての有効来訪は証明可能");
  });

  it("Theme 12はREADY 7 / PARTIAL 0 / BLOCKED 1", () => {
    const entries = TITLE_V2_CATALOG_READINESS.filter((entry) => entry.no >= 50 && entry.no <= 57);
    expect(entries.filter((entry) => entry.status === "READY")).toHaveLength(7);
    expect(entries.filter((entry) => entry.status === "PARTIAL")).toHaveLength(0);
    expect(entries.filter((entry) => entry.status === "BLOCKED")).toHaveLength(1);
  });

  it("blocker実集計はF2k後missing_persisted_source 4、missing_role_history 7", () => {
    expect(TITLE_V2_CATALOG_READINESS.filter((entry) => entry.blockerKinds.includes("missing_persisted_source"))).toHaveLength(4);
    expect(TITLE_V2_CATALOG_READINESS.filter((entry) => entry.blockerKinds.includes("missing_role_history"))).toHaveLength(7);
  });
});

describe("PR F2h: canonical TC conversation/reaction safe source追加後のreadiness", () => {
  it("No.42-47（No.46 reaction含む）は必要なdistributionを表現できるためREADY", () => {
    for (const no of [42, 43, 44, 45, 46, 47]) {
      const entry = readinessFor(no);
      expect(entry.status, `candidate #${no}`).toBe("READY");
      expect(entry.missingCapabilities, `candidate #${no}`).toEqual([]);
      expect(entry.blockerKinds, `candidate #${no}`).toEqual(["none"]);
      expect(entry.thresholdCategory, `candidate #${no}`).toBe("THRESHOLD_PENDING");
    }
    expect(readinessFor(46).usableSources).toEqual(["tc_reaction_safe"]);
  });

  it("No.48はexplicit reply/threadだけならexactだがfree-flow同一topicを証明できずPARTIAL", () => {
    expect(readinessFor(48)).toMatchObject({
      status: "PARTIAL",
      usableSources: ["tc_conversation_safe"],
      missingCapabilities: ["normal free-flow会話の同一topic long-life correlation（reply/thread非依存）"],
      blockerKinds: ["source_semantic_mismatch"],
    });
  });

  it("No.49はTC socialDays + F2f vc_social_safe.dailyBreadthでREADY", () => {
    expect(readinessFor(49)).toMatchObject({
      status: "READY",
      usableSources: ["tc_conversation_safe", "vc_social_safe"],
      specializedResolvers: ["computeTcConversationSafe", "computeSafeSocialAggregates"],
      missingCapabilities: [],
      blockerKinds: ["none"],
    });
  });

  it("Theme 11はREADY 7 / PARTIAL 1 / BLOCKED 0", () => {
    const entries = TITLE_V2_CATALOG_READINESS.filter((entry) => entry.no >= 42 && entry.no <= 49);
    expect(entries.filter((entry) => entry.status === "READY")).toHaveLength(7);
    expect(entries.filter((entry) => entry.status === "PARTIAL")).toHaveLength(1);
    expect(entries.filter((entry) => entry.status === "BLOCKED")).toHaveLength(0);
  });
});

describe("PR F2i: public social activity time safe source追加後のreadiness", () => {
  it("No.32-37はJST date×24hour TC/VC分布から後段calibrationできるためSOURCE READY", () => {
    for (let no = 32; no <= 37; no += 1) {
      const entry = readinessFor(no);
      expect(entry.status, `candidate #${no}`).toBe("READY");
      expect(entry.usableSources, `candidate #${no}`).toEqual(["social_activity_time_safe"]);
      expect(entry.specializedResolvers, `candidate #${no}`).toEqual(["computeSocialActivityTimeSafe"]);
      expect(entry.missingCapabilities, `candidate #${no}`).toEqual([]);
      expect(entry.blockerKinds, `candidate #${no}`).toEqual(["none"]);
      expect(entry.thresholdCategory, `candidate #${no}`).toBe("THRESHOLD_PENDING");
      expect(entry.notes, `candidate #${no}`).toContain("24hour");
      expect(entry.notes, `candidate #${no}`).toContain("NONCOUNT");
    }
  });

  it("Theme 9はREADY 6 / PARTIAL 0 / BLOCKED 0", () => {
    const entries = TITLE_V2_CATALOG_READINESS.filter((entry) => entry.no >= 32 && entry.no <= 37);
    expect(entries.filter((entry) => entry.status === "READY")).toHaveLength(6);
    expect(entries.filter((entry) => entry.status === "PARTIAL")).toHaveLength(0);
    expect(entries.filter((entry) => entry.status === "BLOCKED")).toHaveLength(0);
  });

  it("No.48 free-flow同一topic問題は時間帯sourceで解決せずPARTIALを維持する", () => {
    expect(readinessFor(48)).toMatchObject({
      status: "PARTIAL",
      usableSources: ["tc_conversation_safe"],
      blockerKinds: ["source_semantic_mismatch"],
    });
  });
});

describe("semantic false-positive再監査（public event completion保証）", () => {
  it("No.80/81は明示completion正本とrosterのsafe JOINによりREADY", () => {
    for (const no of [80, 81]) {
      const entry = readinessFor(no);
      expect(entry.status, `candidate #${no}`).toBe("READY");
      expect(entry.usableSources, `candidate #${no}`).toEqual(["public_event_completed_participations"]);
      expect(entry.specializedResolvers, `candidate #${no}`).toEqual(["computeCompletedPublicEventParticipations"]);
      expect(entry.missingCapabilities, `candidate #${no}`).toEqual([]);
      expect(entry.blockerKinds, `candidate #${no}`).toEqual(["none"]);
    }
  });

  it("No.82はcompletion mismatchだけ解消し、実event_date span source不足でBLOCKEDのまま", () => {
    const entry = readinessFor(82);
    expect(entry.status).toBe("BLOCKED");
    expect(entry.usableSources).toEqual([]);
    expect(entry.missingCapabilities).toEqual(["実event_dateのsafe title exposure / span source"]);
    expect(entry.blockerKinds).toEqual(["missing_persisted_source"]);
  });

  it("No.83/84はorganizer/staff protocol不足のまま変更しない", () => {
    for (const no of [83, 84]) {
      expect(readinessFor(no)).toMatchObject({ status: "BLOCKED", blockerKinds: ["missing_event_protocol"] });
    }
  });
});

/**
 * PR F2a: computeLastOccupant()のsame-second/0-second visit tie bug修正
 * （packages/core/src/vc/derived.ts）に伴うreadiness registryの追従を固定する。
 */
describe("PR F2a: vc_last_occupant tie bug修正後のreadiness", () => {
  it("No.7/9はtie bug修正によりREADY、No.6はknown bug解消後もpublic provenance不足でPARTIAL", () => {
    for (const no of [7, 9]) {
      const entry = readinessFor(no);
      expect(entry.status, `candidate #${no}`).toBe("READY");
      expect(entry.blockerKinds, `candidate #${no}`).toEqual(["none"]);
      expect(entry.blockerKinds, `candidate #${no}`).not.toContain("known_bug");
    }
    expect(readinessFor(6)).toMatchObject({
      status: "PARTIAL",
      blockerKinds: ["source_semantic_mismatch"],
    });
    expect(readinessFor(6).blockerKinds).not.toContain("known_bug");
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

/**
 * PR F2b: casino completed-participation safe signal（casino_completed_activity_days）
 * 追加に伴うreadiness registryの追従を固定する。casino_activity_days（commitment
 * ベース、E4）の意味は変更していない——No.68は引き続きそちらを使う。
 */
describe("PR F2b: casino completion source追加後のreadiness", () => {
  it("No.66/67はcasino_completed_activity_daysでREADY・blockerKinds:[\"none\"]", () => {
    for (const no of [66, 67]) {
      const entry = readinessFor(no);
      expect(entry.status, `candidate #${no}`).toBe("READY");
      expect(entry.blockerKinds, `candidate #${no}`).toEqual(["none"]);
      expect(entry.usableSources, `candidate #${no}`).toContain("casino_completed_activity_days");
    }
  });

  it("No.68はcasino_activity_days（commitmentベース）のままREADY——completion sourceへ切り替えない", () => {
    const entry = readinessFor(68);
    expect(entry.status).toBe("READY");
    expect(entry.usableSources).toEqual(["casino_activity_days"]);
    expect(entry.usableSources).not.toContain("casino_completed_activity_days");
  });

  it("No.69はmissing_manifestのみ残りBLOCKEDのまま——source_semantic_mismatchは解消済み", () => {
    const entry = readinessFor(69);
    expect(entry.status).toBe("BLOCKED");
    expect(entry.blockerKinds).toEqual(["missing_manifest"]);
    expect(entry.blockerKinds).not.toContain("source_semantic_mismatch");
  });

  it("source_semantic_mismatch blockerはNo.58/66/67/69から外れ、依然残る候補にはそのまま残る", () => {
    for (const no of [58, 66, 67, 80, 81, 82]) {
      expect(readinessFor(no).blockerKinds, `candidate #${no}`).not.toContain("source_semantic_mismatch");
    }
    for (const no of [29, 30]) {
      expect(readinessFor(no).blockerKinds, `candidate #${no}`).toContain("source_semantic_mismatch");
    }
    for (const no of [23, 24, 25]) {
      expect(readinessFor(no).blockerKinds, `candidate #${no}`).not.toContain("source_semantic_mismatch");
    }
  });
});

describe("PR F2j: exact invite-rooted safe source追加後のreadiness", () => {
  it("No.76-79はanonymous direct-branch profileで各semanticをexactに表現できるためREADY", () => {
    for (let no = 76; no <= 79; no += 1) {
      expect(readinessFor(no)).toMatchObject({
        status: "READY",
        usableSources: ["invite_rooted_safe"],
        specializedResolvers: ["computeInviteRootedSafe"],
        missingCapabilities: [],
        blockerKinds: ["none"],
        optimizationRisk: "HIGH",
      });
    }
  });

  it("No.74/75はconfirmed_invitesの意味を変えずREADYを維持する", () => {
    for (const no of [74, 75]) {
      expect(readinessFor(no)).toMatchObject({
        status: "READY",
        usableSources: ["confirmed_invites"],
        specializedResolvers: [],
        blockerKinds: ["none"],
        optimizationRisk: "HIGH",
      });
    }
  });

  it("Theme 15は6/6 READY、F2k後のpersisted/derived blockerは実集計4/7", () => {
    expect(TITLE_V2_CATALOG_READINESS.filter((entry) => entry.no >= 74 && entry.no <= 79).map((entry) => entry.status)).toEqual([
      "READY",
      "READY",
      "READY",
      "READY",
      "READY",
      "READY",
    ]);
    expect(TITLE_V2_CATALOG_READINESS.filter((entry) => entry.blockerKinds.includes("missing_persisted_source"))).toHaveLength(4);
    expect(TITLE_V2_CATALOG_READINESS.filter((entry) => entry.blockerKinds.includes("missing_derived_source"))).toHaveLength(7);
  });
});
