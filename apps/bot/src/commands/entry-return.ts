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
  type Guild,
  type GuildMember,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import {
  MEIREI_ROLE_SETTING_KEY,
  RANK_LADDER,
  RANK_ROLE_SETTING_KEYS,
  RETURN_TARGETS,
  RETURN_TARGET_LABELS,
  type LadderRank,
  type ReturnTarget,
} from "@meigokujo/core";
import { isAdmin } from "../permissions.js";
import type { Services } from "../services.js";

/**
 * 出戻り（退出 → 再参加 → 申請 → 運営判断 → 反映）。
 *
 * ## 自動復帰させない
 *
 * 再参加した時点では必ず案内待ちへ入れる。以前の階級は `rank_at_leave` へ退避してあり、
 * **運営に見せる参考情報**として使う。戻し先は運営が選ぶ。
 *
 * ## 任意 status を書く口にしない
 *
 * 選べるのは決められた戻し先だけで、各戻し先の副作用（評価サイクルの新規開始・
 * ロールの入れ替え）は Bot が担当する。DB エディタにはしない。
 */

/** 出戻り申請の受付ID。意味論として固定する */
export const RETURN_PANEL_ID = "return";

export function returnActionRow(disabled = false) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("ret:target")
      .setPlaceholder("今回の戻し先を決める")
      .setDisabled(disabled)
      .addOptions(RETURN_TARGETS.map((t) => ({ label: RETURN_TARGET_LABELS[t].slice(0, 100), value: t }))),
  );
}

/** 運営が見る判断材料。詰め込みすぎず「何に戻すか」に効く情報だけ */
export function returnContextEmbed(services: Services, userId: string, member: GuildMember | null): EmbedBuilder {
  const ctx = services.returns.context(userId);
  const rankRoles = [...RANK_LADDER.map((r) => [r, services.settings.getString(RANK_ROLE_SETTING_KEYS[r])] as const), ["meirei", services.settings.getString(MEIREI_ROLE_SETTING_KEY)] as const]
    .filter(([, id]) => !!id && !!member && member.roles.cache.has(id!))
    .map(([r]) => r);
  const jst = (ts: number | null) => (ts === null ? "—" : `<t:${ts}:D>`);

  const embed = new EmbedBuilder()
    .setTitle("🔄 出戻り申請")
    .setColor(0x0369a1)
    .setDescription(`対象: <@${userId}>`)
    .addFields(
      { name: "過去の在籍", value: ctx.hasSoul ? (ctx.hasHistory ? "あり（退出の記録あり）" : "あり（退出の記録なし）") : "**記録なし**", inline: true },
      { name: "最終退出", value: jst(ctx.leftAt), inline: true },
      { name: "最終階級", value: ctx.rankAtLeave ?? "—", inline: true },
      { name: "現在の台帳", value: ctx.currentStatus ?? "**行なし**", inline: true },
      { name: "現在の階級ロール", value: rankRoles.join("+") || "なし", inline: true },
      { name: "Land残高", value: ctx.land.toLocaleString("ja-JP"), inline: true },
      {
        name: "過去の評価",
        value: `評価 ${ctx.pastEvaluations}件 / 昇格印 ${ctx.pastPromotionMarks} / 降格印 ${ctx.pastDemotionMarks} / 招待 ${ctx.inviteCount}人`,
        inline: false,
      },
    );
  if (ctx.everMeirei) {
    embed.addFields({ name: "⚠️ 元迷霊", value: "**以前は迷霊でした。** 戻し先は運営が判断してください（自動では決めません）。", inline: false });
  }
  embed.setFooter({
    text: "亡霊で戻すと評価は最初からやり直しになり、昇格に必要なアリが通常より1個多くなります。初期Landは再発行しません。",
  });
  return embed;
}

/** 対応者資格。パネルの対応ロール（または管理者）を正とし、ロールを焼き付けない */
function isReturnStaff(interaction: StringSelectMenuInteraction | ModalSubmitInteraction, services: Services): boolean {
  const panel = services.tickets.getPanel(RETURN_PANEL_ID);
  if (!panel) return false;
  const member = interaction.member as GuildMember | null;
  if (!!member && panel.staffRoleIds.some((id) => member.roles.cache.has(id))) return true;
  return isAdmin(interaction, services);
}

