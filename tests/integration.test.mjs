/**
 * 集成测试：临时目录组装真实 schema 的 db.sqlite + provider 配置夹具，
 * 经 env 改道把全部真实路径指向临时目录，activate() 全链跑 3 个以上轮询周期——
 * 首拍回填落小时桶→额度引擎（keyless 不发请求）→快照文件→注册资源→素条推送，
 * 再直驱 onGenerateEvent 钉「官方事件 → 素条点亮」端到端链路；任何输出不含密钥。
 * Task 6 接线扩展：workbench/context mock 下会话作用域素条（slots 第三参）、
 * notify 推送链句柄、sync 资源即时拉取（停拍隔离验证）。
 * Task 7 视图消费契约扩展：display 载荷 V2 形状全链钉死（视图哑渲染绑定面）与
 * sync 返回 quota 的窗口形状（视图重渲数据源）。
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
  // 推送链句柄模拟：视图打开期间宿主侧收到的 notify uri 记录
  const notifyCalls = [];
  let viewCloseCb = null;
  const ctx = {
    views: { register: (id, def) => calls.views.push({ id, def }), open: (id) => calls.opened.push(id) },
    commands: { register: (id, fn) => calls.commands.push({ id, fn }) },
    // 会话作用域素条（修订 #1）：第三参作用域也要记录
    slots: { update: (id, patch, scope) => calls.slots.push({ id, patch, scope }) },
    // workbench 模拟（宿主实证形状）：单窗口聚焦根会话，初值经 visibleSessions 拉取
    workbench: {
      onDidChange: () => {},
      visibleSessions: async () => ({
        sessions: [{ sessionId: "sess-root", workspace: "E:\\code\\plugin\\zcode\\ZPowerPack", isDraft: false, focused: true }],
      }),
    },
    // context.get 模拟（宿主实证）：根会话已选模型 → tooltip 额度供应商 bigmodel-api
    context: {
      get: async ({ sessionId }) => (sessionId === "sess-root" ? { model: { providerId: "bigmodel-api", modelId: "glm-4.7", contextWindow: 200000 } } : null),
    },
  };

  // 快照文件路径（sync 断言在停拍段读取，声明前置避免时序引用）
  const snapshotPath = join(tmp, "cli", "zpowerpack", "last-snapshot.json");

  let handle;
  let syncQuota = null;
  let snapAtSync = null;
  try {
    handle = await activate(ctx, { intervalMs: 150, log: () => {} });
    // 模拟宿主打开视图（推送链 §五.8）：句柄带 notify(uri) 与 onDidClose(cb)
    calls.views[0].def.onDidOpen({ notify: (uri) => notifyCalls.push(uri), onDidClose: (cb) => (viewCloseCb = cb) });
    await new Promise((r) => setTimeout(r, 500)); // 3 个以上轮询周期（首拍回填+增量）
    // 生成事件直驱（Task 6 绑定宿主订阅；本测试钉「官方事件 → 会话素条点亮」端到端链路）
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
    await new Promise((r) => setTimeout(r, 80)); // 事件型 deliver → 会话素条/视图通知落地
    handle.stop(); // 停拍：隔离 sync 即时拉取断言（此后任何快照重写只能来自 sync 触发的拍）
    viewCloseCb(); // 模拟视图关闭：notify 句柄引用清除
    const notifyAtClose = notifyCalls.length;
    // sync 手动同步通道（Task 6）：read 置待办 → 即时跑一拍 → {quota} 返回 + 快照重写
    const before = JSON.parse(readFileSync(snapshotPath, "utf8")).generatedAt;
    syncQuota = JSON.parse(await calls.views[0].def.resources["zpowerpack://sync"].read({ view: {} }));
    snapAtSync = JSON.parse(readFileSync(snapshotPath, "utf8"));
    assert.deepEqual(Object.keys(syncQuota), ["quota"], "sync 返回 {quota} 载荷");
    assert.equal(syncQuota.quota.length, 3, "sync 即时拉取返回三家实例额度");
    // Task 7 视图消费契约：sync 返回的 quota 行窗口形状=厂商行重渲数据源（六键契约）
    for (const q of syncQuota.quota) {
      assert.ok(Array.isArray(q.windows), "sync quota 行须带 windows 数组");
      for (const w of q.windows) {
        for (const key of ["type", "used", "limit", "percent", "source", "nextResetMs"]) {
          assert.ok(key in w, `sync 窗口缺 ${key} 键（视图厂商行消费契约）`);
        }
      }
    }
    assert.ok(snapAtSync.generatedAt >= before, "sync 触发的即时拍重写快照文件");
    assert.equal(notifyCalls.length, notifyAtClose, "视图关闭后 sync 拍不得再通知已关闭视图");
  } finally {
    if (handle) handle.stop();
    envKeys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }

  // ---- ① 快照文件兜底通道：真实路径解析 + 原子写；V2 契约五段、无 charts ----
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
  // 官方失败（keyless）时速率保留、额度段给「额度不可用」——空环不得被读成 0 用量
  assert.equal(display.strip.text, "428 tok/s · 额度不可用", "官方失败时素条须标注额度不可用（不编造水位）");
  assert.equal(display.panel.rate.stateText, "生成中");
  assert.equal(display.panel.rate.totalText, "428 tok/s");
  assert.equal(display.panel.vendors.length, 3, "三家厂商行全出");
  // ---- ⑤b 视图消费契约（Task 7 视图全量重写后的哑渲染绑定面）：display 载荷 V2 形状全链 ----
  // 顶层/四区键集按契约钉死（deepEqual 收紧到「多键/缺键即断」；视图实际按 vendors/trend
  // 的 JSON 差异重渲，不依赖键序——此断言是扩展侧载荷契约的守门，不代表视图依赖顺序）
  assert.deepEqual(Object.keys(display), ["strip", "panel"], "display 顶层只含 strip/panel");
  assert.deepEqual(Object.keys(display.panel), ["rate", "vendors", "trend", "conclusion"], "panel 四区键齐");
  // 速率条绑定字段：各流并列三键（modelId/tpsText/isSubText 可空），活动时刻可空
  assert.ok(
    display.panel.rate.streams.every(
      (s) => typeof s.modelId === "string" && typeof s.tpsText === "string" && (s.isSubText === null || typeof s.isSubText === "string"),
    ),
    "流并列字段类型齐（视图哑渲染绑定面）",
  );
  assert.ok(
    display.panel.rate.lastActivityText === null || typeof display.panel.rate.lastActivityText === "string",
    "活动时刻可空或字符串",
  );
  // 厂商行绑定字段：环百分比可空、环色 hex、状态句可空或字符串、副行可空
  for (const v of display.panel.vendors) {
    assert.ok(v.ringPct === null || typeof v.ringPct === "number", "ringPct 可空或数值");
    assert.match(v.ringColor, /^#[0-9a-f]{6}$/i, "环色为 hex 色值（stroke-dasharray 环直渲）");
    // keyless 夹具=官方失败形态：状态句必须是「官方接口不可用」，不得伪装成滚动窗口
    assert.equal(v.statusText, "官方接口不可用", `官方失败须给状态句: ${v.name}`);
    assert.ok(v.subText === null || typeof v.subText === "string", "副行可空或字符串");
    // 百分比枚举必须覆盖实例全部窗口（OpenCode 三枚真钉住，少一枚即视图丢窗口）
    const quotaRow = snap.quota.find((q) => q.name === v.name);
    assert.ok(quotaRow, `厂商行应对应快照额度实例: ${v.name}`);
    assert.equal(v.percents.length, quotaRow.windows.length, `百分比枚举须覆盖全部窗口: ${v.name}`);
    assert.ok(
      v.percents.every((p) => typeof p.label === "string" && (p.pct === null || typeof p.pct === "number")),
      "百分比枚举字段齐（OpenCode 三枚全量契约）",
    );
  }
  // 趋势：24 点序号坐标 + foot 累计句（视图 SVG path 直接映射）
  assert.equal(display.panel.trend.points.length, 24, "趋势 24 点");
  assert.equal(typeof display.panel.trend.footText, "string", "趋势 foot 必有");
  // 结论：keyless 无官方 percent 采样 → 诚实占位句（真实链路经 view-model 产出）
  assert.equal(display.panel.conclusion.text, "消耗速度尚不足以推算");

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

  // ---- ⑨ 临时探测段（Task 0 采集，保留至 T9 采集后移除）：真实 activate 链路内产出诊断文件 ----
  // 本测试不注入 deps → 探测段真实执行：ctx 枚举/候选订阅/session 采样在真实 schema 下跑通
  // 即激活正确性的证明；opts.deps 注入的单元测试路径已跳过探测段（防真机诊断文件污染）。
  const diagPath = join(tmp, "cli", "zpowerpack", "v2-probe-diagnostics.json");
  const diagText = readFileSync(diagPath, "utf8");
  const diag = JSON.parse(diagText);
  for (const key of ["ctxApi", "modelsSubscribe", "generateEvents", "viewOpenInfo", "sessionParentSample", "stripPushes", "errors"]) {
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

  // ---- ⑩ 会话作用域素条（2026-11-23 修订 #1）：事件按 sessionId 过滤，slots.update 第三参推给聚焦会话 ----
  const scoped = calls.slots.filter((s) => s.id === "zpowerpack-mini" && s.scope?.sessionId === "sess-root");
  assert.ok(scoped.length >= 1, "聚焦会话应收到作用域素条");
  assert.equal(scoped[scoped.length - 1].patch.text, "428 tok/s · 额度不可用", "官方失败时速率保留、额度段给不可用");
  // tooltip 额度头=聚焦会话当前模型选择供应商（修订 #2，context.get mock）的 quota 行
  assert.equal(scoped[scoped.length - 1].patch.tooltip, "智谱 GLM Coding · 主 428 tok/s · 点击查看详情");

  // ---- ⑪ 推送链（Task 6 接线）：视图打开期间数据更新 → notify(display) 恰在打开窗口内 ----
  assert.ok(notifyCalls.length >= 1, "视图打开期间应收到 display 更新通知");
  assert.ok(notifyCalls.every((u) => u === "zpowerpack://display"), "通知 uri 固定为 display");

  // 清理：Windows 下 sqlite 只读句柄释放有延迟，rm 失败容忍（临时目录由 OS 回收）
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // 句柄未释放时留待 OS 清理
  }
});

test("集成：素条推送采样落诊断 stripPushes——contextModel/contextError 原文（0.2.1 厂商选择证据链）", async () => {
  const { tmp, dbPath, providerPath } = buildEnv();

  const envKeys = ["ZCODE_SESSION_DB_PATH", "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE", "ZCODE_STORAGE_DIR"];
  const saved = envKeys.map((k) => process.env[k]);
  process.env.ZCODE_SESSION_DB_PATH = dbPath;
  process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = providerPath;
  process.env.ZCODE_STORAGE_DIR = join(tmp, "cli");

  const calls = { views: [], commands: [], slots: [], opened: [] };
  const ctx = {
    views: { register: (id, def) => calls.views.push({ id, def }), open: (id) => calls.opened.push(id) },
    commands: { register: (id, fn) => calls.commands.push({ id, fn }) },
    slots: { update: (id, patch, scope) => calls.slots.push({ id, patch, scope }) },
    // 两会话可见：根会话 context.get 正常，子会话抛错——两态样本进同一条采样
    workbench: {
      onDidChange: () => {},
      visibleSessions: async () => ({
        sessions: [
          { sessionId: "sess-root", workspace: "E:\\code\\plugin\\zcode\\ZPowerPack", isDraft: false, focused: true },
          { sessionId: "sess-child", workspace: "E:\\code\\plugin\\zcode\\ZPowerPack", isDraft: false, focused: false },
        ],
      }),
    },
    context: {
      get: async ({ sessionId }) => {
        if (sessionId === "sess-child") throw new Error("上下文不可用(真机形态未知)");
        return { model: { providerId: "bigmodel-api", modelId: "glm-4.7", contextWindow: 200000 } };
      },
    },
  };

  let handle;
  try {
    // 不注入 deps：探测段真实执行（stripPushes 复用现有诊断写盘通道）
    handle = await activate(ctx, { intervalMs: 60000, log: () => {} });
    await new Promise((r) => setTimeout(r, 120)); // 可见会话初值 + 首拍素条落地
    // 夹具事件直驱：事件型 deliver → pushStrips → 逐会话 context.get → 采样写盘
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
    await new Promise((r) => setTimeout(r, 120));

    const diagPath = join(tmp, "cli", "zpowerpack", "v2-probe-diagnostics.json");
    const diagText = readFileSync(diagPath, "utf8");
    const diag = JSON.parse(diagText);
    assert.ok(Array.isArray(diag.stripPushes) && diag.stripPushes.length >= 1, "诊断须含素条推送采样 stripPushes");
    assert.ok(diag.stripPushes.length <= 10, "采样上限 10 条（诊断文件不得无限膨胀）");
    const sample = diag.stripPushes[diag.stripPushes.length - 1];
    assert.equal(typeof sample.at, "string", "采样须带时刻");
    assert.ok(sample.targets.includes("sess-root") && sample.targets.includes("sess-child"), "采样须记录目标会话全集");
    const root = sample.perSession.find((p) => p.sessionId === "sess-root");
    const child = sample.perSession.find((p) => p.sessionId === "sess-child");
    assert.ok(root && child, "两会话均须入采样");
    // 成功路径：context.get 的模型选择原样落盘（providerId/modelId），错误为 null
    assert.deepEqual(root.contextModel, { providerId: "bigmodel-api", modelId: "glm-4.7" }, "context.get 模型选择须原样采样");
    assert.equal(root.contextError, null, "成功路径 contextError 必须为 null");
    assert.equal(root.chosenProviderId, "bigmodel-api", "采样须记录实际采用的供应商");
    assert.equal(root.quotaFound, true, "供应商在规则表内 → quotaFound=true");
    // 异常路径：错误 message 原文是「厂商选择假」定案的关键证据，不得吞掉
    assert.equal(child.contextModel, null, "context.get 失败 → contextModel 为 null");
    assert.ok(typeof child.contextError === "string" && child.contextError.includes("上下文不可用"), "context.get 异常原文必须落盘: " + child.contextError);
    assert.equal(child.chosenProviderId, null, "无上下文且无事件 → 无供应商可跟");
    assert.equal(child.quotaFound, false, "无供应商 → 无额度行");
    // 密钥纪律：采样只含供应商/模型标识，不得出现 apiKey
    assert.ok(!diagText.includes("apiKey"), "诊断文件不得出现 apiKey 字样");
  } finally {
    if (handle) handle.stop();
    envKeys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // 句柄未释放时留待 OS 清理
    }
  }
});

test("集成：空库空配置 → activate 不抛错、display 空态、素条待机", async () => {
  // 真实 schema 但零行数据：首拍回填零行、空窗守卫游标兜底、额度过无 provider 分支
  const tmp = mkdtempSync(join(tmpdir(), "zp-integ-empty-"));
  const dbPath = join(tmp, "db.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE model_usage (${MU_COLS})`);
  db.exec(
    `CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, path TEXT, title TEXT, project_id TEXT,
     parent_id TEXT, time_created INTEGER, time_updated INTEGER)`,
  );
  db.close();

  const envKeys = ["ZCODE_SESSION_DB_PATH", "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE", "ZCODE_STORAGE_DIR"];
  const saved = envKeys.map((k) => process.env[k]);
  process.env.ZCODE_SESSION_DB_PATH = dbPath;
  // provider 配置路径指向不存在的文件：激活走「未找到 provider 配置」分支（额度卡空态）
  process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = join(tmp, "provider_config.json");
  process.env.ZCODE_STORAGE_DIR = join(tmp, "cli");

  const calls = { views: [], commands: [], slots: [], opened: [] };
  const ctx = {
    views: { register: (id, def) => calls.views.push({ id, def }), open: (id) => calls.opened.push(id) },
    commands: { register: (id, fn) => calls.commands.push({ id, fn }) },
    slots: { update: (id, patch, scope) => calls.slots.push({ id, patch, scope }) },
  };

  let handle;
  try {
    handle = await activate(ctx, { intervalMs: 120, log: () => {} });
    await new Promise((r) => setTimeout(r, 400)); // 3 拍以上：确认空库下拍频稳定不抛错

    // display 空态：界面四区全部退化到诚实空态（不编造数据）
    const display = JSON.parse(calls.views[0].def.resources["zpowerpack://display"].read({ view: {} }));
    assert.equal(display.strip.text, "ZPowerPack 待机", "空库素条=待机");
    assert.equal(display.panel.rate.stateText, "空闲", "空库速率条=空闲");
    assert.deepEqual(display.panel.rate.streams, [], "空库无活跃流");
    assert.deepEqual(display.panel.vendors, [], "无 provider 配置 → 无厂商行");
    assert.equal(display.panel.trend.points.length, 24, "趋势固定 24 点（全零）");
    assert.equal(display.panel.trend.footText, "近 24 小时 · 暂无消耗");
    assert.equal(display.panel.conclusion.text, "消耗速度尚不足以推算");

    // 素条：无 workbench/事件 → 全局待机推送可达
    const slotCalls = calls.slots.filter((s) => s.id === "zpowerpack-mini");
    assert.ok(slotCalls.length >= 1, "空库也应推送素条（待机）");
    assert.equal(slotCalls[slotCalls.length - 1].patch.text, "ZPowerPack 待机");

    // 快照文件兜底：五段契约仍在（空库不产出错误形状）
    const snap = JSON.parse(readFileSync(join(tmp, "cli", "zpowerpack", "last-snapshot.json"), "utf8"));
    assert.deepEqual(snap.quota, [], "空配置额度段为空数组");
    assert.equal(snap.rate.state, "idle", "空库 rate 段为空闲");
  } finally {
    if (handle) handle.stop();
    envKeys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // 句柄未释放时留待 OS 清理
    }
  }
});
