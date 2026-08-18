export const PVP_NOTIFY_MAX_ROLES = 10;
export const PVP_NOTIFY_BURST_LIMIT = 3;
export const PVP_NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;

type NotifyState = {
  burstCount: number;
  cooldownUntil: number;
  lastNotifiedAt: number;
};

export type PvpNotifyReservation = {
  roleIds: string[];
  status: "sent" | "cooldown" | "unconfigured";
  commit: () => void;
};

const states = new Map<string, NotifyState>();

/**
 * 公開1v1募集で、実際にメンションしてよいロールと通知枠の予約を返す。
 *
 * 通知回数は Discord への募集カード送信が成功した時点でのみ `commit()` する。
 * これにより送信失敗で通知枠だけ消費することを防ぐ。
 *
 * - 通知回数は募集者ユーザー単位で数える。
 * - 同一ユーザーは短時間の3募集連続まで通知する。
 * - 3回目の通知後、そのユーザーだけ5分間CDに入る。
 * - 通知間隔が5分以上空けば「連続」扱いをリセットする。
 * - CD中も募集カード自体は通常どおり投稿する。
 * - 別ユーザーの募集通知は影響を受けない。
 * - 設定ミスや旧データがあっても、1募集あたり最大10ロールまでに制限する。
 *
 * 5分だけの荒らし抑止なので状態はプロセス内に持つ。再起動時にはリセットされる。
 */
export function preparePvpNotify(
  challengerId: string,
  roleIds: string[],
  now = Date.now(),
): PvpNotifyReservation {
  const unique = [...new Set(roleIds.filter(Boolean))].slice(0, PVP_NOTIFY_MAX_ROLES);
  if (unique.length === 0) {
    return { roleIds: [], status: "unconfigured", commit: () => undefined };
  }

  let current = states.get(challengerId) ?? { burstCount: 0, cooldownUntil: 0, lastNotifiedAt: 0 };
  if (current.cooldownUntil > now) {
    return { roleIds: [], status: "cooldown", commit: () => undefined };
  }
  if (
    current.cooldownUntil > 0 ||
    (current.lastNotifiedAt > 0 && now - current.lastNotifiedAt >= PVP_NOTIFY_COOLDOWN_MS)
  ) {
    current = { burstCount: 0, cooldownUntil: 0, lastNotifiedAt: 0 };
  }

  let committed = false;
  return {
    roleIds: unique,
    status: "sent",
    commit: () => {
      if (committed) return;
      committed = true;
      const nextCount = current.burstCount + 1;
      if (nextCount >= PVP_NOTIFY_BURST_LIMIT) {
        states.set(challengerId, {
          burstCount: 0,
          cooldownUntil: now + PVP_NOTIFY_COOLDOWN_MS,
          lastNotifiedAt: now,
        });
      } else {
        states.set(challengerId, { burstCount: nextCount, cooldownUntil: 0, lastNotifiedAt: now });
      }
    },
  };
}

/** テスト間でプロセス内CDを持ち越さないための明示リセット。 */
export function resetPvpNotifyThrottleForTesting(): void {
  states.clear();
}
