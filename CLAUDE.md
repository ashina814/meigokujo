# CLAUDE.md

冥獄城 Discord Bot（pnpm モノレポ: `packages/core` / `apps/bot`）。

このファイルは**変動しない常設ルール**だけを置く。main SHA・PR head・各PRの進捗・
現在の実装状況は**書かない**（すぐ古くなり、古い記述が誤った正本になる）。
それらは常に `git` と GitHub 上の実態を見ること。

---

## 1. 正本

賭場（マモンの賭場）大型アップデートの正本は次の2つだけ。

1. **[docs/casino/マモンの賭場_大型アップデート_最終実装仕様書_v1.0.md](docs/casino/マモンの賭場_大型アップデート_最終実装仕様書_v1.0.md)**
   — 仕様の正本。PR分割（§19）、不変条件（§3）、停止条件（§21）、運営設定（§22）はここが基準。
2. **最新の `main`** — 実装の正本。確定済みの安全修正は必ず main 側を採る。

旧 stacked PR・backup ブランチ・過去のレビュー記録は**資料**であって正本ではない。
参照してよいが、**全体適用してはいけない**。旧ブランチから取り込むのは、その PR 固有の
差分だけに限る。`git diff <old-base>..<old-head> | git apply` のような一括適用は禁止
（監査前の古い実装が main へ逆流する）。

仕様書と実装が食い違う場合は、勝手にどちらかへ寄せず**停止して報告**する。

---

## 2. 共通の不変条件

仕様書 §3（I1〜I10）が正本。実装上、特に壊しやすい点を挙げる。

### 通貨・台帳
- `ChipLedger` はロック付きの**唯一の実装**。`ChipLedgerCore` / `EtherExchangeCore` の
  ような迂回クラスを作らない。公開のロック解除オプションを足さない。
- 1 チップ = 1 Land 固定。変動レート・両替・退場時奉納を復活させない。
- `Σ 全チップholder残高 = ledger.balanceOf("sys:escrow:casino")` を 1 Ld も崩さない。
- 預入・返還は対応する Land 取引 ID を必ず持つ。
- 資金を動かす経路は `services.chips`。`services.ether` は**読み取り専用の互換窓**。
- legacy DB を暗黙に移行しない。

### opening lock
- `legacy_pre_reset` では資金操作を停止する。
- `opening_v1` 以降だけ資金操作が通る。
- 新旧取引型は版で分離する。
- 正式開業前 UI の停止表示・未知版の異常表示を壊さない。
- 資金操作が許されるのは `chipTx.runMaintenance()` 区間だけ（actor 文字列で判定しない）。

### 資産分類（自由チップと預託）
- `freeChips` = `user:<id>` holder の自由に使えるチップ。
- `escrowed` = 卓・板へ拘束されている**本人帰属**額。
- `total = freeChips + escrowed`。
- 利用者資産へ次を混ぜない: `house` / `jackpot` / `relief` / `quarantine` /
  free-spin JP claim holder / system holder / **他人の預託** / 帳簿上の帰属が確認できない孤児残高。
- 拘束中資金を利用可能額に含めない。
- 不明なものを推測で利用者資産へ配分しない。

### 検算・復旧
- 検算 A〜D（仕様書 §6）のいずれかが NG なら `integrity_halt`。
- 所有元・帳簿・実残高・状態のいずれかが一致しないなら、**自動返金も自動精算もしない**。
  対象だけ凍結して人間へ通知する。
- 復旧は登録型（`recoveryRegistry`）。`recoverCasino()` の S1〜S12 の順序を変えない。
- 一人・一件の失敗で復旧ループ全体を止めない。失敗は構造化して残す。
- 未完了の義務（孤児返金の技術失敗・帳簿不一致・後検 NG・S10 失敗）は、
  outcome が 1 つしか選べなくても**すべて理由と event に残す**。低優先の義務を隠さない。
- 例外時も、実際に動いた資金の部分結果を捨てない（catch で空へ戻さない）。
- `recovery_halt` からの再実行で、成功済みは二重実行せず失敗分だけ再試行できること。

### 胴元
- ゲーム開始前に最大債務を予約する。予約できないゲームは開始しない。
- `redeemToAccount` の予約資金保護を外さない。
- 表示上限・事前検証・予約 INSERT は同一の `GameLiabilityModel` を通す。

