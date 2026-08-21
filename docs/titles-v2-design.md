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

`started_at` の出自は `start_reason` 列（additive migration）で区別する。`join`=切断状態
からの新規入室、`move`=チャンネル移動、`state_change`=同一チャンネル内のmute/deafen変化、
`NULL`=列追加前のlegacy行（理由不明）。derived layerのcoalesceは、次segmentが
`state_change` かつ直前segmentが `observed` で閉じている場合だけ同一visitの継続とみなす。
時刻の一致だけで判定すると、同一秒での「退出→再入室」がmute変更による分割と区別できず
誤って1visitへ潰れてしまう（start_reasonは時刻に依存しないprovenanceとして必要）。

### VC derived source層（PR2）

raw `vc_segments` は `titleUsable: false`。個々の称号は `packages/core/src/vc/derived.ts` の
derived sourceを使う。

- `vc_visits`: 隣接segment（同一user・同一channel・時刻が連続、かつ次segmentの
  `start_reason` が `'state_change'` で直前segmentが `'observed'` で閉じている場合のみ）
  を1訪問へ合成した単位。`startedAt` が本物の入室かは `startKind` で別途区別する
  （上記参照）ため、この source自体も `titleUsable: false`（中間source）
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
境界が信頼できる場合だけ成立させる。単独ユーザーの計測（滞在秒数）も、`trusted`と名乗る
数字には信頼できない他者の境界を混ぜない——他者の終了が信頼できず、記録上の退出時刻より
後もまだ居た可能性を否定できない場合、それ以降のsubject残り区間は人数帯そのものが
不確かになるため`untrustedSeconds`側へ計上する。同様に empty-start-then-joined も、
「先に居た他者はもう退出していた」と主張するには、その他者の終了が信頼できるか、記録上
明確に在室していたことのどちらかが必要——終了が信頼できず退出時刻が不確かな他者を
「もういなかった」と勝手に扱わない。

window境界より前から継続していた訪問は、`startedAt` が境界でclipされているだけなので
「開始イベント」として扱わない（`LogicalVisit.startClipped`）。同一秒のtieは前後関係を
証明できないため、安全側（factを作らない）へ倒す（0秒segmentも証拠として保持し、
tie判定から消さない）。

`startedAt` が本物の入室イベントかは `LogicalVisit.startKind` で区別する
（`'arrival'` / `'partial_observation'` / `'unknown'`）。前segmentへcoalesceできなかった
孤立state_change（クラッシュ補正の推定終了後、しばらく経ってからのmute操作等）は
`'partial_observation'`——本人は既にそこにいて状態変化を再観測しただけなので、
「入室した」「後から来た」を主張するfact（empty-start-then-joinedのsubject・laterJoin）
は `'arrival'` のときだけ使う。この区別のため `vc_visits` 自体は `titleUsable: false`
（中間source）にした。称号は必ず `vc_visits` より下流のderived sourceを使う。

`TitleWindow.end` が未来（「今月」「今日」等のカタログ境界から機械的に作られる）を指して
いても、evaluationは `TitleWindow.observedAt`（省略時は現在時刻）より先までtrustedとして
計上しない。`effectiveEnd = min(end, observedAt)` は1回のexported関数呼び出しにつき
`resolveWindow()` で1回だけ解決し、クエリの読み込み境界・coalesce・clippingの全段で
一貫して使う——open visitの終了時刻だけの話ではなく、`observedAt` より後に**開始した**行
（別ユーザーの新規入室等）はクエリの読み込み段階からそもそも見ない。そうしないと、同じ
`observedAt` で再評価してもDBが後から進むと結果が変わってしまい、reconcileの再現性
（「あの時点で何が分かっていたか」の再構築）が壊れる。

