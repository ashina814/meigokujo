/**
 * 称号v2の設計契約。
 *
 * このファイルはカタログを持たない。先に「何を材料にしてよいか」「どう公開するか」を
 * 型とレジストリで固定し、個々の称号は後続PRでこの契約へ乗せる。
 */

export const TITLE_TIME_ZONE = "Asia/Tokyo" as const;

export type TitleLifecycle = "active" | "seasonal" | "retired" | "disabled";
export type TitleTrigger =
  | "vc_leave"
  | "game_end"
  | "room_closed"
  | "transfer"
  | "market_created"
  | "daily";

export type TitleSourceKind = "history" | "counter";
export type TitleSourcePrivacy = "safe" | "restricted" | "forbidden";

export type TitleEpochPolicy =
  | { type: "point"; at: string }
  | { type: "interval"; start: string; end: string; clip: true }
  | { type: "baseline"; metrics: readonly string[] };

export interface TitleSourceCodeRef {
  /** repo rootからの相対パス。 */
  file: string;
  /** そのファイルに必ず存在する、契約を示す最小文字列。 */
  needle: string;
}

export interface TitleSourceDefinition {
  /** 人が追えてテストでも検証できる書き込み正本。 */
  writtenBy: TitleSourceCodeRef;
  /** 本番で writer を呼ぶ入口。 */
  calledFrom: TitleSourceCodeRef;
  kind: TitleSourceKind;
  privacy: TitleSourcePrivacy;
  /**
   * source全体について達成時刻を正確に復元できるか。
   * raw sourceに推定時刻が混ざり得るならfalse。必要なら後続のderived sourceでtrueを取り戻す。
   */
  orderable: boolean;
  /** カタログ施行時刻をまたぐ履歴をどう切るか。 */
  epochPolicy: TitleEpochPolicy;
  /** SQLの1行が利用者行動の何を意味するか。row count の誤用を防ぐ。 */
  rawUnit: string;
}

/**
 * 最初のsource registry。
 *
 * 全データ源を一気に登録しない。実際の writer / caller / 境界契約を監査できたものだけを
 * PRごとに追加する。未登録sourceは称号定義から参照できない。
 */
export const TITLE_SOURCES = {
  vc_segments: {
    writtenBy: {
      file: "packages/core/src/vc/service.ts",
      needle: "INSERT INTO vc_segments",
    },
    calledFrom: {
      file: "apps/bot/src/vc-tracking.ts",
      needle: "services.vc.open(",
    },
    kind: "history",
    privacy: "safe",
    // closeAllDangling() はクラッシュ復旧時に ended_at を推定値で補う。
    // raw vc_segments 全体としては達成時刻を完全には証明できない。
    orderable: false,
    epochPolicy: {
      type: "interval",
      start: "started_at",
      end: "ended_at",
      clip: true,
    },
    // VcTracker.open() は入室だけでなく mute/deafen・ch移動でも前segmentを閉じる。
    // COUNT(*) を「VC入室回数」と読んではいけない。
    rawUnit: "voice_state_segment",
  },
  bump_counts: {
    writtenBy: {
      file: "packages/core/src/rank/bump.ts",
      needle: "INSERT INTO bump_counts",
    },
    calledFrom: {
      file: "apps/bot/src/bump.ts",
      needle: "services.bumps.addOnce(",
    },
    kind: "counter",
    privacy: "safe",
    orderable: false,
    // baselineで保存してよいmetric名もsource contract側で固定する。
    epochPolicy: { type: "baseline", metrics: ["count"] },
    rawUnit: "cumulative_counter",
  },
} as const satisfies Record<string, TitleSourceDefinition>;

export type TitleSourceKey = keyof typeof TITLE_SOURCES;

export interface TitleCheckResult {
  earned: boolean;
  /**
   * 条件を満たした時刻。証明できないときは null。
   * reconcile時刻や付与時刻で埋めてはいけない。
   */
  earnedAt: number | null;
}

export interface TitleDefinition {
  key: `v2.${string}`;
  /** 第I期、第II期など計測起点を共有するカタログ。 */
  catalog: string;
  name: string;
  emoji: string;
  description: string;
  sources: readonly TitleSourceKey[];
  trigger: TitleTrigger;
  lifecycle: TitleLifecycle;
  /** 条件そのものを取得前に公開するのではなく、必要ならこのヒントだけを見せる。 */
  hint?: string;
  /** 条件・名前とも伏せる番外枠。隠し称号は通常カタログ完遂へ含めない。 */
  hidden: boolean;
  /** 通常カタログ完遂の分母へ入るか。 */
  countsForCompletion: boolean;
  /** 高レアだから自動告知、にはしない。 */
  publicAnnounce: boolean;
}

/**
 * カタログ定義の小さなruntime guard。
 * TypeScriptを迂回した動的入力でも、旧key・未登録source・隠し完遂混入を通さない。
 */
export function defineTitle<T extends TitleDefinition>(definition: T): T {
  if (!definition.key.startsWith("v2.") || definition.key.length <= 3) {
    throw new Error(`title key must use v2.* namespace: ${definition.key}`);
  }
  if (!definition.catalog.trim()) throw new Error(`title ${definition.key}: catalog is required`);
  if (definition.sources.length === 0) throw new Error(`title ${definition.key}: at least one source is required`);

  for (const source of definition.sources) {
    if (!(source in TITLE_SOURCES)) {
      throw new Error(`title ${definition.key}: unregistered source ${String(source)}`);
    }
    const sourceDefinition: TitleSourceDefinition = TITLE_SOURCES[source];
    if (sourceDefinition.privacy === "forbidden") {
      throw new Error(`title ${definition.key}: forbidden source ${source}`);
    }
  }

  if (definition.hidden && definition.countsForCompletion) {
    throw new Error(`title ${definition.key}: hidden titles cannot count for catalog completion`);
  }
  if (definition.lifecycle !== "active" && definition.countsForCompletion) {
    throw new Error(`title ${definition.key}: only active titles can count for catalog completion`);
  }
  return definition;
}
