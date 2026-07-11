import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import { fmtEther } from "../format.js";
import { Mammon } from "../mammon.js";
import type { Services } from "../services.js";
import { acquireSeat, releaseSeat, resultEmbed, sleep, validateBet } from "./common.js";

/**
 * 🎲 チンチロ（対マモン）。casino-bot の役・倍率・胴元戦略を踏襲。
 * - 最大3投。終了役（ピンゾロ/ゾロ目/シゴロ/ヒフミ）は即確定
 * - 役倍付け: ピンゾロ5倍 / ゾロ目3倍 / シゴロ2倍 / 目1倍。ヒフミは出した側が2倍払う
 * - 同点はマモン勝ち（ハウスエッジの根幹）。勝ち利益にはさらにエッジ4%
 * - 負けの倍付け徴収は残高が足りない分をスキップ（借金にはしない）
 */
const HOUSE_EDGE = 0.04;
const MAX_ROLLS = 3;
/** 最大配当 = ピンゾロ5倍の利益 + 元金 */
const MAX_MULT = 6;

type Dice = [number, number, number];
type Hand =
  | { type: "pinzoro" }
  | { type: "zorome"; value: number }
  | { type: "shigoro" }
  | { type: "hifumi" }
  | { type: "me"; score: number }
  | { type: "menashi" };

const DIE = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"] as const;

function roll(): Dice {
  return [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)];
}

function evaluate(dice: Dice): Hand {
  const [a, b, c] = [...dice].sort((x, y) => x - y) as Dice;
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

/** プレイヤー視点の純倍率（+利益 / -損失 / 0=プッシュ）。同点はマモン勝ち */
function compare(player: Hand, dealer: Hand): number {
  if (player.type === "hifumi" && dealer.type === "hifumi") return 0;
  if (player.type === "hifumi") return -2;
  if (dealer.type === "hifumi") return 2;
  const pr = handRank(player);
  const dr = handRank(dealer);
  if (pr > dr) return handBaseMul(player);
  if (pr < dr) return -handBaseMul(dealer);
  return -1;
}

function describe(h: Hand): string {
  switch (h.type) {
    case "pinzoro": return "🌟 **ピンゾロ**！（5倍）";
    case "zorome": return `🎯 **ゾロ目**！${h.value}-${h.value}-${h.value}（3倍）`;
    case "shigoro": return "🔥 **シゴロ**！4-5-6（2倍）";
    case "hifumi": return "💀 **ヒフミ**…1-2-3（倍付けで払う）";
    case "me": return `目は **${h.score}**`;
    case "menashi": return "目なし……";
  }
}

const show = (d: Dice) => d.map((v) => DIE[v]).join(" ");
/** 終了役なら振り直し不可 */
const isTerminal = (h: Hand) => h.type === "pinzoro" || h.type === "zorome" || h.type === "shigoro" || h.type === "hifumi";

export async function playChinchiro(
  interaction: ChatInputCommandInteraction,
  services: Services,
  betRaw: number,
): Promise<void> {
  const uid = interaction.user.id;
  const check = await validateBet(interaction, services, betRaw, betRaw * MAX_MULT);
  if (!check.ok) return;
  if (!acquireSeat(uid)) {
    await interaction.reply({ content: "まだ前の勝負が終わっていない。", flags: 64 });
    return;
  }
  const bet = check.bet;
  try {
    // ── プレイヤーの振り（最大3投・終了役は即確定・目/目なしは選択で振り直し）──
    let dice = roll();
    let hand = evaluate(dice);
    let rollNo = 1;

    const header = `🎲 **チンチロ** — 賭け ${fmtEther(bet)}（対マモン）`;
    const msg = await interaction.reply({ content: `${header}\n壺を振る……`, withResponse: true });
    const reply: Message | undefined = msg.resource?.message ?? undefined;
    if (!reply) throw new Error("reply unavailable");
    await sleep(900);

    while (rollNo < MAX_ROLLS && !isTerminal(hand)) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("cc:reroll").setLabel(`もう一度振る（残${MAX_ROLLS - rollNo}投）`).setEmoji("🎲").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("cc:stand").setLabel("この手で勝負").setEmoji("✊").setStyle(ButtonStyle.Success),
      );
      await interaction.editReply({
        content: [header, `第${rollNo}投: ${show(dice)}`, describe(hand), "", "振り直すか、この手で勝負するか。"].join("\n"),
        components: [row],
      });
      let choice: "reroll" | "stand";
      try {
        const btn = await reply.awaitMessageComponent({
          componentType: ComponentType.Button,
          filter: (i) => i.user.id === uid && i.customId.startsWith("cc:"),
          time: 45_000,
        });
        choice = btn.customId === "cc:reroll" ? "reroll" : "stand";
        await btn.deferUpdate();
      } catch {
        choice = "stand"; // 時間切れは手を保持
      }
      if (choice === "stand") break;
      rollNo += 1;
      dice = roll();
      hand = evaluate(dice);
      await interaction.editReply({ content: `${header}\n第${rollNo}投……`, components: [] });
      await sleep(800);
    }

    // ── マモンの振り（戦略: 終了役/目5-6は止め、他は振り直し・3投で強制確定）──
    await interaction.editReply({
      content: [header, `お前の手: ${show(dice)} — ${describe(hand)}`, "", `*「${Mammon.betPlaced()}」* マモンが壺を振る……`].join("\n"),
      components: [],
    });
    await sleep(1100);

    let dDice: Dice = roll();
    let dHand = evaluate(dDice);
    let dRoll = 1;
    while (dRoll < MAX_ROLLS && !isTerminal(dHand) && !(dHand.type === "me" && dHand.score >= 5)) {
      dRoll += 1;
      dDice = roll();
      dHand = evaluate(dDice);
      await sleep(500);
    }

    // ── 精算 ──
    const mul = compare(hand, dHand);
    const held = services.ether.balanceOf(uid);
    let net: number;
    if (mul > 0) {
      const profit = Math.floor(bet * mul * (1 - HOUSE_EDGE));
      services.casino.settle(uid, "chinchiro", bet, bet + profit);
      net = profit;
    } else if (mul === 0) {
      services.casino.settle(uid, "chinchiro", bet, bet); // プッシュ（記録のみ・返金）
      net = 0;
    } else {
      const loss = Math.min(held, bet * -mul); // 倍付けは払える分だけ（借金なし）
      services.casino.settle(uid, "chinchiro", loss, 0);
      net = -loss;
    }

    const lines = [
      `お前:　 ${show(dice)} — ${describe(hand)}`,
      `マモン: ${show(dDice)} — ${describe(dHand)}`,
      "",
      mul > 0
        ? `**勝ち！** 配当 ${fmtEther(bet + net)}（利益 ${fmtEther(net)}）`
        : mul === 0
          ? `**プッシュ。** ${fmtEther(bet)} は返す。`
          : mul < -1
            ? `**倍付け負け……** ${fmtEther(-net)} 没収`
            : `**負け。** ${fmtEther(-net)} 没収`,
    ];
    await interaction.editReply({
      content: "",
      components: [],
      embeds: [
        resultEmbed({
          title: `🎲 チンチロ — ${net > 0 ? `+${fmtEther(net)}` : net < 0 ? `-${fmtEther(-net)}` : "±0"}`,
          lines,
          net,
          balance: services.ether.balanceOf(uid),
        }),
      ],
    });
  } finally {
    releaseSeat(uid);
  }
}
