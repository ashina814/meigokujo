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

awardは `TitleV2Store.award()` の `(user_id, title_key, scope_key)` 冪等性にそのまま乗る。同じevaluationを何度reconcileしても二重awardしないし、既存awardをreconcile時刻等で上書きしない。matchedの`TitleRuleResult`は`awardFacts`が必須（discriminated union、§5参照）——`evaluateTitle()`はDBへ書くかどうかに関わらずこれを検証する。実際のaward/facts/ownershipの原子的な永続化はPR B1で完成した（§5参照）。

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

**callerは `TitleEvaluationScope` を自由に組み立てられない。** `packages/core/src/titles/v2-scope.ts` の `resolveTitleScope(store, definition, observedAt, options?)` だけが `ResolvedTitleScope` を作る唯一のAPI。callerが渡すのは `observedAt` と、必要なら `{ eventProvider?, monthSelector? }` だけで、scopeKey・window境界は必ずここで計算する。

- `ResolvedTitleScope` は module-private な `unique symbol` でbrandされている。他コードが手書きした `{ scopeKey: "...", start: ... }` はこの型に**構造的に合致しない**（TypeScriptの型エラー）。`as unknown as ResolvedTitleScope` で型を迂回されても、実際のsymbol propertyは存在しないため、`assertResolvedTitleScope()`（`readTitleSource()` の入口、および `TitleSourceCache.get()` の入口——cache hit経由でも必ず検証する）がruntimeで検出する——型だけでなくruntimeでもscope forgeryをfail-closedにする。cache hitのときだけbrand検証を飛ばすと、legitimateなscopeと全く同じfields（scopeKey/start/endExclusive/observedAt）を持つ偽造scopeがcache keyだけで「なりすまして」通ってしまうため、hit/miss両方の経路で検証する。
- `endExclusive: number | null` でopen-endedを明示する。`Number.MAX_SAFE_INTEGER` 等で偽装しない。sourceを読む実効的な終端は `effectiveEnd = min(endExclusive ?? observedAt, observedAt)`（`resolvedScopeEffectiveEnd()`）——open-endedなscopeは常に `observedAt` が上限になる。
- `catalog` / `month` / `event` はCATALOG_EPOCHの解決が必要。meta titleは `catalog` を持たないため、`global` 以外のscope policyを解決しようとするとfail-closedする（`defineMetaTitle()` が構築時点で既に拒否する。resolver側も二重に守る）。
- `event` scopeはcanonical event infrastructureがまだ無いため、`TitleEventScopeProvider` の差し込みが無いと解決できずfail-closedする。`eventKey` はcallerが自由に渡せず、`definition.scope.eventKey` にpolicy自体として固定してある。provider が返す `{ start, completedAt }` は resolver が整数性・`start < completedAt`・CATALOG_EPOCHでclipした後も `start < completedAt` であること・`completedAt <= observedAt`（＝eventが観測時点までに完了していること）を検証する——**未完了のeventを部分windowでawardしない**。
- `observedAt` がresolved scopeの `start` より前になることはfail-closedする（`resolveTitleScope` 内の共通チェック）。ただし `start === observedAt`（例: CATALOG_EPOCHちょうどの瞬間の評価）のようなzero-width windowはエラーにしない——「まだ何も観測していない」という正常な状態として扱い、VC derived source層（`vc/derived.ts`）の `clampWindow()` が `start>=end` でthrowしてしまう手前で、v2-sources.ts側が0件payloadを返す。
- `month` scope policyは通常 `observedAt` が属するJST暦月をそのまま使う（`monthSelector` 省略時 = `{type:"current"}`）。日次reconcileが「月をまたいだ後に前月分を修復する」ような historical reconcile を行いたい場合は `{ monthSelector: { type: "specific", month: "YYYY-MM" } }` を渡す——`observedAt` の意味（実際の観測上限）自体は変えず、対象月だけを明示的に選べる。`month` labelは厳格に `/^\d{4}-(0[1-9]|1[0-2])$/` でvalidateし、対象月が丸ごとCATALOG_EPOCHより前ならreject、未来の月を指定すれば通常の `observedAt < start` fail-closedに引っかかる。
- window境界の「開いている/閉じている」はscope種別と選び方で異なる。まとめると:
  - `global` / `catalog`: open-ended（`endExclusive:null`）。実効的な終端は常に評価時の`observedAt`。
  - `month`（`monthSelector:{type:"current"}`、省略時のデフォルト）: `endExclusive`（翌月初）は暦月としては固定値だが、`observedAt` は定義上その月の中に収まる（`jstMonthLabelOf(observedAt)`で選ぶ月だから）ため、`effectiveEnd`は常に`observedAt`と一致する——「まだ進行中の今月」を評価している状態。
  - `month`（`monthSelector:{type:"specific", month}`、historical closed month）: 対象月が既に終わっている（`observedAt`が翌月初以降）場合、`endExclusive`（対象月の翌月初）は`observedAt`から独立した真に固定のendになる——閉じた月を後から修復評価しても、常に同じ`effectiveEnd`が得られる。
  - `event`: `completedAt<=observedAt`をresolver側で要求するため、`endExclusive`（=`completedAt`）は`observedAt`から独立した真に固定のendになる。
- scopeKeyはcanonical生成のみ: `global` / `catalog:<catalogKey>` / `month:<catalogKey>:<YYYY-MM>` / `event:<catalogKey>:<eventKey>`。`catalogKey`・`eventKey`・`themeKey`・`groupKey`・`progression.seriesKey` はすべて `assertSlug()`（lowercase英数字・`-`・`_`のみ）でvalidateし、`:`や空白を許可しない——scopeKeyの文字列結合が曖昧にならないようにするため。

### Theme / Group / Progression / Collection Domain（PR A・PR B2でtheme/domain分離）

`BehaviorTitleDefinition` は `themeKey` / `groupKey` / `collectionDomainKey` / 任意の `progression` を持つ。意味は完全に分離する。

- **Theme**: editorial/browsing/display専用のカテゴリ。表示の整理にのみ使い、series/collection logicには一切使わない。将来titleを別themeへ移動してよい（released後もimmutableではない）。
- **Group**: 関連称号のまとまり。side titleも同じgroupに入れる。
- **Progression** (`{ seriesKey, stage }`): 順番のあるcumulative ladder。《一門皆伝》の対象。`stage` は1始まりの正整数。
- **Collection Domain** (`collectionDomainKey`): collection breadth判定（千印万来のtheme breadth集計等）用のsemantic identity。`v2-collection.ts` の `TitleCollectionMember.collectionDomainKey` が横断性判定の基準として直接参照する。

**PR B2契約correction A**: 当初 `themeKey` に「将来のtheme breadth集計に使う」という意味を持たせ、`TitleCollectionMember` も `themeKey` をimmutable manifestへ保存していたが、これは設計として誤りだった——themeはeditorial/display専用であるべきで、後からtitleのthemeを整理し直しただけでcollection breadthの意味が変わってしまうのは不適切。theme breadth用のsemantic identityを`collectionDomainKey`として分離し、`themeKey`はlogicから完全に切り離した。`released` behavior titleの`collectionDomainKey`はsemantic contractの一部——他のimmutableフィールド（catalog/scope policy/progression等）と同様、後から別domainへ付け替えない。

`released title` の group/series/stage/collectionDomainKeyはsemanticとしてimmutable想定（themeKeyは除く）。

### Series Manifest（PR A・DB永続化はPR B2）

title definitionsを自動走査して「現在存在するstage全部」を一門皆伝（mastery）対象にする方式は禁止。`TitleSeriesManifest`（`packages/core/src/titles/v2-series.ts`）が **released（一度公開した）series は永久にfreezeする** immutable契約を持つ——`members` の並びと内容そのものが《一門皆伝》条件の一部であるため、後からstageを追加しない。新しいladder（例: stage4を持つ版）が欲しい場合は、同じ `(catalog, seriesKey)` を使い回さず、新しいseriesKey + 新しいtitle key群を作る。既存の `(catalog, seriesKey)` を持つmanifestを「新しい内容へ置き換える」ことは正当な拡張手段ではない（runtimeでも `assertNoOverlappingSeriesMembership()` が同一identityの複数manifest存在そのものを拒否する）。

`assertValidSeriesManifest()` が検証する内容: members>=2、member titleの実在、同一catalog/group、全memberが対象seriesのprogressionを宣言していること、stageの重複・欠番禁止（1始まりの連番）。`assertNoOverlappingSeriesMembership()` が、manifest横断で(a) 1 titleが複数seriesへ所属していないか、(b) 同一 `(catalog, seriesKey)` を名乗るmanifestが複数存在しないかを検証する。

**PR B2契約correction B**: `assertValidSeriesManifest()` は当初、全memberの`themeKey`一致も要求していたが、これは削除した。themeはeditorial/display専用metadataであり、theme変更でreleased seriesがinvalidになってはいけない——seriesのsemantic一致条件は catalog / groupKey / seriesKey / stageの連番性で十分。`themeKey`はseries logicへ一切使わない。

`runtimeで時系列immutabilityそのものを証明するDB persistence`（`title_series_manifests` / `title_series_members`）は`v2-series-store.ts`（PR B2）が担う。詳細は「Series Manifest / Series Mastery persistence（PR B2）」参照。

### Collection / Full-clear Manifest（PR A・DB永続化はPR B2）

Collection Editionはtitle catalogとは別概念。`TitleCollectionEdition`（`packages/core/src/titles/v2-collection.ts`）が `editionKey` と `members`（`titleKey` / `collectionDomainKey` / `collectionCredit` / `fullClearRequired`）、およびedition固有の `milestones`（`thousandMarks.count`/`domains` 等）を持つ。旧 `countsForCompletion` のようにtitle definition自身へCollection Credit / Full-clear Requiredを持たせない。**意図的に `catalog` フィールドを持たない**——collection editionは将来的に複数catalog（第I期・第II期等）由来のbehavior titleを1つのfull-clear editionへ束ねる必要があるため、editionそのものを単一catalogへ拘束しない（memberごとにtitleKeyからdefinitionを引いてcollectionDomainKey整合性等を検証すれば足りる）。

《千印万来》《万印皆伝》のようなmeta titleのsemanticは、絶対的な閾値をmeta title自身に持たせず「有効なcollection/full-clear editionのmilestone policyを満たしたか」とする——catalog規模が変われば新しいeditionを作ればよく、meta title自体のkeyや判定ロジックを変えなくて済む。

**collection editionもtitle catalogと同様immutable**——一度公開したら `members`/`milestones` を書き換えない。ある時点でrequired titleがretired/disabledになった場合でも、そのeditionが「当時は有効だった」という事実は変わらず、「当時editionをcomplete済みだったユーザー」を後から修復評価（historical repair）するには、そのeditionの構造そのものが引き続きvalidである必要がある。運用の想定手順は: (1) active editionのrequired/collection titleをretire/disableする必要が生じたら、まず**そのeditionをclose**する（`v2-collection-store.ts` の `closeCollectionEdition()`、PR B2）、(2) old editionのmanifestは変更しない、(3) 次のeditionを新しいmember setで作る、(4) closed editionはhistorical repairのために保持し続ける。

この「immutableな構造」と「今から新規activateしてよいか」は別の関心事なので、検証関数を分離した。

- `assertValidCollectionEdition()`: 時間が経っても変わらない**構造契約**だけを検証する（member titleのlifecycleは見ない——historical closed editionもこれは通り続ける）。
  - member重複禁止・member titleの実在・collectionDomainKeyの一致
  - **meta titleはcollectionCredit/fullClearRequiredのどちらにもできない**（meta titleはcollection/full-clearの分母・分子どちらへも入らない——meta title自体が「有効なcollection editionを満たしたか」を判定する側であり、判定対象の一部を兼ねると自己参照的になるため）
  - **collectionCredit:falseかつfullClearRequired:falseのmemberは禁止**（editionのmemberとして何の意味も持たない）
  - fullClearRequired memberが最低1件
  - milestone値はすべて非負整数
- `assertCollectionEditionActivatable()`: `assertValidCollectionEdition()` を先に通した上で、**「今このeditionを新規activateしてよいか」**を追加で検証する——collectionCredit/fullClearRequiredの少なくとも一方がtrueなmemberは、definition.lifecycleが現在`"active"`であることを要求する。historical closed editionはこの関数を通す必要は無い。
- `countableCount`（collectionCredit:trueなmember数）・`countableDomains`（collectionCredit:trueなmemberのdistinct collectionDomainKey数——collectionCredit:falseのmemberのdomainは数えない）を基準に: `startedCollecting>=1`、`startedCollecting < collectorHabit < stillCollecting`、`stillCollecting <= thousandMarks.count <= countableCount`、`thousandMarks.domains>=1`、`thousandMarks.domains <= countableDomains`、`thousandMarks.domains <= thousandMarks.count`、`almostComplete.remaining>=1`、`almostComplete.remaining < fullClearCount`（full-clear必須総数）

DB persistence（`title_collection_editions` 等）は`v2-collection-store.ts`（PR B2）が担う。詳細は「Collection Edition lifecycle（PR B2）」参照。

### Rarity契約の最低限（PR A・DB永続化はPR B1）

`packages/core/src/titles/v2-rarity.ts` に契約の型を置く（current rarityの計算本体・UI表示は後続PR）。

- **current rarity**: 現在の所持者状況から動的に変化する。永続化しない。titleKey単位——scopeKeyをidentityにしない。current guild membershipを使った計算は今回もしない。
- **acquisition-time rarity**: award時点でsnapshotし、以後不変。**このtitleKeyを最初に獲得した（=最初のownership成立）ときのみ**作る——月/eventで同じtitleKeyを別scopeで繰り返しaward（再獲得）しても、`acquisitionSequence` は増やさない・snapshotを作り直さない。最初に獲得したscopeは `firstScopeKey` として証跡だけ保持する（rarityのidentityそのものではない）。PR B1でこの契約を `title_ownerships`（`acquisition_sequence` / `holder_count_at_acquisition`）として実際にDB永続化した（§5参照）。
- 非orderableなsourceに依存するtitleが存在するため「真のN人目」を断定できない。`acquisitionSequence` は「Botがtitleの最初のownershipを確定した処理順」（刻印順）であって、実際に条件を満たした時系列順の証明ではない。

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

## 5. Award / Ownership / Award Facts（PR B1）

「称号を一度獲得した事実」「所持そのもの」「取得時の理由」を、3つの別テーブルへ分離して永続化する（`packages/core/src/titles/v2-store.ts`）。この3つを混同しない。

- **award**（`title_awards`）: scopeごとの取得出来事。同じtitleが月次/eventで何度もawardされ得る——`(user_id, title_key, scope_key)` の一意性を持つ。
- **award facts**（`title_award_facts`）: 取得時点のsafe snapshot。award 1行につき1行、immutable——一度INSERTしたら書き換えない。「award rowはあるがfacts rowが無い」状態を正常とみなさない（後述のintegrity）。
- **ownership**（`title_ownerships`）: titleKeyそのものの永久所持。`(user_id, title_key)` で1行だけ——同じtitleを別scopeで何度再獲得してもownershipは増えない。award行から見て、そのuserがそのtitleKeyを**最初に**獲得したawardだけがownershipの`first_scope_key`になる。

`title_ownerships.first_*`（`first_scope_key` / `first_earned_at` / `first_awarded_at`）と `acquisition_sequence` / `holder_count_at_acquisition` は、**「歴史上最古のaward」のsnapshotではなく、「Botが最初にownershipを成立させたaward」のsnapshot**である——`v2-rarity.ts` の「刻印順は処理順であって真の達成順の証明ではない」という設計と同じ思想。一度first ownershipが確定したら、その後に historical repair でより古いscopeのawardが判明しても、この起点snapshotは**巻き戻さない**。例: 9月のawardでfirst ownershipが成立した後、8月分を historical repair で追ってawardしても、`first_scope_key`/`first_earned_at`/`first_awarded_at`/`acquisition_sequence`/`holder_count_at_acquisition` はすべて9月award時点のまま変化しない（`Store.award()` の冪等分岐——既にownershipが存在するtitleKeyへのawardはownershipを一切更新しない——がそのままこの契約を実現している）。

