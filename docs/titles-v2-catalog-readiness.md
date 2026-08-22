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
| READY | 14 | 現在`titleUsable:true`のsource／specialized resolverだけで、意味を落とさず表現できる |
| PARTIAL | 10 | 近い意味のsourceはあるが、意味を落とす／広げるか、semantic mismatchが安全な有効化を妨げている |
| BLOCKED | 67 | 意味的に近いものが repo に一切存在しない |
| META | 8 | kind:meta（別bucket、§7参照） |

**READY = 今すぐreleaseしてよい、ではない**。sourceReadinessとthreshold決定は
別軸（§10参照）——READY 14件も、production threshold値（分布TBD等）が
決まるまではrelease対象にならない。またSeries manifest／Collection Edition／
Meta pipelineの本番登録もこのPRでは一切行わない（§9参照）。

## 3. Blocker種別件数（Behavior 91件中、blockerKindsは重複計上あり）

| blockerKind | 件数 | 意味 |
| --- | --- | --- |
| missing_persisted_source | 32 | titles層へ一切昇格されていない生データ／新規persisted sourceが必要 |
| missing_derived_source | 24 | 既存safe sourceの上に新しいderived aggregate（day/share/span/distinct等）が必要 |
| missing_manifest | 9 | 「どのfamilyを対象とするか」を定義するmanifestそのものが未定義 |
| missing_role_history | 7 | role-at-time（過去のある時点でどのroleを保持していたか）がrepo全体で未実装 |
| source_semantic_mismatch | 12 | sourceが証明する事実がcatalogの意味仕様より弱い／異なる（§12参照） |
| missing_event_protocol | 2 | イベントデータモデル自体にorganizer/staff区別が存在しない |
| known_bug | 0 | PR F2aで`computeLastOccupant()`のsame-second/0-second visit tie bugを修正——catalog全体から解消済み（§13参照） |

（`none`のBehavior候補は14件——ちょうどREADY件数と一致。PARTIAL 10件は
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
| 13 | Land・経済 | 8 | 0 | 1 | 7 |
| 14 | 賭場 | 8 | 1 | 2 | 5 |
| 15 | 招待 | 6 | 2 | 0 | 4 |
| 16 | イベント | 5 | 0 | 2 | 3 |
| 17 | 城横断 | 7 | 0 | 0 | 7 |

BUMP/鐘だけが100% READY（既存`bump_events`がそのまま第一級の
timestampリストを持つため）。TC交流・公開部屋・城横断は0% READY——
いずれも「titles層に一切source registrationが無い」ドメイン。

## 5. source別に残る実装（READYを支えるsource／PARTIALの制約／BLOCKEDが必要とするもの）

READYを支えている既存`titleUsable:true` source（7種、14件）:

- `vc_empty_start_then_joined`（No.1-2）
- `vc_last_occupant`（No.6, 7, 9——PR F2aでsame-second/0-second visit tie bugを修正済み、§13参照）
- `vc_social_safe`（No.22, 28 — `distinctCoPresentUsers`/`maxRepeatedDaysWithOneCounterpart`が直接使える。No.23-25は§12参照）
- `bump_events`（No.38-41、全件READY）
- `casino_activity_days`（No.68 のみ——「利用する」semanticsに限りcompletion保証不要。No.66/67は§12参照）
- `confirmed_invites`（No.74-75 のみ——`invitee_id UNIQUE`によりdistinct数が保証される）

PARTIALを止めているもの（source_semantic_mismatch、§12で今回のレビューにより新規判定）:

- `vc_social_safe.trustedOverlapSeconds`が全counterpart合算で、特定counterpartに紐づけられない（No.29, 30）
- `vc_social_safe`が単一累積値のみで時間的分布を持たない（No.23-25）
- `casino_activity_days`がsuccessful funded participation commitmentしか証明せずcompleted gameを証明しない（No.66, 67, 69）
- `economy_safe_peer_actions`がreversal済みoriginal factを消さない（No.58）
- `public_events`にstatus/lifecycle列が無くevent completedを保証できない（No.80, 81, 82）

BLOCKEDが新たに必要とするもの（xlsxのSource_Map original「未実装」から、
E2/E3/E4実装後の現repoで再監査した差分）:

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
- **event_dateのsafe payload露出**—— No.82（1件、completion保証欠如とも複合）
- **`castle_experience_safe`新設 + 城横断manifest**—— No.85-91（7件）。grep 0件で、E3のevent infra完成待ちでもある

## 6. threshold pending

| thresholdCategory | 件数 | 意味 |
| --- | --- | --- |
| STRUCTURAL_FIXED | 16 | 意味仕様そのものから閾値が一意に確定する（例: 初回=1） |
| THRESHOLD_PENDING | 68 | 分布TBD——絶対に仮値を入れない（§10） |
| MANIFEST_DEPENDENT | 6 | manifest（family一覧・series一覧）が定まらないと閾値の土台自体が決まらない |
| STRUCTURAL_PLUS_DISTRIBUTION | 1 | 構造は決まるが、一部の値は分布依存 |
| META_NOT_APPLICABLE | 8 | meta（別contract、§10適用外） |