/** 戻し先を選んだら、理由を書いてもらってから確定する */
export async function handleReturnTargetSelect(interaction: StringSelectMenuInteraction, services: Services): Promise<void> {
  if (!isReturnStaff(interaction, services)) {
    return void (await interaction.reply({ content: "この操作には出戻り申請の対応ロールが必要です。", flags: MessageFlags.Ephemeral }));
  }
  const target = interaction.values[0] as ReturnTarget;
  const modal = new ModalBuilder().setCustomId(`ret:reason:${target}`).setTitle(RETURN_TARGET_LABELS[target].slice(0, 45));
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("reason")
        .setLabel("この判断の理由（監査に残ります）")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(500),
    ),
  );
  await interaction.showModal(modal);
}

type Preflight =
  | { ok: true; member: GuildMember; targetId: string; previousStatus: string }
  | { ok: false; message: string };

/** 確定前の下見。ここで弾けるものは弾き、最終判断はトランザクション内で取り直す */
async function preflight(interaction: ModalSubmitInteraction, services: Services, guild: Guild, target: ReturnTarget): Promise<Preflight> {
  const panel = services.tickets.getPanel(RETURN_PANEL_ID);
  if (!panel || !panel.enabled || panel.archivedAt) {
    return { ok: false, message: "出戻り申請の受付（`return`）が未作成・無効です。`/管理 → 受付パネル` で用意してください。" };
  }
  const ticket = services.tickets.get(interaction.channelId ?? "");
  if (!ticket || ticket.panel_id !== RETURN_PANEL_ID) return { ok: false, message: "この操作は出戻り申請チケットの中でだけ使えます。" };
  if (ticket.status === "closed") return { ok: false, message: "このチケットは既に完了しています。" };
  if (!isReturnStaff(interaction, services)) return { ok: false, message: "この操作には出戻り申請の対応ロールが必要です。" };

  const targetId = ticket.user_id;
  const member = await guild.members.fetch({ user: targetId, force: true }).catch(() => null);
  if (!member) return { ok: false, message: `<@${targetId}> がサーバーに見つかりません。何も変更していません。` };
  let soul = services.entry.getSoul(targetId);
  if (!soul) {
    // Bot停止中の参加など、入城処理が一度も走らなかった人。案内待ちの行だけを作る。
    // **`recordJoin()` は使わない**（通常の参加イベントと「いま参加した」joined_at を
    // 捏造してしまうため）。Discord が持っている実際の参加時刻を使う
    const joinedAt = member.joinedTimestamp ? Math.floor(member.joinedTimestamp / 1000) : null;
    services.returns.createWaitingSoulForReturn(targetId, joinedAt, "system:return-preflight", {
      reason: "出戻り申請の対応時に台帳の行が無かったため作成",
      ticketThreadId: interaction.channelId,
    });
    soul = services.entry.getSoul(targetId);
    if (!soul) return { ok: false, message: `<@${targetId}> の魂の記録を作成できませんでした。` };
  }
  if (soul.status !== "waiting") {
    return { ok: false, message: `<@${targetId}> は現在 **${soul.status}** です。出戻りの反映は案内待ちからのみ行えます。` };
  }
  // **ロールを確定の前に検証する。** 台帳を書いてから「ロールが無い」と分かると、
  // 台帳だけ進んだ中途半端な状態が残る
  const roleCheck = checkTargetRole(services, guild, target);
  if (!roleCheck.ok) return { ok: false, message: `${roleCheck.message} 台帳・チケットとも変更していません。` };
  return { ok: true, member, targetId, previousStatus: soul.status };
}

