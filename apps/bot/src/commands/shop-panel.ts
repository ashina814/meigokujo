import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
  type GuildMember,
  type MessageCreateOptions,
} from "discord.js";
import {
  LedgerError,
  NICKNAME_MAX_LENGTH,
  ShopError,
  SubAccountError,
  describeRejection,
  termDays,
  type PurchaseRow,
  type ShopItemRow,
} from "@meigokujo/core";
import { fmtLd } from "../format.js";
import { deliverPurchase, nicknameBlockReason } from "../shop-delivery.js";
import { deliverOrRefund, type Settlement } from "../shop-refund.js";
import { withUserLock } from "../user-lock.js";
import {
  applyModal,
  handleApplyModal,
  handleRenewConfirm,
  isOriginalRoleItem,
  originalRoleActions,
  payRequote,
  renewConfirm,
  renewPicker,
} from "./original-role.js";
import {
  handleApplyModal as handleSubApplyModal,
  applyModal as subApplyModal,
  isSubAccountItem,
  mainRank as subMainRank,
  payRequote as subPayRequote,
  subAccountActions,
} from "./sub-account.js";
import { meetsRoleRequirement, requirementLabel } from "../rank-requirement.js";
import { refreshShopAdminPanels } from "./shokan.js";
import type { Services } from "../services.js";

/**
 * 公式ショップ（買う側の永続パネル）。
 * /パネル設置 種別:公式ショップ で設置される。
 */

const CATALOG_LIMIT = 25;
const EXTERNAL_CONFIRM_TTL_SEC = 2 * 60;

function formatPrice(item: ShopItemRow): string {
  const parts: string[] = [];
  if (item.price_land !== null) parts.push(fmtLd(item.price_land));
  if (item.price_alt_kind && item.price_alt_amount !== null) {
    const kindJa = item.price_alt_kind === "invite" ? "招待" : item.price_alt_kind;
    parts.push(`${kindJa} ${item.price_alt_amount}`);
  }
  return parts.join(" / ") || "—";
}

function formatKind(item: ShopItemRow): string {
  const days = termDays(item);
  return days === null ? "単発" : `${days}日間`;
}

/** 残り日数。切り上げないと「あと0日」で1日残っている状態が出る */
function daysLeft(expiresAt: number | null): number {
  if (!expiresAt) return 0;
  return Math.max(0, Math.ceil((expiresAt - Math.floor(Date.now() / 1000)) / 86_400));
}

/** その利用者が契約中の同じ商品（あれば購入から延長へ導線を変える） */
function contractView(
  services: Services,
  userId: string,
  item: ShopItemRow,
): { purchase: PurchaseRow; extendable: boolean } | undefined {
  const purchase = services.shop.listUserPurchases(userId, { activeOnly: true }).find((p) => p.item_id === item.id);
  return purchase ? { purchase, extendable: services.shop.isExtendable(item) } : undefined;
}

export function shopPanelMessage(services: Services): MessageCreateOptions {
  const items = services.shop.listItems({ enabledOnly: true });
  const embed = new EmbedBuilder()
    .setTitle("🛒 冥獄城 公式ショップ")
    .setColor(0xdb2777)
    .setDescription(
      [
        "冥界商館が扱う公式商品です。**支払いは Land を焼却**します（通貨は循環から消えます）。",
        "期限付きの商品が切れても**自動で再課金しません**。続ける場合はご自身で買い直してください。",
        "",
        `**${items.length}件** の商品`,
      ].join("\n"),
    );
  if (items.length > 0) {
    embed.addFields(
      items.slice(0, 25).map((item) => ({
        name: `${item.name} — ${formatPrice(item)}`,
        value: [
          `${formatKind(item)}${item.require_role_id ? ` / <@&${item.require_role_id}> 限定` : ""}${item.stock !== null ? ` / 在庫 ${item.stock}` : ""}`,
          item.description ? `_${item.description}_` : "",
        ].filter(Boolean).join("\n"),
      })),
    );
  }

  const components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];
  if (items.length > 0) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("shop:pick")
      .setPlaceholder("商品を選ぶ")
      .addOptions(
        items.slice(0, CATALOG_LIMIT).map((item) => ({
          label: item.name.slice(0, 100),
          value: String(item.id),
          description: `${formatPrice(item)} / ${formatKind(item)}`.slice(0, 100),
        })),
      );
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }
  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("shop:contracts").setLabel("契約中").setEmoji("📜").setStyle(ButtonStyle.Secondary),
    ),
  );
  return { embeds: [embed], components };
}

function itemDetail(
  item: ShopItemRow,
  userHasRole: boolean,
  balance: number,
  requireLabel: string,
  contract?: { purchase: PurchaseRow; extendable: boolean },
): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const embed = new EmbedBuilder()
    .setTitle(`🛒 ${item.name}`)
    .setColor(0xdb2777)
    .setDescription(item.description ?? "（説明なし）")
    .addFields(
      { name: "価格", value: formatPrice(item), inline: true },
      { name: "種類", value: formatKind(item), inline: true },
      { name: "配送", value: item.delivery === "auto" ? "自動" : "手動（スタッフ対応）", inline: true },
      { name: "階級要件", value: requireLabel, inline: true },
      { name: "在庫", value: item.stock === null ? "無限" : String(item.stock), inline: true },
      { name: "あなたの残高", value: fmtLd(balance), inline: true },
    );
  // 既に契約中なら「買い直す」ではなく「延長する」。同じ商品を二重に契約させない代わりに、
  // 利用者には**同じ場所で続きの操作**として見せる（新しい手順を覚えさせない）
  if (contract) {
    embed.addFields({
      name: "契約中",
      value: `残り **${daysLeft(contract.purchase.expires_at)}日**（<t:${contract.purchase.expires_at}:D> まで）`,
    });
    // Botが利用権を管理していない商品には延長を出さない（払っても伸びる保証が無い）
    if (!contract.extendable || item.price_land === null) {
      embed.setFooter({ text: "この契約の延長は運営が対応します。" });
      return { embeds: [embed], components: [] };
    }
    const extend = new ButtonBuilder()
      .setCustomId(`shop:extend:${contract.purchase.id}`)
      .setLabel(`${termDays(item) ?? 30}日延長 (${fmtLd(item.price_land)})`)
      .setEmoji("♻️")
      .setStyle(ButtonStyle.Primary);
    return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(extend)] };
  }

  // 名前変更は「買う」ではなく「名前を変える」。入力→確認→完了で終わらせる
  if (isNicknameItem(item) && item.price_land !== null) {
    return {
      embeds: [embed],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`shop:nick:${item.id}`)
            .setLabel(`名前を変える (${fmtLd(item.price_land)})`)
            .setEmoji("✏️")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!userHasRole),
        ),
      ],
    };
  }

  const buttons: ButtonBuilder[] = [];
  if (item.price_land !== null) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`shop:buy:${item.id}:land`)
        .setLabel(`Land で買う (${fmtLd(item.price_land)})`)
        .setEmoji("💰")
        .setStyle(ButtonStyle.Primary)
        // Land不足でも押せるようにし、押下後に賭場チップ返還の確認を出す。
        .setDisabled(!userHasRole || (item.stock !== null && item.stock <= 0)),
    );
  }
  if (item.price_alt_kind && item.price_alt_amount !== null) {
    const kindJa = item.price_alt_kind === "invite" ? "招待" : item.price_alt_kind;
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`shop:buy:${item.id}:alt`)
        .setLabel(`${kindJa} ${item.price_alt_amount} で買う`)
        .setEmoji("🎟")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!userHasRole || (item.stock !== null && item.stock <= 0)),
    );
  }
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (buttons.length > 0) row.addComponents(...buttons);
  const components = row.components.length > 0 ? [row] : [];
  if (!userHasRole && item.require_role_id) {
    embed.setFooter({ text: "階級要件を満たしていません（上の「階級要件」を参照）" });
  }
  return { embeds: [embed], components };
}

