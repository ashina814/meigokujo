# 称号v2 99 Catalog — Production Readiness Audit（PR F1）

このdocumentは `meigoku_title_v2_catalog_99_fullclear.xlsx`（正本sheet:
`Catalog_99_FINAL` / `Summary` / `Source_Map` / `Collection_Review` /
`FullClear_Manifest`）と、現repo（PR #149〜#163後）を実際に読んで突き合わせた
**readiness audit**の結果をまとめたもの。

このPR自体は「99個を今すぐaward可能にするPR」ではない。99概念の正本と現在の
repo実装を突き合わせて、production catalogへ昇格できるもの／まだできないものを
機械的に確定するための **convergence PR**。

- machine-readable candidate registry: [`packages/core/src/titles/v2-catalog-candidates.ts`](../packages/core/src/titles/v2-catalog-candidates.ts)（xlsx原文の機械転記、99件）
- machine-readable readiness registry: [`packages/core/src/titles/v2-catalog-readiness.ts`](../packages/core/src/titles/v2-catalog-readiness.ts)（現repoとの突き合わせ監査、99件）
- どちらも **planning専用**。production runtime path（`v2.ts`バレル・evaluator・Bot・award）から完全に切り離されている（テストで固定済み）。

> **PR #164レビュー反映（2026-08-23）**: 初版が「似たsourceがある」を
> READYの根拠にしてしまっていた3クラスのsemantic false-positiveを修正した
> （casino participation-vs-completion、economy reversal semantics、VC social
> breadthの時間的分布欠如）。詳細は§12参照。このrevisionでREADY 19→11、
> PARTIAL 5→13に変わっている——**readiness countを特定の値に固定することを
> 目的にしない**。監査の結果として出た実数がそのまま正本。

> **PR F2a反映（2026-08-23）**: `computeLastOccupant()`（`packages/core/src/
> vc/derived.ts`）のsame-second/0-second visit tie bugを修正した——旧版
> §8クラスタ1として記録していた既存の正確性バグ。No.6/7/9がPARTIAL→READY、
> known_bug blockerはcatalog全体から0件になった。詳細は§13参照。
> READY 11→14、PARTIAL 13→10。No.8はarea/categoryタクソノミー不足という
> **別のBLOCKER**が残るため、このfixだけではREADY化しない。

> **PR F2b反映（2026-08-23）**: casino participation-vs-completion mismatch
> （casino_activity_daysがsuccessful funded participation commitmentしか
> 証明せずcompleted gameを証明しない問題）を、新規safe source
> `casino_completed_activity_days`（canonical financial resolution
> primitive成功後にのみ書かれるcompletion正本）の追加で解消した。詳細は
> §14参照。No.66/67がPARTIAL→READY、No.69のblockerからsource_semantic_
> mismatchが外れてmissing_manifestのみに縮小。READY 14→16、PARTIAL 10→8、
> source_semantic_mismatch blocker 12→9。No.68は引き続き既存
> `casino_activity_days`（commitmentベース）のまま——completion sourceへは
> 切り替えていない（semanticSpecが「利用する」でありcompletion保証を
> 要求しないため）。

> **PR F2c反映（2026-08-23）**: `economy_safe_peer_actions`が、evaluation
> snapshot時点でreverse済みのoriginal transactionを除外するようになった。
> future reversalはhistorical snapshotを書き換えず、reversal transaction
> 自身も従来どおり除外する。No.58がPARTIAL→READY、READY 16→17、
> PARTIAL 8→7、`source_semantic_mismatch` 9→8。ただしNo.58には
> **post-award reversal semantics未決定というproduction release gate**が
> 別途残る——SOURCE READINESSのREADYをproduction release可と解釈しない
> （§15参照）。

> **PR F2d反映（2026-08-23）**: roster finalizationとは別のimmutable正本
> `public_event_completions`とsafe JOIN source
> `public_event_completed_participations`を追加した。既存E3 roster semanticsは
> 変更せず、明示的なstaff completion attestationだけを採用し、自動backfillは
> 行わない。No.80/81がPARTIAL→READY、No.82はcompletion不足だけ解消して
> event-date span source不足でBLOCKEDのまま。READY 17→19、PARTIAL 7→5、
> `source_semantic_mismatch` 8→5。詳細は§16参照。

> **PR F2e反映（2026-08-23）**: 既存`vc_group_size_seconds`のtrust/
> occupancy semanticsを共有canonical timelineへ切り出し、同じtrusted sliceを
> JST日境界で分割する`vc_group_size_daily_safe`を追加した。No.10-21が
> BLOCKED→READY、READY 19→31、BLOCKED 67→55、`missing_derived_source`
> 24→12。PARTIAL 5・META 8は不変。threshold/share denominatorは決めず、
> production title/Bot wiringも追加していない。詳細は§17参照。

> **PR F2f反映（2026-08-23）**: 既存`vc_social_safe`へ、JST日ごとの
> distinct trusted counterpart数だけを返す`dailyBreadth`を加算的に追加した。
> No.23-25がPARTIAL→READY、READY 31→34、PARTIAL 5→2、
> `source_semantic_mismatch` 5→2。BLOCKED 55・META 8・
> `missing_derived_source` 12は不変。No.29/30のpair-specific overlap不足と
> No.31のpair persistence不足は解消していない。threshold・production title・
> Bot wiringも追加していない。詳細は§18参照。

> **PR F2g反映（2026-08-23）**: `rooms` lifecycle metadataとcanonical
> `vc_visits`を交差する`public_room_activity_safe`を追加した。公開kindは
> `normal`/`game`だけで、privateな`mitsugetsu`/`oborozuki`は除外する。
> No.50-56がBLOCKED→READY、READY 34→41、BLOCKED 55→48。No.57はroom
> activity側だけ解消し、role-at-timeとtemporal cross-reference待ちでBLOCKEDを
> 維持する。threshold・production title・Bot wiringは追加していない。§19参照。

> **PR F2h反映（2026-08-23）**: message本文・emojiを保存しないrestricted
> `tc_message_observations`/`tc_reaction_observations`と、identity-freeなsafe derived
> `tc_conversation_safe`/`tc_reaction_safe`を追加した。No.42-47/49が
> BLOCKED→READY、No.48はexplicit reply/threadならexactだが通常free-flowの同一topic
> correlationを証明できないためPARTIAL。READY 41→48、PARTIAL 2→3、BLOCKED
> 48→40、`missing_persisted_source` 24→16。Theme 11は0/0/8→7/1/0。
> threshold・production title・award wiring・historical backfillは追加していない。§20参照。

> **PR F2i反映（2026-08-23）**: F2hのcanonical same-surface TC exchange候補と、
> main guild/public GuildVoice/human occupancyをliveに証明するcanonical
> `vc_public_social_presence`を共有し、
> `social_activity_time_safe`へJST date×24hour sparse分布として統合した。
> No.32-37がBLOCKED→READY、READY 48→54、BLOCKED 40→34、PARTIAL 3・META 8は
> 不変。`missing_persisted_source` 16→10、Theme 9は0/0/6→6/0/0。24hour binは
> measurement resolutionであり、daypart/gap/meaningful-seconds/share/concentrationの
> production thresholdは未決定。全6件NONCOUNT、No.48はPARTIALを維持する。§21参照。

> **PR #173追加監査反映（2026-08-24）**: 既存READYのうちNo.1/6/22は候補原文が
> public VCを要求する一方、実dependencyがpublic/private provenanceを持たない
> `vc_visits`系だったためPARTIALへ補正した。READY 54→51、PARTIAL 3→6、
> `source_semantic_mismatch` 3→6。BLOCKED 34・META 8は不変。F2iの
> `vc_public_social_presence`はNo.32-37のmain/public/human/trusted timeをexactに
> 支えるが、empty-start/last-occupant/counterpart breadthの代替sourceではない。§21.5参照。

> **PR F2j反映（2026-08-24）**: confirmed `invites`、append-only `ghosted`
> event、canonical public TC/VCをinternal JOINする`invite_rooted_safe`を追加した。
> profile 1件をanonymous direct branch 1本として、entry翌日以降のpublic activity
> JST日分布、同branchのconfirmed next generation数、inviter↔inviteeだけのlater-day
> reunion分布を同じprofileに保持する。membership survivalや`credited_at`をentry anchorに
> 使わず、legacyでimmutable entry eventが無いrelationはunknownとする。No.76-79が
> BLOCKED→READY、READY 51→55、BLOCKED 34→30。`missing_persisted_source` 10→6、
> `missing_derived_source` 12→10、PARTIAL 6・META 8は不変。§22参照。

> **PR F2k反映（2026-08-24）**: normal peer transfer/tipとcanonical storefront
> purchaseだけをstable semantic familyへ写す`economy_semantic_safe`、および
> eligible productのJST日別/global breadthだけを返す`shop_purchase_safe`を追加した。
> purchase origin/productは購入時append-only provenanceへ凍結し、refund/cancel occurrenceも
> fixed observedAtで切る。current item/status/reasonからのbackfill推測はしない。
> No.59/61/62/63がBLOCKED→READY、READY 55→59、BLOCKED 30→26。
> `missing_derived_source` 10→7、`missing_persisted_source` 6→4、`missing_manifest` 9→8。
> No.60はpair chronology、No.64/65はrole-at-time待ちでBLOCKEDを維持する。§23参照。

> **PR F2l反映（2026-08-24）**: 常設パネル仕様の「基本ゲーム入口」を根拠に
> version固定のEdition-I 8-family manifestを追加し、official Takutateのappend-only
> table instance/known-human guest presenceと、standard market funded commitmentの
> append-only historyをsafe source化した。No.69-72がBLOCKED→READY、READY 59→63、
> BLOCKED 26→22。No.73はcore game/standard market evidenceが揃ったがrole-at-time
> 待ちでBLOCKEDを維持する。`missing_persisted_source` 4→1、`missing_manifest` 8→7。
> threshold・award・notification・historical inferred backfillは追加していない。§24参照。

## 0. xlsx canonical hash（exact drift guard）

| 項目 | 値 |
| --- | --- |
| source workbook | `meigoku_title_v2_catalog_99_fullclear.xlsx` |
| source sheet | `Catalog_99_FINAL` |
| canonical SHA-256 | `2d790dcb675751da8ab721691f3545882223f82587ea92c8cc5398f9ed66245c` |

`packages/core/src/titles/v2-catalog-candidates.ts`の`canonicalCatalogHash()`が、
99件全候補の全semantic field（`no`/`themeNo`/`theme`/`displayName`/
`provisionalKey`/`kind`/`groupKey`/`seriesKey`/`stage`/`semanticSpec`/
`scopeIntent`/`primarySourceIntent`/`sourceStatusOriginal`/
`collectionCredit`/`hidden`/`roleDependency`/`thresholdIntent`/
`productionReadinessOriginal`/`blockerNotes`/`fullClear`）を固定順・
``区切りで1行にjoinし、行同士は`\n`区切りでSHA-256を取る。上記hashは
xlsxを直接読むPythonスクリプト（TypeScript実装とは独立の実装）で一度だけ
生成し、`canonicalCatalogHash(TITLE_V2_CATALOG_CANDIDATES)`と一致することを
確認済み——`packages/core/tests/titles-v2-catalog-candidates.test.ts`が
この一致をtestとして固定する。semanticSpec/blockerNotes/displayName等、
どのfieldが1文字でもxlsx原文からズレればこのtestが落ちる（count/91-8/
43-56等の構造invariantだけでは検出できないdriftのregression guard）。

xlsxの内容が将来変わったら、この節と`FROZEN_CATALOG_99_FINAL_SHA256`を
意図的に更新する（xlsxを直接読むPythonスクリプトで再計算し、手打ちで
値を決めない）。

## 1. 総数

| 項目 | 件数 |
| --- | --- |
| 総候補数 | 99 |
| Behavior | 91 |
| Meta | 8 |
| Collection Credit COUNTABLE | 43 |
| Collection Credit NONCOUNT | 56 |
| Full Clear REQUIRED（現候補） | 91 |
| Full Clear EXEMPT_META | 8 |

