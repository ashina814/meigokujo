# Legacy / maintenance asset inventory

この文書は、legacy・retired・migration・recovery資産を「削除予定」として並べるものではない。
現在のproduction・既存Discord interaction・既存DB rowを壊さず、なぜ残すのか、何を確認できれば
削除できるのかを記録する正本である。

## 判定基準

分類は次の6種類とする。

| Category | Meaning |
| --- | --- |
| `ACTIVE_MAINTENANCE` | 現在の障害復旧・整合性維持に使う |
| `LEGACY_COMPAT` | 旧interactionや旧API名を現行の安全な実装へ収束させる |
| `RETIRED_REMOVAL_SUPPORT` | 新規利用は止めたが、既設物の撤去に必要 |
| `MIGRATION_NEEDS_PROD_CONFIRMATION` | one-shot migration。production適用済みのrepo外確認が必要 |
| `HISTORICAL_DATA_COMPAT` | 既存row、監査、rollback、historical readerに必要 |
| `PROVEN_DEAD_REMOVE_NOW` | runtime・script・UI・schema・history・rollbackの用途がない |

`PROVEN_DEAD_REMOVE_NOW`には、runtime import/call、package script、deploy/CI、active UI、migration、
recovery、既存DB rowの解釈、rollback、historical readerがすべて不要と確認できたものだけを入れる。
production DBはこの監査では読まない。

## Inventory

### ACTIVE_MAINTENANCE

| Asset | Current reason | Removal condition | Evidence | Decision |
| --- | --- | --- | --- | --- |
| `boost:resolve-pending` / `resolve-boost-pending.ts` | `boost_reward_pending`の先行eventが通常recoveryで解消できない場合の、順序を守った手動補償。既定はdry-runで、実行にはmessage・operator・`--execute`が必要 | 自動recoveryが全failure modeを決定的に解消し、pending rowを手動処理する必要がないと証明できた後 | `apps/bot/src/resolve-boost-pending.ts`, `apps/bot/src/boost-reward.ts`, `packages/core/src/ledger/boost-guard.ts` | KEEP |
| casino startup / admin recovery | restart直後のfail-open防止、未完了saga・free spin・opening状態の収束に使う | 対応する永続状態とfailure mode自体が廃止され、migration/rollbackも不要になった後 | `apps/bot/src/casino/recovery-run.ts`, `apps/bot/src/commands/recovery-hub.ts` | KEEP |
| original-role / sub-account import UI | 旧購入履歴だけでは対象role・sub accountを安全に推測できないため、人が1件ずつ対応付ける | productionで未移行対象が0と確認され、監査上の再確認期間を終えた後 | `apps/bot/src/commands/original-role-import.ts`, `apps/bot/src/commands/sub-account-import.ts` | KEEP |

### LEGACY_COMPAT

| Asset | Current reason | Removal condition | Evidence | Decision |
| --- | --- | --- | --- | --- |
| retired slash runtime route 10件 | #185後のDiscord command registrationが未実施でも、Discord側に残る旧interactionを現行handlerまたは停止案内へ到達させる | production registration完了と旧interaction受信不要を運用確認し、共有button/modal/rendererのactive callerを別途保全した後 | `apps/bot/src/commands/legacy-compat-slash-command-routes.ts`, `apps/bot/src/index.ts` | KEEP handlers |
| `/株` → `replyStocksPaused` | 旧commandへ明示的な売買停止・保有維持案内を返す。既存position/historyを削除しない | 上記legacy route撤去条件を満たし、historical stock dataのreader方針を別途決定した後 | `apps/bot/src/casino/stocks-pause.ts`, `apps/bot/tests/casino-stocks-pause.test.ts` | KEEP |
| `EtherExchange` submodule compatibility / Ether名alias | 旧名からも正式開業lock付き`ChipLedger`へ収束させ、旧金融surfaceを復活させない | 全submodule consumer・rollback fixtureを`ChipLedger`へ移し、互換export不要を別PRで証明した後 | `packages/core/src/casino/exchange.ts`, `packages/core/src/casino/chip-ledger.ts`, `packages/core/tests/chip-ledger.test.ts` | KEEP |

### RETIRED_REMOVAL_SUPPORT