award一意性:

```text
(user_id, title_key, scope_key)
```

ownership一意性:

```text
(user_id, title_key)
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

`earned_at > awarded_at` は意味矛盾なので、runtimeとDB `CHECK` の両方で拒否する。加えて、`earned_at` が非nullなら、その値は該当awardの`ResolvedTitleScope`の窓 `[start, effectiveEnd)` に収まっていることをStoreでも検証する（`resolvedScopeEffectiveEnd()`）——zero-width scope（`start===effectiveEnd`）では、この条件を満たすearned_atが存在し得ないため、非nullなearned_atは常にrejectされる。

### `Store.award()` はraw scopeKeyを受け取らない、他titleのscopeも受け付けない

`AwardTitleInput.scope` は `string` ではなく、`resolveTitleScope()` が作った branded `ResolvedTitleScope` を要求する。`award()` の入口で必ず `assertResolvedTitleScopeForTitle(scope, titleKey)` を実行する——callerからscope構築権限を奪ったPR Aの境界を、Store側でも完成させる。手書きのplain objectを `as any` で渡してもruntimeでrejectされる。

`ResolvedTitleScope` の runtime forgery検知は **WeakMap identity** を正本にする（`v2-scope.ts` の `RESOLVED_SCOPE_PROVENANCE: WeakMap<object, ScopeProvenance>`）。当初はmodule-private `unique symbol` をscope objectへ埋め込む方式だったが、これはTypeScript上のbrandingとしては有効でもruntimeの「forge不能」の根拠としては不十分だった——`Object.getOwnPropertySymbols(legitimateScope)` で当該symbolを取得でき、その値を別objectへコピーすればbrandごと偽装できる。加えてlegitimate scope自体もruntimeではmutableなオブジェクトであり、Proxyで包んでnamed fieldsだけ偽装することも可能だった。

現行方式: `resolveTitleScope()` はplain scopeを組み立てた後 `Object.freeze()` し、その**exact object identity**をキーとして `WeakMap` へ canonical snapshot（`titleKey` / `scopeKey` / `start` / `endExclusive` / `observedAt`）を登録して返す。`assertResolvedTitleScope()` は渡されたobjectをそのままWeakMapのキーとして引き（`WeakMap.has()` 相当）、見つからなければ「`resolveTitleScope()` が生成した正規objectではない（forge / 手組み / clone / proxy）」として即reject、見つかった場合もstored snapshotと渡されたobjectの現在fieldsが一致するかを確認する。`assertResolvedTitleScopeForTitle(scope, titleKey)` はさらにprovenanceの`titleKey`を比較し、`ScopeProvenance`（canonical snapshot）を返り値として返す——`Store.award()` はこの返り値のcanonical値を使い、渡された`scope`オブジェクト自身のfieldsを再度信頼しない（belt-and-suspenders）。type-level `unique symbol` brandはTS上のnominal typingとして残しているが、runtime securityの根拠ではない。

`Object.getOwnPropertySymbols()` で legitimate scope の symbol properties を別objectへコピーしたclone、legitimate scope を `Proxy` で包んだもの、いずれもexact object identityが異なるためWeakMap lookupがmissしてrejectされる。legitimate scope自体は `Object.freeze()` 済みのため、field書き換え代入はstrict modeで`TypeError`になる（defense-in-depth）。

このprovenanceはcallerへscopeKey/start/endの構築権限を戻すものではなく、`TitleRuleScope`（ruleのcontextへ渡す形、`toRuleScope()`）にも含めない——rule実装からは見えない。また、source読み込み境界（`readTitleSource()`・`TitleSourceCache`）はtitle単位のcacheを持たず `(userId, sourceKey, scopeKey, start, endExclusive, observedAt)` で共有し続ける——`assertResolvedTitleScope()`（構造チェック＋WeakMap snapshot一致）はそのまま維持し、title provenanceの強制はaward境界（`assertResolvedTitleScopeForTitle()`）だけで行う。これにより、複数titleが同じ`(source, window)`を読む際のcache共有性は壊れない。

### atomicity

`Store.award()` は1回の呼び出しで、単一の `BEGIN IMMEDIATE` transaction内に以下を確定する（途中で1つでも失敗したら全部rollback）。

1. `title_awards` へ `(user_id, title_key, scope_key)` 冪等insert
2. **新規award**なら `title_award_facts` へsnapshotをinsert
3. そのtitleKeyの**first ownership**なら、rarity sequenceを1つ消費して `title_ownerships` をinsert

冪等呼び出し（既にaward済みの`(user,title,scope)`への再award）は、facts・ownership・rarity sequenceのいずれも一切変更しない——先に成立したsnapshotが勝つ。`Store.award()` は外側transaction内から呼べない（`applyCatalog()` と同じ理由でfail-closedする）。

`awardedAt` は `AwardTitleInput` の公開フィールドではない——callerからは入力できない。`awarded_at` / `captured_at` / `title_ownerships.first_awarded_at` はいずれも「Botが実際に永続化を確定した時刻」であり、caller入力を許すと任意の未来時刻を保存できてしまう。`Store.award()` は呼び出しごとに `this.clock()` を**1回だけ**呼び、そのsnapshotを `awarded_at` / `captured_at` / `first_awarded_at` の全てに使う。過去の出来事を表す時刻は引き続き `earnedAt`（callerが渡す、証明できないならnull）が担う——historical repairで過去の出来事を追記する場合も、過去時刻は`earnedAt`に入り、`awardedAt`はそのrepairを実行した時刻になる。

`awardedAt` は、そのscopeを実際に観測した時刻（`scope.observedAt`、`assertResolvedTitleScopeForTitle()` が返すcanonical snapshot経由で取得）より前にはできない——さもないと「まだ観測していない未来のデータを使って過去にawardした」という矛盾した状態を作れてしまう。

### Award Facts JSON validator（`v2-award-facts.ts`）

`facts_json` はそのまま `JSON.stringify()` するだけでなく、award時にruntime validationを行う。

- 許可: `null` / `boolean` / finite number / string / array / plain JSON object
- 拒否: `undefined` / function / symbol / bigint / `NaN` / `Infinity` / `-Infinity` / `Date` / class instance / circular reference
- 上限: シリアライズ後 <= 4096 bytes、深さ <= 4、node数 <= 256
- defense-in-depthとして、明白なidentity-bearing key（`userId` / `user_id` / `counterpartUserId` / `counterpart_user_id` / `channelId` / `channel_id` / `messageId` / `message_id`）と、prototype pollution系key（`__proto__` / `prototype` / `constructor`）をexact matchで拒否する

generic validatorだけでprivacyを完全保証できないことは明記しておく。`{ friend: "Alice" }` はJSONとして合法なので、validatorだけではidentity leakを完全には防げない。主防御はsafe source境界（`v2-sources.ts` の `titleUsable`/`privacy` 契約）・rule review・awardFactsを必要最小限へ翻訳することであり、validatorはその最後の砦にすぎない。

**validationとJSON serializationは単一passで行う**（`serializeAwardFacts()`）。「`assertValidAwardFacts(data)` で検証した後に別途 `JSON.stringify(data)` を呼ぶ」という2段階構成だと、`data` がforged/accessor object（getterが呼び出しごとに異なる値を返す等）だった場合、検証時に読んだ値と実際にpersistされる値が一致する保証が無い（TOCTOU）。`Store.award()` はこの単一pass関数だけを使う——各値をちょうど1回だけ読み、読んだその場でJSON textへ書き出すため、検証結果と永続化される文字列が常に一致する。`assertValidAwardFacts()`（検証専用、シリアライズしない）は、evaluator側の早期fail-closedチェックやDB読み取り時の再検証など、書き込みを伴わない場面のために引き続き残している。

`TitleRuleResult`（`v2-evaluator.ts`）はmatched:false / matched:trueのdiscriminated unionへ分離した。matched:trueは`awardFacts`が**必須**——取得理由が特に無い称号でも`awardFacts: {}`を明示的に返す。これにより「award rowはあるがfacts rowが無い」正常状態を型の上でも作れなくしている。

このdiscriminated unionはTS型としてだけでなくruntimeでも強制する。vitestのesbuild transformはテストbody内のruntime値をtype-checkしないため、TypeScriptを迂回した（あるいは`as any`で誤魔化した）ruleが`matched: "false"`のような非boolean値を返すと、直後の`if (!result.matched)`がJSのtruthy/falsy変換に頼ることになり、discriminated unionのnarrowingが実際のfield構成と食い違ったまま先へ進んでしまう（`matched: "false"`は文字列としてtruthyなのでmatched:true分岐に入るが、実際にはawardFactsが無い、といった矛盾）。`evaluateTitle()` は `rule.evaluate()` 直後に `result.matched !== true && result.matched !== false` を確認し、非booleanならcontract violationとして即throwする——その後で初めて、既存の「matched:falseならearnedAt===null・awardFactsプロパティ無し／matched:trueならawardFacts必須・valid」というguardを適用する。

facts JSONのschema変更（`facts_version`）は、title condition/source/threshold/scope変更（新title key）とは別軸で管理する。`TitleRule.awardFactsVersion`（`defineTitleRule()`の第2引数）に固定し、rule実装の戻り値ごとに付け忘れる事故を防ぐ。

### Rarity sequence

`title_rarity_sequences`（`title_key` PRIMARY KEY、`last_sequence`）が、titleKeyごとのfirst ownership発番counterを持つ。`SELECT MAX(...)+1` のような素朴な処理ではなく、単一rowをUPDATEすることでIMMEDIATE transactionのシリアライズに乗せる。first ownershipを作るときだけsequenceを消費する——同じuserが同titleを別scopeで再awardしても増えない。

`holder_count_at_acquisition` は「そのtransaction時点でDBに記録されていたtitle ownership数（今回のfirst ownershipを含む）」であり、current guild membershipを使った将来のactive population計算とは別概念——今回は勝手に実装しない。

`title_ownerships` にはapplication層のチェックに加えてDB `CHECK`/`UNIQUE`を持たせる: `acquisition_sequence >= 1`、`holder_count_at_acquisition >= 1`、`first_earned_at IS NULL OR first_earned_at <= first_awarded_at`、そして `UNIQUE (title_key, acquisition_sequence)`——titleKeyごとに同じ刻印順を2人が名乗れない。

### Migration / Integrity

v2はまだ本番wiringされていないため、過去のfoundation award（facts/ownershipテーブル導入前に作られたaward行）のfactsをでっち上げて自動backfillしない。`title_awards` にrowがあるのに対応する `title_award_facts` / `title_ownerships` が無い状態を検出したら、明示的なintegrity errorとしてfail-closedする——「本当の取得理由が無いのにあることにする」より安全という判断。

この検証はlazyにしない。`TitleV2Store` の**construction時**に `assertAwardPersistenceIntegrity()` がDB全体を一度スキャンし、欠損があれば即座にfail-closedする——「同じawardを再award()した時だけ検出する」という後追い方式だと、construction後の任意のタイミングまで欠損facts/ownershipを抱えたaward行を正常データとして扱ってしまう（例: retired titleが`hasAward()`だけを見て「既にaward済み」と判定する経路）。旧foundation形式のaward rowが存在するDBでは、この**Store construction自体**がintegrity違反としてfail-closedする。

`assertAwardPersistenceIntegrity()` は単なる「行が存在するか」の確認から、以下のsemantic integrityへ強化されている（いずれか1つでも違反すればfail-closed）。

1. 全awardに対応する `title_award_facts` / `title_ownerships` が存在する
2. 全factsの `facts_version` がvalid（`assertValidFactsVersion()`）
3. `facts_json` がparse可能で、`assertValidAwardFacts()` validatorを通る
4. `captured_at` がvalid（非負整数）
5. `title_award_facts.captured_at` が、対応する `title_awards.awarded_at` と一致する
6. `title_ownerships.first_scope_key` が指すaward行の `earned_at`/`awarded_at` と、`title_ownerships.first_earned_at`/`first_awarded_at` が一致する（＝ownership origin snapshotが実際に参照先awardと矛盾していない）
7. ownershipが存在するtitleKeyには対応する `title_rarity_sequences` 行が存在する
8. `title_rarity_sequences.last_sequence` が、そのtitleKeyの `title_ownerships.acquisition_sequence` の最大値と**完全一致**する（単なる「以上」ではない）
9. `title_rarity_sequences` に行が存在するのに、そのtitleKeyの `title_ownerships` が0件（orphan rarity sequence row）ではない
10. 各 `title_ownerships` 行について `holder_count_at_acquisition === acquisition_sequence`
11. `PRAGMA foreign_key_check` を `title_` prefixのtableへ絞り込んで実行し、違反があればfail-closedする——直接SQL操作や `foreign_keys=OFF` 下での削除等によって作られた孤立child行（親を指すFKが実在しない`title_award_facts`/`title_ownerships`行）は、INNER JOINベースのtargeted queryでは（親が無いので）そもそも結果に現れず検出できない。`PRAGMA foreign_key_check`はこの穴を埋める。他の無関係なアプリケーションテーブルのFK問題まで誤検出しないよう、`title_`prefixのtableだけに絞っている。

8/9のrarity sequenceに関する2点は、`title_rarity_sequences.last_sequence`がfirst ownership時だけ1増え、そのallocationとownership INSERTが同じ`BEGIN IMMEDIATE` transaction内で確定し（rollback時はsequenceも一緒にrollbackする）、ownershipは永久保持で通常削除APIも無い、という契約から導かれる不変条件——normal stateでは常に `last_sequence === MAX(title_ownerships.acquisition_sequence)`（ownershipが1件も無いtitleKeyには`title_rarity_sequences`行自体が存在しない）。`last_sequence`が`MAX(...)`より大きい状態も小さい状態も、ownershipを伴わないsequence消費（またはその逆）が起きた破損を意味するため、両方向をrejectする。10.のholder_count整合は、`holder_count_at_acquisition`が「first ownership transaction時点のDB title ownership総数（今回分を含む）」であり、sequenceもfirst ownershipごとに1から連番で発番されるため、normal stateでは両者が常に一致するという契約から導かれる。

加えて `hasAward()` 自身も、見つけたaward行についてfacts rowが「存在するだけ」でtrueにせず、`awardFacts()`相当の内容validation（version/captured_at/JSON body）を通した上でownershipのbundle integrityを確認してから`true`を返す——construction後にout-of-bandな行が挿入される可能性はゼロではないため、読み取り境界でも二重に守る。偽のrepair/backfillでintegrity違反を迂回することはできない。

`awardFacts()`（read API）も、DB内の `facts_version`・`captured_at`・JSON本体のすべてをvalidateしてから返す——壊れたDB値を空object等で誤魔化さない。

### Series Manifest / Series Mastery persistence（PR B2）

released progression seriesのimmutable manifest（`v2-series.ts`）を実際にDBへ保存し、userのseries mastery（一門完遂）をownershipから永続化する（`packages/core/src/titles/v2-series-store.ts`）。

**永続化の正本は persisted manifest**——`title_series_manifests` / `title_series_members` はcatalog/seriesKey単位のimmutable snapshotであり、runtimeの `BehaviorTitleDefinition` mapではなく、この永続化されたsnapshotが historical な正本になる。`registerSeriesManifests(manifests, behaviorDefinitions)` が、`assertValidSeriesManifest()` / `assertNoOverlappingSeriesMembership()` をバッチ全体へ通した上で、以下をatomicに確定する。

- 既にDBへ登録済みの `(catalog, seriesKey)` は、semantic hashが一致すればidempotent（何もしない）、不一致ならfail-closed（released seriesの内容は書き換えない）。
- 新規登録の場合、渡された配列内だけでなく、**DBに既に登録済みの他series**とのtitle overlapも確認する——`assertNoOverlappingSeriesMembership()` はバッチ内の重複しか見ないため、別途DB上の既存`title_series_members`を検索して確認する（`title_series_members.title_key` のUNIQUE制約が最終防御）。
- `registered_at` はStore clockの1回のsnapshot（呼び出しごとに1回だけ`clock()`を呼ぶ）。callerが任意timestampを注入できない。
- manifest + 全memberは単一の `BEGIN IMMEDIATE` transaction内でatomicに確定する。

**semantic hash**: released seriesの意味が後から変わっていないことを検出するため、`computeSeriesManifestHash()`（`v2-series.ts`）が catalog / seriesKey / masteryEligible / member (titleKey, stage) から決定的なhashを計算する（`label`はpresentation扱いなのでhashに含めない）。member arrayは入力順ではなく**stage順へcanonicalize**してからhashする。hash計算はDB member snapshot（`{titleKey, stage}` のペアだけ）から直接再構成できる形にしてある——construction-time integrity checkがruntimeの `BehaviorTitleDefinition` mapを使わず、DBの値だけから再計算できる。

**Series Mastery**: `reconcileSeriesMasteriesForUser(userId)` が、まだmastery未成立な `mastery_eligible=true` series を対象に、全member titleのownership（`title_ownerships`、awardのscope historyではない）が揃っているかを確認し、揃っていれば `title_series_masteries` へ永続化する。既に成立済みのseriesは何もしない（idempotent）。ownershipは永久なのでmasteryも永久——title lifecycleが後からretiredになってもmasteryを消さない。新しくseries manifestを登録した時点で既に全member ownership済みのuserは、後日のreconcileでmastery可能になる。

**`title_series_masteries.recorded_at` は達成時刻ではない**——「Botがseries mastery成立を初めて確認して永続化した時刻」でしかない。member titleの一部がnon-orderable（`earnedAt===null`）だったり、historical repairで後から追加された場合があるため、真の完遂時刻を安全に一意決定できない。将来《一門皆伝》meta titleのearnedAtが必要になった場合は、`title_awards`から別途proofを組み立てる（PR B2の範囲外）。

**processing chronology**: `recorded_at` は達成時刻ではないが、それでも正常状態では最低限 `recorded_at >= manifest.registered_at` かつ `recorded_at >= MAX(member ownership.first_awarded_at)` が成立する——series manifestが登録される前、または全member ownershipが成立する前にmasteryが処理されることは無いはずだからである。`reconcileSeriesMasteriesForUser()` はclock snapshotがこの最低条件を満たさない場合（clockの逆行・誤った注入等）fail-closedする。`earned_at`（historical achievement time）とは比較しない——達成時刻を推測しない既存契約を維持する。

**semantic integrity**（`assertSeriesPersistenceIntegrity()`、`TitleV2Store` construction時）: mastery行が参照するmanifestが存在し`mastery_eligible=1`であること、mastery userが実際にそのseriesの全member titleをownershipしていること、`recorded_at`が非負整数であること、上記processing chronology契約（`recorded_at >= registered_at` かつ `>= MAX(member ownership.first_awarded_at)`）を満たすこと、同一titleが複数series memberになっていないこと（`UNIQUE(title_key)`のdefense-in-depth再確認）、各seriesのstageが1..N contiguousであること、保存済み`manifest_hash`がDB member snapshotから再計算したhashと一致すること。

さらに、hashチェックとは**独立して**structural integrityも再検証する——manifestごとのmembers>=2・catalog/series_keyがslug形式・member titleKeyがv2.\*namespace・stageが正整数、といった構造契約をDB snapshotだけから直接確認する（runtime definitionsが無いため、title existence・behavior/meta種別・definition側のcollectionDomainKey一致まではここで証明できない）。hash一致はstructural validationの代替にはならない——一方が迂回されても他方が独立して検出する設計。偽mastery/manifestを自動生成して修復しない——欠損・矛盾はfail-closedするだけ。

### Collection Edition lifecycle（PR B2）

activateされたCollection Editionのmanifest snapshotをimmutableにDB保存し、activeなeditionを最大1件に制限し、closeされたeditionをhistorical repairのために保持し続ける（`packages/core/src/titles/v2-collection-store.ts`）。

**activation**: `activateCollectionEdition(edition, definitions, actor, note?)` が `assertCollectionEditionActivatable()`（構造契約 + 現在時点のactivation eligibility）を必ず先に通した上で、単一transaction内で以下を判定する。

- activeなeditionが既に別に存在する → reject（`title_collection_state` のsingleton row `active_edition_key` が最大1件を保証する唯一の実効的な仕組み——これを迂回するDB制約は存在しないため、reject自体がこの契約の唯一の防衛線）
- editionKey未登録 → edition + membersをatomic insert、active pointerを設定
- 同editionKeyが既にactiveかつsemantic hash一致 → idempotentな`"already_active"`
- 同editionKeyだがhash不一致 → reject（editionのmembers/milestonesは書き換えない）
- 同editionKeyがclosed済み → reject（**reopen禁止**）

`activatedAt` はStore clockのsnapshot。callerが任意timestampを注入できない。active pointerを設定するUPDATE文は`changes===1`を要求する——`WHERE`句が意図せず0行しか更新しなかった（stateの整合が崩れている等）場合、静かに成功したふりをせずfail-closedする。

**`title_collection_state` singleton rowはfail-closed**——rowの欠損は「activeなeditionが無い」正常状態ではなくintegrity violationとして扱う。`ensureTitleV2Schema()`（`INSERT OR IGNORE`）が必ずid=1行を作るため、通常運用でこの行が消えることは無い。欠損時に`{active_edition_key:null}`を返すfail-openな実装だと、「out-of-bandにstate rowが削除された」破損状態を正常状態と区別できなくなる。同様に、`activeCollectionEdition()`もactive pointerが指すedition行が実際には存在しない場合、`null`を返さずthrowする——「activeなし」と「pointerが壊れている」を混同しない。

**close**: `closeCollectionEdition(editionKey, actor, note?)` が、現在activeなeditionだけをcloseできる。契約は以下の通り——**stateを先に確認してから**closed判定を行う（順序が重要。後述）。

- 存在しないeditionKey → throw
- 既にclosed済みで、かつ他に何もactiveでない → idempotentな`"already_closed"`（**close metadataは書き換えない**——2回目のcloseで別のactor/noteを渡しても、最初のclose時点のclosedBy/closeNoteのまま）
- 既にclosed済みだが、**別のeditionが現在active** → reject（**stale close request**）。このeditionKey自体は正しくclosed済みでも、その後に別editionが activate→close の運用サイクルを経て今activeになっている状況で、古いeditionKeyへのclose要求は「今」意味を持たない——closed判定をstateより先に行うと、このケースまで単なる冪等な`already_closed`として誤って受理してしまう
- closed済みではないが、別editionが現在active（このeditionはそもそもactiveになったことが無い等） → reject

`closed_at`/`active pointerのNULL化`は単一transaction内でatomicに確定する（state clearのUPDATEも`changes===1`を要求する）。一度closedになったeditionは`activateCollectionEdition()`側が再openを拒否する。

**semantic hash**: Collection Editionもimmutable semantic hashを持つ（`computeCollectionEditionHash()`、`v2-collection.ts`）。hash対象は `editionKey` / `milestones`（全milestone値） / member（**titleKey順にsort**した上での titleKey・collectionDomainKey・collectionCredit・fullClearRequired）。`activatedAt`/`activatedBy`/`activationNote`/close metadataはhashから除外する——運用ログであり、editionの構造そのものではない。canonical order計算には`String.prototype.localeCompare()`ではなく、locale/ICUに依存しないUTF-16 code unit比較（`compareCodeUnit()`）を使う——`canonicalHash()`は配列順をそのまま保存するため、実行環境（ロケール・ICUバージョン）が変わっても同じ入力からは常に同じhashが得られる必要がある。

**historical repair proof契約（§16）**: closed editionのmemberを「close時点で持っていたと証明できる」とみなす条件は次のいずれか。

- **A**: そのuser/titleのawardに `earned_at IS NOT NULL AND earned_at < edition.closed_at` が1件以上ある（正確な達成時刻がclose以前だと証明できる——historical repairでも可）
- **B**: そのuser/titleのawardに `awarded_at < edition.closed_at` が1件以上ある（close前にBotが既にaward記録済み——earnedAtが不明でも、その時点でownership済みだったこと自体は証明できる）

**`<` であって `<=` ではない**（same-second tieはfail-closed）。Store clockはUnix秒精度（`Math.floor(Date.now()/1000)`）のため、`close at T` と `close直後の通常award at T`（同じ秒に丸められる）は`awarded_at === closed_at`になり得る——秒精度のままでは同秒内の前後関係を証明できないため、同秒tieは保守的に対象外とする。`<=`のままだと、close直後（同じ秒内）の通常取得を誤って旧editionへcreditしてしまう。

close後にhistorical repairされたawardは、earnedAtが正確にclose**より前**だと証明できる場合だけ（条件A）旧editionへcreditされる。close後に普通に取得した `awardedAt>=closedAt` かつ `earnedAt=NULL` のtitleは、close以前に持っていた証明が無いため旧editionへは一切creditしない。domain breadthもこの同じ「owned扱いにできるtitle集合」から算出するため、closed proofと同時にfreezeされる。

**`collectionEditionProgress(userId, editionKey)`**: active editionは現在の `title_ownerships` を使い、closed editionは上記proof契約だけをowned扱いする。返却値は `collectionOwnedCount`/`collectionTotalCount`/`collectionOwnedDomainCount`/`collectionTotalDomainCount`/`fullClearOwnedCount`/`fullClearRequiredCount`/`fullClearRemainingCount`/`fullClearComplete`/`state`/`editionKey`のみ——**member titleKey・hidden title名・未取得hidden条件は一切含まない**（hidden title leak防止）。meta evaluatorが必要とするのはこの集計値だけであり、このAPIをそのままユーザー向けprogress rendererへ渡してよい。一方、`collectionEdition(editionKey)`/`listCollectionEditions()`（管理用read API）はmember titleKeyを含む——**ユーザー向けprogress rendererへそのまま渡してよいAPIではない**ことをdoc commentで明示している。

**runtime compatibility API**: PR #152で決めた「active editionのpersisted manifestとruntime contractがズレていたらfail-closed」を実行可能にするAPI `assertActiveCollectionEditionMatchesRuntime(runtimeEdition, definitions)` を用意した——runtime manifestのstructural/activatable validation、DB active editionの取得、editionKey一致、semantic hash一致を確認し、mismatchならthrowする。まだbot startupへwiringしない（PR B2の範囲外）——APIとtestsだけを用意する。

**semantic integrity**（`assertCollectionPersistenceIntegrity()`、`TitleV2Store` construction時）: active pointerがNULLならunclosed editionは0件、active pointerが非NULLなら対応editionが存在し`closed_at IS NULL`、unclosed editionはexactly 1件、closed metadata chronology valid（`closed_at>=activated_at`、`closed_at IS NULL`と`closed_by IS NULL`の同値性）、members/milestonesの構造整合（DB member snapshotから再計算した値がmilestoneの不等式契約を満たす）、保存済み`manifest_hash`がDB snapshotから再計算したhashと一致すること。construction時点ではruntimeの `TitleDefinition` mapが無いため、「現在title lifecycle=activeか」はここで判定しない——それは`assertActiveCollectionEditionMatchesRuntime()`の責務。

hashチェックとは**独立して**structural integrityも再検証する——`edition_key`がslug形式、member titleKeyがv2.\*namespace、member `collectionDomainKey`がslug形式、`collection_credit`/`full_clear_required`が0/1、両方falseのmemberが存在しない、milestone全値が非負整数、といった構造契約をDB snapshotだけから直接確認する。hash一致はstructural validationの代替にはならない——一方が迂回されても他方が独立して検出する設計（title existence・behavior/meta種別・definition側のcollectionDomainKey一致は、runtime definitionsが無いためここでは証明できない）。

### Rank Title Unlock（PR B3）

現在の文位・声位（`packages/core/src/rank/tiers.ts` の `RankTier`）は、rank quantity progression（XP/level）とは別の**identity display candidate**——一度到達した位名は、単なる「今のstatus」ではなく、《名乗り》として選べる永続的な所持物になる。

`RankTier` は `key: RankTitleKey`（`` `rank.${track}.${string}` ``）というstable identity keyを持つ。DB identity（`rank_title_unlocks` / `profile_identity_equips`）は必ずこの`key`を正本にする——**display name・array index・`rank_text.last_tier`/`rank_voice.last_tier`のnumeric index・`minLevel`だけでは識別しない**。18件の`key`/`track`/`minLevel`/`name`は明示的literalとして固定し、`` `rank.${track}.lv${minLevel}` `` のようなruntime組み立てはしない——released後はこの組をkey/name/minLevelとも実質freezeとして扱う（display typo修正等を除く）。`rank_text.last_tier`/`rank_voice.last_tier`のarray indexは、`RankEngine`内部のlegacy bookkeeping/cache（現在のtierを素早く引くための最適化）としてのみ残し、`rank_title_unlocks`/`profile_identity_equips`へは絶対に使用しない。

**一度到達した位名は永久unlock**（`rank_title_unlocks`、`packages/core/src/titles/v2-identity-store.ts`）。XP低下・rank計算変更等で削除しない——constructor integrityも、現在のrank XP/levelとunlock済みtierの整合性を要求しない（過去にLv100へ到達して現在Lv50相当へ下がっていても、Lv100位名unlockは正当）。

**historical reconcile vs live observed transitionの区別**が核心の契約:

- **live observed transition**（`recordRankTitleTransition(userId, track, beforeLevel, afterLevel)`）: 今まさに観測した`beforeLevel`→`afterLevel`のlevel変化。跨いだtier（`beforeLevel < minLevel <= afterLevel`）は`unlocked_at = Store clock`（正確な到達時刻として扱える）。downward transition（`afterLevel < beforeLevel`）はreject。
- **historical reconcile / backfill**（`reconcileRankTitleUnlocks(userId, track, currentLevel)`）: 現在levelから逆算して「過去のいつか到達したはず」のtier（`minLevel <= currentLevel`）を補完する。`unlocked_at = NULL`——**「今Lv75だから過去のLv50到達時刻も今だったことにする」という捏造は絶対にしない**。

`beforeLevel=50, afterLevel=75`のような観測で、DBに過去unlock（Lv0/5/15/30/50）が欠損している場合でも、それらのtierを「今回75になった時刻」にはしない——`minLevel<=beforeLevel`のtierはhistorical missingとして`unlocked_at=NULL`になる。**既存のunlock行（`unlocked_at`がNULLであれnon-nullであれ）は、後続のtransition/reconcileで一切UPDATEしない**——first persisted truthをimmutableに保つ。`recorded_at`はcaller入力ではなく、必ず`clock()`のsnapshot。

将来live wiring時、rank XP更新成功→identity unlock write前にprocess crash、というケースが起こり得る。その場合はdaily reconcileによってmissing rank titleを後から`unlocked_at=NULL`として回収できる——「live writeを逃したから後から現在時刻をexact unlock時刻として捏造」しないための設計上、reconcile APIを observed transition APIから意図的に分離してある。

### 《名乗り》— Profile Identity 3-slot（PR B3）

印（title ownership）と位名（rank title unlock）を共通の3枠へ装備する（`profile_identity_equips`、`equipIdentity()`/`unequipIdentity()`/`listIdentityEquips()`）。`ProfileIdentity` はdiscriminated union（`{kind:"title", titleKey}` | `{kind:"rank_title", rankTitleKey}`）——DB raw shapeをそのままpublic APIへ漏らさない。

- 初期0行。unlockやtitle ownership取得時に自動equipしない——unlockとequipは完全に別の関心事。
- title equipは`title_ownerships`だけを見る。**scopeKeyは装備identityに含めない**——印のidentityはtitleKeyそのもの。retired titleでも既存holderは引き続きequip可能（構造上、runtime definitionのlifecycleに依存しない——`equipIdentity()`はdefinitions mapを一切受け取らない）。
- rank title equipは`rank_title_unlocks`だけを見る。現在levelが`tier.minLevel`を満たしているかは要求しない。
- 同じidentityを複数slotへ重複させない: target slotに別identityがあればreplace（既存occupantはunequip）、同identityが別slotにあればmove、同identityが既に同slotならidempotent no-op。単一transactionでatomic。partial unique index（`title_key IS NOT NULL`/`rank_title_key IS NOT NULL`でそれぞれ絞った`UNIQUE(user_id, title_key)`/`UNIQUE(user_id, rank_title_key)`）がDB層での最終防御。
- 現在の文位・声位（statusとしての表示）と《名乗り》（slot I/II/III、過去にunlock済みの任意の位名を選べる）は別概念——現在文位が「冥獄の弁士」でも、《名乗り》には「囁く者」を選んでよい。B3ではUI実装しないが、data modelはこの意味を壊さない。

**semantic integrity**（`assertRankTitleUnlockIntegrity()` / `assertIdentityEquipIntegrity()`、`TitleV2Store` construction時）: `rank_title_key`が現在のstable registryに存在すること、`unlocked_at`/`recorded_at`の型・chronology、`profile_identity_equips`のslot範囲・`identity_kind`の妥当性・discriminated columnsの排他性、title equipには対応する`title_ownerships`、rank title equipには対応する`rank_title_unlocks`が存在すること、同一identityのduplicate禁止。既存B1のPRAGMA foreign_key_checkは`title_`prefixのtableだけをfilterしていたため、`rank_title_unlocks`/`profile_identity_equips`（このprefixに当てはまらない）は明示的なJOIN check + `PRAGMA foreign_key_check(profile_identity_equips)`の両方でdangling refを検出する。

### Legacy `title_equips`の退役準備（PR B3）

旧`title_equips`（`user_id, slot, title_key, scope_key`）は最終architectureでは退役する——title award occurrenceへ直接boundされている、scopeKeyが装備identityへ混ざっている、rank titleを装備できない、という3つの理由から。

PR B3では**tableそのものはDROPしない**（既存DB compatibility/rollback/inspectionのため）が、`TitleV2Store.equip()`/`unequip()`/`listEquips()` という旧scope-bound public mutation/read APIは退役した。新しいruntime codeは `equipIdentity()`/`unequipIdentity()`/`listIdentityEquips()` だけを使う。

**old `title_equips`から`profile_identity_equips`への自動migrationはしない**——v2はまだproduction wiringされておらず、旧foundation期間のscope-bound equip rowが本当にユーザーの最終identity選択か保証できないため。旧rowは残してよく、新identity equipsが空でも正常。construction時に両者のmirror一致を要求しない。fresh v2 cutover時にどう扱うかはproduction migration PRで明示的に決める。

**follow-up（production profile cutover、PR B3の範囲外）**: 現在の `/プロフィール` は `services.titles.evaluate(target.id)` を呼んでおり、「プロフィールを見るだけで旧v1称号を取得する」挙動が残っている。v2 cutover時には `/プロフィール` からこの`evaluate`呼び出しを除去し、プロフィール閲覧を完全read-onlyにする。同時に《名乗り》（slot I/II/III）の表示・現在の文位/声位の別枠表示・v2 identity equip UIへ切り替える。PR B3ではこの切り替えを一切行わない——`apps/bot` 配下は変更していない。

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

**persistenceのpublic mutation boundaryは `TitleV2Store` のmethodsだけに限定する**（PR B2）。
`v2-series-store.ts` / `v2-collection-store.ts` の関数（`registerSeriesManifests` /
`reconcileSeriesMasteriesForUser` / `activateCollectionEdition` / `closeCollectionEdition`
等）は `Database` + `clock` を直接受け取るraw persistence APIであり、`@meigokujo/core/titles/v2`
からはexportしない。これらを公開すると、callerが `TitleV2Store` の内部clockを経由せず任意の
clockを注入でき、「`registered_at`/`recorded_at`/`activated_at`/`closed_at`はStore clock」
という契約（callerが任意timestampを注入できない）を迂回できてしまう。これらの関数は
`v2-store.ts` が内部でimportして `TitleV2Store` のmethodsとして再公開するためだけに使う。
contract validator（`assertValidSeriesManifest()` 等）・semantic hash計算関数
（`computeSeriesManifestHash()` 等）・公開type はexportして構わない——mutationを伴わず、
clock契約に影響しないため。integrity helper（`assertSeriesPersistenceIntegrity()` 等）も、
`TitleV2Store` construction時に内部で呼ぶだけで、それ単体を公開API化する必要は無い。

### Meta評価 / Evaluation Orchestration Kernel（PR C1）

behavior award → Series Mastery reconcile → Collection progress → meta title評価を、
core内で1つの評価pipelineとして接続する（`packages/core/src/titles/v2-meta.ts` /
`v2-pipeline.ts`）。まだBot本番経路へは接続しない——production catalog・Bot Services
wiring・schedulerはこのPRの範囲外。

**Evaluation order**:

```text
Behavior（trigger対象ruleだけ）
  ↓
