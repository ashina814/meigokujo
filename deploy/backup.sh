#!/usr/bin/env bash
# 冥獄城Bot — WAL対応のオンラインDBバックアップ
# sqlite3のオンラインバックアップAPIで、稼働中のbot.dbから
# 整合性のあるスナップショットを作成する。ライブDBは変更しない。
set -Eeuo pipefail

DB="/home/kabu/meigokujo/apps/bot/data/bot.db"
DEST="/home/kabu/backups"
KEEP=14
LOG="${DEST}/backup.log"
LOCK="${DEST}/.backup.lock"

TMP=""
GZ_TMP=""
FAIL_REASON=""

umask 077
mkdir -p "${DEST}"
touch "${LOG}"
exec >>"${LOG}" 2>&1
cd "${DEST}"

log() {
  printf '[%s] %s\n' "$(date '+%F %T %Z')" "$*"
}

fail() {
  FAIL_REASON="$*"
  exit 1
}

cleanup() {
  local rc=$?
  local removed_incomplete=0
  local suffix=""
  trap - EXIT

  if [[ -n "${TMP}" ]]; then
    removed_incomplete=1
    rm -f -- "${TMP}" || true
  fi
  if [[ -n "${GZ_TMP}" ]]; then
    removed_incomplete=1
    rm -f -- "${GZ_TMP}" || true
  fi

  if (( removed_incomplete == 1 )); then
    suffix="; incomplete backup removed"
  fi

  if (( rc != 0 )); then
    if [[ -n "${FAIL_REASON}" ]]; then
      log "FAIL ${FAIL_REASON}${suffix}"
    else
      log "FAIL rc=${rc}${suffix}"
    fi
  fi

  exit "${rc}"
}
trap cleanup EXIT

for command in sqlite3 gzip flock mktemp find sort cut du; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    fail "required command not found: ${command}"
  fi
done

if [[ ! -f "${DB}" ]]; then
  fail "DB not found: ${DB}"
fi

exec 9>"${LOCK}"
if ! flock -n 9; then
  FAIL_REASON="another backup is already running"
  exit 75
fi

STAMP="$(date '+%Y%m%d-%H%M%S')"
FINAL="${DEST}/bot-${STAMP}.db.gz"
TMP="$(mktemp "${DEST}/.bot-${STAMP}.XXXXXX.db")"
GZ_TMP="$(mktemp "${DEST}/.bot-${STAMP}.XXXXXX.db.gz.partial")"

# -readonlyにより、このsqlite3プロセスからライブDBへ書き込まない。
# .backupはWALを含む一貫したスナップショットを作成する。
sqlite3 -readonly "${DB}" ".backup '${TMP}'"

if [[ "$(sqlite3 -readonly "${TMP}" "PRAGMA integrity_check;")" != "ok" ]]; then
  fail "integrity_check failed: ${TMP}"
fi

gzip -9 -c -- "${TMP}" >"${GZ_TMP}"
gzip -t -- "${GZ_TMP}"
chmod 0600 "${GZ_TMP}"
mv -f -- "${GZ_TMP}" "${FINAL}"
GZ_TMP=""

rm -f -- "${TMP}"
TMP=""

# 新しい順にKEEP個だけ保持する。ファイル名は本スクリプトが生成する固定形式。
mapfile -t backups < <(
  find "${DEST}" -maxdepth 1 -type f -name 'bot-*.db.gz' -printf '%T@ %p\n' \
    | sort -nr \
    | cut -d' ' -f2-
)

if (( ${#backups[@]} > KEEP )); then
  for old_backup in "${backups[@]:KEEP}"; do
    rm -f -- "${old_backup}"
  done
fi

SIZE="$(du -h "${FINAL}" | cut -f1)"
log "OK ${FINAL} (${SIZE}); retained=${KEEP}"
