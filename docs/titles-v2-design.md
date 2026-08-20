# 称号システム v2 設計方針

## 0. 最上位原則

> **城で遊んだ結果、その人らしさが後から印になる。称号を取るために城で遊ばせない。**

称号は攻略表ではなく、冥獄城で過ごした結果を本人があとから見つける**物語と自己表現**にする。

- 数字は裏で数える。表では数字ではなく「役」に翻訳する。
- 称号のためだけに新しい監視項目を増やさない。既に機能上記録している事実を読み替える。
- 条件を攻略されても、城にとってプラスか無害であること。
- VC・賭場・部屋・招待など、どの遊び方でも比較的早く最初の意味ある印に出会えること。

## 1. 位と印

- 文位・声位は既存 `TEXT_TIERS` / `VOICE_TIERS` の読み取り表示。称号ではない。
- **印**が称号本体。いくつでも取得できる。
- 他人へ公開するのは本人が手動で選んだ **0〜3印だけ**。
- 全取得履歴・未装備の印は本人用の印録だけで見せる。
- ニックネームには出さない。

## 2. 未取得条件を攻略表にしない

通常称号も、取得前から正確な閾値を一覧表示しない。

```text
NG: 空VCから人を迎える 3/5
OK: 誰もいない場所から始まる印があるらしい
取得後: 別々の5日、空のVCに最初に入り、その後誰かを迎えた
```

必要ならぼかしたヒントだけを出し、取得後に種明かしする。

## 3. データ源起点

> **称号から書かない。データ源から書く。**

称号定義は必ず `TITLE_SOURCES` の登録済みsourceを宣言する。sourceは `persisted`（DBへ直接書く）と
`derived`（他sourceから読み出し専用で導出する）のdiscriminated unionで、共通して次を持つ。

- `kind`: `history | counter`
- `privacy`: `safe | restricted | forbidden`
- `orderable`: source全体で達成時刻を正確に復元できるか
- `titleUsable`: 個々の称号から直接参照してよいか
- `epochPolicy`: カタログ施行境界の切り方。counterはbaseline metric名もここで固定する
- `rawUnit`: DBの1行（またはderived factの1件）が何を意味するか

`persisted` はさらに次を持つ。

- `writtenBy`: 書き込み正本
- `calledFrom`: writerを直接呼ぶ本番処理
- `wiredFrom`: Discord event等から`calledFrom`までの最上流配線

`derived` は「writerが存在するsource」と偽装しない。代わりに次を持つ。

- `derivedBy`: 導出ロジックを実装しているファイルと、その存在を示す最小文字列
- `derivedFrom`: 依存する登録済みsource。dependency chainは最終的にlive persistedへ到達しなければ
  ならない（`assertDerivedSourceDependenciesResolve()` が循環参照・未登録参照・非persisted終端を拒否する）

sourceは一気に登録せず、writer / caller / event wiring / 境界を実コードで検証できたものだけ追加する。
derivedも同様に、実装ファイルの存在とdependency chainの解決を機械テストで検証してから追加する。

### VCの重要な契約

`VcTracker.open()` は入室時だけでなく、mute/deafen状態変化やチャンネル移動でも前segmentを閉じて新しい行を作る。

したがって `COUNT(vc_segments)` を「VC入室回数」と読んではいけない。raw unitは **voice state segment**。

さらに `closeAllDangling()` はクラッシュ等で実退出時刻が分からないsegmentを「開始 + 上限（既定6時間）」で補正する。そのためraw `vc_segments` 全体は `orderable: false` とする。正確な時刻を保証できる行動は、後続のderived sourceで別契約にして `orderable: true` を持たせる。

`ended_at` の出自は `end_quality` 列（additive migration）で区別する。`observed`=通常の
VoiceStateUpdate処理で閉じた、`recovered_estimate`=`closeAllDangling()` の推定値、
`NULL`=まだ開いている、または列追加前のlegacy行（品質不明）。既存closed行を`observed`と
推測して書き換えることはしない。

### VC derived source層（PR2）

raw `vc_segments` は `titleUsable: false`。個々の称号は `packages/core/src/vc/derived.ts` の
derived sourceを使う。

