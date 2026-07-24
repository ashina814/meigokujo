# 本番デプロイ手順

冥獄城Botの本番反映は、`main`へマージ済みの変更だけを対象にします。

## 初回設置

PRをmainへマージした直後は、本番に`deploy/deploy.sh`がまだ存在しないため、最初の1回だけ手動でリポジトリを更新します。

本番に未コミット差分がある場合は、先に内容を確認して正式反映または意図的な復元を行ってください。勝手な`reset --hard`やcheckoutによる破棄は禁止です。

```bash
cd /home/kabu/meigokujo
sudo -u kabu git status --short
sudo -u kabu git fetch origin
sudo -u kabu git checkout main
sudo -u kabu git pull --ff-only origin main
bash -n deploy/deploy.sh deploy/backup.sh
```

その後、実行用wrapperを一度だけ設置します。

```bash
cat >/home/kabu/deploy.sh <<'EOF'
#!/usr/bin/env bash
exec bash /home/kabu/meigokujo/deploy/deploy.sh "$@"
EOF
chmod 0755 /home/kabu/deploy.sh
chown root:root /home/kabu/deploy.sh
```

最初にdry-runで環境確認を行います。

```bash
/home/kabu/deploy.sh --dry-run
```

問題がなければ通常実行します。

```bash
/home/kabu/deploy.sh
```

以後の本番反映は、通常実行の一コマンドだけで行います。

## 実行内容

1. root実行と必要コマンドを確認
2. 多重実行をロック
3. systemdのservice・実行ユーザー・作業ディレクトリを確認
4. systemdの`ExecStart`からNodeのbinディレクトリを検出
5. 本番リポジトリのブランチと未コミット差分を確認
6. `origin/main`を取得し、fast-forward可能か確認
7. 取得先SHAを一時worktreeへ展開
8. 一時worktreeで依存同期・typecheck・全テストを実行
9. 一時worktreeを削除
10. 検証中に本番checkoutが変更されていないか再確認
11. 反映前DBバックアップを作成
12. 本番mainを取得済みSHAへ`--ff-only`で反映
13. 本番の依存関係を`--frozen-lockfile`で同期
14. 反映後も作業ツリーがcleanか確認
15. `meigokujo-bot.service`を再起動
16. service状態と再起動後journalを表示
17. serviceが引き続きactiveか再確認
18. 成功したSHAを`/home/kabu/.meigokujo-deployed-sha`へ記録
19. 反映前・取得先・反映後SHAを表示

Discord上の計器盤や変更箇所の実表示確認は、自動化せず最後に人が行います。

## 安全上の挙動

- 未コミット差分が1件でもあれば停止します。自動stash・自動破棄はしません。
- 本番HEADから`origin/main`へfast-forwardできなければ停止します。
- `fetch`後に確定したSHAだけを反映し、実行途中でさらに更新されたmainを混ぜません。
- 取得先SHAの検証は一時worktreeで行うため、typecheck・testが失敗しても本番checkoutは更新されません。
- 検証中に本番ブランチ、HEAD、作業ツリーが変更された場合は反映前に停止します。
- バックアップ、本番依存同期、service起動確認のいずれかが失敗した場合は成功扱いにしません。
- 自動stash・自動reset・DB復元などの自動ロールバックは行いません。
- 失敗時は処理段階、反映前・取得先・現在・最終成功SHA、再起動有無を表示します。
- 同時に2つのデプロイは実行できません。
- Git上のSHAが最新でも、成功SHAが未記録・不一致なら事前検証と再起動をやり直します。
- 最新SHAの反映成功が記録済みで、サービスもactiveなら何も変更せず終了します。

成功SHA記録により、本番依存同期やservice再起動で停止した場合でも、次回実行時に「すでに最新」と誤判定せず再検証できます。

## 事前確認だけ行う

```bash
/home/kabu/deploy.sh --dry-run
```

`fetch`と状態確認だけを行います。作業ツリー、DB、依存関係、serviceは変更しません。

## 同じSHAを再検証・再起動する

```bash
/home/kabu/deploy.sh --force
```

## DBバックアップ

正本は`deploy/backup.sh`です。本番実行用ファイルは次のコマンドで設置します。

```bash
install -o root -g kabu -m 0750 \
  /home/kabu/meigokujo/deploy/backup.sh \
  /home/kabu/backup.sh
```

手動実行は`kabu`ユーザーで行います。

```bash
sudo -u kabu /home/kabu/backup.sh
```

バックアップは`/home/kabu/backups/bot-YYYYmmdd-HHMMSS.db.gz`へ保存され、最新14世代を保持します。ログは`/home/kabu/backups/backup.log`です。

スクリプトは次を保証します。

- SQLiteのオンラインバックアップAPIを使用し、WALを含む整合スナップショットを作成
- ライブDBを`-readonly`で開き、バックアップ処理から書き込まない
- `flock`により同時実行を拒否
- 一時ファイルへ作成し、整合性検査とgzip検査に成功後だけ正式名へ移動
- バックアップとログを所有者のみ読み書きできる権限で作成
- 失敗時に未完成ファイルを削除

毎日04:00 JSTの自動実行は`/etc/cron.d/meigokujo-backup`で管理します。

```cron
0 4 * * * kabu /home/kabu/backup.sh
```

cronの標準出力・標準エラーを別途同じログへリダイレクトする必要はありません。スクリプト自身が`backup.log`へ記録します。