Collection Credit と Full Clear は別概念。COUNTABLE 43だけが《千印万来》等の
collection count/breadthへ寄与する。一方、《万印皆伝》の最終targetは、activeな
full-clear editionに登録されたREQUIRED印100%——NONCOUNTの91 behavior全件が
将来のcore full-clear REQUIRED候補である（NONCOUNT ≠ Full Clear不要）。

## 2. Readiness内訳

| status | 件数 | 意味 |
| --- | --- | --- |
| READY | 63 | 現在`titleUsable:true`のsource／specialized resolverだけで、意味を落とさず表現できる |
| PARTIAL | 6 | 近い意味のsourceはあるが、意味を落とす／広げるか、semantic mismatchが安全な有効化を妨げている |
| BLOCKED | 22 | 意味的に近いものが repo に一切存在しない、または複合条件の残りの基盤が無い |
| META | 8 | kind:meta（別bucket、§7参照） |

**READY = 今すぐreleaseしてよい、ではない**。sourceReadinessとthreshold決定は
別軸（§10参照）——READY 63件も、production threshold値（分布TBD等）が
決まるまではrelease対象にならない。またSeries manifest／Collection Edition／
Meta pipelineの本番登録もこのPRでは一切行わない（§9参照）。No.58はさらに、
award後のreversalを既存immutable ownershipへどう反映するかが未決定であるため、
source-readyでもproduction release不可（§15）。

## 3. Blocker種別件数（Behavior 91件中、blockerKindsは重複計上あり）

| blockerKind | 件数 | 意味 |
| --- | --- | --- |
| missing_persisted_source | 1 | titles層へ一切昇格されていない生データ／新規persisted sourceが必要 |
| missing_derived_source | 7 | 既存safe sourceの上に新しいderived aggregate（day/share/span/distinct等）が必要 |
| missing_manifest | 7 | 「どのfamilyを対象とするか」を定義するmanifestそのものが未定義 |
| missing_role_history | 7 | role-at-time（過去のある時点でどのroleを保持していたか）がrepo全体で未実装 |
| source_semantic_mismatch | 6 | sourceが証明する事実がcatalogの意味仕様より弱い／異なる（No.1/6/22のpublic VC provenance、No.29/30のpair-specific overlap、No.48のfree-flow同一topic correlation） |
| missing_event_protocol | 2 | イベントデータモデル自体にorganizer/staff区別が存在しない |
| known_bug | 0 | PR F2aで`computeLastOccupant()`のsame-second/0-second visit tie bugを修正——catalog全体から解消済み（§13参照） |

（`none`のBehavior候補は63件——ちょうどREADY件数と一致。PARTIAL 6件は
すべて`source_semantic_mismatch`を持つ。）

## 4. Theme別 readiness

| Theme No | Theme | 総数 | READY | PARTIAL | BLOCKED |
| --- | --- | --- | --- | --- | --- |
| 1 | 場を起こす | 5 | 1 | 1 | 3 |
| 2 | 場を締める | 4 | 2 | 1 | 1 |
| 3 | 一対一型 | 3 | 3 | 0 | 0 |
| 4 | 少人数型 | 3 | 3 | 0 | 0 |
| 5 | 大人数型 | 3 | 3 | 0 | 0 |
| 6 | 万能型 | 3 | 3 | 0 | 0 |
| 7 | 広い交友 | 6 | 3 | 1 | 2 |
| 8 | 深い交友 | 4 | 1 | 2 | 1 |
| 9 | 時間帯・生活痕 | 6 | 6 | 0 | 0 |
| 10 | BUMP / 鐘 | 4 | 4 | 0 | 0 |
| 11 | TC交流 | 8 | 7 | 1 | 0 |
| 12 | 公開部屋 | 8 | 7 | 0 | 1 |
| 13 | Land・経済 | 8 | 5 | 0 | 3 |
| 14 | 賭場 | 8 | 7 | 0 | 1 |
| 15 | 招待 | 6 | 6 | 0 | 0 |
| 16 | イベント | 5 | 2 | 0 | 3 |
| 17 | 城横断 | 7 | 0 | 0 | 7 |

BUMP/鐘とVC人数帯Theme 3-6が100% READY（後者はPR F2eのJST日別4bucket
trusted secondsで日数/share/span/streakを後段評価できるため）。公開部屋はF2gで
7/8件がSOURCE READYとなり、No.57だけrole-at-time待ち。時間帯・生活痕はF2iで6/6件が
SOURCE READYとなった。TC交流はF2hで7/8件がSOURCE READYとなり、No.48だけfree-flow同一topic correlationのsemantic mismatchが残る。
招待はF2jで6/6件がSOURCE READYとなった。Land・経済はF2kで5/8件がREADYとなり、
No.60はpair chronology、No.64/65はrole-at-time待ち。賭場はF2lで7/8件がREADYとなり、
No.73だけrole-at-time待ち。城横断は引き続き0% READY。

## 5. source別に残る実装（READYを支えるsource／PARTIALの制約／BLOCKEDが必要とするもの）

READYを支えている既存`titleUsable:true` source（20種、63件）:

- `vc_empty_start_then_joined`（No.2。No.1はpublic provenance不足でPARTIAL）
- `vc_last_occupant`（No.7, 9。No.6はtie bug解消済みだがpublic provenance不足でPARTIAL）
- `vc_group_size_daily_safe`（No.10-21——JST date×4bucketのtrusted seconds。threshold/share denominatorは未固定、§17参照）
- `vc_social_safe`（No.23-25, 28。No.22はbreadth自体はあるがpublic provenance不足でPARTIAL）
- `bump_events`（No.38-41、全件READY）
- `casino_activity_days`（No.68 のみ——「利用する」semanticsに限りcompletion保証不要。commitmentベースのまま維持）
- `casino_completed_activity_days`（No.66, 67——PR F2bで追加したcompletion正本、§14参照）
- `casino_edition_i_completion_safe`（No.69——version固定8-family manifestとcompletionだけを集約、§24参照）
- `casino_table_activity_safe`（No.70-71——official卓×anonymous guest profile×JST日×trusted seconds、§24参照）
- `casino_market_activity_safe`（No.72——other standard boardのsuccessful funded commitmentをmarket×JST日collapse、§24参照）
- `confirmed_invites`（No.74-75 のみ——`invitee_id UNIQUE`によりdistinct数が保証される）
- `invite_rooted_safe`（No.76-79——confirmed direct relation、immutable entry anchor、canonical public activity/network/pair reunionをanonymous direct-branch profileへ統合、§22参照）
- `economy_safe_peer_actions`（No.58——snapshot時点でreverse済みoriginalを除外、§15参照）
- `economy_semantic_safe`（No.59/61/63——explicit semantic family、natural in/out、human counterpart/day breadth、subject-initiated family breadth、§23参照）
- `shop_purchase_safe`（No.62——immutable storefront origin/productとsnapshot-bounded refund/cancel、§23参照）
- `public_event_completed_participations`（No.80-81——明示staff completion正本と同一roster revisionへJOIN、§16参照）
- `public_room_activity_safe`（No.50-56——room lifecycleとtrusted logical VC visitの交差をidentityなしでhosted/guest/ownUseへ集計、§19参照）
- `tc_conversation_safe`（No.42-45, 47, 49——quiet/continuation/dormant/area/join/social-dayのthreshold-neutral stats、§20参照）
- `tc_reaction_safe`（No.46——anonymous post/JST observation day/distinct human reactor分布、§20参照）
- `social_activity_time_safe`（No.32-37——same-surface TC exchange候補とtrusted VC wall-clock unionのJST date×24hour sparse分布。daypart/thresholdは未固定、§21参照）

PARTIALを止めているもの（source_semantic_mismatch、§12/§14で今回のレビューにより判定）:

- `vc_empty_start_then_joined` / `vc_last_occupant` / `vc_social_safe`がpublic/private provenanceを持たず、No.1/6/22の明示public semanticsを証明できない
- `vc_social_safe.trustedOverlapSeconds`が全counterpart合算で、特定counterpartに紐づけられない（No.29, 30）
- `tc_conversation_safe.startedConversations`はexplicit reply/threadだけを同一conversationとexactに証明でき、通常free-flowの同一topic長期継続をcanonicalに証明できない（No.48）

（casino participation-vs-completion mismatchはPR F2bで解消済み——No.66/67は
READY化し、No.69のmanifest blockerもF2lで解消した。economy reversal mismatchも
PR F2cで解消済み。public event completion mismatchもPR F2dで解消済み——
No.80/81はREADY、No.82はevent-date span source不足のみ残る。§14-16参照。）

BLOCKEDが新たに必要とするもの（xlsxのSource_Map original「未実装」から、
E2/E3/E4/F2b実装後の現repoで再監査した差分）:

- **event dual-role（organizer/staff）protocol拡張**—— No.83-84（2件）。`public_events`のデータモデル自体にorganizer概念が無い
- **event_dateのsafe span source新設**—— No.82（1件）。`completedAt`はstaff attestation時刻であり実event日/spanの代用不可
- **`castle_experience_safe`新設 + 城横断manifest**—— No.85-91（7件）。grep 0件で、E3のevent infra完成待ちでもある

## 6. threshold pending

| thresholdCategory | 件数 | 意味 |
| --- | --- | --- |
| STRUCTURAL_FIXED | 16 | 意味仕様そのものから閾値が一意に確定する（例: 初回=1） |
| THRESHOLD_PENDING | 68 | 分布TBD——絶対に仮値を入れない（§10） |
| MANIFEST_DEPENDENT | 6 | manifest（family一覧・series一覧）が定まらないと閾値の土台自体が決まらない |
| STRUCTURAL_PLUS_DISTRIBUTION | 1 | 構造は決まるが、一部の値は分布依存 |
| META_NOT_APPLICABLE | 8 | meta（別contract、§10適用外） |

sourceReadinessとthresholdは別軸——READY 63件のうち、STRUCTURAL_FIXEDなのは
一部（初回系）のみで、残りはTHRESHOLD_PENDINGのままREADYになっている
（sourceは十分だが実数値は分布を見てから決める）。

## 7. 依存軸別集計

| 依存軸 | 件数 | 備考 |
| --- | --- | --- |
| role-at-time依存（`roleDependency !== "none"`） | 10 | readiness blockerとして`missing_role_history`が残るのは7件。No.65はF2kでshop側だけ解消しrole-at-time単独待ちになった |
| イベントtheme（Theme No.16） | 5 | No.80/81はcompletion sourceでREADY、No.82-84は依然BLOCKED |
| manifest依存（thresholdCategory: MANIFEST_DEPENDENT） | 6 | No.69の賭場Edition-I manifestはF2lで確定。残る城横断family一覧・series一覧等は未定義 |
| known bug依存 | 0 | PR F2aで`computeLastOccupant`の同秒0秒visit tie bugを修正——catalog全体から解消（§13参照） |
| source_semantic_mismatch依存 | 6 | No.1/6/22のpublic VC provenance、No.29/30のpair-specific overlap、No.48のfree-flow同一topic（§14-16/§18/§20/§21.5参照） |

## 8. 次に何を実装すれば最も多くのcandidateがunblockされるか

単純なunblock件数だけでなく、安全性・基盤依存・実装順序も考慮した優先順位。
新規sourceを1つ作る、または既存sourceのsemanticsを正すごとに複数candidateが
同時に動く「クラスタ」が明確に存在する。

> `vc_last_occupant`の同秒0秒visit tie bug修正（旧クラスタ1）は**PR F2aで
> 解消済み**（§13参照）——No.6,7,9がPARTIAL→READY。casino completed-
> participation safe signal（旧クラスタ1、F2a後の番号）も**PR F2bで
> 解消済み**（§14参照）——No.66,67がPARTIAL→READY、No.69のcompletion
> blockerも解消。economy reversed-original除外も**PR F2cで解消済み**
> （§15参照）——No.58がPARTIAL→READY。public event completion保証も
> **PR F2dで解消済み**（§16参照）——No.80/81がPARTIAL→READY、No.82は
> event-date span blockerのみ残る。VC group-size day/share/span拡張も
> **PR F2eで解消済み**（§17参照）——No.10-21がBLOCKED→READY。
> VC social breadthのJST日次分布も**PR F2fで解消済み**（§18参照）——
> No.23-25がPARTIAL→READY。公開部屋の実利用safe aggregateも**PR F2gで
> 解消済み**（§19参照）——No.50-56がBLOCKED→READY、No.57はrole-at-time
> blockerのみ残る。TC+VC時間帯clusterも**PR F2iで解消済み**（§21参照）——
> No.32-37がBLOCKED→READY。economy semantic family/shop purchase clusterも
> **PR F2kで解消済み**（§23参照）——No.59/61/62/63がBLOCKED→READY、
> No.65はshop側だけ解消してrole-at-time待ち。casino Edition-I manifest / official
> table / standard market clusterも**PR F2lで解消済み**（§24参照）——No.69-72が
> BLOCKED→READY、No.73はrole-at-timeだけが残る。
> 以下は残っているクラスタのみを優先度順に並べ直したもの。

