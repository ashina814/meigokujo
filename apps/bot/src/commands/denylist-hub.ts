import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { nicknameKey } from "@meigokujo/core";
import type { Services } from "../services.js";

/**
 * 名前の禁止語を運営が管理する。
 *
 * **語彙はコードに焼き込まない。** 何を下ネタとするかは運営の判断で動くもので、
 * 語を足すたびに deploy するのは現実的でない。判定は正規化済みの名前に対する
 * **部分一致だけ**（正規表現は持たない）。
 *
 * - `reject` … その場で拒否。本人に別の名前を入れてもらう
 * - `flag`  … 登録は通すが**一括合格に含めない**。門番が見て通す
 */

const MAX_LISTED = 25;

/** その語に触れている登録済みの名前を数える（ONにする前の影響確認用） */
function affectedCount(services: Services, pattern: string): number {
  const rows = services.db.prepare("SELECT name_key FROM member_names").all() as Array<{ name_key: string }>;
  return rows.filter((r) => r.name_key.includes(pattern)).length;
}

export function denylistHome(services: Services) {
  const words = services.nicknames.listDenyWords();
  const reject = words.filter((w) => w.action === "reject");
  const flag = words.filter((w) => w.action === "flag");
  const line = (w: { pattern: string; note: string | null }) => {
    const n = affectedCount(services, w.pattern);
    return `・\`${w.pattern}\`${w.note ? `（${w.note}）` : ""}${n > 0 ? ` — **登録済みの名前 ${n}件に一致**` : ""}`;
  };
  const embed = new EmbedBuilder()
    .setTitle("🚫 名前の禁止語")
    .setColor(0x991b1b)
    .setDescription(
      [
        "名前に含められない語を管理します。判定は**部分一致**だけです（正規表現はありません）。",
        "登録した語は**正規化して**保存します（全角半角・大文字小文字の違いは吸収されます）。",
        "",
        `**拒否 ${reject.length}件** … その場で断ります。本人に別の名前を入れてもらいます。`,
        reject.length > 0 ? reject.slice(0, MAX_LISTED).map(line).join("\n") : "　（なし）",
        "",
        `**要確認 ${flag.length}件** … 登録は通しますが、**一括合格には入れません**。門番が中身を見て通します。`,
        flag.length > 0 ? flag.slice(0, MAX_LISTED).map(line).join("\n") : "　（なし）",
        "",
        "-# 語を足すと、**その語に一致する登録済みの名前も**入城の判定でひっかかるようになります（遡って改名はさせません）。",
        "-# 要確認の語を増やすと、既に門番が通した名前でも**もう一度確認**が要ります（見ていない語で通さないため）。",
      ].join("\n"),
    );
  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("mgmt:denyword:add-reject").setLabel("拒否する語を追加").setEmoji("⛔").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("mgmt:denyword:add-flag").setLabel("要確認の語を追加").setEmoji("🔍").setStyle(ButtonStyle.Secondary),
    ),
  ];
  if (words.length > 0) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("mgmt:denyword:remove")
          .setPlaceholder("🗑 削除する語を選ぶ")
          .addOptions(
            words.slice(0, MAX_LISTED).map((w) => ({
              label: w.pattern.slice(0, 100),
              description: w.action === "reject" ? "拒否" : "要確認",
              value: w.pattern.slice(0, 100),
            })),
          ),
      ),
    );
  }
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("mgmt:hub").setLabel("← ハブへ").setStyle(ButtonStyle.Secondary),
    ),
  );
  return { embeds: [embed], components: rows };
}

export function denywordModal(action: "reject" | "flag") {
  return new ModalBuilder()
    .setCustomId(`mgmt:denyword:save:${action}`)
    .setTitle(action === "reject" ? "拒否する語を追加" : "要確認の語を追加")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("pattern")
          .setLabel("語（名前に含まれていたら反応します）")
          .setPlaceholder("部分一致です。短すぎる語は関係ない名前まで巻き込みます")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(64),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("note")
          .setLabel("メモ（任意・運営用）")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(100),
      ),
    );
}

/**
 * 確認待ちの追加。**既存の名前に当たる語は、見せてから保存する。**
 *
 * 保存してから件数を出すと、短い語で大勢を巻き込んだあとに気づくことになる。
 * プロセス内に置くだけなので、再起動で消えても入れ直せばよい。
 *
 * **確認1件ごとに鍵を持つ。** 押した人だけで持つと、同じ人が確認を2つ開いたとき、
 * 古い画面のボタンが新しいほうを確定・取り消してしまう。画面と中身は1対1で結ぶ。
 */
interface PendingAdd {
  userId: string;
  pattern: string;
  action: "reject" | "flag";
  note?: string;
  affected: number;
  createdAt: number;
}
const pendingAdd = new Map<string, PendingAdd>();
const PENDING_TTL_MS = 15 * 60_000;

/** 押されないまま残った確認を捨てる（放っておくと溜まり続ける） */
function prunePending(): void {
  const limit = Date.now() - PENDING_TTL_MS;
  for (const [token, p] of pendingAdd) if (p.createdAt < limit) pendingAdd.delete(token);
}

/** 自分の確認だけを取り出す。他人の確認は触らせない */
function takePending(token: string | undefined, userId: string): PendingAdd | null {
  if (!token) return null;
  const pending = pendingAdd.get(token);
  if (!pending || pending.userId !== userId) return null;
  return pending;
}

