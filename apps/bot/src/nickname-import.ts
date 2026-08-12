import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type ButtonInteraction, type Guild, type GuildMember } from "discord.js";
import {
  MEIREI_ROLE_SETTING_KEY,
  RANK_LADDER,
  RANK_ROLE_SETTING_KEYS,
  nicknameKey,
  type LegacyNameEntry,
} from "@meigokujo/core";
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
  /** 取り込む人の内訳。**報告する人数と実際に書く人数を一致させる** */
  byGroup: Record<MemberGroup, number>;
  /** ニックネーム未設定の内訳（取り込まないが、誰が残るかは見えるようにする） */
  unsetByGroup: Record<MemberGroup, number>;
  duplicateGroups: Array<{ display: string; users: string[] }>;
}

/**
 * いまどこに居る人か。**固定するかどうかがこれで決まる。**
 *
 * - `entered` … 既に城の中。名前はそこで確定している → 固定する
 * - `waiting` … まだ入城案内待ち。説明会まで直せる → 固定しない
 * - `other`  … 階級ロールも案内待ちロールも持たない（運営・特別枠）。
 *              入城導線には乗っていないので、案内待ち扱いにはしない → 固定する
 */
export type MemberGroup = "entered" | "waiting" | "other";

function rankRoleIds(services: Services): string[] {
  return [
    ...RANK_LADDER.map((rank) => services.settings.getString(RANK_ROLE_SETTING_KEYS[rank])),
    services.settings.getString(MEIREI_ROLE_SETTING_KEY),
  ].filter((id): id is string => !!id);
}

/**
 * ロールと台帳の両方を見る。どちらか一方でも「城の中」を示していれば入城済みとして扱う。
 * ロールが落ちているだけの人を案内待ち扱いにして、名前を未固定で取り込まないため。
 */
export function classifyMember(member: GuildMember, services: Services, ranks: string[]): MemberGroup {
  if (ranks.some((id) => member.roles.cache.has(id))) return "entered";
  const soul = services.entry.getSoul(member.id);
  if (soul && soul.status !== "waiting" && soul.status !== "departed") return "entered";
  const waitRoleId = services.settings.getString("role:queue_wait");
  if ((waitRoleId && member.roles.cache.has(waitRoleId)) || soul?.status === "waiting") return "waiting";
  return "other";
}

/** 取り込み対象。**ニックネームを実際に設定している人だけ** */
export async function collectGuildNames(guild: Guild, services: Services): Promise<LegacyNameEntry[]> {
  const members = await guild.members.fetch();
  const ranks = rankRoleIds(services);
  return [...members.values()]
    .filter((m) => !m.user.bot && m.nickname)
    .map((m) => ({
      userId: m.id,
      nickname: m.nickname as string,
      // 案内待ちだけが未固定。**入城済みの人の名前はそこで確定している**
      locked: classifyMember(m, services, ranks) !== "waiting",
    }));
}

/** 実行前に何が起きるかを数える。**DBは一切変えない** */
export async function previewLegacyImport(guild: Guild, services: Services): Promise<ImportPreview> {
  const members = await guild.members.fetch();
  const ranks = rankRoleIds(services);
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
  const tally = (list: GuildMember[]): Record<MemberGroup, number> => {
    const counts: Record<MemberGroup, number> = { entered: 0, waiting: 0, other: 0 };
    for (const m of list) counts[classifyMember(m, services, ranks)] += 1;
    return counts;
  };
  return {
    scanned: humans.length,
    withNickname: named.length,
    withoutNickname: humans.length - named.length,
    alreadyImported: named.length - fresh.length,
    newlyImportable: fresh.length,
    byGroup: tally(fresh),
    unsetByGroup: tally(humans.filter((m) => !m.nickname)),
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
        `　└ 入城済み **${preview.byGroup.entered}名**（名前を**確定**します）`,
        `　└ 案内待ち **${preview.byGroup.waiting}名**（説明会まで本人が直せます）`,
        `　└ その他 **${preview.byGroup.other}名**（運営など。入城導線に乗っていないので**確定**します）`,
        `・ニックネーム未設定: **${preview.withoutNickname}名** … 取り込みません（本人が決めた名前ではないため）`,
        `　└ 入城済み ${preview.unsetByGroup.entered}名 ／ 案内待ち ${preview.unsetByGroup.waiting}名 ／ その他 ${preview.unsetByGroup.other}名`,
        preview.unsetByGroup.entered > 0
          ? `　-# 入城済みで未設定の ${preview.unsetByGroup.entered}名は、後から個別に正式な名前を設定する対象として残ります。`
          : "",
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
  const entries = await collectGuildNames(interaction.guild, services);
  const result = services.nicknames.importLegacy(entries, `user:${interaction.user.id}`);
  const conflicts = services.nicknames.listConflicts();
  await interaction.editReply({
    content: [
      `✅ **${result.imported}名** の名前を取り込みました（飛ばした既存 ${result.skipped}名）。`,
      `　うち **${result.locked}名** は入城済み・運営として名前を**確定**しました（本人からは変更できません）。`,
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
