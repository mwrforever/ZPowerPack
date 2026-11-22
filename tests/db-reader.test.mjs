/**
 * db.sqlite 只读增量读取层的单元测试（V2 口径：列收窄至 USED_COLS + 有界回填 + subagent 判定）。
 * 临时库按 E1 结构造样，覆盖：rowid 游标增量、回填界含等与游标衔接不重不漏、
 * 列探测降级（旧版 schema 缺列不抛错）、库缺失容错、subagent 会话集合判定。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs"; // 不清理临时目录：Windows 下 sqlite 只读连接句柄释放有延迟，立即 rmSync 会 EPERM
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  resolveDbPath,
  openDb,
  USED_COLS,
  fetchNewModelUsage,
  fetchRecentModelUsage,
  subagentSessionIds,
} from "../extension/core/db-reader.mjs";

/** snake_case → camelCase（测试侧独立推导，字段集断言与实现解耦） */
const camelOf = (c) => c.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());

/** USED_COLS 的 camelCase 行字段全集（行输出契约的期望字段集） */
const USED_CAMEL = USED_COLS.map(camelOf);

/** E1 核心列集（造表用：比 USED_COLS 宽——多出的列用于验证「收窄后不得出现在行输出」） */
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

/** 造一个含 model_usage 的临时库，可插入 n 行样例行 */
function makeDb({ modelUsageExtraDrop = null, rows = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "zpowerpack-dbreader-"));
  const dbPath = join(dir, "db.sqlite");
  const db = new DatabaseSync(dbPath);
  const cols = modelUsageExtraDrop
    ? MODEL_USAGE_COLS.filter((c) => c !== modelUsageExtraDrop)
    : MODEL_USAGE_COLS;
  // id 按真实 E1 形态声明为 INTEGER PRIMARY KEY（rowid 别名），钉住「别名表上 rowid 输出列名」回归
  db.exec(`CREATE TABLE model_usage (${cols.map((c) => (c === "id" ? "id INTEGER PRIMARY KEY" : c)).join(", ")})`);
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
  const { dbPath } = makeDb({ rows: 30 });
  const opened = openDb(dbPath);
  const r1 = fetchNewModelUsage(opened.db, opened.schema, 0);
  assert.equal(r1.rows.length, 30);
  assert.equal(r1.nextCursor, 30);
  // 行结构 = USED_COLS 的 camelCase 且保留列取值正确
  const first = r1.rows[0];
  assert.equal(first.rowid, 1);
  assert.equal(first.sessionId, "sess1");
  assert.equal(first.providerId, "kimi-code-cn");
  assert.equal(first.modelId, "glm-4.7");
  assert.equal(first.outputTokens, 300);
  assert.equal(first.completedAt, 1700000001000 + 100);
  opened.db.close();
});

test("游标推进后只取增量（追加 5 行 → 恰取 5 行）", async () => {
  const { dbPath } = makeDb({ rows: 30 });
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
  assert.equal(r2.rows[0].rowid, 31);
  assert.equal(r2.rows[0].outputTokens, 999);
  assert.equal(r2.nextCursor, 35);
  opened.db.close();
});

