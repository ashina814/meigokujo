# 冥獄城ボット（meigokujo）

冥獄城 Discord サーバーの経済・階級・入城導線を担う自作ボットのモノレポ。

- 設計書: OneDrive の作業フォルダ（システム設計.md / 経済設計.md / ボット設計.md）を参照
- `packages/core` — コアサービス層（台帳・事件録・魂台帳・称号機関・刻時盤）。全ロジックはここ
- `apps/bot` — discord.js の窓口（パネル・コマンド・演出）
- `apps/web` — Next.js（公式サイト・名鑑・バンキング）※後続フェーズ

## 開発

```bash
pnpm install
pnpm test
```
