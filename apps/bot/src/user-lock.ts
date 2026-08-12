const locks = new Map<string, Promise<unknown>>();

/**
 * 同じ相手への操作を**同時に2本走らせない。**
 *
 * DBの書き込みだけを直列化しても足りない場面がある。名前の設定は
 * 「予約を取る → Discord へ設定する → 失敗したら予約を戻す」の3手で、
 * 途中に必ず待ちが入る。同じ人が A と B を並行に送ると、
 *
 * - Aの巻き戻しが、後から入ったBの正本を消す
 * - DBはB・Discordの表示はA、という食い違いが残る
 *
 * のどちらかが起きる。区間まるごとをここで直列化して、2本目は1本目が
 * 完全に終わってから走らせる。Botは単一プロセスなので、プロセス内で足りる。
 */
export function withUserLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(key);
  const next = (previous ? previous.then(noop, noop) : Promise.resolve()).then(run);
  locks.set(key, next);
  return next.finally(() => {
    // 後続が並んでいれば、その最後の1本だけが自分を消す
    if (locks.get(key) === next) locks.delete(key);
  });
}

function noop(): void {
  /* 直前の操作の成否は次の操作の判定に影響しない（毎回いまのDBを見る） */
}
