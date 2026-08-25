export type SlashCommandStatus = "active" | "retired";

export interface SlashCommandMeta {
  readonly name: string;
  readonly status: SlashCommandStatus;
}

/** Discordへ現在登録するpublic slash surface。並びは従来のregistration順を維持する。 */
export const ACTIVE_SLASH_COMMANDS = [
  { name: "管理", status: "active" },
  { name: "商館", status: "active" },
  { name: "審判", status: "active" },
  { name: "説明会", status: "active" },
  { name: "評価", status: "active" },
  { name: "イベント参加記録", status: "active" },
  { name: "イベント完了記録", status: "active" },
  { name: "送金", status: "active" },
  { name: "プロフィール", status: "active" },
  { name: "部署", status: "active" },
  { name: "投げ銭", status: "active" },
  { name: "ランキング", status: "active" },
  { name: "あそびかた", status: "active" },
  { name: "賭場", status: "active" },
  { name: "通行証", status: "active" },
  { name: "板", status: "active" },
] as const satisfies readonly SlashCommandMeta[];

/** 登録へ戻してはいけないcasino slash surface。 */
export const RETIRED_SLASH_COMMANDS = [
  { name: "遊ぶ", status: "retired" },
  { name: "福分け", status: "retired" },
  { name: "賭場番付", status: "retired" },
  { name: "賭場商店", status: "retired" },
  { name: "競馬", status: "retired" },
  { name: "案内", status: "retired" },
  { name: "vip", status: "retired" },
  { name: "流れ星", status: "retired" },
  { name: "勝負", status: "retired" },
  { name: "株", status: "retired" },
] as const satisfies readonly SlashCommandMeta[];

export const SLASH_COMMANDS = [...ACTIVE_SLASH_COMMANDS, ...RETIRED_SLASH_COMMANDS] as const;

export type ActiveSlashCommandName = (typeof ACTIVE_SLASH_COMMANDS)[number]["name"];
export type RetiredSlashCommandName = (typeof RETIRED_SLASH_COMMANDS)[number]["name"];

export const ACTIVE_SLASH_COMMAND_NAMES = ACTIVE_SLASH_COMMANDS.map(({ name }) => name) as readonly ActiveSlashCommandName[];
export const RETIRED_SLASH_COMMAND_NAMES = RETIRED_SLASH_COMMANDS.map(({ name }) => name) as readonly RetiredSlashCommandName[];

const ACTIVE_NAME_SET = new Set<string>(ACTIVE_SLASH_COMMAND_NAMES);

export function isActiveSlashCommandName(name: string): name is ActiveSlashCommandName {
  return ACTIVE_NAME_SET.has(name);
}
