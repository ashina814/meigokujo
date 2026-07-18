# 冥獄城ボット — VPS のDBバックアップを開発PCへ引き落とす
# ------------------------------------------------------------
# 今回の教訓: VPS 上だけのバックアップは VPS ごと消えると意味がない。
# 手元にも降ろしてはじめて「壊れない」。
#
# 手動実行:
#   powershell -ExecutionPolicy Bypass -File deploy\pull-backup.ps1
#
# 毎日自動で引き落とす（タスクスケジューラに登録・1回だけ実行すればOK）:
#   powershell -ExecutionPolicy Bypass -File deploy\pull-backup.ps1 -Install
#
# 保存先: C:\Users\kout2\OneDrive\discord\冥獄城\_backups\
#   （OneDrive なので PC が飛んでもクラウドに残る = 三重化）

param(
  [string]$VpsHost = "root@160.251.205.72",   # 新VPS（2026-07-17 移行）。IPが変わったらここを直す
  [string]$Dest    = "C:\Users\kout2\OneDrive\discord\冥獄城\_backups",
  [int]$Keep       = 30,
  [switch]$Install
)

$ErrorActionPreference = "Stop"

if ($Install) {
  $script = $MyInvocation.MyCommand.Path
  $action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -VpsHost `"$VpsHost`""
  $trigger = New-ScheduledTaskTrigger -Daily -At 9:00am
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable
  Register-ScheduledTask -TaskName "冥獄城ボット DBバックアップ取得" `
    -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Write-Host "✅ タスクスケジューラに登録しました（毎日 09:00・PCが起動していれば実行）" -ForegroundColor Green
  Write-Host "   PCが落ちていた日は次回起動時に自動で追いつきます。"
  exit 0
}

if (-not (Test-Path $Dest)) { New-Item -ItemType Directory -Path $Dest -Force | Out-Null }

Write-Host "▸ $VpsHost の最新バックアップを探す..." -ForegroundColor Magenta
$latest = (ssh -o BatchMode=yes -o ConnectTimeout=15 $VpsHost "ls -1t /home/kabu/backups/bot-*.db.gz 2>/dev/null | head -1").Trim()

if (-not $latest) {
  Write-Host "❌ VPS にバックアップがありません（cron がまだ動いていないかも）" -ForegroundColor Red
  Write-Host "   VPS で手動実行: sudo -u kabu /home/kabu/backup.sh"
  exit 1
}

$name = Split-Path $latest -Leaf
$out  = Join-Path $Dest $name

if (Test-Path $out) {
  Write-Host "  → $name は取得済み。スキップ" -ForegroundColor DarkGray
} else {
  Write-Host "▸ 取得中: $name" -ForegroundColor Magenta
  scp -o BatchMode=yes "${VpsHost}:${latest}" "$out"
  $size = "{0:N1} MB" -f ((Get-Item $out).Length / 1MB)
  Write-Host "✅ 保存: $out ($size)" -ForegroundColor Green
}

# 世代整理（新しい順に Keep 個）
Get-ChildItem -Path $Dest -Filter "bot-*.db.gz" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip $Keep |
  Remove-Item -Force -ErrorAction SilentlyContinue

$count = (Get-ChildItem -Path $Dest -Filter "bot-*.db.gz").Count
Write-Host "   手元の世代: $count 個（最大 $Keep）"