| 優先度 | クラスタ | 解放されるcandidate数 | 理由 |
| --- | --- | --- | --- |
| 1 | event dual-role protocol + event_date露出 | 3件（No.82-84） | `public_events`データモデル自体の拡張が必要——E3の上に直接積めない |
| 2 | role-at-time基盤 | role依存最大10件 | 波及範囲は大きいが、role権限・処罰系roleを含むため設計難度と慎重さが最も高い——単純unblock数で最優先にしない |
| 3 | `castle_experience_safe` + 城横断manifest | 7件（No.85-91） | 他の**すべてのドメインsourceが先に揃っている必要がある**——最後に着手するのが自然（event infra完成待ちでもある、Summary判断#8） |

VC group-size clusterはF2e、VC social breadth clusterはF2f、公開部屋clusterは
F2g、TC conversation/reactionの7件はF2h、TC+VC時間帯clusterはF2iで解消した。
招待clusterはF2jの`invite_rooted_safe`、economy/shop clusterはF2kで解消した。
casino Edition-I/table/market clusterはF2lで解消した。
No.48の残件は次のsource実装ではなく、
content無しでfree-flow同一topicをどうcanonicalに証明するかという別枠のproduct/UX
semantic decisionであり、特殊操作をユーザーへ強制してREADY化しない。

## 9. editorial intent → runtime resolution（契約の食い違いの明示）

xlsxはconcept/editorial正本であり、runtime契約そのものではない。以下は
xlsx上の記述と、現在のruntime契約が食い違う箇所——本PRではruntime契約自体を
変えない。

| xlsx上の記述 | 現runtime契約 | 差分の扱い |
| --- | --- | --- |
| Meta（No.92-99）のScope列: `catalog` | `MetaTitleDefinition`はruntimeでは常にglobal scope（catalogスコープの概念を持たない） | このPRでは変更しない。将来Meta titleを実際に登録する際に解決する |
| Meta（No.92-99）のSeries/Stage: `collection_meta` stage 1..7 | `MetaTitleDefinition`はprogressionを持たない（`v2-contract.ts`の型契約） | xlsx上のstageは**editorial orderingとしてのみ**候補データに保持する（`v2-catalog-candidates.ts`の`stage`フィールド）。Meta titleをBehavior progressionへ無理に押し込まない |
| 賭場・招待・時間帯・role-aware・generic eventも「REQUIRED」（Full-clear Manifest Contract） | 本PRではfull-clear editionそのものを一切activateしない | REQUIRED表記はcandidate上の**将来の意図**の記録であり、今すぐeditionに組み込まれるという意味ではない（§13参照） |
| casino No.66/67/69の「正常完了する」 | **PR F2b**でcompletion正本を追加し、**PR F2l**でversion固定Edition-I 8-family manifestを追加した（§14/§24） | catalog側semanticsは変更していない。No.69もcommitmentではなくcompletionだけを用い、将来gameは旧editionへ自動加入しない |
| economy No.58の「reversal済取引は無効」 | **PR F2cで解消**: `economy_safe_peer_actions`はevaluation snapshot時点でreversal済みのoriginalを除外する（future reversalは過去を変更しない、§15） | catalog/xlsx semanticは変更していない。source readinessはREADY。ただしpost-award reversalは別のproduction release gateとして残る |
| event No.80/81の「completed公式イベント」 | **PR F2dで解消**: immutable `public_event_completions`へstaffが明示attestし、safe sourceがroster revisionとJOINする（§16） | catalog側semanticsと既存E3 roster sourceは変更していない。No.82は実event-date span source不足だけ残る |

## 10. Production runtimeへの非影響（固定済み）

- `packages/core/src/titles/v2.ts`（public barrel）から`v2-catalog-candidates.ts`/`v2-catalog-readiness.ts`は一切exportされていない
- evaluator（`v2-evaluator.ts`/`v2-pipeline.ts`/`v2-prefetch.ts`）・source registry（`v2-sources.ts`/`v2-contract.ts`）・store（`v2-store.ts`）・meta/series/collection engine（`v2-meta.ts`/`v2-series.ts`/`v2-series-store.ts`/`v2-collection.ts`/`v2-collection-store.ts`）・award facts（`v2-award-facts.ts`）から一切参照されていない
- `apps/bot/src`配下のどのファイルからも一切importされていない
- 上記すべてを`packages/core/tests/titles-v2-catalog-readiness.test.ts`（K, L）がsource-order文字列検証で機械的に固定している

## 11. このPRで行わないこと

- production 99-title catalogの登録（`defineBehaviorTitle`/`defineMetaTitle`呼び出し）
- Series manifestの登録（`registerSeriesManifests()`呼び出し）
- Collection Editionのactivate
- production threshold値の決定
- role-at-time・castle_experience・event dual-role protocol等、優先度表に残る基盤の新規実装
- Behavior evaluatorのproduction wiring

（`vc_last_occupant`の同秒0秒visit tie bug修正はPR F2aで実施済み——§13参照。
casino completed-participation safe signalの追加はPR F2bで実施済み——§14参照。）

## 12. semantic false-positive 修正記録（PR #164レビュー対応）

初版のreadiness監査は、一部の候補について「意味的に近いsourceがある」ことを
「意味を落とさず表現できる」（READY）と誤って同一視していた。以下3クラスを
counterexample付きで再監査し修正した。

### 12.1 casino participation-vs-completion（No.66, 67, 69: READY/BLOCKED → PARTIAL/BLOCKED+）

`casino_activity_days`が証明するのは「successful funded participation
commitment」であって「completed game」ではない。solo 7種目（PR #163で
`settleSolo()`成功後に書くよう修正済み）はcompletion=participationが
成立するが、PVP経路——`pvp-accept.ts`の`collectAndStartFunded()`、
`bj-duel.ts`/`chinchiro-duel.ts`/`sashi.ts`/`indian.ts`/`poker-duel.ts`/
`chohan-multi.ts`の全named-invite/公開募集経路——は**すべて**
`collectStakes`成功直後・実際のgame runner実行前にwriterが発火する。
`chohan-multi.ts`には実際に「🎴 中断」embedを出すabort経路があり、
participation factが書かれた後にgameが中断され得ることが実装上明示されて
いる。activityKeyだけではsolo/PVPどちらの経路で書かれたfactかruleから
区別できないため、「初めて正常精算まで完了する」（No.66）「正常完了する」
（No.67）をcasino_activity_days単独では証明できない。No.68「賭場通」は
semanticSpecが「複数日に利用する」であり完了保証を要求しないため、
No.66/67と一括変更せずREADYのまま維持した。No.69は`missing_manifest`に
加えて同じcompletion proof不足も残るため`source_semantic_mismatch`を追加。

> **PR F2bで解消**: `casino_completed_activity_days`（canonical financial
> resolution primitive成功後にのみ書かれる別のimmutable正本）を追加し、
> No.66/67はREADYへ、No.69は`source_semantic_mismatch`を除去した。
> 詳細は§14参照。

### 12.2 economy reversal semantics（No.58: READY → PARTIAL）

xlsx Blocker欄「reversal済取引は無効」に対し、
`computeSafeEconomyPeerActions()`のコード自身のコメント（§18-19）が
明示するとおり、現E2契約は「reversal transaction自体はfactを作らない
——元actionのfactはreversalの有無に関わらず消えない」。つまり後から
reversalされたtipでも「初回tip」factは残ったまま。catalog側semanticsを
現sourceへ合わせて書き換えることはせず、source側の限界として記録した。

> **PR F2cでsource mismatchを解消**: originalをreverseするtransactionが
> evaluation snapshotの実効終端より前に存在する場合、そのoriginalをsafe fact
> から除外する。reversal transaction自身も従来どおり除外する。No.58は
> SOURCE READINESS上PARTIAL→READYへ戻したが、production award-finality gateは
> 別問題として§15に残す。

### 12.3 VC social breadthの時間的分布欠如（No.23, 24, 25: PR F2fで解消）

PR #164レビュー時点の`vc_social_safe` payloadは`distinctCoPresentUsers`/
`maxRepeatedDaysWithOneCounterpart`/`trustedOverlapSeconds`という
scope window全体の**単一累積値**のみ。counterexample: day1に100人と
co-presenceが成立し、day2〜30はAlice1人だけと会った場合でも、
`distinctCoPresentUsers`は大きいまま計算できる——しかし「より広い異なる
相手との交流が、複数日に広がる」（No.23）「十分な期間にわたり...続く」
（No.24）「長期・多数日にわたり」（No.25）という**時間的持続性**は
証明できなかった。No.22「顔馴染み」は時間的な広がりを要求しない
（「成立する」であって「広がる/続く」ではない）ためREADYのまま維持した。

> **PR F2fでsource mismatchを解消**: 同じ`vc_social_safe`へ
> `dailyBreadth: [{ date, distinctCoPresentUsers }]`を追加した。dateはJST昇順、
> countはその日のtrusted counterpart集合のsizeで、interactionが無い日は行を
> 作らない。scope全体のglobal distinctとの併用により、上記day1 spikeと
> uniform breadthを区別し、日数・各日breadth・first→last spanを後段評価できる。
> No.23-25はPARTIAL→READY。No.29/30のpair-specific overlapとNo.31の
> pair persistenceは意図的に解消していない（§18）。

PR #164時点でのfollow-up（casino participation-vs-completion・economy
reversal・VC social breadth per-day・`vc_last_occupant` tie bug・VC
group-size拡張）はPR #164自体では実施しない——記録のみ。このうち
`vc_last_occupant`のtie bugはその後PR F2aで（§13）、casino
participation-vs-completionはPR F2bで（§14）、economy reversalはPR F2cで
（§15）、VC social breadth per-dayはPR F2fで（§18）解消した——残りは§8の
現在の優先度表を参照（クラスタ番号はPRを重ねるたびに再割当てされるため、
特定の番号ではなくトピック名で参照すること）。

## 13. PR F2a: `vc_last_occupant` same-second / 0-second visit tie bug修正

`packages/core/src/vc/derived.ts`の`computeLastOccupant()`にあった既存の
正確性バグを修正した——**新機能ではなくcorrectness fix**。production
title定義・threshold・catalog activationはまだ行わない。

### 13.1 バグの内容

departing userの終了時刻`t`について、第三者`o`が「`t`の瞬間に在室していた
か」を`o.startedAt <= t && o.endedAt > t`で判定していた。0秒visit
（`o.startedAt === o.endedAt === t`）はこの条件で`false`になる——
`endedAt > t`が`t > t`で成立しないため。

counterexample:

```
Alice: [0, 100]
Bob:   [10, 50]  observed exit
Carol: [50, 50]  observed zero-duration visit（Bobの退出と同じ秒）
```

Carolがthird-party-presentと判定されず、Aliceに`becameLastAt=50`という
factが成立し得た。しかし秒精度では「Bobが退出した後にCarolが来た」のか
「Carolが来た後にBobが退出した」のか前後関係を証明できない。

### 13.2 修正内容

`thirdPartyPresentOrAmbiguous`判定へ、`o.startedAt === t`（departingの
終了時刻とoの開始時刻が同一秒）の場合は無条件でambiguousとしてブロックする
分岐を追加した。0秒visitを削除・無視するのではなく、判定対象として保持した
まま安全側（factを作らない）へ倒す——`LogicalVisit.startKind`
（arrival/partial_observation/unknown）によらずブロックする。
partial_observation由来（前segmentへcoalesceできなかった孤立state_change）
でも「その人が既に居た可能性」を否定できないため。

