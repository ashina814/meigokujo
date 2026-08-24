import type Database from "better-sqlite3";

/**
 * raw vc_segments を、称号条件に安全に使える意味単位へ変換するderived layer。
 *
 * # なぜこの層が要るか
 *
 * raw vc_segments の1行は「1回のVC入室」ではない。VcTracker.open() は入室だけでなく
 * mute/deafen変化やチャンネル移動でも前segmentを閉じて新しい行を作る（vc/service.ts）。
 * したがって `COUNT(vc_segments)` を入室回数と読むと、頻繁にミュートを切り替える人ほど
 * 多く数えてしまう。ここでは隣接segmentを1回の「訪問（logical visit）」へ合成してから
 * 各種factを導出する。
 *
 * # 信頼境界（このファイル全体で守る唯一のルール）
 *
 * **開始時刻（startedAt）は常に信頼できる。** Botが実際にDiscordイベントを観測した瞬間の
 * 記録だから。**終了時刻（endedAt）は `isTrustedVisitEnd()` が true のときだけ信頼できる。**
 * closeAllDangling() の推定終了（'recovered_estimate'）は、Bot停止中に本人がとっくに
 * 退出していた場合には過大評価にも過小評価にもなり得る。上限にも下限にも使えない。
 *
 * 複数ユーザーの訪問を比較して「誰が先か」「誰がまだ居たか」を主張するfact
 * （empty-start-then-joined・last-occupant）は、比較に使う双方の境界が信頼できる場合
 * だけ成立させる。単独ユーザーの合計時間（group-size seconds）のように「主張」ではなく
 * 「計測」であるものも、"trusted" を名乗る数字には信頼できない他者の境界を混ぜない
 * ——他者の終了が信頼できず、記録上の退出時刻より後もまだ居た可能性を否定できない場合、
 * それ以降は人数帯そのものが不確かになるため untrustedSeconds 側へ計上する。
 *
 * 同一秒のtieは「前後関係を証明できない」として安全側（factを作らない）へ倒す。
 * 0秒segment（同一秒での入室即退出等）もarrivalの証拠として保持し、tie判定から消さない。
 *
 * `startedAt` が本物の入室イベントかどうかは `LogicalVisit.startKind` で区別する。
 * 前segmentへcoalesceできなかった孤立state_change（mute/deafen変化）から始まった訪問は
 * 'partial_observation'——本人は既にそこにいて、単に状態変化を再観測しただけなので、
 * 「入室した」「後から来た」等のイベントを主張するfactには使えない。
 *
 * `TitleWindow.end` が未来を指していても、evaluationは `observedAt`（省略時は現在時刻）
 * より先までtrustedとして計上しない。これはopen visitの終了時刻だけの話ではない
 * ——`observedAt` より後に作られた行（別ユーザーの新規入室・後から確定した退室時刻等）は
 * クエリの読み込み段階からそもそも見ない。そうしないと「同じ `observedAt` で再評価すれば
 * 常に同じ結果になる」というreconcileの再現性が壊れる（DBが後から進んでも、過去の
 * `observedAt` 時点の評価結果は変わらないという前提）。
 */

export interface TitleWindow {
  /** inclusive */
  start: number;
  /** exclusive */
  end: number;
  /**
   * このwindowを「実際に見ていた」時刻（省略時は呼び出し時点の現在時刻）。
   *
   * `effectiveEnd = min(end, observedAt)` が、クエリの読み込み境界・open visitの打ち切り・
   * 全ての結果clippingに共通して使われる上限になる——`end` だけでなく `observedAt` も
   * 一度resolveした上でクエリそのものに反映するのはこのため。`end` はカタログ施行境界
   * （「今月」「今日」等）から機械的に作られることが多く、未来を指し得る。`observedAt` は
   * 「実際にはここまでしか見ていない」という上限を明示し、同じ `observedAt` で再評価すれば
   * DBが後から進んでも常に同じ結果になることを保証する。
   */
  observedAt?: number;
}

export type LogicalVisitEndQuality = "observed" | "recovered_estimate" | "unknown" | "open";

/**
 * このvisitのstartedAtが「入室した瞬間」を意味するか。
 *
 * - 'arrival': 最初のraw segmentがjoin/moveで始まった。本物の入室（またはチャンネル移動）
 * - 'partial_observation': 最初のraw segmentがstate_change（mute/deafen変化）で始まった
 *   ——前のsegmentへcoalesceできなかった孤立state_change。本人は既にそこにいて、
 *   単に状態変化を再観測しただけ。startedAtを「入室した瞬間」として扱ってはいけない
 *   （典型例: クラッシュ復旧の推定終了(recovered_estimate)後、しばらく経ってから
 *   mute操作があり、そこが新しいvisitの先頭になった場合）
 * - 'unknown': 最初のraw segmentがstart_reason未設定（列追加前のlegacy行）
 */
export type LogicalVisitStartKind = "arrival" | "partial_observation" | "unknown";

export interface LogicalVisit {
  userId: string;
  channelId: string;
  parentId: string | null;
  startedAt: number;
  /** windowでclipされた値。open visitはwindow.endで打ち切られる。 */
  endedAt: number;
  endQuality: LogicalVisitEndQuality;
  /** coalesceされたraw segment数（診断用）。 */
  segmentCount: number;
  /**
   * trueなら、実際の開始はwindow.startより前で、startedAtはwindowの端で切っただけ。
   * 「window内で入室した」「空VCへ最初に入った」等の**開始イベント**として扱ってはいけない
   * ——window境界と一致しているだけで、本当にその瞬間に起きた出来事ではないため。
   * 継続時間の計測（fact E）や「その時点で在室していたか」の下限（fact D）には使ってよい。
   */
  startClipped: boolean;
  /**
   * startedAtが本物の入室イベントか（`LogicalVisitStartKind`参照）。
   * 「入室した」「空VCへ最初に来た」等のイベントを主張するfactは 'arrival' のときだけ
   * 使ってよい。滞在時間の計測や「その時点で在室していたか」の確認には影響しない
   * ——partial_observationでも、その時点に在室していたこと自体は事実のため。
   */
  startKind: LogicalVisitStartKind;
}

