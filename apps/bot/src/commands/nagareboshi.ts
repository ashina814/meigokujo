import { randomUUID } from "node:crypto";
import {
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { HOUSE_HOLDER, JACKPOT_HOLDER } from "@meigokujo/core";
import { fmtEther } from "../format.js";
import type { Services } from "../services.js";

/**
 * @deprecated slash registrationから退役済み。流れ星は`/賭場` のhome/panelから利用する。
 * /流れ星 — 賭場占い（casino-bot /流れ星 準拠）。
 * 1日5回まで（初回無料、2〜5回目は 1,000 Ld を胴元へ）。
 * 報酬は基本ナシ（フレーバー）、稀に「流れ星」結果で JP プールから 10,000 Ld 支給。
 * 設計意図: 利用可能額を回収してインフレを抑制し、賭けじゃない遊びを増やす。
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

function pickOutcome(services: Services): Outcome {
  return services.rng.weighted(OUTCOMES.map((o) => [o, o.weight]));
}

/**
 * 1回ぶんの確定結果。`result_json` に保存され、同じ操作の再試行はここから再生される
 * （抽選結果も含むので、二度目も同じ運勢・同じ報酬が返る）。
 */
export type DrawRecord =
  | { ok: true; used: number; fee: number; outcomeKey: string; line: string; paid: number }
  | { ok: false; reason: "limit" }
  | { ok: false; reason: "funds"; fee: number; held: number };

const now = () => Math.floor(Date.now() / 1000);

/** casino_nagareboshi テーブル: user_id, day_key（YYYY-MM-DD JST）, count */
export function ensureNagareboshiTable(services: Services): void {
  services.db.exec(`
    CREATE TABLE IF NOT EXISTS casino_nagareboshi (
      user_id TEXT NOT NULL,
      day_key TEXT NOT NULL,
      count   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day_key)
    );
  `);
}

export function todayJst(): string {
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

/**
 * 1回ぶんの占い。料金・利用回数・抽選・報酬を**ひとつの業務グループ**で行う。
 *
 * 別々のグループにすると「料金だけ取られて回数が増えない」「回数だけ増えて報酬が落ちる」が
 * 起こりうるうえ、同じ操作を二度実行すると回数も料金も二重になる。
 * 利用回数・残高の判定もグループの中に置き（成功後の再試行を「もう5回引いた」で落とさない）、
 * 抽選結果も保存するので、再試行は同じ運勢・同じ報酬をそのまま返す。
 */
export function drawNagareboshi(services: Services, uid: string, day: string, operationId: string): DrawRecord {
  return services.chips.runGroup(
    { groupKey: `nagareboshi:${uid}:${operationId}`, kind: "solo_game", actorId: uid },
    (): DrawRecord => {
      const used = getCount(services, uid, day);
      if (used >= MAX_PER_DAY) return { ok: false, reason: "limit" };
      const fee = used === 0 ? 0 : FEE;
      const held = services.chips.balanceOf(uid);
      if (fee > 0 && held < fee) return { ok: false, reason: "funds", fee, held };
      if (fee > 0) services.chips.transfer(uid, HOUSE_HOLDER, fee, { reason: "流れ星の祈り代", game: "流れ星" });
      incCount(services, uid, day);

      const outcome = pickOutcome(services);
      const line = services.rng.pick(outcome.lines);
      let paid = 0;
      if (outcome.reward) {
        // JPプールが満額に届かなくても、有るだけ払う（流れ星を空砲にしない）
        paid = Math.min(outcome.reward, services.chips.balanceOf(JACKPOT_HOLDER));
        if (paid > 0) services.chips.transfer(JACKPOT_HOLDER, uid, paid, { reason: "流れ星の褒賞", game: "流れ星" });
      }
      return { ok: true, used, fee, outcomeKey: outcome.key, line, paid };
    },
  );
}

export async function handleNagareboshiCommand(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
): Promise<void> {
  ensureNagareboshiTable(services);
  const uid = interaction.user.id;
  const day = todayJst();

  const draw = drawNagareboshi(services, uid, day, interaction.id);

  if (!draw.ok) {
    const content =
      draw.reason === "limit"
        ? `今日はもう ${MAX_PER_DAY}回 引いた。明日また来い。`
        : `占い料 ${fmtEther(draw.fee)} に足りない（所持 ${fmtEther(draw.held)}）。`;
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    return;
  }

  const { used, fee, line, paid } = draw;
  const outcome = OUTCOMES.find((o) => o.key === draw.outcomeKey)!;
  let rewardLine = "";
  if (outcome.reward) {
    rewardLine =
      paid > 0
        ? `\n\n💰 **+${fmtEther(paid)}**（JPプールから${paid < outcome.reward ? "・プール残が少なく減額" : ""}）`
        : "\n\n……が、JPプールが空だった。マモンが気まずそうに目を逸らす。";
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
        fee > 0 ? `占い料 ${fmtEther(fee).replace(" Ld", "Ld")}` : "無料",
        `所持 ${fmtEther(services.chips.balanceOf(uid)).replace(" Ld", "Ld")}`,
      ].join(" · "),
    });
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
