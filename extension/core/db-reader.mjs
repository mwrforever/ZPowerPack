/**
 * db.sqlite 只读增量读取层（看板数据源，V2 口径）。
 *
 * 数据契约（设计文档 E1）：官方遥测库 WAL 模式，行在请求完成时落库、无 running 中间态；
 * 本层以 rowid 为游标做增量拉取，并提供「completed_at ≥ sinceMs」的有界回填——
 * 激活首拍回填近 24h 后增量游标从回填行最大 rowid 起步（V1 游标 0 全量拉取是卡顿根因，禁止重演）。
 * 行输出收窄为 USED_COLS 的 camelCase 映射（增量与回填共用列集），视图/指标层统一消费。
 *
 * 兼容策略（§七）：所有查询按列名取值，启动时探测表/列存在性（PRAGMA table_info），
 * 缺列时对应字段为 undefined 且不抛错——zcode 更新改表只降级隐藏指标，不崩看板。
 */

import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

/**
 * V2 增量与回填共用的查询列（收窄契约：小时桶聚合/速率/额度兜底所需的最小列集）。
 * rowid 为 SQLite 隐式列（PRAGMA 不上报但恒可选取，游标机制依赖）；行输出仅含这些列的 camelCase 映射。
 */
export const USED_COLS = [
  "rowid",
  "session_id",
  "provider_id",
  "model_id",
  "status",
  "started_at",
  "first_token_at",
  "completed_at",
  "duration_ms",
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
];

/** snake_case → camelCase（单词列名如 rowid 原样保持） */
const camelOf = (c) => c.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());

/** USED_COLS → camelCase 行字段映射（由 USED_COLS 推导，保证行输出与列集契约天然一致） */
const USED_MAP = new Map(USED_COLS.map((c) => [c, camelOf(c)]));

/** tool_usage 全量列 → camelCase 行字段映射（E1）。退役：Task 4 切换导入，Task 8 清零 */
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

