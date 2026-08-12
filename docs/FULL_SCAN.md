# 冥獄城・全体スキャン

Discord上に残っている冥獄城の構造、人物、文章、操作履歴と、既存BotのSQLite台帳を読み取り専用で書き出すためのコマンドです。

## 実行

Botを動かしているVPS上で、リポジトリのルートから実行します。

```bash
pnpm --filter @meigokujo/bot scan
```

出力先は既定で次の形式です。

```text
data/scans/2026-07-17T13-00-00-000Z/
```

`data/` は `.gitignore` 対象です。スキャン結果にはサーバー内部の文章や人物情報が含まれるため、GitHubへコミットしないでください。

## 取得するもの

- サーバー基本情報
- ロール、権限、階層
- カテゴリ、チャンネル、権限上書き
- 現在のメンバーと所持ロール
- 公開・非公開の取得可能なスレッド
- Botが閲覧できるチャンネルのメッセージ履歴
- 添付ファイルのメタデータ、Embed、リアクション、メンション
- 招待、絵文字、スタンプ、イベント、BAN、AutoMod、連携
- 取得可能な監査ログ
- 既存SQLiteの全テーブル
- 権限不足や取得失敗の一覧

DM、削除済みメッセージ、Botが閲覧できない場所、過去のVC音声内容は取得できません。

## 環境変数

```dotenv
# 対象サーバー。未指定時は GUILD_ID を使います。
SCAN_GUILD_ID=

# 親出力フォルダ
SCAN_OUTPUT_DIR=./data/scans

# 1チャンネルあたりの取得件数。0は取得可能な履歴を最後まで取得。
SCAN_MESSAGE_LIMIT_PER_CHANNEL=0

# メッセージ履歴を取得するか
SCAN_INCLUDE_MESSAGES=true

# 監査ログを取得するか
SCAN_INCLUDE_AUDIT_LOG=true

# 監査ログの最大件数。0はDiscord側に残っている範囲を取得。
SCAN_AUDIT_LOG_LIMIT=0

# BotのSQLite全テーブルも書き出すか
SCAN_INCLUDE_DATABASE=true
```

## 最初の試運転

全履歴はAPIリクエストを多く使うため、最初は各チャンネル100件で正常性を確認できます。

```bash
SCAN_MESSAGE_LIMIT_PER_CHANNEL=100 pnpm --filter @meigokujo/bot scan
```

正常に完了したら、`SCAN_MESSAGE_LIMIT_PER_CHANNEL=0` で本スキャンします。Discord.jsのレート制御に従って順番に取得するため、Bot本体とは別プロセスで実行してください。

## 主な出力

- `manifest.json` — 件数、実行条件、欠損箇所
- `guild.jsonl` — サーバー基本情報
- `roles.jsonl` — ロールと権限
- `channels.jsonl` — チャンネル構造
- `threads.jsonl` — スレッド
- `members.jsonl` — メンバーと所持ロール
- `messages.jsonl` — メッセージ本文と付随情報
- `audit-log.jsonl` — 管理操作
- `message-channel-summary.jsonl` — チャンネル別取得件数
- `errors.jsonl` — 取得不能・権限不足
- `db-schema.json` / `db/*.jsonl` — 既存BotのSQLite

まず `manifest.json` と `errors.jsonl` を確認し、欠けている領域を把握してから分析へ進みます。
