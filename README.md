# 冥獄城ボット（meigokujo）

冥獄城 Discord サーバーの運営、入城、階級・評価、Land 経済、ショップ、賭場、部屋、イベント、VC/TC 活動、称号基盤などを扱う Discord bot / domain core の pnpm monorepo です。

この README は、初めてリポジトリを開いた人が現在の構成、安全な開発手順、正しい詳細文書へ辿り着くための入口です。個別機能の完全な仕様や運用手順は複製せず、リポジトリ内のコード・registry・専門文書を正本とします。

## 現在の実装範囲

### Production / active

- **入城とメンバー運用** — 説明会、入城判定、名前ポリシー、復帰・サブアカウント、招待観測
- **階級と評価** — 文位・声位、昇格、評価フォーラム、ランキング、ロール同期と復旧
- **Land 経済** — 取引記録、送金・投げ銭、部署・財政・給与、冪等性と監査
- **ショップと権利配送** — 商品購入、ロール・期限付き権利、再評価、オリジナルロール
- **マモンの賭場** — ゲーム、公開対戦・板・競馬、チップ預託、債務予約、検算、復旧、正式開業オペレーション
- **部屋とソーシャル活動** — 公開・私的な部屋、VC 報酬、BUMP、VC/TC の活動観測
- **イベントと相談導線** — 公開イベント記録、チケット、匿名相談、裁判所・緊急対応
- **運営 UI** — 常設パネル、管理ハブ、operator-facing Settings、scheduler と outbox

Public slash command、常設パネル、operator setting の現在の集合は、それぞれコード上のregistryが正本です。READMEには件数や全項目を転記しません。

### Infrastructure / continuing development

Titles v2 は、通常の城内活動を後から意味のある「印」として認識するための基盤です。safe evidence source、時系列・privacy contract、collection / series、readiness audit、calibration infrastructure は実装されていますが、候補catalog全体がplayer-visibleにproduction化済みという意味ではありません。設計と最新状況は [Titles v2 design](docs/titles-v2-design.md) と [catalog readiness](docs/titles-v2-catalog-readiness.md) を参照してください。

### Legacy / maintenance-only

旧データの移行や手動補償用scriptは一部残っています。通常の開発・起動手順では使用しません。用途と対象データを監査せずに実行しないでください。廃止済みslash commandのhandlerも互換境界から内部機能を再利用する場合がありますが、public registrationへは戻しません。

## Architecture

```text
Discord Gateway / Interactions
            |
            v
apps/bot  ─────────> read-only internal economy API (feature-gated)
  | Discord adapter、runtime wiring、UI、scheduler、観測adapter
  v
packages/core
  | domain services、persistence、ledger、evidence/read models
  v
SQLite
```

`apps/bot`にもDiscord固有の状態管理やproduction orchestrationがあります。「全ロジックがcoreにある」という構成ではありません。`packages/core`はDiscordに依存しないdomain serviceとSQLite persistenceを中心に提供し、bot runtimeがそれらを配線します。

本番はsystemdで`apps/bot`をworking directoryにし、Node.jsからTypeScript entry pointを`tsx`経由で直接起動します。Web applicationのworkspaceは現在存在しません。

## Repository structure

- [`apps/bot`](apps/bot) — discord.js runtime、commands、panels、scheduler、Discord observation adapters
- [`packages/core`](packages/core) — domain services、SQLite schema/persistence、ledger、casino safety、Titles evidence
- [`docs`](docs) — Titles v2と賭場の設計・readiness文書
- [`deploy`](deploy) — VPS bootstrap、safe deploy、SQLite backupと運用手順
- [`ecosystem`](ecosystem) — 現行systemd unit
- [`.github/workflows`](.github/workflows) — Linux CI

## Getting started

### Prerequisites

- **Node.js 22** — CIの検証versionです。本番serviceは現在Node.js `v22.23.1`を使用しますが、このpatch versionはmachine-specificな配備状態です。
- **pnpm 9.15.9** — root `packageManager`とCIの正本versionです。Corepackの利用を推奨します。
- native dependencyをbuildできる環境 — SQLite bindingと画像生成依存をinstallするために必要です。

### Install

再現可能なinstallとCI確認では、リポジトリrootで次を実行します。

```bash
pnpm install --frozen-lockfile
```

依存versionを意図的に更新する作業だけは通常の`pnpm install`でlockfileを更新し、その差分をレビューしてください。

### Environment

Bot packageのscriptと本番serviceは`apps/bot`をworking directoryとして実行され、dotenvは`apps/bot/.env`を読みます。rootから雛形をコピーします。

```bash
cp apps/bot/.env.example apps/bot/.env
```

PowerShellでは次のとおりです。

```powershell
Copy-Item apps/bot/.env.example apps/bot/.env
```

`.env`へ実値を設定し、commitしないでください。契約の正本は [`apps/bot/src/env-contract.ts`](apps/bot/src/env-contract.ts)、入力例は [`apps/bot/.env.example`](apps/bot/.env.example) です。

