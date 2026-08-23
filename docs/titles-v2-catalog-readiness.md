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
| READY | 19 | 現在`titleUsable:true`のsource／specialized resolverだけで、意味を落とさず表現できる |
| PARTIAL | 5 | 近い意味のsourceはあるが、意味を落とす／広げるか、semantic mismatchが安全な有効化を妨げている |
| BLOCKED | 67 | 意味的に近いものが repo に一切存在しない |
| META | 8 | kind:meta（別bucket、§7参照） |

**READY = 今すぐreleaseしてよい、ではない**。sourceReadinessとthreshold決定は
別軸（§10参照）——READY 19件も、production threshold値（分布TBD等）が
決まるまではrelease対象にならない。またSeries manifest／Collection Edition／
Meta pipelineの本番登録もこのPRでは一切行わない（§9参照）。No.58はさらに、
award後のreversalを既存immutable ownershipへどう反映するかが未決定であるため、
source-readyでもproduction release不可（§15）。

## 3. Blocker種別件数（Behavior 91件中、blockerKindsは重複計上あり）

| blockerKind | 件数 | 意味 |
| --- | --- | --- |
| missing_persisted_source | 32 | titles層へ一切昇格されていない生データ／新規persisted sourceが必要 |
| missing_derived_source | 24 | 既存safe sourceの上に新しいderived aggregate（day/share/span/distinct等）が必要 |
| missing_manifest | 9 | 「どのfamilyを対象とするか」を定義するmanifestそのものが未定義 |
| missing_role_history | 7 | role-at-time（過去のある時点でどのroleを保持していたか）がrepo全体で未実装 |
| source_semantic_mismatch | 5 | sourceが証明する事実がcatalogの意味仕様より弱い／異なる（casino分は§14、economy分は§15、event completion分は§16で解消済み） |
| missing_event_protocol | 2 | イベントデータモデル自体にorganizer/staff区別が存在しない |
| known_bug | 0 | PR F2aで`computeLastOccupant()`のsame-second/0-second visit tie bugを修正——catalog全体から解消済み（§13参照） |

（`none`のBehavior候補は19件——ちょうどREADY件数と一致。PARTIAL 5件は
すべて`source_semantic_mismatch`を持つ。）

## 4. Theme別 readiness

| Theme No | Theme | 総数 | READY | PARTIAL | BLOCKED |
| --- | --- | --- | --- | --- | --- |
| 1 | 場を起こす | 5 | 2 | 0 | 3 |
| 2 | 場を締める | 4 | 3 | 0 | 1 |
| 3 | 一対一型 | 3 | 0 | 0 | 3 |
| 4 | 少人数型 | 3 | 0 | 0 | 3 |
| 5 | 大人数型 | 3 | 0 | 0 | 3 |
| 6 | 万能型 | 3 | 0 | 0 | 3 |
| 7 | 広い交友 | 6 | 1 | 3 | 2 |
| 8 | 深い交友 | 4 | 1 | 2 | 1 |
| 9 | 時間帯・生活痕 | 6 | 0 | 0 | 6 |
| 10 | BUMP / 鐘 | 4 | 4 | 0 | 0 |
| 11 | TC交流 | 8 | 0 | 0 | 8 |
| 12 | 公開部屋 | 8 | 0 | 0 | 8 |
| 13 | Land・経済 | 8 | 1 | 0 | 7 |
| 14 | 賭場 | 8 | 3 | 0 | 5 |
| 15 | 招待 | 6 | 2 | 0 | 4 |
| 16 | イベント | 5 | 2 | 0 | 3 |
| 17 | 城横断 | 7 | 0 | 0 | 7 |

BUMP/鐘だけが100% READY（既存`bump_events`がそのまま第一級の
timestampリストを持つため）。TC交流・公開部屋・城横断は0% READY——
いずれも「titles層に一切source registrationが無い」ドメイン。

## 5. source別に残る実装（READYを支えるsource／PARTIALの制約／BLOCKEDが必要とするもの）

READYを支えている既存`titleUsable:true` source（9種、19件）:

