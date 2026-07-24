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
STATE_FILE="${STATE_FILE:-/home/kabu/.meigokujo-deployed-sha}"

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
  --force    同じSHAでも事前検証・バックアップ・依存同期・再起動まで実行する
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
DEPLOYED_SHA=""
VERIFY_DIR=""
APP_PATH=""

log() { printf '\n==> %s\n' "$*"; }
fail() { echo "❌ $*" >&2; return 1; }
require() { command -v "$1" >/dev/null 2>&1 || fail "必要なコマンドがありません: $1"; }

as_app() {
  sudo -u "$APP_USER" env HOME="$APP_HOME" PATH="$APP_PATH" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT
  if [[ -n "$VERIFY_DIR" && -n "$APP_PATH" ]]; then
    cd "$REPO" 2>/dev/null || true
    as_app git worktree remove --force "$VERIFY_DIR" >/dev/null 2>&1 || true
    as_app git worktree prune >/dev/null 2>&1 || true
  fi
  exit "$rc"
}

on_error() {
  local rc=$?
  echo
  echo "❌ デプロイ失敗: ${STEP} (exit=${rc})" >&2
  [[ -n "$BEFORE_SHA" ]] && echo "反映前SHA:   ${BEFORE_SHA}" >&2
  [[ -n "$TARGET_SHA" ]] && echo "取得先SHA:   ${TARGET_SHA}" >&2
  [[ -n "$AFTER_SHA" ]] && echo "現在SHA:     ${AFTER_SHA}" >&2
  [[ -n "$DEPLOYED_SHA" ]] && echo "最終成功SHA: ${DEPLOYED_SHA}" >&2
  if [[ "$RESTARTED" -eq 0 ]]; then
    echo "Botサービスはこの処理では再起動していません。" >&2
  else
    echo "Botサービスは再起動済みです。状態とjournalを確認してください。" >&2
  fi
  exit "$rc"
}
trap cleanup EXIT
trap on_error ERR

[[ "$EUID" -eq 0 ]] || fail "rootで実行してください: sudo /home/kabu/deploy.sh"
for cmd in sudo git systemctl journalctl flock grep find sort head tail dirname tr date sleep chown chmod; do
  require "$cmd"
done
[[ -d "$REPO/.git" ]] || fail "Gitリポジトリがありません: $REPO"
[[ -f "$BACKUP_SCRIPT" ]] || fail "バックアップスクリプトがありません: $BACKUP_SCRIPT"

exec 9>"$LOCK_FILE"
flock -n 9 || fail "別のデプロイが実行中です: $LOCK_FILE"

STEP="systemd・Node/pnpm環境の検出"
LOAD_STATE="$(systemctl show "$SERVICE" -p LoadState --value)"
[[ "$LOAD_STATE" == "loaded" ]] || fail "systemdサービスを読み込めません: ${SERVICE} (${LOAD_STATE:-unknown})"
SERVICE_USER="$(systemctl show "$SERVICE" -p User --value)"
[[ "$SERVICE_USER" == "$APP_USER" ]] || fail "service Userが想定外です: ${SERVICE_USER:-root}（想定: $APP_USER）"
SERVICE_WORKDIR="$(systemctl show "$SERVICE" -p WorkingDirectory --value)"
case "$SERVICE_WORKDIR" in
  "$REPO"|"$REPO"/*) ;;
  *) fail "service WorkingDirectoryがリポジトリ配下ではありません: ${SERVICE_WORKDIR:-未設定}" ;;
esac

SERVICE_EXEC="$(systemctl show "$SERVICE" -p ExecStart --value)"
NODE_PATH="$(printf '%s\n' "$SERVICE_EXEC" | grep -oE '/[^ ;]+/bin/node' | head -n 1 || true)"
if [[ -z "$NODE_PATH" ]]; then
  NODE_PATH="$(find "$APP_HOME/.nvm/versions/node" -type f -path '*/bin/node' 2>/dev/null | sort -V | tail -n 1 || true)"
fi
[[ -n "$NODE_PATH" && -x "$NODE_PATH" ]] || fail "systemdまたはNVMからNodeを検出できません"
NODE_BIN="$(dirname "$NODE_PATH")"
APP_PATH="$NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

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
if [[ -f "$STATE_FILE" ]]; then
  DEPLOYED_SHA="$(tr -d '[:space:]' < "$STATE_FILE")"