過剰ブロックを防ぐガード: `o.startedAt === t`が成立するのは同一秒だけ——
1秒後の0秒visit（`o.startedAt = t+1`）や別channelの0秒visitはブロック
対象にならない（`packages/core/tests/vc-derived.test.ts`のD/Eで確認）。

### 13.3 Title source boundaryへの影響

`vc_last_occupant`のpayload contract（`{ facts: [{ becameLastAt,
channelId }] }`）は変更していない。`v2-sources.ts`も変更不要——derived層
のfixだけでreaderへ正しく反映される。

### 13.4 readiness registryへの反映

| No | 候補 | before | after |
| --- | --- | --- | --- |
| 6 | 残り火 | PARTIAL（known_bug） | READY（none） |
| 7 | まだいる | PARTIAL（known_bug） | READY（none） |
| 8 | 見届け人 | BLOCKED（missing_derived_source + known_bug） | BLOCKED（missing_derived_source のみ——VC channel area/categoryタクソノミー不足は別のBLOCKERとして残る） |
| 9 | 戸締まりよろしく | PARTIAL（known_bug） | READY（none） |

READY 11→14、PARTIAL 13→10、BLOCKED/META不変。known_bug blockerは
catalog全体（Behavior 91件）から0件になった。Theme 2（場を締める）は
READY 3・PARTIAL 0・BLOCKED 1（No.8のみ）。

### 13.5 mutation self-verification

- `computeLastOccupant()`の`o.startedAt === t`ガードを一時的に無効化
  → `vc-derived.test.ts`のtest A/B/C（exact bug reproduction / subject
  filter / partial_observation tie）が実際にfail、D/E/F（過剰ブロック
  防止・別channel・通常系）はfailしないことを確認 → restore。
- readiness registryのNo.6をPARTIALへ戻す → `titles-v2-catalog-readiness.
  test.ts`の新規guardがfail → restore。
- readiness registryのNo.8をREADYへ変える → 同guardがfail → restore。
- すべて`git diff`クリーンな状態まで復元済み。

## 14. PR F2b: Casino Completed Participation Safe Signal

`casino_activity_days`が証明する「successful funded participation
commitment」と、No.66/67/69が要求する「ゲームが正常精算まで完了した」を
明確に分離する——PR #164レビューで確定したsemantic mismatch（§12.1）を
実装で解消した。**新機能**であり、既存`casino_activity_days`の意味は一切
変更していない。

### 14.1 completionのexact semantic

「そのfunded participationについて、ゲーム固有のcanonical financial
resolution primitive（正常なsettlement、またはゲームルール上の正常な
draw/push等の解決）が成功したことを直接観測した」。Discordの最終結果表示
（final UI edit）が成功したかどうかはcompletion条件ではない——settlement
成功後にDiscord editが失敗してもcompletionは成立する。逆に、participation
commitment成功→game開始→settlement前に例外/abnormal abort→void/refund
cleanupでは、completionは成立しない。

「Promiseがresolveした」「runnerを呼んだ」「collectStakesが成功した」
「mode=solo/PVPだった」だけをcompletion証拠にしない——mode区別（solo/PVP）
自体は修正にならない（§8参照、PR #165レビューでも同じ論点が指摘された）。
異常系の`voidPvpTable`/`voidKeibaRace`/`voidRouletteTable`等は
completionと解釈しない。通常ルール上のpush/draw/timeout強制行動が、
最終的にcanonical settlementを正常に完了した場合はcompletionとして扱う
（下記§14.3の監査表参照）。

### 14.2 永続モデル

既存`casino_participations`は変更せず、successful funded participation
commitmentのimmutable正本のまま維持した。新規`casino_participation_
completions`（`participation_key`/`user_id`/`completed_at`、
`FOREIGN KEY(participation_key, user_id) REFERENCES casino_participations`）
を追加し、`CasinoParticipationHistory.recordCompletedParticipation()`が
必ず親commitment行を照合してから書く——commitment無しのcompletionは
`missing_commitment`でreject。completion rowをUPDATE/DELETEするAPIは
作っていない。historical backfillも行っていない——既存
`casino_participations`から「これはsoloっぽいから完了していたはず」と
推測してcompletionを生成することはしない。

### 14.3 canonical settlement boundary監査表（production callsite audit）

全11 activityKeyを監査し、各経路の「実際に正常なfinancial resolutionが
成功した直後」へcompletion writerを置いた。

| activityKey | production callsite | completion writerの位置 | pre-completion failure時 |
| --- | --- | --- | --- |
| slots | `slots.ts` | `spinPaid()`成功後（solo共通、commitmentと同じ境界） | completion 0 |
| chohan（solo） | `chohan.ts` | `settleSolo()`成功後 | completion 0 |
| crash | `crash.ts` | win/loss各分岐の`settleSolo()`成功後 | completion 0 |
| chinchiro（solo） | `chinchiro.ts` | `settleChinchiroRound()`成功後 | completion 0 |
| blackjack（solo） | `blackjack.ts` | 共有`finish()`内`settleSolo()`成功後 | completion 0 |
| poker（solo） | `poker.ts` | `settleSolo()`成功後 | completion 0 |
| holdem | `holdem.ts` | `settleSolo()`成功後（fold/showdown合流） | completion 0 |
| blackjack（PVP） | `bj-duel.ts` | push分岐: `refundAll()`直後／win-loss分岐: `settlePvp()`直後 | completion 0（`voidPvpTable`は`markResolved()`未到達時のみ） |
| chinchiro（PVP） | `chinchiro-duel.ts` | 引き分け分岐: `refundAll()`直後／win分岐: `settlePvp()`直後 | completion 0 |
| sashi | `sashi.ts` | `settlePvp()`直後（push/drawなし単一終端） | completion 0 |
| indian | `indian.ts` | both-fold/draw分岐: `refundAll()`直後／win分岐: `settlePvp()`直後——**DM失敗abortは対象外**（ゲーム本体未到達） | completion 0 |
| poker（PVP duel） | `poker-duel.ts` | `settlePvp()`/`settleProportional()`成功直後・`postResult()`前 | completion 0 |
| chohan（多人数） | `chohan-multi.ts` | `settleProportional()`成功直後・結果embed編集前。「🎴 中断」try/catchの外 | completion 0 |
| roulette | `roulette.ts` | `settleRoulette()`成功直後（卓全体atomic）・参加者ごとに`roulette:<session>:<userId>`でcompletion | completion 0（`voidRouletteTable`は精算自体が投げた場合のみ、部分成功は起きない） |
| keiba | `keiba.ts` | `settleKeibaRace()`成功直後（レース全体atomic）・bettorごとに`keiba:<session>:<userId>`でcompletion | completion 0（`voidKeibaRace`は`runRaceAndSettle()`全体を囲む外側catch） |

**abnormal voidがcompletionでない理由**: `voidPvpTable`/`voidRouletteTable`/
`voidKeibaRace`はいずれも「返金のみ」の異常系cleanup primitiveであり、
ゲームルール上の正常な決着ではない——`pvp-common.ts`の`runFundedSession()`
契約自体が「`markResolved()`を呼ぶかthrowするかのどちらかで終わること」を
強制し、settlement/refund成功後に`markResolved()`を呼んだ後は
cleanup（void）が無条件でno-opになる（resolved flag）。indian.tsのDM失敗
abortは「ゲーム本体（stay/fold判断）へ到達する前のinfrastructure abort」
であり、push/draw/both-foldのような**ゲームルール上の正常な決着**とは
区別した——completion対象にしていない。

**settlement後UI failureでもcompletionである理由**: `pvp-common.ts`の
doc comment自体が「`settlePvp()`/`refundAll()`が成功した後にDiscord API
だけ落ちた場合は金銭処理を巻き戻さない」「`markResolved()`を呼ぶ位置は
精算・返金の直後であって、表示の成功ではない」と明示している。completion
writerもこの同じ境界（settlement/refund成功直後、markResolved前後）へ
置いた——settlement成功後の`postResult()`/embed編集の失敗はcompletionを
無かったことにしない。

### 14.4 privacy boundary

新規safe source `casino_completed_activity_days`のpayloadは
`{ activityKey, activityDate, completedAt }`だけ——participationKey・
userId（相手の分）・opponent/counterpart・wager・payout・net・result・
winner/loser・bet selection・horse・roulette選択・raw play count・
session id・operation idのいずれも含めない。`user × activityKey × JST day`
で最大1 factへcollapseする（同日100回完了しても1件）。`activityDate`は
`completed_at`をJST変換して求める——commitmentの`occurred_at`の日ではない。
raw persisted source `casino_participation_completions`は
`titleUsable:false`/`restricted`/`restrictedUse:
"casino_safe_completion_classification"`——内部classifier
（`computeCasinoCompletedActivityDays()`）だけが読む。

### 14.5 readiness registryへの反映

| No | 候補 | before | after |
| --- | --- | --- | --- |
| 66 | 初勝負 | PARTIAL（source_semantic_mismatch） | READY（none、usableSources: `casino_completed_activity_days`） |
| 67 | つまみ食い | PARTIAL（source_semantic_mismatch） | READY（none、usableSources: `casino_completed_activity_days`） |
| 68 | 賭場通 | READY（`casino_activity_days`のまま） | 変更なし——completion sourceへ切り替えない |
| 69 | 何でもござれ | BLOCKED（missing_manifest + source_semantic_mismatch） | BLOCKED（missing_manifestのみ。usableSourcesに`casino_completed_activity_days`を記録） |

READY 14→16、PARTIAL 10→8、BLOCKED/META不変。`source_semantic_mismatch`
blocker 12→9（casino分3件が解消、VC social breadth/economy/eventの6件は
残る）。Theme 14（賭場）はREADY 1→3・PARTIAL 2→0・BLOCKED 5（不変）。
READYを支えるsource種は6→7（`casino_completed_activity_days`が追加）。

### 14.6 mutation self-verification

- `computeCasinoCompletedActivityDays()`のday-collapse dedupe guard
  （`seen.has(dedupeKey)`）を一時的に無効化 → same-day 100回completion
  testが実際にfail（100件返る）→ restore。
- `v2-sources.ts`の`casino_completed_activity_days` bulk readerへ
  `participationKey`を一時的に漏らす → privacy test（J）が実際にfail
  → restore。
- `chohan-multi.ts`のcompletion writerを`settleProportional()`成功前へ
  一時的に移動 → production callsite source-order testが実際にfail
  → restore。
- 新規`casino-completion-callsites.test.ts`の「settlement成功→UI失敗でも
  completion=1」testのcallback内で、completion write呼び出しを意図的に
  UI失敗(throw)の後ろへ動かす → testが実際にfail（completion 0件のまま）
  → restore。
- readiness registryのNo.66をPARTIALへ戻す → 新規/既存guardが実際にfail
  → restore。
- readiness registryのNo.69へ`source_semantic_mismatch`を再度追加する
  → 新規/既存guardが実際にfail → restore。
- すべて`git diff`クリーンな状態まで復元済み。副産物として
  `packages/core/src/casino/opening-tables.ts`に新テーブル
  `casino_participation_completions`の分類entryを追加する必要があることを
  既存`casino-opening-plan.test.ts`が検出——追加して解消した。

## 15. PR F2c: Economy Reversal-Safe Peer Actions / No.58 Source Readiness

### 15.1 source classificationとsnapshot境界

`computeSafeEconomyPeerActions()`はoriginal transactionを`t`として読み、
従来の`t.reversal_of IS NULL`（reversal transaction自身を除外）に加えて、
次のsnapshot-bounded anti-joinでreverse済みoriginalを除外する。

```sql
NOT EXISTS (
  SELECT 1
    FROM transactions AS r
   WHERE r.reversal_of = t.id
     AND r.created_at < effectiveEnd
)
```

`effectiveEnd`は他sourceと同じ`resolvedScopeEffectiveEnd(scope)`の結果であり、
original側の`[scope.start, effectiveEnd)`と同じ終端を使う。したがってfuture
reversalはhistorical evaluationを書き換えない。`r.created_at === effectiveEnd`
もexclusive endのため、そのsnapshotではoriginalがまだvalidである。
reversal identityの正本はLedgerの`original.id` / `reversal_of` /
`reversal.created_at`だけで、reason/ref/idempotency/amount/counterpartyから
妥当性を推測しない。

