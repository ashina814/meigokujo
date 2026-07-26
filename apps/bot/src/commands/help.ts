import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import type { Services } from "../services.js";

/**
 * 住人向けの遊び方ガイド（オンボーディング）。運営設定に依存せず、常に使える一望。
 */
export const helpCommand = new SlashCommandBuilder()
  .setName("あそびかた")
  .setDescription("冥獄城の暮らしと遊びかたの案内")
  .setDMPermission(false);

export async function handleHelpCommand(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  const initialGrant = services.settings.getNumber("initial_grant");
  const initialGrantText = initialGrant > 0 ? `説明会参加後の初期Landは現在 **${initialGrant.toLocaleString("ja-JP")}Ld** です。` : "";

  const embed = new EmbedBuilder()
    .setTitle("📖 冥獄城の歩きかた")
    .setColor(0x6b21a8)
    .setDescription("初めての人が「次に何を押せばいいか」だけ拾える入口集です。迷ったら上から順にどうぞ。")
    .addFields(
      {
        name: "🚪 初めての人",
        value: [
          "入城案内・申請パネルから説明会を予約し、説明会VCへ参加してください。",
          "参加後は `/通行証` や `/プロフィール` で自分の状態を確認できます。",
          initialGrantText,
        ].filter(Boolean).join("\n"),
      },
      {
        name: "👤 プロフィール・通帳",
        value: [
          "`/プロフィール` — 階級、称号、在城日数、所持Landなどの確認。",
          "`/通行証` — 入城状態や案内の確認。",
          "銀行・通帳パネルでは残高照会と取引履歴を確認できます。",
        ].join("\n"),
      },
      {
        name: "💰 Land",
        value: [
          "`/送金` — 住人へLandを送る。",
          "`/投げ銭` — 気持ちを添えてLandを贈る。",
          "残高や履歴は、プロフィールや通帳系の表示から確認してください。",
        ].join("\n"),
      },
      {
        name: "⚔️ 評価・階級",
        value: [
          "亡霊は評価対象になり、評価・印が集まると階級が進みます。",
          "評価する側は `/評価` から対象者の評価を行います。",
          "期限や印数は評価パネル・対象スレッドの表示を確認してください。",
        ].join("\n"),
      },
      {
        name: "🛏 部屋・VC",
        value: [
          "部屋パネルから宿・蜜月・朧月・ゲーム部屋などを開けます。",
          "VC滞在や部屋の利用は自動記録され、条件に応じて表示や報酬へ反映されます。",
          "全員退出した一時部屋は自動で片付けられます。",
        ].join("\n"),
      },
      {
        name: "🏆 ランキング・賭場",
        value: [
          "`/ランキング` — Land、活動、bump/upなどの順位を見る入口。",
          "マモンの賭場は `/案内` から。チップ購入、スロット、勝負、競馬、板、市場、VIPなどへ進めます。",
          "賭場の詳しい使い方・注意は、賭場内の案内表示を優先してください。",
        ].join("\n"),
      },
      {
        name: "🕯️ 困った時",
        value: [
          "困りごと、相談、返信不要の声はトートの耳などの受付窓口へ。",
          "出戻り申請・個別相談など、用途別のチケット受付パネルがある場合は該当する入口を選んでください。",
        ].join("\n"),
      },
    )
    .setFooter({ text: "全部任意参加です。まずはプロフィール・通帳・案内から触るのがおすすめ。" });
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