ただし、これは「同じ `observedAt` ならDBがどんな後更新を受けてもビット単位で永久に
同じ結果になる」ことまでは保証しない。VCは完全なevent-sourcing DBではなく、
`closeAllDangling()` は既存の（`observedAt` より前に開始済みの）dangling segmentへ、
後から`recovered_estimate`という**過去時刻**を書き込む。この場合、その行は
`observedAt`より前に開始しているため引き続き読み込まれるが、評価時点で「まだ開いていた
（trusted `'open'`）」ものが、後日「推定値で閉じた（untrusted `'recovered_estimate'`）」
へ変わり得る——`isTrustedVisitEnd()` は `'open'` を trusted、`'recovered_estimate'` を
untrustedとするため、この変化は常に**より保守的な方向**（信頼できたものが信頼できなく
なる）にしか動かない。late recoveryによって称号を誤って増やすことはなく、安全側へ倒れる。

各derived関数の`userIds`引数の契約: `undefined`=全ユーザー対象、`[]`（空配列）=対象なし
（何も返さない）。空配列を「絞り込みなし」と解釈すると、意図せず全ユーザーのデータを
返してしまう事故になるため区別する。`computeSafeSocialAggregates`は`userIds`指定時、
指定ユーザー以外の行を返さない——`computeCoPresenceOverlaps`は「少なくとも一方が指定
ユーザー」であるpairを返す都合上、指定していない相手側にも部分的な重なりが乗るが、
その相手の集計はchannel全体を見た完全なものではないため、指定時は指定ユーザー分だけを
返す。

### BUMPの重要な契約

BUMP / upの成功は既に `bump_events(message_id, user_id, created_at)` へ1件ずつ保存されている。称号では集計counterの `bump_counts` ではなく、この時刻付きhistoryを正本にする。

- `bump_events`: `history / orderable:true / titleUsable:true`
- `bump_counts`: ランキングとcounter baseline機構の監査用。`titleUsable:false`

これにより、例えば「20回目の成功BUMP」をreconcileしても20件目の `created_at` から正確な `earned_at` を復元できる。既に持っている履歴を捨てて取得順を不明にしない。

### 実行経路: source → evaluation rule → award（PR3）

称号v2の実行は次の経路をたどる。

```text
行動（VC / BUMP等）
  ↓
persisted source（vc_segments / bump_events）
  ↓
derived source（vc_visits / vc_empty_start_then_joined / vc_social_safe 等）
  ↓
evaluation rule（TitleRule.evaluate）
  ↓
award（TitleV2Store、matchedのときだけ）
  ↓
（後続PRで） notification / equip
```

**ruleはDBを直接読まない。** `packages/core/src/titles/v2-sources.ts` が唯一の読み込み境界で、ruleへ渡されるのは `definition.sources` に宣言した `titleUsable: true` sourceの、sanitize済みpayloadだけ。`Database.Database` そのものやraw source（`vc_segments`・`vc_visits`・`vc_co_presence`・`bump_counts`）は一切渡さない——ruleが独自SQLを書ける設計にすると、privacy・provenance・trusted/untrustedの契約を全部迂回できてしまうため。

