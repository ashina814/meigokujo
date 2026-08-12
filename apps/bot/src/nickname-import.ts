import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type ButtonInteraction, type Guild } from "discord.js";
import { nicknameKey } from "@meigokujo/core";
import type { Services } from "./services.js";

/**
 * 制度導入前からの名前を正本へ取り込む（移行の1回だけ）。
 *
 * ## なぜ `displayName` を取り込まないか
 *
 * 正本は「城で登録したサーバーニックネーム」。ニックネーム未設定の人が
 * 見えているのは Discord のグローバル表示名で、**本人が城で名乗ると決めた名前ではない**。
 * それを勝手に登録すると、決めていない名前が正本になり、しかもその名前が
 * 予約されて他の人が取れなくなる。未設定は未設定のまま数だけ報告する。
 *
 * ## 誰も改名しない
 *
 * 取り込むだけで Discord 側は一切触らない。重複していた名前は
 * `legacy_conflict`（誰の持ち物でもない予約）になり、当人はそのまま。
 */
export interface ImportPreview {
  scanned: number;
  withNickname: number;
  withoutNickname: number;
  alreadyImported: number;
  newlyImportable: number;
  duplicateGroups: Array<{ display: string; users: string[] }>;
}

/** 取り込み対象。**ニックネームを実際に設定している人だけ** */
export async function collectGuildNames(guild: Guild): Promise<Array<{ userId: string; nickname: string }>> {
  const members = await guild.members.fetch();
  return [...members.values()]
    .filter((m) => !m.user.bot && m.nickname)
    .map((m) => ({ userId: m.id, nickname: m.nickname as string }));
}

/** 実行前に何が起きるかを数える。**DBは一切変えない** */
export async function previewLegacyImport(guild: Guild, services: Services): Promise<ImportPreview> {
  const members = await guild.members.fetch();
  const humans = [...members.values()].filter((m) => !m.user.bot);
  const named = humans.filter((m) => m.nickname);
  const fresh = named.filter((m) => !services.nicknames.get(m.id));
  // 重複の見立ては**取り込みと同じ鍵**で数える（見え方が違うと数が食い違う）
  const byKey = new Map<string, string[]>();
  for (const m of fresh) {
    const key = nicknameKey(m.nickname as string);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(m.id);
  }
  return {
    scanned: humans.length,
    withNickname: named.length,
    withoutNickname: humans.length - named.length,
    alreadyImported: named.length - fresh.length,
    newlyImportable: fresh.length,
    duplicateGroups: [...byKey.entries()]
      .filter(([, users]) => users.length > 1)
      .map(([key, users]) => ({ display: key, users })),
  };
}

export function legacyNameImportConfirm(preview: ImportPreview) {
  const embed = new EmbedBuilder()
    .setTitle("✒️ 既存の名前を正本へ取り込む")
    .setColor(0x0f766e)
    .setDescription(
      [
        "いまサーバーに設定されているニックネームを、名前の正本へ記録します。",
        "**誰の名前も変更しません。** Discord 側には一切触らず、記録を作るだけです。",
        "",
        `・対象メンバー: **${preview.scanned}名**`,
        `・ニックネームあり: **${preview.withNickname}名**（うち取り込み済み ${preview.alreadyImported}名）`,
        `・今回取り込む: **${preview.newlyImportable}名**`,
        `・ニックネーム未設定: **${preview.withoutNickname}名** … 取り込みません（本人が決めた名前ではないため）`,
        "",
        preview.duplicateGroups.length > 0
          ? [
              `⚠️ **重複 ${preview.duplicateGroups.length}組**（当人は改名しません）:`,
              ...preview.duplicateGroups.map((g) => `　「${g.display}」 ${g.users.map((u) => `<@${u}>`).join(" ")}`),
              "これらの名前は**誰の持ち物でもない予約**として押さえます。新規の方は取得できません。",
            ].join("\n")
          : "重複はありません。",
        "",
        "-# 何度実行しても同じ結果になります（取り込み済みの人は飛ばします）。",
      ].join("\n"),
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("mgmt:recover:names-run")
      .setLabel(`${preview.newlyImportable}名を取り込む`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(preview.newlyImportable === 0),
    new ButtonBuilder().setCustomId("mgmt:recover").setLabel("← 回収へ").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

export async function handleLegacyNameImportRun(interaction: ButtonInteraction, services: Services): Promise<void> {
  if (!interaction.guild) {
    await interaction.update({ content: "サーバー内で実行してください。", embeds: [], components: [] });
    return;
  }
  await interaction.update({ content: "⏳ 取り込み中…", embeds: [], components: [] });
  const entries = await collectGuildNames(interaction.guild);
  const result = services.nicknames.importLegacy(entries, `user:${interaction.user.id}`);
  const conflicts = services.nicknames.listConflicts();
  await interaction.editReply({
    content: [
      `✅ **${result.imported}名** の名前を取り込みました（飛ばした既存 ${result.skipped}名）。`,
      result.conflicted > 0
        ? `⚠️ **重複 ${result.conflicted}名**は \`conflict\` として記録し、名前そのものを予約しました（当人は改名していません）。`
        : "",
      conflicts.length > 0
        ? ["", "**解消待ちの重複:**", ...conflicts.map((c) => `・「${c.display}」 ${c.users.map((u) => `<@${u}>`).join(" ")}`)].join("\n")
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    allowedMentions: { parse: [] },
  });
}
