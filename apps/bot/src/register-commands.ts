import { REST, Routes } from "discord.js";
import { config } from "./config.js";
import { buildRegistrationPayload, resolveRegistrationTarget } from "./commands/slash-command-registration.js";

const rest = new REST().setToken(config.token);
const guildId = process.env.GUILD_ID;
const target = resolveRegistrationTarget({ guildId, registerGlobal: process.env.REGISTER_GLOBAL });
const commands = buildRegistrationPayload();

if (target.kind === "global") {
  const result = (await rest.put(Routes.applicationCommands(config.clientId), { body: commands })) as unknown[];
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(config.clientId, guildId), { body: [] });
    console.log(`✅ ${result.length} 個をグローバル登録し、ギルド ${guildId} の重複登録を掃除しました（反映に数分〜1時間）`);
  } else {
    console.log(`✅ ${result.length} 個のコマンドを登録しました（グローバル）`);
  }
} else {
  await rest.put(Routes.applicationCommands(config.clientId), { body: [] });
  const result = (await rest.put(Routes.applicationGuildCommands(config.clientId, target.guildId), { body: commands })) as unknown[];
  console.log(`✅ ${result.length} 個のコマンドをギルド ${target.guildId} に登録しました（即時反映・グローバルは掃除済み）`);
}
