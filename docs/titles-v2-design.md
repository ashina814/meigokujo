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
