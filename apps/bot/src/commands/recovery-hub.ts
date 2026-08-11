import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type Guild,
  type GuildMember,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from "discord.js";
import {
  RANK_ROLE_SETTING_KEYS,
  canBackfillHistoricalMajin,
  canCatchUpPromotion,
  roleToRestoreForStatus,
  type LadderRank,
} from "@meigokujo/core";
import { redeliverPurchase } from "../shop-delivery.js";
import { REEVAL_ITEM_SETTING_KEY } from "./reeval.js";
import type { Services } from "./../services.js";

/**
 * 既存データの回収（運営用）。
 *
 * 2026-08-11 の監査で見つかった既存不整合を、**通常導線の副作用を出さずに**直すための場所。
 * 通常導線（`/審判`・`/昇格`）を今さら流すと、評価期間の新規設定・初期発行・公開の昇格告知が
 * 発生してしまう。ここはそれらを起こさず、台帳とロールの食い違いだけを埋める。
 *
 * **汎用の「任意 status を書く口」にしない。** 操作ごとに遷移を1本へ固定し、
 * 履歴追認は ID 許可リストで対象を縛る。
 */

/**
 * 履歴追認の対象（2026-08-11 監査 A群の魔人4名）。
 *
 * 4名とも「Discordに魔人ロールがあり、2026-08分の給与も支給されているが、
 * 台帳は waiting のまま・入城処理の痕跡（ghost_at・初期発行・評価）が一切無い」。
 * 今から `/審判` を流すと評価期間と初期発行が新規に生えて実態と合わなくなるため、
 * **この4名に限って** waiting→majin を追認する。
 *
 * @korohosi(965817827959377970) は魔族ロールで論点が別なので**含めない**（人間判断待ち）。
 */
export const HISTORICAL_MAJIN_ALLOWLIST: readonly string[] = [
  "703048809030090843", // @babu3221
  "788782267035549716", // @1amk4ji.com
  "793679594288054343", // @sabusuteitsuku1908
  "1531375937533251751", // @3uqlx._70931
];

export function recoveryHome() {
  const embed = new EmbedBuilder()
    .setTitle("🧰 既存データの回収")
    .setColor(0x0f766e)
    .setDescription(
      [
        "監査で見つかった食い違いを、通常導線の副作用を出さずに直します。",
        "",
        "**未配送の再配送** … 課金は済んだのに配送が終わっていない購入を、記録された配送内容だけ再実行します。",
        "**階級ロールの復元** … 台帳の階級に対してロールが欠けている人へ、その階級のロールを足します。",
        "**昇格記録の追いつき** … ロール上は魔人だが台帳が亡霊のままの人の記録を合わせます（告知はしません）。",
        "**履歴追認** … 監査で特定した4名限定の waiting→魔人 追認です。",
        "**旧自動解除の巻き戻し** … 撤回した自動配送で迷霊が外れた2名を、面談を受けられる状態へ戻します。",
        "",
        "-# どれも実行前に条件を再確認し、条件を満たさなければ何もせず理由を出します。",
      ].join("\n"),
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:recover:shop").setLabel("未配送の再配送").setEmoji("📦").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("mgmt:recover:role").setLabel("階級ロールの復元").setEmoji("🎖").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:recover:promo").setLabel("昇格記録の追いつき").setEmoji("⚔️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:recover:backfill").setLabel("履歴追認（4名限定）").setEmoji("📜").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:recover:legacy").setLabel("旧自動解除の巻き戻し").setEmoji("↩️").setStyle(ButtonStyle.Secondary),
  );
  const back = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:hub").setLabel("← ハブへ").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row, back] };
}

const backRow = () =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:recover").setLabel("← 回収へ").setStyle(ButtonStyle.Secondary),
  );

// ---- 未配送の再配送 ----