sourceReadinessとthresholdは別軸——READY 11件のうち、STRUCTURAL_FIXEDなのは
一部（初回系）のみで、残りはTHRESHOLD_PENDINGのままREADYになっている
（sourceは十分だが実数値は分布を見てから決める）。

## 7. 依存軸別集計

| 依存軸 | 件数 | 備考 |
| --- | --- | --- |
| role-at-time依存（`roleDependency !== "none"`） | 10 | うちrole-history欠如**単独**が原因なのは3件（No.27, 64, 73）、残りは他blockerと複合 |
| イベントtheme（Theme No.16） | 5 | 全件PARTIAL/BLOCKED——No.80/81はcompletion保証欠如でPARTIAL、No.82-84は依然BLOCKED |
| manifest依存（thresholdCategory: MANIFEST_DEPENDENT） | 6 | 賭場core family一覧・城横断family一覧・series一覧が未定義 |
| known bug依存 | 0 | PR F2aで`computeLastOccupant`の同秒0秒visit tie bugを修正——catalog全体から解消（§13参照） |
| source_semantic_mismatch依存 | 12 | §12参照。今回のレビューで新規に確定 |

## 8. 次に何を実装すれば最も多くのcandidateがunblockされるか

単純なunblock件数だけでなく、安全性・基盤依存・実装順序も考慮した優先順位。
`missing_persisted_source`単独が理由の候補が27件、`missing_derived_source`
単独が20件、`source_semantic_mismatch`単独が10件——新規sourceを1つ作る、
または既存sourceのsemanticsを正すごとに複数candidateが同時に動く
「クラスタ」が明確に存在する。

> `vc_last_occupant`の同秒0秒visit tie bug修正（旧クラスタ1）は**PR F2aで
> 解消済み**（§13参照）——No.6,7,9がPARTIAL→READY。以下は残っている
> クラスタのみを優先度順に並べ直したもの。

| 優先度 | クラスタ | 解放されるcandidate数 | 理由 |
| --- | --- | --- | --- |
| 1 | casino completed-participation safe signal / source semantics（そのparticipationが実際にsettled/completedしたことを安全に証明できるimmutable signal——例: committed-participationとcompleted-participationを別factに分ける、成功完了後にのみ書くimmutable completion marker、または同等のsafe derived completion source） | 2件をPARTIAL→READY化（No.66,67）＋No.69のcompletion blockerを解消 | 現在のmismatchが特に目立つのはsolo/PVPで異なるwriter位置を持つため——solo 7種目は`settleSolo()`成功後に書くためcompletion=participationが成立するが、PVP経路（pvp-accept.ts等）はrunner実行前にwriterが発火する。ただし**solo/PVPのmode区別そのものは修正にならない**——両モードとも安全に「completed」を証明できるsignal/semantics自体が無いことが本質的な欠如であり、単にどちらの経路で書かれたかを区別するflagを足すだけでは、PVP側が引き続き未完了のfactを生成し得る問題は解決しない。**現時点での次の未解決優先度トップ** |
| 2 | `economy_safe_peer_actions`にreversed-original除外ロジックを追加 | 1件をPARTIAL→READY化（No.58） | reversal_of追跡だけの小さい拡張——既存E2の安全設計は変えない |
| 3 | `public_events`へのevent completion保証（status列 or 運用contractの明文化＋evidence） | 2件をPARTIAL→READY化（No.80,81） | コード変更が最小で済む可能性がある（例えば「recordFinalizedEventは必ずevent終了後に呼ぶ」という運用contractをdocs化しevidenceとして採用する設計判断でも解決し得る） |
| 4 | VC group-size拡張（day/share/span） | 12件（No.10-21） | 既存`vc_group_size_seconds`の上に集計を足すだけ——新規persisted source不要、単一derived拡張で最大クラスタが動く |
| 5 | `vc_social_safe`にper-day counterpart breadth集計を追加 | 3件をPARTIAL→READY化（No.23,24,25）＋No.29,30の一部も前進 | クラスタ4と同じVC derived層の拡張——日別counterpart distinct集計を追加すれば複数候補が同時に前進する |
| 6 | `public_room_activity_safe`新設 | 7-8件（No.50-57） | 生データ（Rooms）は既にrich——titles層への昇格だけで完結し、他ドメインへの依存が無い独立クラスタ |
| 7 | `tc_conversation_safe`/`tc_reaction_safe`新設 | 8件（No.42-49） | TC側の会話構造化は`social_activity_time_safe`（クラスタ8）とも土台を共有するため、先に着手すると時間帯クラスタの半分も前進する |
| 8 | `social_activity_time_safe`(TC+VC)新設 | 6件（No.32-37） | クラスタ7のTC構造化と共通基盤——健康/FOMO対策でCOUNTABLE 0のまま据え置く前提は維持 |
| 9 | `invite_retention_safe`新設 | 4件（No.76-79） | 外部勧誘圧のリスクが高いドメイン（optimizationRisk: HIGH）——実装優先度はunblock数以上に安全設計のレビュー時間を要する |
| 10 | economy classifier拡張 + shop purchase source | 4件（No.61,62,63,65） | Land経済は既にE2の土台があるため増分コストが低い |
| 11 | casino table/market source新設 | 3件（No.70-72） | E4の土台（casino_activity_days）はあるが、host/guestとmarketは別データモデルの新設が必要 |
| 12 | event dual-role protocol + event_date露出 | 3件（No.82-84） | `public_events`データモデル自体の拡張が必要——E3の上に直接積めない |
| 13 | role-at-time基盤 | 単独3件＋複合7件＝最大10件 | 波及範囲は大きいが、role権限・処罰系roleを含むため設計難度と慎重さが最も高い——単純unblock数で最優先にしない |
| 14 | `castle_experience_safe` + 城横断manifest | 7件（No.85-91） | 他の**すべてのドメインsourceが先に揃っている必要がある**——最後に着手するのが自然（event infra完成待ちでもある、Summary判断#8） |

