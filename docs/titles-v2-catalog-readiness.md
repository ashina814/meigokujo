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
| PARTIAL | 5 | 近い意味のsourceはあるが、意味を落とす／広げるか、既知バグが安全な有効化を妨げている |
| BLOCKED | 67 | 意味的に近いものが repo に一切存在しない |
| META | 8 | kind:meta（別bucket、§7参照） |

**READY = 今すぐreleaseしてよい、ではない**。sourceReadinessとthreshold決定は
別軸（§10参照）——READY 19件も、production threshold値（分布TBD等）が
決まるまではrelease対象にならない。またSeries manifest／Collection Edition／
Meta pipelineの本番登録もこのPRでは一切行わない（§9参照）。

## 3. Blocker種別件数（Behavior 91件中、blockerKindsは重複計上あり）

| blockerKind | 件数 | 意味 |
| --- | --- | --- |
| missing_persisted_source | 32 | titles層へ一切昇格されていない生データ／新規persisted sourceが必要 |
| missing_derived_source | 24 | 既存safe sourceの上に新しいderived aggregate（day/share/span/distinct等）が必要 |
| missing_manifest | 9 | 「どのfamilyを対象とするか」を定義するmanifestそのものが未定義 |
| missing_role_history | 7 | role-at-time（過去のある時点でどのroleを保持していたか）がrepo全体で未実装 |
| known_bug | 4 | source自体は意味的に十分だが、既知の正確性バグ（同秒0秒visit tie等）が未修正 |
| missing_event_protocol | 2 | イベントデータモデル自体にorganizer/staff区別が存在しない |
| source_semantic_mismatch | 2 | 集約値はあるが、必要な粒度（特定counterpart単位等）に分解できない |

（`none`のBehavior候補は19件——ちょうどREADY件数と一致。PARTIAL 5件は
`known_bug`または`source_semantic_mismatch`のいずれかを持つ。）

## 4. Theme別 readiness

| Theme No | Theme | 総数 | READY | PARTIAL | BLOCKED |
| --- | --- | --- | --- | --- | --- |
| 1 | 場を起こす | 5 | 2 | 0 | 3 |
| 2 | 場を締める | 4 | 0 | 3 | 1 |
| 3 | 一対一型 | 3 | 0 | 0 | 3 |
| 4 | 少人数型 | 3 | 0 | 0 | 3 |
| 5 | 大人数型 | 3 | 0 | 0 | 3 |
| 6 | 万能型 | 3 | 0 | 0 | 3 |
| 7 | 広い交友 | 6 | 4 | 0 | 2 |
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

READYを支えている既存`titleUsable:true` source（6種）:

- `vc_empty_start_then_joined`（No.1-2）
- `vc_social_safe`（No.22-25, 28 — `distinctCoPresentUsers`/`maxRepeatedDaysWithOneCounterpart`が直接使える）
- `bump_events`（No.38-41、全件READY）
- `economy_safe_peer_actions`（No.58 のみ——tip単発の初回検知だけ）
- `casino_activity_days`（No.66-68 のみ——breadth/day集計まで）
- `confirmed_invites`（No.74-75 のみ——`invitee_id UNIQUE`によりdistinct数が保証される）

PARTIALを止めているもの:

- `vc_last_occupant`のsame-second/0-second visit tie bug（No.6, 7, 9——xlsx Blocker欄の記載どおり、未修正）
- `vc_social_safe.trustedOverlapSeconds`が全counterpart合算で、特定counterpartに紐づけられない（No.29, 30）

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
- **event_dateのsafe payload露出**—— No.82（1件）。`recordedAt`はroster確定時刻であって実event日ではない
- **`castle_experience_safe`新設 + 城横断manifest**—— No.85-91（7件）。grep 0件で、E3のevent infra完成待ちでもある

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
| イベントtheme（Theme No.16） | 5 | 全件BLOCKED——dual-role protocol拡張とevent_date露出が必要 |
| manifest依存（thresholdCategory: MANIFEST_DEPENDENT） | 6 | 賭場core family一覧・城横断family一覧・series一覧が未定義 |
| known bug依存 | 4 | `computeLastOccupant`の同秒0秒visit tie bug（本PRでは修正しない、production前提として記録のみ） |

## 8. 次に何を実装すれば最も多くのcandidateがunblockされるか

単純なunblock件数だけでなく、安全性・基盤依存・実装順序も考慮した優先順位。
`missing_persisted_source`単独が理由の候補が28件、`missing_derived_source`
単独が20件——新規sourceを1つ作るごとに複数candidateが同時に動く「クラスタ」が
明確に存在する。

