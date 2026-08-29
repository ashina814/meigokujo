# 冥界商館 状態モデルと authority

Phase C〜H で積み上げた安全機構の**意味・authority・遷移**をここに集める。
`service.ts` を数千行たどらずに、次の問いへ答えられることを目的とする。

- この購入はいま何状態か
- なぜ返金できないのか
- なぜ失効しないのか
- 次に誰が触るのか
- 何が authority なのか

読み取り口は `Shop.safetySnapshot(purchaseId)`。**新しい判定はそこで作っていない**。
どの欄も既存の authority を呼んだ結果で、一覧SQL・巡回・運営操作と食い違わないことが
唯一の存在意義。

**snapshot は1つの一貫した読みから作る。** 9本のSELECTを素直に順番へ並べると、
最初の purchase を読んだあとに別接続が commit した場合、「古い purchase 行 ＋
新しい claim / 返金 / 決着」という**一度も存在しなかった状態**を返せてしまう。
運営と監査へ事実を説明する土台なので、資産を動かさなくても不正確な説明は許されない。
DEFERRED で始めるため読み取りのために書き込みロックは取らず、既に transaction の
中ならその snapshot をそのまま使う。

---

## 1. 状態は1本のenumではない

現在の状態は**互いに直交する複数の事実**からできている。同じ `active` でも、

| 契約 | 提供 | 返金の復旧 | 期限 | 意味 |
|---|---|---|---|---|
| active | delivered | closed | 未来 | 正常 |
| active | failed | open | 超過 | 金を返せておらず、失効も止めている |

はまったく別物になる。1本の `ShopState` へ潰すと、この違いが消える。
正本は **durable な事実のベクタ** ＋ **そこから導く運用上の意味**。

---

## 2. State dimensions

### 契約（Purchase contract）

| 事実 | 置き場所 |
|---|---|
| 有効か | `shop_purchases.status` = `active` / `expired` / `refunded` / `cancelled` |
| 期限 | `shop_purchases.expires_at`（NULL は無期限） |
| 支払 | `paid_land` / `paid_alt_kind` / `paid_alt_amount` |

### 提供（Fulfillment）

| 事実 | 置き場所 | 強さ |
|---|---|---|
| 配送の経過 | `delivery_state` = `pending` / `failed` / `delivered` | **証拠ではない**（移行時の既定値がある） |
| 配送時刻 | `delivered_at` | 証拠 |
| 配送方式のスナップショット | `delivery_snapshot_json` | 「そのつもりだった」の証拠。成功の証拠ではない |
| 購入時 provenance | `shop_purchase_fulfillment_provenance` | 「今のコードが作った購入」 |
| ロール付与 provenance | `shop_purchase_role_grant_provenance` | 何のロールを与える契約だったか |
| **提供済みか** | `DELIVERED_EVIDENCE_SQL` / `hasDeliveredEvidence()` | **authoritative** |

`DELIVERED_EVIDENCE_SQL` は `delivered_at IS NOT NULL` **or** `shop_delivered` event
**or**（provenance あり かつ `delivery_state='delivered'`）。
1件判定はこの定義をそのまま評価する（`DELIVERED_EVIDENCE_ROW_SQL`）ので、
一覧と個別判定が食い違わない。

### 外部副作用（External delivery claim）

`shop_external_delivery_attempts`。1 purchase につき**同時に生きている claim は1つ**
（部分ユニーク索引でDBが縛る）。

| state | 意味 | 返金 | 失効 | 再配送 |
|---|---|---|---|---|
| `in_flight` | いま外部へ投げている | 不可 | 不可 | 不可 |
| `uncertain` | 投げたが結果が分からない | 不可 | 不可 | 不可 |
| `settled` | 提供できたと確定した | — | 可 | 不要 |
| `released` | 副作用が無いと確認して手放した | 可 | 可 | 可 |

生きている状態の集合は `EXTERNAL_CLAIM_LIVE_STATES` が唯一の定義で、
**Core の query・UPDATE の条件・候補選択・DBの部分ユニーク索引がすべてここから導かれる。**

索引 `uq_shop_external_delivery_open`（1 purchase につき生きた claim は1件）は
DDL 生成時にこの定義を埋め込む。手で書き写すと、Coreが「生きている」と見なす集合と
DBが1件に縛る集合が将来ズレて、Coreは止めているつもりなのにDBは重複を許す（またはその逆）
という穴が開く。

> **⚠ 集合を変えるときは migration が要る。**
> 索引はDBに焼き付くので、定数を書き換えただけでは既存DBの索引は古い集合のまま残る。
> 新しい live state を足す／既存の state を live から外す場合は、
> `DROP INDEX` → `CREATE UNIQUE INDEX` を伴う migration を書くこと。
> 定義とDBの一致は `shop-claim-live-states.test.ts` が fresh DB で固定している。

### 返金（Refund）

**「履歴」と「いま復旧待ちか」を混ぜない。**