/**
 * その商品が「再評価を受ける権利」か。
 *
 * 再評価チャレンジは**配送する物が無い**。購入で権利が立ち、消費するのは
 * 既存の再評価面談フローだけ。ここを配送商品として扱うと、汎用の「配送完了」で
 * `delivered_at` が入り、**面談前に権利が消える**（購入 #44 で実際に起きた形）。
 */
function isReevalItem(services: Services, item: ShopItemRow): boolean {
  const configured = Number(services.settings.getString("shop:reeval_item_id"));
  return Number.isInteger(configured) && configured === item.id;
}

/** 再評価面談の受付パネルへのジャンプリンク（未設置なら null） */
function reevalPanelLink(services: Services, guildId: string | null): string | null {
  if (!guildId) return null;
  const panel = services.tickets.getPanel("reeval");
  if (!panel || !panel.enabled || panel.archivedAt) return null;
  if (!panel.channelId || !panel.messageId) return null;
  return `https://discord.com/channels/${guildId}/${panel.channelId}/${panel.messageId}`;
}


/** Botが自分でニックネームを変える商品か（配送種別で決める） */
function isNicknameItem(item: ShopItemRow): boolean {
  return item.delivery === "auto" && item.delivery_kind === "set_nickname";
}

/**
 * いま城で名乗っている名前。**登録済みなら正本（`member_names`）を見る。**
 *
 * 入城の名前制度が入る前から居る人は、まだ登録が無いことがある。その場合だけ
 * 「利用者に見えている名前」で代用する（登録が無いからといって、見えている名前と
 * 同じ名前へ有料で変えさせない）。
 */
function currentName(services: Services, member: GuildMember): string {
  return services.nicknames.get(member.id)?.nickname ?? member.displayName;
}

/**
 * 課金前の検査を**入城パネルと同じ規則**で行う。
 *
 * 名前の決まり（使える文字・禁止語）と同名禁止は `NicknamePolicy` と
 * 予約テーブルが正本。ここで独自に判定すると、**払えば規則を迂回できる**
 * 抜け道になる。払う前に分かる不可はすべてここで止め、人を呼ばない。
 */
function checkNicknameBeforeCharge(
  services: Services,
  member: GuildMember,
  input: string,
): { ok: true; nickname: string } | { ok: false; message: string } {
  const evaluated = services.nicknames.evaluate(input);
  if (!evaluated.ok) return { ok: false, message: describeRejection(evaluated.rejection) };
  // **確認が要る名前は自動で変えない。** 入城側では門番の確認待ちになるので、
  // 払えば素通しになる経路を作らない。どの語で止まったかは本人に見せない
  if (evaluated.flagged) {
    return {
      ok: false,
      message: "この名前は運営の確認が必要です。別の名前をお選びいただくか、運営にご相談ください。",
    };
  }
  if (evaluated.nickname === currentName(services, member)) {
    return { ok: false, message: "いまの名前と同じです。" };
  }
  // 予約は名前の唯一の正本。自分がいま押さえている名前なら通す
  const reservation = services.nicknames.reservation(evaluated.key);
  if (reservation && !(reservation.kind === "member" && reservation.user_id === member.id)) {
    return {
      ok: false,
      message:
        reservation.kind === "legacy_conflict"
          ? "その名前は既に城内で使われているため、お使いいただけません。別の名前をお願いします。"
          : "その名前は既に他の方が使っています。別の名前をお願いします。",
    };
  }
  return { ok: true, nickname: evaluated.nickname };
}

/**
 * 課金前に、Botが変更できる相手かを確かめる。
 *
 * **ここで止めたものはスタッフの仕事にしない。** 払う前に分かることで人を呼ばない。
 */
function nicknamePreflight(
  interaction: ButtonInteraction | ModalSubmitInteraction,
): { ok: true; member: GuildMember } | { ok: false; message: string } {
  const guild = interaction.guild;
  const member = interaction.member as GuildMember | null;
  if (!guild || !member) return { ok: false, message: "サーバー内で実行してください。" };
  const blocked = nicknameBlockReason(guild, member);
  return blocked ? { ok: false, message: blocked.message } : { ok: true, member };
}

function nicknameModal(itemId: number, current: string) {
  return new ModalBuilder()
    .setCustomId(`shop:nick-input:${itemId}`)
    .setTitle("名前変更")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("nickname")
          .setLabel("新しいサーバーニックネーム")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("漢字・かな・カナ・英数字のみ（記号や空白は使えません）")
          .setMaxLength(NICKNAME_MAX_LENGTH)
          .setValue(current.slice(0, NICKNAME_MAX_LENGTH)),
      ),
    );
}

