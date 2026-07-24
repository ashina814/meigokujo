#!/usr/bin/env bash
# 冥獄城Bot 安全デプロイ
# 本番では /home/kabu/deploy.sh からこのファイルを bash で呼び出す。
set -Eeuo pipefail

APP_USER="${APP_USER:-kabu}"
APP_HOME="${APP_HOME:-/home/kabu}"
REPO="${REPO:-/home/kabu/meigokujo}"
BRANCH="${BRANCH:-main}"
REMOTE="${REMOTE:-origin}"
SERVICE="${SERVICE:-meigokujo-bot.service}"
BACKUP_SCRIPT="${BACKUP_SCRIPT:-/home/kabu/backup.sh}"
LOCK_FILE="${LOCK_FILE:-/run/lock/meigokujo-deploy.lock}"

FORCE=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      cat <<'HELP'
Usage: /home/kabu/deploy.sh [--dry-run] [--force]

  --dry-run  本番を変更せず、dirty状態・取得先・ff可能性・実行環境だけ確認する
  --force    mainが更新されていなくても依存同期・検証・再起動まで実行する
HELP
      exit 0
      ;;
    *) echo "不明な引数: $arg" >&2; exit 2 ;;
  esac
done

STEP="初期化"
RESTARTED=0
BEFORE_SHA=""
TARGET_SHA=""
AFTER_SHA=""

on_error() {
  local rc=$?
  echo
  echo "❌ デプロイ失敗: ${STEP} (exit=${rc})" >&2
  [[ -n "$BEFORE_SHA" ]] && echo "反映前SHA: ${BEFORE_SHA}" >&2
  [[ -n "$TARGET_SHA" ]] && echo "取得先SHA: ${TARGET_SHA}" >&2
  [[ -n "$AFTER_SHA" ]] && echo "現在SHA:   ${AFTER_SHA}" >&2
  if [[ "$RESTARTED" -eq 0 ]]; then
    echo "Botサービスはこの処理では再起動していません。" >&2
  else
    echo "Botサービスは再起動済みです。状態とjournalを確認してください。" >&2
  fi
  exit "$rc"
}
trap on_error ERR

log() { printf '\n==> %s\n' "$*"; }
fail() { echo "❌ $*" >&2; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || fail "必要なコマンドがありません: $1"; }

[[ "$EUID" -eq 0 ]] || fail "rootで実行してください: sudo /home/kabu/deploy.sh"
for cmd in sudo git systemctl journalctl flock grep find sort; do require "$cmd"; done
[[ -d "$REPO/.git" ]] || fail "Gitリポジトリがありません: $REPO"
[[ -f "$BACKUP_SCRIPT" ]] || fail "バックアップスクリプトがありません: $BACKUP_SCRIPT"

exec 9>"$LOCK_FILE"
flock -n 9 || fail "別のデプロイが実行中です: $LOCK_FILE"

# systemdの実行Nodeを優先して、pnpmと同じbinディレクトリを使う。
STEP="Node/pnpm環境の検出"
SERVICE_EXEC="$(systemctl show "$SERVICE" -p ExecStart --value)"
NODE_PATH="$(printf '%s\n' "$SERVICE_EXEC" | grep -oE '/[^ ;]+/bin/node' | head -n 1 || true)"
if [[ -z "$NODE_PATH" ]]; then
  NODE_PATH="$(find "$APP_HOME/.nvm/versions/node" -type f -path '*/bin/node' 2>/dev/null | sort -V | tail -n 1 || true)"
fi
[[ -n "$NODE_PATH" && -x "$NODE_PATH" ]] || fail "systemdまたはNVMからNodeを検出できません"
NODE_BIN="$(dirname "$NODE_PATH")"
APP_PATH="$NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

as_app() {
  sudo -u "$APP_USER" env HOME="$APP_HOME" PATH="$APP_PATH" "$@"
}

as_app node --version >/dev/null
as_app pnpm --version >/dev/null

