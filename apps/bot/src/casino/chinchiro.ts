import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import { HOUSE_HOLDER } from "@meigokujo/core";
import { fmtEther } from "../format.js";
import type { Services } from "../services.js";
import { LOSE_COLOR, MAMMON_COLOR, MAX_BET, MIN_BET, WIN_COLOR, acquireSeat, applyAmulets, releaseSeat, sleep, validateBet } from "./common.js";
import { broadcastBigWin } from "./bigwin.js";

/**
 * 🎲 チンチロ（対マモン・casino-bot 準拠の忠実移植）。
 * - 最大3投。終了役（ピンゾロ/ゾロ目/シゴロ/ヒフミ）即確定。メナシ自動再振り。目は選択
 * - 役倍率: ピンゾロ5 / ゾロ目3 / シゴロ2 / 目1 / ヒフミは負ける側が2倍払う
 * - 同点はマモン勝ち（-1倍）。勝ち利益にエッジ5%
 * - 倍付け負け（|mul|≥2）は追加徴収。残高不足なら通常負けにフォールバック
 * - シェイクアニメ 4フレーム、マモンのターンでも同じ演出
 * - 結果画面に「最低/前回/最大/配当表/退席」ボタン
 */
const HOUSE_EDGE = 0.05;
const MAX_ROLLS = 3;
const ROLL_BUTTON_TIMEOUT_MS = 30_000;
const DIE_FACES = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"] as const;
const MAX_MULT = 6; // 最大ピンゾロ5倍 = 純利益5倍 + 元金 = 6倍 分の胴元余力

type Dice = readonly [number, number, number];
type Hand =
  | { type: "pinzoro" }
  | { type: "zorome"; value: number }
  | { type: "shigoro" }
  | { type: "hifumi" }
  | { type: "me"; score: number }
  | { type: "menashi" };

const rollDice = (): Dice =>
  [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)] as const;

function evaluate(dice: Dice): Hand {
  const [a, b, c] = [...dice].sort((x, y) => x - y) as [number, number, number];
  if (a === b && b === c) return a === 1 ? { type: "pinzoro" } : { type: "zorome", value: a };
  if (a === 4 && b === 5 && c === 6) return { type: "shigoro" };
  if (a === 1 && b === 2 && c === 3) return { type: "hifumi" };
  if (a === b) return { type: "me", score: c };
  if (b === c) return { type: "me", score: a };
  return { type: "menashi" };
}

function handRank(h: Hand): number {
  switch (h.type) {
    case "pinzoro": return 1000;
    case "zorome": return 800 + h.value;
    case "shigoro": return 700;
    case "me": return 100 + h.score;
    case "menashi": return 0;
    case "hifumi": return -100;
  }
}

function handBaseMul(h: Hand): number {
  switch (h.type) {
    case "pinzoro": return 5;
    case "zorome": return 3;
    case "shigoro": return 2;
    case "hifumi": return 2;
    default: return 1;
  }
}

function compare(player: Hand, dealer: Hand): { result: "player_win" | "dealer_win" | "push"; mul: number } {
  if (player.type === "hifumi" && dealer.type === "hifumi") return { result: "push", mul: 0 };
  if (player.type === "hifumi") return { result: "dealer_win", mul: -2 };
  if (dealer.type === "hifumi") return { result: "player_win", mul: 2 };
  const pr = handRank(player);
  const dr = handRank(dealer);
  if (pr > dr) return { result: "player_win", mul: handBaseMul(player) };
  if (pr < dr) return { result: "dealer_win", mul: -handBaseMul(dealer) };
  return { result: "dealer_win", mul: -1 };
}

function describe(h: Hand): string {
  switch (h.type) {
    case "pinzoro": return "🌟 **ピンゾロ**！1-1-1（5倍）";
    case "zorome": return `🎯 **ゾロ目**！${h.value}-${h.value}-${h.value}（3倍）`;
    case "shigoro": return "🔥 **シゴロ**！4-5-6（2倍）";
    case "hifumi": return "💀 **ヒフミ**…1-2-3（倍付けで払う）";
    case "me": return `🎲 **目** スコア **${h.score}**`;
    case "menashi": return "🌀 **メナシ**（役なし）";
  }
}

