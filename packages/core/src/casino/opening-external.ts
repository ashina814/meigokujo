/**
 * 正式開業初期化の外部Discord工程インターフェース（CLAUDE.md §8）。
 *
 * 仕様書R3「旧Discord一時VCの削除」は外部副作用であり、本PRでは
 * interface・request/result型・idempotency・fake adapterまでに限定する。
 * 本番Discord adapter・token使用・実際のチャンネル操作・admin hub/button/command/scheduler
 * からの呼び出しは、別の明示的な運営GOの後にレビューする（本PRの範囲外）。
 */

export interface OpeningExternalDisableLegacyRequest {
  planHash: string;
  /** 同じ値なら二重実行しない。呼び出し側が `casino-opening:${planHash}:disable-legacy` 等で作る */
  idempotencyKey: string;
}

export interface OpeningExternalDisableLegacyResult {
  idempotencyKey: string;
  /** 実際に処理した対象の識別子一覧（fakeでは疑似ID。本番adapterは実チャンネルIDを入れる） */
  disabledChannelIds: readonly string[];
  completedAt: number;
}

export interface OpeningExternalAdapter {
  /**
   * 冪等でなければならない。同じ `idempotencyKey` の再呼び出しは、実際に処理した後は
   * **保存済みの結果をそのまま返し、二重に実行しない**。
   */
  disableLegacyCasino(request: OpeningExternalDisableLegacyRequest): Promise<OpeningExternalDisableLegacyResult>;
}

const now = () => Math.floor(Date.now() / 1000);

/**
 * テスト専用のfake外部adapter。実際のDiscord APIには一切接続しない。
 *
 * - 同じ `idempotencyKey` の2回目の呼び出しは、1回目の結果をそのまま返す（実行回数を増やさない）
 * - `failTimes` で「最初のN回は失敗する」を注入できる（リトライテスト用）
 * - `failAlways` で恒久的な失敗を注入できる（crash injection: 外部adapter失敗時にopening_reset
 *   状態を維持し、DB資金を一切動かさないことのテストに使う）
 */
export class FakeOpeningExternalAdapter implements OpeningExternalAdapter {
  private readonly results = new Map<string, OpeningExternalDisableLegacyResult>();
  private readonly attemptCounts = new Map<string, number>();
  private idCounter = 0;

  constructor(private readonly opts: { failTimes?: number; failAlways?: boolean } = {}) {}

  async disableLegacyCasino(
    request: OpeningExternalDisableLegacyRequest,
  ): Promise<OpeningExternalDisableLegacyResult> {
    const cached = this.results.get(request.idempotencyKey);
    if (cached) return cached;

    const attempts = (this.attemptCounts.get(request.idempotencyKey) ?? 0) + 1;
    this.attemptCounts.set(request.idempotencyKey, attempts);

    if (this.opts.failAlways || (this.opts.failTimes !== undefined && attempts <= this.opts.failTimes)) {
      throw new Error(`fake external adapter: forced failure (attempt ${attempts})`);
    }

    const result: OpeningExternalDisableLegacyResult = {
      idempotencyKey: request.idempotencyKey,
      disabledChannelIds: [`fake-legacy-vc-${++this.idCounter}`],
      completedAt: now(),
    };
    this.results.set(request.idempotencyKey, result);
    return result;
  }

  /** テスト用: 実際に本体処理まで到達した回数（キャッシュヒットは含まない） */
  attemptsFor(idempotencyKey: string): number {
    return this.attemptCounts.get(idempotencyKey) ?? 0;
  }
}