cd "$REPO"

STEP="本番作業ツリーの確認"
log "本番作業ツリーを確認"
CURRENT_BRANCH="$(as_app git branch --show-current)"
[[ "$CURRENT_BRANCH" == "$BRANCH" ]] || fail "現在ブランチが${BRANCH}ではありません: ${CURRENT_BRANCH}"
DIRTY="$(as_app git status --porcelain=v1 --untracked-files=all)"
if [[ -n "$DIRTY" ]]; then
  echo "$DIRTY" >&2
  fail "未コミット差分があります。勝手に破棄せず、先に整理してください"
fi
BEFORE_SHA="$(as_app git rev-parse HEAD)"

STEP="リモートmainの取得"
log "${REMOTE}/${BRANCH}を取得"
as_app git fetch --prune "$REMOTE" "$BRANCH"
TARGET_SHA="$(as_app git rev-parse "${REMOTE}/${BRANCH}")"
as_app git merge-base --is-ancestor "$BEFORE_SHA" "$TARGET_SHA" \
  || fail "本番HEADから${REMOTE}/${BRANCH}へfast-forwardできません"

printf '反映前SHA: %s\n取得先SHA: %s\n' "$BEFORE_SHA" "$TARGET_SHA"
printf 'Node: %s\npnpm: %s\n' "$(as_app node --version)" "$(as_app pnpm --version)"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "✅ dry-run完了。本番への変更、バックアップ、再起動は行っていません。"
  exit 0
fi

if [[ "$BEFORE_SHA" == "$TARGET_SHA" && "$FORCE" -eq 0 ]]; then
  echo "✅ すでに最新です。何も変更していません。再検証する場合は --force を使用してください。"
  exit 0
fi

STEP="反映前バックアップ"
log "反映前バックアップ"
as_app bash "$BACKUP_SCRIPT"

STEP="mainのfast-forward反映"
log "mainをff-onlyで反映"
as_app git pull --ff-only "$REMOTE" "$BRANCH"
AFTER_SHA="$(as_app git rev-parse HEAD)"
[[ "$AFTER_SHA" == "$TARGET_SHA" ]] || fail "反映後SHAが取得先SHAと一致しません"

STEP="依存関係の同期"
log "依存関係を同期"
as_app pnpm install --frozen-lockfile

STEP="型検査"
log "typecheck"
as_app pnpm -r typecheck

STEP="テスト"
log "test"
as_app pnpm -r test

STEP="検証後の作業ツリー確認"
DIRTY_AFTER="$(as_app git status --porcelain=v1 --untracked-files=all)"
if [[ -n "$DIRTY_AFTER" ]]; then
  echo "$DIRTY_AFTER" >&2
  fail "依存同期または検証後に追跡対象の差分が発生しました"
fi

STEP="Botサービスの再起動"
log "${SERVICE}を再起動"
RESTART_AT="$(date '+%Y-%m-%d %H:%M:%S')"
systemctl restart "$SERVICE"
RESTARTED=1
sleep 5
systemctl is-active --quiet "$SERVICE" || {
  systemctl status "$SERVICE" --no-pager --full || true
  journalctl -u "$SERVICE" --since "$RESTART_AT" -n 120 --no-pager || true
  fail "サービスがactiveになりませんでした"
}

STEP="service/journalの確認"
log "service状態"
systemctl status "$SERVICE" --no-pager --full
log "再起動後journal"
journalctl -u "$SERVICE" --since "$RESTART_AT" -n 120 --no-pager

STEP="完了"
AFTER_SHA="$(as_app git rev-parse HEAD)"
echo
echo "✅ 本番反映完了"
echo "反映前SHA: $BEFORE_SHA"
echo "取得先SHA: $TARGET_SHA"
echo "反映後SHA: $AFTER_SHA"
echo "service:    $(systemctl is-active "$SERVICE")"
echo "次にDiscordで計器盤など、変更箇所の実表示を人手確認してください。"
