import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROLE_SLOT_META, ROLE_SLOT_ORDER } from "../src/church-roles.js";
import { buildRegistrationPayload } from "../src/commands/slash-command-registration.js";

/**
 * 対人順位卓・賭博場従業員の**利用者から見える面**が復活していないことを固定する。
 * 旧設計は Git タグ `archive/casino-ranked-before-retirement-20260816` にのみ残る。
 */
describe("退役した順位卓の入口が戻っていない", () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

  it("退役コマンドを登録しない", () => {
    const names = buildRegistrationPayload().map(({ name }) => name);
    for (const retired of ["casino-employee", "casino-evidence", "casino-arbitration"]) {
      expect(names, `${retired} が再登録されている`).not.toContain(retired);
    }
  });

  it("index の interaction ルーティングに順位卓が無い", () => {
    const source = read("../src/index.ts");
    for (const retired of ["賭場運営", "賭場証拠", "casino-arbitration", "RankedTable", "ranked-table-ui"]) {
      expect(source, `${retired} のルーティングが戻っている`).not.toContain(retired);
    }
  });

  it("賭博場従業員のロールスロットが存在しない", () => {
    expect(Object.keys(ROLE_SLOT_META)).not.toContain("casino_employee");
    expect(ROLE_SLOT_ORDER as readonly string[]).not.toContain("casino_employee");
  });

  it("運営ハブに順位卓の設定UIが無い", () => {
    const source = read("../src/commands/admin-hub.ts");
    for (const retired of ["mgmt:casino:profile", "mgmt:casino:unlock", "casino_extreme_enabled", "casino_meigoku_enabled"]) {
      expect(source, `${retired} が戻っている`).not.toContain(retired);
    }
  });

  it("起動時復旧が同期の runCasinoRecovery を通る", () => {
    const source = read("../src/casino/recovery-run.ts");
    expect(source).toContain("recoverCasino(");
    expect(source).not.toContain("recoverCasinoAsync");
    expect(source).not.toContain("persistentTableRestore");
  });
});