| Asset | Current reason | Removal condition | Evidence | Decision |
| --- | --- | --- | --- | --- |
| panel kind `entry_flex` | `installable:false`で新規設置を拒否しつつ、既設panelを撤去対象へ出す | productionの既設panel/messageが0と確認され、撤去導線と旧interaction handlerが不要になった後 | `apps/bot/src/commands/panel-kinds.ts`, `apps/bot/src/commands/bank-panel.ts`, `apps/bot/tests/panel-kinds-consistency.test.ts` | KEEP |

### MIGRATION_NEEDS_PROD_CONFIRMATION

| Asset | Current reason | Removal condition | Evidence | Decision |
| --- | --- | --- | --- | --- |
| `migrate:timed-access-legacy` | item #1の7件、item #3の5件を照合し、role-only利用者を30日契約へ一度だけ取り込む。migration keyは`shop-timed-access-v2-role-only-2026-08` | productionで同keyのrun row、期待件数、import結果、必要な運用期間終了を別途確認する。repoだけで完了扱いにしない | `apps/bot/src/migrate-timed-access-legacy.ts`, `packages/core/src/shop/service.ts` | KEEP |

### HISTORICAL_DATA_COMPAT

| Asset | Compatibility reason | Removal condition | Evidence | Decision |
| --- | --- | --- | --- | --- |
| `shop:original_role_legacy_item_id` | 旧購入から引き継ぎ候補を列挙するread-only anchor。roleは推測せず手動対応付けする | production未移行0件と運用確認後 | `original-role-import.ts`の`legacyHolders()` | KEEP |
| `shop:sub_account_legacy_item_id` | 旧購入の二重課金を防ぎ、手動import候補を列挙する | production未移行0件と運用確認後 | `sub-account.ts`の`hasUnresolvedLegacySubAccount()`, `sub-account-import.ts` | KEEP |
| `Disposition = "kaiwa"` | 旧相談案件の保存値を表示・読取可能にする。新規選択・通知は停止済み | historical rowを変換または保持期限終了し、readerが不要になった後 | `packages/core/src/confession/service.ts`, `apps/bot/src/commands/confession-base.ts` | KEEP |
| `migration_staging` / `Migration` | 旧残高移行のstaging・監査・冪等な再実行形式。現行runtime callerがなくても既存rowとrollback価値を持つ | production row・監査・rollback不要を確認し、別migrationで扱う | `packages/core/src/migration/service.ts`, `packages/core/src/db/bootstrap.ts` | KEEP |
| `title_equips` | 新しいidentity equipへ自動推測migrationせず、旧scope-bound rowをinspection/rollback用に保持する | Titles production cutoverで明示的な移行方針を決定した後 | `packages/core/src/titles/v2-store.ts`, `docs/titles-v2-design.md` | KEEP |
| casino旧opening / escrow / transaction history | 正式開業前残高、100%準備、refund saga、検算、監査を説明する事実 | financial audit・rollback・readerがすべて不要になった後。通常cleanup PRでは削除しない | `packages/core/src/casino`, `packages/core/src/db/bootstrap.ts` | KEEP |
| shop purchase / status / provenance / legacy import rows | 購入成立時点・配送状態・Titles evidence・one-shot migrationを後から説明する | retentionと監査要件を別途定義し、安全なdata migrationを設計した後 | `shop_purchases`, `shop_purchase_status_history`, `shop_purchase_title_provenance`, `shop_timed_access_legacy_*` | KEEP |
| ledger / event / recovery / title evidence | 新規writer停止だけでは削除理由にならず、監査・reversal・repairに必要 | domainごとのretention/archival仕様とproduction migrationを別途用意した後 | `packages/core/src/db/bootstrap.ts`, ledger/event/recovery/title stores | KEEP |

### PROVEN_DEAD_REMOVE_NOW

| Asset | Removal proof | Performed |
| --- | --- | --- |
| retired slash builder 9件 (`遊ぶ`, `福分け`, `賭場番付`, `賭場商店`, `競馬`, `案内`, `vip`, `流れ星`, `勝負`) | ACTIVE builder map・registration payload・runtime routeのいずれからも参照0。7件はdefinitionのみ、`遊ぶ`/`勝負`はretired builder shapeだけをテストが自己保存していた。handler・button・modal・rendererは別exportでrouteから生存 | YES。builder declarationと不要importを削除し、handlerを維持 |
| `migration_cap` typed default / legacy classification | `/移行`削除後、production read/write 0。`Migration.import()`はcapを引数で受け、既存DB rowを読む経路もない | YES。source default/metadataのみ削除。DB row削除なし |
| `roles:kaiwa` legacy setting classification | production read/write 0。旧`kaiwa`案件の互換は`Disposition`値と表示定義で成立し、role通知は明示的に空 | YES。分類と誤ったread説明のみ削除。historical dispositionは維持 |
| `vc_whitelist` legacy setting classification / test fixture | blacklist移行後のproduction read/write 0。現行は`xp_excluded_channels`と`vc_sleep_list`を使用 | YES。分類と人工的test fixtureを削除。過去方式を説明する履歴コメントは維持 |
| den whitelist terminology | `den_vcs`は現在も撤去・除外ID cleanupに必要だが、whitelist登録は存在しない | YES。stale説明と定数名だけをcurrent tracking semanticsへ修正 |

