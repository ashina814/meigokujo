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
  | "bump_success"
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

/** 全sourceに共通するメタデータ。persisted/derivedのどちらでも同じ意味で使う。 */
interface TitleSourceCommon {
  kind: TitleSourceKind;
  privacy: TitleSourcePrivacy;
  /**
   * source全体について達成時刻を正確に復元できるか。
   * raw sourceに推定時刻が混ざり得るならfalse。必要なら後続のderived sourceでtrueを取り戻す。
   */
  orderable: boolean;
  /** 個々の称号が直接sourceとして宣言してよいか。監査・baseline専用sourceはfalse。 */
  titleUsable: boolean;
  /** カタログ施行時刻をまたぐ履歴をどう切るか。 */
  epochPolicy: TitleEpochPolicy;
  /** SQLの1行（またはderived factの1件）が利用者行動の何を意味するか。誤用を防ぐ。 */
  rawUnit: string;
}

/** DBへ直接書き込まれる正本source。 */
export interface PersistedTitleSourceDefinition extends TitleSourceCommon {
  origin: "persisted";
  /** 人が追えてテストでも検証できる書き込み正本。 */
  writtenBy: TitleSourceCodeRef;
  /** writerを直接呼ぶ本番処理。 */
  calledFrom: TitleSourceCodeRef;
  /** Discord event等からcalledFromまでの最上流配線。死んだcallerを検知する。 */
  wiredFrom: TitleSourceCodeRef;
}

/**
 * 他のsourceから読み出し専用で導出するsource。
 *
 * 「writerが存在するsource」と偽装しない——derivedはDBへ何も書かないので
 * writtenBy/calledFrom/wiredFromを持たせず、代わりに実装ファイルと依存元を持つ。
 */
export interface DerivedTitleSourceDefinition extends TitleSourceCommon {
  origin: "derived";
  /** 導出ロジックを実装しているファイルと、その存在を示す最小文字列。 */
  derivedBy: TitleSourceCodeRef;
  /**
   * 依存する登録済みsource（persisted/derived問わず）。
   * dependency chainは最終的にlive persisted sourceへ到達しなければならない（v2-store.tsで検証）。
   */
  derivedFrom: readonly string[];
}

export type TitleSourceDefinition = PersistedTitleSourceDefinition | DerivedTitleSourceDefinition;

/**
 * 最初のsource registry。
 *
 * 全データ源を一気に登録しない。実際の writer / caller / event wiring / 境界契約を監査できたものだけを
 * PRごとに追加する。未登録sourceは称号定義から参照できない。
 */
