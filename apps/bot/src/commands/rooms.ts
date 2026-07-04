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
} from "discord.js";
import { LedgerError, type RoomKind } from "@meigokujo/core";
import { fmtLd } from "../format.js";
import type { Services } from "../services.js";

const KIND_LABELS: Record<RoomKind, string> = {
  normal: "宿",
  mitsugetsu: "蜜月",
  oborozuki: "朧月",
  game: "ゲーム部屋",
};

export function roomPanelMessage(): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setTitle("🏨 冥獄城 貸間")
    .setDescription(
      [
        "🛏 **宿** — 2人まで無料。3人目から枠+1ごとに 5,000 Ld（部屋の誰でも払えます）",
        "🌸 **蜜月** — 5,000 Ld。異性へ匿名で募集を出し、参加者だけが入れる部屋",
        "🌙 **朧月** — 30,000 Ld。相手を指名する、運営以外に見えない秘密の部屋",
        "🎲 **ゲーム部屋** — 2h 6,000 / 3h 8,000 / 5h 13,000 / 10h 27,000 Ld",
        "",
        "全ての部屋は**全員が退出すると自動で消えます**。",
      ].join("\n"),
    )
    .setColor(0x6b21a8);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("room:new:normal").setLabel("宿").setEmoji("🛏").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("room:new:mitsugetsu").setLabel("蜜月").setEmoji("🌸").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("room:new:oborozuki").setLabel("朧月").setEmoji("🌙").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("room:new:game").setLabel("ゲーム部屋").setEmoji("🎲").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

async function roomCategory(guild: Guild, services: Services, secret: boolean): Promise<CategoryChannel | null> {
  const key = secret ? "category:oborozuki" : "category:rooms";
  const id = services.settings.getString(key);
  if (!id) return null;
  const cat = await guild.channels.fetch(id).catch(() => null);
  return cat?.type === ChannelType.GuildCategory ? (cat as CategoryChannel) : null;
}

/** 部屋VCを作る（可視性に応じた権限オーバーライト付き） */
async function createRoomChannel(
  guild: Guild,
  services: Services,
  kind: RoomKind,
  owner: GuildMember,
  members: string[],
): Promise<VoiceChannel | null> {
  const secret = kind === "oborozuki";
  const category = await roomCategory(guild, services, secret);
  const everyone = guild.roles.everyone.id;
  const adminRoleId = services.settings.getString("role:admin");

  const overwrites: Array<{ id: string; allow?: bigint[]; deny?: bigint[] }> = [];
  if (secret) {
    // 秘匿: everyone は見えない。参加者と高度な管理者のみ
    overwrites.push({ id: everyone, deny: [PermissionFlagsBits.ViewChannel] });
    for (const m of members) {
      overwrites.push({ id: m, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] });
    }
    if (adminRoleId) overwrites.push({ id: adminRoleId, allow: [PermissionFlagsBits.ViewChannel] });
  } else if (kind === "mitsugetsu") {
    // 蜜月: 部屋自体は非表示（募集パネルの参加ボタンで表示権限を付与する）
    overwrites.push({ id: everyone, deny: [PermissionFlagsBits.ViewChannel] });
    overwrites.push({ id: owner.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] });
  }

  const channel = await guild.channels
    .create({
      name: `${KIND_LABELS[kind]}-${owner.displayName}`.slice(0, 90),
      type: ChannelType.GuildVoice,
      parent: category ?? undefined,
      permissionOverwrites: overwrites.length > 0 ? overwrites : undefined,
    })
    .catch((e) => {
      console.error("[room] チャンネル作成失敗:", e);
      return null;
    });
  return channel;
}

// ---- 部屋作成のエントリ ----

const pendingGame = new Map<string, void>(); // 予約不要だが将来用

