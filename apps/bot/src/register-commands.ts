import { REST, Routes } from "discord.js";
import { config } from "./config.js";
import { settingsCommand } from "./commands/settings.js";
import { transferCommand } from "./commands/transfer.js";
import { panelCommand } from "./commands/bank-panel.js";

const commands = [settingsCommand.toJSON(), transferCommand.toJSON(), panelCommand.toJSON()];

const rest = new REST().setToken(config.token);
const result = (await rest.put(Routes.applicationCommands(config.clientId), {
  body: commands,
})) as unknown[];
console.log(`✅ ${result.length} 個のコマンドを登録しました（グローバル。反映に数分かかることがあります）`);
