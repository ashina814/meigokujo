import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import { HOUSE_HOLDER, JACKPOT_HOLDER } from "@meigokujo/core";
import { fmtEther } from "../format.js";
import { LOSE_COLOR, MAMMON_COLOR, MAX_BET, MIN_BET, WIN_COLOR, sleep } from "./common.js";

/**
 * 🏇 マモンの賭場 競馬（シンプル版）。
 * - 6頭固定馬・単勝/複勝（3着以内）の2種類の賭け
 * - 手動 /競馬 開始 で 60秒受付 → レース進行（数ターンのアニメーション）→ パリミュチュエル配当
 * - 場代10%を JP プールへ、残りを的中者に賭け額比で分配
 */
const LOBBY_SEC = 60;
const TRACK_LENGTH = 20;
const TURN_MS = 1400;
const HOUSE_RATE = 0.1;

interface Horse {
  id: number;
  name: string;
  emoji: string;
  baseSpeed: number; // 1-10
}

const HORSES: readonly Horse[] = [
  { id: 1, name: "冥馬・獄炎", emoji: "🔥", baseSpeed: 7 },
  { id: 2, name: "冥馬・霧影", emoji: "👻", baseSpeed: 6 },
  { id: 3, name: "冥馬・雷牙", emoji: "⚡", baseSpeed: 8 },
  { id: 4, name: "冥馬・骨鎧", emoji: "💀", baseSpeed: 5 },
  { id: 5, name: "冥馬・血月", emoji: "🌙", baseSpeed: 7 },
  { id: 6, name: "冥馬・魔王", emoji: "😈", baseSpeed: 6 },
] as const;

type BetType = "win" | "place";

interface Bet {
  userId: string;
  horseId: number;
  type: BetType;
  amount: number;
}

const activeSessions = new Set<string>();

export async function playKeiba(interaction: ChatInputCommandInteraction, services: import("../services.js").Services): Promise<void> {
  const channelId = interaction.channelId;
  if (activeSessions.has(channelId)) {
    await interaction.reply({ content: "この卓は既にレース中。", flags: MessageFlags.Ephemeral });
    return;
  }
  activeSessions.add(channelId);
  try {
    await runSession(interaction, services);
  } finally {
    activeSessions.delete(channelId);
  }
}