- `vc_empty_start_then_joined`（No.1-2）
- `vc_last_occupant`（No.6, 7, 9——PR F2aでsame-second/0-second visit tie bugを修正済み、§13参照）
- `vc_social_safe`（No.22, 28 — `distinctCoPresentUsers`/`maxRepeatedDaysWithOneCounterpart`が直接使える。No.23-25は§12参照）
- `bump_events`（No.38-41、全件READY）
- `casino_activity_days`（No.68 のみ——「利用する」semanticsに限りcompletion保証不要。commitmentベースのまま維持）
- `casino_completed_activity_days`（No.66, 67——PR F2bで追加したcompletion正本、§14参照）
- `confirmed_invites`（No.74-75 のみ——`invitee_id UNIQUE`によりdistinct数が保証される）
- `economy_safe_peer_actions`（No.58——snapshot時点でreverse済みoriginalを除外、§15参照）
- `public_event_completed_participations`（No.80-81——明示staff completion正本と同一roster revisionへJOIN、§16参照）

PARTIALを止めているもの（source_semantic_mismatch、§12/§14で今回のレビューにより判定）:

- `vc_social_safe.trustedOverlapSeconds`が全counterpart合算で、特定counterpartに紐づけられない（No.29, 30）
- `vc_social_safe`が単一累積値のみで時間的分布を持たない（No.23-25）

（casino participation-vs-completion mismatchはPR F2bで解消済み——No.66/67は
READY化、No.69はmissing_manifestのみ残る。economy reversal mismatchも
PR F2cで解消済み。public event completion mismatchもPR F2dで解消済み——
No.80/81はREADY、No.82はevent-date span source不足のみ残る。§14-16参照。）

BLOCKEDが新たに必要とするもの（xlsxのSource_Map original「未実装」から、
E2/E3/E4/F2b実装後の現repoで再監査した差分）:

- **VC group-size拡張**（day-count / time-share / streak・span）—— No.10-21（12件）が単一のこの拡張だけで動く
- **`public_room_activity_safe`新設**—— No.50-57（8件、うちNo.57はrole-at-timeも必要）。Rooms自体の生データ（`rooms`/`recruits`/`oborozuki_invites`）はrichだが、titles層への昇格作業が0
- **`tc_conversation_safe`/`tc_reaction_safe`新設**—— No.42-49（8件）。`text_active_days`は「その日1回でも投稿があったか」の二値のみで、会話単位・沈黙復活・reactionのいずれも構造化されていない
- **`social_activity_time_safe`(TC+VC daypart)新設**—— No.32-37（6件）
- **`invite_retention_safe`新設**—— No.76-79（4件、うち2件はさらにnetwork-graph derivedも必要）。retentionは repo全体でgrep 0件——スタブすら無い
- **`casino_table_activity_safe`(host/guest区別)新設**—— No.70-71（2件）。casino_participationsは全参加者を対称記録——host/guest概念自体が現データモデルに存在しない
- **market/betting safe source新設**—— No.72（1件）。market/stocks系は`CASINO_ACTIVITY_KEYS`の対象外
- **economy機能family classifier拡張**—— No.61, 63（2件）
- **shop purchase safe source新設**—— No.62, 65（2件）
- **event dual-role（organizer/staff）protocol拡張**—— No.83-84（2件）。`public_events`のデータモデル自体にorganizer概念が無い
- **event_dateのsafe span source新設**—— No.82（1件）。`completedAt`はstaff attestation時刻であり実event日/spanの代用不可
- **`castle_experience_safe`新設 + 城横断manifest**—— No.85-91（7件）。grep 0件で、E3のevent infra完成待ちでもある
- **第I期core game family一覧manifest**—— No.69（1件）。completion半分はPR F2bで解消済み——残るのはmanifest未定義のみ

## 6. threshold pending

| thresholdCategory | 件数 | 意味 |
| --- | --- | --- |
| STRUCTURAL_FIXED | 16 | 意味仕様そのものから閾値が一意に確定する（例: 初回=1） |
| THRESHOLD_PENDING | 68 | 分布TBD——絶対に仮値を入れない（§10） |
| MANIFEST_DEPENDENT | 6 | manifest（family一覧・series一覧）が定まらないと閾値の土台自体が決まらない |
| STRUCTURAL_PLUS_DISTRIBUTION | 1 | 構造は決まるが、一部の値は分布依存 |
| META_NOT_APPLICABLE | 8 | meta（別contract、§10適用外） |

sourceReadinessとthresholdは別軸——READY 19件のうち、STRUCTURAL_FIXEDなのは
一部（初回系）のみで、残りはTHRESHOLD_PENDINGのままREADYになっている
（sourceは十分だが実数値は分布を見てから決める）。