- `readTitleSource()` は、`sourceKey` がTypeScriptを迂回して（`as any`等で）titleUsable:falseや未登録の値を渡された場合でもruntimeでfail-closedする。
- `assertSourceReaderCoverage()`（`TitleV2Store` construction時に自動実行）は、titleUsable:trueな全sourceに実際のreaderが存在することを検証する——「registryへ登録だけされているがreaderが無い」状態を黙って空データ扱いにしない。
- `TitleSourceCache` が `(userId, sourceKey, scopeKey, start, endExclusive, observedAt)` 単位で1 evaluation batch内の重複読み込みを防ぐ。複数ruleが同じsourceを使っても、derived計算（PR2の一部はO(訪問数²)）をrule数だけ繰り返さない。永続cacheではない。
- `bump_events` readerも「observedAtより先を読まない」制約をPR2のVC readerと揃える（下記observedAt/effectiveEndの節を参照）。ただしBUMPはretryで後からcreated_atが過去のeventを挿入し得るため、「同じobservedAtなら永久にDB内容と一致する」とまでは言えない——observedAtは「event occurrenceの上限」として扱う。
- `TitleRule` は公開structural interfaceなので、`defineTitleRule()` を経由せず手で組み立てたり構築後にdefinitionを書き換えたりできる。`evaluateTitle()` は入口で必ず `defineBehaviorTitle(rule.definition)` を再度通す——さもないと `sources: []` のruleが「何も読まずに任意のearnedAtでaward」できてしまい、「source contractを条件実装から迂回させない」が破れる。
- ただし `defineBehaviorTitle()` はdefinitionをcopyせず同じobjectを返すため、それだけでは足りない。`rule.evaluate()` の実行**中**に `rule.definition`（同一参照）を書き換えられると、評価後のorderable判定がその改竄後の値を見てしまい、入口の再検証をすり抜けられる（VC専用ruleがevaluate()の中で自分のsourcesをorderable:trueな`bump_events`へ差し替え、非nullなearnedAtを通す、等）。`evaluateTitle()` は `sources`/`triggers` を含めて独立したcopyを作り、以降はそのcopyだけを使う。`scope` も同様に、ctx.scopeとして渡す前に値だけを取り出したcopyへ変換する——ruleがctx.scopeを書き換えても、award先のscopeKeyには影響しない。
- source payloadはTitleSourceCache経由で複数ruleへ同じ参照が配られる。1つのruleが受け取ったpayloadを（配列への`push()`等で）書き換えると、後続ruleが汚染された値を見てしまう。`readTitleSource()` はpayloadを再帰的にdeep-freezeしてから返す——書き換えようとすると（strict modeで）例外になる。

earnedAtは、ruleが宣言した**全source**が `orderable: true` のときだけ非nullを返してよい。1つでも `orderable: false` sourceに依存するruleが非nullを返すと `evaluateTitle()` がrejectする——「たぶんこの時刻だろう」を実時刻として保存させない。

lifecycle:

- `disabled`: 新規評価しない（sourceも読まず、scopeも解決せず、ruleの `evaluate()` 自体を呼ばない）
- `retired`: matchedでも新規awardしない。既存awardは保持する（消さないし増やさない）
- `active`: 通常通り評価・award可能

awardは `TitleV2Store.award()` の `(user_id, title_key, scope_key)` 冪等性にそのまま乗る。同じevaluationを何度reconcileしても二重awardしないし、既存awardをreconcile時刻等で上書きしない。

### behavior / meta の分離（PR A、v2 contract v3）

`TitleDefinition` は `kind` で discriminated union へ分離した。

- `BehaviorTitleDefinition`（`kind: "behavior"`）: 通常のsource evaluatorを通す称号。`catalog` / `sources` / `triggers` / 任意の `progression` を持つ。`defineBehaviorTitle()` で構築する。
- `MetaTitleDefinition`（`kind: "meta"`）: 他titleのaward状態やcollection/full-clear manifestを横断して判定する称号（千印万来・万印皆伝等）。`sources` / `triggers` / `catalog` / `progression` を持たない——meta titleは特定1catalogの監査対象という単位ではなく、有効な複数catalog/manifestを横断して判定するため。`defineMetaTitle()` で構築する。

`TitleRule.definition` の型は `BehaviorTitleDefinition` に固定してあるため、meta titleを `evaluateTitle()` へ渡すことは**コンパイルエラーになる**（型で分離）。TypeScriptを迂回されても、`defineTitleRule()`/`evaluateTitle()` 内部の `defineBehaviorTitle()` が `kind` をruntimeでも検証する。

`countsForCompletion` は廃止した。Collection Credit / Full-clear Requiredは、title definition自身のpropertyではなく、後続のimmutable collection manifest（下記）側が持つ。

`trigger`（単数）は `triggers`（複数、最低1件・重複禁止）へ変更した——TC+VCの両方で完成し得る称号、複数featureに跨る称号を表現できるようにするため。`lifecycle` から `seasonal` を削除した——期間限定の意味は次のscope policyが持つため、両方に「期間」概念を持たせて意味が重複するのを避ける。