### 権限
- 資金裁定と人物処分を分離する（I10）。
- **賭博場従業員（順位卓の運営係）は 2026-08-16 に廃止した。** 役職・ロールスロット
  `roles:casino_employee`・専用コマンドはいずれも存在しない。復活させないこと
  （仕様書 §13 §14 §17 を参照。あの節は実装しない）。

---

## 3. 実装の作法

### fail-closed
- 分からない値・未知の状態・破損した行は、**推測で通さず停止**する。
- DB 由来の値を `Number()` で黙って変換しない。safe integer 検証を通す。
- 未知の status を持つ行が状態機械の外で資金を動かせないようにする
  （UPDATE の `changes` 件数を確認する）。
- 不正 JSON は「読めた」ことにしない。
- 旧 DB へ `NOT NULL DEFAULT 0` で後付けした列の 0 を、正常値として扱わない。

### 数値・識別子
- 正の safe integer 検証を通す。負数・小数・`NaN`・`Infinity`・unsafe integer を拒否。
- 合算（`free + land` など）も checked add にする。和が safe range を出ないことを確認する。
- 空 ID・system holder・`user:user:<id>` のような二重接頭辞を拒否。
- 冪等キーへ混ぜる識別子は、区切り文字の注入を拒否する。

### 冪等性・原子性・並行性
- 外部から呼ばれる金銭操作は、最上位で `runGroup()` を**ちょうど一度**通す。
  入れ子の預入・返還が別 group を作らない。
- プロセス内ロックだけで金銭の冪等性を担保しない。
- 同じ group key を別の user・amount・kind・operation へ再利用したら **conflict** にする。
  保存済みの結果を返すとき、現在の要求と矛盾していれば成功扱いにしない。
- **冪等キーに時刻だけを使わない**。秒精度の時刻は「同じ秒に同額へ戻った」状態を
  区別できない。単調な世代（取引 ID・balance version・append-only sequence）を使う。
- 資金が動いていない skip を、settled な 0 円 group として固定しない。
  安全な状態に戻った後の再試行が永久に replay されてしまう。
- Land 取引とチップ発行は同一 SQLite トランザクションで行う。

### crash recovery
- 「片方だけ確定した」窓を必ず想定する（返還済み・元操作未完了、購入済み・完了記録失敗など）。
- 再実行で正しい終端へ**収束**すること。二重に資金を動かさないこと。
- `executing` のまま永久に触れない行を残さない。期限切れは回収する。
- 課金だけ冪等で配送（ロール付与・期限延長・通知）が二重実行される状態を残さない。
- 監査記録（event log）の失敗が、資金処理の結果を失わせないこと。

---

## 4. PR の範囲

- **PR 範囲外の先行実装を入れない。** 仕様書 §19 の PR 分割が範囲の正本。
- 旧ブランチに後続 PR の実装が含まれていても持ち込まない。
- 「ついでに直す」をしない。範囲外で見つけた問題は**報告に書く**（実装しない）。
- 暫定実装は「最終仕様は○○で、PR□□で置き換える」と PR 本文へ明記し、完成と誤認させない。
- 前の PR が squash マージされたら、次の PR は必ず**新しい main から積み直す**。

### 差分を狭く保つ
許容されるのは、その PR の機能・必要最小限の表示変更・その PR 専用テスト・
既存テストの機械的適応まで。次が入っていたら除去する。

- `.github/workflows/tmp-*` / stack 同期 workflow / 診断 workflow
- 既に main にある実装の再実装
- 後続 PR の機能
- 無関係な整形（unrelated formatting）
- lockfile の不要な変更
- ビルド成果物・一時 patch・ローカル DB・ログ

作業後に必ず確認する。

```bash
git diff --name-status main...HEAD
git diff --stat main...HEAD
git log --oneline main..HEAD
```

---

## 5. 検証手順

```bash
pnpm install --frozen-lockfile
pnpm --filter @meigokujo/core typecheck
pnpm --filter @meigokujo/bot typecheck
```

対象 PR のテストを先に流し、そのあと全体を流す。

```bash
pnpm --filter @meigokujo/core test
pnpm --filter @meigokujo/core test:serial
pnpm --filter @meigokujo/bot test
```

