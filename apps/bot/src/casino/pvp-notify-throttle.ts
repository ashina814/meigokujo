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
 * - 通知回数は募集者ユーザー単位で数える。
 * - 同一ユーザーは3募集連続まで通知する。
 * - 3回目の通知後、そのユーザーだけ5分間CDに入る。
 * - CD中も募集カード自体は通常どおり投稿する。
 * - 別ユーザーの募集通知は影響を受けない。
 * - 設定ミスや旧データがあっても、1募集あたり最大5ロールまでに制限する。
 *
 * 5分だけの荒らし抑止なので状態はプロセス内に持つ。再起動時にはリセットされる。
 */
export function takePvpNotifyRoleIds(challengerId: string, roleIds: string[], now = Date.now()): string[] {
  const unique = [...new Set(roleIds.filter(Boolean))].slice(0, PVP_NOTIFY_MAX_ROLES);
  if (unique.length === 0) return [];

  let current = states.get(challengerId) ?? { burstCount: 0, cooldownUntil: 0 };
  if (current.cooldownUntil > now) return [];
  if (current.cooldownUntil > 0) current = { burstCount: 0, cooldownUntil: 0 };

  const nextCount = current.burstCount + 1;
  if (nextCount >= PVP_NOTIFY_BURST_LIMIT) {
    states.set(challengerId, { burstCount: 0, cooldownUntil: now + PVP_NOTIFY_COOLDOWN_MS });
  } else {
    states.set(challengerId, { burstCount: nextCount, cooldownUntil: 0 });
  }

  return unique;
}

/** テスト間でプロセス内CDを持ち越さないための明示リセット。 */
export function resetPvpNotifyThrottleForTesting(): void {
  states.clear();
}