export async function handleRoomButton(
  interaction: ButtonInteraction | StringSelectMenuInteraction | UserSelectMenuInteraction,
  services: Services,
): Promise<void> {
  const id = interaction.customId;
  void pendingGame;

  if (id.startsWith("room:new:") && interaction.isButton()) {
    const kind = id.split(":")[2] as RoomKind;
    if (kind === "game") {
      const tiers = services.rooms.gameTiers();
      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("room:gametier")
          .setPlaceholder("利用時間を選ぶ")
          .addOptions(tiers.map(([h, price]) => ({ label: `${h}時間 — ${price.toLocaleString()} Ld`, value: String(h) }))),
      );
      await interaction.reply({ content: "🎲 利用時間を選んでください（立てた人が支払います）。", components: [row], flags: MessageFlags.Ephemeral });
      return;
    }
    if (kind === "mitsugetsu") {
      await interaction.showModal(recruitModal());
      return;
    }
    if (kind === "oborozuki") {
      const row = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        new UserSelectMenuBuilder().setCustomId("room:oboro:target").setPlaceholder("招く相手を選ぶ（1人）"),
      );
      await interaction.reply({ content: "🌙 朧月に招く相手を選んでください（30,000 Ld）。", components: [row], flags: MessageFlags.Ephemeral });
      return;
    }
    // normal
    await createAndReply(interaction, services, "normal", [interaction.user.id]);
    return;
  }

  if (id === "room:gametier" && interaction.isStringSelectMenu()) {
    const hours = Number(interaction.values[0]);
    await createAndReply(interaction, services, "game", [interaction.user.id], { hours });
    return;
  }

  if (id === "room:oboro:target" && interaction.isUserSelectMenu()) {
    const targetId = interaction.values[0];
    if (!targetId || targetId === interaction.user.id) {
      await interaction.update({ content: "相手を正しく選んでください。", components: [] });
      return;
    }
    await createAndReply(interaction, services, "oborozuki", [interaction.user.id, targetId]);
    return;
  }

  if (id.startsWith("room:join:") && interaction.isButton()) {
    await handleRecruitJoin(interaction, services);
    return;
  }

  if (id.startsWith("room:slot:") && interaction.isButton()) {
    await handleAddSlot(interaction, services);
    return;
  }

  if (id.startsWith("room:extend:") && interaction.isButton()) {
    const [, , roomIdStr, hoursStr] = id.split(":");
    const roomId = Number(roomIdStr);
    const hours = Number(hoursStr);
    try {
      const room = services.rooms.extendGame(roomId, hours, interaction.user.id);
      await interaction.reply({
        content: `✅ <@${interaction.user.id}> が +${hours}時間 延長しました（新期限 <t:${room.expires_at}:t>）。`,
        allowedMentions: { parse: [] },
      });
    } catch (e) {
      const msg = e instanceof LedgerError && e.code === "ERR_INSUFFICIENT" ? "残高が足りません。" : "延長に失敗しました。";
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    }
    return;
  }
}

