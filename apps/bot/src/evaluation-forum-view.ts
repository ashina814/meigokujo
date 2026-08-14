import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } from "discord.js";
import type { EvaluationCycleContext, EvaluationPresenceSummary } from "@meigokujo/core/evaluation/forum";

const DEN_LOW_SECONDS = 30 * 60;
const SWORDSMAN_LOW_SECONDS = 15 * 60;

export interface EvaluationTargetView {
  userId: string;
  displayName: string;
  deadlineAt: number | null;
}

export const evaluationCommand = new SlashCommandBuilder()
  .setName("評価")
  .setDescription("評価フォーラム方式の案内を表示する")
  .setDMPermission(false);

export function evaluationPanelRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("eval:open")
      .setLabel("評価する亡霊を選択")
      .setStyle(ButtonStyle.Primary),
  );
}

/** DB上で評価中かつ、現在Discord Guildに在籍する人だけをUI対象にする。 */
export function currentGuildEvaluationTargets(
  cycles: EvaluationCycleContext[],
  members: ReadonlyMap<string, { displayName: string }>,
  omitUserId?: string,
): EvaluationTargetView[] {
  const targets: EvaluationTargetView[] = [];
  for (const cycle of cycles) {
    if (cycle.userId === omitUserId) continue;
    const member = members.get(cycle.userId);
    if (!member) continue;
    targets.push({
      userId: cycle.userId,
      displayName: member.displayName,
      deadlineAt: cycle.deadlineAt,
    });
  }
  return targets;
}

export function evaluationReferenceText(summary: EvaluationPresenceSummary): string {
  if (summary.denSeconds < DEN_LOW_SECONDS) {
    return "巣穴での活動がまだ少なく、評価材料が不足している可能性があります。";
  }
  if (summary.swordsmanSeconds < SWORDSMAN_LOW_SECONDS) {
    return "巣穴への参加はありますが、魔剣士との同席が少なく、評価機会が不足している可能性があります。";
  }
  return "魔剣士との同席機会があります。評価できる材料があるか確認してみてください。";
}

export function threadTitleFor(displayName: string, _deadlineTs?: number | null): string {
  const suffix = "｜亡霊評価";
  return `${displayName.slice(0, Math.max(1, 95 - suffix.length))}${suffix}`.slice(0, 95);
}

export const evaluationForumThresholdsForTesting = {
  denLowSeconds: DEN_LOW_SECONDS,
  swordsmanLowSeconds: SWORDSMAN_LOW_SECONDS,
};
