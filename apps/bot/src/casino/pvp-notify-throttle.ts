export const PVP_NOTIFY_MAX_ROLES = 5;
export const PVP_NOTIFY_BURST_LIMIT = 3;
export const PVP_NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;

type NotifyState = {
  burstCount: number;
  cooldownUntil: number;
};

const states = new Map<string, NotifyState>();

/**
 * 公開1v1募集で実際にメンションしてよいロールだけを返す。
 *
 * - 同一ロールは3回連続まで通知する。
 * - 3回目の通知後、そのロールだけ5分間CDに入る。
 * - CD中も募集カード自体は通常どおり投稿する。
 * - 複数ロールはロールごとに独立して数える。
 * - 設定ミスや旧データがあっても、1募集あたり最大5ロールまでに制限する。
 *
 * 5分だけの荒らし抑止なので状態はプロセス内に持つ。再起動時にはリセットされる。
 */
export function takePvpNotifyRoleIds(roleIds: string[], now = Date.now()): string[] {
  const unique = [...new Set(roleIds.filter(Boolean))].slice(0, PVP_NOTIFY_MAX_ROLES);
  const allowed: string[] = [];

  for (const roleId of unique) {
    const previous = states.get(roleId);
    const current = !previous || now >= previous.cooldownUntil
      ? { burstCount: 0, cooldownUntil: 0 }
      : previous;

    if (current.cooldownUntil > now) continue;

    allowed.push(roleId);
    const nextCount = current.burstCount + 1;
    if (nextCount >= PVP_NOTIFY_BURST_LIMIT) {
      states.set(roleId, { burstCount: 0, cooldownUntil: now + PVP_NOTIFY_COOLDOWN_MS });
    } else {
      states.set(roleId, { burstCount: nextCount, cooldownUntil: 0 });
    }
  }

  return allowed;
}

/** テスト間でプロセス内CDを持ち越さないための明示リセット。 */
export function resetPvpNotifyThrottleForTesting(): void {
  states.clear();
}