/** 終了時刻を「主張」の根拠として使ってよいか。'recovered_estimate' と 'unknown' は使えない。 */
export function isTrustedVisitEnd(quality: LogicalVisitEndQuality): boolean {
  return quality === "observed" || quality === "open";
}

function clampWindow(window: TitleWindow): void {
  if (!Number.isInteger(window.start) || !Number.isInteger(window.end) || window.start >= window.end) {
    throw new RangeError(`invalid title window: [${window.start}, ${window.end})`);
  }
  if (window.observedAt !== undefined && !Number.isInteger(window.observedAt)) {
    throw new RangeError(`invalid title window: observedAt must be an integer unix timestamp`);
  }
}

const now = (): number => Math.floor(Date.now() / 1000);

/**
 * `observedAt`（省略時はnow()）を**1回だけ**解決し、そのeffectiveEndをクエリ・coalesce・
 * clippingの全段で一貫して使う。呼び出しのたびにnow()を評価し直すと、大量のopen visitを
 * 処理する間に秒境界をまたぎ、同じ1回の集計内でユーザーごとに違う打ち切り時刻を持って
 * しまう（Aliceは14:00:00、Bobは14:00:01、など）。exported関数の入口で1回だけ呼ぶこと。
 */
interface ResolvedWindow {
  start: number;
  /** = min(元のwindow.end, 解決済みobservedAt) */
  end: number;
  /**
   * trueなら、endを決めた側はobservedAt（＝ここから先はまだ観測していない未来かもしれない）。
   * falseなら呼び出し側が明示的に選んだwindow.end側（データ自体は既知で、単なるscope制限）。
   * coalesceVisits()が「実データの終了はendedAtだが観測境界より後」を'open'として扱うかの
   * 判定に使う——観測境界による打ち切りなら'open'、単なるscope制限による打ち切りなら
   * 元のend_qualityを保つ（既存のwindow.endクリッピングの意味を変えないため）。
   */
  observationLimited: boolean;
}

function resolveWindow(window: TitleWindow): ResolvedWindow {
  clampWindow(window);
  const resolvedObservedAt = window.observedAt ?? now();
  return {
    start: window.start,
    end: Math.min(window.end, resolvedObservedAt),
    // 同値ならobservedAt側とみなす（安全側）
    observationLimited: resolvedObservedAt <= window.end,
  };
}

interface RawSegmentRow {
  id: number;
  user_id: string;
  channel_id: string;
  parent_id: string | null;
  started_at: number;
  ended_at: number | null;
  end_quality: "observed" | "recovered_estimate" | null;
  start_reason: "join" | "move" | "state_change" | null;
}

/**
 * userIds引数の契約: `undefined` = 全ユーザー対象。`[]`（空配列）= 対象ユーザーなし
 * （何も返さない）。空配列を「絞り込みなし」と誤解すると、呼び出し側が意図せず
 * 全ユーザーのデータを受け取ってしまう事故になるため、明示的に空配列を弾く。
 */
function loadRawSegments(
  db: Database.Database,
  window: ResolvedWindow,
  userIds?: readonly string[],
): RawSegmentRow[] {
  if (userIds && userIds.length === 0) return [];
  const params: unknown[] = [window.end, window.start, window.start];
  let sql = `
    SELECT id, user_id, channel_id, parent_id, started_at, ended_at, end_quality, start_reason
    FROM vc_segments
    WHERE started_at < ?
      -- 通常の半開区間overlapは ended_at > window.start。ただし0秒segment
      -- （started_at===ended_at、同一秒での入室即退出等）はこの式だとended_at>window.startが
      -- 常に偽になり、window.startちょうどの0秒segmentが取り逃がされる。arrivalの証拠を
      -- 消さないため、0秒segmentはstarted_atがwindow内なら明示的に拾う。
      AND (ended_at IS NULL OR ended_at > ? OR (ended_at = started_at AND ended_at >= ?))
  `;
  if (userIds) {
    sql += ` AND user_id IN (${userIds.map(() => "?").join(",")})`;
    params.push(...userIds);
  }
  sql += " ORDER BY user_id, started_at, id";
  return db.prepare(sql).all(...params) as RawSegmentRow[];
}

function loadRawSegmentsForChannels(
  db: Database.Database,
  window: ResolvedWindow,
  channelIds: readonly string[],
): RawSegmentRow[] {
  if (channelIds.length === 0) return [];
  const uniqueChannelIds = [...new Set(channelIds)];
  const rows: RawSegmentRow[] = [];
  for (let i = 0; i < uniqueChannelIds.length; i += VC_CHANNEL_QUERY_CHUNK_SIZE) {
    const chunk = uniqueChannelIds.slice(i, i + VC_CHANNEL_QUERY_CHUNK_SIZE);
    const sql = `
      SELECT id, user_id, channel_id, parent_id, started_at, ended_at, end_quality, start_reason
      FROM vc_segments
      WHERE started_at < ?
        -- loadRawSegments()と同じ0秒segment救済（arrivalの証拠を取り逃がさないため）
        AND (ended_at IS NULL OR ended_at > ? OR (ended_at = started_at AND ended_at >= ?))
        AND channel_id IN (${chunk.map(() => "?").join(",")})
      ORDER BY user_id, started_at, id
    `;
    rows.push(...(db.prepare(sql).all(window.end, window.start, window.start, ...chunk) as RawSegmentRow[]));
  }

  // chunkごとのORDER BYだけではcoalesceVisits()の前提を満たさない。全chunkをmergeした後に
  // user_id → started_at → idのcode-unit/数値順へ戻し、非chunk版と同じ意味を保つ。
  rows.sort((a, b) => {
    if (a.user_id < b.user_id) return -1;
    if (a.user_id > b.user_id) return 1;
    return a.started_at - b.started_at || a.id - b.id;
  });
  return rows;
}

