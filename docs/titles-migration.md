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
| `innkeeper` | `dan_room_2` | 旧「10回以上」を段位Ⅱ（5回）に寄せた |
| `veteran` | `dan_days_2` | 在城30日 |
| `elder` | `dan_days_3` | 在城100日 |
| `nightwalker` | （対応先なし・表示は残す） | 累計VC時間はランクの領分と整理。廃止称号として表示のみ生かす |
| `matchmaker` | **（移行しない・非公開）** | 蜜月は秘匿対象。行は残すが新コードの公開面には一切出さない |

### `matchmaker`（旧「月下氷人」）を移行しない理由

蜜月は匿名の募集・マッチングなので、成立した事実そのものが人間関係の開示になる
（`packages/core/src/titles/privacy.ts`）。表示用の廃止称号として移行すると、
**装備未設定時の自動選択や将来の装備UI経由でプロフィールカードに出てしまう。**

そこで「DBに行が残ること」と「新コードで公開表示すること」を分けた。

| | 挙動 |
| --- | --- |
| DBの `matchmaker` 行 | **残す**（旧コードへ戻したときに旧称号がそのまま見える） |
| 新コードの `list()` | 出ない |
| 自動装備 | 選ばれない |
| 明示装備 | 拒否される |
| プロフィールカード | 出ない |
| 収集数 (`progress().owned`) | 数えない |

実装は `NON_PUBLIC_LEGACY_KEYS`（`titles/service.ts`）。移行先を作らず、
`ownedMap()` の段階で落とすので以降のどの経路にも現れない。
`NON_PUBLIC_TITLE_KEYS` としてエクスポートし、
「表示ルールに存在しないこと」をテストで固定している。

## 収集称号（`titles_25` / `titles_50` / `titles_80`）の所持数の定義

`titles` テーブルの `COUNT(*)` は**使わない**。非破壊移行で旧行と新行が並存するため、
同じ称号が二重に数えられ、収集称号が本来より早く解除されてしまう。

所持数は次の1つの定義に統一している（`TitleEngine.currentOwnedCount`）。

1. 旧キーを新キーへ解決する
2. 非公開の旧キーを落とす
3. 重複を排除する
4. **現行カタログ（`TITLE_RULES`）に存在するものだけ**を数える

`progress().owned` と `buildSnapshot()` に渡る `ownedTitles` は同じ値になる。
廃止称号（`nightwalker`）とカタログから消えたキーは一覧には残るが**数には入らない**。

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

`matchmaker` は移行台帳に載らないので、上のSQLでは消えない。消す場合は明示的に指定する
（旧コードへ戻す可能性が無くなってからでよい。残していても新コードには出ない）。

```sql
DELETE FROM titles WHERE title_key IN ('matchmaker', 'mitsugetsu_retired');
```

削除後は `LEGACY_KEY_MAP`（`packages/core/src/titles/service.ts`）も空にできる。
ただし `nightwalker` の廃止ルール定義は既得者の表示のために残し続ける。
`NON_PUBLIC_LEGACY_KEYS` も、古いバックアップからの復元に備えて残しておくのが安全。

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
