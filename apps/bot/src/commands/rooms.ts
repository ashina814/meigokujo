import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  UserSelectMenuInteraction,
  type CategoryChannel,
  type Guild,
  type GuildMember,
  type MessageCreateOptions,
  type TextChannel,
  type VoiceChannel,
  type VoiceState,
} from "discord.js";
import { LedgerError, RoomError, roomOwnershipSlot, type RoomKind, type RoomRow } from "@meigokujo/core";
import { fmtLd } from "../format.js";
import type { Services } from "../services.js";

const KIND_LABELS: Record<RoomKind, string> = {
  normal: "宿",
  mitsugetsu: "蜜月",
  oborozuki: "朧月",
  game: "ゲーム部屋",
};

const KIND_TITLE: Record<RoomKind, string> = {
  normal: "🛏 宿",
  mitsugetsu: "🌸 蜜月",
  oborozuki: "🌙 朧月",
  game: "🎲 ゲーム部屋",
};

const KIND_EMOJI: Record<RoomKind, string> = {
  normal: "🛏",
  mitsugetsu: "🌸",
  oborozuki: "🌙",
  game: "🎲",
};

const paidConfirmTtlMs = 5 * 60 * 1000;
const pendingCreates = new Set<string>();

function panelCategoryId(
  interaction:
    | ButtonInteraction
    | StringSelectMenuInteraction
    | UserSelectMenuInteraction
    | ModalSubmitInteraction,
): string | null {
  const ch = interaction.channel;
  if (ch && !ch.isDMBased() && "parentId" in ch) return ch.parentId ?? null;
  return null;
}

/** 宿の種別ごとの正規カテゴリ設定キー（巣穴の `category:eval_den` と同じ流儀） */
export const ROOM_CATEGORY_SETTING_KEYS: Readonly<Record<RoomKind, string>> = {
  normal: "category:room_normal",
  mitsugetsu: "category:room_mitsugetsu",
  oborozuki: "category:room_oborozuki",
  game: "category:room_game",
};

/** 種別ごとの設定が無いときに使う共通の宿カテゴリ */
export const ROOM_CATEGORY_FALLBACK_KEY = "category:rooms";

/**
 * 宿VCを作る**正規の**カテゴリを決める。
 *
 * 生成先は「操作されたパネルがたまたま置かれている場所」ではなく、種別ごとの設定で決める。
 * パネルを別カテゴリへ動かしたら宿VCまでそこへ作られる、という状態にしないため。
 *
 * とくに秘密の宿(oborozuki)は **DMの承諾ボタン**から作られるので、そもそも参照できる
 * 親カテゴリが存在せず、これまで常にカテゴリ外（サーバー直下）へ作られていた。
 * カテゴリが付かないと XP・浮上報酬の除外判定（チャンネルID または 親カテゴリID）が
 * 親側で成立せず、除外設定に載せる方法が無くなる。
 *
 * 未設定のあいだは従来どおり `fallbackCategoryId`（パネルの親）へ落とす。
 * デプロイした瞬間に既存サーバーの生成先が変わらないようにするため。
 * ただし未設定のままでは秘密の宿のXP漏れは直らないので、運営が
 * 「⚙️設定 → カテゴリ」で入れることが前提。
 */
function roomCategoryId(services: Services, kind: RoomKind, fallbackCategoryId: string | null): string | null {
  return (
    services.settings.getString(ROOM_CATEGORY_SETTING_KEYS[kind]) ??
    services.settings.getString(ROOM_CATEGORY_FALLBACK_KEY) ??
    fallbackCategoryId
  );
}

function formatHours(hours: number): string {
  return `${hours}時間`;
}

function roomDescription(kind: RoomKind, services?: Services): string {
  if (!services) {
    return {
      normal: "2人まで無料。人数枠は設定額で追加できます。",
      mitsugetsu: "異性へ匿名募集を出し、参加者だけが入れる部屋です。",
      oborozuki: "相手の承諾後にだけ作成される秘密の部屋です。",
      game: "時間を選んで利用するゲーム用VCです。",
    }[kind];
  }
  const v = services.rooms.panelValues();
  if (kind === "normal") {
    return [
      "無料で作れます。通常宿枠は同時に1部屋までです。",
      `初期定員: 2人 / 最大定員: ${v.normalMaxCapacity}人`,
      `人数枠追加: 1枠ごとに ${fmtLd(v.slotPrice)}`,
    ].join("\n");
  }
  if (kind === "mitsugetsu") {
    return [
      `料金: ${fmtLd(v.mitsugetsuPrice)}`,
      `募集期限: ${formatHours(v.recruitExpireHours)}`,
      `募集失効時の返金額: ${fmtLd(v.recruitRefund)}`,
      "特殊部屋枠は蜜月・朧月・ゲーム部屋をまとめて同時に1部屋までです。",
    ].join("\n");
  }
  if (kind === "oborozuki") {
    return [
      `料金: ${fmtLd(v.oborozukiPrice)}`,
      `利用期限: ${formatHours(v.loveRoomTtlHours)}`,
      "選んだ相手へDM招待を送り、承諾された場合だけ課金・作成されます。",
      "特殊部屋枠は蜜月・朧月・ゲーム部屋をまとめて同時に1部屋までです。",
    ].join("\n");
  }
  return [
    "料金表:",
    ...v.gameTiers.map(([h, price]) => `- ${formatHours(h)}: ${fmtLd(price)}`),
    "特殊部屋枠は蜜月・朧月・ゲーム部屋をまとめて同時に1部屋までです。",
  ].join("\n");
}

export function roomPanelMessage(kind: RoomKind, services?: Services): MessageCreateOptions {
  const v = services?.rooms.panelValues();
  const lifecycle = v
    ? [
        "",
        `未入室のまま ${v.unusedGraceMinutes}分 経つと自動削除されます。`,
        `全員退出後は ${v.emptyGraceMinutes}分 後に自動削除されます。再入室すると削除予定は解除されます。`,
        kind === "normal" ? "無料宿の自動削除では返金はありません。" : "未利用の有料部屋がBot整理で削除される場合は、条件を満たすと全額返金されます。",
      ].join("\n")
    : "\n全員が退出すると自動で消えます。";
  const embed = new EmbedBuilder()
    .setTitle(KIND_TITLE[kind])
    .setDescription([roomDescription(kind, services), lifecycle].join("\n"))
    .setColor(0x6b21a8);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`room:new:${kind}`)
      .setLabel(`${KIND_LABELS[kind]}を立てる`)
      .setEmoji(KIND_EMOJI[kind])
      .setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