export function undeliveredPicker(services: Services) {
  const rows = services.shop.listUndeliveredAuto(25);
  const embed = new EmbedBuilder()
    .setTitle("📦 未配送の再配送")
    .setColor(0x0f766e)
    .setDescription(
      rows.length === 0
        ? "未配送の自動配送はありません。"
        : [
            `配送が完了していない購入が **${rows.length}件** あります。`,
            "選ぶと、その購入に記録された配送内容だけをもう一度実行します（追加の課金はありません）。",
          ].join("\n"),
    );
  if (rows.length > 0) {
    embed.addFields(
      rows.slice(0, 10).map((p) => ({
        name: `#${p.id} ${p.item_name}`,
        value: `<@${p.user_id}> / 状態=${p.delivery_state ?? "pending"} / 試行${p.delivery_attempts}回${p.delivery_error ? `\n直近の失敗: \`${p.delivery_error.slice(0, 80)}\`` : ""}`,
      })),
    );
  }
  const components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];
  if (rows.length > 0) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("mgmt:recover:redeliver")
          .setPlaceholder("再配送する購入を選ぶ")
          .addOptions(
            rows.slice(0, 25).map((p) => ({
              label: `#${p.id} ${p.item_name}`.slice(0, 100),
              value: String(p.id),
              description: `${p.user_id} / ${p.delivery_state ?? "pending"} / 試行${p.delivery_attempts}`.slice(0, 100),
            })),
          ),
      ),
    );
  }
  components.push(backRow());
  return { embeds: [embed], components };
}

export async function handleRedeliver(interaction: StringSelectMenuInteraction, services: Services): Promise<void> {
  const purchaseId = Number(interaction.values[0]);
  const actor = `user:${interaction.user.id}`;
  const outcome = await redeliverPurchase(services, interaction.guild, purchaseId, actor);
  const head =
    outcome.state === "delivered"
      ? `✅ 購入 #${purchaseId} の配送が完了しました。`
      : outcome.state === "already_delivered"
        ? `ℹ️ 購入 #${purchaseId} は既に配送済みです。何もしていません。`
        : `⚠️ 購入 #${purchaseId} の再配送に失敗しました（\`${outcome.error ?? "unknown"}\`）。状態は failed のまま残るので、原因を直してからもう一度実行できます。`;
  await interaction.update({ content: `${head}\n${outcome.message}`, embeds: [], components: [backRow()] });
}

// ---- 階級ロールの復元（DBが正・ロールが欠落）----

export function roleRestorePicker() {
  const embed = new EmbedBuilder()
    .setTitle("🎖 階級ロールの復元")
    .setColor(0x0f766e)
    .setDescription(
      [
        "台帳の階級に対してロールが無い人へ、**その階級のロールだけ**を足します。",
        "",
        "-# 台帳を書き換えることはありません。余分なロールを外すこともしません（人が見て判断してください）。",
        "-# 入城前・離脱済み・迷霊は対象外です。",
      ].join("\n"),
    );
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        new UserSelectMenuBuilder().setCustomId("mgmt:recover:role-target").setPlaceholder("ロールを復元する対象を選ぶ"),
      ),
      backRow(),
    ],
  };
}

export async function handleRoleRestore(interaction: UserSelectMenuInteraction, services: Services): Promise<void> {
  const targetId = interaction.values[0]!;
  const actor = `user:${interaction.user.id}`;
  const guild = interaction.guild;
  const done = (msg: string) => interaction.update({ content: msg, embeds: [], components: [backRow()] });
  if (!guild) return void (await done("サーバー内で実行してください。"));

  const soul = services.entry.getSoul(targetId);
  const rank = roleToRestoreForStatus(soul?.status ?? null);
  if (!rank) {
    return void (await done(`⚠️ <@${targetId}> は復元対象外です（台帳の階級: ${soul?.status ?? "記録なし"}）。何もしていません。`));
  }
  const roleId = services.settings.getString(RANK_ROLE_SETTING_KEYS[rank as LadderRank]);
  if (!roleId) return void (await done(`⚠️ ${rank} のロールが未設定です。先に /管理 → 設定 で登録してください。`));

  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) return void (await done("⚠️ メンバー情報を取得できませんでした。何もしていません。"));
  if (member.roles.cache.has(roleId)) {
    return void (await done(`ℹ️ <@${targetId}> は既に <@&${roleId}> を持っています。何もしていません。`));
  }
  const added = await member.roles.add(roleId).then(() => true).catch((e: Error) => e.message);
  if (added !== true) {
    services.events.log("rank_role_restore_failed", { actor, target: targetId, payload: { rank, roleId, error: added } });
    return void (await done(`⚠️ ロールの付与に失敗しました（\`${added}\`）。台帳は変更していません。`));
  }
  services.events.log("rank_role_restored", { actor, target: targetId, payload: { rank, roleId, from: "db_status" } });
  await done(`✅ <@${targetId}> へ <@&${roleId}> を付けました（台帳の **${rank}** に合わせた復元）。台帳は変更していません。`);
}

// ---- 昇格記録の追いつき ----

