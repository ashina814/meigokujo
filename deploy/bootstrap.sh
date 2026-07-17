#!/usr/bin/env bash
# 冥獄城ボット — 新規VPS ブートストラップ
# ------------------------------------------------------------
# 使い方（新VPSに root でSSHして実行）:
#   curl -fsSL https://raw.githubusercontent.com/ashina814/meigokujo/main/deploy/bootstrap.sh -o bootstrap.sh
#   bash bootstrap.sh
# もしくはこのファイルの中身を丸ごと貼り付けて実行。
#
# やること:
#   1. 必要パッケージ（git / sqlite3 / build-essential 等）
#   2. ユーザー kabu 作成
#   3. nvm + Node v22.23.1（kabu のホームに）
#   4. リポジトリ clone → pnpm install
#   5. .env の雛形を配置（トークンは手で入れる）
#   6. systemd unit 設置
#   7. 毎日のDBバックアップ cron を設置
# 実行後にやること: .env にトークンを入れる → register → start（画面の指示に従う）
set -euo pipefail

NODE_VERSION="v22.23.1"
APP_USER="kabu"
APP_HOME="/home/${APP_USER}"
REPO_URL="https://github.com/ashina814/meigokujo.git"
REPO_DIR="${APP_HOME}/meigokujo"
BOT_DIR="${REPO_DIR}/apps/bot"

say() { printf "\n\033[1;35m▸ %s\033[0m\n" "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "root で実行してください（sudo bash bootstrap.sh）" >&2
  exit 1
fi

say "1/7 パッケージを入れる"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl ca-certificates sqlite3 build-essential python3 tzdata
timedatectl set-timezone Asia/Tokyo || true

say "2/7 ユーザー ${APP_USER} を用意"
if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "${APP_USER}"
  echo "  → ${APP_USER} を作成しました"
else
  echo "  → ${APP_USER} は既にいます"
fi

say "3/7 nvm + Node ${NODE_VERSION}"
sudo -u "${APP_USER}" -H bash <<EOF
set -euo pipefail
if [ ! -d "\${HOME}/.nvm" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
export NVM_DIR="\${HOME}/.nvm"
. "\${NVM_DIR}/nvm.sh"
nvm install ${NODE_VERSION}
nvm alias default ${NODE_VERSION}
corepack enable || true
corepack prepare pnpm@9.15.9 --activate || true
node -v
EOF

say "4/7 リポジトリを clone して install"
sudo -u "${APP_USER}" -H bash <<EOF
set -euo pipefail
export NVM_DIR="\${HOME}/.nvm"
. "\${NVM_DIR}/nvm.sh"
if [ ! -d "${REPO_DIR}/.git" ]; then
  git clone "${REPO_URL}" "${REPO_DIR}"
else
  cd "${REPO_DIR}" && git pull --ff-only
fi
cd "${REPO_DIR}"
pnpm install --frozen-lockfile
mkdir -p "${BOT_DIR}/data"
EOF

say "5/7 .env の雛形"
if [ ! -f "${BOT_DIR}/.env" ]; then
  cat > "${BOT_DIR}/.env" <<'ENVEOF'
# ★ DISCORD_TOKEN は Developer Portal → Bot → Reset Token で新しく発行して貼る
DISCORD_TOKEN=
CLIENT_ID=1522579449420189706
# 冥獄城（本番）。テスト鯖(1521736665482137630)にしないこと
GUILD_ID=1463201396567441441
OWNER_ID=
DB_PATH=./data/bot.db
ENVEOF
  chown "${APP_USER}:${APP_USER}" "${BOT_DIR}/.env"
  chmod 600 "${BOT_DIR}/.env"
  echo "  → ${BOT_DIR}/.env を作成（DISCORD_TOKEN と OWNER_ID が空です）"
else
  echo "  → .env は既にあります（触りません）"
fi

say "6/7 systemd unit"
cp "${REPO_DIR}/ecosystem/meigokujo-bot.service" /etc/systemd/system/meigokujo-bot.service
systemctl daemon-reload
systemctl enable meigokujo-bot.service
echo "  → 有効化しました（まだ起動しません）"

say "7/7 毎日のDBバックアップ"
install -o "${APP_USER}" -g "${APP_USER}" -m 750 -d "${APP_HOME}/backups"
cp "${REPO_DIR}/deploy/backup.sh" "${APP_HOME}/backup.sh"
chown "${APP_USER}:${APP_USER}" "${APP_HOME}/backup.sh"
chmod 750 "${APP_HOME}/backup.sh"
cat > /etc/cron.d/meigokujo-backup <<'CRONEOF'
# 冥獄城ボット: 毎日 04:00 JST に DB をバックアップ（14世代保持）
CRON_TZ=Asia/Tokyo
0 4 * * * kabu /home/kabu/backup.sh >> /home/kabu/backups/backup.log 2>&1
CRONEOF
chmod 644 /etc/cron.d/meigokujo-backup
echo "  → 毎日 04:00 JST・14世代保持"

cat <<'DONE'

============================================================
 ブートストラップ完了。あと3ステップ:

 1) トークンを入れる
      nano /home/kabu/meigokujo/apps/bot/.env
      # DISCORD_TOKEN=（Developer Portal で Reset Token して発行）
      # OWNER_ID=（あなたの Discord ユーザーID）

 2) スラッシュコマンドを登録
      cd /home/kabu/meigokujo/apps/bot && sudo -u kabu env NODE_ENV=production TZ=Asia/Tokyo \
        /home/kabu/.nvm/versions/node/v22.23.1/bin/node --import tsx src/register-commands.ts

 3) 起動して確認
      systemctl start meigokujo-bot.service
      journalctl -u meigokujo-bot.service -n 20 --no-pager -o cat
      # 「⚔️ 冥獄城ボット 起動」と「📗 検算OK」が出れば成功

 起動後は 復旧手順書（新VPS復旧手順.md）の設定チェックリストへ。
============================================================
DONE