/** 戻し先のロールが設定され、実在し、Botが操作できるか */
export function checkTargetRole(services: Services, guild: Guild, target: ReturnTarget): { ok: true } | { ok: false; message: string } {
  if (target === "waiting") return { ok: true }; // ロールを触らない
  const key = target === "meirei" ? MEIREI_ROLE_SETTING_KEY : RANK_ROLE_SETTING_KEYS[target as LadderRank];
  const roleId = services.settings.getString(key);
  if (!roleId) return { ok: false, message: `${RETURN_TARGET_LABELS[target]} のロール設定（\`${key}\`）がありません。` };
  const role = guild.roles.cache.get(roleId);
  if (!role) return { ok: false, message: `設定されたロール（${roleId}）がサーバーに見つかりません。` };
  const me = guild.members.me;
  if (!me) return { ok: false, message: "Bot自身のメンバー情報を取得できませんでした。" };
  if (role.position >= me.roles.highest.position) {
    return { ok: false, message: `Botのロールが <@&${roleId}> より下にあるため操作できません（ロール順を上げてください）。` };
  }
  return { ok: true };
}

export async function handleReturnReasonSubmit(interaction: ModalSubmitInteraction, services: Services): Promise<void> {
  const target = interaction.customId.split(":")[2] as ReturnTarget;
  if (!RETURN_TARGETS.includes(target)) {
    return void (await interaction.reply({ content: "不明な戻し先です。", flags: MessageFlags.Ephemeral }));
  }
  const guild = interaction.guild;
  if (!guild) return void (await interaction.reply({ content: "サーバー内で実行してください。", flags: MessageFlags.Ephemeral }));

  const pre = await preflight(interaction, services, guild, target);
  if (!pre.ok) return void (await interaction.reply({ content: `⚠️ ${pre.message}`, flags: MessageFlags.Ephemeral }));
  await interaction.deferReply();

  const actor = `user:${interaction.user.id}`;
  const reason = interaction.fields.getTextInputValue("reason").trim();
  const contextBefore = services.returns.context(pre.targetId);

  // 台帳の確定。CAS付きなので二重クリック・同時操作では2回目が空振りする
  const settled = settleReturn(services, {
    threadId: interaction.channelId!,
    targetId: pre.targetId,
    target,
    actor,
    reason,
    evidence: {
      ticketThreadId: interaction.channelId,
      approver: interaction.user.id,
      panelId: RETURN_PANEL_ID,
      previousStatus: pre.previousStatus,
      rankAtLeave: contextBefore.rankAtLeave,
      everMeirei: contextBefore.everMeirei,
      reason,
    },
  });
  if (!settled.ok) {
    return void (await interaction.editReply(`⚠️ 直前に状態が変わったため中止しました（\`${settled.reason}\`）。台帳・ロール・チケットのいずれも変更していません。`));
  }

  const roleErrors = target === "waiting" ? [] : await applyReturnRoles(services, guild, pre.member, pre.targetId, target, actor);
  // 最終確認: 目標階級ロールだけが付き、迷霊と競合せず、案内待ちも残っていないか
  if (target !== "waiting" && roleErrors.length === 0) {
    roleErrors.push(...(await postCheckRoles(services, guild, pre.targetId, target, actor)));
  }
  if (roleErrors.length > 0) {
    services.events.log("entry_return_role_repair_failed", { actor, target: pre.targetId, payload: { to: target, errors: roleErrors } });
  }

  const cycle = settled.result?.cycle;
  await interaction.editReply({
    content: [
      target === "waiting"
        ? `🚫 <@${pre.targetId}> は今回復帰させないことにしました（案内待ちのまま）。`
        : `✅ <@${pre.targetId}> を **${RETURN_TARGET_LABELS[target]}** で反映しました。`,
      cycle
        ? `新しい評価期間: <t:${cycle.deadline}:D> まで / 必要アリ **${cycle.promotionRequired}**（出戻りのため通常より多い）/ 招待は ${cycle.inviteThreshold}人から1アリ（過去分は持ち越さず、いまの ${cycle.inviteBaseline}人を起点）${(settled.result?.revokedMarks ?? 0) > 0 ? ` / 以前の印 ${settled.result!.revokedMarks}件を無効化（履歴は保持）` : ""}`
        : "",
      `理由: ${reason}`,
      roleErrors.length > 0
        ? `⚠️ **ロールの入れ替えに失敗しました**（台帳は確定済み）:\n${roleErrors.map((e) => `・${e}`).join("\n")}\n-# 危険な組み合わせを作らないため、外せなかった場合は目標ロールを付けていません。手で直してください。`
        : "",
      "-# 初期Landの再発行・招待実績の再計上は行っていません。",
    ]
      .filter(Boolean)
      .join("\n"),
    allowedMentions: { parse: [] },
  });
}