/** SQLite bind上限へ近づく巨大なchannel IN句を作らない。 */
const VC_CHANNEL_QUERY_CHUNK_SIZE = 300;

/**
 * rowから直接logical visitsを合成する。呼び出し側は既に必要な行をロード済みという前提。
 * 行は user_id, started_at, id 順（loadRawSegments系が保証する）。windowは
 * `resolveWindow()` 済みのものを渡すこと（呼び出しのたびにnow()を評価し直さないため）。
 */
function coalesceVisits(rows: readonly RawSegmentRow[], window: ResolvedWindow): LogicalVisit[] {
  const visits: LogicalVisit[] = [];

  type Open = {
    userId: string;
    channelId: string;
    parentId: string | null;
    startedAt: number;
    startKind: LogicalVisitStartKind;
    lastEndedAt: number | null;
    lastEndQuality: RawSegmentRow["end_quality"];
    segmentCount: number;
  };
  let current: Open | null = null;

  const flush = () => {
    if (!current) return;
    let endedAt: number;
    let endQuality: LogicalVisitEndQuality;
    // まだ開いている、または実データの終了が観測境界（=resolved window.end）より後——
    // どちらにせよ、これより先は「実際に観測できていない」ため、window.endで打ち切って
    // trusted 'open' として扱う。window.endがscope制限（呼び出し側が明示的に選んだend）
    // 側で決まっている場合は、実データの終了自体は既知なので元のend_qualityを保つ
    // （既存の「windowでscopeを絞るとclipされる」挙動を変えないため）。
    const truncatedByObservation =
      current.lastEndedAt === null || (window.observationLimited && current.lastEndedAt > window.end);
    if (truncatedByObservation) {
      endedAt = window.end;
      endQuality = "open";
    } else if (current.lastEndQuality === "observed") {
      endedAt = current.lastEndedAt!;
      endQuality = "observed";
    } else if (current.lastEndQuality === "recovered_estimate") {
      endedAt = current.lastEndedAt!;
      endQuality = "recovered_estimate";
    } else {
      // legacy行（end_quality列追加前にclosedになった行）。品質不明のまま扱う。
      endedAt = current.lastEndedAt!;
      endQuality = "unknown";
    }

    const startClipped = current.startedAt < window.start;
    const startedAt = Math.max(current.startedAt, window.start);
    const clippedEnded = Math.min(endedAt, window.end);
    // 0秒segment（同一秒での入室即退出等）も捨てない。滞在時間としては無意味でも、
    // 「その瞬間、確かにここにいた」というarrival証拠そのものは保持する——これを消すと、
    // 同一秒に別の人が「空VCへ入った」と誤って主張できてしまう（fact C参照）。
    if (clippedEnded >= startedAt) {
      visits.push({
        userId: current.userId,
        channelId: current.channelId,
        parentId: current.parentId,
        startedAt,
        endedAt: clippedEnded,
        endQuality,
        segmentCount: current.segmentCount,
        startClipped,
        startKind: current.startKind,
      });
    }
    current = null;
  };

  for (const row of rows) {
    // 行は user_id → started_at → id の順に並んでいるので、同一userの行は必ず連続する。
    //
    // 合成してよいのは「同一チャンネル内のmute/deafen状態変化」だけ。時刻の一致だけでは
    // 判定しない——同一秒での「退出→再入室」も前segmentの終了時刻と新segmentの開始時刻が
    // 一致してしまい、時刻だけを見ると状態変化と区別がつかない。start_reasonという
    // provenanceで区別する: 新しい行が 'state_change'（切断を経ていない）であり、かつ
    // 直前segmentが 'observed' で閉じている場合だけ継続とみなす。
    //
    // 直前segmentが 'recovered_estimate'（クラッシュ補正の推定終了）のときは合成しない。
    // 合成してしまうと、そのvisit全体の endQuality は最終segmentの品質だけで決まるため、
    // 途中に挟まった推定区間が"洗浄"されてobservedへ格上げされてしまう。
    const continuesCurrent =
      current !== null &&
      current.userId === row.user_id &&
      current.channelId === row.channel_id &&
      current.lastEndedAt === row.started_at &&
      row.start_reason === "state_change" &&
      current.lastEndQuality === "observed";

    if (continuesCurrent && current) {
      current.lastEndedAt = row.ended_at;
      current.lastEndQuality = row.end_quality;
      current.segmentCount += 1;
    } else {
      flush();
      // このrowが新しいvisitの先頭になる。start_reasonがjoin/moveなら本物の入室（arrival）。
      // state_changeがここに来るのは「前segmentへcoalesceできなかった孤立state_change」の
      // 場合だけ（continuesCurrentの条件を参照）——つまり本人は既にそこにいて、単に状態
      // 変化を再観測しただけなので、startedAtを入室イベントとして扱ってはいけない
      // （partial_observation）。legacy行（start_reason未設定）はunknown。
      const startKind: LogicalVisitStartKind =
        row.start_reason === "join" || row.start_reason === "move"
          ? "arrival"
          : row.start_reason === "state_change"
            ? "partial_observation"
            : "unknown";
      current = {
        userId: row.user_id,
        channelId: row.channel_id,
        parentId: row.parent_id,
        startedAt: row.started_at,
        startKind,
        lastEndedAt: row.ended_at,
        lastEndQuality: row.end_quality,
        segmentCount: 1,
      };
    }
  }
  flush();

  return visits;
}

/**
 * A. logical visits。
 * raw vc_segments の隣接segment（同一user・同一channel・時刻が連続）を1訪問へ合成する。
 * 単純に user_id + channel_id で GROUP BY してはいけない
 * （退出→再入室が同じチャンネルなら誤って1訪問に潰れてしまう）。
 */