| 区分 | 変数 | 意味 |
| --- | --- | --- |
| Required | `DISCORD_TOKEN`, `CLIENT_ID`, `OWNER_ID` | 1つでも未設定ならBot起動を拒否 |
| Optional/default | `DB_PATH` | 既定`./data/bot.db` |
| Feature-gated | `CASINO_OPENING_BACKUP_DIR` | 未設定ならformal-opening applyをfail-closedで無効化 |
| Feature-gated | `ECONOMY_API_TOKEN`, `ECONOMY_API_HOST`, `ECONOMY_API_PORT` | token未設定なら内部APIを起動しない。host既定`172.17.0.1`、port既定`8787` |
| Registration | `GUILD_ID`, `REGISTER_GLOBAL` | slash command登録先だけを制御し、通常起動のrequiredにはしない |

systemd、deploy、OSが所有するruntime環境変数はREADMEへ複製していません。env contractと対象scriptを確認してください。

### Start the bot

開発時のwatch起動:

```bash
pnpm --filter @meigokujo/bot dev
```

watchなしの通常起動:

```bash
pnpm --filter @meigokujo/bot start
```

どちらも実際のDiscordへ接続します。開発用tokenとguildを使用し、production credentialやproduction DBを流用しないでください。

## Slash command registration

Bot起動とslash command登録は別操作です。registryやbuilderを変更し、登録更新が必要なときだけ実行します。

```bash
pnpm --filter @meigokujo/bot register
```

登録先の決定規則:

1. `REGISTER_GLOBAL=1`ならglobal登録
2. それ以外で`GUILD_ID`があればそのguildへ登録
3. `GUILD_ID`も無ければglobal登録

登録payloadとactive / retired surfaceの正本は`apps/bot/src/commands`配下のslash command registryです。退役commandを、handler fileが残っているという理由だけで再登録しないでください。

## Verification

root contract:

```bash
pnpm typecheck
pnpm test
```

workspaceごとに切り分ける場合:

```bash
pnpm --filter @meigokujo/bot typecheck
pnpm --filter @meigokujo/bot test

pnpm --filter @meigokujo/core typecheck
pnpm --filter @meigokujo/core test
pnpm --filter @meigokujo/core test:serial
```

Coreの`test`は通常suiteの後にserial concurrency suiteも実行します。`test:serial`はserial suiteだけを再実行するための導線です。CIはLinux上でfrozen install、deploy shell syntax、全workspaceのtypecheckとtestを実行します。

Windowsでは別process testの一時directory raceやcleanup時の`EPERM`が発生することがあります。failureを無条件に無視せず、対象testの単独再実行と未変更baseとの比較でproduct regressionかfilesystem要因かを切り分けてください。

## Database and internal API

永続化はSQLiteです。package scriptまたは本番serviceから起動した場合、既定`DB_PATH=./data/bot.db`は`apps/bot/data/bot.db`を指します。schema bootstrapは起動時に適用されます。開発ではproduction DBをコピー元・接続先として勝手に使用せず、migration、正式開業、backupなどの専用導線を通常起動と区別してください。

Botはtokenで有効化されるhost内向けの読み取り専用economy APIを持ちます。`ECONOMY_API_TOKEN`が無ければserver自体を起動しません。hostはカンマ区切りで複数指定でき、Bearer tokenを要求します。APIのconsumer実装はこのmonorepoには含まれていません。

## Production deployment

本番反映の正本は [deploy/DEPLOY.md](deploy/DEPLOY.md) です。対象は`main`へmerge済みのcommitだけで、通常はroot-owned wrapperから実行します。

```bash
/home/kabu/deploy.sh --dry-run
/home/kabu/deploy.sh
```

deploy flowは取得先SHAを一時worktreeで検証し、反映前にSQLite backupを作成し、fast-forward、frozen install、systemd restart、journal確認、成功SHA記録を行います。Discord上の最終表示・動作確認は人が行います。このREADMEの手順だけで本番操作せず、必ずdeploy文書を確認してください。

## Documentation map

- [Titles v2 design](docs/titles-v2-design.md) — 称号のUX、privacy、source-first設計の正本
- [Titles v2 catalog readiness](docs/titles-v2-catalog-readiness.md) — candidate catalogと現在の実装可能性の監査。変動するstatusはここを参照
- [マモンの賭場 大型アップデート 最終実装仕様書](docs/casino/マモンの賭場_大型アップデート_最終実装仕様書_v1.0.md) — 賭場の安全不変条件と実装基準
- [マモンの賭場 常設パネル仕様](docs/casino/マモンの賭場_常設パネル仕様_2026-08-18.md) — 現行の入口・常設panel仕様。基準書§12と矛盾する場合はこちらを優先
- [Production deploy](deploy/DEPLOY.md) — bootstrap後の通常deploy、backup、systemd運用の正本

実装の最終的な正本は常に最新の`main`です。歴史的なbranch、private storage、過去のPR本文だけを根拠に現在の挙動を変更しないでください。
