import type { RESTPostAPIApplicationCommandsJSONBody } from "discord.js";
import { ACTIVE_SLASH_COMMAND_BUILDERS } from "./slash-command-builders.js";
import { ACTIVE_SLASH_COMMAND_NAMES } from "./slash-command-kinds.js";

export type RegistrationTarget =
  | { readonly kind: "global" }
  | { readonly kind: "guild"; readonly guildId: string };

export interface RegistrationTargetInput {
  readonly guildId?: string;
  readonly registerGlobal?: string;
}

/** 既存CLIのscope semanticsを副作用なしで確定する。 */
export function resolveRegistrationTarget({ guildId, registerGlobal }: RegistrationTargetInput): RegistrationTarget {
  if (registerGlobal === "1" || !guildId) return { kind: "global" };
  return { kind: "guild", guildId };
}

/** ACTIVE builderだけから、従来順のdeterministic payloadを作る。 */
export function buildRegistrationPayload(): RESTPostAPIApplicationCommandsJSONBody[] {
  return ACTIVE_SLASH_COMMAND_NAMES.map((name) => {
    const json = ACTIVE_SLASH_COMMAND_BUILDERS[name].toJSON();
    // /管理 はBot内部の OWNER_ID / role gateを使うため、従来どおりDiscord側制限を外す。
    return name === "管理" ? { ...json, default_member_permissions: null } : json;
  });
}
