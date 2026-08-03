import { REST, Routes } from "discord.js";
import { config } from "./config.js";
import { adminCommand } from "./commands/admin-hub.js";
import { shokanCommand } from "./commands/shokan.js";
import { transferCommand } from "./commands/transfer.js";
import { sessionCommand } from "./commands/entry.js";
import { sessionScheduleCommand } from "./commands/session-schedule.js";
import { evaluationCommand } from "./commands/evaluation.js";
import { profileCommand } from "./commands/profile.js";
import { departmentCommand } from "./commands/department.js";
import { tipCommand } from "./commands/tip.js";
import { rankingCommand } from "./commands/ranking.js";
import { helpCommand } from "./commands/help.js";
import { asobuCommand } from "./commands/asobu.js";
import { dailyCommand } from "./commands/daily.js";
import { passportCommand } from "./commands/passport.js";
import { banzukeCommand } from "./commands/banzuke.js";
import { shobuCommand } from "./commands/shobu.js";
import { bakutenCommand } from "./commands/bakuten.js";
import { keibaCommand } from "./commands/keiba.js";
import { annaiCommand } from "./commands/annai.js";
import { vipCommand } from "./commands/vip.js";
import { nagareboshiCommand } from "./commands/nagareboshi.js";
import { itaCommand } from "./commands/ita.js";

// /管理 はBot内部で OWNER_ID / 管理コマンド利用ロールを検証する。
// Discord側のManageGuild制限を外し、設定したロール保持者にもコマンドを表示する。
const adminCommandJson = { ...adminCommand.toJSON(), default_member_permissions: null };

const commands = [
  // 運営（Bot内のロールゲート）
  adminCommandJson,
  shokanCommand.toJSON(),
  // スタッフ（役職ゲート）
  sessionCommand.toJSON(),
  sessionScheduleCommand.toJSON(),
  evaluationCommand.toJSON(),
  // 全員
  transferCommand.toJSON(),
  profileCommand.toJSON(),
  departmentCommand.toJSON(),
  tipCommand.toJSON(),
  rankingCommand.toJSON(),
  helpCommand.toJSON(),
  asobuCommand.toJSON(),
  dailyCommand.toJSON(),
  passportCommand.toJSON(),
  banzukeCommand.toJSON(),
  shobuCommand.toJSON(),
  bakutenCommand.toJSON(),
  keibaCommand.toJSON(),
  annaiCommand.toJSON(),
  vipCommand.toJSON(),
  nagareboshiCommand.toJSON(),
  itaCommand.toJSON(),
];

const rest = new REST().setToken(config.token);
const guildId = process.env.GUILD_ID;
const useGlobal = process.env.REGISTER_GLOBAL === "1" || !guildId;

if (useGlobal) {
  const result = (await rest.put(Routes.applicationCommands(config.clientId), { body: commands })) as unknown[];
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(config.clientId, guildId), { body: [] });
    console.log(`✅ ${result.length} 個をグローバル登録し、ギルド ${guildId} の重複登録を掃除しました（反映に数分〜1時間）`);
  } else {
    console.log(`✅ ${result.length} 個のコマンドを登録しました（グローバル）`);
  }
} else {
  await rest.put(Routes.applicationCommands(config.clientId), { body: [] });
  const result = (await rest.put(Routes.applicationGuildCommands(config.clientId, guildId), { body: commands })) as unknown[];
  console.log(`✅ ${result.length} 個のコマンドをギルド ${guildId} に登録しました（即時反映・グローバルは掃除済み）`);
}
