import type { ChatInputCommandInteraction } from "discord.js";
import type { Services } from "../services.js";
import { handleAdminCommand } from "./admin-payroll-recovery.js";
import { handleCasinoHomeCommand } from "./casino-home.js";
import { handleDepartment } from "./department.js";
import { handleSessionCommand } from "./entry.js";
import { handleEvaluationCommand } from "./evaluation.js";
import { handleHelpCommand } from "./help.js";
import { handleItaCommand } from "./ita.js";
import { handlePassportCommand } from "./passport.js";
import { handleProfile } from "./profile.js";
import { handlePromote } from "./promote.js";
import { handlePublicEventCompleteCommand } from "./public-event-complete.js";
import { handlePublicEventRecordCommand } from "./public-event-record.js";
import { handleRankingCommand } from "./ranking.js";
import { handleSessionScheduleCommand } from "./session-schedule.js";
import { handleShokanCommand } from "./shokan.js";
import { isActiveSlashCommandName, type ActiveSlashCommandName } from "./slash-command-kinds.js";
import { handleTip } from "./tip.js";
import { handleTransfer } from "./transfer.js";

export type ActiveSlashCommandHandler = (
  interaction: ChatInputCommandInteraction,
  services: Services,
) => Promise<void>;

const handleJudgeCommand: ActiveSlashCommandHandler = async (interaction, services) => {
  if (interaction.options.getSubcommand() === "昇格") await handlePromote(interaction, services);
  else await handleSessionCommand(interaction, services);
};

/** Chat inputだけのruntime completeness boundary。autocompleteは別経路。 */
export const ACTIVE_SLASH_COMMAND_ROUTES = {
  管理: handleAdminCommand,
  商館: handleShokanCommand,
  審判: handleJudgeCommand,
  説明会: handleSessionScheduleCommand,
  評価: handleEvaluationCommand,
  イベント参加記録: handlePublicEventRecordCommand,
  イベント完了記録: handlePublicEventCompleteCommand,
  送金: handleTransfer,
  プロフィール: handleProfile,
  部署: handleDepartment,
  投げ銭: handleTip,
  ランキング: handleRankingCommand,
  あそびかた: handleHelpCommand,
  賭場: handleCasinoHomeCommand,
  通行証: handlePassportCommand,
  板: handleItaCommand,
} satisfies Record<ActiveSlashCommandName, ActiveSlashCommandHandler>;

export function getActiveSlashCommandRoute(name: string): ActiveSlashCommandHandler | undefined {
  return isActiveSlashCommandName(name) ? ACTIVE_SLASH_COMMAND_ROUTES[name] : undefined;
}