## 7. 依存軸別集計

| 依存軸 | 件数 | 備考 |
| --- | --- | --- |
| role-at-time依存（`roleDependency !== "none"`） | 10 | うちrole-history欠如**単独**が原因なのは3件（No.27, 64, 73）、残りは他blockerと複合 |
| イベントtheme（Theme No.16） | 5 | No.80/81はcompletion sourceでREADY、No.82-84は依然BLOCKED |
| manifest依存（thresholdCategory: MANIFEST_DEPENDENT） | 6 | 賭場core family一覧・城横断family一覧・series一覧が未定義 |
| known bug依存 | 0 | PR F2aで`computeLastOccupant`の同秒0秒visit tie bugを修正——catalog全体から解消（§13参照） |
| source_semantic_mismatch依存 | 5 | casino分はPR F2b、economy reversalはPR F2c、event completion分（No.80-82）はPR F2dで解消——残るのはVC social breadth（No.23-25,29,30）のみ（§14-16参照） |

## 8. 次に何を実装すれば最も多くのcandidateがunblockされるか

単純なunblock件数だけでなく、安全性・基盤依存・実装順序も考慮した優先順位。
`missing_persisted_source`単独が理由の候補が27件、`missing_derived_source`
単独が21件、`source_semantic_mismatch`単独が5件——新規sourceを1つ作る、
または既存sourceのsemanticsを正すごとに複数candidateが同時に動く
「クラスタ」が明確に存在する。

> `vc_last_occupant`の同秒0秒visit tie bug修正（旧クラスタ1）は**PR F2aで
> 解消済み**（§13参照）——No.6,7,9がPARTIAL→READY。casino completed-
> participation safe signal（旧クラスタ1、F2a後の番号）も**PR F2bで
> 解消済み**（§14参照）——No.66,67がPARTIAL→READY、No.69のcompletion
> blockerも解消。economy reversed-original除外も**PR F2cで解消済み**
> （§15参照）——No.58がPARTIAL→READY。public event completion保証も
> **PR F2dで解消済み**（§16参照）——No.80/81がPARTIAL→READY、No.82は
> event-date span blockerのみ残る。以下は残っているクラスタのみを
> 優先度順に並べ直したもの。

| 優先度 | クラスタ | 解放されるcandidate数 | 理由 |
| --- | --- | --- | --- |
| 1 | VC group-size拡張（day/share/span） | 12件（No.10-21） | 既存`vc_group_size_seconds`の上に集計を足すだけ——新規persisted source不要、単一derived拡張で最大クラスタが動く |
| 2 | `vc_social_safe`にper-day counterpart breadth集計を追加 | 3件をPARTIAL→READY化（No.23,24,25）＋No.29,30の一部も前進 | クラスタ1と同じVC derived層の拡張——日別counterpart distinct集計を追加すれば複数候補が同時に前進する |
| 3 | `public_room_activity_safe`新設 | 7-8件（No.50-57） | 生データ（Rooms）は既にrich——titles層への昇格だけで完結し、他ドメインへの依存が無い独立クラスタ |
| 4 | `tc_conversation_safe`/`tc_reaction_safe`新設 | 8件（No.42-49） | TC側の会話構造化は`social_activity_time_safe`（クラスタ5）とも土台を共有するため、先に着手すると時間帯クラスタの半分も前進する |
| 5 | `social_activity_time_safe`(TC+VC)新設 | 6件（No.32-37） | クラスタ4のTC構造化と共通基盤——健康/FOMO対策でCOUNTABLE 0のまま据え置く前提は維持 |
| 6 | `invite_retention_safe`新設 | 4件（No.76-79） | 外部勧誘圧のリスクが高いドメイン（optimizationRisk: HIGH）——実装優先度はunblock数以上に安全設計のレビュー時間を要する |
| 7 | economy classifier拡張 + shop purchase source | 4件（No.61,62,63,65） | Land経済は既にE2の土台があるため増分コストが低い |
| 8 | casino table/market source新設 | 3件（No.70-72） | completion正本（F2b）はあるが、host/guestとmarketは別データモデルの新設が必要 |
| 9 | event dual-role protocol + event_date露出 | 3件（No.82-84） | `public_events`データモデル自体の拡張が必要——E3の上に直接積めない |
| 10 | role-at-time基盤 | 単独3件＋複合7件＝最大10件 | 波及範囲は大きいが、role権限・処罰系roleを含むため設計難度と慎重さが最も高い——単純unblock数で最優先にしない |
| 11 | 第I期core game family一覧manifest | 1件（No.69） | completion半分はPR F2bで解消済み——残るのはmanifest策定のみ。他の賭場manifest系（castle_experience等）と合わせて検討してよい |
| 12 | `castle_experience_safe` + 城横断manifest | 7件（No.85-91） | 他の**すべてのドメインsourceが先に揃っている必要がある**——最後に着手するのが自然（event infra完成待ちでもある、Summary判断#8） |