Ownership（Store側で確定済み）
  ↓
Series Mastery reconcile（userごと1回）
  ↓
Meta snapshot構築（userごと1回）
  ↓
Meta Award
```

`evaluateUserPipeline(db, store, plan, userId, observedAt, trigger, options?)` がこの順序を
固定する唯一のAPI。Behavior→Meta→Seriesの順にはしない——《一門皆伝》のようなmeta titleが、
同じpass内で成立したばかりのSeries mastery/behavior awardを見られなくなるため。

**MetaTitleRule契約**（`v2-meta.ts`）: behaviorのTitleRuleとは別contract。
`defineMetaTitleRule(definition, impl)` が `defineMetaTitle()` のruntime検証を必ず通す
——behavior definitionをmeta ruleへ、meta definitionをbehavior TitleRuleへ渡すことは
（型でもruntimeでも）できない。

- meta ruleへ `Database` / `TitleV2Store` / userIdを渡さない——ruleが独自SQLを書いたり、
  特定userを名指しした special caseを書けたりする経路を作らない。ruleへ渡すのは
  `{ scope, snapshot }` だけ。
- `MetaTitleRuleResult` は `matched:false` / `matched:true & awardFacts` の
  discriminated union。**earnedAtをruleに決めさせない**——meta titleはbehavior
  award・Series Mastery・Collection Edition progress・historical repairという複数の
  永続状態から導出され、その一部はnon-orderableであり得るため、「meta条件を歴史上
  初めて満たしたexact時刻」を一般には証明できない。`evaluateMetaTitle()` はaward時に
  常に `earnedAt: null` を固定する——recorded/awarded processing timeを achievement
  timeへ偽装しない。
- behavior evaluatorと同じ堅牢性: matched strict boolean・matched:falseへの
  awardFacts混入拒否・matched:trueのawardFacts必須+`assertValidAwardFacts()`・
  definitionの独立copyでの再検証（rule実装が評価中にdefinitionを書き換えても
  以降の判定へ影響しない）。
- lifecycleの意味はbehavior evaluatorと同じ: `disabled` はscopeも解決せず
  `evaluate()` 自体を呼ばない、`retired` はmatchedでも新規awardしない
  （既存awardの有無だけ見る）。

**TitleMetaSnapshot**（`v2-meta.ts` の `buildMetaSnapshot()`、internal）: meta ruleへ
渡す、sanitizeされたpersisted-state snapshot。

- `behaviorOwnershipCount`: `store.listOwnerships(userId)` を、評価planのbehavior
  rule定義key集合へ照合してカウントする。meta title自身のownership・rank title
  unlock（別テーブルなので構造的にここへ混ざらない）は絶対に数えない——meta titleの
  award自身がbehaviorOwnershipCountを増やす自己参照（Meta-to-Meta recursion）を
  構造的に防ぐ。
- `seriesMasteries`: `store.listSeriesMasteries(userId)` から `catalogKey`/`seriesKey`
  だけを抜き出す。
- `collectionEditions`: `store.listCollectionEditions()`（**active/closed両方**）+
  各editionの `store.collectionEditionProgress()` をそのまま使う——current runtime
  catalogを再計算したり、独自SQLで所有数を数え直したりしない。closed editionの
  historical repair proof契約（B2 §16、`earned_at < closedAt` または
  `awarded_at < closedAt`、same-second tieはfail-closed）を、meta snapshot側で
  迂回できない設計にしている。
- 絶対に含めない: userId・counterpart userId・member titleKey一覧・missing
  titleKey・hidden title名/条件・raw award scope list・raw DB row・channel ID・
  message ID・relationship pair identity・rank title unlock・profile equips・
  edition運用metadata（activatedBy/closedBy/activationNote/closeNote）。
- 構築後は配列・nested objectまで含めてdeep-freezeする——同じMeta evaluation pass内で
  rule Aがsnapshotを書き換えてrule Bの判定へ影響することを防ぐ。
- snapshotはMeta rule群を回す前に**1回だけ**構築し、Meta award後に再構築しない——
  これによりMeta→Meta recursionを構造的に防ぐ。

**forged snapshot経路を作らない**: `buildMetaSnapshot()` / `evaluateMetaTitle()` は
internal関数で、`v2.ts`（`@meigokujo/core/titles/v2`）からはexportしない。callerが
snapshotを自由に組み立ててaward()まで到達できる公開APIは存在しない——meta snapshot
構築はevaluation pipeline内部だけで行う。

**TitleEvaluationPlan**（`v2-pipeline.ts`）: `defineTitleEvaluationPlan(behaviorRules,
metaRules)` がbehavior/meta ruleをまとめ、以下を検証する: behavior rule定義は
kind:"behavior"であること・meta rule定義はkind:"meta"であること（手で組み立てた/kindを
書き換えたforged ruleも `defineBehaviorTitle()`/`defineMetaTitle()` のruntime guardで
弾く）・awardFactsVersionの妥当性・behavior/meta同士および横断でのkey重複禁止。
返り値の配列はfreezeする。

**released ruleをplanから消さない契約**: evaluation planは「今activeなtitleだけの
一覧」ではなく、v2 runtimeが知っているreleased definitions/rulesのregistry。
retired/disabledなruleも残す——lifecycleはrule/definition自身が制御する。これにより
`behaviorOwnershipCount`等が、historical ownershipのkind判定（そのtitleKeyが
「behavior title」だったか）を維持できる。

**trigger-aware behavior selection**（§19）: `evaluateUserPipeline()` はbehavior
stageで `rule.definition.triggers.includes(trigger)` のruleだけを評価する。
`daily` trigger等を「無条件で全ruleを評価する」魔法triggerにはしない——
`daily`を宣言したruleだけがdaily passで評価される。meta ruleはtriggerを持たない
——metaはbehavior source actionの結果ではなくpersisted stateの結果として成立する
ため、どのpipeline triggerであってもbehavior→series→meta snapshot→meta評価の順で
確認してよい。

**Pipeline result**: `TitleUserPipelineResult` は `{ userId, trigger, behavior,
series, meta }` ——新規取得だけに絞らず各stage resultを返す（audit・通知判断が
しやすいように）。

**Pipelineはidempotent/resumable、atomic all-or-nothingではない**: Behavior
award・Series reconcile・Meta awardの全体を1つの外側 `BEGIN IMMEDIATE`
transactionへ包まない——既存Store mutationはそれぞれ独立にIMMEDIATE契約を持つ。
外側transactionへ包むとnested savepoint化して保証が変わる。exceptionは
fail-fastで即座に呼び出し元へ伝播する——途中のruleがthrowしても残りのruleを
catchして続行するbest-effort evaluatorにはしない。例えばBehavior rule Aが
award成功、Behavior rule Bがthrowした場合、Aはrollbackされない。次回pipelineを
retryすればAは`already_awarded`、Bだけ再試行される。Series/Meta stageも同様
——behavior成功・series成功・meta throwでも、次回metaだけretryできる。
「半端に残るバグ」ではなく、各永続操作がatomicでpipeline全体はretriable、という
設計。

**Series reconcile / Meta snapshot構築はuserごと1回だけ**（§34, §35）:
`reconcileSeriesMasteriesForUser()` はbehavior stage完了後に1回だけ呼ぶ
——behavior ruleがawardするたびには呼ばない。Meta snapshotも同様、series
reconcile後に1回だけ構築し、meta rule数だけDBを読み直さない（100前後のrule規模を
前提にした性能設計）。

**evaluateBatchPipeline**: 複数user向け。userごとに behavior→series→meta を
完了させてから次userへ進む——全userのbehaviorを先に全部実行してから
series/metaへ進む二段階方式にはしない（1人分のpipeline orderを常に保つ）。
`TitleSourceCache` はbatch全体で共有してよい——cache keyにuserIdが含まれる
既存契約はそのまま維持する。

**follow-up（PR C1の範囲外）**: relationship private evidence・evaluator
orchestrationのproduction wiring・bulk source planner・rank-title live
wiring/daily reconcile・source expansion・production 99-title catalog・
shadow evaluation/threshold calibration・production cutover
（`/プロフィール` read-only化・《名乗り》UI・notification等）。

### Relationship private evidence（PR C2）

「特定の同じ相手との関係が積み重なった」ことを表すbehavior title（将来の再縁・深縁・
腐れ縁・宿縁等）のための、private witness resolution境界と非開示契約。

**Public semantic / Private witnessの分離**:

- `vc_social_safe`（`privacy: safe`, `titleUsable: true`）: 公開semanticとして
  relationship titleが依存を宣言するsource。counterpart identityを含まない集計値
  （`distinctCoPresentUsers`/`maxRepeatedDaysWithOneCounterpart`/
  `trustedOverlapSeconds`）だけを持つ——B/C1から変更していない。
- `vc_co_presence`（`privacy: restricted`, `titleUsable: false`,
  `restrictedUse: "relationship_private_evidence"`）: 生pairwise data
  （counterpart identityを含む）。**この用途のためにtitleUsableをtrueへ緩めていない**
  ——`restrictedUse`は「特定の内部private-evidence resolverだけが読んでよい」という
  用途を型として固定するラベルであり、`assertRestrictedUseContract()`が
  `privacy==="restricted"` かつ `titleUsable===false` を強制する（safe/forbidden
  sourceへ`restrictedUse`を付けることも禁止）。generic source reader coverage
  （`v2-sources.ts`の`SOURCE_READERS`）には引き続き追加しない——`readTitleSource()`
  経由でruleから読むことはできないまま。

**generic ruleはrestricted sourceを読めない**: `vc_co_presence`は
`v2-relationship-evidence.ts`（internal、`v2.ts`から一切exportしない）だけが
`computeCoPresenceOverlaps()`を呼んで読む。generic `TitleRule`/`MetaTitleRule`へ
counterpart identity・raw pair row・Database・Storeを渡す経路は無い。

**relationship ruleはanonymous candidateだけ見る**: `RelationshipTitleRule`
（`v2-relationship.ts`）はgeneric `TitleRule`とは別contract。`evaluateCandidate()`
へ渡す`RelationshipTitleRuleContext`は`{ scope, candidate }`のみ——`candidate`
（`RelationshipCandidateSnapshot`）は`{ repeatedJstDays, trustedOverlapSeconds }`
だけを持ち、counterpartUserId・userA/userB・channelId・jstDays[]の実日付等は一切
含まない。userId・Database・Store・source cache・全candidate一覧もcontextへ渡さない
——1candidateずつ評価する。`sources`はVC co-presence専用に限定し、exactly
`["vc_social_safe"]`を要求する（`defineBehaviorTitle()`の既存registry検証を
再利用するための宣言であり、実際の候補解決は`vc_social_safe`を`readTitleSource()`
経由で読むわけではなく、restricted resolverが直接`vc_co_presence`から解決する）。

**候補の全件評価とdeterministic witness選択**: subjectと重なった各counterpartについて、
匿名candidateを1件ずつruleへ渡す（呼び出し順はcounterpartUserId code-unit ASCで
決定的、localeCompareは使わない）。1件でもmatchedならtitleはmatched。複数candidateが
matchedした場合、private evidenceとして保存するprimary witnessを決定的に1人選ぶ
（`selectPrimaryWitness()`、優先順: repeatedJstDays DESC → trustedOverlapSeconds DESC
→ counterpartUserId code-unit ASC、内部tie-breakのみ）。

**earnedAtは常にnull**: `vc_co_presence`は`orderable: false`であり秒精度tieや
trust境界もあるため、「N日目を達成した正確な時刻」をprocessing timeから捏造しない。
`RelationshipTitleRuleResult`はearnedAtを持たない——`evaluateRelationshipTitle()`が
award時に常に`earnedAt: null`を固定する（B2の通常ルールに従い、closed Collection
Editionでpost-close awardされたrelationship titleは旧editionへcreditされない。
historical exact achievement timeを主張しない）。

**private evidence provenance**: `v2-relationship-evidence.ts`の
`resolveRelationshipPrivateEvidence()`だけが`ResolvedRelationshipPrivateEvidence`を
作れる（`v2-scope.ts`の`ResolvedTitleScope`・`v2-pipeline.ts`のEvaluation Plan
provenanceと同じWeakMap identity方式）。callerが手書きの
`{counterpartUserId:"...", repeatedJstDays:999}`のようなobjectを
`TitleV2Store.awardRelationship()`へ渡すことはできない。canonical provenanceは
`(subjectUserId, titleKey, scopeKey, observedAt, counterpartUserId,
repeatedJstDays, trustedOverlapSeconds)`を保持し、`requireRelationshipEvidenceProvenance()`
がtitle A用に解決したevidenceをtitle Bへ・別userへ・別scopeへsubstituteすることを拒否する。

**DB private evidence**: `title_relationship_private_evidence`
（`user_id, title_key, scope_key`をPKに、`counterpart_user_id`/`repeated_jst_days`/
`trusted_overlap_seconds`/`evidence_version`/`captured_at`を持つ）に、
counterpart identityを含むaudit evidenceを保持するが**一切非公開**。identityは
award occurrence単位（`user_id, title_key, scope_key`）——ownership単位ではない
（同じrelationship titleを月ごとに複数scope awardすれば、各scopeで別private witness
を持ち得る）。`title_ownerships`へcounterpartを追加しない——「このtitleはBobとの
titleだからownership identityもBob込み」にはしない。counterpart_user_idへ
users table相当のFKは張らない——historical evidenceであり、相手が後にguildを
抜けても過去のtitle evidenceを壊さない。

**award bundle（4-way atomicity）**: `TitleV2Store.awardRelationship()`が、
既存の`award()`と共有する`performAward()`（private）を通じて、単一
`BEGIN IMMEDIATE` transaction内で `title_awards` / `title_award_facts` /
`title_ownerships`+rarity sequence（first ownership時だけ） / private evidence
を確定する。どれか1つ失敗すれば全部rollbackする。冪等呼び出し（既にaward済みの
`(user,title,scope)`への再評価）は、facts・ownership・**private evidenceも**
一切変更しない——後からより強いcandidateが現れてもfirst persisted witnessを
上書きしない。award行があるのにevidenceが無い状態を発見したら、現在の候補から
自動backfillせずintegrity violationとしてfail-closedする（B1のfacts/ownership方針と
同じ）。Store constructionにはruntime evaluation planが無いため「このtitleKeyは
relationship titleだからevidence必須」という判定はできない——`assertRelationshipEvidenceIntegrity()`
は既に存在するevidence行の内容・chronology一致（`captured_at===award.awarded_at`）
だけを検証し、missing evidenceの検出は`hasRelationshipAward()`（読み取り境界）と
`awardRelationship()`（書き込み境界）が個別にfail-closedする。error messageに
counterpart_user_idを含めない。

**non-disclosure**: counterpart_user_idは以下へ一切流さない——awardFacts・
title ownership・profile・Meta snapshot・pipeline result（`RelationshipTitleEvaluationResult`
にcounterpart fieldは無い）・notification・generic title source・analytics export・
public API。`@meigokujo/core/titles/v2`は`defineRelationshipTitleRule()`と
counterpart identityを含まないcontract type（`RelationshipCandidateSnapshot`/
`RelationshipTitleRuleContext`/`RelationshipTitleRuleResult`/
`RelationshipTitleEvaluationResult`）だけを公開する。`resolveRelationshipCandidates()`/
`resolveRelationshipPrivateEvidence()`/`requireRelationshipEvidenceProvenance()`/
`evaluateRelationshipTitle()`はexportしない——counterpartをpublicに読める
raw read API（`listRelationshipEvidence()`等）は今回作らない。

**lifecycle / read minimization**: `active`はcandidate matchでaward。`retired`は
新規awardしない——既存awardの有無を`hasRelationshipAward()`（safe existence check、
counterpartを返さない）だけで確認し、**restricted candidateを解決しに行かない**
（privacy minimization）。`disabled`はscopeも解決せず、restricted sourceも読まず、
ruleの`evaluateCandidate()`も呼ばない。restricted `vc_co_presence`を読むのは、
active relationship ruleが実際にtrigger対象になったpassだけ——trigger対象外・
disabled・retired・generic title evaluation・Meta evaluation・collection
progress等では読まない。

**Evaluation Plan / Pipeline統合**: `defineTitleEvaluationPlan(behaviorRules,
metaRules, relationshipRules = [])`——3引数目は省略可で既存2引数呼び出しはそのまま
動く。key uniquenessはgeneric behavior / relationship behavior / metaの全横断
——どの組で同じv2 keyを使ってもreject。relationshipRulesもPR #156のcanonical
compiled plan（WeakMap provenance）へ同じcanonicalize/freezeを適用する——plan
構築後に元ruleのdefinitionを書き換えてもpipeline semanticsは変わらない。
pipeline順序は: generic Behavior rules → Relationship Behavior rules →
Series Mastery reconcile → Meta snapshot構築 → Meta rules。Meta snapshotの
`behaviorOwnershipCount`にはgeneric behavior + relationship behaviorの両方の
ownershipを数える（meta ownership・rank title unlockは数えない、既存契約を維持）。
`TitleUserPipelineResult`に`relationship: RelationshipTitleEvaluationResult[]`を
追加——counterpart identityは含まない。

**follow-up（C2の範囲外）**: counterpartを本人へ開示する機能は今回実装しない
——将来別PRで、caller authorization・disclosure policy・必要ならmutual consent・
audit・output minimizationを設計する。「DBにあるからそのまま返す」は禁止。
今回はprivate evidence persistence + non-disclosure boundaryまで。

### Bulk Source Prefetch Planner（PR D1）

`TitleSourceCache`はuserごとのcache（key: `(userId, sourceKey, scopeKey, start,
endExclusive, observedAt)`）——N人 × M ruleが同じ(source, semantic scope)を
共有していても、そのままではN回derived計算が走る。VC derived関数
（`computeEmptyStartThenJoined`/`computeLastOccupant`/`computeGroupSizeSeconds`/
`computeSafeSocialAggregates`）は元々`userIds?: readonly string[]`でbulk計算
できる——このPRは、その既存能力をcache層まで持ち上げる**読み取り専用の最適化
plannerを追加するだけ**。Bot/scheduler配線・production catalog・新source・
rank-title live wiring・profile/notification・relationship-disclosure等は
このPRの範囲外。

**cache/group key生成の一元化**: `v2-sources.ts`に`scopeIdentityFor(scope)`
（`[scopeKey, start, endExclusive, observedAt]`）を土台とし、`cacheKeyFor(userId,
sourceKey, scope)`（既存`TitleSourceCache`のcache key）と`sourceScopeGroupKeyFor(
sourceKey, scope)`（bulk group key、internal export）の両方がこれを共有する
——key生成ロジックを2箇所へコピペしない。groupのidentityは`(sourceKey,
scope.scopeKey, scope.start, scope.endExclusive, scope.observedAt)`——**`titleKey`
はgroup identityに含めない**（既存cacheのscope-based共有philosophyと同じ）。
複数title/ruleが同じ(source, scope)を宣言していれば1 groupへmergeする。同じ
windowでも`scopeKey`が違う（例: 別々のevent）場合は別group扱いのまま。

**bulk source readers（正本）**: `v2-sources.ts`に`BULK_SOURCE_READERS: {
[K in TitleUsableSourceKey]: BulkSourceReader<K> }`を追加。型レベルの
exhaustiveness（新しいtitleUsable sourceを追加してbulk readerを足し忘れると
コンパイルエラー）に加え、`assertBulkSourceReaderCoverage()`が既存
`assertSourceReaderCoverage()`と同じ理由でruntime側も守る。**bulk readerが
正本**——単一user向けの既存`SOURCE_READERS`は`BULK_SOURCE_READERS[key](db,
[userId], scope).get(userId)!`へ委譲する薄いwrapperに書き換えた。single/bulkの
semanticsを別々に実装して片方だけ将来修正される事故を、実装を1本化することで
構造的に防ぐ。`bump_events`は`WHERE user_id IN (...) AND created_at >= ? AND
created_at < ? ORDER BY user_id, created_at`のchunked SQLで直接読む。4つのVC
sourceは既存derived関数のbulk引数へそのまま委譲する——第三者/相手ユーザーの
context読み込み（occupancy/co-presence計算に必要）はderived関数内部で行われ
続けるが、**cacheへ書き込むのは明示的に要求したsubject userのentryだけ**
——context userがそれ自身のcache entryとして紛れ込むことはない。

すべてのbulk readerは要求した`userIds`**全員分**のentryを返す契約
——0件のuserも「未読み込み」ではなく明示的な空payload（既存single readerの
空defaultと同じ形）として含める。zero-width scope（`effectiveEnd <=
scope.start`）はVC derived関数（`clampWindow()`が`RangeError`を投げる）を
一切呼ばず、空payloadだけを返す。

**SQLite variable limit対策のchunking**: `userIds`を内部定数
`BULK_USER_CHUNK_SIZE`（300）単位でchunkし、1000人以上のuserでも単一の巨大
`IN (...)`を作らない。chunkは`prefetch()`側からは見えない実装詳細
——呼び出し側は「1回のbulk読み込み」として扱ってよい。

**`TitleSourceCache.prefetch(db, sourceKey, userIds, scope)`**: 唯一の書き込み
経路。callerが任意payloadをcacheへ注入できるAPI（`set`/`seed`/
`primeWithPayload`等）は意図的に存在しない——cache mutationは`get()`
（trusted single reader）と`prefetch()`（trusted bulk reader）の結果だけを
経由する。契約:

- scope brand検証は`userIds`が空でも必ず行う——「読むuserがいないから
  validationを省略する」はしない。source未登録・非titleUsable（`vc_co_presence`
  等のrestricted sourceを含む）もscope検証の直後、`userIds`の長さに関わらず
  runtime rejectする。
- **first-read-wins**: 既にcache済みの`(user, source, scope)`は上書きしない
  ——bulk readerへ渡す前に、既cache済みuserを「missing」集合から除外する
  （書き込み側だけでなく、読み込みの発行自体を省く）。
- `userIds`は内部でdedupe（初出順維持）——bulk readerへは重複の無いlistを渡す。
- bulk readerの戻り値を完全に受け取ってから（＝例外が起きれば何もcommitしない）
  cacheへ書き込む——1 groupの内部chunkingが途中で失敗しても、そのgroup分の
  部分的な結果がcacheへ混入することはない（他の既に完了したgroupの書き込みは
  そのまま残ってよい——group横断のatomicityまでは要求しない）。
- cacheした値は既存single readerと同じくdeep-freezeする。

**`TitleSourceCache`のruntime provenance（PR #158レビュー対応）**: TypeScriptの
`private`はruntimeを守らない——`private readonly cache = new Map(...)`という
素朴な実装では、`(cache as any).cache`でbacking Mapへ直接到達できてしまい、
さらに深刻なのは、`{ get(){ return forgedPayload } }`のようなstructural fake
objectを`TitleEvaluationOptions.cache`/`TitlePrefetchOptions.cache`へ渡し、
呼び出し側がそれを`cache.get(...)`のようなdynamic dispatchで呼ぶと、
`readTitleSource()`/`BULK_SOURCE_READERS`/DBを一切経由せずforgeされたsafe
payloadをruleへ渡せてしまう——source trust boundary全体の迂回になる。

対策は`v2-scope.ts`の`RESOLVED_SCOPE_PROVENANCE`・`v2-pipeline.ts`の
`PLAN_PROVENANCE`と同じ思想:

- backing stateをinstanceのown propertyに置かず、module-private
  `TITLE_SOURCE_CACHE_STATE: WeakMap<object, Map<string, unknown>>`
  （exact object identityでしか引けない）へ移す。`{ ...realCache }`の
  shallow copy・`Object.create(TitleSourceCache.prototype)`・
  `new Proxy(realCache, {})`はいずれもこのWeakMapに載っていないため
  fail-closedする。
- constructorで`Object.freeze(this)`する——`instance.get = fakeFn`のような
  instance own propertyによるmethod shadowingをstrict modeで例外にする。
- **evaluator（`v2-evaluator.ts`）・planner（`v2-prefetch.ts`）は
  `cache.get(...)`/`cache.prefetch(...)`というdynamic dispatchを一切呼ばない**
  ——freezeで守れるのはgenuine instanceへのshadowingだけで、callerが最初から
  渡してきたstructural fake object自体にはfreezeが及ばない。true trust
  boundaryは`getFromTitleSourceCache()`/`prefetchIntoTitleSourceCache()`という
  freestanding function（`v2.ts`からは再exportしない、internal cross-module
  export）——`cache`を単にWeakMap lookupのkeyとしてしか使わず、`cache`の
  どのmethodも一切呼び出さないため、`cache`が何のmethodを持っていようと
  影響を受けない。`TitleSourceCache.get()`/`.prefetch()`はこの2関数への
  薄いpublic wrapper（外部利用者向け）。
- `options.cache`が指定された場合、`evaluateTitle()`/`prefetchBatchPipelineSources()`
  は入口で`assertGenuineTitleSourceCache()`による早期検証も行う
  （defense-in-depth——実際の読み書きは上記freestanding functionが呼ばれる
  たびに再検証するため必須ではないが、forgeされたcacheをruleが1件でも
  評価される前にfail-closedする）。

**`bulkReadCalls`は実測値**: 各bulk readerが実際に発行したDB/derived関数
呼び出し回数（内部chunkingの実行回数）をそのまま合算する——`userIds.length`
からの見積もり（`Math.ceil(userIds.length / CHUNK_SIZE)`）ではない。
zero-width scopeの早期returnではchunkループ自体を回さないため、
`cacheEntriesLoaded`（payloadがcacheされたuser数）が正でも`bulkReadCalls`は
0のままになり得る——両者は別の意味を持つ統計であり、混同しない。

**`prefetchBatchPipelineSources(db, store, plan, userIds, observedAt, trigger,
options?)`**（`v2-prefetch.ts`、公開API）: 高レベルplanner。

- `plan`は`requirePlanProvenance()`（`v2-pipeline.ts`、PR C1のWeakMap
  provenance機構を内部reuse——`v2.ts`からは再exportしない）でruntime検証
  する。手書きplan・shallow copy・plan構築後のrule定義書き換えは、canonical
  compiled planを経由しないため一切影響しない。
- 対象は**compiled planのbehaviorRulesだけ**。`relationshipRules`は
  `definition.sources`が`["vc_social_safe"]`であっても対象外——relationship
  evaluatorはこの汎用source cacheを一切読まず、`v2-relationship-evidence.ts`
  のprivate restricted resolverだけを使うため。`metaRules`はsourceを持たず
  対象外。
- lifecycle:`disabled`はscope解決も含め完全にskip。`active`/`retired`は
  両方とも対象（`evaluateTitle()`の既存契約——retired titleも新規awardしない
  だけでsource読み込み自体は行う——に合わせる）。
- `trigger`でfilterする（`rule.definition.triggers.includes(trigger)`）
  ——`daily`等を「全rule評価」の魔法triggerにしない。
- scopeは**rule単位で1回だけ**解決する（user単位でもsource単位でもない）
  ——100人のuserに対して100回`resolveTitleScope()`を呼ばない。
- 実際の先読みは`TitleSourceCache.prefetch()`へ委譲するだけ——planner自身は
  ruleの`evaluate()`/`evaluateCandidate()`、meta `evaluate()`、Store mutation
  method（award系）を一切呼ばない。外側transactionで包んでpoint-in-time
  snapshot保証を偽装することもしない（既存source契約が持つ以上の一貫性を
  主張しない）。

戻り値は`{ cache, summary }`。`summary`（`TitlePrefetchSummary`）は
identity-freeな要約統計だけ——`{ plannedGroups, executedGroups,
requestedUniqueUsers, cacheEntriesLoaded, bulkReadCalls }`。userId・
titleKey・counterpart・raw payload・source別内訳は一切含まない
——実行infrastructureの統計であり、catalog introspection APIではない。

**`evaluateBatchPipeline()`のデフォルト挙動は変えない**: `prefetchBatchPipelineSources()`
は完全にopt-in。既存の`evaluateUserPipeline()`/`evaluateBatchPipeline()`/
`readTitleSource()`/`TitleSourceCache.get()`は、呼び出し側が明示的に
prefetch結果のcacheを渡さない限り、挙動もパフォーマンス特性も変わらない。
呼び出しパターンは:

```ts
const prepared = prefetchBatchPipelineSources(db, store, plan, userIds, observedAt, trigger);
const results = evaluateBatchPipeline(db, store, plan, userIds, observedAt, trigger, {
  ...options,
  cache: prepared.cache,
});
```

**failure semanticsはpipelineと別**: `prefetchBatchPipelineSources()`は
`evaluateBatchPipeline()`本体より**前に**呼ぶ、独立したoptional最適化
ステップであり、そのエラーはpipeline自体のfail-fast/resumable契約より前に
表面化し得る——これは意図的な設計であり、pipeline側のresumable semanticsと
無理に一致させない。scope providerの非決定性（例えばevent scopeが後から
別の値へ解決される等）でplannerが使ったscopeと、後の`evaluateTitle()`内での
再解決scopeが食い違った場合も、cache key検証を緩めて無理にhitさせることは
しない——単なるcache missとしてsingle readerへ自然にfallbackする。

**私cy**: `computeCoPresenceOverlaps()`/`CoPresenceOverlap`はPR C2 round 3の
lockdownのまま——`v2.ts`/root `index.ts`のどちらからも再exportしない。
`vc_co_presence.titleUsable`は`false`のまま——bulk readerも追加しない。
restricted relationship candidateがbulk cacheへ混入する経路は無い
（そもそもrelationship rulesをplanner対象から除外しているため）。

**公開境界**: `@meigokujo/core/titles/v2`は`prefetchBatchPipelineSources`・
`TitlePrefetchOptions`/`TitlePrefetchResult`/`TitlePrefetchSummary`・既存の
`TitleSourceCache`だけを公開する。`BULK_SOURCE_READERS`・生のbulk reader
関数・`TitleSourceCache`の内側の`Map`・`sourceScopeGroupKeyFor()`・
payload-seeding手段はexportしない。root `index.ts`は既存pipeline API
（`evaluateBatchPipeline`等）自体を再exportしていない前例に合わせ、
`prefetchBatchPipelineSources`もrootへは追加しない。

**follow-up（D1の範囲外）**: rank-title live wiring/daily reconcile・
source拡張（TC/Land/economy/casino/invites/events）・production 99-title
catalog + Series manifests + Collection Edition・shadow evaluation/threshold
calibration・production cutover（epoch/baseline・evaluator配線・rank-title
配線・profile read-only化・《名乗り》3枠・notification）。

### Rank-title Live Wiring / Historical Reconcile（PR D2）

PR B3で完成していた`rank_title_unlocks`永続層（stable `RankTitleKey`・
`recordRankTitleTransition()`・`reconcileRankTitleUnlocks()`・permanent
unlock・historical `unlocked_at=NULL`・live crossingは`unlocked_at=Store
clock`・Profile Identity 3-slot）を、実際のBot本番経路（発言XP/Voice XP）へ
初めて接続する。称号v2 Behavior evaluator/production catalogはまだ起動しない
——このPRの対象は`rank_title_unlocks`だけ。

**RankEngine XPがlive observation source**: `apps/bot/src/rank-tracker.ts`の
`handleMessageXp()`/`tickVoiceXp()`が、既存の`services.ranks.awardText()`/
`awardVoice()`呼び出しの直後（rank-up通知より前）に、共通helper
`recordLiveRankTitleUnlock()`（`apps/bot/src/rank-title-wiring.ts`）を呼ぶ。
Text/Voiceで別実装をコピペしない。

**stable `RankTier.key`がidentity、`last_tier`はauthorityではない**:
`recordLiveRankTitleUnlock()`/`RankEngine.listTrackedLevels()`のいずれも、
`rank_text.last_tier`/`rank_voice.last_tier`（array indexのlegacy
cache/bookkeeping）を一切読まない。`listTrackedLevels()`は必ず
`textLevel(xp)`/`voiceLevel(xp)`でXPからlevelを再計算する。

**live sync条件（不要writeを避ける）**:

```ts
if (award.tierUp || !services.titleV2.hasRankTitleUnlock(userId, award.after.tier.key)) {
  services.titleV2.recordRankTitleTransition(userId, track, award.before.level, award.after.level);
}
```

- 普通の同tier内XP増加 → no-op（`recordRankTitleTransition()`を呼ばない）。
- 実際のtier crossing（`tierUp`）→ live record。
- pre-v2 user（既存Lv75だが`rank_title_unlocks`が空）が同tier内で次のXPを
  得た場合（`tierUp=false`）→ current tier unlock missingを検出してself-heal。
- 新規userの最初の成功XP → 同じself-heal経路でLv0から補完される。

`tierUp`だけで判定しない——v2導入前から一定levelだったuserの、次のXP
（`tierUp=false`になり得る）を取りこぼさない。

**live crossing semantics**: `unlockedAt`の正本は常にTitleV2Store clock
——Bot側から`rank_text.last_award_at`/`Date.now()`/message timestamp/VC
tick timestampを`unlockedAt`として渡す新APIは作らない。複数tierを同時に
跨いでも、Bot側でtierごとにループしてINSERTしない——既存
`recordRankTitleTransition()`の契約（`v2-identity-store.ts`の
`applyRankTitleTierUnlocks()`）にすべて任せる。**existing unlockは
immutable**——後から同じtierへ再度tierUpが来ても、既存行の
`unlocked_at`/`recorded_at`は一切UPDATEしない（B3のfirst persisted truth
契約をそのまま維持）。

**live persistenceはexisting rank機能を壊さないsidecar**:
`recordLiveRankTitleUnlock()`は自身の中で`try { ... } catch (e) {
console.error(...) }`する——XP付与自体（既存production機能）のrollbackも、
既存rank-up通知の停止もしない。TitleV2Store側の例外がmessage
handler全体を落とさない。RankEngineのXP付与とTitleV2Storeのunlock
persistenceは1つの外側transactionへ結合しない——**live best-effort +
historical reconcileによる自己修復**というモデル。failureは
`console.error("[rank-title-v2] live unlock persistence failed track=... userId=...", e)`
の形でtrackとuserIdだけをlogする（counterpart等は無関係、そもそも登場しない）。

**failureはdaily reconcileでrepair、現在時刻を捏造しない**: live
persistenceが失敗した場合、その日はunlockされないまま残る。後続の
historical reconcile（startup/daily）が`unlocked_at=NULL`で補完する
——「本当はlive crossingだったはずだから」と現在時刻をunlockedAtへ
入れることは絶対にしない。exact live observationを永続化できなかった
以上、historical unknownへ安全側に倒す。

**tracked populationはrank DB union**: historical reconcileの対象userは
`RankEngine.listTrackedLevels()`が返す「`rank_text`/`rank_voice`いずれかに
1行でも持つuser」全員——`rank_text.user_id UNION rank_voice.user_id`を
1 queryで解決する（userごとのN+1 queryにしない）。Discord
`guild.members`はreconcileの正本にしない——外部Discord APIへ一切
依存しない。片方のtrackにしかrowが無いuserも、無い方のtrackはXP=0
として両方のlevelを返す。順序は`user_id ASC`——locale-independentな
deterministic order。

**Historical reconcile runner**（`reconcileTrackedRankTitles()`、
`apps/bot/src/rank-title-wiring.ts`）: `listTrackedLevels()`の結果を
1人ずつ、`TitleV2Store.reconcileRankTitleUnlocks(userId, "text", ...)` /
`(userId, "voice", ...)`へ渡すだけ。identity-freeな要約統計
`{usersScanned, tracksReconciled, newlyUnlocked}`を返す——PR D1の
`TitlePrefetchSummary`と同じ思想（userId/titleKey一覧は含まない）。

**no auto-equip / no notification from reconcile**: historical
reconcileで新規unlockが何百件できても、DM・rank通知channel・イベント
通知は一切送らない（silent persistence + summary logのみ）。
`profile_identity_equips`への自動装備もしない——3枠は後続UIでuser自身が
選ぶ。既存unlock（現在levelより高いものも含む）を削除・downgradeする
ロジックも一切存在しない——永久unlock契約のまま。

**startup + daily reconcile**: `apps/bot/src/index.ts`のClientReadyで、
外部Discord APIを一切使わず`startupReconcileRankTitles(services)`を
同期的に呼ぶ（casino recoveryの直後、他の非同期Discord I/Oより前）。
失敗しても`console.error`するだけでBot起動は継続する（内部でcatch済み、
呼び出し側でtry/catchを書く必要が無い）。startup成功はdaily reconcileの
markerを立てない——別概念。daily reconcileは`apps/bot/src/scheduler.ts`の
tickへ、JST 04:30〜04:32の3分retry windowで追加した
（`runDailyRankTitleReconcile()`、marker:
`rank_title_v2:reconciled:${dateStr}`、既存`runSchedulerTaskOnce()`の
marker/retry契約——成功時だけmarkerを立て、途中失敗した日は次tickで
自然にretryする）。全user×2trackを1つの外側DB transactionへは包まない
——`reconcileRankTitleUnlocks()`自体が各mutationのtransaction境界を持つ。

**no catalog epoch dependency**: `TitleV2Store(db)`（Bot側の
`services.titleV2`、production clockはdefault Store clock、Bot側から
timestampをinjectしない）は、`applySystemEpoch()`/`applyCatalog()`/
baseline captureのいずれもstartupで実行しない——production 99-title
catalogを施行しない。rank title identityはbehavior title catalogとは
別のidentity subsystemであり、`recordRankTitleTransition()`/
`reconcileRankTitleUnlocks()`自体がcatalog epochを一切参照しないため、
SYSTEM_EPOCH/CATALOG_EPOCH未施行のDBでも成立する。

**old TitleEngine remains active**: `apps/bot/src/services.ts`の
`services.titles`（旧`TitleEngine`、production正本）は一切変更しない
——`services.titleV2`（`TitleV2Store`）を明確に別名で追加するだけ。
旧callerは何も変わらない。

**follow-up（D2の範囲外）**: Behavior/Meta evaluator live wiring・
production 99-title catalog・source拡張・`/プロフィール`のv2表示・
《名乗り》3枠UI・equip command・title notification・relationship
disclosure・shadow evaluation/threshold calibration・production
cutover・旧TitleEngine削除・旧profile migration。

### Safe Activity Source Expansion — E1

称号v2のproduction catalogへ進む前に、現在不足している安全な一次sourceを
2つだけ追加する: `text_active_days`（TC安全source）・`confirmed_invites`
（確定招待source）。Behavior evaluatorのproduction wiringはまだ行わない
——このPRはsource収集基盤まで。

**`text_active_days`**:

- **raw message数を一切保存しない**: `text_active_days`テーブルは
  `user_id × activity_date`（Asia/Tokyo日）で最大1行。1message=1rowの
  raw message tableは作らない。rank_text（発言XP・level・30秒cooldown）は
  称号sourceとして流用しない——位名(rank)と印を再び混ぜないため。
- JST日への変換は`TextActivity`service（`packages/core/src/text-activity/
  service.ts`）内で一元化する。既存のJST utility（`entry/sessions.ts`の
  `jstDateStr()`）を再利用し、timezone hardcodeを複数実装しない。
- **XP cooldownとは完全に独立**: `recordActiveDay()`の判定に
  `award.before`/`award.after`/`tierUp`/XP/`rank_title_unlock`のいずれも
  使わない。同日最初のqualifying messageがrank XP cooldown中でも、
  その日はTC活動日として記録される——`handleMessageXp()`内の呼び出し順序は
  「basic eligibility → `isSafeTitleTextActivityMessage()`判定 →
  （trueなら）`textActivity.recordActiveDay()` → `RankEngine.awardText()` →
  rank-title sidecar → rank-up通知」。
- **public non-thread guild TCだけを対象にする**（PR #160レビュー対応）:
  既存Rank XP eligibility（bot除外・guild外除外・空message除外・
  `xp_excluded_channels`除外）だけでは、DM・private/staff-only/ticket/
  role限定channel・thread・forum postを構造的に除外できない。
  `isSafeTitleTextActivityMessage()`（`apps/bot/src/rank-tracker.ts`）が
  追加のfail-closed判定を行う:
  - thread（forum post含む）は`channel.isThread()`で除外。
  - channel typeは`GuildText`/`GuildAnnouncement`だけに限定
    （VC内テキスト等を暗黙に「普通のTC」へ含めない）。
  - `channel.permissionsFor(guild.roles.everyone)`で**@everyoneの
    ViewChannel**を確認する——「Botがそのchannelを見られるか」ではない
    （Botはstaff/ticket/private roomも見える可能性がある）。判定したいのは
    「一般guild memberに公開された会話か」なので@everyone visibilityを正本に
    する。role-gated channelは安全側に倒して対象外（allowlistが必要なら
    別PRで設計する）。permission解決が失敗/nullの場合もfail-closedで対象外。
  - **この判定はtext_active_days記録の可否だけに使い、`RankEngine.
    awardText()`の実行有無には一切影響させない**——既存Rank XP production
    behaviorはprivate channelでも従来通り動く。`xp_excluded_channels`も
    引き続き効く（public channelでも運営上XP除外ならtext_active_daysも除外、
    既存契約通り）。
- **first observation immutable**: 同じuser×同じJST日の2回目以降の呼び出しは
  `INSERT ... ON CONFLICT(user_id, activity_date) DO NOTHING`——
  `observed_at`をUPDATEしない。後から古いtimestampのevent（遅延配送等）が
  届いても、first persisted observationを保持する。
- **live-only、historical inferenceをしない**: rank_text XP・Discord
  search・EventLog・ログ推定から過去の`text_active_days`を生成しない。
  E1導入前の活動日は永久にunknownのまま——「たぶんその日は喋っていた」と
  捏造しない。
- **writer failureで既存Rank XPを壊さない**: `handleMessageXp()`内で
  `textActivity.recordActiveDay(...)`を`try/catch`し、失敗しても
  `console.error("[text-activity] persistence failed ...")`してRank XP
  処理（cooldown付与・rank-title sidecar・rank-up通知）を継続する。
- payload（`TextActiveDaysSourcePayload`）は`{ days: [{ date, observedAt }] }`
  だけ——message数・channel・message idは一切含まない。JST dateは safe
  なので含めてよい（将来、連続日/週末/特定イベント日を安全に評価できる
  ようにする）。ただし`rawUnit: "unique_jst_public_text_active_day"`が示す
  通り、これは「ある1つのJST日に、public/non-thread guild channelでのTC
  活動が観測された」という事実1件——N messages/N sessionsを意味せず、
  private/thread conversationも含まない。

**`confirmed_invites`**:

- 正本は`invites`テーブルだけ——`souls.inviter_hint_*`/`entry_bookings.
  inviter_*`（検出・hintの段階、まだconfirmedではない）をJOINしない。
  `Entry.creditInvite()`が実際に`INSERT INTO invites`した行だけを数える。
- **invitee identityを一切開示しない**: payload
  （`ConfirmedInvitesSourcePayload`）は`{ creditedAt: number[] }`だけ——
  `invitee_id`はreaderのSELECT文にすら含めない。inviter自身のuserIdも
  含めない（subject userIdはcaller側で既知）。
- revoked/cancelled invite semanticsは現行`invites`テーブルに存在しない
  ——E1で「このinviteは無効そう」と独自に推測しない。既存Entry contractの
  confirmed invite rowをそのまま正本とする（将来取消制度を作るならsource
  semantic変更として別PR）。

**Bulk source integration**: 両sourceともD1契約（bulk readerが正本、
single readerはbulkへ`[userId]`委譲、`BULK_SOURCE_READERS`型coverage、
first-read-wins cache、chunking共有、deep freeze、forged scope/cache
provenance維持）にそのまま乗る——`prefetchBatchPipelineSources()`側への
source固有special-caseは一切追加していない。`text_active_days`は
`bump_events`と同じ「point epochPolicy・chunked `IN (...)` SQL」パターン、
`confirmed_invites`も同型（`invitee_id`をSELECTしない点だけが違う）。

**Deferred unsafe sources（今回入れない）**: economy（`transactions`は
salary/fine/tax/bet/prize/casino chip等が同居しており、type allowlist設計が
必要——生のまま`titleUsable`化しない）・generic `EventLog`（confession/
evaluation/entry/shop等、意味の異なる多数domainが共有する汎用tableであり、
public event participationは専用sourceとして別途設計する）・casino
（win/loss/PnL/all-in等のadverse metricsを普通の印へ使わない既存契約を
維持、参加した事実だけを畳む安全な設計は別PR）・private rooms/recruits
（private/social contextを含むため、`room_activity` triggerの存在だけを
理由にraw tableを公開しない）。

**follow-up（E1の範囲外）**: E2 Economy Safe Classification（safe
allowlist + identity-minimized aggregates）・E3 Public Event Participation
Source（generic EventLogと分離した明示的event participation truth）・
E4 Casino Safe Participation Source（neutral participationだけの安全な
畳み込み）。その後、production 99-title catalog・Series manifests・
Collection Edition・shadow evaluation・threshold calibration・production
cutoverへ進む。

### Economy Safe Classification — E2

raw `transactions`（Ledgerの全取引正本）にはsalary/pension/fine/tax/bet/
prize/casino chip/departmentといった、意味も安全性も全く異なる多数の
domainが同居し、amount・counterparty・reason・ref・approved_by等の
機微データも含む——`transactions`自体を`titleUsable:true`にはしない。
このPRでは、identity-minimized + amount-minimized + count-minimizedな
**安全な対人経済行動**だけを、厳密なallowlistで切り出して称号sourceへ
昇格する。

**`transactions`は`titleUsable:false`のまま**:

- `TITLE_SOURCES`へ`ledger_transactions`（`origin:"persisted"`、
  `privacy:"restricted"`、`titleUsable:false`、`epochPolicy:{type:"point",
  at:"created_at"}`）を登録する。`writtenBy`はLedger本体の
  `INSERT INTO transactions`（`packages/core/src/ledger/service.ts`）、
  `calledFrom`/`wiredFrom`は`/送金`の実production呼び出し経路
  （`apps/bot/src/commands/transfer.ts`の`services.ledger.transfer({`→
  `apps/bot/src/index.ts`の`handleTransfer`dispatch）。
- `restrictedUse`型をPR C2の`"relationship_private_evidence"`から
  `"relationship_private_evidence" | "economy_safe_classification"`へ
  拡張し、`ledger_transactions`だけが後者を宣言する。C2で確立した
  contract（`privacy==="restricted"`かつ`titleUsable===false`必須、
  `safe`/`forbidden`のsourceは`restrictedUse`を宣言できない、未知の
  `restrictedUse`値は拒否）は`assertRestrictedUseContract()`側を一切
  変更せず、値の型を広げるだけで自動的に新しい値へも適用される。

**exact allowlist（内部のみ）**: `transfer`/`tip`の2種類だけ。`registry.ts`の
`knownTxTypes()`や`publicLog:true`フラグから動的にtype集合を採用しない
——将来型が追加されても、`packages/core/src/titles/v2-economy.ts`の
`SAFE_PEER_ECONOMY_TYPES`定数を明示的に変更・レビューしない限りsafe
boundaryは広がらない。`registerTxType()`で新規登録したtypeが
`publicLog:true`かつ`user→user`であっても、`economy_safe_peer_actions`
へは自動で入らない（テストで固定）。

**`tip_burn`は今回除外する**: 表面上は同じ「投げ銭」だが、実際は
(A) Bot宛投げ銭 (B) 公式ショップ購入 (C) ショップ延長 (D) オリジナル
ロール請求、と複数domainがこの1つのtxtypeを共有しており、type単体では
意味を一意に特定できない。`ref_type`やidempotency prefixによる
事後的な意味の切り分けもしない——将来、domain固有のsourceとして
別途設計する。`to_account LIKE 'user:%'`フィルタにより、
`tip_burn`（to=`sys:treasury`）は構造的にも二重に排除される
——allowlistへ`"tip_burn"`を誤って追加してしまっても、このto_account
フィルタが最後の砦として機能する（mutation testingで検証済み）。

**除外理由の全体像**:

| カテゴリ | 例 | 除外理由 |
| --- | --- | --- |
| 発行/自動/管理者操作 | opening/initial/salary/pension/vc_reward/reward_boost/event_prize/harvest/insurance_payout/room_refund/adjust | 本人の対人行動ではない |
| ショップ/機微 | shop_personal/shop_official/fanclub/inheritance | ショップ紐付き・私的文脈 |
| 部署/役割 | dept_in/dept_out/commission | role/business state隣接 |
| 逆風/行政 | fine/tax/event_fee/insurance_premium/room_fee | 懲罰的・行政的・private room文脈 |
| ギャンブル/損益 | bet/prize/market_house_fee/ether_*/chip_*/casino_* | PnL系、E4で別途設計 |
| 投げ銭(overloaded) | tip_burn | 複数domain共有で意味が一意でない（上記） |

**subject semantics（誰の行動として数えるか）**:

- `from_account = user:<subjectUserId>`側だけを見る——受け取った側の
  行動としては数えない（incoming exclusion）。
- `actor_id = from_account`を要求し、staff/system代行を除外する。
  高額送金の運営承認フロー（`/送金`の`handleApprovalButton`）でも、
  `actor`は常に元の送信者のまま（`approvedBy`は別フィールド）——
  承認の有無をactor identityと混同しない。実装前にproduction
  callsite（`transfer.ts`/`tip.ts`）を直接読み、この前提を確認した。
- `to_account LIKE 'user:%'`を要求し、system口座宛（`tip_burn`等）を
  除外する。
- `reversal_of IS NOT NULL`の行自体はfactを作らない。さらにoriginalを`t`、
  reversalを`r`として、`r.reversal_of = t.id AND r.created_at <
  effectiveEnd`が存在するoriginalも除外する。`effectiveEnd`はsource readerの
  正本`resolvedScopeEffectiveEnd(scope)`——future reversalでhistorical snapshotを
  書き換えず、endちょうどのreversalは`[start,end)`上まだ未成立と扱う。

**identity/amount minimization**: payload
（`EconomySafePeerActionsSourcePayload`）は
`{ facts: [{ kind: "transfer"|"tip", date, occurredAt }] }`だけ。
amount・counterparty（from/to account）・reason・ref・approved_by・
idempotency_key・transaction idは一切含めない。SQL側も
`SELECT from_account, type, created_at`だけを取得し、JS側で読み捨てる
のではなくSELECT文自体を最小化する。

**JST day×kind dedupe**: `user × JST date × kind`で最大1 fact。同日に
`transfer`を10回しても1 fact、`tip`を20回しても1 fact——生の取引件数を
1:1でfactにしない（1 Land spamでfactを量産できない）。`occurredAt`は
そのsnapshotでinvalid originalを除外した後の、(user, date, kind)で最初に
qualifyした取引の`created_at`（first valid qualifying observation）。JST変換はE1と同じ
`entry/sessions.ts`の`jstDateStr()`を再利用する。

**No.58 production release gate**: 上記はSOURCE READINESSだけを解決する。
Title v2のaward/ownership/award factsはimmutable前提のため、valid tipの直後に
awardし、その後staffがtipをreverseしても、既存awardは自動で消えない。
production化前に (A) 成立時validなら後日reversal後も獲得維持するsemanticへ
正式変更、(B) transaction finality後だけaward、(C) safeなinvalidated/revocation
lifecycle、のいずれかを正式決定する。PR F2cではどれも決めず、No.58の
production Behavior rule/Bot wiring/revoke機構を作らない。SOURCE READINESSの
READYをproduction release可と解釈しない。

**永続化なし**: `title_economy_events`のような新規tableは作らない。
`packages/core/src/titles/v2-economy.ts`の`computeSafeEconomyPeerActions()`
は`transactions`からのread-only derivationであり、`transactions`/
`balances`/`outbox`等のLedger stateを一切mutateしない。

**Bulk source integration**: D1契約にそのまま乗る（bulk readerが正本、
single readerは`[userId]`委譲、chunking共有、deep freeze、forged
scope/cache provenance維持）。

**公開境界**: `v2.ts`からexportしてよいのは
`EconomySafePeerActionsSourcePayload`と`SafePeerEconomyActionKind`だけ。
raw ledger transaction reader・`SAFE_PEER_ECONOMY_TYPES`allowlist・
`computeSafeEconomyPeerActions()`自体はexportしない——callerがraw
`transactions`由来のfactを直接組み立ててruleへ注入できる経路を作らない。

**明示的にスコープ外**: Behavior evaluatorのproduction wiring
（`/送金`/`/投げ銭`成功時に`evaluateUserPipeline(trigger:"economy_activity")`
を呼ぶこと）・新規Discord通知・`Ledger.transfer()`/Shop/Fiscal/Casino
の既存経済的振る舞いの変更・`/プロフィール`表示や称号装備への影響。
このPRはsource収集基盤の追加だけ。

**follow-up（E2の範囲外）**: E3 Public Event Participation Source・
E4 Casino Safe Participation Source（neutral participationだけ、
win/loss/PnL/all-inを使わない）。その後、production 99-title catalog・
Series manifests・Collection Edition・shadow evaluation・threshold
calibration・production cutoverへ進む。

### Public Event Participation Source — E3

God Field大会・ビンゴ・ファッションショー等、冥獄城の公開イベントへの参加実績を、
identity-minimized truthとして称号v2へ持ち込む。

**generic EventLogは参加者正本ではない**: `events`（`events.actor_id`/
`target_id`/`payload_json`/`type`）はconfession/evaluation/entry/shop/rooms/
casino等が共用する汎用事件録であり、公開イベント参加者をこれらの列から推測しない
——`EventLog.listByType()`/`listByTarget()`も使わない。`events`テーブルを
`titleUsable:true`にすることは絶対にしない。

**dedicated `PublicEvents`ドメイン**: 新規moduleを`packages/core/src/titles/`
配下ではなく`packages/core/src/public-events/service.ts`に置く——これは
称号を取るための監視ログではなく、**public event operations / attendance
history**という独立したevent-ops正本（将来のevent history/UI等にも使える）。
称号v2は、この確定rosterをsafe sourceとして読む1 consumerに過ぎない。

**staff-confirmed public roster**: E3のroster正本は`public_events`（1開催instance = 1
`event_key`）と`public_event_participations`の2 tableだけを持つ。F2dの
`public_event_completions`はrosterと意味を混ぜない別のcompletion正本。draft/
participant add-remove/event finalizeという複雑なstate machineはDBへ作らない
——Bot UI側でpreview→confirmし、`PublicEvents.recordFinalizedEvent()`という
単一atomic writeだけを呼ぶ。confirm前はDB mutationが0件。

**event instance keyはimmutable**: `event_key`は公開イベント1開催につき1つの
immutableなslug（例: `gf-2026-08-22`）。シリーズ名ではなく開催instanceの
identity。

**atomic finalize**: `public_events` INSERTと全participant INSERTは単一
transaction——途中のparticipant INSERT失敗は、event row・先行participant行を
含めて丸ごとrollbackする。

**roster immutable / exact idempotency / conflicting re-record reject**:
一度確定したevent_key/participantsをUPDATEしない（edit/delete/participant
add-remove/void APIは今回作らない）。同一event_keyの再送は、name/eventDate/
participant set（比較は入力順に依存しない集合比較）が完全一致すれば
`alreadyRecorded:true`の冪等成功——recorded_at/recorded_byは既存値を維持する。
1件でも違えばconflict error——「新しい入力の方が正しそうだから上書き」はしない。

**participant dedupeとfail-closedなidentity解決**: 参加者リストは最初の
appearance順でdedupeする（`alice,bob,alice` → alice,bob）。空participant
リストはreject。Bot側の入力parserは、メンション（`<@id>`/`<@!id>`）または
生のDiscord IDとして明確にparseできるtokenだけを受け付け、username/表示名
からの推測はしない——1 tokenでも不正なら全体をrejectし、partial rosterを
保存しない。

**no participant-derived self-service progress**: `event_key`はstaff-
confirmedの1開催1keyであり、同一eventでは1 participant 1 rowまで——button連打
やmessage連打、1 Land送金等でparticipant自身がevent countを増やす経路は無い。
raw participant countの累積counter tableも作らない（history rowsから必要時
に数える）。

**no result/score/prize/bet**: E3 sourceにwinner/placement/score/prize/bet/
predictionやhost/organizer情報を含めない——「参加した」というneutral truthの
みを記録する。event_fee支払い・event_prize受取・event market賭けからも
rosterを自動生成しない（賞金を受け取っていない参加者もいるし、賭けただけの
人は参加者ではない）。

**source payload minimization**: `TITLE_SOURCES`へ`public_event_participations`
を`origin:"persisted"`, `privacy:"safe"`, `titleUsable:true`で登録する。
payload（`PublicEventParticipationsSourcePayload`）は
`{ participations: [{ eventKey, recordedAt }] }`だけ——event name・event
date・recorded_by・他参加者identityは一切含めない。reader SQLも
`recorded_by`/`name`/`event_date`をSELECTしない。

**recordedAtはpersistence confirmationであって出席の瞬間ではない**:
`recorded_at`は「運営がこの公開イベントrosterをBotへ確定保存した時刻」で
あり、イベント開始時刻・参加者が入室した瞬間・実際の参加開始時刻ではない。
`PublicEvents`自身のclockだけが正本——Discord message timestamp・event
date・operator入力timestampから作らない。過去イベントを後から登録しても、
`event_date`を使ってcatalog epoch以前へbackdateしない。

**`orderable:false`**: 上記の理由により、`public_event_participations`は
`orderable:false`で登録する——「N件目のイベント参加を達成したexact time」
としてrecorded_atを使わせない。orderable:falseなsourceに依存するruleが
`earnedAt`に非nullを主張すると、既存のv2 orderability contract
（`v2-evaluator.ts`の`assertOnlyOrderableSourcesClaimEarnedAt`相当）が
fail-closedする。

**no automatic historical inference**: `events`/`transactions`/VC/Discord
historyから過去rosterを自動backfillしない。明示的に運営がauthoritative
rosterを入力したものだけを記録する。

**no evaluator wiring**: event roster確定後に
`evaluateUserPipeline(trigger:"event_completed")`を呼ばない。production
catalogは未施行のまま——E3はsource正本の追加までで、`/プロフィール`・
イベント履歴閲覧・Title UIも今回は追加しない。

**follow-up（E3の範囲外）**: E4 Casino Safe Participation Source
（win/loss/PnL/all-inを使わない、neutralな参加factだけの畳み込み）。その後、
production 99-title catalog・Series manifests・Collection Edition・shadow
evaluation・threshold calibration・production cutoverへ進む。

### Casino Safe Participation Source — E4

賭場（マモンの賭場）へ、「ユーザーがどのgame familyへ参加したか」という
neutral participation factだけを称号v2へ持ち込む。「何回賭けたか」
「いくら賭けたか」「勝ったか負けたか」は一切source化しない——城で遊んだ
結果として後から称号になるのであって、称号を取るために賭場で危険な行動を
させない。

**なぜTransientParticipationを使わないか**: `apps/bot/src/casino/
participation.ts`はsolo/roulette/pvp/keibaの「現在参加中」を排他制御する
だけのprocess-memory Map（Bot再起動で消える）——履歴ではない。ここから
historical participationを作らない。

**なぜCasinoMetricsをtitle sourceにしないか**: `CasinoMetrics`
（`casino_metric_events`等）はwager・payout・net・amount・payloadを持つ
analytics正本であり、raw retention policyを持つ——titleの永久証拠として
安定した正本ではない。`game_start`だけをSELECTして安全扱いにする、
という実装も採らない。`CasinoMetrics`はanalytics専用のまま一切変更しない。

**dedicated `CasinoParticipationHistory`ドメイン**: 新規module
`packages/core/src/casino/participation-history.ts`（`CasinoMetrics`とは
完全に別module）が`casino_participations`テーブルを持つ。列は
`participation_key`/`user_id`/`activity_key`/`occurred_at`だけ——wager・
amount・payout・net・result・opponent_id・counterparty・horse・bet_type・
roulette_number・score・rank・reason・source payloadのいずれも保存しない。

**successful participation commitmentの定義**: 「賭金検証だけ」
「seat取得だけ」「house reservationだけ」「challenge作成」「acceptボタンを
押しただけ」は参加ではない。実際のゲームroundの資金処理/round作成が
成功した後（solo: 各ゲームの真のcommit primitive——slots は
`spinPaid()`、chohan/poker/holdem は `settleSolo()`、crash は win/loss
各分岐の `settleSolo()`、chinchiro は `settleChinchiroRound()`、
blackjack は共有 `finish()` 内の `settleSolo()`——が成功した時点。
house reservation成立だけでは参加と見なさない（house reservationは
HOUSE側の引受余力確保にすぎず、プレイヤー資金の実際の増減は伴わない）。
roulette/keiba: escrow/risk/reservationを含む業務groupの成功、PVP:
両者のcollectStakesが成功しfunded gameとして開始可能になった時点）に
参加factを記録する——completed game/win/lossではなく、successful
funded participation。後からsystem error等でvoid/refundになっても、
その時点で実際にfunded participationまで到達していたならfact自体は
消さない。

**production callsite audit**: solo 7種目（スロット・丁半・クラッシュ・
チンチロ・ブラックジャック・ポーカー・ホールデム）は、house reservation
成立ではなく、各ゲームで実際に資金移動・round結果が確定するprimitiveを
個別に監査して配線した——slots: `spinPaid()`（`runGroup`内で抽選・賭け・
配当・JP積立を単一atomic transactionにまとめる正本、唯一のcall site）
成功後。chohan/poker/holdem: `settleSolo()`成功後（holdemはfold/
showdown両経路が同じ`settleSolo()`呼び出しへ合流、foldは`rawPayout=0`で
同じsettleへ入る）。crash: win分岐・loss分岐それぞれ独立した
`settleSolo()`成功後（同じ`participationKey`へ収束するため二重書き込み
なし）。chinchiro: `settleChinchiroRound()`（内部でescrow事前預託pool
残高の不変条件をチェックした上で`settleSolo()`を呼ぶ正本、唯一の
call site）成功後。blackjack: ナチュラル・バースト・スタンド・ダブル・
timeout強制スタンドなど全9決着経路が合流する共有`finish()`closure内の
`settleSolo()`成功後。ルーレット/競馬（`acceptRouletteBet()`/
`acceptKeibaBet()`の実bet受理成功時、`bets.set(...)`直前）・PVP
named-invite 4種目（bj-duel/chinchiro-duel/sashi/indian、両者の
collectStakes成功後・`runFundedX()`呼び出し前）・PVP公開募集
（`pvp-accept.ts`の`collectAndStartFunded()`、`collectStakes()`1回成功後）・
poker-duel（`dealHands()`/`dealHandsFromClient()`の配布直前、sashi/open
どちらのmodeも実際に配牌が始まる瞬間）・多人数丁半（両側に張り手が
揃った時点、`revealAndSettle()`直前）を全て監査し、各entrypointへ
書き込みを配線した。validation失敗・reservation失敗・escrow不足・
conflict・capacity reject・challenge作成のみ・claimだけでは一切
書き込まない。timeout/cancelは「timeoutそのもの」で判断せず、実際に
commit primitiveへ到達したかで判断する——丁半の丁/半選択timeoutは
`settleSolo()`到達前に早期returnするため書き込まないが、blackjack/
holdemのアクションtimeoutはproduction game semantics上、強制スタンド
（blackjack）・強制check（holdem）という正常なround決着へ変換されて
`settleSolo()`まで到達するため書き込む。

**activity key mapping**: 表示名やmode文字列をそのまま保存せず、
`packages/core/src/casino/participation-history.ts`の
`CASINO_ACTIVITY_KEYS`（`slots`/`chohan`/`crash`/`chinchiro`/`blackjack`/
`poker`/`holdem`/`roulette`/`keiba`/`sashi`/`indian`)を単一の真実源にする
——writer/reader両方がこの同じallowlistを参照する（E2の
`SAFE_PEER_ECONOMY_TYPES`と同じ考え方）。solo blackjackとPVP BJは同じ
`"blackjack"`へ、PVP chinchiroも`"chinchiro"`へ正規化する——同じgame
familyを「別のゲームを2個遊んだ」扱いにしない。unknown activity keyは
writer側もreader側もfail-closedで拒否する。

**gameplay failure isolation**: 称号用safe historyの書き込み失敗で
casino gameplay自体を失敗させない。Bot側の`recordCasinoParticipationBestEffort()`
はtry/catchで囲み、失敗してもwarning logだけに留めてgame成立処理を継続する。

**daily collapse — raw play countをsourceにしない**: raw
`casino_participations`の1行1playをそのままTitle evaluatorへ渡さない。
新Title source`casino_activity_days`は`user × activityKey × JST calendar
day`につき最大1 safe factへ畳み込む——同じ日にblackjackを1回遊んでも
100回遊んでも、Title source上は`blackjack / 2026-08-22`の1件だけ。これに
より将来のTitle ruleがraw gambling volumeを報酬化できないようにする
（Goodhart対策）。

**source contract**: `casino_participations`を`origin:"persisted"`,
`privacy:"restricted"`, `titleUsable:false`,
`restrictedUse:"casino_safe_participation_classification"`で登録する
（E2の`ledger_transactions`と同じ二層構造）。`casino_activity_days`は
`origin:"derived"`, `privacy:"safe"`, `titleUsable:true`,
`derivedFrom:["casino_participations"]`で登録し、payload
（`CasinoActivityDaysSourcePayload`）は`{ activityDays: [{ activityKey,
activityDate, occurredAt }] }`だけ——participationKey・operationId・
session・counterpart/opponent・wager・payout・net・result・betType・
horse・roulette選択・raw play countは一切含めない。

**timestamp/orderability**: `occurred_at`は「successful participation
commitmentをこのsafe serviceへ記録した時刻」——service自身のclockが正本で、
callerからtimestampを渡させない。同一`recordCommittedParticipation()`内の
全participantは1 clock snapshot。E3の`recorded_at`（staffが後から入力した
確定時刻）とは異なり、これはcommit時に直接観測した値なので、
`casino_participations`・`casino_activity_days`とも`orderable:true`で
登録できる。ただし`casino_activity_days`はraw play countをTitle
evaluatorへ一切公開しない（daily collapseで畳み込み済み）——orderableで
使えるのは、そのactivity-day factの最初のqualifying participation
timestampをearnedAtの順序付けに利用できる、という範囲にとどまる。
将来のTitle ruleがraw casino play countを参照できるかのように読める
表現は用いない。

**no automatic historical backfill**: 既存の`casino_metric_events`や
Ledgerから過去のcasino participationを推測して埋めない。明示的に
successful funded participationへ到達した瞬間だけを記録する。

**明示的にスコープ外**: production 99-title catalog・casino title
definitions・Series manifest・Collection Edition activation・shadow
evaluation・threshold calibration・Behavior evaluatorのproduction
wiring・profile UI・title通知・auto equip・既存`CasinoMetrics`の再設計・
casino payout/risk/game ruleの変更。

### F1 — Catalog Convergence

E4までで基盤（source contract / catalog epoch / award ownership /
series・collection engine / meta pipeline）が揃った後、`meigoku_title_v2_
catalog_99_fullclear.xlsx`（正本sheet: `Catalog_99_FINAL` / `Summary` /
`Source_Map` / `Collection_Review` / `FullClear_Manifest`）で確定した
99概念の候補カタログと、現repoの実装状況を機械的に突き合わせる
**convergence PR**。「99個を今すぐaward可能にする」PRではない。

- **xlsx `Catalog_99_FINAL` がconcept正本**。`packages/core/src/titles/
  v2-catalog-candidates.ts`が原文を機械転記する（言い換えない、planning専用、
  production runtime pathから完全に切り離す）。
- **provisional keyはまだproduction immutable keyではない**。xlsxの「仮key」を
  `provisionalKey`としてそのまま保持するが、source・threshold・scopeが
  確定してから正式key化する（xlsx Summaryの契約と同じ）。
- **99 = 91 behavior + 8 meta**。Collection Credit COUNTABLE 43 /
  NONCOUNT 56、Full-clear REQUIRED 91 / EXEMPT_META 8。Collection Credit
  とFull Clearは別概念——NONCOUNTでもbehavior 91件全件がFull-clear
  REQUIRED候補（NONCOUNT ≠ Full Clear不要）。
- **readinessとreleaseは別**。`packages/core/src/titles/
  v2-catalog-readiness.ts`が現repoとの突き合わせ監査（READY/PARTIAL/
  BLOCKED/META、blockerKinds、thresholdCategory、evidence）を持つ——
  READYは「今すぐreleaseしてよい」ではなく「sourceが意味を落とさず
  表現できる」だけの意味。thresholdの実数値・Series/Collection Edition
  activation・production評価配線は別途。
- **current source reconciliation方式**: xlsx作成時点のSource_Mapを
  そのままコピーせず、PR #149〜#163後の現repoを実際に読んで再判定する
  （E2 economy safe classification・E3 public event participation・
  E4 casino safe activity-dayはxlsx作成後に実装が進んでいるため）。詳細は
  `docs/titles-v2-catalog-readiness.md`。
- **no fake sources**: READY判定の根拠は必ず既存`titleUsable:true`の
  source keyまたは実在するspecialized resolver——「似たsourceがある」
  だけではREADYにしない。「sourceは存在する」と「sourceがcatalogの
  意味仕様を落とさず証明する」は別の質問——レビューで、casino
  participation（successful funded participation commitment ≠
  completed game）・economy reversal semantics・VC social breadthの
  時間的分布欠如という3クラスのsemantic false-positiveが見つかり修正した
  （`docs/titles-v2-catalog-readiness.md`§12）。counterexampleを1つ
  構成できるかどうかを、READY判定の実質的なテストにする。
- **no threshold guessing**: 分布TBDの候補に仮の数値（「とりあえず3日」等）
  を一切入れない。`thresholdCategory: THRESHOLD_PENDING`として明示する。
- **no full-clear activation yet**: 現時点で未実装titleが多数あるため、
  production Collection Editionをこのpr で作成・activateしない——91件を
  今activeなeditionへ登録すると、取得不能なfull-clearを作ってしまう。

### F2a — vc_last_occupant same-second / 0-second visit tie bug修正

`packages/core/src/vc/derived.ts`の`computeLastOccupant()`にあった、
F1 readiness auditで`known_bug`として記録していた既存の正確性バグを
修正した——新機能ではなくcorrectness fix。departing userの終了時刻`t`と
同一秒に開始した第三者（0秒visitを含む）を、前後関係を秒精度では証明
できないambiguousケースとして安全側（factを作らない）へ倒す分岐を追加した。
0秒visit自体は削除せず、arrival/observationの証拠として保持したまま
判定対象にする。`vc_last_occupant`のpayload contractは変更していない。
readiness registry（No.6,7,9: PARTIAL→READY、No.8: area taxonomy不足で
BLOCKEDのまま）とtests（`vc-derived.test.ts`のA-F、`titles-v2-catalog-
readiness.test.ts`の追従guard）を更新した。詳細は`docs/titles-v2-catalog-
readiness.md`§13参照。

### F2b — Casino Completed Participation Safe Signal

`casino_activity_days`（PR E4）が証明する「successful funded
participation commitment」と、「ゲームが正常精算まで完了した」ことは
別事実——PR #164レビューで確定したsemantic mismatch（No.66/67/69）を、
新機能として解消した。既存`casino_activity_days`の意味・schema・writerは
一切変更していない。

新規source: そのparticipationについて、ゲーム固有のcanonical financial
resolution primitive（settlement、またはゲームルール上の正常な
draw/push等の解決）が成功したことだけを表すimmutable正本
`casino_participation_completions`（`CasinoParticipationHistory.
recordCompletedParticipation()`——親commitment行と`activityKey`/
participant setの一致を必ず照合し、commitment無しのcompletionは
`missing_commitment`でfail-closed reject）と、`user × activityKey ×
JST day`でcollapseするsafe derived source `casino_completed_activity_
days`を追加した。Discordの最終結果表示成功はcompletion条件ではない
——settlement成功後にUI editが失敗してもcompletionは成立し、逆に
`voidPvpTable`/`voidRouletteTable`/`voidKeibaRace`等の異常系cleanupは
completionと解釈しない。全11 activityKey（solo 7種目・PVP named-invite
4種目・poker-duel・多人数丁半・roulette・keiba）のproduction callsiteを
監査し、各ゲームの実settlement primitive成功直後へwriterを配線した。

readiness registry（No.66,67: PARTIAL→READY、No.68: `casino_activity_
days`のまま変更なし、No.69: `source_semantic_mismatch`が外れ
`missing_manifest`のみ残る）を更新した。詳細は`docs/titles-v2-catalog-
readiness.md`§14参照。

### F2c — Economy Reversal-Safe Peer Actions

`economy_safe_peer_actions`のoriginal queryへ、evaluation snapshotの
effective endより前に`reversal_of = original.id`を持つtransactionが存在する
場合だけoriginalを除外する`NOT EXISTS` classificationを追加した。reversal
transaction自身の除外、`transfer`/`tip` exact allowlist、actor/from binding、
user→user限定、payload minimization、JST day×kind collapseは維持する。
invalid originalをcollapse前に除くため、同日のreversed first tip + valid second
tipではsecondの`created_at`が`occurredAt`になる。

No.58「ほんの気持ち」はsource readiness上PARTIAL→READY。ただしpost-award
reversalとimmutable ownershipの整合はproduction release gateとして未決定。
production BehaviorTitleDefinition/Bot award wiring/revocation/finality policyは
このPRに含めない。詳細は`docs/titles-v2-catalog-readiness.md`§15参照。

### F2d — Public Event Completed Participation Safe Signal

E3の`recordFinalizedEvent()`と`public_event_participations`は、rosterの確定を
表すだけでevent completionを表さない。この意味を読み替えず、別のimmutable
`public_event_completions`正本と`PublicEvents.recordCompletedEvent()`を追加した。
completionは`/イベント完了記録`の運営限定preview→confirmで明示attestされ、
caller timestamp、自動historical backfill、event_dateへのbackdate、update/delete
APIを持たない。retryは最初のaudit actor/timeを保持し、未来event date・roster無し・
timestamp不整合・corrupt既存rowはfail-closed。

Title側はraw completionをrestricted internal classificationに閉じ、同一eventKey・
同一roster timestampでparticipantとJOINしたsafe derived source
`public_event_completed_participations`だけをgeneric ruleへ公開する。payloadは
`{ participations: [{ eventKey, completedAt }] }`のみ。`completedAt`はstaffが
evidenceを確定した時刻でactual event endではないため`orderable:false`とし、
earnedAtを主張できない。

readinessはNo.80/81だけPARTIAL→READY。No.82は実event_dateのsafe span sourceが
無いためBLOCKED、No.83/84はorganizer/staff role protocolが無いためBLOCKEDのまま。
production title定義・threshold・award/notification配線は追加しない。詳細は
`docs/titles-v2-catalog-readiness.md`§16参照。

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
