from pathlib import Path

path = Path("apps/bot/src/commands/admin-hub.ts")
text = path.read_text()
old = 'warning = "旧パネルのチャンネル取得に失敗し、旧パネルが残っている可能性があります。";'
new = 'warning = "旧パネルのチャンネル取得に失敗し、旧パネルが残っている可能性があります。手動確認が必要です。";'
count = text.count(old)
if count != 1:
    raise RuntimeError(f"expected one old-channel warning, found {count}")
path.write_text(text.replace(old, new, 1))
