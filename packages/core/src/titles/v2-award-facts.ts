/**
 * Award Facts契約（PR B1）。
 *
 * 「そのawardがなぜ成立したか」という取得時snapshot——PR #152で固定した
 * awardFacts ban list（raw user ID・counterpart user ID・channel ID・message ID・
 * restricted identity・raw DB row・source payload丸ごと）を維持しつつ、実際に
 * DBへ永続化するために必要な型とruntime validatorをここへ固定する。
 *
 * generic validatorだけでprivacyを完全保証できないことは明記しておく。
 * 例えば `{ friend: "Alice" }` はJSONとして合法なので、validatorだけでは
 * identity leakを完全には防げない。主防御は:
 *
 * - safe source境界（v2-sources.ts、TITLE_SOURCESのtitleUsable/privacy契約）
 * - rule review（awardFactsを組み立てるのは称号作者自身）
 * - awardFactsを必要最小限へ翻訳する（sourceのpayloadを丸ごとcopyしない）
 *
 * このvalidatorはdefense-in-depthとして、明白なidentity-bearing keyの
 * exact matchや、prototype pollution系の特殊keyだけを機械的に拒否する。
 */

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type TitleAwardFacts = Readonly<Record<string, JsonValue>>;

/** UTF-8でJSON.stringifyした際の上限バイト数。大きなfactsが必要な称号は保存しすぎと判断する。 */
export const MAX_AWARD_FACTS_BYTES = 4096;
/** トップレベルのawardFacts object自体をdepth 0とする、許容する最大ネスト深さ。 */
export const MAX_AWARD_FACTS_DEPTH = 4;
/** value/object/array/keyを合わせた総node数の上限。深さ制限だけでは幅方向の肥大化を防げないため。 */
export const MAX_AWARD_FACTS_NODES = 256;

/**
 * 明白にidentityを運ぶkey名。exact matchでのみ拒否する——`distinctUserCount` のような
 * 安全なaggregate値まで巻き込まないよう、部分一致や大文字小文字ゆらぎでは拒否しない。
 */
const FORBIDDEN_KEYS = new Set([
  "userId",
  "user_id",
  "counterpartUserId",
  "counterpart_user_id",
  "channelId",
  "channel_id",
  "messageId",
  "message_id",
  // prototype pollution対策。JSON.parse('{"__proto__":...}') は通常のobject
  // literalと違い実際に own property として "__proto__" を作れてしまうため、
  // facts_jsonの往復（JSON.stringify → DB → JSON.parse）を想定して拒否する。
  "__proto__",
  "prototype",
  "constructor",
]);

/**
 * awardFactsとして許可された値かどうかをruntimeで検証する。
 *
 * 許可: null / boolean / finite number / string / array / plain JSON object。
 * 拒否: undefined / function / symbol / bigint / NaN / Infinity / -Infinity /
 *       Date / class instance / circular reference / prototype pollution系key。
 * 上限: シリアライズ後 <= {@link MAX_AWARD_FACTS_BYTES} バイト、
 *       深さ <= {@link MAX_AWARD_FACTS_DEPTH}、node数 <= {@link MAX_AWARD_FACTS_NODES}。
 *
 * トップレベルはplain objectであることを要求する（配列そのものやprimitiveは不可）
 * ——award facts全体としては「取得理由の集合」を表すため。
 */
export function assertValidAwardFacts(value: unknown, label = "awardFacts"): asserts value is TitleAwardFacts {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a plain JSON object`);
  }
  assertPlainObjectPrototype(value, label, "$");

  let nodeCount = 0;
  const onStack = new Set<object>();

  const walk = (node: unknown, depth: number, path: string): void => {
    nodeCount += 1;
    if (nodeCount > MAX_AWARD_FACTS_NODES) {
      throw new Error(`${label}: exceeds max node count (${MAX_AWARD_FACTS_NODES}) at ${path}`);
    }
    if (depth > MAX_AWARD_FACTS_DEPTH) {
      throw new Error(`${label}: exceeds max depth (${MAX_AWARD_FACTS_DEPTH}) at ${path}`);
    }

    if (node === null) return;
    const t = typeof node;
    if (t === "boolean" || t === "string") return;
    if (t === "number") {
      if (!Number.isFinite(node as number)) {
        throw new Error(`${label}: non-finite number (NaN/Infinity) is not allowed at ${path}`);
      }
      return;
    }
    if (t === "undefined") throw new Error(`${label}: undefined is not allowed at ${path}`);
    if (t === "function") throw new Error(`${label}: function is not allowed at ${path}`);
    if (t === "symbol") throw new Error(`${label}: symbol is not allowed at ${path}`);
    if (t === "bigint") throw new Error(`${label}: bigint is not allowed at ${path}`);
    if (t !== "object") throw new Error(`${label}: unsupported type "${t}" at ${path}`);

    if (node instanceof Date) throw new Error(`${label}: Date is not allowed at ${path}`);
    const obj = node as object;
    if (onStack.has(obj)) throw new Error(`${label}: circular reference at ${path}`);
    onStack.add(obj);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], depth + 1, `${path}[${i}]`);
    } else {
      assertPlainObjectPrototype(node, label, path);
      for (const key of Object.keys(node as Record<string, unknown>)) {
        if (FORBIDDEN_KEYS.has(key)) {
          throw new Error(`${label}: forbidden key "${key}" at ${path} (potential identity leak or prototype pollution)`);
        }
        walk((node as Record<string, unknown>)[key], depth + 1, `${path}.${key}`);
      }
    }

    onStack.delete(obj);
  };

  walk(value, 0, "$");

  const size = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (size > MAX_AWARD_FACTS_BYTES) {
    throw new Error(`${label}: serialized size (${size} bytes) exceeds limit (${MAX_AWARD_FACTS_BYTES} bytes)`);
  }
}

/** plain object（`{}` literalまたは `Object.create(null)`）であることを要求する。classのinstanceは拒否する。 */
function assertPlainObjectPrototype(node: unknown, label: string, path: string): void {
  const proto = Object.getPrototypeOf(node);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`${label}: plain object required (class instance detected) at ${path}`);
  }
}

/** awardFactsのschema version。title semantic自体の変更（新title key）とは別軸で管理する正の整数。 */
export function assertValidFactsVersion(value: number, label = "awardFactsVersion"): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer: ${JSON.stringify(value)}`);
  }
}

