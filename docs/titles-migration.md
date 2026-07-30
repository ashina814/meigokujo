# 称号カタログ刷新の移行手順

PR #28 で称号のキー体系が変わった。本番投入とロールバックの手順をここに残す。

## 方針: 旧行を消さない

旧キーの行を **書き換えず**、新キーの行を **追加する**。`granted_at` は旧行の値を引き継ぐ。

```
移行前:  titles(u1, veteran,     100)
移行後:  titles(u1, veteran,     100)   ← 残す
         titles(u1, dan_days_2,  100)   ← 追加（獲得時刻は同じ）
         title_key_migrations(u1, veteran, dan_days_2, <実行時刻>)
```

これを選んだ理由は、前回の本番投入でコードのロールバックが実際に必要になったため。
「DBだけ新形式に進んだ状態で旧コードに戻す」が現実的に起こり得る前提で組んでいる。

| 状況 | 挙動 |
| --- | --- |
| 新コード + 移行済みDB | 旧キーを新キーに解決し、重複を潰して表示 |
| **旧コード + 移行済みDB** | 旧キー行をそのまま表示。新キー行は未知キーとして無視される（`list` が飛ばす） |
| 移行を二度実行 | `INSERT OR IGNORE` と `title_key_migrations` のPKで何も起きない |
| 新旧どちらも所持 | 1件に潰れる。獲得時刻は古い方を採用 |

つまり **DBバックアップからの復元は最後の手段ではなく、そもそも不要** になっている。

## 対応表

| 旧キー | 新キー | 備考 |
| --- | --- | --- |
| `newborn` | （変更なし） | |
| `risen` | （変更なし） | |
| `recruiter` | `recruiter_1` | |
| `recruiter_gold` | `recruiter_5` | |
| `matchmaker` | `mitsugetsu_retired` | 蜜月は秘匿対象になったため廃止称号として記録のみ残す |
| `innkeeper` | `dan_room_2` | 旧「10回以上」を段位Ⅱ（5回）に寄せた |
| `veteran` | `dan_days_2` | 在城30日 |
| `elder` | `dan_days_3` | 在城100日 |
| `nightwalker` | （対応先なし） | 累計VC時間はランクの領分と整理。廃止称号として表示のみ残す |

## 投入手順

1. 事前に同席台帳を作っておく（任意・起動を最短にしたい場合）

   ```bash
   DB_PATH=/var/lib/meigokujo/meigokujo.db pnpm --filter @meigokujo/core companions:rebuild
   ```

2. 通常のデプロイ（pull → register → restart）

   起動時に以下が自動で走る。いずれも冪等。
   - 旧キー → 新キーの行追加
   - 同席台帳の全再計算（世代マーカー未記録 or dirty のときだけ）

3. 起動ログを確認する

   ```
   [vc] 同席台帳を再計算 (理由=generation セグメント=NNNNN件): NNN組 / NNNms
   ```

## ロールバック手順

コードを戻すだけでよい。DBはそのままにする。

```bash
git checkout <前のタグ> && systemctl restart meigokujo-bot
```

旧コードは旧キー行を読むので称号表示は元通りになる。新キー行・`title_key_migrations`・
`title_equips`・`vc_companions` は旧コードから参照されないまま残る（無害）。

## 将来の後片付け

旧コードへ戻す可能性が無くなってから、旧行を落とす。急ぐ理由はない（行数はごく小さい）。

```sql
-- 実行前に必ずバックアップを取る。移行台帳に記録がある旧行だけを対象にする
DELETE FROM titles
WHERE (user_id, title_key) IN (SELECT user_id, legacy_key FROM title_key_migrations);
```

削除後は `LEGACY_KEY_MAP`（`packages/core/src/titles/service.ts`）も空にできる。
ただし `mitsugetsu_retired` / `nightwalker` の廃止ルール定義は、
既得者の表示のために残し続ける。

## 同席台帳の再計算について

`vc_companions` は通常、セグメントを閉じるのと同一トランザクションで増分更新される。
全再計算が必要になるのは次の場合だけで、`settings` の
`vc_companions:generation` / `vc_companions:dirty` で検出する。

- **generation**: 世代マーカーが無い（導入直後）／集計アルゴリズムを変更した
- **dirty**: `closeAllDangling` による一括クローズが走った（増分を取り漏らす経路）

実測値（`tests/vc-companions-perf.test.ts`）:

| セグメント件数 | 所要時間 | ヒープ増加 |
| ---: | ---: | ---: |
| 200,000 | 約 0.5 秒 | 約 4 MB |

行はストリーミングで読むため、ヒープは件数に比例しない。生成される行数は住人数だけで
決まり（上限 N×(N−1)）、セグメント件数では増えない。60万件でも1.5秒程度の想定なので
起動時の同期実行で差し支えないと判断した。