export const TITLE_SOURCES = {
  vc_segments: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/vc/service.ts",
      needle: "INSERT INTO vc_segments",
    },
    calledFrom: {
      file: "apps/bot/src/vc-tracking.ts",
      needle: "services.vc.open(",
    },
    wiredFrom: {
      file: "apps/bot/src/index.ts",
      needle: "trackVoiceState(oldState, newState, services);",
    },
    kind: "history",
    privacy: "safe",
    // closeAllDangling() はクラッシュ復旧時に ended_at を推定値で補う。
    // raw vc_segments 全体としては達成時刻を完全には証明できない。
    orderable: false,
    // 個々の称号からは直接使わせない。安全な derived source（vc_visits 以下）を使うこと。
    // raw segment を将来の称号作者が直接 COUNT してしまう経路をここで閉じる。
    titleUsable: false,
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
  bump_events: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/rank/bump.ts",
      needle: "INSERT OR IGNORE INTO bump_events",
    },
    calledFrom: {
      file: "apps/bot/src/bump.ts",
      needle: "services.bumps.addOnce(",
    },
    wiredFrom: {
      file: "apps/bot/src/index.ts",
      needle: "handleBumpMessage(message, services)",
    },
    kind: "history",
    privacy: "safe",
    // addOnce() が成功BUMPごとに created_at を保存するため、N件目の達成時刻を復元できる。
    orderable: true,
    titleUsable: true,
    epochPolicy: { type: "point", at: "created_at" },
    rawUnit: "successful_bump_event",
  },
  bump_counts: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/rank/bump.ts",
      needle: "INSERT INTO bump_counts",
    },
    calledFrom: {
      file: "apps/bot/src/bump.ts",
      needle: "services.bumps.addOnce(",
    },
    wiredFrom: {
      file: "apps/bot/src/index.ts",
      needle: "handleBumpMessage(message, services)",
    },
    kind: "counter",
    privacy: "safe",
    orderable: false,
    // ランキング・counter baseline機構の監査には使うが、BUMP称号は時刻付きbump_eventsを使う。
    titleUsable: false,
    // baselineで保存してよいmetric名もsource contract側で固定する。
    epochPolicy: { type: "baseline", metrics: ["count"] },
    rawUnit: "cumulative_counter",
  },

  // ── VC derived source層（PR2）────────────────────────────────────
  //
  // raw vc_segments は state segment（mute/deafen変化でも切れる）で titleUsable:false。
  // 個々の称号は必ずここから下のderived sourceを使う。
  vc_visits: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/vc/derived.ts",
      needle: "export function computeLogicalVisits(",
    },
    derivedFrom: ["vc_segments"],
    kind: "history",
    privacy: "safe",
    // VoiceStateUpdateには強い正本時刻が無く、秒精度のtieも起こりうる。
    // 「N人目」等を主張できるsourceへ安易に昇格させない（正本 §8）。
    orderable: false,
    // visit.startedAtは「入室した瞬間」とは限らない（LogicalVisit.startKind参照）。
    // 孤立したstate_change（クラッシュ補正等で前segmentへcoalesceできなかったmute/deafen
    // 変化）から始まった訪問はpartial_observationで、本人は既にそこにいただけ。
    // これをそのまま称号からCOUNTすると「入室回数」を過大に主張してしまうため、
    // vc_visits自体は中間source扱いとし、直接は使わせない。個々の称号は、
    // startKindを踏まえて安全に畳み込まれた下流derived source（vc_social_safe等）を使うこと。
    titleUsable: false,
    epochPolicy: { type: "interval", start: "startedAt", end: "endedAt", clip: true },
    // raw segment の隣接行を1回の訪問へ合成した単位。
    rawUnit: "logical_vc_visit",
  },
  vc_empty_start_then_joined: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/vc/derived.ts",
      needle: "export function computeEmptyStartThenJoined(",
    },
    derivedFrom: ["vc_visits"],
    kind: "history",
    privacy: "safe",
    orderable: false,
    titleUsable: true,
    epochPolicy: { type: "point", at: "joinedAt" },
    // 「誰もいないVCから始まり、後から誰かが入った」という事実のみ。相手のidentityは含まない。
    rawUnit: "empty_start_then_joined_fact",
  },
  vc_last_occupant: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/vc/derived.ts",
      needle: "export function computeLastOccupant(",
    },
    derivedFrom: ["vc_visits"],
    kind: "history",
    privacy: "safe",
    orderable: false,
    titleUsable: true,
    epochPolicy: { type: "point", at: "becameLastAt" },
    // 「他者が退出し、subjectだけが残った」瞬間。相手のidentityは含まない。
    rawUnit: "last_occupant_fact",
  },
  vc_group_size_seconds: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/vc/derived.ts",
      needle: "export function computeGroupSizeSeconds(",
    },
    derivedFrom: ["vc_visits"],
    kind: "history",
    privacy: "safe",
    orderable: false,
    titleUsable: true,
    // 呼び出し側が渡すwindow境界そのものが切り口。行ごとのSQL列ではない。
    epochPolicy: { type: "interval", start: "windowStart", end: "windowEnd", clip: true },
    rawUnit: "group_size_seconds_measurement",
  },
  vc_co_presence: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/vc/derived.ts",
      needle: "export function computeCoPresenceOverlaps(",
    },
    derivedFrom: ["vc_visits"],
    kind: "history",
    privacy: "restricted",
    orderable: false,
    // 生pairwiseは相手のuserIdを含むため称号から直接は使わせない。vc_social_safe を使うこと。
    titleUsable: false,
    epochPolicy: { type: "interval", start: "windowStart", end: "windowEnd", clip: true },
    rawUnit: "pairwise_overlap",
  },
  vc_social_safe: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/vc/derived.ts",
      needle: "export function computeSafeSocialAggregates(",
    },
    derivedFrom: ["vc_co_presence"],
    kind: "history",
    privacy: "safe",
    orderable: false,
    titleUsable: true,
    epochPolicy: { type: "interval", start: "windowStart", end: "windowEnd", clip: true },
    // pair identityを畳み込んだ、本人単位の集計だけ。
    rawUnit: "safe_social_aggregate",
  },
} as const satisfies Record<string, TitleSourceDefinition>;