const isTerminal = (h: Hand) => h.type !== "me" && h.type !== "menashi";
/** 壺の中に転がる三賽を等幅で並べる（原作準拠の見せ方より視認性重視） */
const diceDisplay = (d: Dice) => `╭─────╮  ╭─────╮  ╭─────╮\n│  ${DIE_FACES[d[0]]}  │  │  ${DIE_FACES[d[1]]}  │  │  ${DIE_FACES[d[2]]}  │\n╰─────╯  ╰─────╯  ╰─────╯`;

function paytableEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("📖 チンチロ — ルール")
    .setColor(MAMMON_COLOR)
    .setDescription(
      [
        "**役と倍率（対マモン）**",
        "・🌟 ピンゾロ 1-1-1 → **5倍**",
        "・🎯 ゾロ目 → **3倍**",
        "・🔥 シゴロ 4-5-6 → **2倍**",
        "・🎲 目（一組ペア）→ **1倍**",
        "・🌀 メナシ → 目より弱い（自動再振り）",
        "・💀 ヒフミ 1-2-3 → **出した側が2倍払う**（自爆役）",
        "",
        "**振りルール**",
        "・最大3投。終了役（ピンゾロ/ゾロ目/シゴロ/ヒフミ）で即確定",
        "・目が出たら「止める/もう一度」を選択",
        "・メナシは自動で振り直し（3投目でメナシなら確定）",
        "",
        "**同点はマモン勝ち**（-1倍）。勝ち利益にエッジ5%",
      ].join("\n"),
    );
}

async function shakeAnimation(reply: Message, header: string[], bet: number, rollNo: number, remaining: number): Promise<void> {
  for (let f = 0; f < 4; f++) {
    const shake: Dice = [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)] as const;
    const e = new EmbedBuilder()
      .setAuthor({ name: "マモンの賭場 · チンチロ" })
      .setColor(MAMMON_COLOR)
      .setTitle(`🎲  壺を振る……  ${"・".repeat(f + 1)}`)
      .setDescription(
        [
          ...header,
          "```",
          diceDisplay(shake),
          "```",
        ].join("\n"),
      )
      .setFooter({ text: `第${rollNo}投 · 残り${remaining} · 賭け ${fmtEther(bet).replace(" ◈", "◈")}` });
    await reply.edit({ embeds: [e], components: [] }).catch(() => undefined);
    await sleep(220);
  }
}

export async function playChinchiro(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  betRaw: number,
): Promise<void> {
  const uid = interaction.user.id;
  const check = await validateBet(interaction as ChatInputCommandInteraction, services, betRaw, betRaw * MAX_MULT);
  if (!check.ok) return;
  if (!acquireSeat(uid)) {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: "まだ前の勝負が終わっていない。", flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: "まだ前の勝負が終わっていない。", flags: MessageFlags.Ephemeral });
    }
    return;
  }
  try {
    await runRound(interaction, services, check.bet);
  } finally {
    releaseSeat(uid);
  }
}

