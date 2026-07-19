import type { GuildMember } from "discord.js";
import type { Services } from "./services.js";

/**
 * 特別プロフィール役職（§9-§14）。
 *
 * 既存の「Discordロール」を、プロフィール上の特別役職へ対応付ける。Botはロールを作らない。
 * 運営ボードで選んだロールIDと表示設定を Settings の `special_profile_roles` に JSON配列で保存する。
 * プロフィール描画時に、対象者が持つロールと突き合わせ、最も優先度の高い有効エントリを主要役職として扱う。
 *
 * ロールIDをコードの各所へ直書きしない（§15-12）。魔王の初期値もこの1ファイルだけが握り、
 * 起動時シード後は運営ボードから変更できる。
 */

/** 装飾スタイル。カード描画側（profile-card.ts）が解釈する */
export type SpecialStyle = "maou" | "gold" | "crimson" | "plain";

export const SPECIAL_STYLE_META: Record<SpecialStyle, string> = {
  maou: "魔王専用（王冠・玉座・黒×深紅×金）",
  gold: "金の威厳",
  crimson: "深紅の格式",
  plain: "装飾なし（名前のみ強調）",
};

export interface SpecialProfileEntry {
  roleId: string;
  name: string; // プロフィール上の表示名
  priority: number; // 大きいほど上位（同時保持時に優先）
  desc: string; // 説明文
  style: SpecialStyle; // 装飾スタイル
  enabled: boolean;
}

const SETTINGS_KEY = "special_profile_roles";

/** 魔王ロール（既にサーバーに存在するロール）。初期シード専用。以後は運営ボードで変更可 */
export const MAOU_ROLE_ID = "1463890550544404531";

const MAOU_DESC = "冥獄城の玉座に座し、城の最終意思を示す者。\nその言葉は冥獄に響き、城の行く末を決する。";

/** 初期シード（未設定時のみ投入）。魔王を最上位の特別役職として対応付ける */
export const DEFAULT_SPECIAL_PROFILES: SpecialProfileEntry[] = [
  { roleId: MAOU_ROLE_ID, name: "魔王", priority: 100, desc: MAOU_DESC, style: "maou", enabled: true },
];

/** 起動時シード。まだ一度も設定されていなければ既定を書き込む（再起動後も維持される） */
export function seedSpecialProfiles(services: Services): void {
  if (services.settings.getString(SETTINGS_KEY) === undefined) {
    services.settings.set(SETTINGS_KEY, DEFAULT_SPECIAL_PROFILES, "system:seed");
  }
}

export function getSpecialProfiles(services: Services): SpecialProfileEntry[] {
  const list = services.settings.getJson<SpecialProfileEntry[]>(SETTINGS_KEY, DEFAULT_SPECIAL_PROFILES);
  return Array.isArray(list) ? list : DEFAULT_SPECIAL_PROFILES;
}

export function setSpecialProfiles(services: Services, entries: SpecialProfileEntry[], actor: string): void {
  services.settings.set(SETTINGS_KEY, entries, actor);
}

/** 対象ロールのエントリを追加・更新（同一 roleId は上書き） */
export function upsertSpecialProfile(services: Services, entry: SpecialProfileEntry, actor: string): void {
  const list = getSpecialProfiles(services).filter((e) => e.roleId !== entry.roleId);
  list.push(entry);
  setSpecialProfiles(services, list, actor);
}

export function removeSpecialProfile(services: Services, roleId: string, actor: string): void {
  setSpecialProfiles(
    services,
    getSpecialProfiles(services).filter((e) => e.roleId !== roleId),
    actor,
  );
}

export function toggleSpecialProfile(services: Services, roleId: string, actor: string): void {
  const list = getSpecialProfiles(services).map((e) => (e.roleId === roleId ? { ...e, enabled: !e.enabled } : e));
  setSpecialProfiles(services, list, actor);
}

/**
 * 対象メンバーが持つ特別役職のうち、有効かつ最も優先度が高いものを主要役職として返す。
 * 兼任として他の特別役職も返す（§13）。無ければ null。
 */
export function resolveSpecialProfile(
  member: GuildMember | null,
  services: Services,
): { primary: SpecialProfileEntry; others: SpecialProfileEntry[] } | null {
  if (!member) return null;
  const held = getSpecialProfiles(services)
    .filter((e) => e.enabled && member.roles.cache.has(e.roleId))
    .sort((a, b) => b.priority - a.priority);
  if (held.length === 0) return null;
  return { primary: held[0]!, others: held.slice(1) };
}