export function promotionCatchUpPicker() {
  const embed = new EmbedBuilder()
    .setTitle("⚔️ 昇格記録の追いつき")
    .setColor(0x0f766e)
    .setDescription(
      [
        "面談・ロール付与まで終わっているのに、台帳が亡霊のままの人の**記録だけ**を合わせます。",
        "",
        "実行条件（3つとも必須）:",
        "・台帳が **亡霊**",
        "・Discord に **魔人ロール** がある",
        "・有効な昇格印が**本人のスナップショット要求数**に達している",
        "",
        "-# ロールの再付与も、公開の昇格告知もしません（どちらも済んでいる前提の操作です）。",
      ].join("\n"),
    );
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        new UserSelectMenuBuilder().setCustomId("mgmt:recover:promo-target").setPlaceholder("追いつかせる対象を選ぶ"),
      ),
      backRow(),
    ],
  };
}

export async function handlePromotionCatchUp(interaction: UserSelectMenuInteraction, services: Services): Promise<void> {
  const targetId = interaction.values[0]!;
  const actor = `user:${interaction.user.id}`;
  const guild = interaction.guild;
  const done = (msg: string) => interaction.update({ content: msg, embeds: [], components: [backRow()] });
  if (!guild) return void (await done("サーバー内で実行してください。"));

  const verdict = await evaluateCatchUp(services, guild, targetId);
  if (!verdict.ok) return void (await done(`⚠️ <@${targetId}> は条件を満たしません（\`${verdict.reason}\`）。何もしていません。`));

  const applied = services.evaluation.catchUpPromotion(targetId, actor, verdict.evidence);
  await done(
    applied
      ? `✅ <@${targetId}> の昇格記録を追いつかせました（亡霊 → 魔人・評価期限をクリア）。**告知はしていません**。\n根拠: 昇格印 ${verdict.evidence.promotionScore}/${verdict.evidence.promotionRequired}・魔人ロール保有`
      : `⚠️ 直前に台帳が変わったため中止しました（亡霊ではなくなっています）。何もしていません。`,
  );
}

async function evaluateCatchUp(
  services: Services,
  guild: Guild,
  targetId: string,
): Promise<{ ok: true; evidence: Record<string, any> } | { ok: false; reason: string }> {
  const soul = services.entry.getSoul(targetId);
  const majinRoleId = services.settings.getString(RANK_ROLE_SETTING_KEYS.majin);
  if (!majinRoleId) return { ok: false, reason: "majin_role_setting_missing" };
  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) return { ok: false, reason: "member_fetch_failed" };
  const score = services.evaluation.promotionScore(targetId);
  const required = services.evaluation.thresholdsFor(targetId).promotionRequired;
  const verdict = canCatchUpPromotion({
    currentStatus: soul?.status ?? null,
    hasMajinRole: member.roles.cache.has(majinRoleId),
    promotionScore: score.total,
    promotionRequired: required,
  });
  if (!verdict.ok) return verdict;
  return {
    ok: true,
    evidence: {
      promotionScore: score.total,
      promotionRequired: required,
      evalMarks: score.evalMarks,
      inviteScore: score.inviteScore,
      majinRoleId,
      basis: "role_and_marks_present_but_promotion_event_missing",
    },
  };
}

// ---- 履歴追認（許可リスト固定）----

export function backfillConfirm(services: Services) {
  const lines = HISTORICAL_MAJIN_ALLOWLIST.map((id) => {
    const soul = services.entry.getSoul(id);
    return `・<@${id}> — 台帳: ${soul?.status ?? "記録なし"}`;
  });
  const embed = new EmbedBuilder()
    .setTitle("📜 履歴追認（waiting → 魔人・4名限定）")
    .setColor(0xb45309)
    .setDescription(
      [
        "監査で特定した**この4名だけ**の台帳を、実態（魔人ロール保有・給与支給済み）へ合わせます。",
        "",
        ...lines,
        "",
        "行うこと: `status` を waiting から魔人へ書き換え、`rank_history_backfill` を事件録へ残すだけ。",
        "**行わないこと**: 初期発行・評価期間の設定・ロール変更・告知。",
        "",
        "-# 実行時に「許可リストに含まれる」「台帳が waiting」「魔人ロールを持っている」を再確認します。",
      ].join("\n"),
    );
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("mgmt:recover:backfill-run").setLabel("4名を追認する").setStyle(ButtonStyle.Danger),
      ),
      backRow(),
    ],
  };
}

