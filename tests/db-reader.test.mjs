/**
 * db.sqlite 只读增量读取层的单元测试。
 * 临时库按 E1 结构造样，覆盖：rowid 游标增量、列探测降级（旧版 schema 缺列不抛错）、库缺失容错。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs"; // 不清理临时目录：Windows 下 sqlite 只读连接句柄释放有延迟，立即 rmSync 会 EPERM
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { resolveDbPath, openDb, fetchNewModelUsage, fetchToolUsage } from "../extension/core/db-reader.mjs";

/** E1 核心列集（camelCase 行结构的来源） */
const MODEL_USAGE_COLS = [
  "id",
  "logical_request_id",
  "session_id",
  "query_source",
  "provider_id",
  "model_id",
  "status",
  "started_at",
  "first_token_at",
  "completed_at",
  "duration_ms",
  "time_to_first_token_ms",
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "retry_count",
  "cancelled_by_user",
  "context_exceeded",
  "error_type",
];

/** 造一个含 model_usage/tool_usage 的临时库，可插入 n 行样例行 */
function makeDb({ modelUsageExtraDrop = null, rows = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "zpowerpack-dbreader-"));
  const dbPath = join(dir, "db.sqlite");
  const db = new DatabaseSync(dbPath);
  const cols = modelUsageExtraDrop
    ? MODEL_USAGE_COLS.filter((c) => c !== modelUsageExtraDrop)
    : MODEL_USAGE_COLS;
  db.exec(`CREATE TABLE model_usage (${cols.join(", ")})`);
  db.exec("CREATE TABLE tool_usage (id, tool_name, started_at, completed_at, duration_ms, output_bytes)");
  for (let i = 1; i <= rows; i++) {
    const vals = cols.map((c) => {
      if (c === "id") return i;
      if (c === "logical_request_id") return i;
      if (c === "session_id") return "sess" + (i % 3);
      if (c === "query_source") return i % 2 === 0 ? "main_turn" : "subagent";
      if (c === "provider_id") return i % 2 === 0 ? "bigmodel-api" : "kimi-code-cn";
      if (c === "model_id") return "glm-4.7";
      if (c === "status") return "completed";
      if (c === "started_at") return 1700000000000 + i * 100;
      if (c === "first_token_at") return 1700000000200 + i * 100;
      if (c === "completed_at") return 1700000001000 + i * 100;
      if (c === "duration_ms") return 800;
      if (c === "time_to_first_token_ms") return 200;
      if (c === "input_tokens") return 1000 + i;
      if (c === "output_tokens") return 300;
      if (c === "reasoning_tokens") return 50;
      if (c === "cache_creation_input_tokens") return 0;
      if (c === "cache_read_input_tokens") return 500;
      if (c === "retry_count") return 0;
      if (c === "cancelled_by_user") return 0;
      if (c === "context_exceeded") return 0;
      return null;
    });
    db.prepare(`INSERT INTO model_usage (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...vals);
  }
  return { db, dbPath, dir };
}

test("resolveDbPath：config 有 storage.sessionDbPath 用之，否则默认 ~/.zcode/cli/db/db.sqlite", () => {
  assert.equal(resolveDbPath({ ZCODE_SESSION_DB_PATH: "D:\\db\\x.sqlite" }, "C:\\h"), "D:\\db\\x.sqlite");
  assert.equal(resolveDbPath({}, "C:\\h"), join("C:\\h", ".zcode", "cli", "db", "db.sqlite"));
});

test("首次 fetch 全量返回、游标推进到最大 rowid", async () => {
  const { dbPath, dir } = makeDb({ rows: 30 });
  const opened = openDb(dbPath);
  const r1 = fetchNewModelUsage(opened.db, opened.schema, 0);
  assert.equal(r1.rows.length, 30);
  assert.equal(r1.nextCursor, 30);
  // 行结构 = camelCase 且字段值正确
  const first = r1.rows[0];
  assert.equal(first.id, 1);
  assert.equal(first.logicalRequestId, 1);
  assert.equal(first.sessionId, "sess1");
  assert.equal(first.providerId, "kimi-code-cn");
  assert.equal(first.modelId, "glm-4.7");
  assert.equal(first.outputTokens, 300);
  assert.equal(first.timeToFirstTokenMs, 200);
  assert.equal(first.completedAt, 1700000001000 + 100);
  opened.db.close();
});

test("游标推进后只取增量（追加 5 行 → 恰取 5 行）", async () => {
  const { dbPath, dir } = makeDb({ rows: 30 });
  const opened = openDb(dbPath);
  const r1 = fetchNewModelUsage(opened.db, opened.schema, 0);
  assert.equal(r1.rows.length, 30);

  // 追加 5 行（只读连接不可写，另开可写连接模拟 zcode 主进程持续落库）
  const wdb = new DatabaseSync(dbPath);
  const cols = MODEL_USAGE_COLS;
  for (let i = 31; i <= 35; i++) {
    wdb
      .prepare(`INSERT INTO model_usage (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
      .run(...cols.map((c) => (c === "id" ? i : c === "output_tokens" ? 999 : null)));
  }
  wdb.close();
  const r2 = fetchNewModelUsage(opened.db, opened.schema, r1.nextCursor);
  assert.equal(r2.rows.length, 5, "只取增量");
  assert.equal(r2.rows[0].id, 31);
  assert.equal(r2.rows[0].outputTokens, 999);
  assert.equal(r2.nextCursor, 35);
  opened.db.close();
});

test("旧版 schema 缺列：该字段为 undefined 且不抛错", async () => {
  const { dbPath, dir } = makeDb({ modelUsageExtraDrop: "time_to_first_token_ms", rows: 3 });
  const opened = openDb(dbPath);
  assert.equal(opened.schema.modelUsage.has("time_to_first_token_ms"), false, "schema 探测应缺列");
  assert.equal(opened.schema.modelUsage.has("output_tokens"), true);
  const r = fetchNewModelUsage(opened.db, opened.schema, 0);
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[0].timeToFirstTokenMs, undefined, "缺列字段 undefined");
  assert.equal(r.rows[0].outputTokens, 300, "存在列正常取值");
  opened.db.close();
});

test("db 文件不存在：空 schema 与空行，不抛错", () => {
  const opened = openDb(join(tmpdir(), "zp-not-exist-" + Date.now() + ".sqlite"));
  assert.equal(opened.db, null);
  assert.equal(opened.schema.modelUsage.size, 0);
  const r = fetchNewModelUsage(opened.db, opened.schema, 0);
  assert.deepEqual(r.rows, []);
  assert.equal(r.nextCursor, 0);
});

test("fetchToolUsage 按 started_at 增量返回", async () => {
  const { dbPath, dir } = makeDb({ rows: 2 });
  // 用可写连接插入工具用例行（openDb 是只读连接）
  const wdb = new DatabaseSync(dbPath);
  const ins = wdb.prepare(
    "INSERT INTO tool_usage (id, tool_name, started_at, completed_at, duration_ms, output_bytes) VALUES (?, ?, ?, ?, ?, ?)",
  );
  ins.run(1, "Read", 1700000000000, 1700000000100, 100, 50);
  ins.run(2, "Bash", 1700000050000, 1700000050200, 200, 80);
  wdb.close();
  const opened = openDb(dbPath);
  const all = fetchToolUsage(opened.db, opened.schema, 0);
  assert.equal(all.length, 2);
  assert.equal(all[0].toolName, "Read");
  const inc = fetchToolUsage(opened.db, opened.schema, 1700000000000);
  assert.equal(inc.length, 1);
  assert.equal(inc[0].toolName, "Bash");
  opened.db.close();
});
