import { REST, Routes } from "discord.js";
import { config } from "./config.js";
import { settingsCommand } from "./commands/settings.js";
import { transferCommand } from "./commands/transfer.js";
import { panelCommand } from "./commands/bank-panel.js";
import { adjustCommand } from "./commands/adjust.js";
import { salaryTableCommand } from "./commands/salary-table.js";
import { paydayCommand } from "./commands/payday-command.js";

const commands = [
  settingsCommand.toJSON(),
  transferCommand.toJSON(),
  panelCommand.toJSON(),
  adjustCommand.toJSON(),
  salaryTableCommand.toJSON(),
  paydayCommand.toJSON(),
];

const rest = new REST().setToken(config.token);
const guildId = process.env.GUILD_ID;
if (guildId) {
  // ギルド登録は即時反映（開発用）。グローバル側は空にして重複表示を防ぐ
  await rest.put(Routes.applicationCommands(config.clientId), { body: [] });
  const result = (await rest.put(Routes.applicationGuildCommands(config.clientId, guildId), {
    body: commands,
  })) as unknown[];
  console.log(`✅ ${result.length} 個のコマンドをギルド ${guildId} に登録しました（即時反映・グローバルは掃除済み）`);
} else {
  const result = (await rest.put(Routes.applicationCommands(config.clientId), {
    body: commands,
  })) as unknown[];
  console.log(`✅ ${result.length} 個のコマンドを登録しました（グローバル。反映に数分かかることがあります）`);
}