- `vc_visits`: 隣接segment（同一user・同一channel・時刻が連続）を1訪問へ合成した単位
- `vc_empty_start_then_joined`: 誰もいないVCへ入り、後から誰かが来た、という事実のみ
  （相手のidentityは含まない）
- `vc_last_occupant`: occupancyが2以上から1に減り、subjectだけが残った瞬間
  （相手のidentityは含まない）
- `vc_group_size_seconds`: solo/1:1/小人数/大人数の帯ごとの滞在秒数
- `vc_co_presence`: pairwiseの重なり（`privacy: restricted`。相手のuserIdを含むため
  称号から直接は使わせない）
- `vc_social_safe`: `vc_co_presence` を畳み込んだ、本人単位の安全な集計（`vc_co_presence`
  から派生する2段のdependency chain）

**信頼境界**: 開始時刻は常にDiscordイベントを観測した記録なので信頼できる。終了時刻は
`observed`／訪問がまだ`window.end`で開いている場合のみ信頼できる（`isTrustedVisitEnd()`）。
複数ユーザーを比較して「誰が先か」「誰がまだ居たか」を主張するfactは、比較に使う双方の
境界が信頼できる場合だけ成立させる。単独ユーザーの計測（滞在秒数）は、本人の終了だけを
信頼判定に使い、周囲の人数把握は他者の終了品質を問わずbest-effortで使ってよい
（特定の誰かについての主張をしないため）。

window境界より前から継続していた訪問は、`startedAt` が境界でclipされているだけなので
「開始イベント」として扱わない（`LogicalVisit.startClipped`）。同一秒のtieは前後関係を
証明できないため、安全側（factを作らない）へ倒す。

### BUMPの重要な契約

BUMP / upの成功は既に `bump_events(message_id, user_id, created_at)` へ1件ずつ保存されている。称号では集計counterの `bump_counts` ではなく、この時刻付きhistoryを正本にする。

- `bump_events`: `history / orderable:true / titleUsable:true`
- `bump_counts`: ランキングとcounter baseline機構の監査用。`titleUsable:false`

これにより、例えば「20回目の成功BUMP」をreconcileしても20件目の `created_at` から正確な `earned_at` を復元できる。既に持っている履歴を捨てて取得順を不明にしない。

## 4. SYSTEM_EPOCH / CATALOG_EPOCH

- `SYSTEM_EPOCH`: v2称号世界そのものの開始点。一度だけ `title_system_state` に確定し、その後は動かさない。
- `CATALOG_EPOCH`: 第I期・第II期など、その称号群を数え始める起点。

counter sourceはカタログ施行時点の値をbaselineとして保存し、`現在値 - baseline` で判定する。

### baselineは呼び出し側に作らせない

`applyCatalog()` の呼び出し側へ任意のbaseline配列を渡させない。Store自身が `TITLE_SOURCES` に登録された**すべての利用可能なcounter baseline source**を列挙し、sourceごとの正規snapshotterで全ユーザーを取得する。

これにより、次をAPI上できなくする。

- 一部ユーザーだけsnapshotし忘れる
- `count` を `coutn` と書くなどmetric名を間違える
- 0件だったのか、snapshot自体を忘れたのか分からなくなる

`title_source_baseline_runs` に `(catalog, source, metric, row_count, captured_at)` を残し、0行でも「snapshotを実行した」という施行証跡を持つ。

baseline snapshot・SYSTEM_EPOCH初回確定・CATALOG_EPOCH確定は**同じ `BEGIN IMMEDIATE` transaction**で行う。snapshot中にBUMP等が増えて境界がずれる窓を作らない。

`applyCatalog()` は外側transaction内から呼ばせない。better-sqlite3のnested transactionでは内側がsavepointになり `BEGIN IMMEDIATE` の保証が弱まるため、`db.inTransaction` ならfail-closedする。

CATALOG_EPOCHは過去方向へ巻き戻せない。第II期を追加しても、第I期から継続する称号は第I期の起点を使い続け、累積をリセットしない。

## 5. Award

awardの一意性は次で持つ。

```text
(user_id, title_key, scope_key)
```

scope例:

