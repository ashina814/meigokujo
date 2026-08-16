import type Database from "better-sqlite3";
import { EventLog } from "../events/service.js";
import { ChipLedgerError, ChipLedger, HOUSE_HOLDER } from "./chip-ledger.js";

/**
 * 賭場のエスクロー台帳。
 * 「賭け金を先取りして預り所に一時保管する」ゲーム（対人・競馬・丁半・PvPポーカー等）で、
 * 誰からいくら預かっているかを DB に記録する。
 *
 * ## 資金分離（重要）
 * 旧実装は預り金を `HOUSE_HOLDER` に置いていたため、ソロゲームの配当余力（テーブルリミット）を
 * 計算する `Casino.canAccept()` から見て「対人戦の預り金まで含めた house 残高」で受注してしまい、
 * 対人戦の預り金でソロ配当を払える構造になっていた。
 *
 * 現在は「セッションごとの専用保有者(escrow:session:<sid>)」に預ける。
 * - 胴元(house)の配当余力は house 残高だけを見る → 預り金は含めない
 * - 精算は必ずセッション保有者から動かす（マーケットも同様に session を切って使うこと）
 *
 * ## 起動時掃除
 * `sweepAll()` は次の3系統を返金対象にする:
 * 1. `casino_escrow` 台帳に残っている行 → 記録の source から返金
 * 2. 新方式の `escrow:session:*` 保有者に残っているエテル残高（台帳と乖離した孤児）
 * 3. 旧方式で house に混ざったまま台帳だけ残っている行（互換：source='house' の行）
 * これで「Bot再起動時も全額返金可能」を保証する。
 */

export interface EscrowRow {
  session_id: string;
  user_id: string;
  amount: number;
  game: string;
  /** 資金の実際の置き場（保有者ID）。新方式は "escrow:session:<sid>"、旧行は "house" */
  source: string;
  created_at: number;
}

const now = () => Math.floor(Date.now() / 1000);

/** 複数人徴収の途中で「残高が足りない人がいた」ことを伝える内部例外（グループを巻き戻すため） */
class EscrowShortfall extends Error {
  constructor(readonly userId: string) {
    super("ESCROW_SHORTFALL");
    this.name = "EscrowShortfall";
  }
}

/** hold() の取り違え検出に使う要求の指紋。groupKey（session+user+operationId）に対して一意であるべき内容 */
interface HoldFingerprint {
  sessionId: string;
  userId: string;
  amount: number;
  game: string;
}

/** hold() がグループに保存する形（新規グループのみ。legacy は素の boolean） */
interface HoldStoredResult {
  ok: boolean;
  fingerprint: HoldFingerprint;
}

function holdFingerprintsEqual(a: HoldFingerprint, b: HoldFingerprint): boolean {
  return a.sessionId === b.sessionId && a.userId === b.userId && a.amount === b.amount && a.game === b.game;
}

/** holdAll() の取り違え検出に使う要求の指紋。participants は順序を無視するので常に sort 済みで持つ */
interface HoldAllFingerprint {
  sessionId: string;
  game: string;
  amount: number;
  participants: string[];
}

/** holdAll() がグループに保存する形（新規グループのみ。legacy は素の boolean true） */
interface HoldAllStoredResult {
  ok: boolean;
  fingerprint: HoldAllFingerprint;
}

function holdAllFingerprintsEqual(a: HoldAllFingerprint, b: HoldAllFingerprint): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.game === b.game &&
    a.amount === b.amount &&
    a.participants.length === b.participants.length &&
    a.participants.every((u, i) => u === b.participants[i])
  );
}

/**
 * holdAll() の重複 userId を初回・replay を問わず拒否する。
 * 重複は「同じ人から二重徴収したいのか、指定ミスか」を区別できず、取り違えの温床になる。
 */
function assertNoDuplicateUserIds(userIds: readonly string[], context: string): void {
  const seen = new Set<string>();
  for (const userId of userIds) {
    if (seen.has(userId)) {
      throw new Error(`${context}: duplicate userId "${userId}" in participant list`);
    }
    seen.add(userId);
  }
}

/** セッションIDから専用保有者のIDを作る。他モジュールも同じ命名規則で作ること */
export const escrowHolderFor = (sessionId: string): string => `escrow:session:${sessionId}`;

/**
 * 孤児エスクローの隔離用保有者ID。
 * 台帳（casino_escrow）に対応記録がない預り所残高は、ここに移して人手確認を待つ。
 * house とは別で、`Casino.houseBalance()` にも `canAccept()` にも含まれない。
 * 運営が原因調査後に手動で返金 or 帳消しできる（返金先が判明したら `ether.transfer` で個別対応）。
 */
export const ESCROW_QUARANTINE = "sys:escrow:quarantine";

/** 保有者IDがエスクロー保有者かの判定（Ledger 側の除外にも使える） */
export const isEscrowHolder = (holderId: string): boolean =>
  holderId.startsWith("escrow:") || holderId === ESCROW_QUARANTINE || holderId === "house_escrow_legacy";

export interface EscrowOptions {
  /**
   * **確定精算のときだけ**呼ばれる、利用者ごとのゲーム由来の実現損益（PR3・通算損益）。
   *
   * ```text
   * net = その精算で実際に受け取った額 − その卓へ預けていた総額
   * ```
   *
   * 預託（hold）と返金（refund）では**呼ばない**。預けただけ・返ってきただけでは
   * まだ何も確定していないのに「対局中なのに通算負けが増える」「全額返金なのに
   * total_earned と total_lost が両方膨らむ」ことになる。場代は「受取が預託を下回る」
   * という形で自然に損失側へ入る。
   *
   * `Escrow.settle()` の資金グループの中から呼ばれるので、同じ精算を再試行しても
   * 「保存済みの結果を返す」経路に入り、二度は呼ばれない。
   */
  onPlayerNet?: (userId: string, net: number) => void;
}