test("旧版 schema 缺列：该字段为 undefined 且不抛错", async () => {
  const { dbPath } = makeDb({ modelUsageExtraDrop: "first_token_at", rows: 3 });
  const opened = openDb(dbPath);
  assert.equal(opened.schema.modelUsage.has("first_token_at"), false, "schema 探测应缺列");
  assert.equal(opened.schema.modelUsage.has("output_tokens"), true);
  const r = fetchNewModelUsage(opened.db, opened.schema, 0);
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[0].firstTokenAt, undefined, "缺列字段 undefined");
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

test("回填查询：只取 USED_COLS、界上 completed_at 恰等于 sinceMs 的行包含在内、maxRowid 为返回行最大 rowid", () => {
  const { dbPath } = makeDb({ rows: 30 });
  const opened = openDb(dbPath);
  // 取第 15 行完成时刻为界：界前行裁掉、界上及之后共 16 行进入回填（completed_at ≥ sinceMs 闭区间）
  const sinceMs = 1700000001000 + 15 * 100;
  const r = fetchRecentModelUsage(opened.db, opened.schema, sinceMs);
  assert.equal(r.rows.length, 16, "第 15..30 行共 16 行");
  assert.equal(r.rows[0].completedAt, sinceMs, "completed_at 恰等于 sinceMs 的界上行必须包含（≥ 含等）");
  assert.deepEqual(
    Object.keys(r.rows[0]).sort(),
    [...USED_CAMEL].sort(),
    "回填行字段集应恰为 USED_COLS 的 camelCase 映射",
  );
  // ORDER BY rowid ASC → 首行 rowid 最小、maxRowid 取末行（增量游标衔接起点）
  assert.equal(r.rows[0].rowid, 15);
  assert.equal(r.maxRowid, 30, "maxRowid 为返回行的最大 rowid");
  opened.db.close();
});

test("回填后游标衔接不重不漏：从 maxRowid 起增量恰取新行，与回填零重叠、窗口行零遗漏", async () => {
  const { dbPath } = makeDb({ rows: 30 });
  const opened = openDb(dbPath);
  // 第 20 行完成时刻为界：第 20..30 行共 11 行先入回填
  const sinceMs = 1700000001000 + 20 * 100;
  const back = fetchRecentModelUsage(opened.db, opened.schema, sinceMs);
  assert.equal(back.rows.length, 11);
  assert.equal(back.maxRowid, 30);
  // 不漏：窗口内（completed_at ≥ sinceMs）行全部出现在回填结果且按 rowid 升序
  assert.deepEqual(
    back.rows.map((row) => row.rowid),
    Array.from({ length: 11 }, (_, k) => 20 + k),
    "回填应覆盖第 20..30 行",
  );

  // 模拟 zcode 主进程继续落库：追加 5 行新完成行（只读连接不可写，另开可写连接）
  const wdb = new DatabaseSync(dbPath);
  const cols = MODEL_USAGE_COLS;
  for (let i = 31; i <= 35; i++) {
    wdb
      .prepare(`INSERT INTO model_usage (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
      .run(
        ...cols.map((c) =>
          c === "id" ? i : c === "completed_at" ? 1700000001000 + i * 100 : c === "output_tokens" ? 999 : null,
        ),
      );
  }
  wdb.close();

  // 增量从回填 maxRowid 起：恰取新追加 5 行（衔接起点由回填给出，非 0 全量）
  const inc = fetchNewModelUsage(opened.db, opened.schema, back.maxRowid);
  assert.equal(inc.rows.length, 5, "增量恰取追加的 5 行");
  assert.equal(inc.nextCursor, 35);
  const backRowids = new Set(back.rows.map((row) => row.rowid));
  assert.ok(inc.rows.every((row) => !backRowids.has(row.rowid)), "不重：增量行不得与回填行重叠");
  assert.deepEqual(
    inc.rows.map((row) => row.rowid),
    [31, 32, 33, 34, 35],
    "不漏：追加行全部入增量",
  );
  opened.db.close();
});

test("subagentSessionIds：parentId 非空且父存在于行集合 → 入集合；根会话/父缺失/空串 → 不入", () => {
  const rows = [
    { id: "root-1", parentId: null }, // 根会话 → 不入
    { id: "root-2" }, // 无 parentId 键（session 表缺列降级形态）→ 不入
    { id: "sub-a", parentId: "root-1" }, // 父在集合内 → 入
    { id: "sub-b", parentId: "root-2" }, // 父在集合内（父自身是根）→ 入
    { id: "orphan", parentId: "ghost" }, // 父不在集合内 → 不入
    { id: "empty", parentId: "" }, // 空串 → 不入
  ];
  const ids = subagentSessionIds(rows);
  assert.ok(ids instanceof Set, "返回 Set（供速率层 O(1) 归属判定）");
  assert.deepEqual([...ids].sort(), ["sub-a", "sub-b"]);
  // 空输入 → 空集合（冷启动容错）
  assert.equal(subagentSessionIds([]).size, 0);
});

test("fetchNewModelUsage：输出行仅含 USED_COLS 的 camelCase 字段（id/query_source/TTFT 等已裁列不出现）", () => {
  const { dbPath } = makeDb({ rows: 3 });
  const opened = openDb(dbPath);
  const r = fetchNewModelUsage(opened.db, opened.schema, 0);
  assert.equal(r.rows.length, 3);
  assert.deepEqual(
    Object.keys(r.rows[0]).sort(),
    [...USED_CAMEL].sort(),
    "行字段集应恰为 USED_COLS 的 camelCase 映射",
  );
  // 造表含但已被裁的列 → 不得出现在行输出（报表砍除列）
  assert.equal("id" in r.rows[0], false);
  assert.equal("querySource" in r.rows[0], false);
  assert.equal("timeToFirstTokenMs" in r.rows[0], false);
  opened.db.close();
});

test("库缺失或 completed_at 列缺失：回填返回空结果不抛错（maxRowid=0 → 增量游标自 0 起步）", () => {
  const missing = openDb(join(tmpdir(), "zp-not-exist-" + Date.now() + ".sqlite"));
  assert.deepEqual(fetchRecentModelUsage(missing.db, missing.schema, 0), { rows: [], maxRowid: 0 });
  // 旧版 schema 缺 completed_at → 无法定界 → 空结果不抛错
  const { dbPath } = makeDb({ modelUsageExtraDrop: "completed_at", rows: 3 });
  const opened = openDb(dbPath);
  assert.deepEqual(fetchRecentModelUsage(opened.db, opened.schema, 0), { rows: [], maxRowid: 0 });
  opened.db.close();
});