fi

STEP="リモートmainの取得"
log "${REMOTE}/${BRANCH}を取得"
as_app git fetch --prune "$REMOTE" "$BRANCH"
TARGET_SHA="$(as_app git rev-parse "${REMOTE}/${BRANCH}")"
as_app git merge-base --is-ancestor "$BEFORE_SHA" "$TARGET_SHA" \
  || fail "本番HEADから${REMOTE}/${BRANCH}へfast-forwardできません"

printf '反映前SHA:   %s\n取得先SHA:   %s\n' "$BEFORE_SHA" "$TARGET_SHA"
printf '最終成功SHA: %s\n' "${DEPLOYED_SHA:-未記録}"
printf 'Node: %s\npnpm: %s\n' "$(as_app node --version)" "$(as_app pnpm --version)"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "✅ dry-run完了。作業ツリー、DB、依存関係、serviceは変更していません。"
  exit 0
fi

if [[ "$BEFORE_SHA" == "$TARGET_SHA" && "$DEPLOYED_SHA" == "$TARGET_SHA" && "$FORCE" -eq 0 ]]; then
  if systemctl is-active --quiet "$SERVICE"; then
    echo "✅ このSHAは反映・起動確認済みです。何も変更していません。再検証する場合は --force を使用してください。"
    exit 0
  fi
  echo "⚠️ SHAは反映済みですがサービスがactiveではないため、事前検証と再起動を続行します。"
fi

STEP="取得先SHAの隔離検証"
log "取得先SHAを一時worktreeで検証"
as_app git worktree prune
VERIFY_DIR="$APP_HOME/.meigokujo-deploy-check-${TARGET_SHA:0:12}-$$"
[[ ! -e "$VERIFY_DIR" ]] || fail "一時検証ディレクトリが既に存在します: $VERIFY_DIR"
as_app git worktree add --detach "$VERIFY_DIR" "$TARGET_SHA"
cd "$VERIFY_DIR"
as_app pnpm install --frozen-lockfile
as_app pnpm -r typecheck
as_app pnpm -r test
VERIFY_DIRTY="$(as_app git status --porcelain=v1 --untracked-files=all)"
if [[ -n "$VERIFY_DIRTY" ]]; then
  echo "$VERIFY_DIRTY" >&2
  fail "事前検証後に追跡対象の差分が発生しました"
fi
cd "$REPO"
as_app git worktree remove --force "$VERIFY_DIR"
VERIFY_DIR=""
as_app git worktree prune

STEP="反映前バックアップ"
log "反映前バックアップ"
as_app bash "$BACKUP_SCRIPT"

STEP="mainのfast-forward反映"
log "取得済みmainをff-onlyで反映"
as_app git merge --ff-only "$TARGET_SHA"
AFTER_SHA="$(as_app git rev-parse HEAD)"
[[ "$AFTER_SHA" == "$TARGET_SHA" ]] || fail "反映後SHAが取得先SHAと一致しません"

STEP="本番依存関係の同期"
log "本番依存関係を同期"
as_app pnpm install --frozen-lockfile

STEP="反映後の作業ツリー確認"
DIRTY_AFTER="$(as_app git status --porcelain=v1 --untracked-files=all)"
if [[ -n "$DIRTY_AFTER" ]]; then
  echo "$DIRTY_AFTER" >&2
  fail "依存同期後に追跡対象の差分が発生しました"
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
systemctl is-active --quiet "$SERVICE" || fail "journal確認後にサービスがactiveではありません"

STEP="成功SHAの記録"
AFTER_SHA="$(as_app git rev-parse HEAD)"
printf '%s\n' "$AFTER_SHA" > "$STATE_FILE"
chown root:root "$STATE_FILE"
chmod 0644 "$STATE_FILE"
DEPLOYED_SHA="$AFTER_SHA"

STEP="完了"
echo
echo "✅ 本番反映完了"
echo "反映前SHA:   $BEFORE_SHA"
echo "取得先SHA:   $TARGET_SHA"
echo "反映後SHA:   $AFTER_SHA"
echo "service:      $(systemctl is-active "$SERVICE")"
echo "次にDiscordで計器盤など、変更箇所の実表示を人手確認してください。"