```text
global
month:2026-08
event:72h-2026
catalog:v1
```

時刻は分ける。

- `earned_at`: 条件を満たした時刻。証明できないなら `NULL`。
- `awarded_at`: Botが実際に付与した時刻。

reconcile時刻を `earned_at` として捏造しない。取得順は `earned_at` が正確に分かる称号だけ出す。

`earned_at > awarded_at` は意味矛盾なので、runtimeとDB `CHECK` の両方で拒否する。

## 6. 即時判定 + reconcile

- 行動直後の即時判定: トロフィー体験のための速い経路。
- 日次reconcile: 障害時の取りこぼしを修復する正しさの保証。
- 称号判定が落ちても、VC・賭場・送金など本体処理をロールバックしない。
- `(user,title,scope)` の冪等制約で二重付与を防ぐ。

## 7. 通知

- 正規の通知面は**その場**。行動と結果を近づける。
- 取得通知から「装備する」「印録を見る」へ進める。
- DMはその場で通知できなかった場合の代替、または本人が受信を選んだ場合だけ。
- reconcileで遅れて見つかった取得は本人向けにまとめ、公開チャンネルへ遡及告知しない。
- 公開告知は `publicAnnounce` が真の称号だけ。レア度とは独立。

## 8. ライフサイクルと収集

```text
active    通常。取得可・装備可
seasonal  期間限定。通常完遂の分母外
retired   新規取得不可。既得者は保持・装備可
disabled  秘匿事故等。強制非表示・装備不可
```

- 全クリ称号は**カタログ版単位**にする。
- 隠し称号は通常カタログ完遂の分母に入れない。「極・番外」の別収集。
- 一度公開したカタログ版の完遂対象集合は後から都合で書き換えない。

## 9. レア度

保有率から現在の希少性を算出するが、意味を二つに分ける。

- **現在:** 城の何%が持っているか。時間で動いてよい。
- **取得時:** 取得時の希少章・取得順。取得者の履歴として固定する。

正確な `earned_at` を証明できない称号には「あなたはN人目」を出さない。

## 10. Privacy

称号判定へ渡す前にsourceを `safe / restricted / forbidden` で分離する。

- `forbidden` はsnapshot組み立て時点で除外する。
- `restricted` は許可した集計値だけ渡す。
- イベントログはイベント型だけでなく、利用可能フィールドもallowlistにする。
- 「装備しなければ見えない」等の運用ルールを秘匿の防壁にしない。

## 11. Goodhart対策

> **条件を攻略する行動そのものが、城にとってプラスか無害であること。**

対策例:

- 同日連打ではなく別日数
- 同じ相手の往復ではなく別人
- 1日1カウント上限
- 相手側にも意味のある出来事

「全財産を賭けた」のように危険行動を誘発する称号は作らない。

> **負けることを推奨しない。負けた体験を救う。**

惜敗・大逆転された・特殊役を出したのに負けた、など本人の意思で安全に最適化できない結果を物語化する。

## 12. Key

v2カタログは `v2.*` 名前空間を使う。

- 名前・説明・絵文字だけの変更: key維持
- 獲得条件の意味変更: 新key
- 判定sourceの意味変更: 新key

一度世に出たkeyの意味も永続IDの一部とみなす。

## 13. 時間境界

「日」「月」「夜」「日次」の意味づけは **Asia/Tokyo（JST）固定**。DBはunix秒で保存する。

## 14. 公開API

v2基盤は `@meigokujo/core/titles/v2` を公開入口にする。後続のBot実装がcore内部pathへ依存しないようにする。

## 15. PR分割

このPRは**基盤だけ**。

入れる:

- v2 source contract / registry
- catalog epoch + baseline store
- SYSTEM_EPOCH singleton
- scoped award
- 3枠equip store
- 旧称号と分離したadditive schema
- `@meigokujo/core/titles/v2` 公開入口
- 基盤テスト

まだ入れない:

- 個々の称号カタログ
- profile UI
- 通知配線
- 日次reconcile scheduler
- 旧 `titles` 行の削除
- 本番のcatalog施行 / baseline snapshot

旧 `TitleEngine` は移行完了までそのまま動かす。