function computeLogicalVisitsResolved(
  db: Database.Database,
  resolved: ResolvedWindow,
  userIds?: readonly string[],
): LogicalVisit[] {
  const rows = loadRawSegments(db, resolved, userIds);
  return coalesceVisits(rows, resolved);
}

export function computeLogicalVisits(
  db: Database.Database,
  window: TitleWindow,
  userIds?: readonly string[],
): LogicalVisit[] {
  return computeLogicalVisitsResolved(db, resolveWindow(window), userIds);
}

/**
 * 指定channel群のlogical visitをまとめて読む、他domainのderived source向けmodule helper。
 * raw segmentの再実装を防ぎ、通常のlogical visitと同じcoalesce・observedAt・300-channel
 * chunk契約を共有する。公開title payloadへchannel/user identityをそのまま出してはならない。
 */
export function computeLogicalVisitsForChannels(
  db: Database.Database,
  window: TitleWindow,
  channelIds: readonly string[],
): LogicalVisit[] {
  const resolved = resolveWindow(window);
  return coalesceVisits(loadRawSegmentsForChannels(db, resolved, channelIds), resolved);
}

// ─────────────────────────────────────────────────────────────
// C. empty-start → later joined
// ─────────────────────────────────────────────────────────────

export interface EmptyStartThenJoinedFact {
  userId: string;
  channelId: string;
  visitStartedAt: number;
  /** 別のuserが入室してきた時刻。 */
  joinedAt: number;
}

/**
 * 「誰もいないVCから始まり、その後別の誰かが入ってきた」という事実だけを返す。
 * 誰が来たか（identity）・因果（呼び込んだ、人気がある等）は一切主張しない。
 *
 * 成立条件:
 * - subjectの訪問**開始そのものがwindow内の本物の入室イベント**であること
 *   （window開始前から継続していた訪問をclipしただけのものは開始イベントとして数えない
 *   `startClipped`。孤立したstate_changeから始まった訪問も本物の入室ではない
 *   `startKind !== 'arrival'`）
 * - subjectの訪問開始時、他の誰の訪問もその瞬間を覆っていない（tie含めて厳密に除外）
 * - subjectの訪問の終了が信頼できる（'observed' または 'open'）
 *   → 信頼できない終了時刻を「まだ居た」の根拠にしない
 * - 他者の訪問開始が、subjectの開始より厳密に後、終了より前、かつ**本物の入室イベント**
 *   であること（孤立state_changeを「後から人が来た」と読まない）
 */
export function computeEmptyStartThenJoined(
  db: Database.Database,
  window: TitleWindow,
  userIds?: readonly string[],
): EmptyStartThenJoinedFact[] {
  const resolved = resolveWindow(window);
  const subjectVisits = computeLogicalVisitsResolved(db, resolved, userIds);
  if (subjectVisits.length === 0) return [];

  const channelIds = [...new Set(subjectVisits.map((v) => v.channelId))];
  const allRows = loadRawSegmentsForChannels(db, resolved, channelIds);
  const allVisits = coalesceVisits(allRows, resolved);
  const byChannel = groupByChannel(allVisits);

  const facts: EmptyStartThenJoinedFact[] = [];
  for (const subject of subjectVisits) {
    if (subject.startClipped) continue;
    if (subject.startKind !== "arrival") continue;
    if (!isTrustedVisitEnd(subject.endQuality)) continue;

    const others = (byChannel.get(subject.channelId) ?? []).filter(
      (v) => !(v.userId === subject.userId && v.startedAt === subject.startedAt),
    );

    // 「空だった」と主張するには、subjectの開始時点で在室していた可能性がある他者が
    // 誰もいないと言い切れる必要がある。
    // - o.startedAt === subject.startedAt（同一秒tie）は前後関係を証明できない
    //   （0秒segmentも含む——arrivalの証拠自体はcoalesceVisitsが保持している）
    // - o.startedAt < subject.startedAt かつ o.endedAt > subject.startedAt なら
    //   記録上も明確に在室中（空ではない）
    // - o.endedAt <= subject.startedAt でも、oの終了が信頼できない（recovered_estimate等）
    //   なら「本当にその前に退出していた」とは証明できない。空だったと断定できない
    const notEmptyOrAmbiguous = others.some((o) => {
      if (o.startedAt === subject.startedAt) return true;
      if (o.startedAt > subject.startedAt) return false;
      if (o.endedAt > subject.startedAt) return true;
      return !isTrustedVisitEnd(o.endQuality);
    });
    if (notEmptyOrAmbiguous) continue;

    // 「後から人が来た」と主張できるのは、その相手も本物の入室イベントのときだけ。
    // 孤立state_change（既にそこにいた人を再観測しただけ）を「入ってきた」と読まない。
    const laterJoin = others
      .filter((o) => o.startKind === "arrival" && o.startedAt > subject.startedAt && o.startedAt < subject.endedAt)
      .sort((a, b) => a.startedAt - b.startedAt)[0];
    if (!laterJoin) continue;

    facts.push({
      userId: subject.userId,
      channelId: subject.channelId,
      visitStartedAt: subject.startedAt,
      joinedAt: laterJoin.startedAt,
    });
  }
  return facts;
}

// ─────────────────────────────────────────────────────────────
// D. last occupant
// ─────────────────────────────────────────────────────────────

export interface LastOccupantFact {
  userId: string;
  channelId: string;
  /** 直前まで居た他者が退出し、subjectだけが残った時刻。 */
  becameLastAt: number;
}

/**
 * 「occupancyが2以上だったVCで、他者が退出し、subjectだけが残った」瞬間を返す。
 *
 * 成立条件:
 * - 退出した他者の終了が信頼できる（そうでなければ「本当にその瞬間に退出した」と言えない）
 * - subjectの開始がその瞬間以前、終了がその瞬間より後（subjectの終了も信頼できること）
 * - 第三者がその瞬間を覆っていない。ただし第三者の終了が信頼できない場合、
 *   「もう居なかった」と決めつけず、安全側に倒してfactを作らない
 * - 最初から1人きりの訪問（元々occupancy 1）は対象外
 */
