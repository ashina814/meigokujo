export type EnvCategory =
  | "startup-required"
  | "app-optional-default"
  | "feature-gated"
  | "command-registration-only"
  | "service-runtime"
  | "obsolete-dead";

export interface EnvContractEntry {
  name: string;
  category: EnvCategory;
  /** Human-readable semantics only. Never put a credential value in this registry. */
  defaultSemantic?: string;
  exampleValue?: string;
  secret?: boolean;
}

/**
 * Repository-wide environment inventory.
 *
 * This is metadata, not runtime state: it intentionally contains names and semantics only.
 * Service/deploy variables are inventoried here even though bot config must not read them.
 */
export const ENV_CONTRACT = [
  { name: "DISCORD_TOKEN", category: "startup-required", secret: true, exampleValue: "" },
  { name: "CLIENT_ID", category: "startup-required", exampleValue: "" },
  { name: "OWNER_ID", category: "startup-required", exampleValue: "" },
  {
    name: "DB_PATH",
    category: "app-optional-default",
    defaultSemantic: "./data/bot.db",
    exampleValue: "./data/bot.db",
  },
  {
    name: "CASINO_OPENING_BACKUP_DIR",
    category: "feature-gated",
    defaultSemantic: "unset disables formal-opening apply; no path is inferred",
    exampleValue: "./data/casino-opening-backups",
  },
  {
    name: "ECONOMY_API_TOKEN",
    category: "feature-gated",
    defaultSemantic: "unset disables the internal economy API",
    secret: true,
    exampleValue: "",
  },
  {
    name: "ECONOMY_API_HOST",
    category: "feature-gated",
    defaultSemantic: "172.17.0.1; comma-separated hosts are supported",
    exampleValue: "172.17.0.1",
  },
  {
    name: "ECONOMY_API_PORT",
    category: "feature-gated",
    defaultSemantic: "8787",
    exampleValue: "8787",
  },
  { name: "GUILD_ID", category: "command-registration-only", exampleValue: "" },
  {
    name: "REGISTER_GLOBAL",
    category: "command-registration-only",
    defaultSemantic: "exactly 1 forces global registration; otherwise GUILD_ID selects guild registration",
    exampleValue: "0",
  },
  { name: "NODE_ENV", category: "service-runtime", defaultSemantic: "owned by systemd/test runtime" },
  { name: "TZ", category: "service-runtime", defaultSemantic: "Asia/Tokyo in systemd" },
  { name: "APP_USER", category: "service-runtime", defaultSemantic: "deploy.sh override; kabu" },
  { name: "APP_HOME", category: "service-runtime", defaultSemantic: "deploy.sh override; /home/kabu" },
  { name: "REPO", category: "service-runtime", defaultSemantic: "deploy.sh repository path override" },
  { name: "BRANCH", category: "service-runtime", defaultSemantic: "deploy.sh branch override; main" },
  { name: "REMOTE", category: "service-runtime", defaultSemantic: "deploy.sh remote override; origin" },
  { name: "SERVICE", category: "service-runtime", defaultSemantic: "deploy.sh systemd unit override" },
  { name: "BACKUP_SCRIPT", category: "service-runtime", defaultSemantic: "deploy.sh backup command override" },
  { name: "LOCK_FILE", category: "service-runtime", defaultSemantic: "deploy.sh lock path override" },
  { name: "STATE_FILE", category: "service-runtime", defaultSemantic: "deploy.sh deployed-SHA marker override" },
  { name: "HOME", category: "service-runtime", defaultSemantic: "deploy.sh sets the service-user home" },
  { name: "PATH", category: "service-runtime", defaultSemantic: "deploy.sh constructs the verified Node runtime path" },
  {
    name: "DEBIAN_FRONTEND",
    category: "service-runtime",
    defaultSemantic: "bootstrap.sh sets noninteractive package installation",
  },
  { name: "NVM_DIR", category: "service-runtime", defaultSemantic: "bootstrap.sh sets the service-user NVM path" },
  { name: "CRON_TZ", category: "service-runtime", defaultSemantic: "bootstrap.sh writes Asia/Tokyo for backup cron" },
  {
    name: "DEBUG_OPENING_RESET_CONCURRENCY",
    category: "service-runtime",
    defaultSemantic: "test-only diagnostic output switch",
  },
  {
    name: "CASINO_EVIDENCE_CHANNEL_ID",
    category: "obsolete-dead",
    defaultSemantic: "ranked-table evidence surface retired by #138; production references removed",
  },
  {
    name: "CASINO_ARBITRATOR_ROLE_ID",
    category: "obsolete-dead",
    defaultSemantic: "ranked-table arbitration surface retired by #138; production references removed",
  },
] as const satisfies readonly EnvContractEntry[];

export type EnvName = (typeof ENV_CONTRACT)[number]["name"];

const EXAMPLE_CATEGORIES = new Set<EnvCategory>([
  "startup-required",
  "app-optional-default",
  "feature-gated",
  "command-registration-only",
]);

export const ENV_EXAMPLE_NAMES = ENV_CONTRACT.filter((entry) => EXAMPLE_CATEGORIES.has(entry.category)).map(
  (entry) => entry.name,
);

export class MissingRequiredEnvError extends Error {
  constructor(readonly envName: "DISCORD_TOKEN" | "CLIENT_ID" | "OWNER_ID") {
    super(`environment variable ${envName} is required`);
    this.name = "MissingRequiredEnvError";
  }
}

export interface BotRuntimeEnv {
  token: string;
  clientId: string;
  ownerId: string;
  dbPath: string;
  openingBackupDir: string | undefined;
}

export function resolveDbPath(env: NodeJS.ProcessEnv): string {
  return env.DB_PATH ?? "./data/bot.db";
}

export function resolveOpeningBackupDir(env: NodeJS.ProcessEnv): string | undefined {
  return env.CASINO_OPENING_BACKUP_DIR || undefined;
}

function required(env: NodeJS.ProcessEnv, name: MissingRequiredEnvError["envName"]): string {
  const value = env[name];
  if (!value) throw new MissingRequiredEnvError(name);
  return value;
}

/** Pure startup config resolution; callers decide how to report a missing required value. */
export function resolveBotRuntimeEnv(env: NodeJS.ProcessEnv): BotRuntimeEnv {
  return {
    token: required(env, "DISCORD_TOKEN"),
    clientId: required(env, "CLIENT_ID"),
    ownerId: required(env, "OWNER_ID"),
    dbPath: resolveDbPath(env),
    // Empty and missing are both fail-closed at the opening adapter boundary.
    openingBackupDir: resolveOpeningBackupDir(env),
  };
}

export interface InternalApiRuntimeEnv {
  token: string;
  hosts: string[];
  port: number;
}

/** Pure feature-gate/default resolution shared by tests and the HTTP production boundary. */
export function resolveInternalApiEnv(env: NodeJS.ProcessEnv): InternalApiRuntimeEnv | null {
  const token = env.ECONOMY_API_TOKEN;
  if (!token) return null;
  return {
    token,
    hosts: (env.ECONOMY_API_HOST ?? "172.17.0.1")
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean),
    port: Number(env.ECONOMY_API_PORT ?? 8787),
  };
}