class SettleAbort extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

type Settled = { ok: true; result: ReturnType<Services["returns"]["reinstate"]> } | { ok: false; reason: string };

/**
 * 台帳の確定とチケットのcloseを1トランザクションで行う。
 *
 * 確定直前にチケットと台帳を取り直すので、二重クリック・複数運営の同時操作・
 * 古いチケットからの操作はすべて2回目以降が空振りになる。
 */
export function settleReturn(
  services: Services,
  input: { threadId: string; targetId: string; target: ReturnTarget; actor: string; reason: string; evidence: Record<string, unknown> },
): Settled {
  const run = services.db.transaction((): Settled => {
    const ticket = services.tickets.get(input.threadId);
    if (!ticket || ticket.panel_id !== RETURN_PANEL_ID) throw new SettleAbort("ticket_missing_or_wrong_panel");
    if (ticket.user_id !== input.targetId) throw new SettleAbort("ticket_user_mismatch");
    if (ticket.status !== "open" && ticket.status !== "claimed") throw new SettleAbort(`ticket_${ticket.status}`);
    const soul = services.entry.getSoul(input.targetId);
    if (!soul) throw new SettleAbort("no_soul_row");
    if (soul.status !== "waiting") throw new SettleAbort(`not_waiting:${soul.status}`);

    const result = services.returns.reinstate(input.targetId, input.target, input.actor, input.evidence);
    if (!result) throw new SettleAbort("reinstate_precondition_lost");
    if (!services.tickets.close(input.threadId, input.actor)) throw new SettleAbort("ticket_close_failed");
    return { ok: true, result };
  });
  try {
    return run.immediate();
  } catch (e) {
    if (e instanceof SettleAbort) return { ok: false, reason: e.reason };
    throw e;
  }
}

/**
 * 戻し先に合わせてロールを入れ替える。**危険な組み合わせを作らない順序**で行う。
 *
 * 迷霊ロールが通常階級と同居すると階級同期が迷霊を採り、台帳を巻き戻す。
 * そこで **余分な階級ロールを先に外し、消えたことを確かめてから目標ロールを付ける**。
 * 外せなければ目標ロールは付けない（付与イベントを起こさなければ同期も走らない）。
 */
