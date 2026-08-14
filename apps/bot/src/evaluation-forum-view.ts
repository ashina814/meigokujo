import { SlashCommandBuilder } from "discord.js";
import type { EvaluationPresenceSummary } from "@meigokujo/core/evaluation/forum";

const DEN_LOW_SECONDS = 30 * 60;
const SWORDSMAN_LOW_SECONDS = 15 * 60;

export const evaluationCommand = new SlashCommandBuilder()
  .setName("評価")
  .setDescription("評価フォーラム方式の案内を表示する")
  .setDMPermission(false);

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
