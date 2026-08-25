export const CASTLE_EXPERIENCE_SUPER_DOMAINS = [
  "social",
  "economy_play",
  "castle_wide",
] as const;

export type CastleExperienceSuperDomain = (typeof CASTLE_EXPERIENCE_SUPER_DOMAINS)[number];

export interface CastleExperienceFamilyDefinition {
  readonly familyKey: string;
  readonly superDomain: CastleExperienceSuperDomain;
}

export interface CastleExperienceManifest {
  readonly editionKey: string;
  readonly version: number;
  readonly families: readonly CastleExperienceFamilyDefinition[];
}

function requireKey(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

/**
 * Manifest order is presentation-only. Canonical sorting makes semantic identity independent of
 * source order while duplicate/conflicting membership and unknown super-domains fail closed.
 */
export function defineCastleExperienceManifest(input: {
  readonly editionKey: unknown;
  readonly version: unknown;
  readonly families: readonly {
    readonly familyKey: unknown;
    readonly superDomain: unknown;
  }[];
}): CastleExperienceManifest {
  const editionKey = requireKey(input.editionKey, "editionKey");
  if (!Number.isSafeInteger(input.version) || (input.version as number) <= 0) {
    throw new Error("version must be a positive safe integer");
  }
  if (!Array.isArray(input.families) || input.families.length === 0) {
    throw new Error("families must not be empty");
  }

  const allowedSuperDomains = new Set<string>(CASTLE_EXPERIENCE_SUPER_DOMAINS);
  const seenFamilies = new Set<string>();
  const families = input.families.map((family) => {
    const familyKey = requireKey(family.familyKey, "familyKey");
    if (seenFamilies.has(familyKey)) throw new Error(`duplicate castle experience family: ${familyKey}`);
    seenFamilies.add(familyKey);
    if (typeof family.superDomain !== "string" || !allowedSuperDomains.has(family.superDomain)) {
      throw new Error(`unknown castle experience super-domain: ${String(family.superDomain)}`);
    }
    return { familyKey, superDomain: family.superDomain as CastleExperienceSuperDomain };
  }).sort((a, b) => a.familyKey.localeCompare(b.familyKey));

  return Object.freeze({
    editionKey,
    version: input.version as number,
    families: Object.freeze(families.map((family) => Object.freeze(family))),
  });
}

export function castleExperienceManifestSemanticIdentity(manifest: CastleExperienceManifest): string {
  const canonical = defineCastleExperienceManifest(manifest);
  return JSON.stringify({
    editionKey: canonical.editionKey,
    version: canonical.version,
    families: canonical.families,
  });
}

/**
 * Edition-I is an explicit experience taxonomy, not a projection of TITLE_SOURCES. New features,
 * roles, ranks, invites, evaluations, or title awards never join it without a reviewed new version.
 */
export const CASTLE_EXPERIENCE_EDITION_I_MANIFEST = defineCastleExperienceManifest({
  editionKey: "castle-experience-edition-i",
  version: 1,
  families: [
    { familyKey: "public_vc", superDomain: "social" },
    { familyKey: "public_tc", superDomain: "social" },
    { familyKey: "public_room", superDomain: "social" },
    { familyKey: "economy", superDomain: "economy_play" },
    { familyKey: "shop", superDomain: "economy_play" },
    { familyKey: "casino", superDomain: "economy_play" },
    { familyKey: "public_event", superDomain: "castle_wide" },
  ],
});

export type CastleExperienceFamilyKey =
  | "public_vc"
  | "public_tc"
  | "public_room"
  | "economy"
  | "shop"
  | "casino"
  | "public_event";