async function createRoomChannel(
  guild: Guild,
  services: Services,
  kind: RoomKind,
  owner: GuildMember,
  members: string[],
  parentCategoryId: string | null,
): Promise<VoiceChannel | null> {
  const secret = kind === "oborozuki";
  const parentFetched = parentCategoryId ? await guild.channels.fetch(parentCategoryId).catch(() => null) : null;
  const category = parentFetched?.type === ChannelType.GuildCategory ? (parentFetched as CategoryChannel) : null;
  // 生成先が指定されているのに解決できないなら**作らない**。
  // ここで黙って `parent: undefined` へ落ちると、カテゴリが消された・別種別の
  // チャンネルIDが入っていた、というだけで宿VCがサーバー直下に生まれ、
  // 親カテゴリでのXP除外が効かなくなる（今回直した不具合がそのまま再発する）。
  // カテゴリ未指定(null)のときだけ、従来互換でカテゴリ無し生成を許す
  if (parentCategoryId !== null && !category) {
    console.error(
      `[room] 生成先カテゴリを解決できないため作成を中止: kind=${kind} categoryId=${parentCategoryId} ` +
        `(${parentFetched ? `type=${parentFetched.type}` : "取得不可"})`,
    );
    return null;
  }
  const everyone = guild.roles.everyone.id;
  const adminRoleId = services.settings.getString("role:admin");

  const overwrites: Array<{ id: string; allow?: bigint[]; deny?: bigint[] }> = [];
  if (secret) {
    overwrites.push({ id: everyone, deny: [PermissionFlagsBits.ViewChannel] });
    for (const m of members) overwrites.push({ id: m, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] });
    if (adminRoleId) overwrites.push({ id: adminRoleId, allow: [PermissionFlagsBits.ViewChannel] });
  } else if (kind === "mitsugetsu") {
    overwrites.push({ id: everyone, deny: [PermissionFlagsBits.ViewChannel] });
    overwrites.push({ id: owner.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] });
  }

  const userLimit = kind === "game" ? undefined : kind === "normal" ? 2 : 3;
  const channel = await guild.channels
    .create({
      name: `${KIND_LABELS[kind]}-${owner.displayName}`.slice(0, 90),
      type: ChannelType.GuildVoice,
      parent: category ?? undefined,
      userLimit,
      permissionOverwrites: overwrites.length > 0 ? overwrites : undefined,
    })
    .catch((e) => {
      console.error("[room] チャンネル作成失敗:", e);
      return null;
    });
  if (channel && category && overwrites.length === 0) await channel.lockPermissions().catch(() => undefined);
  return channel;
}

function isRoomAdmin(member: GuildMember | null | undefined, services: Services): boolean {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.ManageChannels)) return true;
  const adminRoleId = services.settings.getString("role:admin");
  return !!adminRoleId && member.roles.cache.has(adminRoleId);
}

function roomAccessConflictMessage(error: RoomError): string {
  const slot = error.meta.slot === "normal" ? "通常宿枠" : "特殊部屋枠";
  const room = error.meta.room as RoomRow | undefined;
  const detail = room ? `（使用中: ${KIND_LABELS[room.kind]} / <#${room.channel_id}>）` : "";
  return `${slot}を使用中です${detail}。その枠の部屋を閉じてから作成してください。`;
}

function balanceLine(services: Services, userId: string, price: number): string {
  const balance = services.ledger.balanceOf(`user:${userId}`);
  return [`現在残高: ${fmtLd(balance)}`, `支払後残高: ${fmtLd(balance - price)}`].join("\n");
}

function operationPanel(room: RoomRow, services: Services): ActionRowBuilder<ButtonBuilder>[] {
  const controls: ButtonBuilder[] = [
    new ButtonBuilder().setCustomId(`room:rename:${room.id}`).setLabel("名前を変える").setEmoji("🏷").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`room:close:${room.id}`).setLabel("部屋を閉じる").setEmoji("🧹").setStyle(ButtonStyle.Danger),
  ];
  if (room.kind === "normal") {
    controls.splice(
      1,
      0,
      new ButtonBuilder()
        .setCustomId(`room:slot:${room.id}`)
        .setLabel(`人数枠+1（${fmtLd(services.settings.getNumber("room_slot_price"))}）`)
        .setStyle(ButtonStyle.Secondary),
    );
  }
  if (room.kind === "mitsugetsu") {
    controls.splice(1, 0, new ButtonBuilder().setCustomId(`room:cancelrecruit:${room.id}`).setLabel("募集を取り消す").setStyle(ButtonStyle.Secondary));
  }
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(...controls.slice(0, 5))];
}

async function sendRoomIntro(channel: VoiceChannel, room: RoomRow, owner: GuildMember, services: Services): Promise<void> {
  const v = services.rooms.panelValues();
  const expiry = room.expires_at ? `\n利用期限: <t:${room.expires_at}:t>` : "";
  await channel.send({
    content: [
      `${KIND_LABELS[room.kind]}を開きました（オーナー: <@${owner.id}>）。`,
      `現在の定員: ${room.kind === "game" ? "制限なし" : `${room.capacity}人`}`,
      `未入室削除: ${v.unusedGraceMinutes}分 / 全員退出後削除: ${v.emptyGraceMinutes}分`,
      room.kind === "normal"
        ? "通常宿は無料です。自己都合クローズや全員退出クローズで返金はありません。"
        : "未利用の有料部屋がBot整理で削除される場合は、条件を満たすと全額返金されます。自己都合クローズは通常返金されません。",
      expiry,
    ].join("\n"),
    components: operationPanel(room, services),
    allowedMentions: { users: [owner.id] },
  });
}

async function cleanupRegisteredRoomChannel(
  channel: VoiceChannel,
  services: Services,
  room: RoomRow,
  closeReason: string,
  actor: string,
  deleteReason: string,
): Promise<boolean> {
  services.rooms.requestDelete(room.id, closeReason, actor);
  try {
    await channel.delete(deleteReason);
    services.rooms.markDeletedAndClosed(room.id, closeReason, actor);
    return true;
  } catch (error) {
    console.error("[room] 登録済み部屋のVC削除に失敗しました", { roomId: room.id, channelId: channel.id, closeReason, error });
    services.rooms.markDeleteFailed(room.id, error);
    return false;
  }
}

export function handleRoomVoiceUpdate(oldState: VoiceState, newState: VoiceState, services: Services): void {
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) return;
  if (!newState.channelId || newState.channelId === oldState.channelId) return;
  const room = services.rooms.byChannel(newState.channelId);
  if (!room || room.status !== "open" || room.pending_delete) return;
  services.rooms.markOccupancy(room.id, true);
}