### 15.2 privacyとday collapse

outer SELECTとsafe payloadは従来どおり最小化される。SQLが内部classification用に
`t.id`/`r.reversal_of`/`r.created_at`を見るだけで、readerのJS resultへは
`from_account`/`type`/`created_at`だけを返し、rule payloadは`{ kind, date,
occurredAt }`だけ。transaction id、reversal id、amount、counterparty、reason、
ref、approved_by、idempotency_key、reversal_ofは公開しない。

invalid originalをSQLで先に除外してから`user × JST date × kind`で最大1件へ
collapseする。同日のtip #1がreverse済みでもtip #2がvalidなら、その日のtip
factは残り、`occurredAt`はtip #2——snapshot内の最初のvalid qualifying
transaction——になる。exact allowlistは`transfer`/`tip`のままで拡張しない。

### 15.3 No.58 readiness delta

| No | 候補 | before | after |
| --- | --- | --- | --- |
| 58 | ほんの気持ち | PARTIAL（source_semantic_mismatch） | READY（none、`economy_safe_peer_actions` / `computeSafeEconomyPeerActions`） |

registry実データの再集計結果はREADY 16→17、PARTIAL 8→7、BLOCKED 67・
META 8は不変。`source_semantic_mismatch`は9→8。No.58の
`missingCapabilities`は空になった。xlsxのsemanticSpec「別ユーザーへの最初の
有効な通常tip。」とBlocker原文「reversal済取引は無効。」は変更していない。

### 15.4 production release gate（未解決）

SOURCE READINESSのREADYはproduction release可を意味しない。Title v2のaward /
ownership / award factsはimmutable前提であるため、次の時系列はsource
classificationだけでは解決しない。

1. t0: valid tip
2. t1: No.58をaward
3. t2: staffがそのtipをreverse

t2以降のsource snapshotはtipを正しく無効として扱う一方、t1で永続化済みのaward /
ownershipを自動revocationしない。production化前に、少なくとも次のいずれかを
正式決定する必要がある。

- A. catalog semanticを「成立時点でvalidなら後日reversal後も獲得維持」へ正式変更する
- B. economy transactionへfinality policyを導入し、finality後だけawardする
- C. Title側に安全なinvalidated/revocation lifecycleを設計する

PR F2cではどれも決めず、production BehaviorTitleDefinition、Bot award wiring、
revoke機構、reversal期限、economy policy変更を実装しない。

### 15.5 mutation self-verification

- reversed-originalの`NOT EXISTS` filterを一時的に除去
  → B/C/Hがoriginal factを返してfailし、Eもreversed firstの`occurredAt`を
  採用してfail（4 failures）→ restore。
- reversal側の`r.created_at < effectiveEnd`を一時的に除去し、DB全体の
  reversal存在だけを見る形へ変更
  → G（future reversal）とI（end exactly）が空factになってfail
  （2 failures）→ restore。
- later valid transactionがある場合だけreversed firstを誤って候補へ戻すmutation
  → Eだけをfocus実行し、expected tip #2に対してtip #1の`occurredAt`を返してfail
  （1 failure）→ restore。
- restore後に対象テストを再実行し、意図した実装へ完全復元されていることを確認した。

## 16. PR F2d: Public Event Completed Participation Safe Signal

### 16.1 rosterとcompletionの分離

既存E3の`public_event_participations`は「運営が確定したrosterにuserが含まれた」
事実のまま変更していない。`recorded_at`もroster保存時刻であり、event終了時刻では
ない。別のappend-only正本`public_event_completions`へ、`/イベント完了記録`の
preview→confirmを通じてstaffが終了済みと明示attestしたeventだけを記録する。
既存rosterからの自動backfillやevent_dateへのbackdateは行わない。

completion rowは`event_key`をprimary keyとし、`(event_key,
roster_recorded_at)`で`public_events`へFK接続する。`completed_at >=
roster_recorded_at`をCHECKし、timestampはservice clockだけが決める。retryは
最初の`completed_at`/`completed_by`を保持する。event_dateがcompletion時点のJST
dateより未来ならrejectする。

### 16.2 raw/safe source

raw `public_event_completions`は`privacy:"restricted"`, `titleUsable:false`,
`restrictedUse:"public_event_safe_completion_classification"`。derived
`public_event_completed_participations`は、participant rowとcompletion rowの
event key・roster timestampが一致し、completion timestampがscope内にある場合だけ
`{ eventKey, completedAt }`を返す。name/date/recordedBy/completedBy/count/他参加者は
公開しない。`completedAt`はstaff attestation時刻でactual event end timestampでは
ないため、raw/safeとも`orderable:false`であり、earnedAtの根拠にはできない。

### 16.3 readiness delta

| No | before | after |
| --- | --- | --- |
| 80 | PARTIAL（completion mismatch） | READY（`public_event_completed_participations`） |
| 81 | PARTIAL（completion mismatch） | READY（`public_event_completed_participations`） |
| 82 | BLOCKED（event-date + completion） | BLOCKED（実event-date safe span source不足のみ） |
| 83/84 | BLOCKED（role protocol） | 変更なし |

registry実集計はREADY 17→19、PARTIAL 7→5、BLOCKED 67・META 8は不変。
`source_semantic_mismatch`は8→5、Theme 16はREADY 2 / PARTIAL 0 /
BLOCKED 3。production BehaviorTitleDefinition、threshold、Bot award wiringは
追加していない。

## 17. PR F2e: VC Group-Size Daily Safe Aggregates

### 17.1 canonical timelineとJST日次payload

既存`computeGroupSizeSeconds()`のtrust判定・occupancy境界を別実装へ複製せず、
module-privateなcanonical timelineへ切り出した。timelineはsubjectごとに
`{ start, end, bucket }`のtrusted sliceと`untrustedSeconds`だけを持つ。
既存whole-window resolverはsliceを4bucketへ合算し、新しい
`computeGroupSizeDailySeconds()`は同じsliceをJST 00:00境界で分割する。
したがって、daily全日のbucket合計は既存`trustedSecondsByBucket`と全4bucketで
完全一致する。既存`vc_group_size_seconds`のpayloadと`untrustedSeconds`の意味は
変更していない。

新しい`vc_group_size_daily_safe` payloadは次だけを返す。

```ts
{ days: [{ date: "YYYY-MM-DD", trustedSecondsByBucket: {
  solo, oneToOne, smallGroup, largeGroup
} }] }
```

dateはJST・昇順、各bucket keyは固定。untrusted-onlyの日は作らず、counterpart
identity、channel/parent、visit start/end、raw ID、mute/deafen、start/end quality、
exact occupancy、pairwise overlapは公開しない。source contractは`privacy:"safe"`,
`titleUsable:true`, `orderable:false`。日付とaggregate秒はexact achievement timestampを
証明しないため、non-null `earnedAt`の根拠には使えない。

### 17.2 threshold-neutralとreadiness

sourceはactive-day秒数、必要日数、share、minimum sample、span、streak、skewの
具体値を一切持たない。soloをshare分母へ含めるか、social三帯だけを分母にするかも
production catalog側で決める。4bucketの日別trusted secondsが欠落なくあるため、
No.10-21が要求するqualifying days、total、share、per-day share、first/last date、
span、streak、bucket coverage、三social bucket網羅、長期skewは後段ruleで評価可能。
全件`thresholdCategory: THRESHOLD_PENDING`のままSOURCE READINESSだけREADYへ変更した。

registry実集計はREADY 19→31、PARTIAL 5（不変）、BLOCKED 67→55、META 8（不変）。
`missing_derived_source`は24→12。Theme 3-6は各READY 3 / PARTIAL 0 /
BLOCKED 0。production BehaviorTitleDefinition、threshold、Bot award wiringは追加していない。

### 17.3 historical channel bind boundedness

D1経路を再監査した結果、subjectのhistorical distinct channel IDsを単一の
`channel_id IN (...)`へ無制限展開していた。`VC_CHANNEL_QUERY_CHUNK_SIZE = 300`
でdedupe/chunkし、各queryをwindow bind 3個＋channel ID最大300個に制限した。
chunk結果はmerge後に`user_id ASC, started_at ASC, id ASC`へglobal sortしてから
coalesceするため、chunk境界でlogical visit semanticsは変わらない。1200 distinct
historical channel fixtureでSQL placeholder最大303・結果保存をregression testに固定した。

## 18. PR F2f: VC Social Breadth Daily Distribution

### 18.1 additive safe payloadと集約意味論

新規sourceは作らず、既存`vc_social_safe`と`computeSafeSocialAggregates()`だけを
加算的に拡張した。既存3指標は変更せず、payloadへ次を追加する。

```ts
{
  distinctCoPresentUsers,
  maxRepeatedDaysWithOneCounterpart,
  trustedOverlapSeconds,
  dailyBreadth: [{ date: "YYYY-MM-DD", distinctCoPresentUsers }]
}
```

`computeCoPresenceOverlaps()`が返すrestrictedな
`{ userA, userB, overlapSeconds, jstDays }`だけを1 passで畳み込み、本人ごとの
global counterpart union、pairごとのJST日数、pair-seconds、
`Map<date, Set<counterpart>>`を同時に構築する。同じ相手との同日複数visit・
複数channelは1人、異なる日は各日の集合へ1人ずつ数える。`dailyBreadth`はJST date
昇順で、interactionの無い日は0行を補わない。各日のcount合計は同じ相手を日ごとに
再計上するため、scope全体の`distinctCoPresentUsers`と一致する保存則ではない。

公開payloadはdate/countだけで、counterpart ID/hash/stable index、pair、channel、
timestamp、visit count、pair overlap、per-partner timelineを含まない。
`readTitleSource()`/`TitleSourceCache`の既存generic deep-freezeがpayload、配列、entryを
再帰的にfreezeする。zero-resultは既存zero metricsに`dailyBreadth: []`を加える。

source contractは`derivedFrom:["vc_co_presence"]`, `privacy:"safe"`,
`titleUsable:true`, `orderable:false`, `rawUnit:"safe_social_aggregate"`のまま。
監視・永続化・SQL・production BehaviorTitleDefinition・threshold・Bot award wiringは
追加していない。既存の300-user bulk chunkと300-channel query chunkも維持する。

### 18.2 threshold-neutralとreadiness

active day、minimum per-day breadth、必要日数、span等の具体値はsourceへ置かない。
No.23-25はscope全体のglobal distinct、JST日次分布、date spanを後段で組み合わせて
意味を落とさず表現できるため、`usableSources:["vc_social_safe"]`、
`specializedResolvers:["computeSafeSocialAggregates"]`、`missingCapabilities:[]`、
`blockerKinds:["none"]`としてPARTIAL→READYへ変更した。いずれも
`thresholdCategory:THRESHOLD_PENDING`のまま。

No.29/30は特定counterpartに紐づいたoverlapをpublic sourceが返さないためPARTIAL、
No.31はpair persistence source不足でBLOCKEDのまま。missingCapabilities・blockerKinds
も変更していない。registry実集計はREADY 31→34、PARTIAL 5→2、BLOCKED 55・
META 8は不変。`source_semantic_mismatch`は5→2、`missing_derived_source`は12のまま。
F2f時点のTheme 7はREADY 4 / PARTIAL 0 / BLOCKED 2、Theme 8はREADY 1 / PARTIAL 2 /
BLOCKED 1。

## 19. PR F2g: Public Room Activity Safe Source

### 19.1 source境界と実利用

`rooms`単体はroom session metadata/lifecycleの正本であり、一般guest履歴は持たない。
`recruits.matched_user_id`と`oborozuki_invites`はprivate機能固有で、公開部屋guestの
推論には使わない。F2gは新しい監視・writer・tableを追加せず、raw restricted source
`rooms`と既存canonical `vc_visits`を`computePublicRoomActivitySafe()`で交差する。

eligible kindは`normal`/`game`のexact allowlist。`mitsugetsu`/`oborozuki`はprivate
permission semanticsのため完全除外する。有効利用はroom intervalとtrusted positive
logical visitの交差だけで、room作成・`activated_at`・0秒intersection・
`recovered_estimate`はevidenceにならない。untrusted visitや重複room attributionの
曖昧時間帯だけを局所的に除外し、同日・同roomの別trusted activityは保持する。

