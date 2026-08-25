import type { ChatInputCommandInteraction } from "discord.js";
import { replyStocksPaused } from "../casino/stocks-pause.js";
import type { Services } from "../services.js";
import { handleAnnaiCommand } from "./annai.js";
import { handleAsobuCommand } from "./asobu.js";
import { handleBakutenCommand } from "./bakuten.js";
import { handleBanzukeCommand } from "./banzuke.js";
import { handleDailyCommand } from "./daily.js";
import { handleKeibaCommand } from "./keiba.js";
import { handleNagareboshiCommand } from "./nagareboshi.js";
import { handleShobuCommand } from "./shobu.js";
import type { RetiredSlashCommandName } from "./slash-command-kinds.js";
import { handleVipCommand } from "./vip.js";

export const LEGACY_COMPAT_SLASH_NAMES = [
  "遊ぶ",
  "福分け",
  "賭場番付",
  "賭場商店",
  "競馬",
  "案内",
  "vip",
  "流れ星",
  "勝負",
  "株",
] as const satisfies readonly RetiredSlashCommandName[];

export type LegacyCompatSlashCommandName = (typeof LEGACY_COMPAT_SLASH_NAMES)[number];
export type LegacyCompatSlashCommandHandler = (
  interaction: ChatInputCommandInteraction,
  services: Services,
) => Promise<void>;

const LEGACY_NAME_SET = new Set<string>(LEGACY_COMPAT_SLASH_NAMES);

export function isLegacyCompatSlashCommand(name: string): name is LegacyCompatSlashCommandName {
  return LEGACY_NAME_SET.has(name);
}

/** 既にDiscord側へ残っている旧interactionだけを受ける。registrationには使用しない。 */
export const LEGACY_COMPAT_SLASH_ROUTES = {
  遊ぶ: handleAsobuCommand,
  福分け: handleDailyCommand,
  賭場番付: handleBanzukeCommand,
  賭場商店: handleBakutenCommand,
  競馬: handleKeibaCommand,
  案内: handleAnnaiCommand,
  vip: handleVipCommand,
  流れ星: handleNagareboshiCommand,
  勝負: handleShobuCommand,
  株: replyStocksPaused,
} satisfies Record<LegacyCompatSlashCommandName, LegacyCompatSlashCommandHandler>;

export function getLegacyCompatSlashCommandRoute(name: string): LegacyCompatSlashCommandHandler | undefined {
  return isLegacyCompatSlashCommand(name) ? LEGACY_COMPAT_SLASH_ROUTES[name] : undefined;
}