async function runSession(interaction: ChatInputCommandInteraction, services: import("../services.js").Services): Promise<void> {
  const bets = new Map<string, Bet[]>(); // userId -> bets
  const endAt = Date.now() + LOBBY_SEC * 1000;

  const buildLobby = (secondsLeft: number) => {
    const totalByHorseWin = new Map<number, number>();
    const totalByHorsePlace = new Map<number, number>();
    for (const arr of bets.values()) {
      for (const b of arr) {
        const map = b.type === "win" ? totalByHorseWin : totalByHorsePlace;
        map.set(b.horseId, (map.get(b.horseId) ?? 0) + b.amount);
      }
    }
    const horseLines = HORSES.map((h) => {
      const w = totalByHorseWin.get(h.id) ?? 0;
      const p = totalByHorsePlace.get(h.id) ?? 0;
      return `${h.emoji} **${h.id}. ${h.name}** — 単 ${fmtEther(w)} / 複 ${fmtEther(p)}`;
    });
    return new EmbedBuilder()
      .setTitle("🏇 冥馬レース — 受付中")
      .setColor(MAMMON_COLOR)
      .setDescription(
        [
          `締切まで **${secondsLeft}秒**。1人何口でも張れる。`,
          "**単勝**: 1着的中で配当 / **複勝**: 3着以内で配当（場代10%）",
          "",
          ...horseLines,
        ].join("\n"),
      );
  };

  const rows = () => [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("keiba:bet:win").setLabel("単勝に張る").setEmoji("🎯").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("keiba:bet:place").setLabel("複勝に張る").setEmoji("🥉").setStyle(ButtonStyle.Success),
    ),
  ];

  await interaction.reply({ embeds: [buildLobby(LOBBY_SEC)], components: rows() });
  const reply = (await interaction.fetchReply()) as Message;

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) => i.customId.startsWith("keiba:bet:"),
    time: LOBBY_SEC * 1000,
  });

  collector.on("collect", (btn: ButtonInteraction) => {
    void (async () => {
      const type = btn.customId.split(":")[2] as BetType;
      const modal = new ModalBuilder()
        .setCustomId(`keiba:bet:${type}:${btn.id}`)
        .setTitle(`${type === "win" ? "単勝" : "複勝"} に張る`)
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId("horse").setLabel("馬番号（1-6）").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(1),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("amount")
              .setLabel(`賭ける額（${MIN_BET}〜${MAX_BET.toLocaleString()}）`)
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(9),
          ),
        );
      await btn.showModal(modal);
      const sub = await btn.awaitModalSubmit({ time: 55_000, filter: (m) => m.customId === `keiba:bet:${type}:${btn.id}` }).catch(() => null);
      if (!sub) return;
      const horseId = Number(sub.fields.getTextInputValue("horse").trim());
      const amt = Number(sub.fields.getTextInputValue("amount").replaceAll(",", "").trim());
      if (!HORSES.some((h) => h.id === horseId)) {
        await sub.reply({ content: "馬番号は 1-6 で。", flags: MessageFlags.Ephemeral });
        return;
      }
      if (!Number.isInteger(amt) || amt < MIN_BET || amt > MAX_BET) {
        await sub.reply({ content: `賭け額は ${MIN_BET}〜${MAX_BET.toLocaleString()} ◈ で。`, flags: MessageFlags.Ephemeral });
        return;
      }
      if (services.ether.balanceOf(btn.user.id) < amt) {
        await sub.reply({ content: "エテル残高が足りない。", flags: MessageFlags.Ephemeral });
        return;
      }
      services.ether.transfer(btn.user.id, HOUSE_HOLDER, amt);
      const arr = bets.get(btn.user.id) ?? [];
      arr.push({ userId: btn.user.id, horseId, type, amount: amt });
      bets.set(btn.user.id, arr);
      await sub.reply({
        content: `✅ ${type === "win" ? "単勝" : "複勝"} ${horseId}番 に ${fmtEther(amt)} を張った。`,
        flags: MessageFlags.Ephemeral,
      });
      await interaction.editReply({ embeds: [buildLobby(Math.max(0, Math.ceil((endAt - Date.now()) / 1000)))] }).catch(() => undefined);
    })();
  });

  // 残り時間表示
  for (const left of [30, 15, 5] as const) {
    const wait = endAt - left * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    if (collector.ended) break;
    await interaction.editReply({ embeds: [buildLobby(left)] }).catch(() => undefined);
  }
  await new Promise<void>((resolve) => collector.once("end", () => resolve()));

  const allBets: Bet[] = [];
  for (const arr of bets.values()) allBets.push(...arr);
  if (allBets.length === 0) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🏇 冥馬レース — 不成立")
          .setColor(LOSE_COLOR)
          .setDescription("誰も張らなかった。レースは流れた。"),
      ],
      components: [],
    });
    return;
  }

  // ── レース進行 ──
  const positions = new Map<number, number>(HORSES.map((h) => [h.id, 0]));
  const finished: number[] = []; // ゴール順

  const renderTrack = () => {
    const lines = HORSES.map((h) => {
      const pos = Math.min(TRACK_LENGTH, positions.get(h.id) ?? 0);
      const filled = "▰".repeat(pos);
      const empty = "▱".repeat(TRACK_LENGTH - pos);
      const rank = finished.indexOf(h.id);
      const rankMark = rank >= 0 ? ` [${rank + 1}着]` : "";
      return `${h.emoji} ${h.id}. ${filled}${h.emoji}${empty} 🏁${rankMark}`;
    });
    return lines.join("\n");
  };

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("🏇 冥馬レース — スタート！")
        .setColor(MAMMON_COLOR)
        .setDescription(renderTrack()),
    ],
    components: [],
  });

  // 最大 30 ターン（安全弁）
  for (let turn = 0; turn < 30 && finished.length < HORSES.length; turn++) {
    await sleep(TURN_MS);
    for (const h of HORSES) {
      if (finished.includes(h.id)) continue;
      const step = 1 + Math.floor(Math.random() * (h.baseSpeed / 2)); // 1..speed/2+
      const noise = Math.random() < 0.15 ? -1 : 0; // 15%で足踏み
      const cur = positions.get(h.id) ?? 0;
      const next = Math.max(0, Math.min(TRACK_LENGTH, cur + step + noise));
      positions.set(h.id, next);
      if (next >= TRACK_LENGTH && !finished.includes(h.id)) {
        finished.push(h.id);
      }
    }
    await interaction.editReply({
      embeds: [
        new EmbedBuilder().setTitle("🏇 冥馬レース").setColor(MAMMON_COLOR).setDescription(renderTrack()),
      ],
    }).catch(() => undefined);
  }
  // 残った馬は最終位置順で決定
  const remaining = HORSES.filter((h) => !finished.includes(h.id))
    .sort((a, b) => (positions.get(b.id) ?? 0) - (positions.get(a.id) ?? 0));
  for (const h of remaining) finished.push(h.id);

  // ── 精算（パリミュチュエル）──
  const winnerId = finished[0]!;
  const placeIds = new Set(finished.slice(0, 3));
  const winBets = allBets.filter((b) => b.type === "win");
  const placeBets = allBets.filter((b) => b.type === "place");
  const winPool = winBets.reduce((s, b) => s + b.amount, 0);
  const placePool = placeBets.reduce((s, b) => s + b.amount, 0);
  const winHit = winBets.filter((b) => b.horseId === winnerId);
  const placeHit = placeBets.filter((b) => placeIds.has(b.horseId));
  const winHitTotal = winHit.reduce((s, b) => s + b.amount, 0);
  const placeHitTotal = placeHit.reduce((s, b) => s + b.amount, 0);

  const winCut = Math.floor(winPool * HOUSE_RATE);
  const placeCut = Math.floor(placePool * HOUSE_RATE);
  if (winCut > 0) services.ether.transfer(HOUSE_HOLDER, JACKPOT_HOLDER, winCut);
  if (placeCut > 0) services.ether.transfer(HOUSE_HOLDER, JACKPOT_HOLDER, placeCut);
  const winDistributable = winPool - winCut;
  const placeDistributable = placePool - placeCut;

  // 単勝分配: 的中者に賭け額比で
  for (const b of winHit) {
    if (winHitTotal === 0) break;
    const payout = Math.floor((winDistributable * b.amount) / winHitTotal);
    if (payout > 0) services.ether.transfer(HOUSE_HOLDER, b.userId, payout);
  }
  // 複勝分配
  for (const b of placeHit) {
    if (placeHitTotal === 0) break;
    const payout = Math.floor((placeDistributable * b.amount) / placeHitTotal);
    if (payout > 0) services.ether.transfer(HOUSE_HOLDER, b.userId, payout);
  }
  // 的中者がいなかった分は JP へ（キャリーオーバー相当）
  if (winHit.length === 0 && winDistributable > 0) services.ether.transfer(HOUSE_HOLDER, JACKPOT_HOLDER, winDistributable);
  if (placeHit.length === 0 && placeDistributable > 0) services.ether.transfer(HOUSE_HOLDER, JACKPOT_HOLDER, placeDistributable);

  const winnerHorse = HORSES.find((h) => h.id === winnerId)!;
  const top3 = finished.slice(0, 3).map((id, i) => {
    const h = HORSES.find((x) => x.id === id)!;
    const medal = ["🥇", "🥈", "🥉"][i]!;
    return `${medal} ${h.emoji} ${h.name}`;
  });
  const winOdds = winHitTotal > 0 ? (winDistributable / winHitTotal).toFixed(2) : "—";
  const placeOdds = placeHitTotal > 0 ? (placeDistributable / placeHitTotal).toFixed(2) : "—";

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(`🏇 冥馬レース — 勝者 ${winnerHorse.emoji} ${winnerHorse.name}`)
        .setColor(WIN_COLOR)
        .setDescription(
          [
            "**順位**",
            ...top3,
            "",
            `**単勝配当倍率**: ${winOdds} 倍（プール ${fmtEther(winPool)}・場代 ${fmtEther(winCut)}）`,
            `**複勝配当倍率**: ${placeOdds} 倍（プール ${fmtEther(placePool)}・場代 ${fmtEther(placeCut)}）`,
            "",
            renderTrack(),
          ].join("\n"),
        ),
    ],
    components: [],
    allowedMentions: { parse: [] },
  });
}
