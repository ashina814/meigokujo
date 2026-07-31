import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  UserSelectMenuBuilder,
  UserSelectMenuInteraction,
  type Guild,
  type GuildMember,
  type MessageCreateOptions,
  type TextChannel,
  type VoiceState,
} from "discord.js";
import { fmtLd } from "../format.js";
import { deliverToUser } from "../notify.js";
import { isAdmin } from "../permissions.js";
import { jstNow, nextSessionStart } from "../scheduler.js";
import type { Services } from "../services.js";

// ---- パネル ----

/**
 * 入城案内の常設パネル（正本）。
 *
 * 設置後は再編集されない静的メッセージなので、**具体的な日時を書かない**。
 * 「次は何時か」は押した時点で計算する `いまの自分の状態を見る` が返す。
 * 招待経路の登録ボタンは置かない（新規に操作を要求しない・門番が `/審判 招待` で拾う）。
 */
export function entryPanelMessage(services: Services): MessageCreateOptions {
  const vcIds = sessionVcIds(services);
  const embed = new EmbedBuilder()
    .setTitle("🚪 冥獄城 入城案内")
    .setColor(0x6b21a8)
    .setDescription("城に入るには、説明会に来ていただくだけです。事前の登録や申請はいりません。")
    .addFields(
      {
        name: "📅 説明会",
        value: ["**月・木を除く 21時 / 22時 / 23時**", "開始 **5分前** にこのチャンネルでお知らせします。"].join("\n"),
        inline: true,
      },
      {
        name: "📍 集合場所",
        value: vcIds.length > 0 ? vcIds.map((id) => `<#${id}>`).join("\n") : "説明会場VC",
        inline: true,
      },
      {
        name: "🎯 やること",
        value: ["**1.** 時間になったら説明会場VCに入る", "**2.** 門番の案内を待つ（10分ほどで終わります）"].join("\n"),
      },
      {
        name: "⏰ その時間に来られない",
        value: "下の「時間外・個別希望」から、都合のいい時間で個別に調整できます。",
      },
    )
    .setFooter({ text: "次の説明会が何時かは「いまの自分の状態を見る」で確認できます" });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("entry:status").setLabel("いまの自分の状態を見る").setEmoji("🕯️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("entry:flex").setLabel("時間外・個別希望").setEmoji("⏰").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

/**
 * @deprecated 入城案内パネルへ統合済み。新規設置はできない（`/パネル設置` の選択肢から外した）。
 * 既に設置してあるパネルを撤去するまでの間、押しても動くように残してある。
 */
export function entryFlexPanelMessage(): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setTitle("⏰ 時間外・個別希望 受付")
    .setColor(0xdb2777)
    .setDescription(
      [
        "**月・木を除く 21/22/23時** の説明会に来られない方は、こちらから個別希望を出せます。",
        "ボタンを押すと、あなたとスタッフだけの非公開スレッドが開きます。都合のいい時間帯を書いてください。",
      ].join("\n"),
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("entry:flex").setLabel("時間外・個別希望を出す").setEmoji("⏰").setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

function sessionVcIds(services: Services): string[] {
  return [services.settings.getString("channel:session_vc"), services.settings.getString("channel:session_vc2")].filter(
    (v): v is string => !!v,
  );
}

export async function handleEntryButton(
  interaction: ButtonInteraction | UserSelectMenuInteraction,
  services: Services,
): Promise<void> {
  const id = interaction.customId;
  const userId = interaction.user.id;

  if (id === "entry:status" && interaction.isButton()) {
    await interaction.reply({ ...entryStatusMessage(services, userId), flags: MessageFlags.Ephemeral });
    return;
  }

  if (id === "entry:flex" && interaction.isButton()) {
    await openFlexTicket(interaction, services, userId);
    return;
  }

  // 旧パネル（招待経路を本人に登録させる導線）の互換。撤去前のパネルが残っていても
  // 迷子にしない。本人からの招待経路の登録は受け付けない方針になった。
  if (id === "entry:book" || id === "entry:invsel" || id.startsWith("entry:inv:")) {
    await interaction.reply({
      content: [
        "この操作は不要になりました。**招待経路の登録は要りません**（分かる場合は門番が記録します）。",
        "時間になったら **説明会場VC** に入ってお待ちください。",
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (id.startsWith("entry:judgehold") && interaction.isUserSelectMenu()) {
    await handleJudgeSelect(interaction, services);
    return;
  }

  if (id.startsWith("entry:pass") && interaction.isButton()) {
    await handlePassButton(interaction, services);
  }
}

/**
 * `いまの自分の状態を見る`（エフェメラル）。
 * パネルが静的な代わりに、動的な情報（次の実時刻・自分の状態）はここが返す。
 * 招待者の名前は出さない（記録の有無だけ）。
 */
export function entryStatusMessage(services: Services, userId: string): MessageCreateOptions {
  const soul = services.entry.getSoul(userId);
  const next = nextSessionStart();
  const nextTs = next ? Math.floor(next.getTime() / 1000) : null;
  const vcIds = sessionVcIds(services);

  const embed = new EmbedBuilder().setTitle("🕯️ いまのあなたの状態").setColor(0x6b21a8);

  if (soul && soul.status !== "waiting") {
    embed.setDescription(
      soul.status === "departed"
        ? "城の記録では退城扱いになっています。門番にお声がけください。"
        : "**入城済み**です。説明会に来ていただく必要はありません。",
    );
    return { embeds: [embed] };
  }

  // 招待経路はここに出さない。本人に操作を要求しない方針なら、記録の有無を見せる
  // 必要もない。「未記録」の表示があるだけで「未完了の項目がある」「当日説明しな
  // ければならない」という圧になる。招待経路は完全に裏側の情報として、判定画面・
  // 入退室ログ・待ち人ボードだけで扱う。
  embed
    .setDescription("**案内待ち**です。次の説明会で説明会場VCに来ていただければ入城できます。")
    .addFields(
      {
        name: "📅 次の説明会",
        value: nextTs ? `<t:${nextTs}:F>\n<t:${nextTs}:R>` : "月・木を除く 21 / 22 / 23 時",
        inline: true,
      },
      {
        name: "📍 集合場所",
        value: vcIds.length > 0 ? vcIds.map((id) => `<#${id}>`).join("\n") : "説明会場VC",
        inline: true,
      },
    )
    .setFooter({ text: "その時間に来られない場合はパネルの「時間外・個別希望」からどうぞ" });
  return { embeds: [embed] };
}

// ---- 参加時の自動処理 ----

/**
 * 参加時の処理。**公開チャンネルには何も投稿しない**（設計案 確定事項1）。
 *
 * 案内待ちの段階では一般住民から新規が見えないので、公開投稿に「住民が歓迎する」
 * 効果が無い。参加のたびに長文が並ぶ副作用だけが残るため、本人へのDMに寄せる。
 * DMが届かなかった時だけ、入城案内chへ1行のフォールバックを出す。
 */
export async function handleMemberJoin(
  member: GuildMember,
  services: Services,
  inviterId?: string | null,
): Promise<void> {
  if (member.user.bot) return;
  services.entry.recordJoin(member.id);

  const waitRoleId = services.settings.getString("role:queue_wait");
  if (waitRoleId)
    await member.roles
      .add(waitRoleId)
      .catch((e) => console.warn(`[entry] 入城待ちロール付与に失敗（ボットのロールを階級より上へ）: ${(e as Error).message}`));

  // 招待リンクから招待者を自動検出 → 検出として保存するだけ。実績の確定は亡霊化の時。
  if (inviterId && inviterId !== member.id) {
    services.entry.recordInviterHint(
      member.id,
      { userId: inviterId, source: "user" },
      "auto",
      "system:invite-tracker",
    );
    console.log(`[invite] 自動検出: ${member.id} は ${inviterId} の招待リンクで入城`);
  }

  const result = await deliverToUser(member.client, services, member.id, {
    dm: { embeds: [buildWelcomeEmbed(member, services)] },
    fallback: {
      channelKey: "channel:entry_guide",
      content: "案内をDMへ送れなかったため、上部の常設パネルを確認してください。",
    },
  });
  services.events.log("entry_guide_sent", { target: member.id, payload: { via: result.via } });
  if (!result.delivered) {
    console.warn(`[entry] 入城案内が届きませんでした（DM拒否＋フォールバック不可）: ${member.id}`);
  }
}

/**
 * 参加者本人へ送るDM。
 * 「いつ・どこへ・何をする」の3点だけ。招待者の名前は載せない。
 *
 * 招待経路の登録は新規に要求しない。検出できたものは黙って記録し、抜けたぶんは
 * 門番が当日 `/審判 招待` で拾う。ここで手順を1つ増やすほうが損が大きい。
 */
function buildWelcomeEmbed(member: GuildMember, services: Services): EmbedBuilder {
  const next = nextSessionStart();
  const nextTs = next ? Math.floor(next.getTime() / 1000) : null;
  const guildId = member.guild.id;
  const vcIds = sessionVcIds(services);
  // DM にはサーバーの文脈が無く <#id> が「#unknown」になることがあるので、
  // 名前を添えたチャンネルリンクで出す。
  const vcLinks = vcIds
    .map((id) => {
      const ch = member.guild.channels.cache.get(id);
      return `[${ch?.name ?? "説明会場VC"}](https://discord.com/channels/${guildId}/${id})`;
    })
    .join("\n");

  const steps = ["時間になったら説明会場VCに入る", "門番の案内を待つ（10分ほどで終わります）"]
    .map((s, i) => `**${i + 1}.** ${s}`)
    .join("\n");

  const embed = new EmbedBuilder()
    .setAuthor({ name: "冥獄城 入城案内" })
    .setTitle("ようこそ、冥獄城へ")
    .setColor(0x6b21a8)
    .setThumbnail(member.displayAvatarURL({ size: 128 }))
    .setDescription("城に入るには、説明会に来ていただくだけです。事前の登録や申請はいりません。")
    .addFields(
      {
        name: "🕯️ 次の案内",
        value: nextTs ? `<t:${nextTs}:F>\n<t:${nextTs}:R>` : "月・木を除く 21 / 22 / 23 時",
        inline: true,
      },
      { name: "📍 集合場所", value: vcLinks || "説明会場VC", inline: true },
      { name: "🎯 やること", value: steps, inline: false },
    )
    .setFooter({ text: "この案内は入城案内チャンネルのパネルからいつでも確認できます" });

  const guideId = services.settings.getString("channel:entry_guide");
  if (guideId) {
    embed.addFields({
      name: "📌 案内パネル",
      value: `[入城案内チャンネルを開く](https://discord.com/channels/${guildId}/${guideId})\n次の説明会の時刻も、そこの「いまの自分の状態を見る」で確認できます。`,
      inline: false,
    });
  }

  // 次の会まで半日以上空く（月木に参加した場合など）なら、待たせきりにせず個別調整へ逃がす
  if (next && next.getTime() - Date.now() > 12 * 3_600_000) {
    embed.addFields({
      name: "⏰ その時間に来られない",
      value: "案内パネルの「時間外・個別希望」から、都合のいい時間で個別に調整できます。",
      inline: false,
    });
  }
  return embed;
}

// ---- ロール変更検知: 亡霊ロールが手動付与された時にghostify・性別ロール後付けで招待延長 ----

export async function handleMemberRoleUpdate(
  oldMember: GuildMember,
  newMember: GuildMember,
  services: Services,
): Promise<void> {
  if (newMember.user.bot) return;
  const before = oldMember.roles.cache;
  const after = newMember.roles.cache;
  const added = after.filter((r) => !before.has(r.id));
  const removed = before.filter((r) => !after.has(r.id));

  const ghostRoleId = services.settings.getString("role:ghost");
  const maleRoleId = services.settings.getString("role:male");
  const femaleRoleId = services.settings.getString("role:female");
  const majinRoleId = services.settings.getString("role:majin");
  const mazokuRoleId = services.settings.getString("role:mazoku");
  const meireiRoleId = services.settings.getString("role:meirei");
  const waitRoleId = services.settings.getString("role:queue_wait");

  // ① 亡霊ロールが手動付与された → ghostify（冪等）
  if (added.size > 0 && ghostRoleId && added.has(ghostRoleId)) {
    const soul = services.entry.getSoul(newMember.id);
    if (!soul || soul.status !== "ghost") {
      const r = await ghostifyOne(newMember.guild, services, newMember.id, "system:role-add");
      if (r.ok) console.log(`[entry] 亡霊ロール手動付与検知 → ghostify: ${newMember.id}`);
    }
  }

  // ② 性別ロールが後付けされた → 招待延長を後追い適用
  if (added.size > 0 && maleRoleId && added.has(maleRoleId)) {
    const ext = services.entry.applyInviteeGenderExtension(newMember.id, "male");
    if (ext > 0) console.log(`[entry] 後追い招待延長(男): +${ext}日 for ${newMember.id}`);
  }
  if (added.size > 0 && femaleRoleId && added.has(femaleRoleId)) {
    const ext = services.entry.applyInviteeGenderExtension(newMember.id, "female");
    if (ext > 0) console.log(`[entry] 後追い招待延長(女): +${ext}日 for ${newMember.id}`);
  }

  // ③ 亡霊ロールが剥奪された（他の階級ロールが同時に付いていない）→ 案内待ちにリセット
  if (removed.size > 0 && ghostRoleId && removed.has(ghostRoleId)) {
    const hasOther =
      (majinRoleId && after.has(majinRoleId)) ||
      (mazokuRoleId && after.has(mazokuRoleId)) ||
      (meireiRoleId && after.has(meireiRoleId));
    if (!hasOther) {
      // 台帳側で既に階級が変わっているなら、ロール反映の途中で新ロールがまだ付いていない
      // 状態のイベントを見ているだけ。案内待ちへ戻すとDB status を上書きし queue_wait を
      // 付けてしまうので、ここでは何もしない（迷霊落ち・魔人昇格レースへの防護線）。
      const soul = services.entry.getSoul(newMember.id);
      if (soul && soul.status !== "ghost" && soul.status !== "waiting") {
        console.log(`[entry] 亡霊ロール剥奪検知したが台帳は既に ${soul.status}。リセットせず（レース対策）: ${newMember.id}`);
        return;
      }
      services.entry.resetToWaiting(newMember.id, "system:role-remove");
      if (waitRoleId) await newMember.roles.add(waitRoleId).catch(() => undefined);
      console.log(`[entry] 亡霊ロール剥奪 → 案内待ちにリセット: ${newMember.id}`);
    }
  }
}

// ---- 出席の自動記録（voiceState）----

/**
 * @deprecated 予約制の名残。新しい導線は予約行を作らないので、新規参加者には効かない。
 * 判定は VC 在室者を直接見る（presentWaiters）。過去の予約行のために残してある。
 */
export function handleVoiceAttendance(
  _old: VoiceState,
  next: VoiceState,
  services: Services,
): void {
  if (!next.channelId || next.member?.user.bot) return;
  const sessionVcIds = [
    services.settings.getString("channel:session_vc"),
    services.settings.getString("channel:session_vc2"),
  ].filter((v): v is string => !!v);
  if (!sessionVcIds.includes(next.channelId)) return;

  const booking = services.entry.getBooking(next.id);
  if (!booking || booking.status !== "booked") return;

  // 現在時刻が予約枠のウィンドウ（開始5分前〜+60分）に入っているか
  const nowJst = jstNow();
  const candidates = new Set<string>([`${nowJst.dateStr} ${nowJst.hour}`]);
  if (nowJst.minute <= 5) {
    const prev = jstNow(new Date(Date.now() - 3_600_000));
    candidates.add(`${prev.dateStr} ${prev.hour}`);
  }
  if (nowJst.minute >= 55) {
    const nextH = jstNow(new Date(Date.now() + 3_600_000));
    candidates.add(`${nextH.dateStr} ${nextH.hour}`);
  }
  if (candidates.has(booking.slot)) {
    if (services.entry.markAttended(next.id)) {
      console.log(`[entry] 出席記録: ${next.id} (${booking.slot})`);
    }
  }
}

// ---- 判定（/審判）----

export const sessionCommand = new SlashCommandBuilder()
  .setName("審判")
  .setDescription("説明会の判定と昇格（面接担当・魔剣士・審・運営）")
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub.setName("判定").setDescription("いま説明会VCにいる案内待ちの人を確認して一括で亡霊にする"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("昇格")
      .setDescription("面談合格者を魔人に昇格させる（審・運営）")
      .addUserOption((o) => o.setName("対象").setDescription("昇格させる亡霊").setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("招待")
      .setDescription("招待経路を門番が代わりに登録する（判定の前でも後でも可）")
      .addUserOption((o) => o.setName("対象").setDescription("招待されて来た人").setRequired(true))
      .addUserOption((o) => o.setName("招待者").setDescription("招待した人（城の住人）"))
      .addStringOption((o) =>
        o
          .setName("経路")
          .setDescription("人以外の経路")
          .addChoices(
            { name: "ディスボード", value: "disboard" },
            { name: "ルミナ", value: "lumina" },
            { name: "その他（誰の招待でもない）", value: "none" },
          ),
      ),
  );

/** 審判を使えるのは 運営 / 面接担当 / 魔剣士 / 審 のいずれか */
const JUDGE_ROLE_KINDS = ["judge", "judge_lead", "judge_extra"] as const;
function isJudge(
  interaction: ChatInputCommandInteraction | ButtonInteraction | UserSelectMenuInteraction,
  services: Services,
): boolean {
  if (isAdmin(interaction, services)) return true;
  const member = interaction.member as GuildMember | null;
  if (!member) return false;
  return JUDGE_ROLE_KINDS.some((kind) => {
    const rid = services.settings.getString(`role:${kind}`);
    return rid ? member.roles.cache.has(rid) : false;
  });
}

/**
 * いま説明会VC(1・2)にいる「案内待ち」のメンバーIDを集める。
 * ロール優先: 案内待ちロール保持者は対象。魂がghost等でズレていた場合は自動修復する。
 * ロール無しでも魂が waiting なら対象（ロール付与失敗の救済）。
 * 案内待ちロール保持でも高階級ロール(魔族/魔人/迷霊)がある場合は対象外（誤操作防止）。
 */
async function presentWaiters(guild: Guild, services: Services): Promise<string[]> {
  const vcIds = [
    services.settings.getString("channel:session_vc"),
    services.settings.getString("channel:session_vc2"),
  ].filter((v): v is string => !!v);
  const waitRoleId = services.settings.getString("role:queue_wait");
  const ghostRoleId = services.settings.getString("role:ghost");
  const majinRoleId = services.settings.getString("role:majin");
  const mazokuRoleId = services.settings.getString("role:mazoku");
  const meireiRoleId = services.settings.getString("role:meirei");
  const ids = new Set<string>();
  for (const vcId of vcIds) {
    const ch = await guild.channels.fetch(vcId).catch(() => null);
    if (!ch || !ch.isVoiceBased()) continue;
    for (const [, m] of ch.members) {
      if (m.user.bot) continue;
      const roles = m.roles.cache;
      const hasWait = !!(waitRoleId && roles.has(waitRoleId));
      const hasGhost = !!(ghostRoleId && roles.has(ghostRoleId));
      const hasHigher =
        (majinRoleId && roles.has(majinRoleId)) ||
        (mazokuRoleId && roles.has(mazokuRoleId)) ||
        (meireiRoleId && roles.has(meireiRoleId));
      if (hasHigher || hasGhost) continue; // 亡霊以上は判定対象外
      const soul = services.entry.getSoul(m.id);
      if (hasWait) {
        // 案内待ちロール保持者は対象。魂とのズレを見つけたら修復
        if (soul && soul.status !== "waiting") {
          services.entry.resetToWaiting(m.id, "system:role-sync");
          console.log(`[entry] 魂のズレを修復: ${m.id} (${soul.status} → waiting、案内待ちロール保持のため)`);
        }
        ids.add(m.id);
        continue;
      }
      // ロール無しでも魂が waiting なら救済
      if (soul?.status === "waiting") ids.add(m.id);
    }
  }
  return [...ids];
}

export async function handleSessionCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  if (!isJudge(interaction, services)) {
    await interaction.reply({ content: "この操作には門番（運営・門番・門番統括）の権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.options.getSubcommand() === "招待") {
    await handleInviterRecord(interaction, services);
    return;
  }
  // 判定のみ（昇格は index 側で handlePromote に振り分け）
  const guild = interaction.guild!;
  const vc1 = services.settings.getString("channel:session_vc");
  const vc2 = services.settings.getString("channel:session_vc2");
  if (!vc1 && !vc2) {
    await interaction.reply({
      content: "説明会場VCが未設定です。`/設定 チャンネル 種別:説明会場VC` で登録してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const present = await presentWaiters(guild, services);
  if (present.length === 0) {
    const vcMentions = [vc1, vc2].filter(Boolean).map((id) => `<#${id}>`).join(" / ");
    await interaction.reply({
      content: [
        `いま ${vcMentions} に「案内待ち」の人がいません。`,
        "（対象は **入城案内待ちロール保持者** か **魂の状態が waiting** の人だけ。既に亡霊/魔人などになっている人は対象外です）",
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  // 招待経路の未検出は「警告」であって判定の条件ではない。
  // 以前はここで未登録者を判定対象から外していたが、本人にボタンを押させる導線が
  // 詰まりの主因になっていたため、全員を判定対象にして未検出は表示だけ残す。
  // 経路が要る場合は門番が `/審判 招待` で後から入れられる（亡霊化後でも記帳できる）。
  //
  // 検出・補足が1件でもあれば「確認済み」。`none`（誰の招待でもない）も門番が確認した
  // 結果なので未検出には数えない。
  const missing = present.filter((uid) => !services.entry.getInviterHint(uid));
  judgeState.set(interaction.user.id, { present, missing, hold: new Set() });
  await interaction.reply({ ...renderJudgment(services, interaction.user.id), flags: MessageFlags.Ephemeral });
}

/**
 * `/審判 招待` — 門番が招待経路を代わりに登録する。
 * 本人にボタンを押させる代わりに、抜けたぶんは門番がここで拾う。
 * 亡霊化の後でも記帳できる（招待者への期限延長・称号評価もここで走る）。
 */
async function handleInviterRecord(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  const target = interaction.options.getUser("対象", true);
  const inviter = interaction.options.getUser("招待者");
  const source = interaction.options.getString("経路") as "disboard" | "lumina" | "none" | null;

  if (!inviter && !source) {
    await interaction.reply({
      content: "「招待者」か「経路」のどちらかを指定してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (inviter && inviter.id === target.id) {
    await interaction.reply({ content: "自分自身は招待者にできません。", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // 期限延長の日数は被招待者の性別ロールで決まる（男+1日 / 女+2日）
  const member = await interaction.guild?.members.fetch(target.id).catch(() => null);
  const maleRoleId = services.settings.getString("role:male");
  const femaleRoleId = services.settings.getString("role:female");
  const gender =
    member && maleRoleId && member.roles.cache.has(maleRoleId)
      ? ("male" as const)
      : member && femaleRoleId && member.roles.cache.has(femaleRoleId)
        ? ("female" as const)
        : null;

  const result = services.entry.recordInviterByStaff(
    target.id,
    inviter ? { userId: inviter.id, source: "user" } : { source: source! },
    `user:${interaction.user.id}`,
    gender,
  );

  // 既に確定済みなら何も書き換えていない。付け替えは取り消し設計とセットの別操作にする
  if (result.reason === "already") {
    await interaction.editReply({
      content: [
        `ℹ️ <@${target.id}> の招待実績は既に確定済みです（招待者: <@${result.existingInviterId}>）。`,
        "二重加算を防ぐため、**何も書き換えていません**。",
        "誤りの訂正が必要な場合は運営へ連絡してください（延長・称号の取り消しを伴うため、この操作では変更できません）。",
      ].join("\n"),
      allowedMentions: { parse: [] },
    });
    return;
  }

  const lines: string[] = [
    `✅ <@${target.id}> の招待経路を記録しました（${inviter ? `招待者 <@${inviter.id}>` : sourceLabel(source!)}）。`,
  ];
  if (result.pending) {
    // まだ説明会を受けていない。実績は本人が入城した時に確定する
    lines.push(
      "⏳ この人はまだ入城前なので、**招待実績はまだ確定していません**。",
      "説明会を受けて亡霊になった時点で、実績・期限延長・称号がまとめて反映されます。",
    );
  } else if (result.credited) {
    lines.push(
      result.extendedDays > 0
        ? `🕯️ 招待者の評価期限を **+${result.extendedDays}日** 延長しました。`
        : "🕯️ 期限延長はなし（招待者が評価期間中でない、または上限に到達）。",
    );
    if (!gender) lines.push("※ 対象に性別ロールが無いため延長は保留です。後で付けば自動で反映されます。");
    // 招待実績で称号の条件を満たしたかを見る
    if (inviter) {
      const granted = services.titles.evaluate(inviter.id);
      if (granted.length > 0) lines.push(`🎉 招待者が称号を獲得: ${granted.map((t) => `${t.emoji} ${t.name}`).join(" / ")}`);
    }
  }
  await interaction.editReply({ content: lines.join("\n"), allowedMentions: { parse: [] } });
}

function sourceLabel(source: "disboard" | "lumina" | "none"): string {
  return source === "disboard" ? "ディスボード" : source === "lumina" ? "ルミナ" : "誰の招待でもない";
}

// ---- 判定UI: 保留/合格/招待未検出の警告 ----

interface JudgeSel {
  present: string[]; // 今VCにいる案内待ち＝判定対象（招待経路の有無は問わない）
  missing: string[]; // うち招待経路が未検出の人。警告表示のみで、判定は妨げない
  hold: Set<string>; // 保留＝今回は通さない（案内待ちのまま。次回の判定で再度出る）
}
const judgeState = new Map<string, JudgeSel>(); // key = 判定者のユーザーID

/** 判定メッセージ（今VCにいる案内待ち + 保留の選択UI）を組み立てる */
function renderJudgment(_services: Services, judgeId: string) {
  const st = judgeState.get(judgeId) ?? ({ present: [], missing: [], hold: new Set<string>() } as JudgeSel);
  const toGhost = st.present.filter((id) => !st.hold.has(id));

  const line = (ids: string[]) => (ids.length > 0 ? ids.map((id) => `・<@${id}>`).join("\n") : "（なし）");
  const embed = new EmbedBuilder()
    .setTitle("⚖️ 説明会の判定（今VCにいる案内待ち）")
    .setColor(0x6b21a8)
    .setDescription(
      [
        `**合格→亡霊にする ${toGhost.length}名**:`,
        line(toGhost),
        "",
        st.hold.size > 0 ? `⏸ **保留 ${st.hold.size}名**（今回は通さない・案内待ちのまま）:\n${line([...st.hold])}\n` : "",
        st.missing.length > 0
          ? `⚠️ **招待経路 未検出 ${st.missing.length}名**（判定は通せます。必要なら \`/審判 招待\` で後から登録）:\n${line(st.missing)}\n`
          : "",
      ]
        .filter((s) => s !== "")
        .join("\n"),
    );

  const max = Math.min(25, Math.max(1, st.present.length));
  const rows: ActionRowBuilder<UserSelectMenuBuilder | ButtonBuilder>[] = [];
  if (st.present.length > 0) {
    rows.push(
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        new UserSelectMenuBuilder().setCustomId("entry:judgehold").setPlaceholder("⏸ 保留にする人（今回通さない）").setMinValues(0).setMaxValues(max),
      ),
    );
  }
  const bottom = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("entry:pass").setLabel(`${toGhost.length}名を合格（亡霊化）`).setStyle(ButtonStyle.Success).setDisabled(toGhost.length === 0),
  );
  rows.push(bottom);
  return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

/** 保留の選択を反映してメッセージを更新 */
async function handleJudgeSelect(interaction: UserSelectMenuInteraction, services: Services): Promise<void> {
  if (!isJudge(interaction, services)) {
    await interaction.reply({ content: "この操作には門番の権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const sel = judgeState.get(interaction.user.id);
  if (!sel) {
    await interaction.update({ content: "⌛ この判定は期限切れです。`/審判 判定` からやり直してください。", components: [], embeds: [] });
    return;
  }
  sel.hold = new Set(interaction.values);
  judgeState.set(interaction.user.id, sel);
  await interaction.update(renderJudgment(services, interaction.user.id));
}

async function handlePassButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  if (!isJudge(interaction, services)) {
    await interaction.reply({ content: "この操作には門番の権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const actor = `user:${interaction.user.id}`;
  const sel = judgeState.get(interaction.user.id);
  if (!sel) {
    await interaction.update({ content: "⌛ この判定は期限切れです。`/審判 判定` からやり直してください。", components: [], embeds: [] });
    return;
  }
  await interaction.update({ content: "⏳ 判定を実行中…", embeds: [], components: [] });

  const guild = interaction.guild!;
  const toGhost = sel.present.filter((id) => !sel.hold.has(id));

  const passed: string[] = [];
  const failed: string[] = [];
  const roleFailed: string[] = []; // DBは亡霊化したがロール変更に失敗＝手動対応が必要
  let totalGranted = 0;
  for (const id of toGhost) {
    const r = await ghostifyOne(guild, services, id, actor);
    if (r.ok) {
      totalGranted += r.granted;
      passed.push(id);
      if (!r.roleOk) roleFailed.push(id);
    } else failed.push(id);
  }

  judgeState.delete(interaction.user.id);

  const lines = [
    `✅ **${passed.length}名** を合格→亡霊にしました（初期発行 計 ${fmtLd(totalGranted)}）。`,
    roleFailed.length > 0
      ? `⚠️ **ロール変更に失敗 ${roleFailed.length}名**: ${roleFailed.map((id) => `<@${id}>`).join(", ")}\n　→ DB上は亡霊化・初期発行済みですが**入城案内待ち→亡霊のロールが変わっていません**。手動で亡霊ロールを付けてください。原因はボットのロールが亡霊ロールより下にあること（Discordのロール順で上へ）。`
      : "",
    failed.length > 0 ? `❌ 亡霊化そのものに失敗: ${failed.map((id) => `<@${id}>`).join(", ")}` : "",
    sel.hold.size > 0 ? `⏸ 保留（案内待ちのまま）: ${sel.hold.size}名` : "",
  ].filter(Boolean);
  await interaction.editReply({ content: lines.join("\n"), allowedMentions: { parse: [] } });
}

// ---- 亡霊化（1人分の共通処理: 判定バッチ・時間外チケット両方から使う）----

async function ghostifyOne(
  guild: Guild,
  services: Services,
  userId: string,
  actor: string,
): Promise<{ ok: boolean; granted: number; roleOk: boolean; roleError?: string }> {
  try {
    const member = await guild.members.fetch(userId);
    const maleRoleId = services.settings.getString("role:male");
    const femaleRoleId = services.settings.getString("role:female");
    const gender =
      maleRoleId && member.roles.cache.has(maleRoleId)
        ? ("male" as const)
        : femaleRoleId && member.roles.cache.has(femaleRoleId)
          ? ("female" as const)
          : null;
    const result = services.entry.ghostify(userId, actor, { inviteeGender: gender });
    const waitRoleId = services.settings.getString("role:queue_wait");
    const ghostRoleId = services.settings.getString("role:ghost");
    // ロール変更の成否を捕捉する。ghostify(DB) は成功しているので握り潰さず、
    // 失敗を呼び出し側（判定UI）へ伝えて手動対応を促す。
    let roleOk = true;
    let roleError: string | undefined;
    if (waitRoleId) {
      const removed = await member.roles.remove(waitRoleId).then(() => true).catch((e: Error) => {
        roleError = e.message;
        return false;
      });
      if (!removed) roleOk = false;
    }
    if (ghostRoleId) {
      const added = await member.roles.add(ghostRoleId).then(() => true).catch((e: Error) => {
        roleError = e.message;
        return false;
      });
      if (!added) roleOk = false;
    } else {
      roleOk = false;
      roleError = "role:ghost が未設定";
    }
    if (!roleOk) {
      console.error(`[entry] 亡霊化のロール変更失敗 ${userId}: ${roleError}（ボットのロールを階級より上へ）`);
    }

    // 招待者への波及処理: 称号評価 + 招待による昇格印の閾値到達チェック
    const inviteeSoul = services.entry.getSoul(userId);
    const inviterId = inviteeSoul?.inviter_user_id;
    if (inviterId) {
      // 称号評価（勧誘者・冥獄の伝道師）
      const newlyGranted = services.titles.evaluate(inviterId);
      if (newlyGranted.length > 0) {
        const inviter = await guild.members.fetch(inviterId).catch(() => null);
        await inviter
          ?.send(
            `🎉 <@${userId}> さんを招待した実績で新たな称号を獲得しました:\n${newlyGranted.map((t) => `${t.emoji} **${t.name}** — ${t.desc}`).join("\n")}`,
          )
          .catch(() => undefined);
      }
      // 招待による昇格印スコアが閾値に達したか（招待者が亡霊で評価期間中の場合のみ）
      await checkInvitePromotion(guild, services, inviterId).catch((e) =>
        console.error(`[entry] 招待昇格チェック失敗 ${inviterId}:`, e),
      );
    }
    return { ok: true, granted: result.granted, roleOk, roleError };
  } catch (e) {
    console.error(`[entry] 亡霊化失敗 ${userId}:`, e);
    return { ok: false, granted: 0, roleOk: false, roleError: (e as Error).message };
  }
}

/**
 * 招待による昇格印スコアが閾値に到達したかチェック（招待者が亡霊のみ対象）。
 * 到達していたら面談待ちロールを付与し、集令チャンネルで審に通知する。
 * 冪等: 既に面談待ちロールを持っていれば何もしない。
 */
async function checkInvitePromotion(guild: Guild, services: Services, inviterId: string): Promise<void> {
  const soul = services.entry.getSoul(inviterId);
  if (!soul || soul.status !== "ghost") return; // 亡霊以外は昇格対象外
  const score = services.evaluation.promotionScore(inviterId);
  const required = services.evaluation.thresholdsFor(inviterId).promotionRequired;
  if (score.total < required) return;

  const member = await guild.members.fetch(inviterId).catch(() => null);
  if (!member) return;
  const mendanRoleId = services.settings.getString("role:mendan");
  if (mendanRoleId && member.roles.cache.has(mendanRoleId)) return; // 既に面談待ちなら通知しない
  if (mendanRoleId) await member.roles.add(mendanRoleId).catch(() => undefined);

  // 昇格面談呼び出し: channel:promotion_call（未設定なら channel:shurei にフォールバック）
  const callChId =
    services.settings.getString("channel:promotion_call") ?? services.settings.getString("channel:shurei");
  const shinRoleId = services.settings.getString("role:shin");
  if (callChId) {
    const channel = await guild.client.channels.fetch(callChId).catch(() => null);
    if (channel?.isTextBased() && "send" in channel) {
      await channel
        .send(
          `⚔️ ${shinRoleId ? `<@&${shinRoleId}> ` : ""}<@${inviterId}> の昇格印が **${score.total}/${required}** に到達しました（評価${score.evalMarks} + 招待${score.inviteScore}）。昇格面談をお願いします。`,
        )
        .catch(() => undefined);
    }
  }
  await member.send(`🎉 招待実績で昇格印が **${score.total}/${required}** に到達しました。面談待ちロールが付き、審に通知されました。`).catch(() => undefined);
  console.log(`[entry] 招待経由で面談待ち到達: ${inviterId} (score=${score.total})`);
}

// ---- 時間外・個別希望: チケット（非公開スレッド）で柔軟に面接 ----

async function openFlexTicket(
  interaction: ButtonInteraction | UserSelectMenuInteraction,
  services: Services,
  userId: string,
): Promise<void> {
  const guild = interaction.guild!;
  const guideId = services.settings.getString("channel:entry_guide");
  const guide = guideId ? await guild.channels.fetch(guideId).catch(() => null) : null;
  const base = (guide?.isTextBased() ? guide : interaction.channel) as TextChannel | null;
  if (!base || !("threads" in base)) {
    await interaction.reply({
      content: "✅ 時間外希望を受け付けました。スタッフから個別に連絡します。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const member = await guild.members.fetch(userId).catch(() => null);
  const thread = await base.threads
    .create({
      name: `時間外希望-${member?.displayName ?? "案内待ち"}`.slice(0, 90),
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    })
    .catch(() => null);
  if (!thread) {
    await interaction.reply({
      content: "✅ 時間外希望を受け付けました。スタッフから連絡します。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await thread.members.add(userId).catch(() => undefined);

  // 門番（judge/lead/extra）と運営のロールが付いていれば全て呼ぶ
  const judgeRoleIds = ["judge", "judge_lead", "judge_extra"]
    .map((k) => services.settings.getString(`role:${k}`))
    .filter((v): v is string => !!v);
  const adminRoleId = services.settings.getString("role:admin");
  const rolesToPing = [...new Set([...judgeRoleIds, ...(adminRoleId ? [adminRoleId] : [])])];

  await thread
    .send({
      content: [
        `${rolesToPing.map((r) => `<@&${r}>`).join(" ")} <@${userId}> さんの**時間外・個別希望**です。`,
        "**都合のいい曜日・時間帯**を書いてください。門番が合わせて調整します。",
        "調整した時間に本人が **説明会場VC** に来たら、通常通り `/審判 判定` で合格にしてください。",
      ].join("\n"),
      allowedMentions: { users: [userId], roles: rolesToPing },
    })
    .catch(() => undefined);

  await interaction.reply({
    content: `✅ 時間外の受付を作りました → ${thread.toString()}\nそちらで門番と時間を決めてください。`,
    flags: MessageFlags.Ephemeral,
  });
}
