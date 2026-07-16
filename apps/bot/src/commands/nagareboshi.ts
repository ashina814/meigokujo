import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { HOUSE_HOLDER, JACKPOT_HOLDER } from "@meigokujo/core";
import { fmtEther } from "../format.js";
import { MAMMON_COLOR } from "../casino/common.js";
import type { Services } from "../services.js";

/**
 * /流れ星 — 賭場占い（casino-bot /流れ星 準拠）。
 * 1日5回まで（初回無料、2〜5回目は 1000◈ 消滅=胴元へ）。
 * 報酬は基本ナシ（フレーバー）、稀に「流れ星」結果で JP プールから 10,000◈ 支給。
 * 設計意図: エテル 100%回収でインフレ抑制、賭けじゃない遊びを増やす。
 */
const MAX_PER_DAY = 5;
const FEE = 1_000;
const NAGAREBOSHI_REWARD = 10_000;

interface Outcome {
  key: string;
  weight: number;
  label: string;
  color: number;
  reward?: number;
  lines: string[];
}

const OUTCOMES: readonly Outcome[] = [
  {
    key: "daikichi",
    weight: 5,
    label: "🌟 大吉",
    color: 0xf0b429,
    lines: [
      "今日は何やってもうまくいく日だ。強気で行け。",
      "絶好調。大胆にいけ。",
      "こんな並び、滅多に出ない。今のうちに稼げ。",
    ],
  },
  {
    key: "chukichi",
    weight: 15,
    label: "🎯 中吉",
    color: 0x22c55e,
    lines: [
      "悪くない日だ。慎重にいけばちゃんと伸びる。",
      "普段通りにやれ。ちょっと良いことがあるかもな。",
      "追い風だ。無理さえしなければ。",
    ],
  },
  {
    key: "shokichi",
    weight: 30,
    label: "🍀 小吉",
    color: 0x0ea5e9,
    lines: [
      "小さい良いこと、一つくらいあるかもな。深追いはするな。",
      "悪くはない。だが欲張ると一気にひっくり返るぞ。",
      "そっと一歩、で丁度いい日だ。",
    ],
  },
  {
    key: "kyou",
    weight: 30,
    label: "☁️ 凶",
    color: 0x7f1d1d,
    lines: [
      "今日は運が悪い。無理はするな。",
      "雲行きが怪しい。賭けるなら小さくいけ。",
      "様子見の日だ。動かないのも選択肢だな。",
    ],
  },
  {
    key: "daikyou",
    weight: 15,
    label: "💀 大凶",
    color: 0x3f0d0d,
    lines: [
      "……今日はやめとけ。本当に運が悪い。",
      "厳しいな。今日は何もしないのが一番だ。",
      "動けば動くほど絡まる日だ。休んどけ。",
    ],
  },
  {
    key: "nagareboshi",
    weight: 5,
    label: "✨ 流れ星",
    color: 0xf0b429,
    reward: NAGAREBOSHI_REWARD,
    lines: [
      "おいおい、流れ星だ！JPプールから施しをくれてやる。",
      "こいつは珍しい。願いごとが一つ叶ったな。",
    ],
  },
];

const TOTAL_WEIGHT = OUTCOMES.reduce((s, o) => s + o.weight, 0);

function pickOutcome(): Outcome {
  let roll = Math.random() * TOTAL_WEIGHT;
  for (const o of OUTCOMES) {
    roll -= o.weight;
    if (roll <= 0) return o;
  }
  return OUTCOMES[0]!;
}

const now = () => Math.floor(Date.now() / 1000);

/** casino_nagareboshi テーブル: user_id, day_key（YYYY-MM-DD JST）, count */
function ensureTable(services: Services): void {
  services.db.exec(`
    CREATE TABLE IF NOT EXISTS casino_nagareboshi (
      user_id TEXT NOT NULL,
      day_key TEXT NOT NULL,
      count   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day_key)
    );
  `);
}

function todayJst(): string {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function getCount(services: Services, uid: string, day: string): number {
  const row = services.db.prepare("SELECT count FROM casino_nagareboshi WHERE user_id = ? AND day_key = ?").get(uid, day) as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}

function incCount(services: Services, uid: string, day: string): void {
  services.db
    .prepare(
      `INSERT INTO casino_nagareboshi (user_id, day_key, count) VALUES (?, ?, 1)
       ON CONFLICT(user_id, day_key) DO UPDATE SET count = count + 1`,
    )
    .run(uid, day);
}

export const nagareboshiCommand = new SlashCommandBuilder()
  .setName("流れ星")
  .setDescription("✨ マモンの賭場占い（1日5回・初回無料）")
  .setDMPermission(false);

export async function handleNagareboshiCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  ensureTable(services);
  const uid = interaction.user.id;
  const day = todayJst();
  const used = getCount(services, uid, day);
  if (used >= MAX_PER_DAY) {
    await interaction.reply({
      content: `今日はもう ${MAX_PER_DAY}回 引いた。明日また来い。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const fee = used === 0 ? 0 : FEE;
  if (fee > 0 && services.ether.balanceOf(uid) < fee) {
    await interaction.reply({
      content: `占い料 ${fmtEther(fee)} に足りない（所持 ${fmtEther(services.ether.balanceOf(uid))}）。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (fee > 0) services.ether.transfer(uid, HOUSE_HOLDER, fee);
  incCount(services, uid, day);

  const outcome = pickOutcome();
  const line = outcome.lines[Math.floor(Math.random() * outcome.lines.length)]!;
  let rewardLine = "";
  if (outcome.reward) {
    const jpPool = services.ether.balanceOf(JACKPOT_HOLDER);
    // JPプールが満額に届かなくても、有るだけ払う（流れ星を空砲にしない）
    const paid = Math.min(outcome.reward, jpPool);
    if (paid > 0) {
      services.ether.transfer(JACKPOT_HOLDER, uid, paid);
      rewardLine = `\n\n💰 **+${fmtEther(paid)}**（JPプールから${paid < outcome.reward ? "・プール残が少なく減額" : ""}）`;
    } else {
      rewardLine = "\n\n……が、JPプールが空だった。マモンが気まずそうに目を逸らす。";
    }
  }

  const remaining = MAX_PER_DAY - used - 1;
  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · 占い" })
    .setColor(outcome.color)
    .setTitle(`${outcome.label}${outcome.reward ? "  ✨" : ""}`)
    .setDescription([`*「${line}」*`, rewardLine].filter(Boolean).join("\n"))
    .setFooter({
      text: [
        `今日の残り ${remaining}/${MAX_PER_DAY - 1}回`,
        fee > 0 ? `占い料 ${fmtEther(fee).replace(" ◈", "◈")}` : "無料",
        `所持 ${fmtEther(services.ether.balanceOf(uid)).replace(" ◈", "◈")}`,
      ].join(" · "),
    });
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