/**
 * 変更内容と料金の確認。**ここで見せた料金を確定操作まで持たせる。**
 *
 * 確認画面のボタンに料金を焼き込み、確定時に商品の現在価格と突き合わせる。
 * 確定時の価格をそのまま課金すると、確認してから押すまでの間に運営が値段を変えただけで
 * 「見せていない額」を引くことになる。
 */
function nicknameConfirm(
  services: Services,
  item: ShopItemRow,
  member: GuildMember,
  wanted: string,
  confirmationId: string,
  opts: { priceChanged?: boolean } = {},
) {
  const price = item.price_land ?? 0;
  const balance = services.ledger.balanceOf(`user:${member.id}`);
  return {
    content: [
      opts.priceChanged
        ? "⚠️ 確認したあとに料金が変わりました。**まだ引き落としていません。**新しい料金でご確認ください。"
        : "✏️ サーバーニックネームを変更します。",
      `**${currentName(services, member)}** → **${wanted}**`,
      `料金 **${fmtLd(price)}** ／ 残高 ${fmtLd(balance)}`,
    ].join("\n"),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          // 同じ確認画面からの実行は同じ操作IDになる（二重課金しない）
          .setCustomId(`shop:nick-do:${item.id}:${confirmationId}:${price}:${wanted}`)
          .setLabel("変更する")
          .setStyle(ButtonStyle.Success),
      ),
    ],
  };
}

type PurchaseOutcome = ReturnType<Services["shop"]["purchase"]> & { replayed?: boolean };

function purchaseOnce(
  services: Services,
  input: {
    operationId: string;
    itemId: number;
    userId: string;
    actor: string;
    memberRoleIds: readonly string[];
    mode: "land" | "alt";
    /** 本人が入力した内容。課金と同じトランザクションで購入行へ残す */
    request?: Record<string, unknown>;
  },
): PurchaseOutcome {
  const execute = services.db.transaction(() => {
    const existing = services.db.prepare(
      "SELECT * FROM shop_purchase_operations WHERE operation_id=?",
    ).get(input.operationId) as
      | { user_id: string; item_id: number; mode: string; purchase_id: number | null; status: string }
      | undefined;
    if (existing) {
      if (existing.user_id !== input.userId || existing.item_id !== input.itemId || existing.mode !== input.mode) {
        throw new Error("shop operation conflict");
      }
      if (existing.status !== "completed" || existing.purchase_id === null) {
        throw new Error("shop operation is incomplete");
      }
      const purchase = services.shop.getPurchase(existing.purchase_id);
      const item = services.shop.getItem(existing.item_id);
      if (!purchase || !item) throw new Error("shop operation result is missing");
      // 課金だけが冪等。**配送は再実行してよい**（未配送なら届けるのが正しい）。
      // 二度配らないのは購入行の配送状態が保証するので、ここでは印を返すだけにする
      return { purchase, item, needsManualDelivery: item.delivery === "manual", replayed: true };
    }

    services.db.prepare(
      `INSERT INTO shop_purchase_operations
       (operation_id,user_id,item_id,mode,status,created_at)
       VALUES (?,?,?,?, 'executing', ?)`,
    ).run(input.operationId, input.userId, input.itemId, input.mode, Math.floor(Date.now() / 1_000));

    const result = services.shop.purchase({
      itemId: input.itemId,
      userId: input.userId,
      actor: input.actor,
      memberRoleIds: input.memberRoleIds,
      payAlt: input.mode === "alt",
      request: input.request,
      // **操作ごとに違う鍵で課金する。** 既定の鍵は秒までしか分けないので、
      // 返金後のやり直しが同じ秒に入ると Land が動かないまま購入行だけができる
      idempotencyKey: `shop:purchase:op:${input.operationId}`,
    });
    services.db.prepare(
      `UPDATE shop_purchase_operations
       SET status='completed',purchase_id=?,completed_at=?
       WHERE operation_id=? AND status='executing'`,
    ).run(result.purchase.id, Math.floor(Date.now() / 1_000), input.operationId);
    return { ...result, replayed: false };
  });
  return execute.immediate();
}

/** 手動配送の案内。商品説明があれば併記する */
function manualDeliveryNote(item: ShopItemRow, head: string): string {
  return item.description ? `${head}
${item.description}` : head;
}

async function finishPurchase(
  interaction: ButtonInteraction,
  services: Services,
  result: PurchaseOutcome,
): Promise<void> {
  const { item, purchase } = result;
  let deliveryNote = "";
  let delivered = true;
  if (item.delivery === "auto") {
    // **replayed でも配送を試す。** 課金は冪等（operation IDで一度きり）だが、
    // 配送は成功するまで再試行してよい。二度配らないのは配送状態が保証する。
    const outcome = await deliverPurchase(services, interaction.guild, purchase, `user:${interaction.user.id}`);
    deliveryNote = outcome.message;
    delivered = outcome.state !== "failed";
    // **1回目の失敗でスタッフへ回す。** ここで知らせないと、利用者だけが
    // 「届いていない」と分かっている状態になる
    if (!delivered) await notifyStaffForFailure(interaction, services, purchase.id, item);
  } else if (isReevalItem(services, item)) {
    // **配送しない。** 買ったのは面談を受ける権利で、消費するのは既存の再評価面談フロー。
    // スタッフへ配送依頼を投げると「配送完了」で権利を消せてしまうので、通知も出さない
    const link = reevalPanelLink(services, interaction.guildId);
    deliveryNote = [
      "🎟 **再評価を受ける権利**を取得しました（この時点では階級は変わりません）。",
      link ? `▶ **[再評価面談の受付はこちら](${link})**` : "受付の場所は運営にご確認ください。",
    ].join("\n");
  } else if (result.replayed) {
    deliveryNote = manualDeliveryNote(item, "この購入は受付済みです（スタッフ対応待ち）。");
  } else {
    // 手動配送は商品ごとに次の一手が違う。商品説明をそのまま出して、
    // 案内を商品側のデータで持てるようにする
    deliveryNote = manualDeliveryNote(item, "スタッフが配送の対応をします。");
    await notifyStaffForDelivery(interaction, services, purchase.id, item).catch(() => undefined);
  }
  const expires = purchase.expires_at ? `\n有効期限: <t:${purchase.expires_at}:D>` : "";
  // 配送が失敗したのに「購入しました」だけ出すと、届いたように読める。
  // 課金は成立し配送は未完了、という事実をそのまま書く
  const head = delivered
    ? `✅ **${item.name}** を購入しました`
    : `⚠️ **${item.name}** の支払いは完了しましたが、**配送が完了していません**（購入 #${purchase.id}）`;
  await interaction.editReply({
    content: `${head}${deliveryNote ? `\n${deliveryNote}` : ""}${expires}`,
    embeds: [],
    components: [],
  });
}

