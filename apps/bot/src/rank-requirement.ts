/**
 * ショップ等の「階級要件」を『〇〇以上』として判定する共通ヘルパー。
 *
 * 階級の序列（下から上）: 亡霊 < 魔人 < 魔族。
 * 要件ロールがこの序列に含まれる場合、そのロール**以上**のいずれかを
 * 持っていれば要件を満たす（魔族は亡霊要件の商品を買える）。
 * 序列外のロール（カスタムロール要件）は従来どおり完全一致。
 */

interface SettingsReader {
  getString(key: string): string | undefined;
}

/** 階級序列の設定キー（下から上の順） */
const RANK_ORDER_KEYS = ["role:ghost", "role:majin", "role:mazoku"] as const;

/** 設定済みの階級ロールIDを序列順（下→上）で返す */
export function rankOrderRoleIds(settings: SettingsReader): string[] {
  return RANK_ORDER_KEYS.map((k) => settings.getString(k)).filter((x): x is string => !!x);
}

/** requireRoleId を「以上」判定で満たすか。序列外ロールは完全一致 */
export function meetsRoleRequirement(
  settings: SettingsReader,
  memberRoleIds: readonly string[],
  requireRoleId: string,
): boolean {
  const order = rankOrderRoleIds(settings);
  const idx = order.indexOf(requireRoleId);
  if (idx === -1) return memberRoleIds.includes(requireRoleId);
  const acceptable = new Set(order.slice(idx));
  return memberRoleIds.some((r) => acceptable.has(r));
}

/** 要件表示用ラベル。階級序列内なら「<@&X> 以上」、序列外はそのまま */
export function requirementLabel(settings: SettingsReader, requireRoleId: string | null): string {
  if (!requireRoleId) return "なし";
  const order = rankOrderRoleIds(settings);
  // 最上位（魔族）に「以上」を付けても意味は同じだが、表記は統一しておく
  return order.includes(requireRoleId) ? `<@&${requireRoleId}> 以上` : `<@&${requireRoleId}>`;
}