| 優先度 | クラスタ | 解放されるcandidate数 | 理由 |
| --- | --- | --- | --- |
| 1 | `vc_last_occupant`の同秒0秒visit tie bug修正 | 3件を PARTIAL→READY化（No.6,7,9） | 新規開発ではなく**既存の正確性バグ修正**。最小コストで最初にやるべき土台整備（Summary判断#9でも「production前提」と明記済み） |
| 2 | VC group-size拡張（day/share/span） | 12件（No.10-21） | 既存`vc_group_size_seconds`の上に集計を足すだけ——新規persisted source不要、単一derived拡張で最大クラスタが動く |
| 3 | `public_room_activity_safe`新設 | 7-8件（No.50-57） | 生データ（Rooms）は既にrich——titles層への昇格だけで完結し、他ドメインへの依存が無い独立クラスタ |
| 4 | `tc_conversation_safe`/`tc_reaction_safe`新設 | 8件（No.42-49） | TC側の会話構造化は`social_activity_time_safe`（クラスタ5）とも土台を共有するため、先に着手すると時間帯クラスタの半分も前進する |
| 5 | `social_activity_time_safe`(TC+VC)新設 | 6件（No.32-37） | クラスタ4のTC構造化と共通基盤——健康/FOMO対策でCOUNTABLE 0のまま据え置く前提は維持 |
| 6 | `invite_retention_safe`新設 | 4件（No.76-79） | 外部勧誘圧のリスクが高いドメイン（optimizationRisk: HIGH）——実装優先度はunblock数以上に安全設計のレビュー時間を要する |
| 7 | economy classifier拡張 + shop purchase source | 4件（No.61,62,63,65） | Land経済は既にE2の土台があるため増分コストが低い |
| 8 | casino table/market source新設 | 3件（No.70-72） | E4の土台（casino_activity_days）はあるが、host/guestとmarketは別データモデルの新設が必要 |
| 9 | event dual-role protocol + event_date露出 | 3件（No.82-84） | `public_events`データモデル自体の拡張が必要——E3の上に直接積めない |
| 10 | role-at-time基盤 | 単独3件＋複合7件＝最大10件 | 波及範囲は大きいが、role権限・処罰系roleを含むため設計難度と慎重さが最も高い——単純unblock数で最優先にしない |
| 11 | `castle_experience_safe` + 城横断manifest | 7件（No.85-91） | 他の**すべてのドメインsourceが先に揃っている必要がある**——最後に着手するのが自然（event infra完成待ちでもある、Summary判断#8） |

優先度10（role-at-time）はunblock件数だけ見れば大きいが、「権限・相談・処罰系
roleはsource禁止/条件付き」（xlsx Source_Map）という制約があり、実装の
慎重さが求められるため、クラスタ2-5（既存sourceの直接拡張・独立ドメイン）を
先に進める方が全体のvelocityとして合理的——これは本docの推奨順であり、
実際の着手順はfollow-up PRごとに再検討してよい。

## 9. editorial intent → runtime resolution（契約の食い違いの明示）

xlsxはconcept/editorial正本であり、runtime契約そのものではない。以下は
xlsx上の記述と、現在のruntime契約が食い違う箇所——本PRではruntime契約自体を
変えない。

| xlsx上の記述 | 現runtime契約 | 差分の扱い |
| --- | --- | --- |
| Meta（No.92-99）のScope列: `catalog` | `MetaTitleDefinition`はruntimeでは常にglobal scope（catalogスコープの概念を持たない） | このPRでは変更しない。将来Meta titleを実際に登録する際に解決する |
| Meta（No.92-99）のSeries/Stage: `collection_meta` stage 1..7 | `MetaTitleDefinition`はprogressionを持たない（`v2-contract.ts`の型契約） | xlsx上のstageは**editorial orderingとしてのみ**候補データに保持する（`v2-catalog-candidates.ts`の`stage`フィールド）。Meta titleをBehavior progressionへ無理に押し込まない |
| 賭場・招待・時間帯・role-aware・generic eventも「REQUIRED」（Full-clear Manifest Contract） | 本PRではfull-clear editionそのものを一切activateしない | REQUIRED表記はcandidate上の**将来の意図**の記録であり、今すぐeditionに組み込まれるという意味ではない（§13参照） |

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
- role-at-time・TC canonical conversation・public room safe source・castle_experience等の新規実装
- `vc_last_occupant`の同秒0秒visit tie bug修正
- Behavior evaluatorのproduction wiring
