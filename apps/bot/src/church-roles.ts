import type { GuildMember } from "discord.js";
import type { ConfessionType, Disposition } from "@meigokujo/core";
import type { Services } from "./services.js";

/**
 * 冥教会・他機関ロールの対応付け（運営ボードから設定）。
 *
 * 設計方針:
 * - ロール名はコードに固定しない。運営ボードで選んだロールIDを Settings の
 *   `roles:<slot>` に **JSON配列** で保存する（複数ロール可・将来の担当交代に強い）。
 * - 旧 `role:ticket_staff` / `role:emergency_staff` は、新設定が未投入の間だけ
 *   フォールバックとして使う（§8 の段階移行）。運営ボードで設定が入れば新設定が優先。
 * - 「通知される資格」と「案件を閲覧・操作できる資格」は別物。ここは前者（＝どのロールを
 *   メンションするか／誰が入口を押せるか）だけを解決する。閲覧権は claim / 担当追加でのみ付く。
 */

/** ロール区分（運営ボードの設定スロット）。値が Settings のキー接尾辞になる */
export type RoleSlot =
  | "church_consult" // 相談対応（シスター・修道士）※複数
  | "church_manage" // 冥教会管理（大司教）
  | "normal_ops" // 通常運営（使令など）
  | "kaiwa" // 諧和廷担当
  | "court" // 冥府裁判所担当
  | "emergency" // 緊急対応担当
  | "opinion" // 意見・改善担当
  | "discipline"; // 規律対応担当

export const ROLE_SLOT_META: Record<RoleSlot, { label: string; hint: string; multi: boolean }> = {
  church_consult: { label: "相談対応ロール（シスター・修道士）", hint: "🕯️相談・🙏懺悔の一次対応。複数選択可", multi: true },
  church_manage: { label: "冥教会管理ロール（大司教）", hint: "冥教会案件の管理・担当調整・引継ぎ確認", multi: true },
  normal_ops: { label: "通常運営ロール（使令など）", hint: "サーバー規約対応・警告・処分は運営の管轄", multi: true },
  // 諧和廷はトートの対応先から廃止（旧運用）。既存 roles:kaiwa の読み取り用に型としては残すが、UIには出さない
  kaiwa: { label: "諧和廷担当ロール（旧運用・非表示）", hint: "廃止済み", multi: true },
  court: { label: "冥府裁判所担当ロール", hint: "冥府裁判所への送致先", multi: true },
  emergency: { label: "緊急対応担当ロール", hint: "🚨緊急の安全問題の通知先", multi: true },
  opinion: { label: "意見・改善担当ロール", hint: "📮意見・要望の通知先", multi: true },
  discipline: { label: "規律対応担当ロール", hint: "⚠️問題・規約違反の報告の通知先", multi: true },
};

// 運営ボードに表示する区分（諧和廷=kaiwa は廃止したため一覧から除外）
export const ROLE_SLOT_ORDER: RoleSlot[] = [
  "church_consult",
  "church_manage",
  "normal_ops",
  "court",
  "emergency",
  "opinion",
  "discipline",
];

const key = (slot: RoleSlot) => `roles:${slot}`;

/**
 * スロットに設定されたロールID一覧を返す。
 * 新設定（roles:<slot> JSON配列）が空なら、後方互換のため旧単一キーへフォールバックする。
 */
export function getRoleIds(services: Services, slot: RoleSlot): string[] {
  const list = services.settings.getJson<string[]>(key(slot), []);
  if (Array.isArray(list) && list.length > 0) return list.filter(Boolean);
  // ── フォールバック（新設定が未投入の間だけ）──
  if (slot === "emergency") {
    const legacy = services.settings.getString("role:emergency_staff");
    if (legacy) return [legacy];
  }
  if (slot === "church_consult") {
    const legacy = services.settings.getString("role:ticket_staff");
    if (legacy) return [legacy];
  }
  return [];
}

/** スロットのロールIDを保存（運営ボードから。空配列で解除） */
export function setRoleIds(services: Services, slot: RoleSlot, roleIds: string[], actor: string): void {
  services.settings.set(key(slot), roleIds, actor);
}

/** メンバーがそのスロットのいずれかのロールを持つか */
export function memberInSlot(member: GuildMember | null, services: Services, slot: RoleSlot): boolean {
  if (!member) return false;
  const ids = getRoleIds(services, slot);
  return ids.some((id) => member.roles.cache.has(id));
}

/** 冥教会管理ロール（大司教）保持者か */
export function isChurchManager(member: GuildMember | null, services: Services): boolean {
  return memberInSlot(member, services, "church_manage");
}

/** 相談対応ロール（シスター・修道士）保持者か */
export function isChurchConsult(member: GuildMember | null, services: Services): boolean {
  return memberInSlot(member, services, "church_consult");
}

// ── 通知の振り分け（§4 新着 / §7 対応先変更） ──────────────

/** 投稿種別 → 新着時に通知するスロット（§4） */
const TYPE_NOTIFY: Record<ConfessionType, RoleSlot[]> = {
  soudan: ["church_consult"],
  zange: ["church_consult"],
  iken: ["opinion"],
  houkoku: ["discipline", "normal_ops"],
  kinkyu: ["emergency"],
};

/** 対応先 → 変更時に通知するスロット（§7）。record・kaiwa（廃止）は通知なし */
const DISPO_NOTIFY: Record<Disposition, RoleSlot[]> = {
  church: ["church_consult"],
  normal: ["normal_ops"],
  kaiwa: [], // 諧和廷連携は廃止。既存案件の表示互換のため型には残すが新規通知はしない
  court: ["court"],
  emergency: ["emergency"],
  record: [],
};

/** 複数スロットのロールIDを重複なくまとめる */
function collectRoleIds(services: Services, slots: RoleSlot[]): string[] {
  const set = new Set<string>();
  for (const slot of slots) for (const id of getRoleIds(services, slot)) set.add(id);
  return [...set];
}

/** 新着投稿の通知先ロールID（§4）。全スロットが空なら ticket_staff フォールバック */
export function notifyRoleIdsForType(services: Services, type: ConfessionType | null): string[] {
  const slots = type ? TYPE_NOTIFY[type] : ["church_consult" as RoleSlot];
  const ids = collectRoleIds(services, slots ?? []);
  if (ids.length > 0) return ids;
  const legacy = services.settings.getString("role:ticket_staff");
  return legacy ? [legacy] : [];
}

/** 対応先変更の通知先ロールID（§7）。record は空 */
export function notifyRoleIdsForDisposition(services: Services, dispo: Disposition): string[] {
  return collectRoleIds(services, DISPO_NOTIFY[dispo] ?? []);
}

/** メンション用の content と allowedMentions を組み立てる（空なら content は undefined） */
export function roleMention(roleIds: string[]): { content: string | undefined; roleIds: string[] } {
  if (roleIds.length === 0) return { content: undefined, roleIds: [] };
  return { content: roleIds.map((id) => `<@&${id}>`).join(" "), roleIds };
}