export async function handleBackfillRun(interaction: ButtonInteraction, services: Services): Promise<void> {
  const actor = `user:${interaction.user.id}`;
  const guild = interaction.guild;
  if (!guild) {
    return void (await interaction.update({ content: "サーバー内で実行してください。", embeds: [], components: [backRow()] }));
  }
  const majinRoleId = services.settings.getString(RANK_ROLE_SETTING_KEYS.majin);
  if (!majinRoleId) {
    return void (await interaction.update({
      content: "⚠️ 魔人ロールが未設定です。何もしていません。",
      embeds: [],
      components: [backRow()],
    }));
  }

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const userId of HISTORICAL_MAJIN_ALLOWLIST) {
    const member = await guild.members.fetch(userId).catch(() => null);
    const soul = services.entry.getSoul(userId);
    const verdict = canBackfillHistoricalMajin({
      allowlist: HISTORICAL_MAJIN_ALLOWLIST,
      userId,
      currentStatus: soul?.status ?? null,
      hasMajinRole: !!member && member.roles.cache.has(majinRoleId),
    });
    if (!verdict.ok) {
      skipped.push(`<@${userId}>（${verdict.reason}）`);
      continue;
    }
    const ok = services.evaluation.backfillHistoricalRank(userId, "majin", actor, {
      basis: "majin_role_and_salary_paid_without_entry_record",
      majinRoleId,
      auditedAt: "2026-08-11",
      note: "監査A群。ghost_at・初期発行・評価履歴なしのまま運用上は魔人として扱われていた",
    });
    (ok ? applied : skipped).push(`<@${userId}>${ok ? "" : "（precondition_lost）"}`);
  }

  await interaction.update({
    content: [
      applied.length > 0 ? `✅ 追認しました（${applied.length}名）: ${applied.join(", ")}` : "追認した人はいません。",
      skipped.length > 0 ? `⏭ 見送り（${skipped.length}名）: ${skipped.join(", ")}` : "",
      "-# 初期発行・評価期間・告知は発生していません。",
    ]
      .filter(Boolean)
      .join("\n"),
    embeds: [],
    components: [backRow()],
    allowedMentions: { parse: [] },
  });
}

// ---- 旧ショップ自動解除の巻き戻し（2名限定）----

/**
 * 撤回した `revoke_meirei` 自動配送が、面談を経ずに迷霊を解除してしまった2名。
 *
 * どちらも `ghost_reset`(actor=`shop:5`) が事件録に残っており、DBだけ案内待ちへ
 * 落ちた状態で止まっている。面談を受けられる状態（迷霊）へ戻すためだけの一回限りの操作。
 *
 * `@amaguri3807` は**入れない**。あの人は購入時にDBが迷霊でなく配送が拒否されたので、
 * 「旧自動解除で迷霊が外れた」証拠が無く、別判断になる。
 */
export const REEVAL_LEGACY_ROLLBACK: ReadonlyArray<{ userId: string; purchaseId: number }> = [
  { userId: "1004526260522856638", purchaseId: 63 }, // @zhese
  { userId: "1081838999980757064", purchaseId: 64 }, // @el_cy1
];

export function legacyRollbackConfirm(services: Services) {
  const lines = REEVAL_LEGACY_ROLLBACK.map(({ userId, purchaseId }) => {
    const soul = services.entry.getSoul(userId);
    return `・<@${userId}> — 台帳: ${soul?.status ?? "記録なし"} / 面談権: 購入 #${purchaseId}`;
  });
  const embed = new EmbedBuilder()
    .setTitle("↩️ 旧ショップ自動解除の巻き戻し（2名限定）")
    .setColor(0xb45309)
    .setDescription(
      [
        "撤回した自動配送が、面談を経ずに迷霊を解除してしまった2名を**迷霊へ戻します**。",
        "",
        ...lines,
        "",
        "行うこと: `status` を案内待ちから迷霊へ戻し、案内待ちロールが残っていれば外すだけ。",
        "**行わないこと**: 亡霊化時刻・以前の評価期限・policy snapshot・印・Land・招待実績の復元。",
        "",
        "-# 戻した後、本人は追加料金なしで購入 #63/#64 を使って再評価面談チケットを開けます。",
        "-# 実行時に許可リスト・台帳・購入・旧解除の記録・在籍・迷霊ロールを再確認します。",
      ].join("\n"),
    );
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("mgmt:recover:legacy-run").setLabel("2名を迷霊へ戻す").setStyle(ButtonStyle.Danger),
      ),
      backRow(),
    ],
  };
}