export async function handleRoomButton(
  interaction: ButtonInteraction | StringSelectMenuInteraction | UserSelectMenuInteraction,
  services: Services,
): Promise<void> {
  const id = interaction.customId;

  if (id.startsWith("room:new:") && interaction.isButton()) {
    const kind = id.split(":")[2] as RoomKind;
    if (kind === "game") {
      const tiers = services.rooms.gameTiers();
      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("room:gametier")
          .setPlaceholder("利用時間を選ぶ")
          .addOptions(tiers.map(([h, price]) => ({ label: `${h}時間 — ${fmtLd(price)}`, value: String(h) }))),
      );
      await interaction.reply({ content: "🎲 利用時間を選んでください。次の画面で支払い確認をします。", components: [row], flags: MessageFlags.Ephemeral });
      return;
    }
    if (kind === "mitsugetsu") {
      const price = services.rooms.priceFor("mitsugetsu");
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("room:recruitg:male").setLabel("男性を募集").setEmoji("🚹").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("room:recruitg:female").setLabel("女性を募集").setEmoji("🚺").setStyle(ButtonStyle.Danger),
      );
      await interaction.reply({ content: `🌸 どちらを募集しますか？\n料金: ${fmtLd(price)}\n次の入力後、募集投稿が可能なことを確認してから課金します。`, components: [row], flags: MessageFlags.Ephemeral });
      return;
    }
    if (kind === "oborozuki") {
      const row = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        new UserSelectMenuBuilder().setCustomId("room:oboro:target").setPlaceholder("招く相手を選ぶ（1人）"),
      );
      await interaction.reply({ content: `🌙 朧月に招く相手を選んでください。\n料金: ${fmtLd(services.rooms.priceFor("oborozuki"))}\n相手の承諾前には課金も部屋作成も行いません。`, components: [row], flags: MessageFlags.Ephemeral });
      return;
    }
    await createAndReply(interaction, services, "normal", [interaction.user.id]);
    return;
  }

  if (id === "room:gametier" && interaction.isStringSelectMenu()) {
    const hours = Number(interaction.values[0]);
    await showCreateConfirm(interaction, services, "game", hours);
    return;
  }

  if (id.startsWith("room:createpay:") && interaction.isButton()) {
    const [, , kind, hoursStr, priceStr, createdStr] = id.split(":");
    if (Date.now() - Number(createdStr) > paidConfirmTtlMs) {
      await interaction.update({ content: "確認画面の期限が切れました。もう一度操作してください。", components: [] });
      return;
    }
    await createAndReply(interaction, services, kind as RoomKind, [interaction.user.id], { hours: Number(hoursStr), expectedPrice: Number(priceStr) });
    return;
  }

  if (id === "room:createcancel" && interaction.isButton()) {
    await interaction.update({ content: "操作を取り消しました。", components: [] });
    return;
  }

  if (id === "room:oboro:target" && interaction.isUserSelectMenu()) {
    await handleOboroTarget(interaction, services);
    return;
  }

  if (id.startsWith("room:oboroinvite:") && interaction.isButton()) {
    await executeOboroInvite(interaction, services);
    return;
  }

  if (id.startsWith("room:oboroaccept:") && interaction.isButton()) {
    await handleOboroDecision(interaction, services, "accept");
    return;
  }

  if (id.startsWith("room:oborodecline:") && interaction.isButton()) {
    await handleOboroDecision(interaction, services, "decline");
    return;
  }

  if (id.startsWith("room:recruitg:") && interaction.isButton()) {
    const gender = id.endsWith("male") && !id.endsWith("female") ? "male" : "female";
    await interaction.showModal(recruitModal(gender, services));
    return;
  }

  if (id.startsWith("room:join:") && interaction.isButton()) {
    await handleRecruitJoin(interaction, services);
    return;
  }

  if (id.startsWith("room:slotpay:") && interaction.isButton()) {
    await executeAddSlot(interaction, services);
    return;
  }

  if (id.startsWith("room:slot:") && interaction.isButton()) {
    await showAddSlotConfirm(interaction, services);
    return;
  }

  if (id.startsWith("room:rename:") && interaction.isButton()) {
    await handleRenameButton(interaction, services);
    return;
  }

  if (id.startsWith("room:extendpay:") && interaction.isButton()) {
    await executeExtendGame(interaction, services);
    return;
  }

  if (id.startsWith("room:extend:") && interaction.isButton()) {
    await showExtendConfirm(interaction, services);
    return;
  }

  if (id.startsWith("room:closeconfirm:") && interaction.isButton()) {
    await executeManualClose(interaction, services);
    return;
  }

  if (id.startsWith("room:close:") && interaction.isButton()) {
    await showCloseConfirm(interaction, services);
    return;
  }

  if (id.startsWith("room:cancelrecruit:") && interaction.isButton()) {
    await showRecruitCancelConfirm(interaction, services);
    return;
  }

  if (id.startsWith("room:recruitcancelconfirm:") && interaction.isButton()) {
    await executeRecruitCancel(interaction, services);
    return;
  }
}

async function showCreateConfirm(interaction: StringSelectMenuInteraction, services: Services, kind: RoomKind, hours: number): Promise<void> {
  const price = services.rooms.priceFor(kind, hours);
  const content = [
    `操作: ${KIND_LABELS[kind]}を作成`,
    `利用時間: ${formatHours(hours)}`,
    `支払額: ${fmtLd(price)}`,
    balanceLine(services, interaction.user.id, price),
    "",
    "料金設定がこの確認画面から変わった場合、課金せず中止します。",
  ].join("\n");
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`room:createpay:${kind}:${hours}:${price}:${Date.now()}`).setLabel("支払って実行").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("room:createcancel").setLabel("やめる").setStyle(ButtonStyle.Secondary),
  );
  await interaction.update({ content, components: [row] });
}