room intervalは`created_at`から、`effectiveEnd`、snapshot内のcanonical `closed_at`、
gameのpaid validity上限`expires_at`の最小まで。`closed_at > observedAt`はhistorical
snapshotではまだopenとして扱う。ownerがその瞬間VCにいることはhosted/guest双方の
追加条件にしない。ownUseだけはowner本人のtrusted visitを必須とする。

### 19.2 safe payloadとprivacy

payloadは`hosted`（distinct guest/session、room-session内最大同時guest、JST日別分布、
`maxRepeatGuestDepth`）、`guest`（distinct owner/sessionとJST日別分布）、`ownUse`
（本人利用sessionとJST日別分布）だけ。guest/owner/room/channel/parent ID、capacity、
close actor/reason、raw visit時刻は公開しない。`maxRepeatGuestDepth`は、各guestについて
distinct JST dateを左、distinct room sessionを右、そのguestがその日・sessionで有効利用
したことをedgeとする二部グラフのmaximum matching sizeを求め、そのguest間最大を取る。
したがって別guestの相関を合成せず、depth Nは互いに異なるN日と互いに異なるN sessionの
有効来訪対応を正確に証明する。同時人数は`[start,end)`でendをstartより先に処理し、
room capacityは使わない。

raw `rooms`は`privacy:"restricted"`, `titleUsable:false`, `orderable:false`,
`restrictedUse:"public_room_safe_activity_classification"`。derived
`public_room_activity_safe`は`derivedFrom:["rooms","vc_visits"]`, `privacy:"safe"`,
`titleUsable:true`, `orderable:false`。300-user bulk chunkとcanonical 300-channel
chunkを維持し、1200 historical room/channelでもroom/guest/day単位のN+1を作らない。
channel lookupは既存global UNIQUE indexを使う。一方、owner open-slot partial indexは
closed historyを含むexact queryには使えず`SCAN rooms`になるため、実query planに基づき
`idx_rooms_owner_history(owner_id, kind, created_at)`を追加した。migration testで同じ
owner-history queryがこのindexを使うことを固定する。

### 19.3 readiness delta

No.50-56は`public_room_activity_safe`/`computePublicRoomActivitySafe`でSOURCE READY。
No.57は普通のguest activity側だけ解消したが、宿屋系role-at-timeとvisit時点のtemporal
cross-referenceが無いためBLOCKEDを維持する。registry実集計はREADY 34→41、
PARTIAL 2（不変）、BLOCKED 55→48、META 8（不変）。Theme 12は0/0/8→7/0/1。
`missing_persisted_source`は32→24、`missing_role_history`は既にNo.57へ付いていたため
7のまま。production threshold、BehaviorTitleDefinition、Bot award wiringは追加していない。

## 20. PR F2h: Canonical TC Social Observation + Safe Conversation / Reaction Sources

### 20.1 persistence・eligibility・snapshot

既存`text_active_days`はpublic non-thread TCの1 user×1 JST day binary sourceのまま変更しない。
F2hは別policyのsidecarとして、main guildのhuman `GuildText`/`GuildAnnouncement`と、
@everyoneが閲覧できる`PublicThread`/`AnnouncementThread`/public forum postだけを観測する。
DM、bot、webhook、system message、PrivateThread、role-gated/permission unknown、
`xp_excluded_channels`対象をfail-closedで除外する。normal channelは
`area_id=surface_id=channel ID`、public thread/forumは`surface_id=thread ID`,
`area_id=public parent ID`——thread本数でarea breadthを水増ししない。

`tc_message_observations`はmessage/author/surface/area/reply identity、surface kind、
Discord `created_at_ms`、Bot first `observed_at_ms`と、exactに得られるthread owner/create
provenanceだけをrestrictedに保存する。content、attachment、embed、sticker、mention、
username、message length、AI/NLP結果はschemaにもwriter APIにも無い。MessageCreate replayは
`ON CONFLICT DO NOTHING`でfirst observationを保持し、edit/deleteでも更新・削除しない。
resolverはevent occurrence=`created_at_ms`とknowledge cutoff=`observed_at_ms`を両方使い、
future observationをhistorical snapshotへ混ぜない。Discord履歴のREST backfillは行わない。

`tc_reaction_observations`は`(message_id, reactor_id)`をPRIMARY KEYとし、既存eligible
messageへのother human reactionのfirst `observed_at_ms`だけを保存する。emoji、author、
channelは重複保存しない。self/bot reactionを除外し、multi-emoji・remove→re-addでも
1 reactor×1 post=最大1 fact。ReactionAddにはcanonical occurrence timestampが無いため、
JST dayは**Bot reaction observation day**であり真のreaction発生日ではない。
`GuildMessageReactions` intentとuncached event用partialsを追加し、fetch/writer failureは
sidecar logだけで通常Bot処理・user reactionへ伝播しない。

### 20.2 conversation safe payload

`tc_conversation_safe`はraw identityを取得済みJS Map内だけで使い、reply parentを同じ
surfaceのrootまで解決する。parent missing/別surface/snapshot未来/cycleはそのlinkだけを
除外し、unrelated interactionは残す。public threadはsurface自体を1 explicit conversation。
content similarityや固定15/30分windowでtopicを推測しない。

payloadは次のidentity-free sufficient statisticsのみ:

- `starts[]`: normal channelのtop-level messageだけについて、JST date、scope内の直前surface
  messageからの`quietBeforeMs`（不明は`null`）、`nextOtherGapMs`、reply上の
  `explicitContinuation`。既存public thread/forum内の通常messageはreply指定が無くても
  conversation内部のmessageであり、thread starterをexactに証明できないため`starts`へ入れない
- `revivalConversations[]`: anonymous explicit conversation groupごとのrevival date、
  `dormantBeforeMs`、`continuationGapMs`
- `areas[]`: anonymous logical areaごとのJST `socialDays`と`bestOtherGapMs`
- `thirdPartyJoins[]`: distinct prior other authors最大2人のgap、`priorSelfGapMs`、
  `nextOtherGapMs`
- `startedConversations[]`: exact reply-root/thread starterに限るdistinct other participants、
  active dates、span、max inter-activity gap
- `socialDays[]`: 別humanとのexchangeが存在するJST日と最小gap（No.49 TC側）

message/post count、message/channel/thread/area/counterpart ID、content/raw timestamp listは出さない。
quiet/dormant/continuation/exchange/longlifeの具体値は一切固定せずF5/F6 calibrationへ送る。
logical area groupingとinteraction localityは分離する。public thread/forumはparent channel/forumへ
area集約する一方、`bestOtherGapMs`とglobal `socialDays`のexchangeは同一`surface_id`内だけで
成立させる。同じforum parent配下でもcross-thread temporal adjacencyはsocial activityにしない。

### 20.3 reaction safe payload・SQL

`tc_reaction_safe`は`distinctReactors`、anonymous `posts[{reactionDays,
distinctReactors}]`、`days[{date,distinctPosts,distinctReactors}]`だけ。global reactorは同一人が
10 postへ付けても1人、同一postへ3 emojiでも1人。message/reactor/post/channel/emoji identityは
公開しない。両safe sourceはcanonical event occurrence/earnedAtを完全には主張できないため
`orderable:false`。

live writerはO(1)。evaluationはrequested author 300-ID chunk、subjectから得たarea 300-ID
chunk、reaction JOINをbulkで読む。reply rootは取得済みMapで解決し、message/reply/reaction/
area単位の再帰SQLを発行しない。1200 messages/surfaces/reactions testでSQLite variable上限を
超えず、author/area/surface/reply/reaction query planは用途に対応するindexを使う。

### 20.4 readiness delta

No.42-45/47はquiet・explicit revival grouping・logical area・distinct prior others/
continuation、No.46はanonymous post/day/reactor分布、No.49はTC `socialDays`とF2f
`vc_social_safe.dailyBreadth`でSOURCE READY。No.48はreply-root/public threadならexactだが、
通常free-flow TCの「同じ話題」をcontent無しでcanonicalに証明できない。reply/threadを使う人
だけへcatalog semanticを縮めないためPARTIALとする。

結果はREADY 41→48、PARTIAL 2→3、BLOCKED 48→40、META 8（不変）。Theme 11は
0/0/8→7/1/0、`missing_persisted_source` 24→16、`source_semantic_mismatch` 2→3。
production threshold、BehaviorTitleDefinition、award/notification、catalog activation、
historical backfillは追加しない。

## 21. PR F2i — Public Social Activity Time Safe

### 21.1 exact source contract / payload

`social_activity_time_safe`は`origin:"derived"`、`derivedFrom:["tc_message_observations",
"vc_public_social_presence"]`、`privacy:"safe"`、`titleUsable:true`、`orderable:false`、interval
`windowStart→windowEnd`（clip:true）。raw unitは
`safe_public_social_activity_hour_distribution`。payloadは次のsparse shapeだけ:

```ts
{
  days: [{
    date: "YYYY-MM-DD",
    hours: [{ hour: 0..23, tcBestOtherGapMs: number | null,
              vcTrustedSocialSeconds: number }]
  }]
}
```

days/date ASC、hours/hour ASC。TC gapがnon-nullまたはVC secondsがpositiveなhourだけを出し、
完全inactive dayは出さない。24hour binはprivacy-safe measurement resolutionであってdaypart
thresholdではない。morning/afternoon/evening/late-night境界、TC social gap、VC meaningful
seconds、share/concentration/必要日数は未決定。

### 21.2 TC canonical semantic共有

F2hのbulk subject/area context loaderとsurface-local nearest-other logicを
`computeTcSocialExchangeCandidates()`へ共有した。standalone投稿はsocial activityにせず、
subject messageと同一surface内other human messageのnearest gapだけを候補にする。normal
channelはsurface=channel、thread/forumはsurface=thread。area=parent breadth taxonomyと
surface=interaction localityを混ぜず、同じforum parent配下のcross-thread temporal adjacencyを
social evidenceへ変換しない。source内でgap cutoffを置かず、6時間gapも値として保持する。
message ID/author/counterpart/surface/area/exact time/minute/second/count/contentはpayloadへ出さない。

### 21.3 canonical public VC social presence

`vc_social_safe.trustedOverlapSeconds`はpair-summedなので時間帯durationへ流用しない。
raw `vc_segments`/`vc_visits`はmain guild/public visibilityを証明しないためF2iの依存から外す。
代わりにrestricted persisted source `vc_public_social_presence`を追加する。eligibleは
`settings["guild:main"]`の`GuildVoice`かつ@everyoneの`ViewChannel`/`Connect`双方がtrueの場合だけ。
role-gated、permission unknown/failure、Stage、other guild、botはfail-closedで除外する。

human occupancyが1→2になったlive observationで在室human全員を同時openし、2→1で全員を
同時closeする。3 humansを3 pairへ展開せず各user 1 intervalなので、3人同時10秒は各user 10秒。
VoiceStateUpdateはaffected old/new channelの全human member cacheを収束する。voice自身・親categoryの
ChannelUpdateとmain guild @everyone RoleUpdateでもpublic/private transitionを再評価する。
derivedはtrusted observed user intervalsをsubject-global unionしてからJST hourへsplitし、
同時複数channel corruptionも二重計上せず各hourを0..3600秒に保つ。

dangling intervalはrestart時に`recovered_estimate`で閉じ、現在snapshotでは行ごと除外する。
起動時刻までobservedとして延長せず、ready時点のmain guild cacheから新intervalを開始するだけで、
Discord history fetch/backfillを行わない。fixed historical `observedAt`がrecoveryより前なら、当時openと
観測済みだった範囲だけをそのcutoffへclipし、後発recovery mutationでsnapshotを変えない。

Gatewayのrealtime observationを失った時点で、影響shardのmain guildだけをsuspendし、open rowを
そのloss boundaryで閉じる。通常のrecoverable closeはDiscord.jsの`ShardReconnecting`、再接続不能は
`ShardDisconnect`を境界にする。suspend中にResumeでreplayされるVoiceStateUpdateはpayloadに真の
occurrence timeが無いためsourceへ書かない。replay完了後の`ShardResume`、fresh Identify後の
`ShardReady`でshard suspensionを解除するが、main guildの`available === false`または
`unavailableGuilds`残存時はguild suspensionを解除しない。cold startupもunavailable cacheからは
0 rowのまま待ち、`GuildAvailable`のfull current cacheを観測した時点からだけ新規openする。
main-guild `GuildVoice`の`ChannelDelete`はVoiceStateUpdateを仮定せずdelete観測時刻で対象open rowを
closeする。main `GuildDelete`はguild内open rowを全てcloseし、`GuildAvailable`では再開せず、再join時の
`GuildCreate` full current cacheから新規観測する。disconnect/unavailable/delete区間をhandler受信時刻で
backfillせず、無関係なguild/shard/channelは停止しない。

