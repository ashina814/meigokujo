export function markWeightLimitForRoleIds(roleIds: Iterable<string>, caps: Record<string, number>): number {
  let max = 1;
  for (const roleId of roleIds) {
    const cap = caps[roleId];
    if (cap !== undefined && Number.isInteger(cap) && cap > 0) max = Math.max(max, cap);
  }
  return max;
}