async function createAndReply(
  interaction: ButtonInteraction | StringSelectMenuInteraction | UserSelectMenuInteraction,
  services: Services,
  kind: RoomKind,
  members: string[],
  opts: { hours?: number } = {},
): Promise<void> {
  const guild = interaction.guild!;
  const owner = (await guild.members.fetch(interaction.user.id)) as GuildMember;

  // 先に残高チェック（チャンネルを作ってから課金失敗で消す無駄を避ける）
  const price = services.rooms.priceFor(kind, opts.hours);
  if (price > 0 && services.ledger.balanceOf(`user:${owner.id}`) < price) {
    const msg = `残高が足りません（所持: ${fmtLd(services.ledger.balanceOf(`user:${owner.id}`))} / 必要: ${fmtLd(price)}）。`;
    if (interaction.isButton()) await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    else await interaction.update({ content: msg, components: [] });
    return;
  }

  const channel = await createRoomChannel(guild, services, kind, owner, members);
  if (!channel) {
    const msg = "部屋の作成に失敗しました。運営にカテゴリ設定（/設定 チャンネル）を確認してもらってください。";
    if (interaction.isButton()) await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    else await interaction.update({ content: msg, components: [] });
    return;
  }

  let room;
  try {
    room = services.rooms.register({ kind, channelId: channel.id, ownerId: owner.id, hours: opts.hours });
  } catch (e) {
    await channel.delete().catch(() => undefined); // 課金失敗 → 片付け
    const msg = e instanceof LedgerError ? "課金に失敗しました（残高をご確認ください）。" : "登録に失敗しました。";
    if (interaction.isButton()) await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    else await interaction.update({ content: msg, components: [] });
    return;
  }

  // 部屋内に操作パネル（宿は枠追加、ゲームは延長案内）
  const controls: ButtonBuilder[] = [];
  if (kind === "normal") {
    controls.push(new ButtonBuilder().setCustomId(`room:slot:${room.id}`).setLabel("人数枠+1（5,000 Ld）").setStyle(ButtonStyle.Secondary));
  }
  const expiryNote = room.expires_at ? `\n利用期限: <t:${room.expires_at}:t>（10分前に延長案内）` : "";
  await channel.send({
    content: `${KIND_LABELS[kind]}を開きました（オーナー: <@${owner.id}>）。全員が退出すると自動で消えます。${expiryNote}`,
    components: controls.length > 0 ? [new ActionRowBuilder<ButtonBuilder>().addComponents(...controls)] : [],
  });

  const done = `✅ ${KIND_LABELS[kind]}を作成しました: ${channel.toString()}${price > 0 ? `（−${fmtLd(price)}）` : ""}`;
  if (interaction.isButton()) await interaction.reply({ content: done, flags: MessageFlags.Ephemeral });
  else await interaction.update({ content: done, components: [] });
}

async function handleAddSlot(interaction: ButtonInteraction, services: Services): Promise<void> {
  const roomId = Number(interaction.customId.split(":")[2]);
  try {
    const room = services.rooms.addSlot(roomId, interaction.user.id);
    await interaction.reply({ content: `✅ <@${interaction.user.id}> が枠を追加しました（定員 ${room.capacity}人）。`, allowedMentions: { parse: [] } });
  } catch (e) {
    const msg = e instanceof LedgerError && e.code === "ERR_INSUFFICIENT" ? "残高が足りません。" : "枠の追加に失敗しました。";
    await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
  }
}

// ---- 蜜月の匿名募集 ----

function recruitModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("room:recruit")
    .setTitle("蜜月の募集（5,000 Ld）")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("gender").setLabel("募集する性別（男 / 女）").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(2),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("purpose").setLabel("目的（例: 寝落ち・作業・雑談）").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("message").setLabel("ひとこと（任意）").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(200),
      ),
    );
}

