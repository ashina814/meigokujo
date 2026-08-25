import "dotenv/config";
import {
  MissingRequiredEnvError,
  resolveBotRuntimeEnv,
  resolveOpeningBackupDir,
  type BotRuntimeEnv,
} from "./env-contract.js";

function loadRuntimeEnv(): BotRuntimeEnv {
  try {
    return resolveBotRuntimeEnv(process.env);
  } catch (error) {
    if (error instanceof MissingRequiredEnvError) {
      console.error(`環境変数 ${error.envName} が未設定です。.env.example を参照してください。`);
      process.exit(1);
    }
    throw error;
  }
}

const resolved = loadRuntimeEnv();

export const config = {
  token: resolved.token,
  clientId: resolved.clientId,
  ownerId: resolved.ownerId,
  dbPath: resolved.dbPath,
  // Formal-opening apply historically resolves this at operation time. Keep that timing while
  // making config.ts the single process.env owner for the casino opening path.
  get openingBackupDir() {
    return resolveOpeningBackupDir(process.env);
  },
};
