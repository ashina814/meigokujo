import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`環境変数 ${name} が未設定です。.env.example を参照してください。`);
    process.exit(1);
  }
  return value;
}

export const config = {
  token: required("DISCORD_TOKEN"),
  clientId: required("CLIENT_ID"),
  ownerId: required("OWNER_ID"),
  dbPath: process.env.DB_PATH ?? "./data/bot.db",
};