function confirmMessage(token: string, pending: PendingAdd, opts: { changedFrom?: number } = {}) {
  const { pattern, action, affected } = pending;
  return {
    content: [
      opts.changedFrom !== undefined
        ? `⚠️ 確認している間に、一致する名前の数が **${opts.changedFrom}件 → ${affected}件** に変わりました。**まだ登録していません。**`
        : `⚠️ \`${pattern}\` は **登録済みの名前 ${affected}件に一致します。**`,
      opts.changedFrom === undefined ? "" : `対象の語: \`${pattern}\``,
      action === "reject"
        ? "登録すると、その方々の名前は入城の判定で**違反**として扱われます（遡って改名はさせません）。"
        : "登録すると、その方々は**門番の確認待ち**になります。既に門番が通した名前も、この語を見ていなければもう一度確認が要ります。",
      "",
      "**まだ登録していません。** よければ下のボタンで確定してください。",
    ]
      .filter(Boolean)
      .join("\n"),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`mgmt:denyword:confirm:${token}`)
          .setLabel(affected > 0 ? `${affected}件に一致するが登録する` : "登録する")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`mgmt:denyword:cancel:${token}`).setLabel("やめる").setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function savedMessage(pattern: string, action: "reject" | "flag", raw: string, affected: number): string {
  return [
    `✅ ${action === "reject" ? "**拒否**" : "**要確認**"}の語として \`${pattern}\` を登録しました。`,
    raw.trim() !== pattern ? `-# 入力 \`${raw.trim()}\` を正規化して保存しています。` : "",
    affected > 0
      ? `⚠️ **登録済みの名前 ${affected}件がこの語に一致します。**${action === "reject" ? "入城の判定で違反として扱われます（遡って改名はさせません）。" : "門番の確認待ちになります。"}`
      : "登録済みの名前で一致するものはありません。",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function handleDenywordModal(interaction: ModalSubmitInteraction, services: Services): Promise<void> {
  const action = interaction.customId.split(":")[3] === "flag" ? "flag" : "reject";
  const raw = interaction.fields.getTextInputValue("pattern");
  const note = interaction.fields.getTextInputValue("note")?.trim() || undefined;
  const pattern = nicknameKey(raw);
  if (!pattern) {
    await interaction.reply({ content: "⚠️ 語が空です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const affected = affectedCount(services, pattern);
  if (affected === 0) {
    // 誰にも当たらないなら、そのまま入れてよい
    services.nicknames.addDenyWord(pattern, `user:${interaction.user.id}`, { action, note });
    await interaction.reply({ content: savedMessage(pattern, action, raw, 0), flags: MessageFlags.Ephemeral });
    return;
  }
  // **まだ保存しない。** 何件に当たるかを見てから決めてもらう。
  // 確認画面ごとに鍵を振り、そのボタンはその語だけを動かす
  prunePending();
  const token = interaction.id;
  const pending: PendingAdd = { userId: interaction.user.id, pattern, action, note, affected, createdAt: Date.now() };
  pendingAdd.set(token, pending);
  const message = confirmMessage(token, pending);
  await interaction.reply({
    content: raw.trim() !== pattern ? `${message.content}\n-# 入力 \`${raw.trim()}\` を正規化した結果です。` : message.content,
    components: message.components,
    flags: MessageFlags.Ephemeral,
  });
}

async function confirmAdd(interaction: ButtonInteraction, services: Services, token: string | undefined): Promise<void> {
  const pending = takePending(token, interaction.user.id);
  if (!pending || !token) {
    await interaction.update({ content: "⌛ この確認は期限切れです。もう一度追加からやり直してください。", components: [] });
    return;
  }
  // **確定の直前にもう一度数える。** 見せてから押すまでの間に名前が増減していると、
  // 運営が見た数と実際に巻き込む数が食い違う
  const current = affectedCount(services, pending.pattern);
  if (current !== pending.affected) {
    const shown = pending.affected;
    pending.affected = current;
    pendingAdd.set(token, pending);
    await interaction.update(confirmMessage(token, pending, { changedFrom: shown }));
    return;
  }
  pendingAdd.delete(token);
  services.nicknames.addDenyWord(pending.pattern, `user:${interaction.user.id}`, {
    action: pending.action,
    note: pending.note,
  });
  await interaction.update({
    content: savedMessage(pending.pattern, pending.action, pending.pattern, pending.affected),
    components: [],
  });
}

export async function handleDenywordRemove(interaction: StringSelectMenuInteraction, services: Services): Promise<void> {
  const pattern = interaction.values[0]!;
  const removed = services.nicknames.removeDenyWord(pattern, `user:${interaction.user.id}`);
  await interaction.update(denylistHome(services));
  await interaction
    .followUp({
      content: removed ? `🗑 \`${pattern}\` を削除しました。` : `⚠️ \`${pattern}\` は見つかりませんでした。`,
      flags: MessageFlags.Ephemeral,
    })
    .catch(() => undefined);
}

export async function handleDenywordButton(interaction: ButtonInteraction, services: Services): Promise<boolean> {
  const action = interaction.customId.split(":")[2];
  if (action === undefined) return false;
  if (action === "add-reject") return void (await interaction.showModal(denywordModal("reject"))), true;
  if (action === "add-flag") return void (await interaction.showModal(denywordModal("flag"))), true;
  const token = interaction.customId.split(":")[3];
  if (action === "confirm") return void (await confirmAdd(interaction, services, token)), true;
  if (action === "cancel") {
    // **その画面の分だけ消す。** 別に開いている確認は残す
    const pending = takePending(token, interaction.user.id);
    if (pending && token) pendingAdd.delete(token);
    await interaction.update({
      content: pending ? `登録をやめました（\`${pending.pattern}\`）。` : "この確認は期限切れです。",
      components: [],
    });
    return true;
  }
  await interaction.update(denylistHome(services));
  return true;
}
