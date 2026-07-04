import { REST, Routes } from "discord.js";
import { config } from "./config.js";
import { settingsCommand } from "./commands/settings.js";
import { transferCommand } from "./commands/transfer.js";
import { panelCommand } from "./commands/bank-panel.js";
import { adjustCommand } from "./commands/adjust.js";
import { salaryTableCommand } from "./commands/salary-table.js";
import { paydayCommand } from "./commands/payday-command.js";
import { migrationCommand } from "./commands/migration.js";
import { sessionCommand } from "./commands/entry.js";
import { evaluationCommand } from "./commands/evaluation.js";
import { promoteCommand } from "./commands/promote.js";
import { dashboardCommand } from "./commands/dashboard-command.js";
import { profileCommand } from "./commands/profile.js";
import { departmentCommand } from "./commands/department.js";
import { tipCommand } from "./commands/tip.js";
import { auctionCommand } from "./commands/auction.js";
import { lotteryCommand } from "./commands/lottery.js";
import { raceCommand } from "./commands/race.js";
import { taxCommand, pensionCommand } from "./commands/fiscal.js";

const commands = [
  settingsCommand.toJSON(),
  transferCommand.toJSON(),
  panelCommand.toJSON(),
  adjustCommand.toJSON(),
  salaryTableCommand.toJSON(),
  paydayCommand.toJSON(),
  migrationCommand.toJSON(),
  sessionCommand.toJSON(),
  evaluationCommand.toJSON(),
  promoteCommand.toJSON(),
  dashboardCommand.toJSON(),
  profileCommand.toJSON(),
  departmentCommand.toJSON(),
  tipCommand.toJSON(),
  auctionCommand.toJSON(),
  lotteryCommand.toJSON(),
  raceCommand.toJSON(),
  taxCommand.toJSON(),
  pensionCommand.toJSON(),
];

const rest = new REST().setToken(config.token);
const guildId = process.env.GUILD_ID;
// REGISTER_GLOBAL=1 で本番用グローバル登録を強制。GUILD_ID 未設定でもグローバル。
const useGlobal = process.env.REGISTER_GLOBAL === "1" || !guildId;

if (useGlobal) {
  const result = (await rest.put(Routes.applicationCommands(config.clientId), {
    body: commands,
  })) as unknown[];
  // 開発ギルドが分かっているなら、そのギルド登録を必ず掃除する（グローバルと二重表示になるため）
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(config.clientId, guildId), { body: [] });
    console.log(`✅ ${result.length} 個をグローバル登録し、ギルド ${guildId} の重複登録を掃除しました（反映に数分〜1時間）`);
  } else {
    console.log(`✅ ${result.length} 個のコマンドを登録しました（グローバル。反映に数分〜1時間かかることがあります）`);
  }
} else {
  // ギルド登録は即時反映（開発用）。グローバル側は空にして重複表示を防ぐ
  await rest.put(Routes.applicationCommands(config.clientId), { body: [] });
  const result = (await rest.put(Routes.applicationGuildCommands(config.clientId, guildId), {
    body: commands,
  })) as unknown[];
  console.log(`✅ ${result.length} 個のコマンドをギルド ${guildId} に登録しました（即時反映・グローバルは掃除済み）`);
}