export function computeLastOccupant(
  db: Database.Database,
  window: TitleWindow,
  userIds?: readonly string[],
): LastOccupantFact[] {
  const resolved = resolveWindow(window);
  const subjectVisits = computeLogicalVisitsResolved(db, resolved, userIds);
  if (subjectVisits.length === 0) return [];

  const channelIds = [...new Set(subjectVisits.map((v) => v.channelId))];
  const allRows = loadRawSegmentsForChannels(db, resolved, channelIds);
  const allVisits = coalesceVisits(allRows, resolved);
  const byChannel = groupByChannel(allVisits);

  const facts: LastOccupantFact[] = [];
  for (const subject of subjectVisits) {
    if (!isTrustedVisitEnd(subject.endQuality)) continue;

    const channelVisits = byChannel.get(subject.channelId) ?? [];
    // channelVisits は別クエリ由来なのでsubjectとは別オブジェクト。userIdで自分自身を除く。
    const others = channelVisits.filter((v) => v.userId !== subject.userId);

    // subjectと重なった他者ごとに「退出時刻」を候補にする
    const departureCandidates = others.filter(
      (o) => isTrustedVisitEnd(o.endQuality) && o.startedAt < o.endedAt && o.endedAt > subject.startedAt && o.endedAt < subject.endedAt,
    );

    for (const departing of departureCandidates) {
      const t = departing.endedAt;
      // subjectがtの時点で在室していること（開始は常に信頼できるので startedAt<=t だけ見ればよい）
      if (subject.startedAt > t) continue;

      // tの瞬間、departing以外の第三者が覆っていないこと。
      // 第三者の終了が信頼できず「まだ居たかもしれない」場合は安全側でfactを作らない。
      const thirdPartyPresentOrAmbiguous = others.some((o) => {
        if (o === departing) return false;
        // 同一秒tie: oのstartedAtがdepartingのendedAtと同じ秒なら、「departingが抜けた後に
        // oが来た」のか「oが来た後にdepartingが抜けた」のか秒精度では前後関係を証明できない
        // ——0秒visit（o.startedAt===o.endedAt）でもarrival/observationの証拠として保持した
        // まま、ambiguousとして安全側でfactを作らない。startKindによらずブロックする
        // （partial_observationも「その人が既に居た可能性」を否定できないため対象）。
        if (o.startedAt === t) return true;
        const coversInstant = o.startedAt <= t && o.endedAt > t;
        if (coversInstant) return true;
        // 終了が信頼できず、tより後で終わっていた可能性を否定できない
        if (!isTrustedVisitEnd(o.endQuality) && o.startedAt <= t) return true;
        return false;
      });
      if (thirdPartyPresentOrAmbiguous) continue;

      facts.push({ userId: subject.userId, channelId: subject.channelId, becameLastAt: t });
      break; // subjectごとに最初に見つかった遷移だけを1factとする
    }
  }
  return facts;
}

function groupByChannel(visits: readonly LogicalVisit[]): Map<string, LogicalVisit[]> {
  const map = new Map<string, LogicalVisit[]>();
  for (const v of visits) {
    const list = map.get(v.channelId);
    if (list) list.push(v);
    else map.set(v.channelId, [v]);
  }
  return map;
}

// ─────────────────────────────────────────────────────────────
// E. group-size style（人数帯ごとの滞在秒数）
// ─────────────────────────────────────────────────────────────

export type OccupancyBucket = "solo" | "oneToOne" | "smallGroup" | "largeGroup";

export interface GroupSizeSeconds {
  userId: string;
  trustedSecondsByBucket: Record<OccupancyBucket, number>;
  /** 終了が信頼できない訪問の合計秒数。bucket化しない。 */
  untrustedSeconds: number;
}

export interface GroupSizeDailySeconds {
  userId: string;
  days: Array<{
    /** JST暦日（YYYY-MM-DD）。 */
    date: string;
    trustedSecondsByBucket: Record<OccupancyBucket, number>;
  }>;
}

interface TrustedGroupSizeSlice {
  start: number;
  end: number;
  bucket: OccupancyBucket;
}

interface GroupSizeTimeline {
  userId: string;
  trustedSlices: TrustedGroupSizeSlice[];
  untrustedSeconds: number;
}

function bucketFor(occupancy: number): OccupancyBucket {
  if (occupancy <= 1) return "solo";
  if (occupancy === 2) return "oneToOne";
  if (occupancy <= 4) return "smallGroup";
  return "largeGroup";
}

/**
 * userごとに、人数帯（solo/1:1/小人数/大人数）ごとの滞在秒数を集計する。
 *
 * 本人の滞在秒数として計上してよいかどうかは、まず本人の訪問の終了が信頼できるかで判定する。
 * それに加えて、`trustedSecondsByBucket` を名乗る以上は**人数帯の判定そのもの**も信頼できな
 * ければならない。他者の終了が信頼できない（recovered_estimate等）区間は、その他者が記録上
 * 居なくなったように見える時刻以降も本当は居たかもしれず、occupancyの帯自体が不確かになる。
 * そのため、そのような他者が現れて以降のsubject残り区間は bucket化せず untrustedSeconds へ
 * 計上する（trustedと名乗る数字に、実は信頼できない他者由来の人数を混ぜない）。
 */