| 問い | 正本 |
|---|---|
| 返金に失敗したことがあるか | `refundFailureHistorySql()`（`shop_refund_failures` に行がある） |
| **いま返金のやり直しキューに載っているか** | `refundFailureSql()` = `active` かつ `delivered_at IS NULL` かつ delivered evidence なし かつ 履歴あり |

履歴は append-only なので消えない。

> **⚠ `refundFailureSql()` は「返す義務が無い」ことの証明ではない。**
>
> これは **いま復旧導線に載っているか**（`recoveryOpen`）であって、普遍的な
> financial truth ではない。`status='active'` を条件に含むので、terminal な購入では
> 常に false になる——`refund()` が active からしか動けないため、復旧導線に載せても
> 意味が無いからそうなっている。
>
> したがって `false` を「利用者へ返す義務が存在しない」と一般化してはいけない。

購入が `refunded` になれば金は戻っている。`expired` / `cancelled` になっただけでは
**戻ったことは証明されない**——復旧キューから落ちるだけで、事実は変わらない。
この組み合わせは §6 の terminal anomaly として surface する。

### 人の判断（Human authority）

`shop_operator_resolutions`（append-only）。

| decision | 意味 | 状態を動かすか |
|---|---|---|
| `delivered` | 提供済みだと確認した | 動かす（決着） |
| `no_effect` | 提供されていないと確認した | 動かす（返金・再試行へ進める） |
| `still_unknown` | まだ判断できない | **1つも動かさない** |

`delivered` / `no_effect` には**根拠（note）が必須**。空文字・空白だけは拒否する。

### 期限と剥奪（Expiry / revocation）

| 問い | 正本 |
|---|---|
| 失効させてよいか | `expireIfDue()`。止める理由は `expiryBlockedBy()` |
| 候補に入れてよいか | `expireOverdue()` の候補SQL（`expiryBlockedBy()` と**同じ述語から組む**） |
| ロールを剥がしてよいか | `roleGrantTarget()`（何を与える契約だったか）＋ delivered evidence（実際に与えたか） |

剥奪キュー `shop_role_revocations` の `status`:

| status | 意味 | 誰が触る |
|---|---|---|
| `pending` | 剥がす予定 | 巡回（worker） |
| `done` | 剥がし終わった | — |
| `failed` | 剥がせなかった（権限不足など） | **運営**（商館スタッフでは authority 不足） |

---

## 3. Authority map

| 問い | authority |
|---|---|
| 購入が有効か | `shop_purchases.status` |
| 外部配送が進行中／不明か | live external claim（`EXTERNAL_CLAIM_LIVE_STATES`。Core と DB索引で共有） |
| 提供済みか | `DELIVERED_EVIDENCE_SQL` / `hasDeliveredEvidence()` |
| いま返金のやり直しキューに載っているか | `refundFailureSql()` / `refundFailureOpen()` |
| 利用者へ返す義務が本当に無いか | **単一の述語では答えられない**。`refunded` が唯一の「戻った」証拠で、terminal anomaly は監査対象として surface する |
| 一度でも返金に失敗したか | `refundFailureHistorySql()` |
| legacy の「提供なし」を誰が証明できるか | `shop_operator_resolutions` の `no_effect`（人が外部を見た事実） |
| この決着がどの claim を閉じるのか | `settleVerifiedFailure()` に渡す claim token |
| 期限切れにしてよいか | `expireIfDue()`（最終）／`expiryBlockedBy()`（理由） |
| ロールを剥がしてよいか | `roleGrantTarget()` ＋ delivered evidence |
| いま有効な契約がそのロールを守っているか | `activePurchaseProvesRoleEntitlement()` |
| 運営が今やる仕事か | 各キューの述語（§5） |

### unknown を何へも自動変換しない

- 「確認できなかった」を「外れた」に倒さない
- 「結末が分からない旧購入」を `delivered` とも `failed` とも書かない
- 現在の商品設定から、過去の購入が何を配ったかを推測しない
- `still_unknown` は状態を動かさない

分からないものは**分からないまま止める**。動かす根拠は、人が外部を見て残した事実だけ。

---

## 4. Transition map

書式は `現在状態 → authority → mutation → durable result → 再起動後の入口`。

### 購入

```
（在庫・価格・条件を満たす）
→ termsToken（表示した条件と一致するか）
→ 支払 + purchase 行 + provenance
→ status=active
→ 通常の購入履歴
```

### 外部配送が成功する

```
active + 未提供
→ claimExternalDelivery（durable に場所を取る）
→ Discord へ副作用
→ 付いたことを確認できた
→ claim=settled + delivered_at + shop_delivered
→ 仕事なし
```

### 副作用が無いと確認できた失敗

```
claim 保持中
→ 外部に副作用が無いことを確認（3状態の presence 確認）
→ settleVerifiedFailure（claim解放・配送失敗確定・返金 or 義務記録を1 transaction）
→ refunded  … status=refunded
   または   … 返金の義務が durable に残る（status=active のまま。復旧待ちへ）
→ 前者は仕事なし／後者は「返金をやり直す」キュー
```