export async function applyReturnRoles(
  services: Services,
  guild: Guild,
  member: GuildMember,
  targetId: string,
  target: Exclude<ReturnTarget, "waiting">,
  actor: string,
): Promise<string[]> {
  const errors: string[] = [];
  const wanted = target === "meirei" ? services.settings.getString(MEIREI_ROLE_SETTING_KEY) : services.settings.getString(RANK_ROLE_SETTING_KEYS[target as LadderRank]);
  if (!wanted) return [`${target} のロールが未設定`];

  const all = [
    ...RANK_LADDER.map((r) => services.settings.getString(RANK_ROLE_SETTING_KEYS[r])),
    services.settings.getString(MEIREI_ROLE_SETTING_KEY),
  ].filter((id): id is string => !!id);
  const toRemove = all.filter((id) => id !== wanted && member.roles.cache.has(id));

  let current = member;
  for (const roleId of toRemove) {
    const removed = await current.roles.remove(roleId).then(() => true).catch((e: Error) => e.message);
    if (removed !== true) {
      errors.push(`余分な階級ロール <@&${roleId}> の解除に失敗: ${removed}（目標ロールは付けていません）`);
      return errors;
    }
  }
  if (toRemove.length > 0) {
    const refetched = await guild.members.fetch({ user: targetId, force: true }).catch(() => null);
    if (!refetched) {
      errors.push("ロール解除後の再取得に失敗（目標ロールは付けていません）");
      return errors;
    }
    const stillThere = toRemove.filter((id) => refetched.roles.cache.has(id));
    if (stillThere.length > 0) {
      errors.push(`解除したはずのロールが残っています: ${stillThere.map((id) => `<@&${id}>`).join(", ")}（目標ロールは付けていません）`);
      return errors;
    }
    current = refetched;
  }

  if (!current.roles.cache.has(wanted)) {
    const added = await current.roles.add(wanted).then(() => true).catch((e: Error) => e.message);
    if (added !== true) errors.push(`目標ロール <@&${wanted}> の付与に失敗: ${added}`);
  }
  // 案内待ちロールは階級ロールではないので、同期に影響しない。最後に外す
  const waitRoleId = services.settings.getString("role:queue_wait");
  if (waitRoleId && current.roles.cache.has(waitRoleId)) {
    const removed = await current.roles.remove(waitRoleId).then(() => true).catch((e: Error) => e.message);
    if (removed !== true) errors.push(`案内待ちロールの解除に失敗: ${removed}`);
  }
  services.events.log("entry_return_roles_applied", { actor, target: targetId, payload: { to: target, removed: toRemove, added: wanted, errors } });
  return errors;
}

/**
 * ロール反映後の最終確認。**force fetch で取り直してから**見る。
 *
 * 目標階級ロールだけが付いていること・迷霊と通常階級が同居していないこと・
 * 案内待ちが残っていないことを確かめ、崩れていれば修復が必要な状態として記録する。
 */
export async function postCheckRoles(
  services: Services,
  guild: Guild,
  targetId: string,
  target: Exclude<ReturnTarget, "waiting">,
  actor: string,
): Promise<string[]> {
  const problems: string[] = [];
  const member = await guild.members.fetch({ user: targetId, force: true }).catch(() => null);
  if (!member) {
    problems.push("反映後の再取得に失敗しました（ロール構成を確認できていません）");
  } else {
    const wanted = target === "meirei" ? services.settings.getString(MEIREI_ROLE_SETTING_KEY) : services.settings.getString(RANK_ROLE_SETTING_KEYS[target as LadderRank]);
    const others = [
      ...RANK_LADDER.map((r) => [r as string, services.settings.getString(RANK_ROLE_SETTING_KEYS[r])] as const),
      ["meirei", services.settings.getString(MEIREI_ROLE_SETTING_KEY)] as const,
    ].filter(([, id]) => !!id && id !== wanted && member.roles.cache.has(id!));
    if (wanted && !member.roles.cache.has(wanted)) problems.push(`目標の ${target} ロールが付いていません`);
    if (others.length > 0) problems.push(`余分な階級ロールが残っています: ${others.map(([r]) => r).join(", ")}`);
    const waitRoleId = services.settings.getString("role:queue_wait");
    if (waitRoleId && member.roles.cache.has(waitRoleId)) problems.push("案内待ちロールが残っています");
  }
  services.events.log(problems.length === 0 ? "entry_return_roles_verified" : "entry_return_roles_repair_needed", {
    actor,
    target: targetId,
    payload: { to: target, problems },
  });
  return problems;
}

/** 出戻り申請ボタンを出す条件を人が読めるようにしたヘルパ（チケット作成時に使う） */
export function returnTicketIntro(services: Services, userId: string): string {
  const ctx = services.returns.context(userId);
  if (!ctx.hasSoul) return "⚠️ 台帳に記録がありません。再参加の記録が作られていない可能性があるため、運営が確認してください。";
  if (ctx.currentStatus !== "waiting") return `ℹ️ 現在の台帳は **${ctx.currentStatus}** です。出戻りの反映は案内待ちからのみ行えます。`;
  return ctx.everMeirei
    ? "下の選択から今回の戻し先を決めてください。**この方は以前に迷霊でした。**"
    : "下の選択から今回の戻し先を決めてください。";
}