### 21.4 snapshot / SQL / privacy / health guard

TCは`created_at_ms`をevent time、`observed_at_ms`をknowledge cutoffとして扱い、VC sidecarは
Gateway healthy中のhandler entry unix secondsをlive occurrence/knowledge timeとして1回だけ固定する。fixed
observedAt未来のrowを除外し、後からDBへ追加しても同じsnapshot結果を変えない。requested userと
TC areaは300-ID chunk。VC sourceはrequested-user bulk 1 queryで、message/surface/channel/hour
ごとのSQLを発行しない。1200 user/area/surface/presence fixtureでSQLite bind上限とN+1不在を固定した。

sidecarのpermission解決・DB writer・startup scan失敗はcatch/logだけで、既存`trackVoiceState`、
voice attendance、rooms、XP、その他VoiceStateUpdate consumerへ伝播しない。全判定はDiscord cacheで
完結し、追加fetch/N+1はない。writer transaction失敗時はchannel-local trust fenceと可能なら同時刻の
durable closeでopen rowを失敗時刻までにclipする。Gatewayはhealthyなので受信済みchannel snapshotは
memoryへ順序付きで保留し、次の正常writeで1 transactionに再適用する。これによりfailure→recoveryを
推測で在室扱いせず、同時に確実に受信したtransitionを不要に捨てない。process restart後のmemory推測は
行わず、残ったdangling rowは従来どおりuntrusted recoveryにする。1 channelのfailureは他channelへ
波及しない。safe payloadにはguild/channel/user/permission identityを出さない。

No.32-37は全件SOURCE READY、NONCOUNT、`THRESHOLD_PENDING`。結果はREADY 48→54、
PARTIAL 3（不変）、BLOCKED 40→34、META 8（不変）。Theme 9は0/0/6→6/0/0、
`missing_persisted_source`は16→10。No.48は時間帯aggregateではfree-flow同一topicを
証明できないためPARTIALを維持する。streak、連続日、深夜量ranking、raw message/VC visit
count、「あと何時間」のprogress barは作らず、夜更かし/FOMOをrewardしない。production
BehaviorTitleDefinition、award/notification/catalog activation、historical backfill、
daypart/thresholdは追加しない。

### 21.5 既存VC candidate public-semantics再監査（readiness補正）

F2i以外も独立再監査した結果、候補原文が明示的にpublicを要求する一方、公開分類のない
`vc_visits`系derivedを使う候補は次の3件だった。`vc_public_social_presence`は時間帯用の
user-level intervalであり、empty-start/last-occupant/counterpart identity breadthを代替しない。
他にmain/public provenanceをexactに証明するsourceもないため、3件をREADY→PARTIAL、
`blockerKinds:["source_semantic_mismatch"]`へ補正した。

| candidate | current source chain | impact |
| --- | --- | --- |
| No.1 火種 | `vc_empty_start_then_joined` → `vc_visits` | private/role-gated/other-guild VCが「空の公開VC」証拠になり得る |
| No.6 残り火 | `vc_last_occupant` → `vc_visits` | private/role-gated/other-guild VCが「複数人の公開VC」証拠になり得る |
| No.22 顔馴染み | `vc_social_safe` → `vc_co_presence` → `vc_visits` | private/role-gated/other-guild co-presenceが「公開の有効共在」breadthへ入り得る |

実集計はREADY 51 / PARTIAL 6 / BLOCKED 34 / META 8。No.32-37は専用sourceが
main guild + public GuildVoice + human occupancy + Gateway/writer trust boundaryを証明するため
READYを維持する。threshold/award/production definitionはこの補正では追加しない。

## 22. PR F2j — Invite Rooted Safe

### 22.1 canonical provenanceとentry anchor

direct relationの正本は既存`invites`だけ。identityを必要とするJOINはrestricted
`confirmed_invite_relations` viewとしてcontract登録し、No.74/75用のidentity-free
`confirmed_invites` payloadとは分離する。`invitee_id UNIQUE`、Entryのself拒否、
亡霊化時または門番の後追い登録時に同じ`creditInvite()`が確定する境界を維持し、
`souls.inviter_hint_*`や`entry_bookings.inviter_*`は一切読まない。No.74/75の
`confirmed_invites` sourceも変更しない。

`invites.credited_at`はrelation確定時刻でありentry時刻ではない。canonical entry anchorは
Entryが最初の亡霊化時にappend-only EventLogへ書く最古の`events(type='ghosted',
target_id=invitee)`。`souls.ghost_at`、`joined_at`、current status/member stateからは推測しない。
従ってlate creditでも実entry dayへ正しくanchorし、immutable eventの無いlegacy relationは
`unknownEntryAnchorCount`へ畳んでprofileを生成しない。sidecar/tableもhistorical inferred
backfillも追加していない。

F2jではdirect relationはscope内behaviorを分類するhistorical contextであるため、
`credited_at < effectiveEnd`ならscope startより前のrelationも読む。entry anchorも同様に
pre-scopeでよい。一方、TC/VC activityとpair reunionそのものは常に
`[scope.start, effectiveEnd)`へclipする。fixed `observedAt`より後のcreditは見えず、creditが
snapshot内へ入った後はstaffがhistorically正しいとconfirmしたrelationとして、既に観測済みの
scope内activityへ結び付ける。これはinvite成立自体を数えるNo.74/75の`confirmed_invites`
（`credited_at >= scope.start`）とは意図的に別のsource semanticsである。

### 22.2 exact public activity / rooted semantics

「rooted」はmembership survivalではない。confirmed direct inviteeについて、exact entry
timestamp以後かつentry JST dayより後の各日に、次のいずれかのcanonical public evidenceが
あることを、anonymous direct-branch profile内の分布として保持する。

- canonical public TC observationのsame-surface other-human exchange候補。message本文、
  private/unclassified message、cross-surface adjacencyは使わず、その日の最小gap msだけを保持。
- `vc_public_social_presence`のtrusted public-social interval。main guild/public GuildVoice/
  human occupancy/Gateway-writer trust boundaryは既存canonical writer/derivedと共有し、JST日別の
  wall-clock union秒だけを保持。

sourceはqualifying日数、TC gap、VC meaningful secondsを決めない。`activityDays`の
`dayOffset`、`tcBestOtherGapMs`、`vcTrustedSocialSeconds`を返し、分布TBDのproduction
calibrationを可能にする。同日大量活動は1 day profileのままで、entry前・entry dayは除外する。

### 22.3 network branchとpair-specific reunion

profile 1件はconfirmed direct invitee 1人に対応するanonymous branch 1本である。child relationの
正本は`invites`のunique confirmed edgeだが、next-generation occurrenceはchild自身の最古の
immutable `ghosted` eventとする。staffの後追い`credited_at`はrelationがsnapshotで可視かだけを
決め、childの実entry historyを後ろへ移動させない。child anchorが無いrelationは
`unknownNextGenerationEntryAnchorCount`へ畳み、current stateやcredit時刻から補完しない。

同じprofileにrooted activity分布と、confirmed childごとのanonymous
`nextGenerationOccurrences`を保持する。各occurrenceはbranch entry JST dateを0とした
`entryDayOffset`に加え、canonical child entry timestamp直前までのchild-day public activityを
`sameDayBeforeEntry`として持つ。TCはsubject messageとnearest other-human messageの両端が
child entryより前のexchangeだけを採り、VCはtrusted subject-global unionを
`[day start, child entry)`でclipした秒数だけを採る。exact timestampやidentityは公開しない。

将来のthreshold ruleは、あるoccurrence `N`に対し`activityDays.dayOffset < N.entryDayOffset`の
完全な過去日分布と`N.sameDayBeforeEntry`を合わせてrooted条件を評価する。これによりthresholdを
固定せず、同じchild JST dayでもactivity-before-childとactivity-after-childを区別できる。
同日複数childもoccurrenceをcollapseせず、それぞれ異なるprefixを保持する。negative/zero offsetも
落とさないため、child-before-rootも誤ってcascadeにしない。No.78はこの条件を満たすprofile数を
数えるため、A→X,Y,Z,Qは1 branch、A→X / B→Yは2 branchesとなる。self/cycleは除外する。

No.79の`reunionDays`はinviterとそのconfirmed direct inviteeのidentityをrestricted derived
内部でだけJOINする。TCは両者のsame-surface message間の最小gap、VCは両者の同一canonical
public channel内trusted interval overlapをJST dayへunionし、entry dayを除外する。第三者との
交流、cross-surface/cross-channel、private/unclassified activity、単なるcurrent membershipは
pair interactionへ変換しない。

### 22.4 safe payload / snapshot / runtime boundary

safe payloadは次のidentity-free shapeだけを返す。

```ts
{
  profiles: Array<{
    activityDays: Array<{ dayOffset; tcBestOtherGapMs; vcTrustedSocialSeconds }>;
    nextGenerationOccurrences: Array<{
      entryDayOffset: number;
      sameDayBeforeEntry: { tcBestOtherGapMs; vcTrustedSocialSeconds };
    }>;
    unknownNextGenerationEntryAnchorCount: number;
    reunionDays: Array<{ dayOffset; tcBestPairGapMs; vcTrustedPairSeconds }>;
  }>;
  unknownEntryAnchorCount;
}
```

invitee/child/counterpart/message/surface/channel/guild identity、exact date/timestamp、invite code、
raw permission/member stateは出さない。profilesはsanitized内容のcanonical順にsortする。
fixed `observedAt`ではrelation confirmationとentry eventをそのsnapshotより前だけから読み、
TC observationとVC trusted intervalはさらにscope startでもclipする。後のcurrent soul/member
変更で過去payloadを書き換えない。

新persisted source・write path・Bot/onboarding wiringは無い。derived read failureが
Entry/`creditInvite()`を止める経路は存在せず、bulk readerは300 subjectごと、internal
participantsも300 IDごとにchunkする。historical backfill、production threshold、award、
notification、leaderboard、progress UIは追加しない。Theme 15はoptimizationRisk: HIGHを
維持する。

No.74/75は既存`confirmed_invites`のままREADY。No.76はpre-scope relation contextとscope内
later-day public activity分布、No.77は完全な過去日分布とchild entry時点のsame-day prefix、
No.78は同日複数childを含めroot-before-childを満たすdistinct profile breadth、No.79はscope内
later-day pair-specific public reunionをexactに表現できるためREADY。
実集計はREADY 55 / PARTIAL 6 / BLOCKED 30 / META 8。

## 23. PR F2k — Economy Semantic Family + Shop Purchase Safe

### 23.1 production callsite / purchase origin audit

`shop_purchases`の3つのINSERT pathと、それらへ到達する全Shop APIを監査した。
originは購入commit時に`shop_purchase_title_provenance`へ凍結し、現在の商品名・設定・
`request_json`・ledger reason/refから後で推測しない。既存rowのinferred backfillも行わない。

| purchase flow | canonical writer | frozen origin | No.62 eligible | 理由 |
| --- | --- | --- | --- | --- |
| normal Land / alternative storefront | `Shop.purchase()` → `purchaseInternal()` | `storefront` | yes | 普通の客としてitem validationとpaymentを通過した通常商館購入 |
| approved original-role application | `purchaseOriginalRole()` → `purchaseInternal()` | `original_role_application` | no | special application service |
| original-role invoice | `purchaseOriginalRoleInvoice()` direct INSERT | `original_role_invoice` | no | staff-issued invoice payment |
| evaluation deadline extension | `purchaseEvaluationExtension()` → `purchaseInternal()` | `evaluation_extension` | no | evaluation lifecycle special service |
| reevaluation right (Land/invite) | `purchaseReevaluation()` → `purchaseInternal()` | `reevaluation` | no | evaluation special service |
| timed-access legacy role import | `migrateTimedAccessLegacy()` direct INSERT | `legacy_timed_access_import` | no | 無償migration entitlement |