async function createAndReply(
  interaction: ButtonInteraction | StringSelectMenuInteraction | UserSelectMenuInteraction,
  services: Services,
  kind: RoomKind,
  members: string[],
  opts: { hours?: number; expectedPrice?: number } = {},
): Promise<void> {
  if (interaction.isButton()) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } else {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  }
  const finish = (content: string) => interaction.editReply({ content, components: [] });
  const guild = interaction.guild!;
  const owner = (await guild.members.fetch(interaction.user.id)) as GuildMember;
  const slot = roomOwnershipSlot(kind);
  const guardKey = `${owner.id}:${slot}`;
  if (pendingCreates.has(guardKey)) {
    await finish("同じ所有枠の部屋を作成中です。少し待ってから確認してください。");
    return;
  }
  pendingCreates.add(guardKey);

  let channel: VoiceChannel | null = null;
  try {
    const conflict = services.rooms.ownershipConflict(owner.id, kind);
    if (conflict) {
      await finish(roomAccessConflictMessage(new RoomError("ERR_ALREADY_OWNS", conflict)));
      return;
    }
    const price = services.rooms.priceFor(kind, opts.hours);
    if (opts.expectedPrice !== undefined && opts.expectedPrice !== price) {
      await finish("料金設定が確認時から変更されています。課金せず中止しました。もう一度操作してください。");
      return;
    }
    if (price > 0 && services.ledger.balanceOf(`user:${owner.id}`) < price) {
      await finish(`残高が足りません（所持: ${fmtLd(services.ledger.balanceOf(`user:${owner.id}`))} / 必要: ${fmtLd(price)}）。`);
      return;
    }

    channel = await createRoomChannel(guild, services, kind, owner, members, roomCategoryId(services, kind, panelCategoryId(interaction)));
    if (!channel) {
      await finish("部屋の作成に失敗しました。運営に宿の生成先カテゴリ設定を確認してもらってください。");
      return;
    }

    const room = services.rooms.register({ kind, channelId: channel.id, ownerId: owner.id, hours: opts.hours });
    try {
      await sendRoomIntro(channel, room, owner, services);
    } catch (error) {
      console.error("[room] 操作パネル投稿失敗。作成済みVCを片付けます", { roomId: room.id, channelId: channel.id, error });
      if (price > 0) services.rooms.refundUnusedPaidRoom(room.id);
      const deleted = await cleanupRegisteredRoomChannel(channel, services, room, "panel_post_failed", `user:${owner.id}`, "部屋パネル投稿失敗のためロールバック");
      await finish(
        deleted
          ? price > 0
            ? "部屋内パネルの投稿に失敗したため作成を中止し、課金済み分は返金しました。"
            : "部屋内パネルの投稿に失敗したため作成を中止しました。"
          : price > 0
            ? "部屋内パネルの投稿に失敗したため作成を中止し、課金済み分は返金しました。VC削除は失敗したため次回スキャンで再試行します。"
            : "部屋内パネルの投稿に失敗したため作成を中止しました。VC削除は失敗したため次回スキャンで再試行します。",
      );
      return;
    }
    if (owner.voice.channel) {
      await owner.voice
        .setChannel(channel)
        .then(() => services.rooms.markOccupancy(room.id, true))
        .catch(() => undefined);
    }
    const expiry = room.expires_at ? ` / 期限: <t:${room.expires_at}:t>` : "";
    await finish(`✅ ${KIND_LABELS[kind]}を作成しました: ${channel.toString()}${price > 0 ? `（−${fmtLd(price)}）` : ""}${expiry}`);
  } catch (error) {
    if (channel) {
      await channel.delete("部屋登録失敗のためロールバック").catch((deleteError) => {
        console.error("[room] 登録失敗後のVC削除にも失敗しました", { channelId: channel?.id, deleteError });
      });
    }
    if (error instanceof RoomError && error.code === "ERR_ALREADY_OWNS") {
      await finish(roomAccessConflictMessage(error));
      return;
    }
    const msg = error instanceof LedgerError && error.code === "ERR_INSUFFICIENT" ? "課金に失敗しました（残高をご確認ください）。" : "部屋の登録に失敗しました。課金やDB登録は確定していません。";
    await finish(msg);
  } finally {
    pendingCreates.delete(guardKey);
  }
}

async function showAddSlotConfirm(interaction: ButtonInteraction, services: Services): Promise<void> {
  const roomId = Number(interaction.customId.split(":")[2]);
  const room = services.rooms.get(roomId);
  const price = services.settings.getNumber("room_slot_price");
  const content = [
    "操作: 宿の人数枠を1つ追加",
    `対象部屋: ${KIND_LABELS[room.kind]} / <#${room.channel_id}>`,
    `現在の定員: ${room.capacity}人`,
    `変更後の定員: ${room.capacity + 1}人`,
    `支払額: ${fmtLd(price)}`,
    balanceLine(services, interaction.user.id, price),
  ].join("\n");
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`room:slotpay:${room.id}:${price}:${room.capacity}`).setLabel("支払って実行").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("room:createcancel").setLabel("やめる").setStyle(ButtonStyle.Secondary),
  );
  await interaction.reply({ content, components: [row], flags: MessageFlags.Ephemeral });
}

async function executeAddSlot(interaction: ButtonInteraction, services: Services): Promise<void> {
  const [, , roomIdStr, priceStr, capacityStr] = interaction.customId.split(":");
  const roomId = Number(roomIdStr);
  const room = services.rooms.get(roomId);
  const ch = interaction.channel;
  if (!ch || ch.type !== ChannelType.GuildVoice || !(ch as VoiceChannel).members.has(interaction.user.id)) {
    await interaction.update({ content: "このVCに入ってから枠を追加してください。課金していません。", components: [] });
    return;
  }
  if (services.settings.getNumber("room_slot_price") !== Number(priceStr) || room.capacity !== Number(capacityStr)) {
    await interaction.update({ content: "料金または定員が確認時から変わっています。課金していません。もう一度操作してください。", components: [] });
    return;
  }
  try {
    const updated = services.rooms.addSlot(roomId, interaction.user.id);
    try {
      await (ch as VoiceChannel).setUserLimit(updated.capacity);
    } catch (error) {
      console.error("[rooms] failed to update voice channel user limit after paid slot add", {
        roomId,
        channelId: room.channel_id,
        capacity: updated.capacity,
        error,
      });
      await interaction.update({
        content: `⚠️ 枠追加の支払いと記録は完了しましたが、Discord側の定員反映に失敗しました（DB上の定員: ${updated.capacity}人）。運営へ連絡してください。`,
        components: [],
      });
      return;
    }
    await interaction.update({ content: `✅ <@${interaction.user.id}> が枠を追加しました（定員 ${updated.capacity}人）。`, components: [], allowedMentions: { parse: [] } });
  } catch (error) {
    const msg =
      error instanceof LedgerError && error.code === "ERR_INSUFFICIENT"
        ? "残高が足りません。課金していません。"
        : error instanceof RoomError && error.code === "ERR_CAPACITY_LIMIT"
          ? "最大定員に達しています。課金していません。"
          : "枠の追加に失敗しました。課金していません。";
    await interaction.update({ content: msg, components: [] });
  }
}