function computeGroupSizeTimelineResolved(
  db: Database.Database,
  resolved: ResolvedWindow,
  userIds?: readonly string[],
): GroupSizeTimeline[] {
  const subjectVisits = computeLogicalVisitsResolved(db, resolved, userIds);
  if (subjectVisits.length === 0) return [];

  const channelIds = [...new Set(subjectVisits.map((v) => v.channelId))];
  const allRows = loadRawSegmentsForChannels(db, resolved, channelIds);
  const allVisits = coalesceVisits(allRows, resolved);
  const byChannel = groupByChannel(allVisits);

  const results = new Map<string, GroupSizeTimeline>();
  const ensure = (userId: string): GroupSizeTimeline => {
    let r = results.get(userId);
    if (!r) {
      r = {
        userId,
        trustedSlices: [],
        untrustedSeconds: 0,
      };
      results.set(userId, r);
    }
    return r;
  };

  for (const subject of subjectVisits) {
    const r = ensure(subject.userId);
    if (!isTrustedVisitEnd(subject.endQuality)) {
      r.untrustedSeconds += subject.endedAt - subject.startedAt;
      continue;
    }

    const channelVisits = byChannel.get(subject.channelId) ?? [];

    // 「人数帯」そのものが不明になる境界を求める。他者(o)の終了が信頼できず、かつ
    // oがsubjectの訪問が終わる前に始まっている場合、oの本当の退出時刻は分からない
    // （記録上のendedAtより後だった可能性を否定できない）。その時点以降は
    // subjectの残り区間すべてでoccupancyが不確かになる——記録上oが居なくなった
    // ように見える区間でも、実際にはまだ居たかもしれないため。
    // 複数の汚染源があれば、最も早いものが以降すべてを汚す。
    let taintFrom: number | null = null;
    for (const v of channelVisits) {
      if (v.userId === subject.userId) continue;
      if (isTrustedVisitEnd(v.endQuality)) continue;
      if (v.startedAt >= subject.endedAt) continue;
      const start = Math.max(v.startedAt, subject.startedAt);
      if (taintFrom === null || start < taintFrom) taintFrom = start;
    }
    const trustedUntil = taintFrom ?? subject.endedAt;

    if (trustedUntil < subject.endedAt) {
      r.untrustedSeconds += subject.endedAt - trustedUntil;
    }

    const boundaries = new Set<number>([subject.startedAt, trustedUntil]);
    for (const v of channelVisits) {
      if (v.startedAt > subject.startedAt && v.startedAt < trustedUntil) boundaries.add(v.startedAt);
      if (v.endedAt > subject.startedAt && v.endedAt < trustedUntil) boundaries.add(v.endedAt);
    }
    const points = [...boundaries].sort((a, b) => a - b);

    for (let i = 0; i < points.length - 1; i++) {
      const sliceStart = points[i]!;
      const sliceEnd = points[i + 1]!;
      if (sliceEnd <= sliceStart) continue;
      // channelVisits は subject自身の写しも含む（同一channelの全visitを取得しているため）。
      // subjectの訪問区間内なので occupancy は常に1以上になる。
      const occupancy = channelVisits.filter((v) => v.startedAt <= sliceStart && v.endedAt > sliceStart).length;
      r.trustedSlices.push({ start: sliceStart, end: sliceEnd, bucket: bucketFor(occupancy) });
    }
  }

  return [...results.values()];
}

export function computeGroupSizeSeconds(
  db: Database.Database,
  window: TitleWindow,
  userIds?: readonly string[],
): GroupSizeSeconds[] {
  return computeGroupSizeTimelineResolved(db, resolveWindow(window), userIds).map((timeline) => {
    const trustedSecondsByBucket: Record<OccupancyBucket, number> = {
      solo: 0,
      oneToOne: 0,
      smallGroup: 0,
      largeGroup: 0,
    };
    for (const slice of timeline.trustedSlices) {
      trustedSecondsByBucket[slice.bucket] += slice.end - slice.start;
    }
    return { userId: timeline.userId, trustedSecondsByBucket, untrustedSeconds: timeline.untrustedSeconds };
  });
}

/**
 * canonical trusted group-size sliceをJST暦日へだけ分割するthreshold-neutral source。
 * active-day/share/span/streak等の判定値はここでは選ばず、日付と4bucket秒だけを返す。
 */
export function computeGroupSizeDailySeconds(
  db: Database.Database,
  window: TitleWindow,
  userIds?: readonly string[],
): GroupSizeDailySeconds[] {
  return computeGroupSizeTimelineResolved(db, resolveWindow(window), userIds).map((timeline) => {
    const byDate = new Map<string, Record<OccupancyBucket, number>>();
    for (const slice of timeline.trustedSlices) {
      for (const part of splitIntervalByJstDay(slice.start, slice.end)) {
        let buckets = byDate.get(part.date);
        if (!buckets) {
          buckets = { solo: 0, oneToOne: 0, smallGroup: 0, largeGroup: 0 };
          byDate.set(part.date, buckets);
        }
        buckets[slice.bucket] += part.seconds;
      }
    }
    return {
      userId: timeline.userId,
      days: [...byDate].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([date, trustedSecondsByBucket]) => ({
        date,
        trustedSecondsByBucket,
      })),
    };
  });
}

// ─────────────────────────────────────────────────────────────
// B / F. co-presence（生pairwiseはrestricted、集計だけsafe）
// ─────────────────────────────────────────────────────────────

export interface TrustedCoPresenceSlice {
  /** userA < userB。raw counterpart identityを含むrestricted internal primitive。 */
  readonly userA: string;
  readonly userB: string;
  /** canonical logical visit同士がpositive durationで重なるtrusted [startedAt, endedAt)。 */
  readonly startedAt: number;
  readonly endedAt: number;
}

export interface CoPresenceOverlap {
  /** userA < userB に正規化する。生の相手identityを含むため privacy: restricted。 */
  userA: string;
  userB: string;
  overlapSeconds: number;
  /** 重なりが生じたdistinct JST日（Asia/Tokyo）。 */
  jstDays: readonly string[];
}

const JST_OFFSET_SEC = 9 * 3600;

/** unix秒 → JST暦日（YYYY-MM-DD）。entry/sessions.ts の jstDateStr と同じ考え方。 */
function jstDateOf(ts: number): string {
  return new Date((ts + JST_OFFSET_SEC) * 1000).toISOString().slice(0, 10);
}

/** JST暦日の 00:00 に対応するunix秒。 */
function jstDayStartUnix(dateStr: string): number {
  return Math.floor(new Date(`${dateStr}T00:00:00+09:00`).getTime() / 1000);
}