- 並行性・crash window は**別 SQLite 接続・別 Node プロセス**で確認する
  （`:memory:` では別接続を作れないので実ファイル DB を使う）。
- テスト失敗を、skip 化・テスト削除・timeout 増加だけ・期待値の無条件緩和で通さない。
- **ローカル環境要因はテスト失敗と区別して報告する。** 特に Windows では、一時ディレクトリの
  `rmSync` が EPERM になる／vitest reporter の RPC timeout が出ることがある。
  疑わしい場合は未変更の head を worktree に展開して同じ失敗が出るか確認し、
  「回帰ではない」ことを示してから報告する。
- CI は起動を確認できればよい。すぐ結果が取れる場合だけ記録する。

---

## 6. 報告の共通項目

再構築・監査・実装のいずれでも、最後に次を報告する。

1. 開始時 main SHA / 開始 head SHA / 最終 head SHA
2. 追加した commit 一覧
3. `main...HEAD` の変更ファイル一覧・ファイル数・追加削除行数
4. 採用した差分と、**捨てた差分とその理由**
5. 実装・変更した挙動の定義（集計方法・除外対象・状態遷移）
6. 既存実装とのコンフリクト解消内容
7. 共通不変条件（§2）を維持した証拠
8. **PR 範囲外が混入していない証拠**
9. core typecheck / bot typecheck
10. core 通常テスト / core serial テスト / bot テスト
11. GitHub CI
12. PR の base・head・Draft・mergeable 状態
13. 残っている曖昧点・判断が必要だった箇所
14. 次のレビューで重点確認すべき箇所

判断が必要になった箇所を黙って決めない。**必ず報告へ書く。**

---

## 7. 明示的な GO なしに禁止

次は、利用者が**その回に明示的に許可した場合だけ**実行してよい。
過去の許可を次回へ持ち越さない。

- `merge` / `auto-merge` の設定
- `main` への直接 push
- deploy / production apply
- **本番 DB の参照・変更**
- Discord 上の操作（メッセージ送信、ロール付与、チャンネル操作など）
- force push（実行前に remote head が想定 SHA と一致することを必ず確認し、
  違えば**上書きせず停止して報告**する）

Draft の解除（Ready 化）は、全ブロッカー解消・全テスト成功・**最終 head の CI 成功**を
満たしたときだけ行う。マージは常に利用者の操作。

### PR12（正式開業初期化）
- **dry-run までしか実行しない。本番 apply は禁止。**
- 不可逆かつ実データを触るため、他の PR より粒度を落とさない。
- preflight は読み取り専用（SELECT のみ）であることを維持する。

### 停止して報告する条件
次に当たったら、作業を進めず**停止して報告**する（仕様書 §21 も参照）。

- **RTP・倍率・配当・勝敗期待値を変更する必要が出た。**
  仕様書が明示している調整（§1.5 のチンチロ）以外は事前に止める。
- **運営設定値が必要になった**（開業元本、house/JP/relief 配分、最低運転資金、
  新 MIN_BET/MAX_BET、月次納付率、証拠保存場所、従業員給与など。仕様書 §22）。
  **推測で埋めない。**
- 検算 A〜D が既存 DB で一致しない。
- preflight で正式資産が見つかり、補償額・原資が未決。
- 利用者の通常 Land または賭場外データへ変更が発生する。
- `Σchips = 準備Land` が 1 Ld でも崩れる。

対象ゲームだけ停止できる問題で、賭場全体を不必要に止めない。

---

## 8. 環境

- 実クローンは 1 つだけ。OneDrive 配下にはドキュメントしかなく、`pnpm install` は通らない。
- クラウド sandbox で作業した分はローカルに残らない。未 push commit を疑うときは、
  先に `git fetch` してから `git log --branches --not --remotes` を見る
  （fetch 前はリモート追跡 ref が古く、ブランチ自体が見えないことがある）。

### commit の Co-Authored-By

AI の `Co-Authored-By` を付ける場合は、次を守る。

- **実際に作業したモデル・環境に一致する表記だけ**を使う。
- **実際の表記を確定できない場合は、推測して付けない。** 付けないほうが安全。
- **監査担当モデルを、実装 commit の共同作者として記録しない。**
  監査で見つけた指摘は、実装した側の commit の作者ではない。
