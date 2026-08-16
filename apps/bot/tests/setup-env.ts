/**
 * bot テスト共通の環境変数セットアップ。
 *
 * `src/config.ts` は **import された時点で** `DISCORD_TOKEN` などを検証し、
 * 無ければ `process.exit(1)` する。ローカルには `.env` があるので気づかないが、
 * CI には本番 credentials が無いため、`config.ts` を transitively import した
 * テストファイルが即死する。
 *
 * 実際に2度これで CI が落ちた（`bank-panel` 経由、`casino-home` → `ita` →
 * `permissions` 経由）。テストごとに `vi.stubEnv` を書くと、import 経路が increased
 * するたびに同じ穴が空くので、ここで一括して埋めて**この失敗の種類ごと**塞ぐ。
 *
 * 既に設定済みなら上書きしない（ローカルの `.env` を尊重する）。
 */
process.env.DISCORD_TOKEN ??= "test-token";
process.env.CLIENT_ID ??= "test-client";
process.env.OWNER_ID ??= "test-owner";