/** session 表全量列 → camelCase 行字段映射（E1：按项目统计的关联表） */
const SESSION_MAP = {
  id: "id",
  directory: "directory",
  path: "path",
  title: "title",
  project_id: "projectId",
  parent_id: "parentId",
  time_created: "timeCreated",
  time_updated: "timeUpdated",
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
 * 按 USED_COLS 组装 model_usage 查询并映射 camelCase 行（增量与回填共用）。
 * @param {DatabaseSync} db 只读连接（调用方保证非空）
 * @param {{modelUsage: Set<string>}} schema 列探测结果
 * @param {string} whereSql 过滤片（形如 WHERE rowid > ?，占位符由 params 按序绑定）
 * @param {...*} params 绑定参数（来源：调用层传入的游标/时间界）
 * @returns {object[]} 行按 rowid 升序、含 rowid 字段与存在列的 camelCase 映射；
 *          缺列降级为字段缺席、不抛错（rowid 恒选保证列表永不空）
 */
function selectUsedRows(db, schema, whereSql, ...params) {
  // 仅 SELECT 实际存在的列（rowid 为隐式列不经探测，缺列降级为字段缺席，不抛错）
  const cols = USED_COLS.filter((c) => c !== "rowid" && schema.modelUsage.has(c));
  // rowid 必须显式 AS 别名：E1 真实表 id INTEGER PRIMARY KEY 是 rowid 别名，裸选 rowid 时
  // SQLite 结果列名会跟随别名列（变 id），显式命名保证两种表形下行键恒为 rowid
  const selectList =
    cols.length > 0 ? `rowid AS rowid, ${cols.map((c) => `"${c}"`).join(", ")}` : "rowid AS rowid";
  const raw = db
    .prepare(`SELECT ${selectList} FROM model_usage ${whereSql} ORDER BY rowid ASC`)
    .all(...params);
  return raw.map((r) => {
    const row = { rowid: r.rowid };
    for (const c of cols) row[USED_MAP.get(c)] = r[c];
    return row;
  });
}

/**
 * rowid 游标增量拉取 model_usage（签名与 V1 一致，行输出收窄为 USED_COLS）。
 * @param {DatabaseSync|null} db openDb 返回的连接（null → 空结果）
 * @param {{modelUsage: Set<string>}} schema 列探测结果
 * @param {number} cursor 上次拉到的最大 rowid（回填场景下来自 fetchRecentModelUsage.maxRowid）
 * @returns {{rows: object[], nextCursor: number}} 行为 USED_COLS 的 camelCase 结构；无新行时 nextCursor=cursor
 */
export function fetchNewModelUsage(db, schema, cursor) {
  if (!db) return { rows: [], nextCursor: cursor };
  const rows = selectUsedRows(db, schema, "WHERE rowid > ?", cursor);
  const nextCursor = rows.length > 0 ? rows[rows.length - 1].rowid : cursor;
  return { rows, nextCursor };
}

/**
 * 有界回填：completed_at ≥ sinceMs 的近窗口行（激活首拍近 24h 底座，行落桶即弃）。
 * 行按 rowid 升序；maxRowid 为返回行的最大 rowid，调用层以此为增量游标起点，
 * 与 fetchNewModelUsage 衔接「不重不漏」（界上行只出现在回填、界后新行只出现在增量）。
 * @param {DatabaseSync|null} db openDb 返回的连接
 * @param {{modelUsage: Set<string>}} schema 列探测结果
 * @param {number} sinceMs 完成时刻下界（epoch 毫秒，闭区间含等于；来源=服务层 now-24h）
 * @returns {{rows: object[], maxRowid: number}} 行为 USED_COLS 的 camelCase 结构；
 *          空窗口/库缺失/completed_at 列缺失 → 空行且 maxRowid=0
 *          （maxRowid=0 语义=无界可续：调用层增量游标自 0 起步，同 V1 冷启动口径）
 */
export function fetchRecentModelUsage(db, schema, sinceMs) {
  if (!db || !schema.modelUsage.has("completed_at")) return { rows: [], maxRowid: 0 };
  const rows = selectUsedRows(db, schema, 'WHERE "completed_at" >= ?', sinceMs);
  const maxRowid = rows.length > 0 ? rows[rows.length - 1].rowid : 0;
  return { rows, maxRowid };
}

/**
 * 从 session 行集合判定 subagent 会话（纯函数，无 IO）。
 * 判定规则：parentId 非空且父会话存在于行集合内 → 该 sessionId 入集合；
 * 根会话（parentId 为空/缺列降级）或父缺失（父行不在集合内）→ 不入。
 * @param {object[]} sessionRows fetchSessions 输出的 camelCase 行（id=会话id、parentId=父会话id）
 * @returns {Set<string>} subagent 会话 id 集合（速率层 O(1) 归属判定用）；空输入 → 空集合
 */
export function subagentSessionIds(sessionRows) {
  const rows = Array.isArray(sessionRows) ? sessionRows : [];
  // 先建集合内全部会话 id（父存在性判定的底座；缺 id 行不参与）
  const knownIds = new Set(rows.map((r) => r?.id).filter((v) => v !== null && v !== undefined));
  const result = new Set();
  for (const r of rows) {
    // 空 parentId（根会话/降级形态）不入；父会话须存在于行集合内
    if (r?.parentId && knownIds.has(r.parentId)) result.add(r.id);
  }
  return result;
}

/**
 * 按 started_at 增量拉取 tool_usage。
 * 退役：Task 4 切换导入，Task 8 清零（工具报表随 V2 砍除；main.js 仍在导入故本任务保留）。
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

/**
 * 读取 session 表（按项目统计的关联数据：directory/parent 链由服务层归并）。
 * @param {DatabaseSync|null} db openDb 返回的连接
 * @param {{toolUsage?: Set<string>, session?: Set<string>}} schema 列探测结果
 * @returns {object[]} camelCase 行数组；session 表不存在（探测集中未含）→ 空数组
 */
export function fetchSessions(db, schema) {
  if (!db) return [];
  // openDb 探测的是三张遥测表；session 表单独探测（缺表 → 空数组，按项目统计降级为未知项目）
  let cols;
  try {
    cols = db.prepare("PRAGMA table_info(session)").all().map((c) => c.name);
  } catch {
    return [];
  }
  const present = Object.keys(SESSION_MAP).filter((c) => cols.includes(c));
  if (present.length === 0) return [];
  const raw = db.prepare(`SELECT ${present.map((c) => `"${c}"`).join(", ")} FROM session`).all();
  return raw.map((r) => {
    const row = {};
    for (const c of present) row[SESSION_MAP[c]] = r[c];
    return row;
  });
}
