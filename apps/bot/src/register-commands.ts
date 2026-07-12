import { REST, Routes } from "discord.js";
import { config } from "./config.js";
import { adminCommand } from "./commands/admin-hub.js";
import { shokanCommand } from "./commands/shokan.js";
import { transferCommand } from "./commands/transfer.js";
import { sessionCommand } from "./commands/entry.js";
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

const commands = [
  // 運営（ManageGuildで一般には非表示。全部ここに畳んだ）
  adminCommand.toJSON(),
  shokanCommand.toJSON(),
  // スタッフ（役職ゲート）
  sessionCommand.toJSON(),
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