### scope policy と中央resolver（PR A）

`definition.scope: TitleScopePolicy` が「どうscopeを区切るか」を宣言する。

```text
{ type: "catalog" }              start = CATALOG_EPOCH、open-ended
{ type: "global" }                start = SYSTEM_EPOCH、open-ended
{ type: "month" }                 JST暦月。start = max(月初, CATALOG_EPOCH)、end = 翌月初
{ type: "event"; eventKey }       event固有window。start = max(canonical開始, CATALOG_EPOCH)、
                                   end = canonical completedAt
```

scope policyの意味はreleased title semanticの一部——resolverのsemanticを後から変えると、既存titleのaward境界が過去に遡って変わってしまうため変更しない。

**callerは `TitleEvaluationScope` を自由に組み立てられない。** `packages/core/src/titles/v2-scope.ts` の `resolveTitleScope(store, definition, observedAt, eventProvider?)` だけが `ResolvedTitleScope` を作る唯一のAPI。callerが渡すのは `observedAt` だけで、scopeKey・window境界は必ずここで計算する。

- `ResolvedTitleScope` は module-private な `unique symbol` でbrandされている。他コードが手書きした `{ scopeKey: "...", start: ... }` はこの型に**構造的に合致しない**（TypeScriptの型エラー）。`as unknown as ResolvedTitleScope` で型を迂回されても、実際のsymbol propertyは存在しないため、`assertResolvedTitleScope()`（`readTitleSource()` の入口で必ず呼ばれる）がruntimeで検出する——型だけでなくruntimeでもscope forgeryをfail-closedにする。
- `endExclusive: number | null` でopen-endedを明示する。`Number.MAX_SAFE_INTEGER` 等で偽装しない。sourceを読む実効的な終端は `effectiveEnd = min(endExclusive ?? observedAt, observedAt)`（`resolvedScopeEffectiveEnd()`）——open-endedなscopeは常に `observedAt` が上限になる。
- `catalog` / `month` / `event` はCATALOG_EPOCHの解決が必要。meta titleは `catalog` を持たないため、`global` 以外のscope policyを解決しようとするとfail-closedする（`defineMetaTitle()` が構築時点で既に拒否する。resolver側も二重に守る）。
- `event` scopeはcanonical event infrastructureがまだ無いため、`TitleEventScopeProvider` の差し込みが無いと解決できずfail-closedする。`eventKey` はcallerが自由に渡せず、`definition.scope.eventKey` にpolicy自体として固定してある。
- scopeKeyはcanonical生成のみ: `global` / `catalog:<catalogKey>` / `month:<catalogKey>:<YYYY-MM>` / `event:<catalogKey>:<eventKey>`。`catalogKey`・`eventKey`・`themeKey`・`groupKey`・`progression.seriesKey` はすべて `assertSlug()`（lowercase英数字・`-`・`_`のみ）でvalidateし、`:`や空白を許可しない——scopeKeyの文字列結合が曖昧にならないようにするため。

### Theme / Group / Progression（PR A）

`BehaviorTitleDefinition` は `themeKey` / `groupKey` / 任意の `progression` を持つ。意味は完全に分離する。

- **Theme**: 「何の分野か」。将来のtheme breadth集計（千印万来等）に使う。
- **Group**: 関連称号のまとまり。side titleも同じgroupに入れる。
- **Progression** (`{ seriesKey, stage }`): 順番のあるcumulative ladder。《一門皆伝》の対象。`stage` は1始まりの正整数。

`released title` の theme/group/series/stageはsemanticとしてimmutable想定。

### Series Manifest（PR A）

title definitionsを自動走査して「現在存在するstage全部」を一門皆伝（mastery）対象にする方式は禁止。`TitleSeriesManifest`（`packages/core/src/titles/v2-series.ts`）がimmutableなmember一覧を持つ——後からstage5を追加しても既存manifestのmembersは書き換えず、新しいmanifestを作る。

