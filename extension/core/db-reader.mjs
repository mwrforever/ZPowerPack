/**
 * db.sqlite 只读增量读取层（看板数据源）。
 *
 * 数据契约（设计文档 E1）：官方遥测库 WAL 模式，行在请求完成时落库、无 running 中间态；
 * 本层以 rowid 为游标做增量拉取，行结构输出 camelCase（视图/指标层统一消费）。
 *
 * 兼容策略（§七）：所有查询按列名取值，启动时探测表/列存在性（PRAGMA table_info），
 * 缺列时对应字段为 undefined 且不抛错——zcode 更新改表只降级隐藏指标，不崩看板。
 */

import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

/** model_usage 全量列 → camelCase 行字段映射（E1；缺列自动降级） */
const MODEL_USAGE_MAP = {
  id: "id",
  logical_request_id: "logicalRequestId",
  attempt_index: "attemptIndex",
  session_id: "sessionId",
  turn_id: "turnId",
  trace_id: "traceId",
  span_id: "spanId",
  assistant_message_id: "assistantMessageId",
  parent_user_message_id: "parentUserMessageId",
  query_source: "querySource",
  provider_id: "providerId",
  model_id: "modelId",
  variant: "variant",
  agent: "agent",
  mode: "mode",
  task_type: "taskType",
  status: "status",
  started_at: "startedAt",
  first_token_at: "firstTokenAt",
  completed_at: "completedAt",
  duration_ms: "durationMs",
  time_to_first_token_ms: "timeToFirstTokenMs",
  finish_reason: "finishReason",
  tool_call_count: "toolCallCount",
  input_tokens: "inputTokens",
  output_tokens: "outputTokens",
  reasoning_tokens: "reasoningTokens",
  cache_creation_input_tokens: "cacheCreationTokens",
  cache_read_input_tokens: "cacheReadTokens",
  provider_total_tokens: "providerTotalTokens",
  computed_total_tokens: "computedTotalTokens",
  retry_count: "retryCount",
  retryable: "retryable",
  cancelled_by_user: "cancelledByUser",
  context_exceeded: "contextExceeded",
  error_type: "errorType",
  error_code: "errorCode",
  error_message: "errorMessage",
};

/** tool_usage 全量列 → camelCase 行字段映射（E1） */
const TOOL_USAGE_MAP = {
  id: "id",
  session_id: "sessionId",
  tool_name: "toolName",
  side_effect_scope: "sideEffectScope",
  read_only: "readOnly",
  destructive: "destructive",
  approval_status: "approvalStatus",
  status: "status",
  started_at: "startedAt",
  first_output_at: "firstOutputAt",
  completed_at: "completedAt",
  duration_ms: "durationMs",
  time_to_first_output_ms: "timeToFirstOutputMs",
  exit_code: "exitCode",
  output_bytes: "outputBytes",
};

/** 三张遥测表名（探测与查询用） */
const TABLES = ["model_usage", "turn_usage", "tool_usage"];

/**
 * 解析 db.sqlite 路径：env 覆盖 → config.json storage.sessionDbPath → 官方默认。
 * @param {NodeJS.ProcessEnv} env 环境变量（ZCODE_SESSION_DB_PATH / ZCODE_SESSION_DB 等价，E2）
 * @param {string} homedir 用户主目录
 * @returns {string} 数据库文件路径
 */
export function resolveDbPath(env, homedir) {
  const fromEnv = env?.ZCODE_SESSION_DB_PATH?.trim() || env?.ZCODE_SESSION_DB?.trim();
  if (fromEnv) return fromEnv;
  try {
    // config.json 固定于 ~/.zcode/cli/config.json（不跟随 storage.dir，E2 已验证）
    let text = readConfigText(join(homedir, ".zcode", "cli", "config.json"));
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const p = JSON.parse(text)?.storage?.sessionDbPath;
    if (typeof p === "string" && p.trim().length > 0) return p.trim();
  } catch {
    // 缺文件/非法 JSON 按默认处理
  }
  return join(homedir, ".zcode", "cli", "db", "db.sqlite");
}

/** 读取文本文件的内部辅助（config.json 无 BOM 容错） */
function readConfigText(path) {
  return readFileSync(path, "utf8");
}

/**
 * 只读打开遥测库并探测表/列结构。
 * @param {string} path 数据库文件路径
 * @returns {{db: DatabaseSync|null, schema: {modelUsage: Set<string>, turnUsage: Set<string>, toolUsage: Set<string>}}}
 *          文件不存在时 db=null、三个列为空 Set（调用层打中文 warn，本层不抛错）
 */
export function openDb(path) {
  if (!existsSync(path)) {
    return { db: null, schema: { modelUsage: new Set(), turnUsage: new Set(), toolUsage: new Set() } };
  }
  const db = new DatabaseSync(path, { readOnly: true });
  const schema = { modelUsage: new Set(), turnUsage: new Set(), toolUsage: new Set() };
  for (const table of TABLES) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      schema[table === "model_usage" ? "modelUsage" : table === "turn_usage" ? "turnUsage" : "toolUsage"] = new Set(cols);
    } catch {
      // 表不存在 → 保持空 Set，对应指标层降级
    }
  }
  return { db, schema };
}

/**
 * rowid 游标增量拉取 model_usage。
 * @param {DatabaseSync|null} db openDb 返回的连接（null → 空结果）
 * @param {{modelUsage: Set<string>}} schema 列探测结果
 * @param {number} cursor 上次拉到的最大 rowid
 * @returns {{rows: object[], nextCursor: number}} 行为 camelCase 结构；无新行时 nextCursor=cursor
 */
export function fetchNewModelUsage(db, schema, cursor) {
  if (!db) return { rows: [], nextCursor: cursor };
  // 仅 SELECT 实际存在的列（缺列降级为 undefined，不抛错）
  const cols = Object.keys(MODEL_USAGE_MAP).filter((c) => schema.modelUsage.has(c));
  const selectList = cols.map((c) => `"${c}"`).join(", ");
  const stmt = db.prepare(
    `SELECT rowid AS _rid, ${selectList} FROM model_usage WHERE rowid > ? ORDER BY rowid ASC`,
  );
  const raw = stmt.all(cursor);
  const rows = raw.map((r) => {
    const row = {};
    for (const c of cols) row[MODEL_USAGE_MAP[c]] = r[c];
    return row;
  });
  const nextCursor = raw.length > 0 ? raw[raw.length - 1]._rid : cursor;
  return { rows, nextCursor };
}

/**
 * 按 started_at 增量拉取 tool_usage。
 * @param {DatabaseSync|null} db openDb 返回的连接
 * @param {{toolUsage: Set<string>}} schema 列探测结果
 * @param {number} sinceMs 上次拉取的时间下界（epoch 毫秒，开区间）
 * @returns {object[]} camelCase 行数组；started_at 列缺失或库不可用时返回空数组
 */
export function fetchToolUsage(db, schema, sinceMs) {
  if (!db || !schema.toolUsage.has("started_at")) return [];
  const cols = Object.keys(TOOL_USAGE_MAP).filter((c) => schema.toolUsage.has(c));
  const selectList = cols.map((c) => `"${c}"`).join(", ");
  const raw = db
    .prepare(`SELECT ${selectList} FROM tool_usage WHERE "started_at" > ? ORDER BY "started_at" ASC`)
    .all(sinceMs);
  return raw.map((r) => {
    const row = {};
    for (const c of cols) row[TOOL_USAGE_MAP[c]] = r[c];
    return row;
  });
}
