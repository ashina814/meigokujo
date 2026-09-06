import type { Services } from "./services.js";

/**
 * **このプロセスが、自分の起動時回収を追い越さないようにするだけの関門。**
 *
 * トートは外部送信（投稿者への DM・運営スレッドへの中継）を durable な所有権と
 * 組にして進める。所有権を取ったあとで落ちると、
 *
 *   - 受領確認の「送信中」の試行が残り、部分ユニーク索引が次の送信を塞ぐ
 *   - 消費済みの返信下書きが「送信中」のまま二度と送れない
 *   - 中継中の追記が「送信中」のまま拾われない
 *
 * という置き土産ができる。これを回収する前に新しい送信や刻時盤が走り出すと、
 * 「前のプロセスは死んでいて、いま動いているのは自分だけ」という前提が崩れる。
 * だから外部へ触る入口はここを通ってから進む。
 *
 * **これは所有権の正本ではない。** 正本は DB 側の行（`outcome`）で、こちらは
 * プロセス内の順序づけしかしない。だから process-local な Promise でよく、
 * durable な表を増やす必要もない（Task #214 の外部効果関門と同じ考え方）。
 *
 * **失敗しても関門は開く。** 回収できなかった行は DB 側に残ってその案件だけを
 * 塞ぎ続ける。Bot 全体を止める必要はないし、「回収できなかったから送ってよい」でもない。
 */
let startupComplete: Promise<void> | null = null;

/** 起動時回収を開始し、関門をそれに結びつける。**ready の早い段階で1度だけ呼ぶ。** */
export function beginConfessionStartup(run: () => Promise<void> | void): void {
  startupComplete = Promise.resolve()
    .then(run)
    .then(() => undefined)
    .catch((error) => {
      console.error("[トート] 起動時の回収に失敗（未決着の行はDBに残る）:", error);
    });
}

/**
 * 外部送信を始める前に必ず待つ。
 *
 * 起動時回収が始まっていなければ即座に通す（テストや、まだ ready 前の経路）。
 * 待つのは**この1回だけ**で、以後は解決済みの Promise を返すだけ。
 */
export async function awaitConfessionReady(): Promise<void> {
  if (startupComplete === null) return;
  await startupComplete;
}

/**
 * 前のプロセスが残した「送信中」を `unknown` へ回収する。
 *
 * `delivered` でも `failed` でもなく `unknown`——送信を始めていたかもしれない以上、
 * 届いたとも届かなかったとも言えない。自動再送はしない（`unknown` は自動対象外）。
 */
export function recoverConfessionOrphans(services: Services): void {
  const recovered = services.confessions.recoverOrphanedEffects();
  const total = recovered.ackAttempts + recovered.replyDrafts + recovered.followUps + recovered.renders;
  if (total > 0) {
    console.log(
      `[トート] 前プロセスの未決着を回収しました 受領確認=${recovered.ackAttempts} 返信=${recovered.replyDrafts} 追記=${recovered.followUps} 表示=${recovered.renders}（送信は「結果不明」、表示は収束をやり直します）`,
    );
  }
}

/** 起動時に一度だけ呼ぶ配線。 */
export function armConfessionStartupRecovery(services: Services): void {
  beginConfessionStartup(() => {
    // 自分の生存をまず刻む（自分の行を自分で孤児と見なさないため）
    services.confessions.heartbeatInstance(services.confessions.instance);
    recoverConfessionOrphans(services);
  });
}

/**
 * 鼓動の間隔。貸出期限（150秒）に対して十分短く取る。
 *
 * **重い刻時盤の列に混ぜない。** 刻時盤は1周が長く、しかも前の周が終わるまで
 * 次が始まらない。鼓動より前の無関係な処理が貸出期限より長く詰まると、
 * プロセスは生きているのに「死んだ所有者」に見え、別インスタンスが実行を奪える。
 * だから鼓動だけは、他の待ちに巻き込まれない独立した間隔で打つ。
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/** 鼓動を打ち始める。停止するまで、他タスクの完了を待たずに更新し続ける */
export function startConfessionHeartbeat(
  services: Services,
  intervalMs = HEARTBEAT_INTERVAL_MS,
): ReturnType<typeof setInterval> {
  stopConfessionHeartbeat();
  services.confessions.heartbeatInstance(services.confessions.instance);
  const timer = setInterval(() => {
    try {
      services.confessions.heartbeatInstance(services.confessions.instance);
    } catch (error) {
      console.error("[トート] 生存の記録に失敗:", error);
    }
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  heartbeatTimer = timer;
  return timer;
}

/** 停止（テストと shutdown 用）。止めれば貸出期限の経過で回収対象になる */
export function stopConfessionHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

/** テスト用。関門の状態を差し替える／解除する。 */
export function __setConfessionBarrierForTest(promise: Promise<void> | null): void {
  startupComplete = promise;
}
