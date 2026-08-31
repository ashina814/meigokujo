/**
 * **このプロセスが、自分の起動時収束を追い越さないようにするだけの関門。**
 *
 * 前のプロセスが残した `held` は「落ちた所有者のもの」なので、再起動直後にだけ
 * 収束してよい。ところがその収束を待たずに新しい worker が走り出すと、
 *
 *     起動時収束が古い held を調べている最中
 *     ↓
 *     新しい worker が同じ資源を取りにいく
 *
 * となり、「前のプロセスは死んでいて、新しい worker はまだ動いていない」という
 * 前提そのものが崩れる。だから外部効果へ触る入口はここを通ってから進む。
 *
 * **これは所有権の正本ではない。** 正本はDBの実行権（`shop_external_effect_locks`）で、
 * こちらはプロセス内の順序づけしかしない。だから process-local な Promise でよいし、
 * 別の durable な表を増やす必要もない。
 *
 * **失敗しても関門は開く。** Discord が見えないなどで収束できなかった資源は、
 * DB側の live な実行権がそのまま残って**その資源だけ**を塞ぎ続ける。
 * 関門を閉じたままにしてBot全体を止める必要はないし、逆に「収束できなかったから
 * 解放してよい」でもない。分からないものは分からないまま残す。
 */

let startupComplete: Promise<void> | null = null;

/**
 * 起動時収束を開始し、関門をそれに結びつける。**ready の早い段階で1度だけ呼ぶ。**
 *
 * 収束が失敗しても reject させない（関門は開く）。未解決の実行権はDB側に残り、
 * その資源への取得を引き続き拒む。
 */
export function beginExternalEffectStartup(run: () => Promise<void>): void {
  startupComplete = run().catch((error) => {
    console.error("[ショップ] 起動時の外部効果収束に失敗（未解決の実行権はDBに残る）:", error);
  });
}

/**
 * 外部効果を取りにいく前に必ず待つ。
 *
 * 起動時収束が始まっていなければ即座に通す（テストや、まだ ready 前の経路）。
 * 待つのは**この1回だけ**で、以後はすでに解決済みの Promise を返すだけ。
 */
export async function awaitExternalEffectReady(): Promise<void> {
  if (startupComplete === null) return;
  await startupComplete;
}

/** テスト用。関門の状態を差し替える／解除する。 */
export function __setExternalEffectBarrierForTest(promise: Promise<void> | null): void {
  startupComplete = promise;
}