/** 実行前の前提確認。1つでも崩れていれば理由を返して何もしない */
export async function legacyRollbackVerdict(
  services: Services,
  guild: Guild,
  entry: { userId: string; purchaseId: number },
): Promise<{ ok: true; member: GuildMember; meireiRoleId: string } | { ok: false; reason: string }> {
  const inAllowlist = REEVAL_LEGACY_ROLLBACK.some((e) => e.userId === entry.userId && e.purchaseId === entry.purchaseId);
  if (!inAllowlist) return { ok: false, reason: "not_in_allowlist" };

  const soul = services.entry.getSoul(entry.userId);
  if (!soul) return { ok: false, reason: "no_soul_row" };
  if (soul.status !== "waiting") return { ok: false, reason: `unexpected_status:${soul.status}` };

  const itemId = Number(services.settings.getString(REEVAL_ITEM_SETTING_KEY));
  if (!Number.isInteger(itemId) || itemId <= 0) return { ok: false, reason: "reeval_item_setting_missing" };
  const purchase = services.shop.getPurchase(entry.purchaseId);
  if (!purchase) return { ok: false, reason: "purchase_not_found" };
  if (purchase.user_id !== entry.userId) return { ok: false, reason: "purchase_user_mismatch" };
  if (purchase.item_id !== itemId) return { ok: false, reason: "purchase_item_mismatch" };

  // 旧自動解除の痕跡。これが無いなら「機械が外した」根拠が無い
  const events = services.events.listByTarget(entry.userId, 200);
  // 「その商品の自動配送が外した」ことまで確かめる（単なる shop: 前方一致にしない）
  if (!events.some((e) => e.type === "ghost_reset" && (e.actor_id ?? "") === `shop:${itemId}`)) {
    return { ok: false, reason: "no_legacy_ghost_reset" };
  }
  // 面談の結果が既に出ているなら巻き戻さない
  if (events.some((e) => e.type === "reeval_reinstated" || e.type === "reeval_rejected")) {
    return { ok: false, reason: "already_interviewed" };
  }

  const member = await guild.members.fetch(entry.userId).catch(() => null);
  if (!member) return { ok: false, reason: "member_not_found" };
  const meireiRoleId = services.settings.getString("role:meirei");
  if (!meireiRoleId) return { ok: false, reason: "meirei_role_setting_missing" };
  // 迷霊ロールが残っていることが「Discord上は迷霊のまま」の根拠
  if (!member.roles.cache.has(meireiRoleId)) return { ok: false, reason: "meirei_role_missing" };

  return { ok: true, member, meireiRoleId };
}

export async function handleLegacyRollbackRun(interaction: ButtonInteraction, services: Services): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    return void (await interaction.update({ content: "サーバー内で実行してください。", embeds: [], components: [backRow()] }));
  }
  const actor = `user:${interaction.user.id}`;
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const entry of REEVAL_LEGACY_ROLLBACK) {
    const verdict = await legacyRollbackVerdict(services, guild, entry);
    if (!verdict.ok) {
      skipped.push(`<@${entry.userId}>（${verdict.reason}）`);
      continue;
    }
    const ok = services.evaluation.legacyRollbackToMeirei(entry.userId, actor, {
      purchaseId: entry.purchaseId,
      basis: "shop_auto_revoke_meirei_withdrawn",
      note: "撤回した自動配送が面談を経ずに迷霊を解除したため、面談を受けられる状態へ戻す",
      auditedAt: "2026-08-11",
    });
    if (!ok) {
      skipped.push(`<@${entry.userId}>（precondition_lost）`);
      continue;
    }
    // 案内待ちロールが残っていれば外す（迷霊ロールは既にあるので触らない）
    const waitRoleId = services.settings.getString("role:queue_wait");
    if (waitRoleId && verdict.member.roles.cache.has(waitRoleId)) {
      const removed = await verdict.member.roles.remove(waitRoleId).then(() => true).catch((e: Error) => e.message);
      if (removed !== true) {
        services.events.log("reeval_legacy_rollback_role_failed", {
          actor,
          target: entry.userId,
          payload: { roleId: waitRoleId, error: removed },
        });
      }
    }
    applied.push(`<@${entry.userId}>（購入 #${entry.purchaseId}）`);
  }

  await interaction.update({
    content: [
      applied.length > 0 ? `✅ 迷霊へ戻しました（${applied.length}名）: ${applied.join(", ")}` : "戻した人はいません。",
      skipped.length > 0 ? `⏭ 見送り（${skipped.length}名）: ${skipped.join(", ")}` : "",
      "-# 評価期間・印・Land・招待実績は復元していません。面談OK時に新しい評価サイクルが正規に始まります。",
    ]
      .filter(Boolean)
      .join("\n"),
    embeds: [],
    components: [backRow()],
    allowedMentions: { parse: [] },
  });
}