export class Escrow {
  private readonly onPlayerNet: (userId: string, net: number) => void;

  constructor(
    private readonly db: Database.Database,
    private readonly ether: ChipLedger,
    private readonly events: EventLog,
    options: EscrowOptions = {},
  ) {
    this.onPlayerNet = options.onPlayerNet ?? (() => undefined);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_escrow (
        session_id TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        amount     INTEGER NOT NULL CHECK(amount > 0),
        game       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, user_id)
      );
    `);
    // 既存DBに source 列が無ければ足す。旧行は "house" 扱い（sweepAll で house から返金）。
    this.addColumnIfMissing("casino_escrow", "source", "TEXT NOT NULL DEFAULT 'house'");
  }

  private addColumnIfMissing(table: string, column: string, spec: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${spec}`);
  }

  /**
   * user から amount を徴収してセッション専用保有者に預け、台帳に記録する。
   * 同一セッション・同一ユーザーの2回目以降は加算（丁半の増額など）。
   * 残高不足なら false（何も動かさない）。
   *
   * ## 取り違え対策（PR11独立監査 #50・フォローアップ）
   *
   * `runGroup` の冪等キーは session_id + user_id + operationId だけで、**要求内容
   * （amount / game）は鍵に含まれない**。同じ operationId を別の amount・game で
   * 呼ぶ取り違えが起きると、`runGroup` は保存済みの真偽値をそのまま replay するだけ
   * なので、実際には1回目の額しか動いていないのに2回目の要求が通ったかのような
   * true を返しかねない。
   *
   * 新規グループは本体の戻り値に要求 fingerprint（sessionId/userId/amount/game）を
   * 含めて保存し、replay 時にいまの引数と突き合わせる。true の側は**さらに**実際に
   * 動いた `casino_tx` 明細（from/to/amount/game/session_id/件数/tx_kind）を読み直して
   * 二重に検証する——fingerprint は「本体を通さず保存された値」を信じる形なので、
   * 台帳そのものとの一致まで見て初めて「本当にその内容で預かった」と言える。
   *
   * ### legacy（この変更より前に確定した生の true/false）との互換
   * - **true**: fingerprint が無いので、`casino_tx` 明細だけを唯一の証拠として検証する
   *   （明細は不変の監査記録なので、legacy でも新規でも同じ検証関数が使える）。
   * - **false**: このコードより前の `hold()` は残高不足を「本体を通して確定した false」
   *   として保存していたが、当時は要求内容を一切残していない。`casino_tx` にも明細が
   *   無い（何も移していないので）。つまり **false 側だけは、legacy 分に限り要求内容を
   *   検証する手段が存在しない**。ここで「たまたま今回の amount/game が一致するかもしれない」
   *   と推測して通すのは fail-closed の原則に反するので、**legacy の false は無条件で
   *   conflict 扱いにする**（同じ operationId を使い回さない運用を強制する）。
   *   新規に確定した false は fingerprint を持つので、通常どおり突き合わせて判定する。
   *
   * ## nested 呼び出し（例: ルーレット）は台帳突き合わせの対象外
   * `roulette:bet:*` のように、他の `runGroup` の**中から**呼ばれる hold() は、
   * `ChipTx.runGroup` が「すでに active なグループがあれば新しいグループを作らず
   * 本体を素通しする」ため、この groupKey 自体は `getGroup`/replay の対象にならず、
   * 呼ばれるたびに本体がそのまま実行される（fingerprint の食い違いは原理上起きない）。
   * さらに、実際に動いた `casino_tx` の明細は**外側の active なグループのキー**に
   * 記録される（この hold() 自身の groupKey には明細が残らない）ため、台帳突き合わせ
   * （`assertHoldLedgerMatches`）を nested 時にそのまま実行すると「明細が0件」で
   * 常に誤検出してしまう。そのため nested 時は台帳突き合わせを行わない
   * （fingerprint 比較は残すが、body が毎回フレッシュに実行される以上は常に一致し無害）。
   * **取り違えの検出は外側の呼び出し元が自分の fingerprint で行う責任を持つ**
   * （`acceptRouletteBet` 参照。外側が settled なら、この hold() 自体が一度も
   * 呼ばれずに外側の body ごとスキップされるため、ここでは検出できない）。
   *
   * ## 台帳突き合わせは commit 前（グループの中）でも行う
   * 新規実行（このグループを初めて作った側）の台帳突き合わせは、`runGroup` の
   * コールバックの**中**、送金・`casino_escrow` 更新の直後で行う。ここで検出して
   * 例外を投げれば、送金・`casino_escrow` 行・グループ行・`casino_tx` 行が
   * **同じ SQLite トランザクションで丸ごとロールバック**する。
   * コールバックの外（`runGroup` が返ったあと）でしか見ないと、その時点でもう
   * トランザクションは commit 済みなので、「不一致を検出して conflict を投げた」のに
   * 実際の資金移動は取り消せない——検出はできても原子性が壊れる。
   * コールバックの外の突き合わせ（下記）は、**body が実行されない replay 経路**
   * （既存の legacy true 行・新規グループの保存済み true replay・別プロセス競合で
   * 先に確定していた側）のためのもので、新規実行では二重チェックになるだけで無害。
   */
  hold(sessionId: string, userId: string, amount: number, game: string, operationId: string): boolean {
    if (!Number.isInteger(amount) || amount <= 0) return false;
    const holder = escrowHolderFor(sessionId);
    const groupKey = `escrow:hold:${sessionId}:${userId}:${operationId}`;
    const context = `escrow hold ${sessionId}:${userId}:${operationId}`;
    const fingerprint: HoldFingerprint = { sessionId, userId, amount, game };
    const nested = this.ether.chipTx.isActive();
    let stored: boolean | HoldStoredResult;
    try {
      stored = this.ether.runGroup({ groupKey, kind: "table_hold", actorId: userId }, (): HoldStoredResult => {
        // 残高判定はグループの中。外でやると、預託成功後の再試行が
        // 「保存済みの結果（true）を返す」前に残高不足で false になる
        if (this.ether.balanceOf(userId) < amount) return { ok: false, fingerprint };
        this.ether.transfer(userId, holder, amount, { reason: "卓への預託", game, sessionId });
        this.db
          .prepare(
            `INSERT INTO casino_escrow (session_id, user_id, amount, game, source, created_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id, user_id) DO UPDATE SET amount = amount + excluded.amount, source = excluded.source`,
          )
          .run(sessionId, userId, amount, game, holder, now());
        // commit前の突き合わせ（このコールバック内で例外を投げれば上の送金・INSERTごと
        // ロールバックする）。nested時は自分のgroupKeyに明細が付かないので省略
        if (!nested) this.assertHoldLedgerMatches(groupKey, userId, holder, amount, game, sessionId, context);
        return { ok: true, fingerprint };
      });
    } catch (e) {
      if (e instanceof ChipLedgerError) return false;
      throw e;
    }

    if (typeof stored === "boolean") {
      // legacy: この変更より前に確定した生の真偽値（fingerprint を持たない）。
      // body は実行されていない（既存グループが replay された）ので、ここで初めて検証する。
      // nested からは`getGroup`が呼ばれないのでここには来ない（legacy 行は常に非nested）
      if (!stored) {
        throw new Error(
          `escrow operation conflict: ${context} is a legacy unverifiable false result (no request fingerprint, no ledger entry to check against) — refusing to assume the requested amount/game match. Use a new operationId.`,
        );
      }
      this.assertHoldLedgerMatches(groupKey, userId, holder, amount, game, sessionId, context);
      return true;
    }

    if (!holdFingerprintsEqual(stored.fingerprint, fingerprint)) {
      throw new Error(
        `escrow operation conflict: ${context} stored request ${JSON.stringify(stored.fingerprint)} != requested ${JSON.stringify(fingerprint)}`,
      );
    }
    // fresh実行ならコールバック内で既に検証済み（ここは無害な再確認）。
    // 保存済みreplay・別プロセス競合ならbodyが実行されていないので、ここが唯一の検証機会
    if (stored.ok && !nested) this.assertHoldLedgerMatches(groupKey, userId, holder, amount, game, sessionId, context);
    return stored.ok;
  }

  /**
   * グループが実際に holder へ移した額の明細（from/to/amount/game/session_id/件数/tx_kind）が
   * 要求どおりかを見る。一致しなければ fail-closed で例外にする。
   *
   * legacy の true・新規の true のどちらも、この関数だけで検証できる
   * （`casino_tx` は不変の監査記録なので、いつ確定したグループかを問わない）。
   */
  private assertHoldLedgerMatches(
    groupKey: string,
    userId: string,
    toHolder: string,
    amount: number,
    game: string,
    sessionId: string,
    context: string,
  ): void {
    const rows = this.ether.chipTx.listByGroup(groupKey);
    if (rows.length !== 1) {
      throw new Error(`escrow operation conflict: ${context} expected exactly 1 ledger entry, found ${rows.length}`);
    }
    const tx = rows[0]!;
    if (
      tx.tx_kind !== "internal_transfer" ||
      tx.from_holder !== userId ||
      tx.to_holder !== toHolder ||
      tx.amount !== amount ||
      tx.game !== game ||
      tx.session_id !== sessionId
    ) {
      throw new Error(
        `escrow operation conflict: ${context} stored ledger entry ${JSON.stringify({
          from: tx.from_holder, to: tx.to_holder, amount: tx.amount, game: tx.game, sessionId: tx.session_id, kind: tx.tx_kind,
        })} != requested ${JSON.stringify({ from: userId, to: toHolder, amount, game, sessionId, kind: "internal_transfer" })}`,
      );
    }
  }

  /**
   * 複数人からまとめて預託する（対人卓の参加徴収）。**全員ぶんで1グループ**。
   *
   * 途中の1人が足りなければ例外でグループごと巻き戻すので、先に取った人の分も残らない
   * （「1人目だけ徴収されて卓が立たない」状態を作らない）。事前の残高確認もグループの
   * 中で行う。外でやると、成功後の再試行が「保存済みの結果（true）を返す」前に
   * 残高不足で false になる。
   *
   * `hold()` と違い、残高不足は**例外**でグループごと巻き戻す（＝グループが確定しない）ので、
   * false は常に「その場で再計算された結果」であり、legacy の false replay 問題は存在しない
   * （false を保存済みグループとして持つことがそもそも無い）。取り違え対策が要るのは
   * **成功（true）** 側だけ: 同じ operationId を別の amount・game・参加者構成で呼ぶと、
   * `runGroup` が保存済みの true を要求内容の検証なしに replay してしまう。
   *
   * 参加者は**順序を無視した集合**として比較する（張る順序が違うだけの同一操作を弾かない
   * ため）。同一呼び出し内の重複 userId は、取り違えの温床になる（同じ人から二重徴収の
   * つもりが片方だけ記録される等）ため、amount の妥当性すら問わず・初回呼び出し・replay を
   * 問わず常に最初に拒否する。
   *
   * 台帳突き合わせは `hold()` と同じく commit 前（`runGroup` コールバックの中、全員ぶんの
   * 送金・`casino_escrow` 更新が終わった直後）でも行う。理由も `hold()` と同じ:
   * コールバックの外でしか見ないと、検出した時点でもう commit 済みで原子性が壊れる。
   *
   * @returns 全員から預かれたら true。1人でも足りなければ false（誰からも取らない）
   */
  holdAll(sessionId: string, userIds: readonly string[], amount: number, game: string, operationId: string): boolean {
    assertNoDuplicateUserIds(userIds, `escrow holdAll ${sessionId}:${operationId}`);
    if (!Number.isInteger(amount) || amount <= 0) return false;
    const holder = escrowHolderFor(sessionId);
    const groupKey = `escrow:hold_all:${sessionId}:${operationId}`;
    const context = `escrow holdAll ${sessionId}:${operationId}`;
    const fingerprint: HoldAllFingerprint = { sessionId, game, amount, participants: [...userIds].sort() };
    // nested（他の runGroup の中から呼ばれた）場合は、実際の明細が外側グループのキーに
    // 記録されるため、この groupKey で台帳突き合わせをすると常に「0件」と誤検出する。
    // hold() 側と同じ理由で nested 時は台帳突き合わせを省略する（現状の生産コードに
    // nested な holdAll 呼び出しは無いが、将来の呼び出し元のために備える）
    const nested = this.ether.chipTx.isActive();
    let stored: boolean | HoldAllStoredResult;
    try {
      stored = this.ether.runGroup(
        { groupKey, kind: "table_hold", actorId: "system:escrow" },
        (): HoldAllStoredResult => {
          for (const userId of userIds) {
            if (this.ether.balanceOf(userId) < amount) throw new EscrowShortfall(userId);
            this.ether.transfer(userId, holder, amount, { reason: "卓への預託", game, sessionId });
            this.db
              .prepare(
                `INSERT INTO casino_escrow (session_id, user_id, amount, game, source, created_at) VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(session_id, user_id) DO UPDATE SET amount = amount + excluded.amount, source = excluded.source`,
              )
              .run(sessionId, userId, amount, game, holder, now());
          }
          // commit前の突き合わせ。ここで例外を投げれば全員ぶんの送金・INSERTごとロールバックする
          if (!nested) this.assertHoldAllLedgerMatches(groupKey, fingerprint.participants, holder, amount, game, sessionId, context);
          return { ok: true, fingerprint };
        },
      );
    } catch (e) {
      // 足りない人がいた／送金が通らなかった → グループごと巻き戻り済み。誰からも取っていない。
      // グループが確定していないので replay の対象にもならない（次回また新規実行される）
      if (e instanceof EscrowShortfall || e instanceof ChipLedgerError) return false;
      throw e;
    }

    if (typeof stored === "boolean") {
      // legacy: この変更より前に確定した生の true（holdAll の false は上記の理由で存在しない）。
      // body は実行されていない（既存グループが replay された）ので、ここで初めて検証する
      if (!nested) this.assertHoldAllLedgerMatches(groupKey, fingerprint.participants, holder, amount, game, sessionId, context);
      return true;
    }
    if (!holdAllFingerprintsEqual(stored.fingerprint, fingerprint)) {
      throw new Error(
        `escrow operation conflict: ${context} stored request ${JSON.stringify(stored.fingerprint)} != requested ${JSON.stringify(fingerprint)}`,
      );
    }
    // fresh実行ならコールバック内で既に検証済み（ここは無害な再確認）。
    // 保存済みreplay・別プロセス競合ならbodyが実行されていないので、ここが唯一の検証機会
    if (!nested) this.assertHoldAllLedgerMatches(groupKey, fingerprint.participants, holder, amount, game, sessionId, context);
    return stored.ok;
  }

  /**
   * holdAll のグループが実際に holder へ移した明細一式が要求どおりかを見る:
   * 件数 === 参加者数、各行が tx_kind=internal_transfer / to_holder=holder / amount / game /
   * session_id 一致、かつ from_holder の集合が参加者集合とちょうど一致する（過不足なし）。
   */
  private assertHoldAllLedgerMatches(
    groupKey: string,
    participants: readonly string[],
    toHolder: string,
    amount: number,
    game: string,
    sessionId: string,
    context: string,
  ): void {
    const rows = this.ether.chipTx.listByGroup(groupKey);
    if (rows.length !== participants.length) {
      throw new Error(
        `escrow operation conflict: ${context} expected ${participants.length} ledger entries, found ${rows.length}`,
      );
    }
    const seen = new Set<string>();
    for (const tx of rows) {
      if (
        tx.tx_kind !== "internal_transfer" ||
        !tx.from_holder ||
        tx.to_holder !== toHolder ||
        tx.amount !== amount ||
        tx.game !== game ||
        tx.session_id !== sessionId
      ) {
        throw new Error(`escrow operation conflict: ${context} unexpected ledger entry ${JSON.stringify(tx)}`);
      }
      seen.add(tx.from_holder);
    }
    const expected = new Set(participants);
    if (seen.size !== expected.size || [...expected].some((u) => !seen.has(u))) {
      throw new Error(
        `escrow operation conflict: ${context} ledger participants ${JSON.stringify([...seen].sort())} != requested ${JSON.stringify([...expected].sort())}`,
      );
    }
  }

  /**
   * 複数人にまとめて返金する（卓の不成立・中止）。**全員ぶんで1グループ**。
   * 途中で落ちたら誰にも返らない（＝帳簿も残る）ので、同じキーで再試行できる。
   *
   * `_beforeStep` はテスト専用のフック（各返金の直前に呼ばれる）。本番呼び出しは省略する。
   *
   * @returns 実際に返金した人数
   */
  refundMany(
    sessionId: string,
    userIds: readonly string[],
    operationId: string,
    _beforeStep?: (index: number, userId: string) => void,
  ): number {
    return this.ether.runGroup(
      { groupKey: `escrow:refund_many:${sessionId}:${operationId}`, kind: "table_refund", actorId: "system:escrow" },
      (): number => {
        let refunded = 0;
        for (let i = 0; i < userIds.length; i++) {
          const userId = userIds[i]!;
          _beforeStep?.(i, userId);
          const row = this.db
            .prepare("SELECT * FROM casino_escrow WHERE session_id = ? AND user_id = ?")
            .get(sessionId, userId) as EscrowRow | undefined;
          if (!row) continue;
          this.ether.transfer(row.source, userId, row.amount, { reason: "離脱による返金", sessionId, game: row.game });
          this.db.prepare("DELETE FROM casino_escrow WHERE session_id = ? AND user_id = ?").run(sessionId, userId);
          refunded++;
        }
        return refunded;
      },
    );
  }

  /** セッションの預かり記録（返金額の確認用） */
  list(sessionId: string): EscrowRow[] {
    return this.db.prepare("SELECT * FROM casino_escrow WHERE session_id = ?").all(sessionId) as EscrowRow[];
  }

  /**
   * セッションの預り総額（＝現在の保有者残高になっているはず）。
   * 精算コードで「勝者/胴元/JPへ幾ら配るか」を計算する材料に使う。
   */
  poolOf(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM casino_escrow WHERE session_id = ?")
      .get(sessionId) as { s: number };
    return row.s;
  }

  /** セッション専用保有者のID（呼び出し側が精算時に使う）。命名を1箇所に閉じ込めるため */
  holderId(sessionId: string): string {
    return escrowHolderFor(sessionId);
  }

  /**
   * 精算配分: 保有者から任意の宛先に額を移す（呼び出し側は帳簿上の精算計算に責任を持つ）。
   * 残高不足なら例外。呼び出し側で poolOf() を守れば起きない。
   */
  payout(sessionId: string, toHolderId: string, amount: number, operationId: string, reason = "卓の配分"): void {
    if (amount <= 0) return;
    this.ether.runGroup(
      { groupKey: `escrow:payout:${sessionId}:${toHolderId}:${operationId}`, kind: "table_settle", actorId: "system:escrow" },
      () => this.ether.transfer(this.holderId(sessionId), toHolderId, amount, { reason, sessionId }),
    );
  }

  /**
   * 正常精算した: 記録だけ消す（金は payout / 呼び出し側が動かした後）。
   * 呼び出し前に保有者残高が 0 になっていること（精算不完全の検出は verify() 側で）。
   */
  clear(sessionId: string): void {
    this.db.prepare("DELETE FROM casino_escrow WHERE session_id = ?").run(sessionId);
  }

  /**
   * 原子的精算（推奨エントリポイント）。
   *
   * 対象: PvP / 競馬 / その他 escrow.hold() で預けた資金の分配全般。
   * 動作: エスクロー残高 == 分配合計 を検証し、単一 SQLite トランザクション内で
   *   1) 全 distribution.to へ ether を送金
   *   2) casino_escrow の当該セッションを削除
   *   3) events に settle 記録を残す
   * 途中の任意の送金で例外が発生すれば全ロールバック（保有者残高・帳簿ともに元の状態に戻る）。
   *
   * オプション `_beforeStep` はテスト専用のフック: 各送金の直前に呼ばれ、例外を投げると
   * その送金は失敗し、トランザクション全体が巻き戻る。プロダクション呼び出しは省略する。
   */
  settle(
    sessionId: string,
    distributions: ReadonlyArray<{ to: string; amount: number; reason?: string }>,
    actor: string,
    reason: string,
    _beforeStep?: (index: number, dist: { to: string; amount: number }) => void,
  ): { paid: number; sessionId: string } {
    const holder = this.holderId(sessionId);

    // 検証は「正数フィルタの前」に全件を検査する。
    // 先に filter(d.amount > 0) してしまうと、負数・NaN・Infinity・小数・空宛先が
    // 黙って捨てられて素通りしてしまう（filter が false になり配列から消える）。
    for (const d of distributions) {
      if (
        !d.to ||
        typeof d.to !== "string" ||
        !Number.isFinite(d.amount) ||
        !Number.isInteger(d.amount) ||
        d.amount < 0
      ) {
        throw new Error(`Escrow.settle: bad distribution ${JSON.stringify(d)}`);
      }
    }

    const positive = distributions.filter((d) => d.amount > 0);
    const total = positive.reduce((s, d) => s + d.amount, 0);

    // 1セッションの精算は一度きり。セッションIDがそのまま冪等キーになる
    return this.ether.runGroup(
      { groupKey: `escrow:settle:${sessionId}`, kind: "table_settle", actorId: actor },
      () => {
      // pool の確認はグループの中。外でやると、精算成功後（＝預り所が空）の再試行が
      // 「保存済みの結果を返す」前に pool 不一致で落ちる
      const pool = this.ether.balanceOf(holder);
      if (total !== pool) {
        throw new Error(
          `Escrow.settle: distribution total ${total} != escrow pool ${pool} for session ${sessionId}`,
        );
      }
      // 通算損益は「受取 − 預託」で出すので、帳簿を消す前に預託額を控えておく（PR3）
      const staked = new Map<string, number>();
      for (const r of this.list(sessionId)) staked.set(r.user_id, (staked.get(r.user_id) ?? 0) + r.amount);

      const received = new Map<string, number>();
      for (let i = 0; i < positive.length; i++) {
        const d = positive[i]!;
        _beforeStep?.(i, d);
        this.ether.transfer(holder, d.to, d.amount, { reason: d.reason ?? reason, sessionId });
        received.set(d.to, (received.get(d.to) ?? 0) + d.amount);
      }

      // **ここが唯一の記録点**。預託時・返金時には動かさない。
      // 場代や JP へ抜けた分は「受取が預託を下回る」形で損失側に入る。
      // 預けた本人だけを対象にする（house / jackpot への配分は利用者の損益ではない）
      for (const [userId, stake] of staked) {
        this.onPlayerNet(userId, (received.get(userId) ?? 0) - stake);
      }

      // 帳簿削除は最後（送金が全部通ってから）
      this.db.prepare("DELETE FROM casino_escrow WHERE session_id = ?").run(sessionId);
      this.events.log("casino_escrow_settle", {
        actor,
        payload: {
          sessionId,
          reason,
          total,
          distributions: positive.map((d) => ({ to: d.to, amount: d.amount, reason: d.reason })),
        },
      });
      return { paid: total, sessionId };
    });
  }

  /** セッションの全員に預かり額を返金して記録を消す。返金した人数を返す */
  refund(sessionId: string): number {
    return this.ether.runGroup(
      { groupKey: `escrow:refund:${sessionId}`, kind: "table_refund", actorId: "system:escrow" },
      (): number => {
        const rows = this.list(sessionId);
        for (const r of rows) {
          // 保有者から返す（旧行は source='house' → house から返金 = 旧挙動互換）
          this.ether.transfer(r.source, r.user_id, r.amount, { reason: "卓の返金", sessionId, game: r.game });
        }
        this.clear(sessionId);
        return rows.length;
      },
    );
  }

  /** 1人だけ返金して記録を消す（ロビー離脱）。記録が無ければ false */
  refundOne(sessionId: string, userId: string, operationId: string): boolean {
    // 張り直し・辞退・巻き戻しで何度も呼ばれるので、局面ごとに別の鍵を受け取る。
    // セッション＋利用者だけで固定すると、2回目の返金が過去結果の再生になってしまう。
    return this.ether.runGroup(
      { groupKey: `escrow:refund_one:${sessionId}:${userId}:${operationId}`, kind: "table_refund", actorId: userId },
      (): boolean => {
      const row = this.db
        .prepare("SELECT * FROM casino_escrow WHERE session_id = ? AND user_id = ?")
        .get(sessionId, userId) as EscrowRow | undefined;
      if (!row) return false;
      this.ether.transfer(row.source, userId, row.amount, { reason: "離脱による返金", sessionId, game: row.game });
      this.db.prepare("DELETE FROM casino_escrow WHERE session_id = ? AND user_id = ?").run(sessionId, userId);
      return true;
    });
  }

  /**
   * 起動時掃除（セッション単位で分離処理）。
   *
   * 1. 台帳(casino_escrow) をセッションごとに独立トランザクションで返金する。
   *    各セッションで「帳簿合計 == source 残高」を検証し、一致するものだけ返金する。
   *    不一致セッションは:
   *      - 帳簿を削除しない
   *      - 残高を勝手に house から補填しない
   *      - イベントログ / 運営ログに残す
   *      - 他の正常セッションの返金は続行する
   *    → 1セッションの破損で Bot 全体が起動不能にならない（market の refundAllPending と同思想）。
   *
   * 2. 台帳に記録がないのに escrow 保有者に残っているエテル(孤児残高)
   *    → 隔離口座 `sys:escrow:quarantine` に移す（house には送らない）。
   *    失敗セッションは帳簿が残るので孤児扱いされない（下の除外ロジック参照）。
   *
   * @returns 返金・孤児・失敗の内訳
   */
  sweepAll(actor: string): {
    totalSessions: number;
    refundedSessions: number;
    refundedUsers: number;
    refundedTotal: number;
    failed: Array<{ sessionId: string; expected: number; actual: number; error: string }>;
    orphans: number;
    orphanTotal: number;
  } {
    const allRows = this.db.prepare("SELECT * FROM casino_escrow").all() as EscrowRow[];
    const bySession = new Map<string, EscrowRow[]>();
    for (const r of allRows) {
      const arr = bySession.get(r.session_id) ?? [];
      arr.push(r);
      bySession.set(r.session_id, arr);
    }

    let refundedSessions = 0;
    let refundedUsers = 0;
    let refundedTotal = 0;
    const failed: Array<{ sessionId: string; expected: number; actual: number; error: string }> = [];

    for (const [sid, rows] of bySession) {
      const expected = rows.reduce((s, r) => s + r.amount, 0);
      const holder = escrowHolderFor(sid);
      try {
        // 起動時の掃除は「そのセッションの返金」そのもの。返金できたら帳簿ごと消えるので、
        // セッションIDを鍵にすれば再起動をまたいでも二重返金にならない
        this.ether.runGroup({ groupKey: `escrow:refund:${sid}`, kind: "table_refund", actorId: actor }, () => {
          // 新方式（source が session 専用保有者）は「保有者残高 == 帳簿合計」を厳格検証。
          // legacy（source='house'）は house が混在勘定なので個別検証できず、そのまま house から返金。
          const sources = new Set(rows.map((r) => r.source));
          const isNewStyle = sources.size === 1 && [...sources][0] === holder;
          if (isNewStyle) {
            const actual = this.ether.balanceOf(holder);
            if (actual !== expected) {
              throw new Error(`escrow mismatch: ledger=${expected} holder=${actual}`);
            }
          }
          for (const r of rows) {
            this.ether.transfer(r.source, r.user_id, r.amount, { reason: "起動時の未精算返金", sessionId: sid, game: r.game });
          }
          this.db.prepare("DELETE FROM casino_escrow WHERE session_id = ?").run(sid);
        });
        refundedSessions++;
        refundedUsers += rows.length;
        refundedTotal += expected;
      } catch (e) {
        const actual = this.ether.balanceOf(holder);
        const error = (e as Error).message;
        failed.push({ sessionId: sid, expected, actual, error });
        this.events.log("casino_escrow_sweep_failed", {
          actor,
          payload: { sessionId: sid, expected, actual, error },
        });
        // eslint-disable-next-line no-console
        console.warn(
          `[escrow] セッション ${sid} の返金失敗（帳簿=${expected} 保有者=${actual}）: ${error}。帳簿は残し house 補填もしない。要調査`,
        );
      }
    }

    // ── 孤児残高（記録が無いのに escrow 保有者に残っているエテル）→ 隔離口座に集約 ──
    this.ether.ensureHolder(ESCROW_QUARANTINE);
    // 失敗セッションは帳簿が残っているので activeSessions に含まれ、孤児扱いされない
    const activeSessions = new Set(
      (this.db.prepare("SELECT DISTINCT session_id FROM casino_escrow").all() as Array<{ session_id: string }>).map(
        (r) => r.session_id,
      ),
    );
    let activeMarkets = new Set<string>();
    try {
      // frozen も「有効な帳簿がある」扱いにする（孤児として自動隔離せず、調査完了まで
      // 市場専用 holder にエスクローを保持する。所有者情報は casino_market_bets に残っている）。
      activeMarkets = new Set(
        (
          this.db
            .prepare("SELECT id FROM casino_markets WHERE status IN ('open','closed','reported','disputed','frozen')")
            .all() as Array<{ id: number }>
        ).map((r) => String(r.id)),
      );
    } catch {
      /* markets テーブル未作成の環境（テスト最小構成）は空扱い */
    }
    const allEscrowHolders = this.db
      .prepare(
        "SELECT user_id, amount FROM ether_balances WHERE user_id LIKE 'escrow:%' AND user_id != ? AND amount > 0",
      )
      .all(ESCROW_QUARANTINE) as Array<{ user_id: string; amount: number }>;
    const orphanHolders = allEscrowHolders.filter((h) => {
      if (h.user_id.startsWith("escrow:session:")) {
        const sid = h.user_id.slice("escrow:session:".length);
        return !activeSessions.has(sid); // 帳簿が消えている = 孤児（失敗セッションは残るので除外）
      }
      if (h.user_id.startsWith("escrow:market:")) {
        const mid = h.user_id.slice("escrow:market:".length);
        return !activeMarkets.has(mid); // 板が精算済み/void 済みなのに残高が残っている = 孤児
      }
      return true; // 未知の escrow:* も孤児として隔離
    });
    let orphanTotal = 0;
    const detectedAt = Math.floor(Date.now() / 1000);
    for (const h of orphanHolders) {
      const bal = this.ether.balanceOf(h.user_id);
      if (bal > 0) {
        // 孤児1件ずつ独立トランザクションで隔離（1件失敗が他を止めない）
        try {
          this.ether.runGroup(
            { groupKey: `escrow:quarantine:${h.user_id}:${bal}`, kind: "table_refund", actorId: actor },
            () => this.ether.transfer(h.user_id, ESCROW_QUARANTINE, bal, { reason: "孤児残高の隔離" }),
          );
          orphanTotal += bal;
          this.events.log("casino_escrow_orphan", {
            actor,
            payload: { holder: h.user_id, amount: bal, detectedAt, quarantinedTo: ESCROW_QUARANTINE },
          });
          // eslint-disable-next-line no-console
          console.warn(
            `[escrow] 孤児残高を隔離: holder=${h.user_id} amount=${bal} → ${ESCROW_QUARANTINE}（要調査）`,
          );
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(`[escrow] 孤児残高の隔離に失敗: holder=${h.user_id} ${(e as Error).message}`);
        }
      }
    }

    if (allRows.length > 0 || orphanHolders.length > 0 || failed.length > 0) {
      this.events.log("casino_escrow_sweep", {
        actor,
        payload: {
          totalSessions: bySession.size,
          refundedSessions,
          refundedUsers,
          refundedTotal,
          failed: failed.length,
          orphans: orphanHolders.length,
          orphanTotal,
        },
      });
    }
    return {
      totalSessions: bySession.size,
      refundedSessions,
      refundedUsers,
      refundedTotal,
      failed,
      orphans: orphanHolders.length,
      orphanTotal,
    };
  }

  /**
   * 起動時の復旧（正本 §8.2 S5〜S8・PR7）。`sweepAll` と違い、
   * **生きている預託を所有元から教えてもらってから**掃除する。
   *
   * ```text
   * S5 帳簿（casino_escrow）と holder 残高を照合
   * S6 keep に含まれ、かつ一致しているセッションは一切触らない
   * S7 所有元が確実に存在しない（keep に無い）セッションだけ返金
   * S8 帳簿が無いのに残高がある escrow:* を quarantine へ隔離
   * ```
   *
   * **不一致は返金も隔離もしない。** 帳簿を残したまま記録だけ作って人間の判断を待つ
   * （正本 §8.3「帳簿不一致: 対象だけ凍結。返金しない」）。
   * 1セッションの失敗が他セッションの復旧を止めないのは `sweepAll` と同じ。
   *
   * @param keep 生存中のエスクロー保有者ID（`escrow:market:12` など）
   */
  recoverSessions(
    actor: string,
    keep: ReadonlySet<string>,
  ): {
    totalSessions: number;
    kept: number;
    refundedSessions: number;
    refundedUsers: number;
    refundedTotal: number;
    mismatched: Array<{ sessionId: string; expected: number; actual: number }>;
    failed: Array<{ sessionId: string; expected: number; actual: number; error: string }>;
    quarantined: number;
    quarantinedTotal: number;
  } {
    const allRows = this.db.prepare("SELECT * FROM casino_escrow").all() as EscrowRow[];
    const bySession = new Map<string, EscrowRow[]>();
    for (const r of allRows) {
      const arr = bySession.get(r.session_id) ?? [];
      arr.push(r);
      bySession.set(r.session_id, arr);
    }

    let kept = 0;
    let refundedSessions = 0;
    let refundedUsers = 0;
    let refundedTotal = 0;
    const mismatched: Array<{ sessionId: string; expected: number; actual: number }> = [];
    const failed: Array<{ sessionId: string; expected: number; actual: number; error: string }> = [];
    /** 触ってはいけない保有者（生存中 + 不一致で凍結したもの） */
    const untouchable = new Set<string>(keep);

    for (const [sid, rows] of bySession) {
      const expected = rows.reduce((s, r) => s + r.amount, 0);
      const holder = escrowHolderFor(sid);
      const sources = new Set(rows.map((r) => r.source));
      const isNewStyle = sources.size === 1 && [...sources][0] === holder;

      // S5: 照合。新方式（セッション専用保有者）だけ厳格に見られる
      if (isNewStyle) {
        const actual = this.ether.balanceOf(holder);
        if (actual !== expected) {
          // 返金も隔離もしない。帳簿を残して記録だけ作る
          mismatched.push({ sessionId: sid, expected, actual });
          untouchable.add(holder);
          this.events.log("casino_escrow_mismatch", {
            actor,
            payload: { sessionId: sid, expected, actual, action: "freeze" },
          });
          // eslint-disable-next-line no-console
          console.warn(
            `[escrow] セッション ${sid} は帳簿=${expected} 保有者=${actual} で不一致。返金も隔離もせず凍結（要調査）`,
          );
          continue;
        }
      }

      // S6: 生きている預託は一切触らない
      if (keep.has(holder)) {
        kept++;
        continue;
      }

      // S7: 所有元が存在しないので返金する。セッション単位の独立トランザクション
      try {
        this.ether.runGroup({ groupKey: `escrow:refund:${sid}`, kind: "table_refund", actorId: actor }, () => {
          for (const r of rows) {
            this.ether.transfer(r.source, r.user_id, r.amount, { reason: "起動時の孤児返金", sessionId: sid, game: r.game });
          }
          this.db.prepare("DELETE FROM casino_escrow WHERE session_id = ?").run(sid);
        });
        refundedSessions++;
        refundedUsers += rows.length;
        refundedTotal += expected;
      } catch (e) {
        const actual = this.ether.balanceOf(holder);
        const error = (e as Error).message;
        failed.push({ sessionId: sid, expected, actual, error });
        untouchable.add(holder);
        this.events.log("casino_escrow_sweep_failed", { actor, payload: { sessionId: sid, expected, actual, error } });
        // eslint-disable-next-line no-console
        console.warn(`[escrow] セッション ${sid} の孤児返金に失敗（帳簿=${expected} 保有者=${actual}）: ${error}。帳簿は残す`);
      }
    }

    // S8: 帳簿が1行も無いのに残高がある escrow:* を隔離する。
    // 生存中・不一致・返金失敗の保有者は触らない（帳簿か所有元が残っている＝孤児ではない）
    this.ether.ensureHolder(ESCROW_QUARANTINE);
    const remainingLedger = new Set(
      (this.db.prepare("SELECT DISTINCT session_id FROM casino_escrow").all() as Array<{ session_id: string }>).map((r) =>
        escrowHolderFor(r.session_id),
      ),
    );
    const holders = this.db
      .prepare("SELECT user_id, amount FROM ether_balances WHERE user_id LIKE 'escrow:%' AND user_id != ? AND amount > 0")
      .all(ESCROW_QUARANTINE) as Array<{ user_id: string; amount: number }>;

    let quarantined = 0;
    let quarantinedTotal = 0;
    const detectedAt = Math.floor(Date.now() / 1000);
    for (const h of holders) {
      if (untouchable.has(h.user_id) || remainingLedger.has(h.user_id)) continue;
      const bal = this.ether.balanceOf(h.user_id);
      if (bal <= 0) continue;
      try {
        this.ether.runGroup(
          { groupKey: `escrow:quarantine:${h.user_id}:${bal}`, kind: "table_refund", actorId: actor },
          () => this.ether.transfer(h.user_id, ESCROW_QUARANTINE, bal, { reason: "孤児残高の隔離" }),
        );
        quarantined++;
        quarantinedTotal += bal;
        this.events.log("casino_escrow_orphan", {
          actor,
          payload: { holder: h.user_id, amount: bal, detectedAt, quarantinedTo: ESCROW_QUARANTINE },
        });
        // eslint-disable-next-line no-console
        console.warn(`[escrow] 孤児残高を隔離: holder=${h.user_id} amount=${bal} → ${ESCROW_QUARANTINE}（要調査）`);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[escrow] 孤児残高の隔離に失敗: holder=${h.user_id} ${(e as Error).message}`);
      }
    }

    this.events.log("casino_escrow_recovered", {
      actor,
      payload: {
        totalSessions: bySession.size,
        kept,
        refundedSessions,
        refundedTotal,
        mismatched: mismatched.length,
        failed: failed.length,
        quarantined,
        quarantinedTotal,
      },
    });

    return {
      totalSessions: bySession.size,
      kept,
      refundedSessions,
      refundedUsers,
      refundedTotal,
      mismatched,
      failed,
      quarantined,
      quarantinedTotal,
    };
  }

  /** 隔離口座の現在残高（運営 UI・監査用） */
  quarantineBalance(): number {
    return this.ether.balanceOf(ESCROW_QUARANTINE);
  }

  /**
   * 隔離口座から個別返金 or 帳消しをする（運営操作専用）。
   * 「原因調査で預入者が判明した」ときはユーザーへ、「原因不明で売上計上する」ときは house へ。
   */
  releaseFromQuarantine(destHolderId: string, amount: number, actor: string, reason: string, operationId: string): void {
    if (amount <= 0) return;
    this.ether.runGroup(
      { groupKey: `escrow:quarantine_release:${destHolderId}:${operationId}`, kind: "table_refund", actorId: actor },
      () => this.ether.transfer(ESCROW_QUARANTINE, destHolderId, amount, { reason: `隔離解除: ${reason}` }),
    );
    this.events.log("casino_escrow_quarantine_release", {
      actor,
      payload: { dest: destHolderId, amount, reason },
    });
  }

  /**
   * 「保有者残高 == 帳簿の預り総額」を検証。テスト・監査で使う。
   * 差分があれば mismatches に列挙する。
   */
  verify(): { ok: boolean; mismatches: Array<{ sessionId: string; expected: number; actual: number }> } {
    const rows = this.db
      .prepare("SELECT session_id, SUM(amount) AS s FROM casino_escrow GROUP BY session_id")
      .all() as Array<{ session_id: string; s: number }>;
    const mismatches: Array<{ sessionId: string; expected: number; actual: number }> = [];
    for (const r of rows) {
      const holder = escrowHolderFor(r.session_id);
      const actual = this.ether.balanceOf(holder);
      if (actual !== r.s) mismatches.push({ sessionId: r.session_id, expected: r.s, actual });
    }
    return { ok: mismatches.length === 0, mismatches };
  }
}