event completion mismatchはF2dで解消した。次は、単一derived拡張で
最大12件を動かせるクラスタ1のVC group-size day/share/span拡張へ
進むのが自然。F2a/F2b/F2c/F2dで既存sourceの正確性・semantic debtを
先に減らしてきた方針を維持しつつ、ここから大きいVC/TC/roomクラスタへ移る。

## 9. editorial intent → runtime resolution（契約の食い違いの明示）

xlsxはconcept/editorial正本であり、runtime契約そのものではない。以下は
xlsx上の記述と、現在のruntime契約が食い違う箇所——本PRではruntime契約自体を
変えない。

| xlsx上の記述 | 現runtime契約 | 差分の扱い |
| --- | --- | --- |
| Meta（No.92-99）のScope列: `catalog` | `MetaTitleDefinition`はruntimeでは常にglobal scope（catalogスコープの概念を持たない） | このPRでは変更しない。将来Meta titleを実際に登録する際に解決する |
| Meta（No.92-99）のSeries/Stage: `collection_meta` stage 1..7 | `MetaTitleDefinition`はprogressionを持たない（`v2-contract.ts`の型契約） | xlsx上のstageは**editorial orderingとしてのみ**候補データに保持する（`v2-catalog-candidates.ts`の`stage`フィールド）。Meta titleをBehavior progressionへ無理に押し込まない |
| 賭場・招待・時間帯・role-aware・generic eventも「REQUIRED」（Full-clear Manifest Contract） | 本PRではfull-clear editionそのものを一切activateしない | REQUIRED表記はcandidate上の**将来の意図**の記録であり、今すぐeditionに組み込まれるという意味ではない（§13参照） |
| casino No.66/67/69の「正常完了する」 | ~~`casino_activity_days`はsuccessful funded participation commitmentまでしか証明しない~~ → **PR F2bで解消**: `casino_completed_activity_days`がcanonical financial resolution primitive成功後にのみ書かれるcompletion正本として追加された（§14） | catalog側semanticsは変更していない——source側にcompletion保証を追加する形で解決した。No.69はmanifest未定義のみ残る |
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
- role-at-time・TC canonical conversation・public room safe source・castle_experience・invite retention・casino table/market・economy classifier・event dual-role protocol等の新規実装
- 第I期casino core-family manifestの策定・No.69のREADY化
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

### 12.3 VC social breadthの時間的分布欠如（No.23, 24, 25: READY → PARTIAL）

`vc_social_safe`のpayloadは`distinctCoPresentUsers`/
`maxRepeatedDaysWithOneCounterpart`/`trustedOverlapSeconds`という
scope window全体の**単一累積値**のみ。counterexample: day1に100人と
co-presenceが成立し、day2〜30はAlice1人だけと会った場合でも、
`distinctCoPresentUsers`は大きいまま計算できる——しかし「より広い異なる
相手との交流が、複数日に広がる」（No.23）「十分な期間にわたり...続く」
（No.24）「長期・多数日にわたり」（No.25）という**時間的持続性**は
証明できない。No.22「顔馴染み」は時間的な広がりを要求しない
（「成立する」であって「広がる/続く」ではない）ためREADYのまま維持した。

PR #164時点でのfollow-up（casino participation-vs-completion・economy
reversal・VC social breadth per-day・`vc_last_occupant` tie bug・VC
group-size拡張）はPR #164自体では実施しない——記録のみ。このうち
`vc_last_occupant`のtie bugはその後PR F2aで（§13）、casino
participation-vs-completionはPR F2bで（§14）、economy reversalはPR F2cで
（§15）解消した——残りは§8の
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
