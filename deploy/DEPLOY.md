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
bash -n deploy/deploy.sh
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

## 初回利用前の注意

2026年7月24日時点の本番には、`deploy/backup.sh`の未コミット差分が残っています。
安全デプロイはこの状態を検出して停止するため、内容を確認し、リポジトリへ正式反映するか意図的に戻してから利用してください。勝手に`git reset --hard`や`git checkout -- deploy/backup.sh`を実行してはいけません。