クラスタ1〜3（casino/economy/eventのsemantic mismatch解消）は、新規source
追加ではなく既存sourceへの**小さな追加保証**で済む可能性が高いため、
unblock件数自体は小さくてもコストは低い——PR F2aで解消したtie bugと合わせて
「まず正確性・semantics面の負債を解消してから、次に大きいVC/TC/roomクラスタへ
進む」という順序が合理的。

## 9. editorial intent → runtime resolution（契約の食い違いの明示）

xlsxはconcept/editorial正本であり、runtime契約そのものではない。以下は
xlsx上の記述と、現在のruntime契約が食い違う箇所——本PRではruntime契約自体を
変えない。

| xlsx上の記述 | 現runtime契約 | 差分の扱い |
| --- | --- | --- |
| Meta（No.92-99）のScope列: `catalog` | `MetaTitleDefinition`はruntimeでは常にglobal scope（catalogスコープの概念を持たない） | このPRでは変更しない。将来Meta titleを実際に登録する際に解決する |
| Meta（No.92-99）のSeries/Stage: `collection_meta` stage 1..7 | `MetaTitleDefinition`はprogressionを持たない（`v2-contract.ts`の型契約） | xlsx上のstageは**editorial orderingとしてのみ**候補データに保持する（`v2-catalog-candidates.ts`の`stage`フィールド）。Meta titleをBehavior progressionへ無理に押し込まない |
| 賭場・招待・時間帯・role-aware・generic eventも「REQUIRED」（Full-clear Manifest Contract） | 本PRではfull-clear editionそのものを一切activateしない | REQUIRED表記はcandidate上の**将来の意図**の記録であり、今すぐeditionに組み込まれるという意味ではない（§13参照） |
| casino No.66/67/69の「正常完了する」 | `casino_activity_days`はsuccessful funded participation commitmentまでしか証明しない（§12） | catalog側semanticsは変更しない。source側にcompletion保証を追加する（follow-up、§8クラスタ1）か、catalog側の意味を正式に見直すかは将来判断 |
| economy No.58の「reversal済取引は無効」 | `economy_safe_peer_actions`はreversalされたoriginal factを消さない（§12） | catalog側semanticsは変更しない。sourceへreversed-original除外を追加する（follow-up、§8クラスタ2） |
| event No.80/81の「completed公式イベント」 | `public_events`にlifecycle/status列が無く、コードレベルでcompletion保証を持たない（§12） | catalog側semanticsは変更しない。運用contract（staffは必ず終了後に記録する）の明文化＋evidence追加、またはstatus列追加のどちらで解決するかは将来判断 |

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
- role-at-time・TC canonical conversation・public room safe source・castle_experience・invite retention・casino table/market・economy classifier・event dual-role protocol・completion保証追加等の新規実装
- Behavior evaluatorのproduction wiring

（`vc_last_occupant`の同秒0秒visit tie bug修正はPR F2aで実施済み——§13参照。）

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

### 12.2 economy reversal semantics（No.58: READY → PARTIAL）

xlsx Blocker欄「reversal済取引は無効」に対し、
`computeSafeEconomyPeerActions()`のコード自身のコメント（§18-19）が
明示するとおり、現E2契約は「reversal transaction自体はfactを作らない
——元actionのfactはreversalの有無に関わらず消えない」。つまり後から
reversalされたtipでも「初回tip」factは残ったまま。catalog側semanticsを
現sourceへ合わせて書き換えることはせず、source側の限界として記録した。

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

すべてのfollow-up（§8クラスタ1〜5）はPR #164では実施しない——記録のみ。
このうちクラスタ1（`vc_last_occupant`のtie bug）はその後PR F2aで解消した
（§13）。

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
