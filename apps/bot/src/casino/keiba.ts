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
import { MAX_BET, MIN_BET, sleep } from "./common.js";
import { C_LOSE, C_MAMMON, C_WIN, E, buildLobbyEmbed } from "./ui.js";

/**
 * 🏇 マモンの賭場 競馬（シンプル版）。
 * - 6頭固定馬・単勝/複勝（3着以内）の2種類の賭け
 * - 手動 /競馬 開始 で 60秒受付 → レース進行（数ターンのアニメーション）→ パリミュチュエル配当
 * - 場代10%を JP プールへ、残りを的中者に賭け額比で分配
 */
const LOBBY_SEC = 60;
const TRACK_LENGTH = 20;
const BASE_TURN_MS = 1600;
const FINAL_STRAIGHT_MS = 2400;
const HOUSE_RATE = 0.1;

/** 走法。casino-bot 準拠。序盤/中盤/終盤で伸びる馬が変わる */
type Style = "nige" | "senko" | "sashi" | "oikomi";

const STYLE_LABEL: Record<Style, string> = {
  nige: "逃げ",
  senko: "先行",
  sashi: "差し",
  oikomi: "追込",
};

interface Horse {
  id: number;
  name: string;
  emoji: string;
  baseSpeed: number; // 1-10
  style: Style;
}

