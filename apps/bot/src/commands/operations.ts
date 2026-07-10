import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { handleLotteryCommand } from "./lottery.js";
import { handleAuctionCommand, handleAuctionAutocomplete } from "./auction.js";
import { handleRaceCommand, handleRaceAutocomplete } from "./race.js";
import { handleDepartment, handleDepartmentAutocomplete } from "./department.js";
import type { Services } from "../services.js";

/**
 * 運営操作の集約コマンド（ManageGuild で一般メンバーには非表示）。
 * 賭場（籤/競売/レース）と部署の"開催・管理"系をここに畳み、プレイヤーの
 * スラッシュ一覧から運営サブコマンドを消す。中身は既存ハンドラへ委譲するだけ
 * （各ハンドラは getSubcommand() と option 名で動くので、親が変わっても同じに動く）。
 */
export const operationsCommand = new SlashCommandBuilder()
  .setName("運営")
  .setDescription("運営操作（賭場・部署の管理）")
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommandGroup((g) =>
    g
      .setName("籤")
      .setDescription("輪廻籤の運営")
      .addSubcommand((s) =>
        s
          .setName("開催")
          .setDescription("新しい輪廻籤を開く")
          .addIntegerOption((o) => o.setName("価格").setDescription("1枚あたりの Land").setRequired(true).setMinValue(1))
          .addIntegerOption((o) => o.setName("時間").setDescription("抽選までの時間（h）").setRequired(true).setMinValue(1).setMaxValue(336))
          .addIntegerOption((o) => o.setName("控除率").setDescription("ハウスエッジ％（既定20）").setMinValue(0).setMaxValue(90)),
      )
      .addSubcommand((s) => s.setName("積立").setDescription("繰越を国庫から積む").addIntegerOption((o) => o.setName("金額").setDescription("Land").setRequired(true).setMinValue(1)))
      .addSubcommand((s) => s.setName("抽選").setDescription("開催中の籤を今すぐ抽選する"))
      .addSubcommand((s) => s.setName("取消").setDescription("開催中の籤を取り消して全額返金")),
  )
  .addSubcommandGroup((g) =>
    g
      .setName("競売")
      .setDescription("冥界競売の運営")
      .addSubcommand((s) =>
        s
          .setName("作成")
          .setDescription("競売を出品する")
          .addStringOption((o) => o.setName("品名").setDescription("出品名").setRequired(true).setMaxLength(100))
          .addIntegerOption((o) => o.setName("開始価格").setDescription("Land").setRequired(true).setMinValue(0))
          .addIntegerOption((o) => o.setName("時間").setDescription("締切までの時間（h）").setRequired(true).setMinValue(1).setMaxValue(168))
          .addStringOption((o) => o.setName("説明").setDescription("品の説明").setMaxLength(500))
          .addIntegerOption((o) => o.setName("最低増分").setDescription("1回の最低上乗せ額（既定1,000）").setMinValue(1)),
      )
      .addSubcommand((s) => s.setName("締切").setDescription("競売を早めに締め切って落札確定").addIntegerOption((o) => o.setName("競売").setDescription("対象").setRequired(true).setAutocomplete(true)))
      .addSubcommand((s) => s.setName("取消").setDescription("競売を取り消して返金").addIntegerOption((o) => o.setName("競売").setDescription("対象").setRequired(true).setAutocomplete(true))),
  )
  .addSubcommandGroup((g) =>
    g
      .setName("レース")
      .setDescription("冥馬レースの運営")
      .addSubcommand((s) =>
        s
          .setName("作成")
          .setDescription("レースを開催する")
          .addStringOption((o) => o.setName("出走馬").setDescription("カンマ区切りで2〜8頭").setRequired(true).setMaxLength(300))
          .addIntegerOption((o) => o.setName("時間").setDescription("発走までの時間（h）").setRequired(true).setMinValue(1).setMaxValue(168))
          .addStringOption((o) => o.setName("名前").setDescription("レース名").setMaxLength(100))
          .addIntegerOption((o) => o.setName("控除率").setDescription("ハウスエッジ％（既定10）").setMinValue(0).setMaxValue(90)),
      )
      .addSubcommand((s) => s.setName("発走").setDescription("レースを発走・清算する").addIntegerOption((o) => o.setName("レース").setDescription("対象").setRequired(true).setAutocomplete(true)))
      .addSubcommand((s) => s.setName("取消").setDescription("レースを取り消して全額返金").addIntegerOption((o) => o.setName("レース").setDescription("対象").setRequired(true).setAutocomplete(true))),
  )
  .addSubcommandGroup((g) =>
    g
      .setName("部署")
      .setDescription("部署口座の作成・削除")
      .addSubcommand((s) =>
        s
          .setName("作成")
          .setDescription("部署を作成／担当ロールを更新")
          .addStringOption((o) => o.setName("名前").setDescription("部署名（例: 賭博場）").setRequired(true).setMaxLength(40))
          .addRoleOption((o) => o.setName("担当ロール").setDescription("入出金できる部署員ロール").setRequired(true)),
      )
      .addSubcommand((s) => s.setName("削除").setDescription("部署を削除（残高0のときのみ）").addStringOption((o) => o.setName("部署").setDescription("削除する部署").setRequired(true).setAutocomplete(true))),
  );

export async function handleOperations(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  switch (interaction.options.getSubcommandGroup()) {
    case "籤":
      return handleLotteryCommand(interaction, services);
    case "競売":
      return handleAuctionCommand(interaction, services);
    case "レース":
      return handleRaceCommand(interaction, services);
    case "部署":
      return handleDepartment(interaction, services);
  }
}

export async function handleOperationsAutocomplete(interaction: AutocompleteInteraction, services: Services): Promise<void> {
  const group = interaction.options.getSubcommandGroup();
  if (group === "競売") return handleAuctionAutocomplete(interaction, services);
  if (group === "レース") return handleRaceAutocomplete(interaction, services);
  return handleDepartmentAutocomplete(interaction, services);
}