新しいdirect INSERTがprovenanceを作らなければsafe sourceには入らない。全3 INSERT pathが
`recordTitlePurchaseProvenance()`を通ることをsource-order testで固定し、unknown/synthetic/
operator-created rowを自動採用しない。

### 23.2 eligible product / lifecycle snapshot semantics

eligible contractは`TITLE_ELIGIBLE_SHOP_ORIGINS = ["storefront"]`。generic
`Shop.purchase()`はconfigured original-role/reevaluation/evaluation-extension itemを先に拒否するため、
このoriginはnormal customer storefrontに限定される。product identityは購入時item IDから作る
restricted `product_key`を凍結するがsafe payloadには出さない。同じeligible商品を何回買っても
global distinctは1、別商品は同じdelivery familyでも別productとして数える。後のrename、price/
delivery更新、disableで過去purchaseのidentity/eligibilityは変わらない。

購入成立と配送は独立。canonical purchase row + storefront provenanceがcommitされた時点を
purchase boundaryとし、`delivery_state=pending/failed`、`delivered_at IS NULL`でもpurchaseを保持する。
`status=expired`も正当な過去購入として残す。購入validation失敗はpurchase/provenanceが無いため0。

refund/cancelはcurrent statusではなくappend-only `shop_purchase_status_history`のoccurrenceを使う。
`Shop.refund()`はstatus updateと同じtransactionでexact application timestampを先にappendする。
current repoにproduction cancel commandは無いが、今後の`status -> cancelled`をDB triggerがtransition
時刻でappendする。sourceは`occurred_at < effectiveEnd`だけを除外するため、future refund/cancelは
fixed historical snapshotを遡及変更しない。legacyの現状態だけがrefunded/cancelledでもpurchase時
provenance自体が無いためfail-closedであり、時刻をcurrent stateからbackfillしない。

safe payloadは次だけ。

```ts
{
  days: [{ date: "YYYY-MM-DD", distinctEligibleProducts: number }],
  distinctEligibleProducts: number
}
```

item/purchase/user ID、name、price、paid kind/amount、transaction/request/delivery/invoice/staff dataは
公開しない。raw count rankingではなく、JST日別とscope-globalのdistinct product breadthだけ。

### 23.3 explicit economy semantic family manifest

`ECONOMY_FEATURE_FAMILY_MANIFEST`は`knownTxTypes()`/`publicLog`を走査せず、次の3 familyだけを
明示する。future tx type/shop workflowはmanifestとregressionのreview無しに自動追加されない。

| family | canonical provenance | direction | human counterpart | completion / reversal |
| --- | --- | --- | --- | --- |
| `peer_transfer` | `commands/transfer.ts`の`Ledger.transfer(type='transfer')` | in/out | yes | actor=from、human↔human、snapshot-bounded Ledger reversal |
| `tip` | `commands/tip.ts`の`Ledger.transfer(type='tip')` | in/out | yes | actor=from、human↔human、snapshot-bounded Ledger reversal |
| `shop` | immutable `origin='storefront'` purchase provenance | out | no | canonical purchase、snapshot-bounded shop refund/cancel |

ledger queryはfrom/to/type/created_atだけを読み、reason/ref/UI文言をSELECTしない。公式shop支払いの
`tip_burn`はledger familyへ入れず、同じ意味行動をcanonical `shop` 1 familyとしてだけ採る。
Land/alternative payment、複数underlying purchase rowがあってもshop family breadthは1。

明示除外はopening/initial、salary/pension/commission、`reward_*`/vc_reward/event_prize、
fine/tax/admin adjust、migration/recovery/compensation/refund、casino bet/prize/chip/remittance/bailout、
legacy ether、department/system bookkeeping、shop_personal/fanclub/inheritance、overloaded `tip_burn`。
reversal transaction自身とsnapshot時点でreversed originalも除外し、future reversalは過去snapshotへ
影響しない。shop refundをledger `adjust` reversalとして分類せずdomainを分離する。

### 23.4 natural circulation / safe aggregate / privacy

natural inflowは、manifest対象human→human transactionでsubjectが受取側、かつgiver本人が
`actor_id=from_account`としてcommitしたもの。natural outflowはsubject本人が実行したmanifest対象
human→human transaction、またはcanonical eligible storefront purchase。shop/system treasuryは
human counterpartへ数えない。

restricted内部でcounterpart identityをglobal/day distinct集合へ畳み、safe payloadは次だけを返す。

```ts
{
  days: [{ date, families, subjectUsedFamilies, directions, distinctHumanCounterparts }],
  distinctFamilies,
  subjectUsedFamilies,
  distinctSubjectUsedFamilies,
  distinctHumanCounterparts,
  hasNaturalInflow,
  hasNaturalOutflow,
  outgoingTip: {
    days: [{ date, distinctRecipients }],
    distinctRecipients
  }
}
```

No.61は複数日・overall family・human counterpart・inflow・outflowを同じwindowでthreshold未固定のまま
同時評価できる。overall `families`/`distinctFamilies`はinflow/outflow双方を含む。一方No.63は、
subject自身がoutflowとして正常利用したfamilyだけをJST日別/global
`subjectUsedFamilies`/`distinctSubjectUsedFamilies`で評価する。incoming-only transfer/tipはこの
breadthを増やさず、同日のincoming transfer + outgoing tipもsubject-usedは`tip`だけとなる。
No.59はoutgoing normal tipだけのrecipient union/day分布を使い、transfer recipientを混ぜない。
user/account/counterpart identity、amount、transaction/purchase ID、exact timestamp、reason/refは
公開しない。No.60の同一pair inflow→別機会outflow chronologyは意図的に公開せずBLOCKEDを維持する。

bulk readerは300 userごとにSQLを発行し、transaction/purchase/counterpart/itemごとのN+1を作らない。
fixed observedAtではfuture transaction/purchase/refund/cancelを混ぜない。

### 23.5 No.58–65 reaudit / readiness delta

| No. | status | 根拠 / 残blocker |
| --- | --- | --- |
| 58 | READY維持 | 専用`economy_safe_peer_actions`の最初のvalid normal tip + snapshot reversal semanticsを変更しない |
| 59 | READY | outgoing tip限定recipient breadth + JST day分布 |
| 60 | BLOCKED | 同一counterpartのpair chronology不足 |
| 61 | READY | natural in/out + human breadth + explicit family + JST days |
| 62 | READY | immutable eligible product breadth + snapshot refund/cancel |
| 63 | READY | tx type数ではなく、subject自身がoutflowとして正常利用したstable semantic family breadth |
| 64 | BLOCKED | normal economy sourceは揃ったが経済role-at-time不足 |
| 65 | BLOCKED | normal eligible storefront purchaseは揃ったが商館role-at-time不足 |

Theme 13はREADY 1→5 / BLOCKED 7→3。overallはREADY 59 / PARTIAL 6 /
BLOCKED 26 / META 8。priority tableから完了済みeconomy/shop clusterを外し、残りを1–5へ
連番化した。production threshold、BehaviorTitleDefinition、award/notification、leaderboard、
progress UI、amount/wealth/spend/purchase-count ranking、Series/Collection/Meta activation、
historical inferred backfill、merge/deployは行わない。

## 24. PR F2l: Casino Edition-I Manifest + Table / Standard Market Safe Sources

### 24.1 Edition-I completion

`CASINO_EDITION_I_MANIFEST`はversion=1の明示manifestで、常設パネル仕様の「基本ゲーム入口」
（スロット・丁半・クラッシュ・チンチロ・ルーレット・BJ・ポーカー・ホールデム）を根拠に、
`slots`/`chohan`/`crash`/`chinchiro`/`roulette`/`blackjack`/`poker`/`holdem`の8 familyへ固定した。
運用allowlist `CASINO_ACTIVITY_KEYS`は11種だが、keiba/sashi/indianはEdition-I外。allowlistへ
future gameを足してもmanifestを明示改訂しない限り旧editionへ加入しない。No.69 derivedは
`casino_completed_activity_days`だけをfamilyへ写し、全8 familyのcanonical completionを要求する。
commitment、勝敗、利益、賭け額、raw回数は使わない。

### 24.2 official table provenance / trust / privacy

eligible typeは`TITLE_ELIGIBLE_CASINO_TABLE_TYPES`へsashi/mahjong/duel/watch/zatsuを明示固定し、
`TABLE_TYPES`へ将来追加しただけでは称号対象にならない。公式panelのDiscord VC作成後、
`Takutate.track()`がcurrent row、append-only instance anchor、eventを同一DB transactionで保存する。
tracking失敗時は作成済みVCを削除してsplit-brainを残さない。channel名/category/reason/manual VCは分類しない。

guest observationはDiscord memberのcanonical bot flagが明示falseのuserだけを開き、owner自身は除外する。
mute/deafen等のsame-channel state changeでは分割しない。known join/leave、ChannelDelete、untrack、graceful
observation endだけをclose境界にする。restart時のdangling intervalは`recovered_unknown`として開始時刻で
閉じ、gap全体を0 trusted secondsにする。startup current cacheからはその観測時刻でfresh intervalを開き、
history backfillをしない。guest writer failureは専用try/catchで既存VC/room/卓削除を止めない。

safe payloadは次のidentity-free shapeである。

```ts
{
  tables: [{ createdDate, guestStays: [{ guestProfileIndex, date, trustedSeconds }] }],
  guests: [{ stays: [{ tableProfileIndex, date, trustedSeconds }] }]
}
```

restricted owner/guest/channel/guild identityだけでcorrelationしてからanonymous indexへ落とす。空卓、ownerのみ、
botのみ、unknown/recovered-only卓はsafe table profile自体を作らない。同一guest再訪は同profile、別guestは別profile。
deleted/untrack後もinstance/historyは残る。一卓の日跨ぎは1 table profileの複数day staysであり独立2卓にしない。
instance作成はscope前でもcontextとして使えるが、guest secondsは`[start,effectiveEnd)`へclipする。

### 24.3 standard market successful commitment

current `casino_market_bets`は張り直しでDELETE/置換されるためhistorical sourceには使わない。また既存rowから
inferred backfillもしない。`Markets.bet()`のfund transfer/current betと同じidempotent `runGroup`
transaction内で`casino_market_participation_history`へimmutable rowを追加する。同じoperation retryはcallbackが
再実行されずduplicate 0、validation/deadline/funding failureはtransaction全体がrollbackしてhistory 0。
commit時のmarket id/creator/mode/create/deadline/occurredAtをrestricted snapshotへ凍結する。

safe readerは`market_mode='standard'`、creator != participant、`created_at <= occurred_at < deadline_at`だけを
採用する。event Land market、stocks、self board、system/admin bookkeepingを除外。market title/options/channel/
message、amount、option、win/loss/result/profitは読まない。`user × market × JST day`でcollapseするため同日100回
rebetも1、同じboardの別日は別day、別board同日はday breadth 2。settlement/refund/voidやcurrent market削除は、
過去のsuccessful funded commitmentをretroactively消さない。payloadは
`{ days:[{date,distinctOtherStandardBoards}], distinctOtherStandardBoards }`だけ。

### 24.4 fixed snapshot / bulk / readiness

全derivedは`[start,resolvedScopeEffectiveEnd(scope))`を守る。300-user chunkでtable guest JOINとmarket historyを
bulk読みし、user/table/guest/marketごとのN+1を作らない。601 subjects（300/300/1）でsingle/bulk payload一致を
固定した。A–AM regressionsはmanifest固定、completion-only、owner/bot/fake/restart/cross-midnight/pre-scope/
deletion、standard/self/event/stocks/failure/idempotency/rebet/refund/corruption/privacyを覆う。

No.66/67 completion、No.68 commitmentは既存semanticを維持。No.69/70/71/72をREADYへ更新し、No.73は
`casino_activity_days`と`casino_market_activity_safe`が利用可能になってもrole-at-time不足でBLOCKED。
overallはREADY 63 / PARTIAL 6 / BLOCKED 22 / META 8。production threshold、BehaviorTitleDefinition、award/
notification/leaderboard/progress、historical inferred backfill、Series/Collection/Meta activation、merge/deployは行わない。
