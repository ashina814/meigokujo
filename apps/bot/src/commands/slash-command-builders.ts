import type { RESTPostAPIApplicationCommandsJSONBody } from "discord.js";
import { adminCommand } from "./admin-hub.js";
import { casinoHomeCommand } from "./casino-home.js";
import { departmentCommand } from "./department.js";
import { sessionCommand } from "./entry.js";
import { evaluationCommand } from "./evaluation.js";
import { helpCommand } from "./help.js";
import { itaCommand } from "./ita.js";
import { passportCommand } from "./passport.js";
import { profileCommand } from "./profile.js";
import { publicEventCompleteCommand } from "./public-event-complete.js";
import { publicEventRecordCommand } from "./public-event-record.js";
import { rankingCommand } from "./ranking.js";
import { sessionScheduleCommand } from "./session-schedule.js";
import { shokanCommand } from "./shokan.js";
import type { ActiveSlashCommandName } from "./slash-command-kinds.js";
import { tipCommand } from "./tip.js";
import { transferCommand } from "./transfer.js";

export interface SlashRegistrationBuilder {
  toJSON(): RESTPostAPIApplicationCommandsJSONBody;
}

/** ACTIVEを増やしたらbuilder追加を型で必須にする完全map。 */
export const ACTIVE_SLASH_COMMAND_BUILDERS = {
  管理: adminCommand,
  商館: shokanCommand,
  審判: sessionCommand,
  説明会: sessionScheduleCommand,
  評価: evaluationCommand,
  イベント参加記録: publicEventRecordCommand,
  イベント完了記録: publicEventCompleteCommand,
  送金: transferCommand,
  プロフィール: profileCommand,
  部署: departmentCommand,
  投げ銭: tipCommand,
  ランキング: rankingCommand,
  あそびかた: helpCommand,
  賭場: casinoHomeCommand,
  通行証: passportCommand,
  板: itaCommand,
} satisfies Record<ActiveSlashCommandName, SlashRegistrationBuilder>;