**この間、守りが外れていて未返金の瞬間は存在しない。**
別接続から観測できるのは「claim保持」「返金済み」「義務あり」の3つだけ。

### 結果が分からない

```
claim 保持中
→ 外部の結果を確認できない
→ claim=uncertain（sticky。付け忘れたら release、にはしない）
→ 返金も失効も再配送も止まる
→ 「提供状況を確認する」キュー
```

### 運営の決着

```
uncertain / legacy unknown
→ 人が外部を見る + 根拠を書く
→ delivered   … 提供済みとして確定（返金しない）
   no_effect  … 提供なしとして確定（返金 or 再試行へ）
   still_unknown … 1つも動かさない
→ shop_operator_resolutions へ append（判断・根拠・前後の状態・結果）
→ 決着したものは「不明」へ戻らない
```

古い画面からの決定は通らない（`ERR_RESOLUTION_STALE`、0 mutation）。

### 返金のやり直し

```
返金の復旧待ち（recoveryOpen）
→ 運営が「返金をやり直す」
→ refunded            … 復旧完了（金が戻った）
   もう一度失敗       … 失敗の事実を**追記**（履歴が積まれ、復旧待ちのまま）
→ 後者はキューに残る
```

### 失効

```
active + 期限到来
→ live claim があるか → あれば待つ（delivery_in_flight）
→ 返金の復旧待ちか → あれば待つ（refund_pending）
→ どちらも無ければ expired
→ 剥奪の判断（契約が role を与えるか × 実際に与えた証拠があるか）
   → pending（巡回が剥がす）／unresolved（人が確認）／何もしない
```

候補選択（`expireOverdue()`）は、**LIMIT を掛ける前に**この2つの理由で止まる行を外す。
外さないと、絶対に失効しない行が古い順に枠を占有して後続へ到達できなくなる。
**最終判断は `expireIfDue()`**。候補選択は速さのためであって安全境界ではない。

---

## 5. Work queue map

### 商館スタッフが処理できる（「対応が必要な仕事」に数える）

| 仕事 | 対象 | 述語 | 使うAPI |
|---|---|---|---|
| 手動で提供する | 手動配送の未完了 | `pendingManualSql()` | `countPendingManual` / `listPendingManual` |
| もう一度配る | 自動配送が pending / failed | `listUndeliveredAuto` | `listUndeliveredAuto` |
| 提供状況を確認する | uncertain + legacy unknown | `unresolvedCandidateSql()` | `listUnresolvedCases` / `resolveOperatorCase` |
| 返金をやり直す | 返金の復旧待ち | `refundFailureSql()` | `listRefundFailures` / `retryRefund` |

合計が `merchantWorkTotal()`。**ここに入るものは必ず商館から辿れて、商館スタッフの
権限で終わらせられる。**

### 商館スタッフでは authority が足りない（件数に入れない）

| 事象 | なぜ商館の仕事でないか | どう扱うか |
|---|---|---|
| 剥奪の `failed`（blocked） | 強制剥奪には別の authority が要る | 件数には入れず、**トップに存在と渡し先を出す** |
| 剥奪の unresolved | 「何を与えたか証明できない」ので人の確認が要る | 現状は API のみ（画面未接続） |

### 二重計上しない

同じ購入が複数のキューに出ないよう、各キューが互いを除外する。

- 確認待ち（live claim あり）は**配送やり直しに出さない**——claim が塞ぐので重ねて配れない
- 返金に失敗した履歴のある購入は**配送やり直しに出さない**——「配り直す」ではなく「返し直す」案件
- 提供済みの証拠があるものは**返金の未完了に出さない**

「件数に入るが処理できない」「処理できるが件数に入らない」を作らない。

---

## 6. 矛盾は隠さず、直しもしない

legacy や事故で、理論上あり得ない組み合わせが実在しうる。
`safetySnapshot().contradictions` で数え上げる。

| 種別 | 意味 |
|---|---|
| `terminal_purchase_with_live_claim:<status>` | 終わった購入に生きた claim が残っている |
| `terminal_with_refund_failure_history_without_delivery_evidence:<status>` | 終わった購入（`expired` / `cancelled`）に、返金を試して失敗した記録だけが残っている。**金の決着を人が監査する必要がある**——「返った」とも「未返金が確定した」とも言わない |
| `delivered_evidence_vs_operator_no_effect` | 提供済みの証拠と「提供なし」の人の判断が同時に立っている |
| `delivered_evidence_vs_open_refund_recovery` | 正本の定義上ありえない。出たら定義がどこかでズレている |
| `delivered_evidence_vs_unresolved_case` | 提供済みなのに「不明」の案件として残っている |
| `active_purchase_with_pending_revocation` | 有効な契約からロールを剥がそうとしている |

**自動修復はしない。** 検知して報告するところまで。
直し方は状況によって違い、外部（Discord）側の状態を見ないと決められない。