async function runRound(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  bet: number,
): Promise<void> {
  const uid = interaction.user.id;
  const startEmbed = new EmbedBuilder()
    .setTitle("🎲 チンチロ")
    .setColor(MAMMON_COLOR)
    .setDescription(
      ["さあ、振れ。", "", "┃ ❓ ┃ ❓ ❓ ❓ ┃", "", `ベット: ${fmtEther(bet)} ／ 最大3投`].join("\n"),
    );
  let reply: Message;
  if (interaction.replied || interaction.deferred) {
    reply = (await interaction.followUp({ embeds: [startEmbed] })) as Message;
  } else {
    await interaction.reply({ embeds: [startEmbed] });
    reply = (await interaction.fetchReply()) as Message;
  }
  await sleep(700);

  // ── プレイヤーの振り ──
  let playerDice: Dice = [1, 1, 1] as const;
  let playerHand: Hand = { type: "menashi" };
  let playerLocked = false;
  // 二度振りの権: 装備してればプレイヤーの投数を +1
  const rerollGranted = services.items.consumeReroll(uid);
  const playerMaxRolls = MAX_ROLLS + (rerollGranted ? 1 : 0);
  void rerollGranted;

  for (let rollNo = 1; rollNo <= playerMaxRolls && !playerLocked; rollNo++) {
    const remaining = playerMaxRolls - rollNo + 1;
    await shakeAnimation(reply, [], bet, rollNo, remaining);
    playerDice = rollDice();
    playerHand = evaluate(playerDice);

    if (isTerminal(playerHand)) {
      // 終了役 → 即確定
      break;
    }

    if (playerHand.type === "menashi") {
      if (rollNo < playerMaxRolls) {
        // 自動再振り
        await reply
          .edit({
            embeds: [
              new EmbedBuilder()
                .setTitle("🎲 チンチロ")
                .setColor(MAMMON_COLOR)
                .setDescription([describe(playerHand), "", diceDisplay(playerDice), "", `第${rollNo}投 → 自動で再振り…（残り${playerMaxRolls - rollNo}）`].join("\n")),
            ],
            components: [],
          })
          .catch(() => undefined);
        await sleep(1500);
        continue;
      }
      break; // 最終投メナシ → 確定
    }

    // 目 → 選択
    if (playerHand.type === "me") {
      if (rollNo >= playerMaxRolls) break;
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("chinchiro:stop")
          .setLabel(`✋ 止める（${playerHand.score}）`)
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId("chinchiro:reroll")
          .setLabel(`🎲 もう一度振る（残り${playerMaxRolls - rollNo}）`)
          .setStyle(ButtonStyle.Danger),
      );
      const e = new EmbedBuilder()
        .setTitle("🎲 チンチロ")
        .setColor(MAMMON_COLOR)
        .setDescription(
          [
            describe(playerHand),
            "",
            diceDisplay(playerDice),
            "",
            `**止めるか、もう一度振るか…**（残り ${playerMaxRolls - rollNo}回）`,
            rerollGranted ? "✨ 二度振りの権が効いている（+1投）" : "",
            "・**止める** → 今の目で決着",
            "・**もう一度振る** → 上書き。ヒフミやメナシ続きのリスクあり",
          ].filter(Boolean).join("\n"),
        );
      await reply.edit({ embeds: [e], components: [row] }).catch(() => undefined);

      const choice = await new Promise<"stop" | "reroll">((resolve) => {
        const collector = reply.createMessageComponentCollector({
          componentType: ComponentType.Button,
          time: ROLL_BUTTON_TIMEOUT_MS,
          filter: (i) => i.user.id === uid && i.customId.startsWith("chinchiro:"),
        });
        collector.on("collect", async (btn) => {
          await btn.deferUpdate();
          if (btn.customId === "chinchiro:stop") {
            collector.stop("stop");
            resolve("stop");
          } else {
            collector.stop("reroll");
            resolve("reroll");
          }
        });
        collector.on("end", (_c, reason) => {
          if (reason !== "stop" && reason !== "reroll") resolve("stop"); // 時間切れは保守的に止める
        });
      });
      if (choice === "stop") {
        playerLocked = true;
        break;
      }
    }
  }

  // ── マモンの振り（同じシェイクアニメ） ──
  await reply
    .edit({
      embeds: [
        new EmbedBuilder()
          .setTitle("🎲 チンチロ — マモンの番")
          .setColor(MAMMON_COLOR)
          .setDescription(
            [
              `あなた: ${diceDisplay(playerDice)}`,
              `　└ ${describe(playerHand)}`,
              "",
              "マモン: ┃ ❓ ┃ ❓ ❓ ❓ ┃",
            ].join("\n"),
          ),
      ],
      components: [],
    })
    .catch(() => undefined);
  await sleep(1200);

  let dealerDice: Dice = [1, 1, 1] as const;
  let dealerHand: Hand = { type: "menashi" };
  for (let rollNo = 1; rollNo <= MAX_ROLLS; rollNo++) {
    for (let f = 0; f < 4; f++) {
      const shake: Dice = [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)] as const;
      const e = new EmbedBuilder()
        .setTitle("🎲 チンチロ — マモンの番")
        .setColor(MAMMON_COLOR)
        .setDescription(
          [
            `あなた: ${diceDisplay(playerDice)}`,
            `　└ ${describe(playerHand)}`,
            "",
            `マモン: ${diceDisplay(shake)}`,
            `第${rollNo}投（残り${MAX_ROLLS - rollNo + 1}）`,
          ].join("\n"),
        );
      await reply.edit({ embeds: [e], components: [] }).catch(() => undefined);
      await sleep(220);
    }
    dealerDice = rollDice();
    dealerHand = evaluate(dealerDice);
    const willStop = isTerminal(dealerHand) || (dealerHand.type === "me" && dealerHand.score >= 5) || rollNo >= MAX_ROLLS;
    await reply
      .edit({
        embeds: [
          new EmbedBuilder()
            .setTitle("🎲 チンチロ — マモンの番")
            .setColor(MAMMON_COLOR)
            .setDescription(
              [
                `あなた: ${diceDisplay(playerDice)}`,
                `　└ ${describe(playerHand)}`,
                "",
                `マモン: ${diceDisplay(dealerDice)}`,
                `　└ ${describe(dealerHand)}`,
              ].join("\n"),
            ),
        ],
        components: [],
      })
      .catch(() => undefined);
    await sleep(willStop ? 1400 : 1000);
    if (willStop) break;
  }

  // ── 精算 ──
  const cmp = compare(playerHand, dealerHand);
  const mul = cmp.mul;
  const held = services.ether.balanceOf(uid);

  let payoutText = "";
  let title = "🎲 チンチロ — 対 マモン";
  let color = LOSE_COLOR;
  let extraNote = "";
  let netForDisplay = 0;

  let amuletNote = "";
  if (mul > 0) {
    // 勝ち: profit = bet * mul * (1 - edge)、payout = bet + profit
    const profit = Math.floor(bet * mul * (1 - HOUSE_EDGE));
    const rawPayout = bet + profit;
    const amulet = applyAmulets(services, uid, bet, rawPayout);
    if (amulet.note) amuletNote = `✨ ${amulet.note}`;
    const settled = services.casino.settle(uid, "チンチロ", bet, amulet.payout);
    color = WIN_COLOR;
    netForDisplay = settled.net;
    const chainLine = settled.chainBonus > 0
      ? `\n${settled.chainLabel} 連鎖 **${settled.chainStreak}連勝** ×${settled.chainMult.toFixed(2)} → **+${fmtEther(settled.chainBonus)}**`
      : "";
    const fukuLine = settled.fukuTax > 0
      ? `\n⚖️ 福の重み ${Math.round(settled.fukuRate * 100)}% → ${fmtEther(settled.fukuTax)} 奉納`
      : "";
    payoutText = `💰 配当 ${fmtEther(settled.payout)}（利益 +${fmtEther(settled.net)}）${chainLine}${fukuLine}`;
    broadcastBigWin(interaction.client, services, { userId: uid, game: "チンチロ", bet, payout: settled.payout });
  } else if (mul === 0) {
    // プッシュ（両方ヒフミ）: 返金
    services.casino.settle(uid, "チンチロ", bet, bet);
    color = MAMMON_COLOR;
    payoutText = `🌀 プッシュ：${fmtEther(bet)} を返金`;
  } else if (mul === -1) {
    // 通常負け: bet だけ徴収。ただし敗北保護お守りがあれば返金
    const lossAmulet = applyAmulets(services, uid, bet, 0);
    if (lossAmulet.note) amuletNote = `✨ ${lossAmulet.note}`;
    services.casino.settle(uid, "チンチロ", bet, lossAmulet.payout);
    netForDisplay = lossAmulet.payout - bet;
    payoutText = lossAmulet.payout > 0 ? `🛡 返金 ${fmtEther(lossAmulet.payout)}` : `💸 -${fmtEther(bet)}`;
  } else {
    // 倍付け負け: bet + (|mul|-1)*bet を徴収。残高不足なら通常負けフォールバック
    const extraNeeded = (Math.abs(mul) - 1) * bet;
    if (held >= bet + extraNeeded) {
      services.casino.settle(uid, "チンチロ", bet, 0);
      services.ether.transfer(uid, HOUSE_HOLDER, extraNeeded);
      const totalLoss = bet + extraNeeded;
      netForDisplay = -totalLoss;
      payoutText = `💀 -${fmtEther(totalLoss)}（${Math.abs(mul)}倍負け）`;
    } else {
      services.casino.settle(uid, "チンチロ", bet, 0);
      netForDisplay = -bet;
      payoutText = `💸 -${fmtEther(bet)}（残高不足で追加徴収なし）`;
      extraNote = "\n*※本来は倍付け負けだったが、残高不足のため通常負けにフォールバック*";
    }
  }

  const resultLabel =
    cmp.result === "player_win" ? "✨ **お前の勝ち！**" : cmp.result === "push" ? "🌀 **プッシュ**" : "😈 **マモンの勝ち**";
  const comparison = [
    "┌─ お前 ────────────┐",
    `│ ${diceDisplay(playerDice)}`,
    `│ ${describe(playerHand)}`,
    "└──────────────────┘",
    "┌─ マモン ──────────┐",
    `│ ${diceDisplay(dealerDice)}`,
    `│ ${describe(dealerHand)}`,
    "└──────────────────┘",
    "",
    resultLabel,
  ].join("\n");

  const resultEmbed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setDescription([comparison, "", payoutText + extraNote, amuletNote].filter(Boolean).join("\n"))
    .setFooter({ text: `所持: ${fmtEther(services.ether.balanceOf(uid))}` });

  const heldAfter = services.ether.balanceOf(uid);
  const min = MIN_BET;
  const max = Math.min(MAX_BET, heldAfter);
  const nextRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`chinchiro:retry:${min}`)
      .setLabel(`最低 ${min.toLocaleString()}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(heldAfter < min),
    new ButtonBuilder()
      .setCustomId(`chinchiro:retry:${bet}`)
      .setLabel(`🎰 もう一回 ${bet.toLocaleString()}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(heldAfter < bet),
    new ButtonBuilder()
      .setCustomId(`chinchiro:retry:${max}`)
      .setLabel(`最大 ${max.toLocaleString()}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(max < min),
    new ButtonBuilder().setCustomId("chinchiro:paytable").setLabel("📖 配当表").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("chinchiro:quit").setLabel("🚪 退席").setStyle(ButtonStyle.Secondary),
  );

  // 演出用の使わない値を silent（TS 気にせず）
  void netForDisplay;

  await reply.edit({ embeds: [resultEmbed], components: [nextRow] }).catch(() => undefined);

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 60_000,
    filter: (i) => i.user.id === uid,
  });
  collector.on("collect", async (btn) => {
    if (btn.customId === "chinchiro:paytable") {
      await btn.reply({ embeds: [paytableEmbed()], flags: MessageFlags.Ephemeral });
      return;
    }
    if (btn.customId === "chinchiro:quit") {
      collector.stop("quit");
      await btn.deferUpdate();
      await reply.edit({ components: [] }).catch(() => undefined);
      return;
    }
    if (btn.customId.startsWith("chinchiro:retry:")) {
      collector.stop("retry");
      const retryBet = Number(btn.customId.split(":")[2]);
      if (retryBet < MIN_BET || retryBet > MAX_BET) return;
      await btn.deferUpdate();
      releaseSeat(uid);
      if (acquireSeat(uid)) {
        try {
          await runRound(btn, services, retryBet);
        } finally {
          releaseSeat(uid);
        }
      }
    }
  });
  collector.on("end", async (_c, reason) => {
    if (reason !== "retry" && reason !== "quit") await reply.edit({ components: [] }).catch(() => undefined);
  });
}