export type TitleSourceKey = keyof typeof TITLE_SOURCES;
export type TitleUsableSourceKey = {
  [K in TitleSourceKey]: (typeof TITLE_SOURCES)[K]["titleUsable"] extends true ? K : never;
}[TitleSourceKey];

/**
 * derived sourceのdependency chainが、最終的にlive persisted sourceへ到達することを検証する。
 *
 * 未登録keyへの参照・循環参照・persistedで終わらないchainを全部拒否する。
 * パスと関数名の文字列が存在するだけでは「本番で実際に通る」ことの証明として弱い
 * （evaluationsの変形版が再発しうる）ので、依存関係そのものの整合性もここで機械検証する。
 */
export function assertDerivedSourceDependenciesResolve(
  sources: Record<string, TitleSourceDefinition> = TITLE_SOURCES,
): void {
  const resolving = new Set<string>();
  const resolved = new Set<string>();

  const resolve = (key: string, path: readonly string[]): void => {
    if (resolved.has(key)) return;
    const def = sources[key];
    if (!def) {
      throw new Error(`title source dependency references unknown source: ${[...path, key].join(" -> ")}`);
    }
    if (def.origin === "persisted") {
      resolved.add(key);
      return;
    }
    if (resolving.has(key)) {
      throw new Error(`title source dependency cycle detected: ${[...path, key].join(" -> ")}`);
    }
    if (def.derivedFrom.length === 0) {
      throw new Error(`derived title source must declare at least one dependency: ${key}`);
    }
    resolving.add(key);
    for (const dep of def.derivedFrom) resolve(dep, [...path, key]);
    resolving.delete(key);
    resolved.add(key);
  };

  for (const key of Object.keys(sources)) resolve(key, []);
}

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
  sources: readonly TitleUsableSourceKey[];
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
 * TypeScriptを迂回した動的入力でも、旧key・未登録source・監査専用source・隠し完遂混入を通さない。
 */
export function defineTitle<T extends TitleDefinition>(definition: T): T {
  if (!definition.key.startsWith("v2.") || definition.key.length <= 3) {
    throw new Error(`title key must use v2.* namespace: ${definition.key}`);
  }
  if (!definition.catalog.trim()) throw new Error(`title ${definition.key}: catalog is required`);
  if (definition.sources.length === 0) throw new Error(`title ${definition.key}: at least one source is required`);

  for (const source of definition.sources as readonly TitleSourceKey[]) {
    if (!(source in TITLE_SOURCES)) {
      throw new Error(`title ${definition.key}: unregistered source ${String(source)}`);
    }
    const sourceDefinition: TitleSourceDefinition = TITLE_SOURCES[source];
    if (!sourceDefinition.titleUsable) {
      throw new Error(`title ${definition.key}: source is not usable by titles: ${source}`);
    }
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