async function showExtendConfirm(interaction: ButtonInteraction, services: Services): Promise<void> {
  const [, , roomIdStr, hoursStr] = interaction.customId.split(":");
  const room = services.rooms.get(Number(roomIdStr));
  const hours = Number(hoursStr);
  const price = services.rooms.priceFor("game", hours);
  const content = [
    "操作: ゲーム部屋を延長",
    `対象部屋: <#${room.channel_id}>`,
    `現在期限: ${room.expires_at ? `<t:${room.expires_at}:t>` : "なし"}`,
    `変更後期限: ${room.expires_at ? `<t:${room.expires_at + hours * 3600}:t>` : "なし"}`,
    `支払額: ${fmtLd(price)}`,
    balanceLine(services, interaction.user.id, price),
  ].join("\n");
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`room:extendpay:${room.id}:${hours}:${price}:${room.expires_at ?? 0}`).setLabel("支払って実行").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("room:createcancel").setLabel("やめる").setStyle(ButtonStyle.Secondary),
  );
  await interaction.reply({ content, components: [row], flags: MessageFlags.Ephemeral });
}

async function executeExtendGame(interaction: ButtonInteraction, services: Services): Promise<void> {
  const [, , roomIdStr, hoursStr, priceStr, expiresStr] = interaction.customId.split(":");
  const room = services.rooms.get(Number(roomIdStr));
  const hours = Number(hoursStr);
  if (room.expires_at !== Number(expiresStr) || services.rooms.priceFor("game", hours) !== Number(priceStr)) {
    await interaction.update({ content: "料金または期限が確認時から変わっています。課金していません。もう一度操作してください。", components: [] });
    return;
  }
  const ch = interaction.channel;
  if (!ch || ch.type !== ChannelType.GuildVoice || !(ch as VoiceChannel).members.has(interaction.user.id)) {
    await interaction.update({ content: "このVCに入ってから延長してください。課金していません。", components: [] });
    return;
  }
  try {
    const updated = services.rooms.extendGame(room.id, hours, interaction.user.id);
    await interaction.update({ content: `✅ <@${interaction.user.id}> が +${hours}時間 延長しました（新期限 <t:${updated.expires_at}:t>）。`, components: [], allowedMentions: { parse: [] } });
  } catch (error) {
    const msg = error instanceof LedgerError && error.code === "ERR_INSUFFICIENT" ? "残高が足りません。課金していません。" : "延長に失敗しました。課金していません。";
    await interaction.update({ content: msg, components: [] });
  }
}