export function splitIntervalByJstDay(startedAt: number, endedAt: number): Array<{ date: string; seconds: number }> {
  const parts: Array<{ date: string; seconds: number }> = [];
  let cursor = startedAt;
  let guard = 0;
  const SANITY_LIMIT_DAYS = 365 * 100;
  while (cursor < endedAt) {
    if (guard >= SANITY_LIMIT_DAYS) {
      throw new RangeError(
        `splitIntervalByJstDay: interval [${startedAt}, ${endedAt}) spans more than ${SANITY_LIMIT_DAYS} days — likely a bug, not a legitimate title window`,
      );
    }
    const date = jstDateOf(cursor);
    const partEnd = Math.min(endedAt, jstDayStartUnix(date) + 86_400);
    parts.push({ date, seconds: partEnd - cursor });
    cursor = partEnd;
    guard += 1;
  }
  return parts;
}

/**
 * canonical [start,end) intervalをJSTの暦日×hourへ分割する。24 hour binは称号threshold
 * ではなくprivacy-safeなmeasurement resolutionであり、秒ごとのloopは行わない。
 */
export function splitIntervalByJstHour(
  startedAt: number,
  endedAt: number,
): Array<{ date: string; hour: number; seconds: number }> {
  const parts: Array<{ date: string; hour: number; seconds: number }> = [];
  let cursor = startedAt;
  let guard = 0;
  const SANITY_LIMIT_HOURS = 24 * 365 * 100;
  while (cursor < endedAt) {
    if (guard >= SANITY_LIMIT_HOURS) {
      throw new RangeError(
        `splitIntervalByJstHour: interval [${startedAt}, ${endedAt}) spans more than ${SANITY_LIMIT_HOURS} hours — likely a bug, not a legitimate title window`,
      );
    }
    const shifted = cursor + JST_OFFSET_SEC;
    const hourStart = Math.floor(shifted / 3600) * 3600 - JST_OFFSET_SEC;
    const iso = new Date(shifted * 1000).toISOString();
    const partEnd = Math.min(endedAt, hourStart + 3600);
    parts.push({ date: iso.slice(0, 10), hour: Number(iso.slice(11, 13)), seconds: partEnd - cursor });
    cursor = partEnd;
    guard += 1;
  }
  return parts;
}

/**
 * [startedAt, endedAt) が触れるdistinct JST暦日を列挙する。秒単位では舐めず、日境界だけ進む。
 *
 * cursorはループのたびに厳密に翌日の00:00（JST）へ進むため、無限ループにはなり得ない
 * （高々 ceil((endedAt-startedAt)/86400)+1 回で終端に達する）。全時代titleがwindowに
 * 数年を渡すような場合でも黙って打ち切らない——`maxRepeatedDaysWithOneCounterpart` の
 * ような集計を静かに過小評価すると、原因不明のまま称号判定がずれる。ここでは異常な
 * 長さ（100年超）だけを実装バグの兆候として明示的に落とす。
 */
function jstDatesInInterval(startedAt: number, endedAt: number): string[] {
  return splitIntervalByJstDay(startedAt, endedAt).map((part) => part.date);
}

/**
 * canonical logical VC visitからtemporal JOIN可能なrestricted pair sliceを作る。
 * 両側のtrusted end、positive duration、requested subject filteringは
 * computeCoPresenceOverlapsと同じ不変条件を使う。
 */
export function computeTrustedCoPresenceSlices(
  db: Database.Database,
  window: TitleWindow,
  userIds?: readonly string[],
): TrustedCoPresenceSlice[] {
  const resolved = resolveWindow(window);
  const subjectVisits = computeLogicalVisitsResolved(db, resolved, userIds);
  if (subjectVisits.length === 0) return [];
  const channelIds = [...new Set(subjectVisits.map((visit) => visit.channelId))];
  const allRows = loadRawSegmentsForChannels(db, resolved, channelIds);
  const allVisits = coalesceVisits(allRows, resolved);
  const byChannel = groupByChannel(allVisits);
  const subjectSet = userIds ? new Set(userIds) : null;
  const slices: TrustedCoPresenceSlice[] = [];

  for (const visits of byChannel.values()) {
    for (let i = 0; i < visits.length; i++) {
      for (let j = i + 1; j < visits.length; j++) {
        const first = visits[i]!;
        const second = visits[j]!;
        if (first.userId === second.userId) continue;
        if (subjectSet && !subjectSet.has(first.userId) && !subjectSet.has(second.userId)) continue;
        if (!isTrustedVisitEnd(first.endQuality) || !isTrustedVisitEnd(second.endQuality)) continue;
        const startedAt = Math.max(first.startedAt, second.startedAt);
        const endedAt = Math.min(first.endedAt, second.endedAt);
        if (endedAt <= startedAt) continue;
        const [userA, userB] = first.userId < second.userId
          ? [first.userId, second.userId]
          : [second.userId, first.userId];
        slices.push({ userA, userB, startedAt, endedAt });
      }
    }
  }
  return slices.sort((a, b) =>
    a.userA.localeCompare(b.userA)
    || a.userB.localeCompare(b.userB)
    || a.startedAt - b.startedAt
    || a.endedAt - b.endedAt);
}

/**
 * pairwiseの重なりを求める。**この結果を公開称号の説明文へそのまま出さない**
 * （相手のuserIdが乗っているため privacy: restricted）。
 *
 * 重なり秒数は「主張」ではなく「計測」だが、どちらか一方の終了が信頼できない場合は
 * 数えない（拘束境界が不確かな計測を安全側で除外する）。
 */
