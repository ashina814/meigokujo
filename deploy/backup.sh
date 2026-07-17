#!/usr/bin/env bash
# 冥獄城ボット — DB バックアップ（cron から毎日 04:00 JST）
# ------------------------------------------------------------
# sqlite3 の .backup を使う。稼働中でも WAL 込みで整合の取れた
# スナップショットが取れる（cp だと WAL 分が欠けて壊れることがある）。
#
# 手動実行: /home/kabu/backup.sh
# 復元:     gunzip -c ~/backups/bot-YYYYmmdd-HHMM.db.gz > /home/kabu/meigokujo/apps/bot/data/bot.db
#           （復元前に systemctl stop meigokujo-bot、復元後に start）
set -euo pipefail

DB="/home/kabu/meigokujo/apps/bot/data/bot.db"
DEST="/home/kabu/backups"
KEEP=14

mkdir -p "${DEST}"

if [ ! -f "${DB}" ]; then
  echo "[$(date '+%F %T')] DB が無い: ${DB}" >&2
  exit 1
fi

STAMP="$(date '+%Y%m%d-%H%M')"
TMP="${DEST}/bot-${STAMP}.db"

# オンラインバックアップ（ロックを取らずに整合スナップショット）
sqlite3 "${DB}" ".backup '${TMP}'"

# 壊れていないか検査してから採用する
if ! sqlite3 "${TMP}" "PRAGMA integrity_check;" | grep -q '^ok$'; then
  echo "[$(date '+%F %T')] integrity_check 失敗。破棄: ${TMP}" >&2
  rm -f "${TMP}"
  exit 1
fi

gzip -9 "${TMP}"
SIZE="$(du -h "${TMP}.gz" | cut -f1)"
echo "[$(date '+%F %T')] OK ${TMP}.gz (${SIZE})"

# 世代整理（新しい順に KEEP 個だけ残す）
ls -1t "${DEST}"/bot-*.db.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
