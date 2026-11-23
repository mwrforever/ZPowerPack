/**
 * 集成测试：临时目录组装真实 schema 的 db.sqlite + provider 配置夹具，
 * 经 env 改道把全部真实路径指向临时目录，activate() 全链跑 3 个以上轮询周期——
 * 首拍回填落小时桶→额度引擎（keyless 不发请求）→快照文件→注册资源→素条推送，
 * 再直驱 onGenerateEvent 钉「官方事件 → 素条点亮」端到端链路；任何输出不含密钥。
 *
 * HTTP 边界排除（Ruling 沿用）：provider 夹具无 apiKey → computeQuota 走 unavailable
 * 分支不发请求；厂商接口已由 quota-fetch.test 注入 fetch 全覆盖，真实联调归真机验收。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { activate } from "../extension/main.js";

/** model_usage 的 E1 全量列（db-reader 列探测按名取值，缺列降级不抛错） */
const MU_COLS = `id INTEGER PRIMARY KEY, logical_request_id TEXT, attempt_index INTEGER, session_id TEXT,
  turn_id TEXT, trace_id TEXT, span_id TEXT, assistant_message_id TEXT, parent_user_message_id TEXT,
  query_source TEXT, provider_id TEXT, model_id TEXT, variant TEXT, agent TEXT, mode TEXT, task_type TEXT,
  status TEXT, started_at INTEGER, first_token_at INTEGER, completed_at INTEGER, duration_ms INTEGER,
  time_to_first_token_ms INTEGER, finish_reason TEXT, tool_call_count INTEGER, input_tokens INTEGER,
  output_tokens INTEGER, reasoning_tokens INTEGER, cache_creation_input_tokens INTEGER,
  cache_read_input_tokens INTEGER, provider_total_tokens INTEGER, computed_total_tokens INTEGER,
  retry_count INTEGER, retryable INTEGER, cancelled_by_user INTEGER, context_exceeded INTEGER,
  error_type TEXT, error_code TEXT, error_message TEXT`;

/** 组装临时环境：真实 schema db + provider 夹具 + env 改道，返回路径集合 */
function buildEnv() {
  const tmp = mkdtempSync(join(tmpdir(), "zp-integ-"));
  const dbPath = join(tmp, "db.sqlite");

  // 写连接建表插数后关闭，再由服务层只读打开（与真机 WAL 并发形态一致）
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE model_usage (${MU_COLS})`);
  db.exec(
    `CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, path TEXT, title TEXT, project_id TEXT,
     parent_id TEXT, time_created INTEGER, time_updated INTEGER)`,
  );

  const now = Date.now();
  const insMu = db.prepare(
    `INSERT INTO model_usage (session_id, query_source, provider_id, model_id, status, started_at,
     first_token_at, completed_at, duration_ms, input_tokens, output_tokens, reasoning_tokens, retry_count)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  // 数据按真实时序落库（rowid≈完成顺序）：3h 前的旧行先插（趋势/5h 兜底底座），近 60s 新行后插
  for (let i = 0; i < 8; i++) {
    const completed = now - 3 * 3600000 - (7 - i) * 60000;
    insMu.run("sess-root", "main_turn", "bigmodel-api", "glm-4.7", "completed",
      completed - 1400, completed - 1000, completed, 1400, 900, 220, 10, 0);
  }
  insMu.run("sess-child", "subagent", "bigmodel-api", "glm-4.7", "completed",
    now - 8000, now - 7600, now - 7000, 700, 300, 150, 5, 0);
  insMu.run("sess-root", "main_turn", "bigmodel-api", "glm-4.7", "error",
    now - 6000, null, now - 5000, 5000, 500, 0, 0, 1);
  // 近 60s 内 12 行，kimi 行最后落库（兜底链最新完成行断言锚点）
  for (let i = 0; i < 12; i++) {
    const completed = now - (12 - i) * 2000;
    insMu.run("sess-root", "main_turn", i === 11 ? "kimi-code-cn" : "bigmodel-api", "glm-4.7", "completed",
      completed - 1400, completed - 1000, completed, 1400, 900, 220, 10, 0);
  }
  db.exec(
    `INSERT INTO session (id, directory, title, parent_id) VALUES
     ('sess-root', 'E:\\code\\plugin\\zcode\\ZPowerPack', '根会话', NULL),
     ('sess-child', NULL, '子代理', 'sess-root')`,
  );
  db.close();

  // provider 夹具：三家全在窗口规则表内，且全部无 apiKey（HTTP 边界按 Ruling 排除）
  const providerPath = join(tmp, "provider_config.json");
  writeFileSync(providerPath, JSON.stringify({
    schemaVersion: "1",
    config: {
      providerOrder: ["bigmodel-api", "kimi-code-cn", "opencode-go-messages"],
      providerConfigRules: {
        providerRules: [
          { providerId: "bigmodel-api", templateId: "bigmodel-api", providerName: "智谱 GLM Coding", config: { access: { type: "api_key" }, modelOrder: [] } },
          { providerId: "kimi-code-cn", templateId: "kimi-code-cn", providerName: "Kimi Code", config: { access: { type: "api_key" }, modelOrder: [] } },
          { providerId: "opencode-go-messages", templateId: "opencode-go-messages", providerName: "OpenCode Go", config: { access: { type: "api_key" }, modelOrder: [] } },
        ],
      },
    },
  }), "utf8");

  return { tmp, dbPath, providerPath };
}

