# 本番デプロイ手順

冥獄城Botの本番反映は、`main`へマージ済みの変更だけを対象にします。

## 初回設置

PRをmainへマージした後、本番で一度だけ次を実行します。

```bash
cat >/home/kabu/deploy.sh <<'EOF'
#!/usr/bin/env bash
exec bash /home/kabu/meigokujo/deploy/deploy.sh "$@"
EOF
chmod 0755 /home/kabu/deploy.sh
chown root:root /home/kabu/deploy.sh
```

設置後は、次の一コマンドで反映します。

```bash
/home/kabu/deploy.sh
```

## 実行内容

1. root実行と必要コマンドを確認
2. 多重実行をロック
3. systemdの`ExecStart`からNodeのbinディレクトリを検出
4. 本番リポジトリのブランチと未コミット差分を確認
5. `origin/main`を取得し、fast-forward可能か確認
6. 更新がある場合だけ反映前DBバックアップを作成
7. `main`を`--ff-only`で反映
8. `pnpm install --frozen-lockfile`
9. `pnpm -r typecheck`
10. `pnpm -r test`
11. 検証後も作業ツリーがcleanか確認
12. `meigokujo-bot.service`を再起動
13. service状態と再起動後journalを表示
14. 反映前・取得先・反映後SHAを表示

Discord上の計器盤や変更箇所の実表示確認は、自動化せず最後に人が行います。

## 安全上の挙動

- 未コミット差分が1件でもあれば停止します。自動stash・自動破棄はしません。
- 本番HEADから`origin/main`へfast-forwardできなければ停止します。
- バックアップ、依存同期、typecheck、testのいずれかが失敗した場合は再起動しません。
- 自動ロールバックは行いません。失敗時は現在SHAと再起動有無を表示します。
- 同時に2つのデプロイは実行できません。
- `main`がすでに最新なら、既定ではバックアップ・検証・再起動を行わず終了します。

## 事前確認だけ行う

```bash
/home/kabu/deploy.sh --dry-run
```

本番変更、バックアップ、依存同期、テスト、再起動は行いません。

## 同じSHAを再検証・再起動する

```bash
/home/kabu/deploy.sh --force
```

## 初回利用前の注意

2026年7月24日時点の本番には、`deploy/backup.sh`の未コミット差分が残っています。
安全デプロイはこの状態を検出して停止するため、内容を確認し、リポジトリへ正式反映するか意図的に戻してから利用してください。勝手に`git reset --hard`や`git checkout -- deploy/backup.sh`を実行してはいけません。
