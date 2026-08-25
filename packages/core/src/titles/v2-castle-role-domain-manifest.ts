import { ROLE_FAMILY_TAGS, type RoleFamilyTag } from "../role-family/temporal.js";
import {
  CASTLE_EXPERIENCE_EDITION_I_MANIFEST,
  type CastleExperienceFamilyKey,
} from "./v2-castle-experience-manifest.js";

export const CASTLE_ROLE_NORMAL_FAMILIES = [
  "public_vc",
  "public_tc",
  "public_room",
  "economy",
  "shop",
  "casino",
] as const satisfies readonly CastleExperienceFamilyKey[];

export type CastleRoleNormalFamilyKey = (typeof CASTLE_ROLE_NORMAL_FAMILIES)[number];

export interface CastleRoleDomainAssignment {
  readonly sourceTag: RoleFamilyTag;
  readonly targetFamily: CastleRoleNormalFamilyKey;
}

export interface CastleRoleDomainManifest {
  readonly editionKey: string;
  readonly version: number;
  readonly assignments: readonly CastleRoleDomainAssignment[];
}

function requireKey(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

/**
 * Role-family tag→Castle normal familyのimmutable semantic bridge。
 * current departments/role IDsからdynamic生成せず、public_eventはnormal activityへ入れない。
 */
export function defineCastleRoleDomainManifest(input: {
  readonly editionKey: unknown;
  readonly version: unknown;
  readonly assignments: readonly { readonly sourceTag: unknown; readonly targetFamily: unknown }[];
}): CastleRoleDomainManifest {
  const editionKey = requireKey(input.editionKey, "editionKey");
  if (!Number.isSafeInteger(input.version) || (input.version as number) <= 0) {
    throw new Error("version must be a positive safe integer");
  }
  if (!Array.isArray(input.assignments) || input.assignments.length === 0) {
    throw new Error("assignments must not be empty");
  }
  const tags = new Set<string>(ROLE_FAMILY_TAGS);
  const editionFamilies = new Set(CASTLE_EXPERIENCE_EDITION_I_MANIFEST.families.map((family) => family.familyKey));
  const normalFamilies = new Set<string>(CASTLE_ROLE_NORMAL_FAMILIES);
  const seenTags = new Set<string>();
  const assignments = input.assignments.map((assignment) => {
    const sourceTag = requireKey(assignment.sourceTag, "sourceTag");
    const targetFamily = requireKey(assignment.targetFamily, "targetFamily");
    if (!tags.has(sourceTag) || sourceTag === "public_department") {
      throw new Error(`unknown castle role-domain source tag: ${sourceTag}`);
    }
    if (seenTags.has(sourceTag)) throw new Error(`duplicate castle role-domain source tag: ${sourceTag}`);
    seenTags.add(sourceTag);
    if (!editionFamilies.has(targetFamily)) throw new Error(`unknown Castle Edition-I family: ${targetFamily}`);
    if (!normalFamilies.has(targetFamily)) throw new Error(`non-normal Castle role-domain family: ${targetFamily}`);
    return { sourceTag: sourceTag as RoleFamilyTag, targetFamily: targetFamily as CastleRoleNormalFamilyKey };
  }).sort((a, b) => a.sourceTag.localeCompare(b.sourceTag));
  return Object.freeze({
    editionKey,
    version: input.version as number,
    assignments: Object.freeze(assignments.map((assignment) => Object.freeze(assignment))),
  });
}

export function castleRoleDomainManifestSemanticIdentity(manifest: CastleRoleDomainManifest): string {
  const canonical = defineCastleRoleDomainManifest(manifest);
  return JSON.stringify(canonical);
}

export const CASTLE_ROLE_DOMAIN_EDITION_I_MANIFEST = defineCastleRoleDomainManifest({
  editionKey: "castle-role-domain-edition-i",
  version: 1,
  assignments: [
    { sourceTag: "inn", targetFamily: "public_room" },
    { sourceTag: "economy", targetFamily: "economy" },
    { sourceTag: "shop", targetFamily: "shop" },
    { sourceTag: "casino", targetFamily: "casino" },
  ],
});