function purchaseErrorMessage(error: unknown, services: Services): string {
  if (error instanceof ShopError) {
    if (error.code === "ERR_ITEM_DISABLED") return "この商品は現在販売されていません。";
    if (error.code === "ERR_NO_STOCK") return "在庫切れです。";
    if (error.code === "ERR_ROLE_REQUIRED") {
      return `階級要件を満たしていません（要 ${requirementLabel(services.settings, (error.details.roleId as string | undefined) ?? null)}）。`;
    }
    if (error.code === "ERR_ALREADY_ACTIVE") return "既に契約中です。「契約中」から延長してください。";
    if (error.code === "ERR_NOT_OWNER" || error.code === "ERR_NOT_ACTIVE") return "この契約は延長できません。";
    if (error.code === "ERR_NOT_EXTENDABLE") return "この契約はここからは延長できません。運営にご確認ください。";
    if (error.code === "ERR_TERMS_CHANGED") return "内容が変わったので、もう一度確認してください（料金は発生していません）。";
    if (error.code === "ERR_NO_PRICE") return "この商品の価格が設定されていません。";
  }
  if (error instanceof LedgerError && error.code === "ERR_INSUFFICIENT") return "残高が足りません。";
  return error instanceof Error ? error.message : "処理に失敗しました。";
}

function chipReturnView(confirmationId: string, item: ShopItemRow, land: number, chips: number) {
  return {
    content: [
      `Landが足りません。商品 **${item.name}** は ${fmtLd(item.price_land ?? 0)}、現在のLandは ${fmtLd(land)} です。`,
      `賭場に **${fmtLd(chips)}** あります。`,
      "押した場合だけ自由チップをLandへ戻し、この購入を同じoperation IDで一度だけ再試行します。",
    ].join("\n"),
    embeds: [],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`shop:chips:${confirmationId}:${item.id}:land`)
          .setLabel("Landへ戻して続ける")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`shop:chips-no:${confirmationId}`)
          .setLabel("やめる")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

/**
 * 返還済み・購入未完了で止まった確認票の再試行ボタン（監査項目13）。
 * 「やめる」は出さない——返還が済んだあとに取り消せる操作ではない。
 */
function retryConfirmComponents(
  confirmationId: string,
  itemId: number,
  mode: "land" | "alt",
): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`shop:chips:${confirmationId}:${itemId}:${mode}`)
        .setLabel("購入を再試行")
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