test("集成：真实 schema db + provider 夹具 → activate 全链 → 快照/注册资源/素条/事件驱动全断言", async () => {
  const { tmp, dbPath, providerPath } = buildEnv();

  // env 改道：全部真实路径指向临时目录（node --test 每文件独立进程，不污染其它测试）
  const envKeys = ["ZCODE_SESSION_DB_PATH", "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE", "ZCODE_STORAGE_DIR"];
  const saved = envKeys.map((k) => process.env[k]);
  process.env.ZCODE_SESSION_DB_PATH = dbPath;
  process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = providerPath;
  process.env.ZCODE_STORAGE_DIR = join(tmp, "cli");

  // mock ctx（宿主注册面），真实 deps（真 db + 真额度引擎 + 真路径解析）
  const calls = { views: [], commands: [], slots: [], opened: [] };
  const ctx = {
    views: { register: (id, def) => calls.views.push({ id, def }), open: (id) => calls.opened.push(id) },
    commands: { register: (id, fn) => calls.commands.push({ id, fn }) },
    slots: { update: (id, patch) => calls.slots.push({ id, patch }) },
  };

  let handle;
  try {
    handle = await activate(ctx, { intervalMs: 150, log: () => {} });
    await new Promise((r) => setTimeout(r, 500)); // 3 个以上轮询周期（首拍回填+增量）
    // 生成事件直驱（Task 6 绑定宿主订阅；本测试钉「官方事件 → 素条点亮」端到端链路）
    handle.onGenerateEvent(
      {
        sessionId: "sess-root",
        requestId: "req-1",
        model: { providerId: "bigmodel-api", modelId: "glm-4.7" },
        phase: "streaming",
        outputTokensPerSecond: 428,
      },
      Date.now(),
    );
  } finally {
    if (handle) handle.stop();
    envKeys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }

  // ---- ① 快照文件兜底通道：真实路径解析 + 原子写；V2 契约五段、无 charts ----
  const snapshotPath = join(tmp, "cli", "zpowerpack", "last-snapshot.json");
  const snapText = readFileSync(snapshotPath, "utf8");
  const snap = JSON.parse(snapText);
  assert.ok(!("charts" in snap), "V2 快照无 charts 键（八报表退役）");
  for (const key of ["generatedAt", "rate", "quota", "trend", "conclusion"]) assert.ok(key in snap, `缺少 ${key} 段`);
  // rate=官方事件直录：生成事件后 live 态、素条合计 428
  assert.equal(snap.rate.state, "live");
  assert.equal(snap.rate.totalTps, 428);
  assert.equal(snap.rate.streams.length, 1);
  // 兜底链：无 final 事件的落库完成行仍在（增量拍最新完成行）
  assert.ok(snap.rate.fallback && typeof snap.rate.fallback.tps === "number", "兜底行有值");

  // ---- ② 额度引擎：三家实例全出卡（keyless → 官方不可用分支，不发请求） ----
  assert.equal(snap.quota.length, 3);
  const byId = Object.fromEntries(snap.quota.map((q) => [q.providerId, q]));
  assert.equal(byId["bigmodel-api"].windows.length, 2, "智谱=5h+周");
  assert.equal(byId["kimi-code-cn"].windows.length, 2, "Kimi=5h+月");
  assert.equal(byId["opencode-go-messages"].windows.length, 3, "OpenCode=5h+周+月");
  // 兜底收窄：5h 分子=小时桶（回填行已落桶）；周/月无本地分子
  const bm5h = byId["bigmodel-api"].windows[0];
  assert.equal(bm5h.type, "rolling-5h");
  assert.equal(bm5h.source, "unavailable", "无 apiKey → 官方不可用");
  assert.ok(bm5h.used > 0, "5h 分子取小时桶整桶和");
  for (const q of snap.quota) {
    for (const w of q.windows) {
      if (w.type !== "rolling-5h") assert.equal(w.used, null, "周/月官方失败 used=null 无本地分子");
    }
  }

  // ---- ③ 24h 趋势：回填行全部落桶（21 行 token 可见） ----
  assert.equal(snap.trend.length, 24, "24 点固定折线");
  assert.ok(snap.trend.some((p) => p.tokens > 0), "回填行已进趋势");

  // ---- ④ 结论：官方 percent 无样本（keyless）→ null（view-model 出占位句） ----
  assert.equal(snap.conclusion, null);

  // ---- ⑤ 注册资源：V2 展示模型端到端可读（真数据绑定） ----
  const display = JSON.parse(calls.views[0].def.resources["zpowerpack://display"].read({ view: {} }));
  assert.equal(display.strip.text, "428 tok/s", "事件驱动素条=官方推送速率（无百分比水位不编造）");
  assert.equal(display.panel.rate.stateText, "生成中");
  assert.equal(display.panel.rate.totalText, "428 tok/s");
  assert.equal(display.panel.vendors.length, 3, "三家厂商行全出");

  // ---- ⑥ 密钥零泄漏：快照与展示输出不含 apiKey 字样/键 ----
  assert.ok(!snapText.includes("apiKey"), "快照文件不得出现 apiKey 字样");
  assert.ok(!snapText.includes("sk-"), "快照文件不得含密钥样式");
  assert.ok(!JSON.stringify(display).includes("apiKey"), "展示模型不得出现 apiKey 字样");
  const raw = JSON.parse(readFileSync(providerPath, "utf8"));
  assert.equal(raw.config.providerConfigRules.providerRules.length, 3, "夹具自检");

  // ---- ⑦ 素条推送合规：text≤40/tooltip≤200，badge 不推 ----
  const miniCalls = calls.slots.filter((s) => s.id === "zpowerpack-mini");
  assert.ok(miniCalls.length >= 1, "素条至少推送一次");
  assert.ok(miniCalls.every((s) => s.patch.text.length <= 40 && s.patch.tooltip.length <= 200));
  assert.ok(miniCalls.every((s) => !("badge" in s.patch)), "V2 不推 badge（渲染侧从不消费）");

  // ---- ⑧ 命令注册面（点击状态条回到看板） ----
  const cmd = calls.commands.find((c) => c.id === "zpowerpack-open-dashboard");
  assert.ok(cmd, "素条命令已注册");

  // ---- ⑨ 临时探测段（Task 0 采集，T6 移除）：真实 activate 链路内产出诊断文件 ----
  // 本测试不注入 deps → 探测段真实执行：ctx 枚举/候选订阅/session 采样在真实 schema 下跑通
  // 即激活正确性的证明；opts.deps 注入的单元测试路径已跳过探测段（防真机诊断文件污染）。
  const diagPath = join(tmp, "cli", "zpowerpack", "v2-probe-diagnostics.json");
  const diagText = readFileSync(diagPath, "utf8");
  const diag = JSON.parse(diagText);
  for (const key of ["ctxApi", "modelsSubscribe", "generateEvents", "viewOpenInfo", "sessionParentSample", "errors"]) {
    assert.ok(key in diag, `诊断缺少 ${key} 段`);
  }
  assert.ok(diag.ctxApi.views && diag.ctxApi.commands && diag.ctxApi.slots, "ctx 键枚举覆盖 mock ctx 全部命名空间");
  assert.ok(
    Array.isArray(diag.modelsSubscribe.candidates) && diag.modelsSubscribe.candidates.length > 0,
    "候选形态有探测记录（本 ctx 无 models 命名空间 → 应有 skip 记录而非空）",
  );
  assert.deepEqual(diag.errors, [], "真实 activate 全链探测零异常");
  // session 采样：复用 realDeps 已开的只读连接（探测段不新开连接），
  // 采到子代理归属对照数据；本夹具无归档列 → 降级为全表倒序查询，不得冒错
  assert.equal(diag.sessionParentSample.ok, true, "session 采样成功（复用 realDeps 连接）");
  const childRow = diag.sessionParentSample.rows.find((r) => r.id === "sess-child");
  assert.ok(childRow && childRow.parent_id === "sess-root", "子代理会话 parent_id 已采到（归属对照数据）");
  // 采集段不触碰 provider 文档 → 诊断无密钥
  assert.ok(!diagText.includes("apiKey"), "诊断文件不得出现 apiKey 字样");

  // 清理：Windows 下 sqlite 只读句柄释放有延迟，rm 失败容忍（临时目录由 OS 回收）
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // 句柄未释放时留待 OS 清理
  }
});