export function computeCoPresenceOverlaps(
  db: Database.Database,
  window: TitleWindow,
  userIds?: readonly string[],
): CoPresenceOverlap[] {
  const resolved = resolveWindow(window);
  const subjectVisits = computeLogicalVisitsResolved(db, resolved, userIds);
  if (subjectVisits.length === 0) return [];

  const channelIds = [...new Set(subjectVisits.map((v) => v.channelId))];
  const allRows = loadRawSegmentsForChannels(db, resolved, channelIds);
  const allVisits = coalesceVisits(allRows, resolved);
  const byChannel = groupByChannel(allVisits);

  const subjectSet = userIds ? new Set(userIds) : null;
  const pairSeconds = new Map<string, { a: string; b: string; seconds: number; days: Set<string> }>();

  for (const [, visits] of byChannel) {
    for (let i = 0; i < visits.length; i++) {
      for (let j = i + 1; j < visits.length; j++) {
        const v1 = visits[i]!;
        const v2 = visits[j]!;
        if (v1.userId === v2.userId) continue;
        // 少なくとも一方がリクエストされたuserであること（userIds指定時）
        if (subjectSet && !subjectSet.has(v1.userId) && !subjectSet.has(v2.userId)) continue;
        if (!isTrustedVisitEnd(v1.endQuality) || !isTrustedVisitEnd(v2.endQuality)) continue;

        const start = Math.max(v1.startedAt, v2.startedAt);
        const end = Math.min(v1.endedAt, v2.endedAt);
        if (end <= start) continue;

        const [a, b] = v1.userId < v2.userId ? [v1.userId, v2.userId] : [v2.userId, v1.userId];
        const key = `${a} ${b}`;
        let entry = pairSeconds.get(key);
        if (!entry) {
          entry = { a, b, seconds: 0, days: new Set() };
          pairSeconds.set(key, entry);
        }
        entry.seconds += end - start;
        for (const d of jstDatesInInterval(start, end)) entry.days.add(d);
      }
    }
  }

  return [...pairSeconds.values()].map((e) => ({
    userA: e.a,
    userB: e.b,
    overlapSeconds: e.seconds,
    jstDays: [...e.days].sort(),
  }));
}

export interface SafeSocialAggregate {
  userId: string;
  /** 重なったdistinctな相手の人数。相手のidentityは含まない。 */
  distinctCoPresentUsers: number;
  /** 同じ一人と重なったdistinct JST日数の最大値。相手のidentityは含まない。 */
  maxRepeatedDaysWithOneCounterpart: number;
  /**
   * 全pairの信頼できる重なり秒数の合計。
   * 3人以上が同時に居た時間は相手ごとに重複して加算される
   * （「時計上の総滞在時間」ではなく「延べ何秒、誰かと重なっていたか」の指標）。
   */
  trustedOverlapSeconds: number;
  /**
   * JST日ごとのdistinctな相手人数。相手のidentity・pair・channel・timestampは含めない。
   * interactionが無い日は行自体を作らない。
   */
  dailyBreadth: ReadonlyArray<{
    date: string;
    distinctCoPresentUsers: number;
  }>;
}

/**
 * pair identityを一切外へ出さずに、社会的な広がりだけを安全に返す。
 * 称号定義は特定の相手のuserIdを渡さなくても、ここから判定できる。
 *
 * userIds指定時、返す行は指定したユーザーだけに絞る。computeCoPresenceOverlaps は
 * 「少なくとも一方が指定ユーザー」であるpairを返すため、指定していない相手側
 * （例: alice指定でbobとの重なりが見つかった場合のbob）にも touch() が働いてしまうが、
 * そのbobの集計はaliceとの重なりしか反映しておらず、bobの channel全体を見た完全な集計
 * ではない。不完全な行を「bobの集計」として返すと誤解を招くため、指定時は指定ユーザー
 * の行だけを返す（指定ユーザー自身の集計は、本人の全channelを見ているため完全）。
 */
export function computeSafeSocialAggregates(
  db: Database.Database,
  window: TitleWindow,
  userIds?: readonly string[],
): SafeSocialAggregate[] {
  if (userIds && userIds.length === 0) return [];
  const overlaps = computeCoPresenceOverlaps(db, window, userIds);
  const byUser = new Map<
    string,
    {
      partners: Map<string, { seconds: number; days: number }>;
      counterpartsByDate: Map<string, Set<string>>;
    }
  >();

  const touch = (self: string, other: string, seconds: number, jstDays: readonly string[]) => {
    let entry = byUser.get(self);
    if (!entry) {
      entry = { partners: new Map(), counterpartsByDate: new Map() };
      byUser.set(self, entry);
    }
    const prev = entry.partners.get(other) ?? { seconds: 0, days: 0 };
    entry.partners.set(other, { seconds: prev.seconds + seconds, days: prev.days + jstDays.length });
    for (const date of jstDays) {
      let counterparts = entry.counterpartsByDate.get(date);
      if (!counterparts) {
        counterparts = new Set();
        entry.counterpartsByDate.set(date, counterparts);
      }
      counterparts.add(other);
    }
  };

  for (const o of overlaps) {
    touch(o.userA, o.userB, o.overlapSeconds, o.jstDays);
    touch(o.userB, o.userA, o.overlapSeconds, o.jstDays);
  }

  const requestedSet = userIds ? new Set(userIds) : null;
  const results: SafeSocialAggregate[] = [];
  for (const [userId, { partners, counterpartsByDate }] of byUser) {
    if (requestedSet && !requestedSet.has(userId)) continue;
    let totalSeconds = 0;
    let maxDays = 0;
    for (const p of partners.values()) {
      totalSeconds += p.seconds;
      if (p.days > maxDays) maxDays = p.days;
    }
    results.push({
      userId,
      distinctCoPresentUsers: partners.size,
      maxRepeatedDaysWithOneCounterpart: maxDays,
      trustedOverlapSeconds: totalSeconds,
      dailyBreadth: [...counterpartsByDate]
        .sort(([dateA], [dateB]) => (dateA < dateB ? -1 : dateA > dateB ? 1 : 0))
        .map(([date, counterparts]) => ({ date, distinctCoPresentUsers: counterparts.size })),
    });
  }
  return results;
}
