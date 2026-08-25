import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ENV_CONTRACT,
  ENV_EXAMPLE_NAMES,
  MissingRequiredEnvError,
  resolveBotRuntimeEnv,
  resolveInternalApiEnv,
} from "../src/env-contract.js";

const validStartup = {
  DISCORD_TOKEN: "test-token",
  CLIENT_ID: "test-client",
  OWNER_ID: "test-owner",
};

function source(path: string): string {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}

function exampleNames(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/u)?.[1])
    .filter((name): name is string => name !== undefined);
}

describe("runtime environment contract", () => {
  it("has no duplicate variable names", () => {
    const names = ENV_CONTRACT.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(["DISCORD_TOKEN", "CLIENT_ID", "OWNER_ID"] as const)("rejects missing required %s", (name) => {
    const env = { ...validStartup };
    delete env[name];
    expect(() => resolveBotRuntimeEnv(env)).toThrow(MissingRequiredEnvError);
    try {
      resolveBotRuntimeEnv(env);
    } catch (error) {
      expect(error).toMatchObject({ envName: name });
    }
  });

  it("preserves DB and formal-opening default semantics", () => {
    expect(resolveBotRuntimeEnv(validStartup)).toMatchObject({
      dbPath: "./data/bot.db",
      openingBackupDir: undefined,
    });
    expect(
      resolveBotRuntimeEnv({ ...validStartup, DB_PATH: "/custom/bot.db", CASINO_OPENING_BACKUP_DIR: "/safe/backups" }),
    ).toMatchObject({ dbPath: "/custom/bot.db", openingBackupDir: "/safe/backups" });
  });

  it("does not make registration-only variables startup requirements", () => {
    const resolved = resolveBotRuntimeEnv(validStartup);
    expect(resolved.token).toBe("test-token");
    expect(Object.keys(resolved)).not.toContain("guildId");
    expect(Object.keys(resolved)).not.toContain("registerGlobal");
  });

  it("disables the internal API without its token", () => {
    expect(resolveInternalApiEnv({})).toBeNull();
    expect(resolveInternalApiEnv({ ECONOMY_API_HOST: "127.0.0.1", ECONOMY_API_PORT: "9999" })).toBeNull();
  });

  it("preserves internal API host, port, and comma-separated host semantics", () => {
    expect(resolveInternalApiEnv({ ECONOMY_API_TOKEN: "test-secret" })).toEqual({
      token: "test-secret",
      hosts: ["172.17.0.1"],
      port: 8787,
    });
    expect(
      resolveInternalApiEnv({
        ECONOMY_API_TOKEN: "test-secret",
        ECONOMY_API_HOST: " 172.17.0.1, 172.18.0.1, ",
        ECONOMY_API_PORT: "9000",
      }),
    ).toEqual({ token: "test-secret", hosts: ["172.17.0.1", "172.18.0.1"], port: 9000 });
  });
});

describe("environment inventory coverage", () => {
  it("keeps .env.example exactly aligned with app-facing live variables", () => {
    const example = source("apps/bot/.env.example");
    expect(exampleNames(example)).toEqual(ENV_EXAMPLE_NAMES);
    for (const dead of ENV_CONTRACT.filter((entry) => entry.category === "obsolete-dead")) {
      expect(example).not.toContain(`${dead.name}=`);
    }
  });

  it("inventories every statically named process.env access in production bot source", () => {
    const production = [
      "apps/bot/src/config.ts",
      "apps/bot/src/internal-api.ts",
      "apps/bot/src/register-commands.ts",
      "apps/bot/src/resolve-boost-pending.ts",
      "apps/bot/src/casino/capacity-report.ts",
    ].map(source).join("\n");
    const accessed = [...production.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/gu)].map((match) => match[1]!);
    const inventoried = new Set(ENV_CONTRACT.map((entry) => entry.name));
    for (const name of accessed) expect(inventoried.has(name), `${name} is absent from ENV_CONTRACT`).toBe(true);
  });

  it("inventories deploy, systemd, bootstrap, and cron environment boundaries", () => {
    const deploy = source("deploy/deploy.sh");
    const deployInputs = [...deploy.matchAll(/^([A-Z][A-Z0-9_]*)="\$\{\1:-/gmu)].map((match) => match[1]!);
    const service = source("ecosystem/meigokujo-bot.service");
    const systemdNames = [...service.matchAll(/^Environment=([A-Z][A-Z0-9_]*)=/gmu)].map((match) => match[1]!);
    const bootstrap = source("deploy/bootstrap.sh");
    const bootstrapExports = [...bootstrap.matchAll(/^export ([A-Z][A-Z0-9_]*)=/gmu)].map((match) => match[1]!);
    const boundaryNames = new Set([
      ...deployInputs,
      ...systemdNames,
      ...bootstrapExports,
      "HOME",
      "PATH",
      "CRON_TZ",
    ]);
    const inventoried = new Set(
      ENV_CONTRACT.filter((entry) => entry.category === "service-runtime").map((entry) => entry.name),
    );
    for (const name of boundaryNames) expect(inventoried.has(name), `${name} is absent from service-runtime`).toBe(true);
  });

  it("mounts pure resolution at the impure production boundaries", () => {
    expect(source("apps/bot/src/config.ts")).toContain("resolveBotRuntimeEnv(process.env)");
    expect(source("apps/bot/src/internal-api.ts")).toContain("resolveInternalApiEnv(process.env)");
    expect(source("apps/bot/src/index.ts")).toContain("startInternalApi(services)");
  });
});