const HORSES: readonly Horse[] = [
  { id: 1, name: "冥馬・獄炎", emoji: "🔥", baseSpeed: 7, style: "nige" },
  { id: 2, name: "冥馬・霧影", emoji: "👻", baseSpeed: 6, style: "sashi" },
  { id: 3, name: "冥馬・雷牙", emoji: "⚡", baseSpeed: 8, style: "senko" },
  { id: 4, name: "冥馬・骨鎧", emoji: "💀", baseSpeed: 5, style: "oikomi" },
  { id: 5, name: "冥馬・血月", emoji: "🌙", baseSpeed: 7, style: "sashi" },
  { id: 6, name: "冥馬・魔王", emoji: "😈", baseSpeed: 6, style: "nige" },
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
    let totalWin = 0;
    let totalPlace = 0;
    for (const arr of bets.values()) {
      for (const b of arr) {
        if (b.type === "win") {
          totalByHorseWin.set(b.horseId, (totalByHorseWin.get(b.horseId) ?? 0) + b.amount);
          totalWin += b.amount;
        } else {
          totalByHorsePlace.set(b.horseId, (totalByHorsePlace.get(b.horseId) ?? 0) + b.amount);
          totalPlace += b.amount;
        }
      }
    }
    const winPrize = Math.floor(totalWin * (1 - HOUSE_RATE));
    const placePrize = Math.floor(totalPlace * (1 - HOUSE_RATE));
    // 人気ランク（単勝賭け額の多い順）
    const popularity = [...HORSES]
      .map((h) => ({ id: h.id, stake: totalByHorseWin.get(h.id) ?? 0 }))
      .sort((a, b) => b.stake - a.stake);
    const popRank = new Map<number, number>();
    popularity.forEach((p, i) => { if (p.stake > 0) popRank.set(p.id, i + 1); });

    const horseLines = HORSES.map((h, i) => {
      const w = totalByHorseWin.get(h.id) ?? 0;
      const p = totalByHorsePlace.get(h.id) ?? 0;
      const winOdds = w > 0 ? `×${(winPrize / w).toFixed(2)}` : "—";
      const placeOdds = p > 0 ? `×${(placePrize / p).toFixed(2)}` : "—";
      const rank = popRank.get(h.id);
      const mark = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : "　";
      return `${mark} ${h.emoji} ${i + 1}. **${h.name}** ｜ ${STYLE_LABEL[h.style]}\n　└ 単勝 **${winOdds}**  ·  複勝 **${placeOdds}**`;
    });
    const embed = buildLobbyEmbed({
      game: "冥馬レース",
      title: "🏇  冥馬レース  ·  受付中",
      body: "賭けが入るたびにオッズは変動する。**単勝**: 1着的中  /  **複勝**: 3着以内で配当（場代10% → JPプール）",
      secondsLeft,
      totalBet: totalWin + totalPlace,
    });
    embed.addFields(
      {
        name: "▸ プール",
        value: [
          `${E.bet}  **単勝** ${fmtEther(totalWin).replace(" ◈", "◈")}  →  賞金プール ${fmtEther(winPrize).replace(" ◈", "◈")}`,
          `${E.up}  **複勝** ${fmtEther(totalPlace).replace(" ◈", "◈")}  →  賞金プール ${fmtEther(placePrize).replace(" ◈", "◈")}`,
        ].join("\n"),
        inline: false,
      },
      { name: "▸ 出走馬  ·  概算オッズ", value: horseLines.join("\n"), inline: false },
    );
    return embed;
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
          .setAuthor({ name: "マモンの賭場 · 冥馬レース" })
          .setColor(C_LOSE)
          .setTitle("🏇  不成立")
          .setDescription("誰も張らなかった。レースは流れた。"),
      ],
      components: [],
    });
    return;
  }

  // ── レース進行 ──
  const positions = new Map<number, number>(HORSES.map((h) => [h.id, 0]));
  const finished: number[] = []; // ゴール順
  // 馬ごとのコンディション（0.8〜1.2）
  const conditions = new Map<number, number>(HORSES.map((h) => [h.id, 0.8 + Math.random() * 0.4]));

  const buildLane = (pos: number) => {
    const p = Math.max(0, Math.min(TRACK_LENGTH, Math.floor(pos)));
    return "▰".repeat(p) + "▱".repeat(TRACK_LENGTH - p) + " 🏁";
  };

  const renderBoard = () => {
    const ranking = [...HORSES].sort((a, b) => (positions.get(b.id) ?? 0) - (positions.get(a.id) ?? 0));
    return ranking
      .map((h, idx) => {
        const finishedRank = finished.indexOf(h.id);
        const marker = finishedRank >= 0 ? ` **[${finishedRank + 1}着]**` : "";
        return `${idx + 1}. ${h.emoji} **${h.name}**${marker}\n　${buildLane(positions.get(h.id) ?? 0)}`;
      })
      .join("\n");
  };

  // 異常終了時は全額返金（casino-bot の rollbackRaceBets 相当）
  try {
    await runRaceAndSettle();
  } catch (e) {
    console.error("[keiba] レース異常終了・全額返金:", e);
    for (const b of allBets) {
      try {
        services.ether.transfer(HOUSE_HOLDER, b.userId, b.amount);
      } catch {
        /* houseに残っているはずだが念のため */
      }
    }
    await interaction
      .editReply({
        content: "",
        embeds: [
          new EmbedBuilder()
            .setAuthor({ name: "マモンの賭場 · 冥馬レース" })
            .setColor(C_LOSE)
            .setTitle("🏇  レース中断")
            .setDescription("システムエラーでレースが流れた。賭け金は全額返金した。"),
        ],
        components: [],
      })
      .catch(() => undefined);
    return;
  }
  return;

  async function runRaceAndSettle(): Promise<void> {
  await interaction.editReply({
    content: "🚦 **三、二、一…スタート！**",
    embeds: [
      new EmbedBuilder()
        .setAuthor({ name: "マモンの賭場 · 冥馬レース" })
        .setColor(C_MAMMON)
        .setTitle("🏇  レース開始")
        .setDescription(renderBoard()),
    ],
    components: [],
  });
  await sleep(1600);

  let prevLeaderId: number | null = null;
  let finalStraightAnnounced = false;

  // 最大 15 ターン（安全弁）
  for (let turn = 1; turn <= 15 && finished.length < HORSES.length; turn++) {
    // ── 移動（casino-bot 準拠: 走法 × 進捗 × コンディション × 乱数）──
    for (const h of HORSES) {
      if (finished.includes(h.id)) continue;
      const current = positions.get(h.id) ?? 0;
      const progress = current / TRACK_LENGTH; // 0..1
      const styleBonus =
        h.style === "nige"
          ? 0.4 * (1 - progress) // 序盤に伸びる
          : h.style === "senko"
            ? 0.25                // 常に安定
            : h.style === "sashi"
              ? 0.35 * progress   // 中盤〜終盤
              : 0.45 * progress;  // 追込は終盤爆発
      const randomFactor = 0.75 + Math.random() * 0.5;
      const move = h.baseSpeed * 0.35 * (conditions.get(h.id) ?? 1) * randomFactor + styleBonus;
      const next = Math.min(TRACK_LENGTH, current + move);
      positions.set(h.id, next);
      if (next >= TRACK_LENGTH && !finished.includes(h.id)) {
        finished.push(h.id);
      }
    }

    // ── 順位 & 実況 ──
    const ranking = [...HORSES].sort((a, b) => (positions.get(b.id) ?? 0) - (positions.get(a.id) ?? 0));
    const leaderPos = positions.get(ranking[0]!.id) ?? 0;
    const remain = TRACK_LENGTH - leaderPos;

    const commentary: string[] = [];
    if (prevLeaderId !== null && prevLeaderId !== ranking[0]!.id) {
      const oldLeader = HORSES.find((h) => h.id === prevLeaderId)?.name ?? "前の馬";
      commentary.push(`📢 **先頭交代！${ranking[0]!.name} が ${oldLeader} を抜いた！**`);
    }
    if (!finalStraightAnnounced && remain < 5) {
      finalStraightAnnounced = true;
      commentary.push("🔥 **さあ最終直線！勝つのはどっちだ…！？**");
    }
    if (finalStraightAnnounced && ranking[1]) {
      const secondPos = positions.get(ranking[1].id) ?? 0;
      const lead = leaderPos - secondPos;
      if (lead < 0.5 && remain < 4) {
        commentary.push(`⚔️ 並んだ！${ranking[0]!.name} と ${ranking[1].name} の叩き合い！`);
      } else if (lead < 1.5 && remain < 3) {
        commentary.push(`🏃 ${ranking[1].name} が猛追！差はわずか…！`);
      }
    }
    prevLeaderId = ranking[0]!.id;

    const header = `**Turn ${turn}** ・ 先頭 ${ranking[0]!.emoji} ${ranking[0]!.name}（残り ${remain.toFixed(1)}）`;
    await interaction.editReply({
      content: [header, ...commentary].join("\n"),
      embeds: [
        new EmbedBuilder()
          .setAuthor({ name: "マモンの賭場 · 冥馬レース" })
          .setColor(C_MAMMON)
          .setTitle(`🏇  レース進行  ·  Turn ${turn}`)
          .setDescription(renderBoard()),
      ],
    }).catch(() => undefined);

    await sleep(finalStraightAnnounced && remain < 5 ? FINAL_STRAIGHT_MS : BASE_TURN_MS);
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
    return `${medal} ${h.emoji} **${h.name}** ｜ ${STYLE_LABEL[h.style]}`;
  });
  const winOdds = winHitTotal > 0 ? (winDistributable / winHitTotal).toFixed(2) : "—";
  const placeOdds = placeHitTotal > 0 ? (placeDistributable / placeHitTotal).toFixed(2) : "—";

  await interaction.editReply({
    content: `🏆 **勝者** ${winnerHorse.emoji} **${winnerHorse.name}** — 単勝 ×${winOdds}`,
    embeds: [
      new EmbedBuilder()
        .setAuthor({ name: "マモンの賭場 · 冥馬レース" })
        .setColor(C_WIN)
        .setTitle(`🏇  勝者  ${winnerHorse.emoji}  ${winnerHorse.name}`)
        .setDescription(renderBoard())
        .addFields(
          { name: "▸ 着順", value: top3.join("\n"), inline: false },
          {
            name: "▸ 配当倍率",
            value: [
              `${E.bet}  **単勝 ×${winOdds}**  ·  プール ${fmtEther(winPool).replace(" ◈", "◈")}  ·  場代 ${fmtEther(winCut).replace(" ◈", "◈")}`,
              `${E.up}  **複勝 ×${placeOdds}**  ·  プール ${fmtEther(placePool).replace(" ◈", "◈")}  ·  場代 ${fmtEther(placeCut).replace(" ◈", "◈")}`,
            ].join("\n"),
            inline: false,
          },
        )
        .setFooter({ text: "場代は JPプールへ ─ 的中不在分もキャリーオーバー" }),
    ],
    components: [],
    allowedMentions: { parse: [] },
  });
  }
}