/**
 * validation と JSON serialization を単一passで行う。DBへ書き込む唯一の経路
 * （`TitleV2Store.award()`）はこの関数だけを使うこと。
 *
 * `assertValidAwardFacts(data)` で検証した**後に**別途 `JSON.stringify(data)` を
 * 呼ぶ2段階構成だと、`data` がforged/accessor object（getterが呼び出しごとに
 * 異なる値を返す等）だった場合、検証時に読んだ値と実際にpersistされる値が
 * 一致する保証が無い（TOCTOU）。この関数は各値をちょうど1回だけ読み、読んだ
 * その場でJSON textへ書き出す——検証結果と永続化される文字列が常に一致する。
 */
export function serializeAwardFacts(value: unknown, label = "awardFacts"): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a plain JSON object`);
  }
  assertPlainObjectPrototype(value, label, "$");

  let nodeCount = 0;
  const onStack = new Set<object>();
  const out: string[] = [];

  const emit = (node: unknown, depth: number, path: string): void => {
    nodeCount += 1;
    if (nodeCount > MAX_AWARD_FACTS_NODES) {
      throw new Error(`${label}: exceeds max node count (${MAX_AWARD_FACTS_NODES}) at ${path}`);
    }
    if (depth > MAX_AWARD_FACTS_DEPTH) {
      throw new Error(`${label}: exceeds max depth (${MAX_AWARD_FACTS_DEPTH}) at ${path}`);
    }

    if (node === null) {
      out.push("null");
      return;
    }
    const t = typeof node;
    if (t === "boolean") {
      out.push(node ? "true" : "false");
      return;
    }
    if (t === "string") {
      out.push(JSON.stringify(node));
      return;
    }
    if (t === "number") {
      if (!Number.isFinite(node as number)) {
        throw new Error(`${label}: non-finite number (NaN/Infinity) is not allowed at ${path}`);
      }
      out.push(String(node));
      return;
    }
    if (t === "undefined") throw new Error(`${label}: undefined is not allowed at ${path}`);
    if (t === "function") throw new Error(`${label}: function is not allowed at ${path}`);
    if (t === "symbol") throw new Error(`${label}: symbol is not allowed at ${path}`);
    if (t === "bigint") throw new Error(`${label}: bigint is not allowed at ${path}`);
    if (t !== "object") throw new Error(`${label}: unsupported type "${t}" at ${path}`);

    if (node instanceof Date) throw new Error(`${label}: Date is not allowed at ${path}`);
    const obj = node as object;
    if (onStack.has(obj)) throw new Error(`${label}: circular reference at ${path}`);
    onStack.add(obj);

    if (Array.isArray(node)) {
      out.push("[");
      for (let i = 0; i < node.length; i++) {
        if (i > 0) out.push(",");
        emit(node[i], depth + 1, `${path}[${i}]`);
      }
      out.push("]");
    } else {
      assertPlainObjectPrototype(node, label, path);
      out.push("{");
      const keys = Object.keys(node as Record<string, unknown>);
      keys.forEach((key, idx) => {
        if (FORBIDDEN_KEYS.has(key)) {
          throw new Error(`${label}: forbidden key "${key}" at ${path} (potential identity leak or prototype pollution)`);
        }
        if (idx > 0) out.push(",");
        out.push(JSON.stringify(key));
        out.push(":");
        emit((node as Record<string, unknown>)[key], depth + 1, `${path}.${key}`);
      });
      out.push("}");
    }

    onStack.delete(obj);
  };

  emit(value, 0, "$");
  const json = out.join("");

  const size = Buffer.byteLength(json, "utf8");
  if (size > MAX_AWARD_FACTS_BYTES) {
    throw new Error(`${label}: serialized size (${size} bytes) exceeds limit (${MAX_AWARD_FACTS_BYTES} bytes)`);
  }

  return json;
}