`/株`にはretired builder file自体が存在しないため、builder削除対象は10件ではなく9件である。

## Retired slash detail

| Command | Runtime handler | Builder | Why handler remains |
| --- | --- | --- | --- |
| `遊ぶ` | `handleAsobuCommand` KEEP | REMOVED | 旧interactionをgame runnerへ接続 |
| `福分け` | `handleDailyCommand` KEEP | REMOVED | 旧interactionを現行daily serviceへ接続 |
| `賭場番付` | `handleBanzukeCommand` KEEP | REMOVED | rendererは`/賭場`でも利用 |
| `賭場商店` | `handleBakutenCommand` KEEP | REMOVED | renderer/button/selectは現役panelでも利用 |
| `競馬` | `handleKeibaCommand` KEEP | REMOVED | 旧interactionを現行raceへ接続 |
| `案内` | `handleAnnaiCommand` KEEP | REMOVED | `/賭場`への移動案内と旧button互換 |
| `vip` | `handleVipCommand` KEEP | REMOVED | status/buttonは現役panelでも利用 |
| `流れ星` | `handleNagareboshiCommand` KEEP | REMOVED | 旧interactionと現役panelが同じ処理を利用 |
| `勝負` | `handleShobuCommand` KEEP | REMOVED | 旧interactionとgame runnerの互換 |
| `株` | `replyStocksPaused` KEEP | N/A | 旧interactionへ停止案内 |

ACTIVE registration payloadとlegacy route集合は変更しない。source contract testで、retired handler fileに
`SlashCommandBuilder`を再導入できないこと、legacy route 10件が維持されることを固定する。

## Settings legacy keys

| Key | Current read/write path | Replacement / fallback | Decision |
| --- | --- | --- | --- |
| `migration_cap` | read 0 / write 0。typed defaultだけ存在した | 旧`Migration.import(dump, members, cap)`の明示引数 | REMOVE source default/metadata; DB untouched |
| `roles:kaiwa` | read 0 / write 0 | 新規通知なし。historical `kaiwa` dispositionだけ保持 | REMOVE source classification; historical reader KEEP |
| `shop:original_role_legacy_item_id` | import UIが設定値を読み、旧active purchaseを列挙 | 現行original-role recordへ人が対応付け | KEEP |
| `shop:sub_account_legacy_item_id` | import UIと新規申請guardが読み、二重課金を防ぐ | 現行sub-account recordへ人が対応付け | KEEP |
| `vc_whitelist` | production read 0 / write 0 | `xp_excluded_channels`によるblacklist方式 | REMOVE source classification/test fixture; DB untouched |

source metadataからキーを外しても、generic `settings` tableの既存rowを削除するmigrationは行わない。

## Package maintenance scripts

| Script | Execution contract | Decision |
| --- | --- | --- |
| `pnpm --filter @meigokujo/bot migrate:timed-access-legacy` | Discord member fetchとproduction DBが必要。既定dry-run、`--execute`でmutation | KEEP。production確認前に実行・削除しない |
| `pnpm --filter @meigokujo/bot boost:resolve-pending -- --message-id=… --actor-user-id=…` | 指定pendingを表示するdry-run。Bot停止中に`--execute`した場合だけ補償 | KEEP。通常startup pathからは呼ばない |

この監査では、上記scriptのdry-run・executeとも実行していない。

## Database decision

- schema deletion: **none**
- column/table migration: **none**
- production DB query: **none**
- settings row deletion: **none**

「現在writerがない」だけでは、ledger、event log、casino financial history、recovery、Titles evidence、
migration record、boost compensation、shop purchase historyを削除しない。データ削除が必要になった場合は、
production counts、retention、rollback、readerを明示した別migrationとして扱う。
