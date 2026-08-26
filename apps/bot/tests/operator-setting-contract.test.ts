import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SETTING_DEFAULTS } from "@meigokujo/core";
import {
  OPERATOR_SETTINGS,
  OPERATOR_SETTING_KINDS,
  INTERNAL_SETTING_KEY_FAMILIES,
  LEGACY_SETTING_KEYS,
  operatorSettingChoices,
  operatorSettingsFor,
} from "../src/commands/operator-setting-kinds.js";

const root = new URL("../../../", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

function tsSources(directory: URL): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) files.push(...tsSources(child));
    else if (entry.name.endsWith(".ts")) files.push(readFileSync(fileURLToPath(child), "utf8"));
  }
  return files;
}

function matchesFamily(key: string, family: string): boolean {
  return family.endsWith("*") ? key.startsWith(family.slice(0, -1)) : key === family;
}

describe("operator Settings registry", () => {
  it("has unique storage keys and unique UI keys within each kind", () => {
    const keys = OPERATOR_SETTINGS.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const kind of OPERATOR_SETTING_KINDS) {
      const uiKeys = operatorSettingsFor(kind).map((entry) => entry.uiKey);
      expect(new Set(uiKeys).size, kind).toBe(uiKeys.length);
    }
  });

  it("contains only supported kinds and reports the audited full inventory counts", () => {
    expect(Object.fromEntries(OPERATOR_SETTING_KINDS.map((kind) => [kind, operatorSettingsFor(kind).length]))).toEqual({
      channel: 25,
      category: 7,
      role: 19,
      number: 38,
      string: 8,
      "role-list": 10,
      "string-list": 2,
      json: 3,
    });
  });

  it("derives every admin UI group from the same registry", () => {
    for (const kind of OPERATOR_SETTING_KINDS) {
      expect(operatorSettingChoices(kind)).toEqual(
        operatorSettingsFor(kind)
          .filter((entry) => (entry.surface ?? "generic-settings-ui") === "generic-settings-ui")
          .map((entry) => [entry.uiKey, entry.label]),
      );
    }
    const admin = source("apps/bot/src/commands/admin-hub.ts");
    for (const kind of ["channel", "category", "role", "number"] as const) {
      expect(admin).toContain(`operatorSettingChoices("${kind}")`);
    }
    expect(admin).toContain("operatorSettingForUi(");
  });

  it("keeps internal runtime marker families out of the operator registry", () => {
    const keys = OPERATOR_SETTINGS.map((entry) => entry.key);
    for (const family of INTERNAL_SETTING_KEY_FAMILIES) {
      const prefix = family.replace(/\*$/u, "");
      expect(keys.some((key) => key.startsWith(prefix)), family).toBe(false);
    }
    for (const legacy of LEGACY_SETTING_KEYS) expect(keys).not.toContain(legacy);
  });

  it("gives every operator setting a live consumer or an explicit display-only classification", () => {
    for (const entry of OPERATOR_SETTINGS) {
      expect(source(entry.consumer.file), `${entry.key} consumer`).toContain(entry.consumer.needle);
      if (entry.consumerMode === "display-only") expect(entry.consumer.file).toContain("admin-hub.ts");
    }
  });

  it("classifies every static literal Settings read as operator, internal, or legacy", () => {
    const text = [
      ...tsSources(new URL("apps/bot/src/", root)),
      ...tsSources(new URL("packages/core/src/", root)),
    ].join("\n");
    const literalReads = new Set(
      [...text.matchAll(/settings\.(?:getString|getNumber|getJson)(?:<[^\n;]+?>)?\("([^"]+)"/gu)].map(
        (match) => match[1]!,
      ),
    );
    const operatorKeys = new Set(OPERATOR_SETTINGS.map((entry) => entry.key));
    for (const key of literalReads) {
      const classified =
        operatorKeys.has(key) ||
        INTERNAL_SETTING_KEY_FAMILIES.some((family) => matchesFamily(key, family)) ||
        LEGACY_SETTING_KEYS.includes(key as (typeof LEGACY_SETTING_KEYS)[number]);
      expect(classified, `${key} is not classified`).toBe(true);
    }
  });

  it("classifies every typed numeric default as operator-facing or legacy", () => {
    const operatorKeys = new Set(OPERATOR_SETTINGS.map((entry) => entry.key));
    for (const key of Object.keys(SETTING_DEFAULTS)) {
      expect(operatorKeys.has(key) || LEGACY_SETTING_KEYS.includes(key as never), `${key} is not classified`).toBe(true);
    }
  });

  it("does not retain proven-dead admin number settings", () => {
    const keys = OPERATOR_SETTINGS.map((entry) => entry.key);
    expect(keys).not.toContain("salary_period_days");
    expect(keys).not.toContain("ether_rate_base");
    expect(source("packages/core/src/settings/service.ts")).not.toContain("ether_rate_base:");
  });

  it("does not retain proven-dead legacy setting metadata or defaults", () => {
    for (const key of ["migration_cap", "roles:kaiwa", "vc_whitelist"]) {
      expect(LEGACY_SETTING_KEYS as readonly string[]).not.toContain(key);
    }
    expect(SETTING_DEFAULTS).not.toHaveProperty("migration_cap");
  });

  it("keeps every Discord select group within the 25-option boundary", () => {
    for (const kind of ["channel", "category", "role", "number"] as const) {
      expect(operatorSettingChoices(kind).length, kind).toBeLessThanOrEqual(25);
    }
  });
});