`assertValidSeriesManifest()` が検証する内容: members>=2、member titleの実在、同一catalog/theme/group、全memberが対象seriesのprogressionを宣言していること、stageの重複・欠番禁止（1始まりの連番）。`assertNoOverlappingSeriesMembership()` が、1 titleが複数seriesへ所属していないかをmanifest横断で検証する。

### Collection / Full-clear Manifest（PR A）

Collection Editionはtitle catalogとは別概念。`TitleCollectionEdition`（`packages/core/src/titles/v2-collection.ts`）が `editionKey` と `members`（`titleKey` / `themeKey` / `collectionCredit` / `fullClearRequired`）、およびedition固有の `milestones`（`thousandMarks.count`/`themes` 等）を持つ。旧 `countsForCompletion` のようにtitle definition自身へCollection Credit / Full-clear Requiredを持たせない。

《千印万来》《万印皆伝》のようなmeta titleのsemanticは、絶対的な閾値をmeta title自身に持たせず「有効なcollection/full-clear editionのmilestone policyを満たしたか」とする——catalog規模が変われば新しいeditionを作ればよく、meta title自体のkeyや判定ロジックを変えなくて済む。

`assertValidCollectionEdition()` が検証する内容: member重複禁止、member titleの実在、themeKeyの一致、meta titleをfullClearRequiredにできない、fullClearRequired memberが最低1件、milestone値の非負整数チェック、`thousandMarks.themes` が数えられるtheme数を超えない、`almostComplete.remaining` がfull-clear必須総数未満であること。

### Rarity契約の最低限（PR A）

`packages/core/src/titles/v2-rarity.ts` に型だけを置く（DB/計算本体は後続PR）。

- **current rarity**: 現在の所持者状況から動的に変化する。永続化しない。
- **acquisition-time rarity**: award時点でsnapshotし、以後不変。
- 非orderableなsourceに依存するtitleが存在するため「真のN人目」を断定できない。`acquisitionSequence` は「Botがownershipを確定した処理順」（刻印順）であって、実際に条件を満たした時系列順の証明ではない。

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

scope例（`resolveTitleScope()` が生成するcanonical形。`catalogKey`はtitle definitionの `catalog` から取る。呼び出し側は組み立てられない）:

```text
global
catalog:v1
month:v1:2026-08
event:v1:summer-2026
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

期間限定の意味は `scope`（`TitleScopePolicy`）が持つ。`lifecycle` はそれとは独立な、称号自体の稼働状態を表す（v2 contract v3で `seasonal` を削除し、両者の意味の重複を解消した）。

```text
active    通常。新規評価・award可
retired   新規award不可。既得者は保持（消さないし増やさない）
disabled  秘匿事故等。sourceも読まずevaluate()自体を呼ばない強制停止。将来UIで非表示・装備解除もできる想定（このPRでは未実装）
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

root `packages/core/src/index.ts` からも、evaluator kernelの主要APIだけを最小限export する
（`TitleV2Store` / `defineBehaviorTitle` / `defineMetaTitle` / `defineTitleRule` /
`evaluateTitle` / `evaluateUser` / `evaluateBatch` / `resolveTitleScope` /
`TitleEvaluationOptions` / `TitleEventScopeProvider` / `ResolvedTitleScope` /
`TitleScopePolicy` / `BehaviorTitleDefinition` / `MetaTitleDefinition` /
`TitleEvaluationResult` / `TitleAwardOutcome` / `TitleRuleContext` / `TitleRuleResult`）。
`readTitleSource()` 等の低レベルreader APIはrootへは出さない——称号条件作者が使うAPIと
内部実装を区別する。旧v1にも `TitleRule` が存在するため、v2側は `TitleV2Rule` /
`TitleV2RuleContext` / `TitleV2RuleResult` へaliasする。

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