export async function handleRecruitModal(interaction: ModalSubmitInteraction, services: Services): Promise<void> {
  const genderRaw = interaction.fields.getTextInputValue("gender").trim();
  const gender = genderRaw.startsWith("男") ? "male" : genderRaw.startsWith("女") ? "female" : null;
  if (!gender) {
    await interaction.reply({ content: "性別は「男」または「女」で入力してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  const purpose = interaction.fields.getTextInputValue("purpose").trim();
  const message = interaction.fields.getTextInputValue("message").trim() || undefined;

  const guild = interaction.guild!;
  const owner = (await guild.members.fetch(interaction.user.id)) as GuildMember;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (services.ledger.balanceOf(`user:${owner.id}`) < services.rooms.priceFor("mitsugetsu")) {
    await interaction.editReply({ content: "残高が足りません（5,000 Ld）。" });
    return;
  }

  const channel = await createRoomChannel(guild, services, "mitsugetsu", owner, [owner.id]);
  if (!channel) {
    await interaction.editReply({ content: "部屋の作成に失敗しました。" });
    return;
  }
  let room;
  try {
    room = services.rooms.register({ kind: "mitsugetsu", channelId: channel.id, ownerId: owner.id });
  } catch {
    await channel.delete().catch(() => undefined);
    await interaction.editReply({ content: "課金に失敗しました。" });
    return;
  }
  const recruit = services.rooms.createRecruit({ roomId: room.id, ownerId: owner.id, targetGender: gender, purpose, message });

  // 対象性別ロールに匿名募集パネルを投稿
  const genderRoleId = services.settings.getString(gender === "male" ? "role:male" : "role:female");
  const panelChannelId = services.settings.getString("channel:recruit") ?? interaction.channelId ?? undefined;
  const panelChannel = panelChannelId
    ? ((await guild.client.channels.fetch(panelChannelId).catch(() => null)) as TextChannel | null)
    : null;
  if (panelChannel?.isTextBased()) {
    const embed = new EmbedBuilder()
      .setTitle("❓ 匿名募集が届きました")
      .addFields(
        { name: "🏷 対象", value: genderRoleId ? `<@&${genderRoleId}>` : gender === "male" ? "男性" : "女性", inline: true },
        { name: "👥 定員", value: "2名（残り1名）", inline: true },
        { name: "🎯 目的", value: purpose },
        ...(message ? [{ name: "💬 メッセージ", value: message }] : []),
      )
      .setFooter({ text: "参加ボタンを押すとチャンネルが表示されます" })
      .setColor(0xdb2777);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`room:join:${recruit.id}`).setLabel("このVCに参加する").setEmoji("🚪").setStyle(ButtonStyle.Success),
    );
    const sent = await panelChannel.send({
      content: genderRoleId ? `<@&${genderRoleId}>` : undefined,
      embeds: [embed],
      components: [row],
      allowedMentions: { roles: genderRoleId ? [genderRoleId] : [] },
    });
    services.rooms.setRecruitPanel(recruit.id, sent.channelId, sent.id);
  }

  await interaction.editReply({ content: `✅ 蜜月の募集を出しました（−${fmtLd(services.rooms.priceFor("mitsugetsu"))}）。応募がないまま5時間で失効すると半額returnされます。` });
}

async function handleRecruitJoin(interaction: ButtonInteraction, services: Services): Promise<void> {
  const recruitId = Number(interaction.customId.split(":")[2]);
  const recruit = services.rooms.getRecruit(recruitId);
  if (recruit.status !== "open") {
    await interaction.reply({ content: "この募集はすでに締め切られています。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.user.id === recruit.owner_id) {
    await interaction.reply({ content: "自分の募集には参加できません。", flags: MessageFlags.Ephemeral });
    return;
  }
  // 性別条件チェック
  const member = interaction.member as GuildMember;
  const wantRoleId = services.settings.getString(recruit.target_gender === "male" ? "role:male" : "role:female");
  if (wantRoleId && !member.roles.cache.has(wantRoleId)) {
    await interaction.reply({ content: "この募集の対象ではありません。", flags: MessageFlags.Ephemeral });
    return;
  }

  const room = services.rooms.get(recruit.room_id);
  const channel = (await interaction.guild!.channels.fetch(room.channel_id).catch(() => null)) as VoiceChannel | null;
  if (!channel) {
    await interaction.reply({ content: "部屋が見つかりませんでした（すでに閉じられた可能性があります）。", flags: MessageFlags.Ephemeral });
    return;
  }
  await channel.permissionOverwrites.create(interaction.user.id, { ViewChannel: true, Connect: true });
  services.rooms.matchRecruit(recruitId, interaction.user.id);

  // パネルを締切表示に更新
  if (recruit.panel_message_id && recruit.panel_channel_id) {
    const pc = (await interaction.client.channels.fetch(recruit.panel_channel_id).catch(() => null)) as TextChannel | null;
    const msg = await pc?.messages.fetch(recruit.panel_message_id).catch(() => null);
    await msg?.edit({ content: "（この募集は締め切られました）", embeds: msg.embeds, components: [] }).catch(() => undefined);
  }
  await interaction.reply({ content: `✅ 参加しました: ${channel.toString()}`, flags: MessageFlags.Ephemeral });
}