async function showCloseConfirm(interaction: ButtonInteraction, services: Services): Promise<void> {
  const room = services.rooms.get(Number(interaction.customId.split(":")[2]));
  const member = interaction.member as GuildMember | null;
  if (interaction.user.id !== room.owner_id && !isRoomAdmin(member, services)) {
    await interaction.reply({ content: "部屋を閉じられるのはオーナーまたは運営だけです。", flags: MessageFlags.Ephemeral });
    return;
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`room:closeconfirm:${room.id}`).setLabel("閉じる").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("room:createcancel").setLabel("やめる").setStyle(ButtonStyle.Secondary),
  );
  await interaction.reply({
    content: `対象: ${KIND_LABELS[room.kind]} / <#${room.channel_id}>\n通常は返金されません。Discordチャンネル削除に成功した後でDBをclosedにします。`,
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

async function executeManualClose(interaction: ButtonInteraction, services: Services): Promise<void> {
  const room = services.rooms.get(Number(interaction.customId.split(":")[2]));
  const member = interaction.member as GuildMember | null;
  if (interaction.user.id !== room.owner_id && !isRoomAdmin(member, services)) {
    await interaction.update({ content: "部屋を閉じられるのはオーナーまたは運営だけです。", components: [] });
    return;
  }
  await interaction.deferUpdate();
  services.rooms.requestDelete(room.id, "manual", `user:${interaction.user.id}`);
  const channel = (await interaction.guild!.channels.fetch(room.channel_id).catch((error) => error)) as VoiceChannel | Error | null;
  if (channel instanceof Error) {
    services.rooms.markDeleteFailed(room.id, channel);
    await interaction.editReply({ content: "Discordチャンネルの削除に失敗したため、次回スキャンで再試行します。DBはclosedにしていません。", components: [] });
    return;
  }
  if (channel) {
    try {
      await channel.delete("部屋の手動クローズ");
    } catch (error) {
      services.rooms.markDeleteFailed(room.id, error);
      await interaction.editReply({ content: "Discordチャンネルの削除に失敗したため、次回スキャンで再試行します。DBはclosedにしていません。", components: [] });
      return;
    }
  }
  services.rooms.markDeletedAndClosed(room.id, "manual", `user:${interaction.user.id}`);
  await interaction.editReply({ content: "✅ 部屋を閉じました。自己都合クローズのため返金はありません。", components: [] }).catch(() => undefined);
}

async function handleRenameButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  const roomId = Number(interaction.customId.split(":")[2]);
  const room = services.rooms.byChannel(interaction.channelId) ?? (Number.isFinite(roomId) ? services.rooms.get(roomId) : undefined);
  if (!room || room.status !== "open") {
    await interaction.reply({ content: "この部屋は見つかりませんでした。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.user.id !== room.owner_id && !isRoomAdmin(interaction.member as GuildMember | null, services)) {
    await interaction.reply({ content: "名前を変えられるのは部屋のオーナーだけです。", flags: MessageFlags.Ephemeral });
    return;
  }
  const modal = new ModalBuilder()
    .setCustomId(`room:renamemodal:${room.id}`)
    .setTitle("部屋の名前を変える")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("name").setLabel("新しい名前").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(90),
      ),
    );
  await interaction.showModal(modal);
}

function sanitizeRoomName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

export async function handleRoomRenameModal(interaction: ModalSubmitInteraction, services: Services): Promise<void> {
  const roomId = Number(interaction.customId.split(":")[2]);
  let room: RoomRow;
  try {
    room = services.rooms.get(roomId);
  } catch {
    await interaction.reply({ content: "この部屋は見つかりませんでした。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (room.status !== "open") {
    await interaction.reply({ content: "閉じた部屋の名前は変更できません。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.user.id !== room.owner_id && !isRoomAdmin(interaction.member as GuildMember | null, services)) {
    await interaction.reply({ content: "名前を変えられるのは部屋のオーナーだけです。", flags: MessageFlags.Ephemeral });
    return;
  }
  const name = sanitizeRoomName(interaction.fields.getTextInputValue("name"));
  if (!name) {
    await interaction.reply({ content: "名前を入力してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  const channel = (await interaction.guild!.channels.fetch(room.channel_id).catch(() => null)) as VoiceChannel | null;
  if (!channel) {
    await interaction.reply({ content: "部屋が見つかりませんでした。", flags: MessageFlags.Ephemeral });
    return;
  }
  try {
    await channel.setName(name);
  } catch (error) {
    console.error("[room] 名前変更失敗", { roomId, channelId: room.channel_id, error });
    await interaction.reply({ content: "Discord側の名前変更に失敗しました。元の名前を維持しています。", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({ content: `✅ 部屋の名前を「${name}」に変えました。`, flags: MessageFlags.Ephemeral });
}

function recruitModal(gender: "male" | "female", services: Services): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`room:recruit:${gender}`)
    .setTitle(`蜜月の募集 — ${gender === "male" ? "男性" : "女性"}向け（${fmtLd(services.rooms.priceFor("mitsugetsu"))}）`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("purpose").setLabel("目的（例: 寝落ち・作業・雑談）").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("message").setLabel("ひとこと（任意）").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(200),
      ),
    );
}

export async function handleRecruitModal(interaction: ModalSubmitInteraction, services: Services): Promise<void> {
  const gender = interaction.customId.endsWith(":male") ? ("male" as const) : ("female" as const);
  const purpose = interaction.fields.getTextInputValue("purpose").trim();
  const message = interaction.fields.getTextInputValue("message").trim() || undefined;
  const guild = interaction.guild!;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const owner = (await guild.members.fetch(interaction.user.id)) as GuildMember;

  const genderRoleId = services.settings.getString(gender === "male" ? "role:male" : "role:female");
  const panelChannelId = services.settings.getString("channel:recruit");
  const panelChannel = panelChannelId ? ((await guild.client.channels.fetch(panelChannelId).catch(() => null)) as TextChannel | null) : null;
  if (!genderRoleId || !panelChannel?.isTextBased()) {
    await interaction.editReply({ content: "募集投稿先または対象性別ロールが未設定のため、作成できません。課金していません。" });
    return;
  }
  const conflict = services.rooms.ownershipConflict(owner.id, "mitsugetsu");
  if (conflict) {
    await interaction.editReply({ content: roomAccessConflictMessage(new RoomError("ERR_ALREADY_OWNS", conflict)) });
    return;
  }
  const price = services.rooms.priceFor("mitsugetsu");
  if (services.ledger.balanceOf(`user:${owner.id}`) < price) {
    await interaction.editReply({ content: `残高が足りません（必要: ${fmtLd(price)}）。課金していません。` });
    return;
  }

  const channel = await createRoomChannel(guild, services, "mitsugetsu", owner, [owner.id], roomCategoryId(services, "mitsugetsu", panelCategoryId(interaction)));
  if (!channel) {
    await interaction.editReply({ content: "部屋の作成に失敗しました。課金していません。運営に宿の生成先カテゴリ設定を確認してもらってください。" });
    return;
  }

  let room: RoomRow | undefined;
  let recruitId: number | undefined;
  try {
    const created = services.rooms.registerWithRecruit({ channelId: channel.id, ownerId: owner.id, targetGender: gender, purpose, message });
    room = created.room;
    recruitId = created.recruit.id;
    const embed = new EmbedBuilder()
      .setTitle("❓ 匿名募集が届きました")
      .addFields(
        { name: "🏷 対象", value: `<@&${genderRoleId}>`, inline: true },
        { name: "👥 定員", value: "2名（残り1名）", inline: true },
        { name: "⏳ 募集期限", value: `<t:${created.recruit.expires_at}:R>`, inline: true },
        { name: "🎯 目的", value: purpose },
        ...(message ? [{ name: "💬 メッセージ", value: message }] : []),
      )
      .setFooter({ text: "参加ボタンを押すとチャンネルが表示されます" })
      .setColor(0xdb2777);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`room:join:${created.recruit.id}`).setLabel("このVCに参加する").setEmoji("🚪").setStyle(ButtonStyle.Success),
    );
    const sent = await panelChannel.send({
      content: `<@&${genderRoleId}>`,
      embeds: [embed],
      components: [row],
      allowedMentions: { roles: [genderRoleId] },
    });
    services.rooms.setRecruitPanel(created.recruit.id, sent.channelId, sent.id);
    await sendRoomIntro(channel, room, owner, services);
    if (owner.voice.channel) {
      await owner.voice
        .setChannel(channel)
        .then(() => services.rooms.markOccupancy(room!.id, true))
        .catch(() => undefined);
    }
    await interaction.editReply({
      content: `✅ 蜜月の募集を出しました（−${fmtLd(price)}）。応募がないまま${formatHours(services.rooms.panelValues().recruitExpireHours)}で失効すると、設定額 ${fmtLd(services.rooms.panelValues().recruitRefund)} を返金します。`,
    });
  } catch (error) {
    console.error("[room] 蜜月募集作成失敗", { roomId: room?.id, recruitId, error });
    if (room) {
      services.rooms.refundUnusedPaidRoom(room.id);
      services.rooms.requestDelete(room.id, "recruit_cancelled", `user:${owner.id}`);
    }
    if (recruitId) {
      try {
        services.rooms.cancelRecruit(recruitId, `user:${owner.id}`, "create_failed");
      } catch {
        // already closed
      }
    }
    if (room) {
      await cleanupRegisteredRoomChannel(channel, services, room, "recruit_cancelled", `user:${owner.id}`, "蜜月募集作成失敗のためロールバック");
    } else {
      await channel.delete("蜜月募集作成失敗のためロールバック").catch((deleteError) => {
        console.error("[room] 蜜月作成失敗後のVC削除にも失敗しました", { channelId: channel.id, deleteError });
      });
    }
    await interaction.editReply({ content: "募集作成に失敗したため中止しました。課金済みの場合は一度だけ返金しました。" });
  }
}

async function handleRecruitJoin(interaction: ButtonInteraction, services: Services): Promise<void> {
  const recruitId = Number(interaction.customId.split(":")[2]);
  let claimed = false;
  try {
    const recruit = services.rooms.claimRecruitForMatch(recruitId, interaction.user.id);
    claimed = true;
    if (interaction.user.id === recruit.owner_id) {
      services.rooms.releaseRecruitClaim(recruitId, interaction.user.id);
      await interaction.reply({ content: "自分の募集には参加できません。", flags: MessageFlags.Ephemeral });
      return;
    }
    const member = interaction.member as GuildMember;
    const wantRoleId = services.settings.getString(recruit.target_gender === "male" ? "role:male" : "role:female");
    if (wantRoleId && !member.roles.cache.has(wantRoleId)) {
      services.rooms.releaseRecruitClaim(recruitId, interaction.user.id);
      await interaction.reply({ content: "この募集の対象ではありません。", flags: MessageFlags.Ephemeral });
      return;
    }
    const room = services.rooms.get(recruit.room_id);
    if (room.status !== "open" || (room.expires_at && room.expires_at <= Math.floor(Date.now() / 1000))) {
      services.rooms.releaseRecruitClaim(recruitId, interaction.user.id);
      await interaction.reply({ content: "この募集は期限切れです。", flags: MessageFlags.Ephemeral });
      return;
    }
    const channel = (await interaction.guild!.channels.fetch(room.channel_id).catch(() => null)) as VoiceChannel | null;
    if (!channel) {
      services.rooms.releaseRecruitClaim(recruitId, interaction.user.id);
      await interaction.reply({ content: "部屋が見つかりませんでした（すでに閉じられた可能性があります）。", flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      await channel.permissionOverwrites.create(interaction.user.id, { ViewChannel: true, Connect: true });
    } catch (error) {
      services.rooms.releaseRecruitClaim(recruitId, interaction.user.id);
      console.error("[room] 蜜月参加者への権限付与失敗", { recruitId, userId: interaction.user.id, error });
      await interaction.reply({ content: "VC権限の付与に失敗しました。募集は締め切っていません。時間をおいて再度お試しください。", flags: MessageFlags.Ephemeral });
      return;
    }
    const matched = services.rooms.confirmRecruitMatched(recruitId, interaction.user.id);
    if (matched.panel_message_id && matched.panel_channel_id) {
      const pc = (await interaction.client.channels.fetch(matched.panel_channel_id).catch(() => null)) as TextChannel | null;
      const msg = await pc?.messages.fetch(matched.panel_message_id).catch(() => null);
      await msg?.edit({ content: "（この募集は締め切られました）", embeds: msg.embeds, components: [] }).catch(() => undefined);
    }
    await interaction.reply({ content: `✅ 参加しました: ${channel.toString()}`, flags: MessageFlags.Ephemeral });
  } catch (error) {
    if (claimed) services.rooms.releaseRecruitClaim(recruitId, interaction.user.id);
    const msg = error instanceof RoomError && (error.code === "ERR_RECRUIT_CLAIMED" || error.code === "ERR_RECRUIT_CLOSED") ? "この募集はすでに締め切られています。" : "参加処理に失敗しました。";
    await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }
}

async function showRecruitCancelConfirm(interaction: ButtonInteraction, services: Services): Promise<void> {
  const room = services.rooms.get(Number(interaction.customId.split(":")[2]));
  if (interaction.user.id !== room.owner_id) {
    await interaction.reply({ content: "募集を取り消せるのはオーナーだけです。", flags: MessageFlags.Ephemeral });
    return;
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`room:recruitcancelconfirm:${room.id}`).setLabel("募集を取り消す").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("room:createcancel").setLabel("やめる").setStyle(ButtonStyle.Secondary),
  );
  await interaction.reply({ content: "未成立の蜜月募集を取り消します。現時点の制度では自己都合取消の返金はありません。", components: [row], flags: MessageFlags.Ephemeral });
}

async function executeRecruitCancel(interaction: ButtonInteraction, services: Services): Promise<void> {
  const room = services.rooms.get(Number(interaction.customId.split(":")[2]));
  if (interaction.user.id !== room.owner_id) {
    await interaction.update({ content: "募集を取り消せるのはオーナーだけです。", components: [] });
    return;
  }
  const recruit = services.db
    .prepare("SELECT * FROM recruits WHERE room_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1")
    .get(room.id) as { id: number; panel_channel_id?: string; panel_message_id?: string } | undefined;
  if (!recruit) {
    await interaction.update({ content: "未成立の募集が見つかりません。", components: [] });
    return;
  }
  try {
    services.rooms.cancelRecruit(recruit.id, `user:${interaction.user.id}`, "owner_cancelled");
  } catch {
    await interaction.update({ content: "募集はすでに締め切られています。", components: [] });
    return;
  }
  if (recruit.panel_channel_id && recruit.panel_message_id) {
    const pc = (await interaction.client.channels.fetch(recruit.panel_channel_id).catch(() => null)) as TextChannel | null;
    const msg = await pc?.messages.fetch(recruit.panel_message_id).catch(() => null);
    await msg?.edit({ content: "（この募集は取り消されました）", components: [] }).catch(() => undefined);
  }
  await interaction.deferUpdate();
  services.rooms.requestDelete(room.id, "recruit_cancelled", `user:${interaction.user.id}`);
  const channel = (await interaction.guild!.channels.fetch(room.channel_id).catch(() => null)) as VoiceChannel | null;
  if (channel) {
    try {
      await channel.delete("蜜月募集のオーナー取消");
    } catch (error) {
      services.rooms.markDeleteFailed(room.id, error);
      await interaction.editReply({ content: "募集は取り消しましたが、VC削除に失敗しました。次回スキャンで再試行します。", components: [] });
      return;
    }
  }
  services.rooms.markDeletedAndClosed(room.id, "recruit_cancelled", `user:${interaction.user.id}`);
  await interaction.editReply({ content: "✅ 募集を取り消し、部屋を閉じました。自己都合取消のため返金はありません。", components: [] }).catch(() => undefined);
}

async function handleOboroTarget(interaction: UserSelectMenuInteraction, services: Services): Promise<void> {
  const targetId = interaction.values[0];
  if (!targetId || targetId === interaction.user.id) {
    await interaction.update({ content: "相手を正しく選んでください。", components: [] });
    return;
  }
  const guild = interaction.guild!;
  const target = await guild.members.fetch(targetId).catch(() => null);
  if (!target || target.user.bot) {
    await interaction.update({ content: "サーバー内の人間のメンバーだけを招待できます。", components: [] });
    return;
  }
  const requester = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!requester) {
    await interaction.update({ content: "申請者情報を確認できませんでした。", components: [] });
    return;
  }
  const conflict = services.rooms.ownershipConflict(interaction.user.id, "oborozuki");
  if (conflict) {
    await interaction.update({ content: roomAccessConflictMessage(new RoomError("ERR_ALREADY_OWNS", conflict)), components: [] });
    return;
  }
  const price = services.rooms.priceFor("oborozuki");
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`room:oboroinvite:${targetId}:${price}:${Date.now()}`).setLabel("招待を送る").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("room:createcancel").setLabel("やめる").setStyle(ButtonStyle.Secondary),
  );
  await interaction.update({
    content: [`対象者: ${target.displayName}`, `支払額: ${fmtLd(price)}`, balanceLine(services, interaction.user.id, price), "", "承諾前には課金も部屋作成も行いません。"].join("\n"),
    components: [row],
  });
}

async function executeOboroInvite(interaction: ButtonInteraction, services: Services): Promise<void> {
  const [, , targetId, priceStr, createdStr] = interaction.customId.split(":");
  if (Date.now() - Number(createdStr) > paidConfirmTtlMs) {
    await interaction.update({ content: "確認画面の期限が切れました。もう一度操作してください。", components: [] });
    return;
  }
  const guild = interaction.guild!;
  const requester = await guild.members.fetch(interaction.user.id).catch(() => null);
  const target = targetId ? await guild.members.fetch(targetId).catch(() => null) : null;
  if (!requester || !target || target.user.bot || target.id === requester.id) {
    await interaction.update({ content: "招待対象を確認できないため中止しました。課金していません。", components: [] });
    return;
  }
  if (services.rooms.priceFor("oborozuki") !== Number(priceStr)) {
    await interaction.update({ content: "料金設定が確認時から変更されています。課金せず中止しました。もう一度操作してください。", components: [] });
    return;
  }
  const price = Number(priceStr);
  const conflict = services.rooms.ownershipConflict(interaction.user.id, "oborozuki");
  if (conflict) {
    await interaction.update({ content: roomAccessConflictMessage(new RoomError("ERR_ALREADY_OWNS", conflict)), components: [] });
    return;
  }
  const token = randomUUID().replace(/-/g, "");
  let inviteToken: string | undefined;
  try {
    const invite = services.rooms.createOborozukiInvite({ requesterId: requester.id, targetId: target.id, token });
    inviteToken = invite.token;
    const dmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`room:oboroaccept:${invite.token}`).setLabel("承諾する").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`room:oborodecline:${invite.token}`).setLabel("辞退する").setStyle(ButtonStyle.Secondary),
    );
    await target.send({
      content: [`${requester.displayName} さんから朧月への招待が届きました。`, `承諾した場合だけ、申請者に ${fmtLd(price)} が課金され秘密部屋が作成されます。`, `有効期限: <t:${invite.expires_at}:R>`].join("\n"),
      components: [dmRow],
      allowedMentions: { parse: [] },
    });
    await interaction.update({ content: `✅ ${target.displayName} さんへ招待DMを送りました。承諾前には課金も部屋作成も行っていません。`, components: [] });
  } catch (error) {
    console.error("[room] 朧月招待作成/DM失敗", { targetId, error });
    if (inviteToken) {
      try {
        services.rooms.decideOborozukiInvite(inviteToken, target.id, "cancelled");
      } catch {
        // already closed
      }
    }
    await interaction.update({ content: "招待DMを送れなかったため中止しました。課金していません。", components: [] });
  }
}

async function handleOboroDecision(interaction: ButtonInteraction, services: Services, decision: "accept" | "decline"): Promise<void> {
  const token = interaction.customId.split(":")[2];
  if (!token) {
    await interaction.reply({ content: "この招待は見つかりません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const invite = services.rooms.getOborozukiInviteByToken(token);
  if (!invite || invite.target_id !== interaction.user.id) {
    await interaction.reply({ content: "この招待は見つかりません。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (decision === "decline") {
    try {
      services.rooms.decideOborozukiInvite(token, interaction.user.id, "declined");
    } catch {
      // already closed
    }
    await interaction.update({ content: "朧月の招待を辞退しました。課金は発生していません。", components: [] });
    return;
  }
  await interaction.deferUpdate();
  const guildId = services.settings.getString("guild:main");
  const guild = guildId ? await interaction.client.guilds.fetch(guildId).catch(() => null) : interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: "サーバー情報を取得できず、承諾処理を中止しました。課金していません。", components: [] });
    return;
  }
  const requester = await guild.members.fetch(invite.requester_id).catch(() => null);
  const target = await guild.members.fetch(invite.target_id).catch(() => null);
  if (!requester || !target) {
    await interaction.editReply({ content: "申請者または対象者がサーバー内に確認できないため中止しました。課金していません。", components: [] });
    return;
  }
  // DMの承諾から作るので参照できる親カテゴリが無い。設定が唯一の生成先になる
  const channel = await createRoomChannel(guild, services, "oborozuki", requester, [requester.id, target.id], roomCategoryId(services, "oborozuki", null));
  if (!channel) {
    await interaction.editReply({ content: "秘密部屋の作成に失敗しました。課金していません。運営に宿の生成先カテゴリ設定を確認してもらってください。", components: [] });
    return;
  }
  let acceptedRoom: RoomRow | undefined;
  try {
    const accepted = services.rooms.acceptOborozukiInvite({ token, targetId: interaction.user.id, channelId: channel.id });
    acceptedRoom = accepted.room;
    await sendRoomIntro(channel, accepted.room, requester, services);
    await interaction.editReply({ content: `✅ 朧月の招待を承諾しました: ${channel.toString()}`, components: [] });
    await requester.send(`✅ 朧月の招待が承諾され、部屋を作成しました: ${channel.toString()}（−${fmtLd(invite.price)}）`).catch(() => undefined);
  } catch (error) {
    if (acceptedRoom) {
      services.rooms.refundUnusedPaidRoom(acceptedRoom.id);
      const deleted = await cleanupRegisteredRoomChannel(channel, services, acceptedRoom, "panel_post_failed", `user:${requester.id}`, "朧月パネル投稿失敗のためロールバック");
      await interaction.editReply({
        content: deleted
          ? "部屋内パネルの投稿に失敗したため承諾処理を中止し、課金済み分は返金しました。"
          : "部屋内パネルの投稿に失敗したため承諾処理を中止し、課金済み分は返金しました。VC削除は失敗したため次回スキャンで再試行します。",
        components: [],
      });
      return;
    }
    await channel.delete("朧月承諾処理失敗のためロールバック").catch((deleteError) => {
      console.error("[room] 朧月承諾失敗後のVC削除にも失敗しました", { channelId: channel.id, deleteError });
    });
    const msg = error instanceof LedgerError && error.code === "ERR_INSUFFICIENT" ? "申請者の残高が不足しているため成立しませんでした。課金していません。" : error instanceof RoomError && error.code === "ERR_ALREADY_OWNS" ? "申請者の特殊部屋枠が埋まっているため成立しませんでした。課金していません。" : "承諾処理に失敗しました。課金していません。";
    await interaction.editReply({ content: msg, components: [] });
  }
}