export async function handleShopButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  const parts = interaction.customId.split(":");
  const action = parts[1];

  if (action === "contracts") {
    const rows = services.shop.listUserPurchases(interaction.user.id, { activeOnly: true });
    const terms = rows.filter((purchase) => purchase.expires_at !== null);
    const lines = rows.length > 0
      ? rows.map((purchase) => {
          const item = services.shop.getItem(purchase.item_id);
          const label = item?.name ?? `#${purchase.item_id}`;
          if (!purchase.expires_at) return `・**${label}**`;
          const head = `・**${label}** — 残り **${daysLeft(purchase.expires_at)}日**（<t:${purchase.expires_at}:D> まで）`;
          // 延長ボタンが出ない契約に「延長してください」とだけ書くと、
          // 押す場所が無いのに催促されているように読める
          if (item && !services.shop.isExtendable(item)) return `${head}\n　↳ この契約の延長は現在、運営対応です`;
          return head;
        })
      : ["契約中の商品はありません。"];
    // 自動更新を廃止したので「自動更新中／停止中」も「解約する」も出さない。
    // 利用者がすることは「残りを見て、延長できるものは押す」だけにする
    const embed = new EmbedBuilder()
      .setTitle("📜 契約中の商品")
      .setColor(0xdb2777)
      .setDescription(
        [...lines, "", "-# 自動での再課金はありません。商館から延長できる契約は、下のボタンから延長できます。"].join("\n"),
      );
    const components: ActionRowBuilder<ButtonBuilder>[] = [];
    for (const purchase of terms.slice(0, 5)) {
      const item = services.shop.getItem(purchase.item_id);
      // Botが利用権を管理していない商品（旧オリジナルロール継続など）には延長を出さない。
      // 払っても実際の権利が伸びる保証が無いため
      if (!item || item.price_land === null || !services.shop.isExtendable(item)) continue;
      const button = new ButtonBuilder()
        .setCustomId(`shop:extend:${purchase.id}`)
        .setLabel(`${item.name.slice(0, 30)} を${termDays(item) ?? 30}日延長`)
        .setEmoji("♻️")
        .setStyle(ButtonStyle.Primary);
      const row = components.at(-1);
      if (row && row.components.length < 2) row.addComponents(button);
      else components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(button));
    }
    await interaction.reply({ embeds: [embed], components, flags: MessageFlags.Ephemeral });
    return;
  }


  // ── オリジナルロール ──
  if (action === "orole-apply") {
    const item = services.shop.getItem(Number(parts[2]));
    if (!item || !item.enabled || !isOriginalRoleItem(services, item)) {
      await interaction.reply({ content: "この商品はいま申請できません。", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(applyModal(item.id));
    return;
  }

  if (action === "sub-apply") {
    // 古いボタンから来ることがある。**商品が今も売られているか確かめてから**開く
    const applyItem = services.shop.getItem(Number(parts[2]));
    if (!applyItem || !applyItem.enabled || !isSubAccountItem(services, applyItem)) {
      await interaction.update({ content: "この商品はいま申請できません。", embeds: [], components: [] });
      return;
    }
    await interaction.showModal(subApplyModal(applyItem.id));
    return;
  }

  if (action === "sub-pay") {
    const itemId = Number(parts[2]);
    const applicationId = Number(parts[3]);
    const quotedPrice = Number(parts[4]);
    const attempt = parts[5] ?? "";
    const item = services.shop.getItem(itemId);
    if (!item || !item.enabled || !isSubAccountItem(services, item) || item.price_land === null) {
      await interaction.update({ content: "この商品はいま購入できません。", embeds: [], components: [] });
      return;
    }
    const application = services.subAccounts.get(applicationId);
    if (quotedPrice !== item.price_land) {
      // **1 Ld も動かさずに**、新しい額で確かめ直してもらう
      await interaction.update(subPayRequote(item, applicationId, application?.alt_user_id ?? ""));
      return;
    }
    await interaction.deferUpdate();
    interface SubAttempt {
      error?: string;
      purchase?: PurchaseRow;
      settled?: Settlement;
    }
    const settlement = await withUserLock<SubAttempt>(`sub-pay:${applicationId}`, async () => {
      const open = services.shop.findActivePurchaseByRequest(interaction.user.id, itemId, "applicationId", applicationId);
      if (open) {
        return {
          purchase: open,
          settled: await deliverOrRefund(interaction.client, services, interaction.guild, open, `user:${interaction.user.id}`),
        };
      }
      try {
        // **最後の関門。** 承認後に降格していれば、ここで 1 Ld も引かずに止める
        services.subAccounts.assertPayable(applicationId, interaction.user.id, subMainRank(services, interaction.user.id));
      } catch (error) {
        const code = error instanceof SubAccountError ? error.code : "";
        return {
          error:
            code === "ERR_RANK_TOO_LOW"
              ? "⚠️ サブ垢の追加は**魔人以上**の方が対象です。承認後に階級が変わっているため、お支払いは行いませんでした。"
              : "⚠️ この申請はいま支払える状態ではありません（取り消されたか、既に支払い済みです）。",
        } as SubAttempt;
      }
      let purchase: PurchaseOutcome;
      try {
        purchase = purchaseOnce(services, {
          operationId: `sub:${applicationId}:${attempt}`,
          itemId,
          userId: interaction.user.id,
          actor: `user:${interaction.user.id}`,
          memberRoleIds: [...((interaction.member as GuildMember | null)?.roles.cache.keys() ?? [])],
          mode: "land",
          request: { applicationId },
        });
      } catch (error) {
        return { error: `❌ ${purchaseErrorMessage(error, services)}` } as SubAttempt;
      }
      return {
        purchase: purchase.purchase,
        settled: await deliverOrRefund(
          interaction.client,
          services,
          interaction.guild,
          purchase.purchase,
          `user:${interaction.user.id}`,
        ),
      };
    });
    if (settlement.error !== undefined) {
      await interaction.editReply({ content: settlement.error, embeds: [], components: [] });
      return;
    }
    const paidSub = settlement.purchase!;
    const { outcome, refund } = settlement.settled!;
    if (outcome.state !== "failed") {
      await interaction.editReply({ content: `✅ ${outcome.message}`, embeds: [], components: [] });
      return;
    }
    await interaction.editReply({
      content:
        refund === "refunded"
          ? `有効化できなかったため、${fmtLd(paidSub.paid_land ?? 0)}は返金しました。
-# ${outcome.message}`
          : `⚠️ 有効化に失敗し、返金も完了できませんでした。運営が対応します（購入 #${paidSub.id}）。
-# ${outcome.message}`,
      embeds: [],
      components: [],
    });
    return;
  }

  if (action === "orole-pay") {
    const itemId = Number(parts[2]);
    const applicationId = Number(parts[3]);
    // 表示した額。**押した時の最新価格ではなく、これで引く**
    const quotedPrice = Number(parts[4]);
    // 支払い画面ごとの鍵。**同じ画面の二度押しは1回**、開き直せば新しい挑戦になる
    const attempt = parts[5] ?? "";
    const item = services.shop.getItem(itemId);
    if (!item || !item.enabled || !isOriginalRoleItem(services, item) || item.price_land === null) {
      await interaction.update({ content: "この商品はいま購入できません。", embeds: [], components: [] });
      return;
    }
    if (quotedPrice !== item.price_land) {
      // **1 Ld も動かさずに**、新しい額で確かめ直してもらう（新しい鍵を配る）
      const application = services.originalRoles.get(applicationId);
      await interaction.update(payRequote(item, applicationId, application?.name ?? ""));
      return;
    }
    await interaction.deferUpdate();
    // **同じ申請の支払いを直列化する。** 2本同時に押されても、2本目は
    // 1本目が作った購入を見つけて課金しない
    interface Attempt {
      error?: string;
      purchase?: PurchaseRow;
      settled?: Settlement;
    }
    const settlement = await withUserLock<Attempt>(`orole-pay:${applicationId}`, async () => {
      // 返金されていない購入が既にあるなら、それを進めるだけ（二重課金しない）。
      // 返金済みは「まだ払っていない」ので、ここには出てこない＝再挑戦できる
      const open = services.shop.findActivePurchaseByRequest(
        interaction.user.id,
        itemId,
        "applicationId",
        applicationId,
      );
      if (open) {
        return {
          purchase: open,
          settled: await deliverOrRefund(interaction.client, services, interaction.guild, open, `user:${interaction.user.id}`),
        };
      }
      try {
        services.originalRoles.assertPayable(applicationId, interaction.user.id);
      } catch {
          return { error: "⚠️ この申請はいま支払える状態ではありません（取り消されたか、既に支払い済みです）。" } as Attempt;
      }
      let purchase: PurchaseOutcome;
      try {
        // 課金・購入行・どの申請かを1トランザクションで確定する
        purchase = purchaseOnce(services, {
          operationId: `orole:${applicationId}:${attempt}`,
          itemId,
          userId: interaction.user.id,
          actor: `user:${interaction.user.id}`,
          memberRoleIds: [...((interaction.member as GuildMember | null)?.roles.cache.keys() ?? [])],
          mode: "land",
          request: { applicationId },
        });
      } catch (error) {
        return { error: `❌ ${purchaseErrorMessage(error, services)}` } as Attempt;
      }
      return {
        purchase: purchase.purchase,
        settled: await deliverOrRefund(
          interaction.client,
          services,
          interaction.guild,
          purchase.purchase,
          `user:${interaction.user.id}`,
        ),
      };
    });
    if (settlement.error !== undefined) {
      await interaction.editReply({ content: settlement.error, embeds: [], components: [] });
      return;
    }
    const paid = settlement.purchase!;
    const { outcome, refund } = settlement.settled!;
    if (outcome.state !== "failed") {
      await interaction.editReply({ content: `✅ ${outcome.message}`, embeds: [], components: [] });
      return;
    }
    await interaction.editReply({
      content:
        refund === "refunded"
          ? `作成できなかったため、${fmtLd(paid.paid_land ?? 0)}は返金しました。
-# ${outcome.message}`
          : `⚠️ 作成に失敗し、返金も完了できませんでした。運営が対応します（購入 #${paid.id}）。
-# ${outcome.message}`,
      embeds: [],
      components: [],
    });
    return;
  }

  if (action === "orole-renew") {
    const itemId = Number(parts[2]);
    await interaction.update({ ...renewPicker(services, itemId, interaction.user.id), content: "" });
    return;
  }

  if (action === "orole-renew-do") {
    await handleRenewConfirm(interaction, services, Number(parts[3]), Number(parts[4]), parts[5] ?? "");
    return;
  }

  // ── 名前変更（セルフサービス）──
  // 押す → 入力 → 金額と内容を確認 → 変更する、で終わり。
  // 課金前に分かる不可（所有者・ロール階層）はここで止め、人を呼ばない
  if (action === "nick") {
    const itemId = Number(parts[2]);
    const item = services.shop.getItem(itemId);
    if (!item || !item.enabled || !isNicknameItem(item)) {
      await interaction.reply({ content: "この商品はいま購入できません。", flags: MessageFlags.Ephemeral });
      return;
    }
    const pre = nicknamePreflight(interaction);
    if (!pre.ok) {
      await interaction.reply({ content: `⚠️ ${pre.message}`, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(nicknameModal(itemId, currentName(services, pre.member)));
    return;
  }

  if (action === "nick-do") {
    const itemId = Number(parts[2]);
    const confirmationId = parts[3] ?? "";
    const quotedPrice = Number(parts[4]);
    const wanted = parts.slice(5).join(":");
    const item = services.shop.getItem(itemId);
    if (!item || !item.enabled || !isNicknameItem(item) || item.price_land === null) {
      await interaction.update({ content: "この商品はいま購入できません。", embeds: [], components: [] });
      return;
    }
    const pre = nicknamePreflight(interaction);
    if (!pre.ok) {
      await interaction.update({ content: `⚠️ ${pre.message}`, embeds: [], components: [] });
      return;
    }
    // 確定の直前にもう一度検める。確認してから押すまでに、他の人がその名前を
    // 取っていたり、禁止語が増えていたりする
    const checked = checkNicknameBeforeCharge(services, pre.member, wanted);
    if (!checked.ok) {
      await interaction.update({ content: `⚠️ ${checked.message}`, embeds: [], components: [] });
      return;
    }
    // **確認した料金でしか引き落とさない。** 変わっていたら課金せず、新しい料金で確認し直す。
    // 別の料金になる以上、確認IDも取り直す（前の確認への同意を流用しない）
    if (!Number.isInteger(quotedPrice) || quotedPrice !== item.price_land) {
      await interaction.update({
        ...nicknameConfirm(services, item, pre.member, wanted, interaction.id, { priceChanged: true }),
        embeds: [],
      });
      return;
    }
    await interaction.deferUpdate();

    let purchase: PurchaseOutcome;
    try {
      // 課金・購入行・希望内容を1トランザクションで確定する。
      // ここで落ちれば何も残らない（＝二重課金にならない）
      purchase = purchaseOnce(services, {
        operationId: confirmationId,
        itemId,
        userId: interaction.user.id,
        actor: `user:${interaction.user.id}`,
        memberRoleIds: [...pre.member.roles.cache.keys()],
        mode: "land",
        request: { nickname: wanted },
      });
    } catch (error) {
      await interaction.editReply({ content: `❌ ${purchaseErrorMessage(error, services)}`, embeds: [], components: [] });
      return;
    }

    // 変更できなかったときは**自分で返して終わらせる**（ここでスタッフを呼ばない）。
    // 配送と返金は同じ区間で行われるので、同時押しでも「変えたうえで返す」にならない
    const { outcome, refund } = await deliverOrRefund(
      interaction.client,
      services,
      interaction.guild,
      purchase.purchase,
      `user:${interaction.user.id}`,
    );
    if (outcome.state === "not_active") {
      // 返金・取消済みの購入への再送。名前は変えていないし、返金もしない
      await interaction.editReply({ content: `⚠️ ${outcome.message}`, embeds: [], components: [] });
      return;
    }
    if (outcome.state !== "failed") {
      await interaction.editReply({ content: `✅ ${outcome.message}`, embeds: [], components: [] });
      return;
    }
    const content =
      refund === "refunded"
        ? `変更できなかったため、${fmtLd(purchase.purchase.paid_land ?? 0)}は返金しました。\n-# ${outcome.message}`
        : refund === "already_delivered"
          ? `✅ 名前の変更は完了しています。`
          : `⚠️ 変更に失敗し、返金も完了できませんでした。運営が対応します（購入 #${purchase.purchase.id}）。\n-# ${outcome.message}`;
    await interaction.editReply({ content, embeds: [], components: [] });
    return;
  }

  // 延長: 押す → 料金と延長後の期限を確認 → 確定。ここで終わり
  if (action === "extend") {
    const purchaseId = Number(parts[2]);
    const purchase = services.shop.getPurchase(purchaseId);
    const item = purchase ? services.shop.getItem(purchase.item_id) : undefined;
    if (!purchase || !item || purchase.user_id !== interaction.user.id || purchase.status !== "active") {
      await interaction.reply({ content: "この契約は延長できません。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!services.shop.isExtendable(item)) {
      await interaction.reply({
        content: "この契約はここからは延長できません。運営にご確認ください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const days = termDays(item) ?? 30;
    const nowSec = Math.floor(Date.now() / 1000);
    const nextExpires = Math.max(purchase.expires_at ?? 0, nowSec) + days * 86_400;
    // **この確認画面のID。** 確定ボタンへ埋めるので、同じ画面から何度押しても
    // 同じ操作として扱える（別の古い確認画面は下の条件検査で弾かれる）
    const confirmationId = interaction.id;
    await interaction.reply({
      content: [
        `♻️ **${item.name}** を${days}日延長します。`,
        `料金 **${fmtLd(item.price_land ?? 0)}** ／ 残高 ${fmtLd(services.ledger.balanceOf(`user:${interaction.user.id}`))}`,
        `期限 <t:${purchase.expires_at ?? nowSec}:D> → **<t:${nextExpires}:D>**`,
      ].join("\n"),
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(
              `shop:extend-do:${purchaseId}:${confirmationId}:${item.price_land ?? 0}:${days}:${purchase.expires_at ?? 0}`,
            )
            .setLabel("延長する")
            .setStyle(ButtonStyle.Success),
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === "extend-do") {
    const [purchaseId, confirmationId, price, days, expiresAt] = [
      Number(parts[2]),
      parts[3] ?? "",
      Number(parts[4]),
      Number(parts[5]),
      Number(parts[6]),
    ];
    try {
      // 階級要件は課金の直前に取り直す（キャッシュだと剥奪直後でも通ってしまう）
      const member = interaction.guild
        ? await interaction.guild.members.fetch({ user: interaction.user.id, force: true }).catch(() => null)
        : null;
      const result = services.shop.extend({
        purchaseId,
        userId: interaction.user.id,
        actor: `user:${interaction.user.id}`,
        // 同じ確認画面からの実行は必ず同じ操作IDになる
        operationId: confirmationId,
        memberRoleIds: member ? [...member.roles.cache.keys()] : [],
        expected: { priceLand: price, days, expiresAt: expiresAt === 0 ? null : expiresAt },
      });
      await interaction.update({
        content: result.extended
          ? `✅ **${result.item.name}** を${result.addedDays}日延長しました（<t:${result.purchase.expires_at!}:D> まで）。`
          : `この延長は受付済みです（<t:${result.purchase.expires_at!}:D> まで）。`,
        embeds: [],
        components: [],
      });
    } catch (error) {
      await interaction.update({ content: `❌ ${purchaseErrorMessage(error, services)}`, embeds: [], components: [] });
    }
    return;
  }

  if (action === "chips-no") {
    const confirmationId = parts[2];
    if (!confirmationId) return;
    const cancelled = services.chipFlow.cancelExternalConfirmation(confirmationId, interaction.user.id);
    await interaction.update({
      content: cancelled ? "購入をやめました。賭場の自由チップは変更していません。" : "この確認は取り消せません。",
      embeds: [],
      components: [],
    });
    return;
  }

  if (action === "chips") {
    const confirmationId = parts[2];
    const itemId = Number(parts[3]);
    const mode = parts[4] as "land" | "alt";
    if (!confirmationId || !Number.isSafeInteger(itemId) || mode !== "land") return;
    const confirmation = services.chipFlow.externalConfirmation(confirmationId);
    if (!confirmation || confirmation.userId !== interaction.user.id || confirmation.operationKind !== `shop:${itemId}:${mode}`) {
      await interaction.reply({ content: "この確認は利用できません。", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferUpdate();
    let redeemed = false;
    let purchased = false;
    try {
      let row = confirmation;
      if (row.status === "pending") row = services.chipFlow.beginExternalConfirmation(confirmationId, interaction.user.id);
      if (row.status !== "executing") throw new Error("この確認は既に処理されています");
      services.chipFlow.redeemExactFreeChips(
        interaction.user.id,
        row.chipAmount,
        `external:${confirmationId}`,
        "公式ショップ購入を続けるための返還",
        true,
      );
      redeemed = true;
      const member = interaction.member;
      const memberRoleIds = member && "roles" in member && "cache" in member.roles
        ? [...member.roles.cache.keys()]
        : [];
      const result = purchaseOnce(services, {
        operationId: row.operationId,
        itemId,
        userId: interaction.user.id,
        actor: `user:${interaction.user.id}`,
        memberRoleIds,
        mode,
      });
      purchased = true;
      if (!services.chipFlow.completeExternalConfirmation(confirmationId, interaction.user.id)) {
        throw new Error("購入確認の完了記録に失敗しました");
      }
      await finishPurchase(interaction, services, result);
    } catch (error) {
      // 返還だけが済んで購入が失敗した状態を、ボタンを消して黙って終わらせない（監査項目13）。
      // 資金が Land 側にあること・購入が未完了であることを明示し、**同じ確認票の
      // ボタンを残して**再試行できるようにする。返還も購入も安定キーなので、
      // 押し直しても資金は二重に動かず、購入が成立していれば完了記録だけが収束する。
      const stranded = redeemed && !purchased;
      await interaction.editReply({
        content: stranded
          ? [
              `❌ ${purchaseErrorMessage(error, services)}`,
              `自由チップは既にLandへ返還済みです（購入は未完了）。`,
              "同じボタンをもう一度押すと、二重に資金を動かさずこの購入だけを再試行します。",
            ].join("\n")
          : `❌ ${purchaseErrorMessage(error, services)}`,
        embeds: [],
        components: stranded ? retryConfirmComponents(confirmationId, itemId, mode) : [],
      });
    }
    return;
  }

  if (action === "buy") {
    const itemId = Number(parts[2]);
    const mode = parts[3] as "land" | "alt";
    const item = services.shop.getItem(itemId);
    if (!item) {
      await interaction.reply({ content: "商品が見つかりません。", flags: MessageFlags.Ephemeral });
      return;
    }
    const member = interaction.member;
    const memberRoleIds = member && "roles" in member && "cache" in member.roles
      ? [...member.roles.cache.keys()]
      : [];
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const result = purchaseOnce(services, {
        operationId: interaction.id,
        itemId,
        userId: interaction.user.id,
        actor: `user:${interaction.user.id}`,
        memberRoleIds,
        mode,
      });
      await finishPurchase(interaction, services, result);
    } catch (error) {
      if (
        mode === "land"
        && item.price_land !== null
        && error instanceof LedgerError
        && error.code === "ERR_INSUFFICIENT"
      ) {
        const freeChips = services.chipAssets.freeChips(interaction.user.id);
        const land = services.ledger.balanceOf(`user:${interaction.user.id}`);
        if (freeChips > 0) {
          try {
            const confirmation = services.chipFlow.createExternalConfirmation({
              id: interaction.id,
              userId: interaction.user.id,
              operationKind: `shop:${itemId}:${mode}`,
              operationId: interaction.id,
              requiredLand: Math.max(1, item.price_land - land),
              chipAmount: freeChips,
              expiresAt: Math.floor(Date.now() / 1_000) + EXTERNAL_CONFIRM_TTL_SEC,
            });
            await interaction.editReply(chipReturnView(confirmation.id, item, land, freeChips));
            return;
          } catch (confirmationError) {
            await interaction.editReply({
              content: `❌ ${confirmationError instanceof Error ? confirmationError.message : "返還確認を作成できません"}`,
              embeds: [],
              components: [],
            });
            return;
          }
        }
      }
      await interaction.editReply({ content: `❌ ${purchaseErrorMessage(error, services)}`, embeds: [], components: [] });
    }
    return;
  }
}

export async function handleShopSelect(
  interaction: StringSelectMenuInteraction,
  services: Services,
): Promise<void> {
  const action = interaction.customId.split(":")[1];
  if (action === "orole-renew-pick") {
    const row = services.originalRoles.get(Number(interaction.values[0]));
    if (!row || row.user_id !== interaction.user.id) {
      await interaction.update({ content: "その契約が見つかりません。", embeds: [], components: [] });
      return;
    }
    // 確認画面ごとに1つの鍵を配る（この操作IDを core が消費して二重課金を止める）
    await interaction.update(renewConfirm(services, Number(interaction.customId.split(":")[2]), row, interaction.id));
    return;
  }
  if (action === "pick") {
    const itemId = Number(interaction.values[0]);
    const item = services.shop.getItem(itemId);
    if (!item) {
      await interaction.reply({ content: "商品が見つかりません。", flags: MessageFlags.Ephemeral });
      return;
    }
    const member = interaction.member;
    const memberRoleIds = member && "roles" in member && "cache" in member.roles
      ? [...member.roles.cache.keys()]
      : [];
    const hasRole = !item.require_role_id || meetsRoleRequirement(services.settings, memberRoleIds, item.require_role_id);
    const balance = services.ledger.balanceOf(`user:${interaction.user.id}`);
    const view = itemDetail(
      item,
      hasRole,
      balance,
      requirementLabel(services.settings, item.require_role_id),
      contractView(services, interaction.user.id, item),
    );
    // オリジナルロールは「買う」ではなく「申請 → 承認 → 支払い」。
    // いま本人が何をすればいいかだけを出す
    if (isOriginalRoleItem(services, item)) {
      const actions = originalRoleActions(services, item, interaction.user.id);
      view.embeds[0]?.addFields({ name: "手続き", value: actions.notes.join(String.fromCharCode(10)).slice(0, 1024) });
      await interaction.reply({ embeds: view.embeds, components: actions.components, flags: MessageFlags.Ephemeral });
      return;
    }
    // サブ垢も同じ形（申請 → 本人確認 → 支払い）。先払いには戻さない
    if (isSubAccountItem(services, item)) {
      const actions = subAccountActions(services, item, interaction.user.id);
      view.embeds[0]?.addFields({ name: "手続き", value: actions.notes.join(String.fromCharCode(10)).slice(0, 1024) });
      await interaction.reply({
        embeds: view.embeds,
        components: actions.components,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
    await interaction.reply({ ...view, flags: MessageFlags.Ephemeral });
    return;
  }
}

/**
 * 自動処理が失敗したことをスタッフへ知らせる。
 *
 * 管理パネルの「処理失敗」の件数を更新し、通知は**変化のお知らせだけ**にする。
 * ここにボタンを置くと、また通知が仕事の正本になる。
 */
async function notifyStaffForFailure(
  interaction: ButtonInteraction,
  services: Services,
  purchaseId: number,
  item: ShopItemRow,
): Promise<void> {
  await refreshShopAdminPanels(interaction.client, services).catch(() => undefined);
  const channelId = services.settings.getString("channel:shokan") ?? services.settings.getString("channel:kessai");
  if (!channelId) return;
  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) return;
  await channel
    .send({
      content: `⚠️ **自動処理に失敗しました**（購入 #${purchaseId} / ${item.name}）。商館の管理パネルの「処理失敗」から確認してください。`,
      allowedMentions: { parse: [] },
    })
    .catch(() => undefined);
}

/**
 * 手動対応が必要になったことをスタッフへ知らせる。
 *
 * **ここにボタンは置かない。** 以前はこの通知の「配送完了」だけが完了手段で、
 * 流れて見失うと復旧できなかった（購入 #1 が1か月放置された）。仕事の一覧と
 * 完了操作は常設の管理パネルにあり、通知は変化のお知らせに徹する。
 */
async function notifyStaffForDelivery(
  interaction: ButtonInteraction,
  services: Services,
  purchaseId: number,
  item: ShopItemRow,
): Promise<void> {
  await refreshShopAdminPanels(interaction.client, services).catch(() => undefined);
  const channelId = services.settings.getString("channel:shokan") ?? services.settings.getString("channel:kessai");
  if (!channelId) return;
  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) return;
  await channel
    .send({
      content: `📦 **公式ショップ**: <@${interaction.user.id}> が **${item.name}** を購入しました（購入 #${purchaseId}）。対応は \`/商館\` か商館の管理パネルの「要対応」から。`,
      allowedMentions: { users: [interaction.user.id] },
    })
    .catch(() => undefined);
}

/** 名前変更の入力を受け取り、金額と変更内容を確認する */
export async function handleShopModal(interaction: ModalSubmitInteraction, services: Services): Promise<void> {
  const parts = interaction.customId.split(":");
  if (parts[1] === "orole-input") {
    await handleApplyModal(interaction, services, Number(parts[2]));
    return;
  }
  if (parts[1] === "sub-input") {
    await handleSubApplyModal(interaction, services, Number(parts[2]));
    return;
  }
  if (parts[1] !== "nick-input") return;
  const itemId = Number(parts[2]);
  const item = services.shop.getItem(itemId);
  if (!item || !item.enabled || !isNicknameItem(item) || item.price_land === null) {
    await interaction.reply({ content: "この商品はいま購入できません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const pre = nicknamePreflight(interaction);
  if (!pre.ok) {
    await interaction.reply({ content: `⚠️ ${pre.message}`, flags: MessageFlags.Ephemeral });
    return;
  }
  const wanted = interaction.fields.getTextInputValue("nickname").trim();
  const checked = checkNicknameBeforeCharge(services, pre.member, wanted);
  if (!checked.ok) {
    await interaction.reply({ content: `⚠️ ${checked.message}`, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({
    ...nicknameConfirm(services, item, pre.member, checked.nickname, interaction.id),
    flags: MessageFlags.Ephemeral,
  });
}
