/**
 * 集成测试（Plan 2 Task 10）：临时目录组装真实 schema 的 db.sqlite + provider 配置夹具，
 * 经 env 改道把全部真实路径指向临时目录，activate() 全链跑 3 个轮询周期——
 * 断言快照文件端到端正确、注册资源可读、迷你条推送、且任何输出不含密钥。
 *
 * HTTP 边界排除（Ruling）：provider 夹具无 apiKey → computeQuota 走 unavailable 分支不发请求；
 * 厂商接口已由 quota-fetch.test 注入 fetch 全覆盖，真实联调归真机验收。
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

/** tool_usage 的 E1 列（集成用最小集 + 关键列） */
const TU_COLS = `id INTEGER PRIMARY KEY, session_id TEXT, tool_name TEXT, side_effect_scope TEXT,
  read_only INTEGER, destructive INTEGER, approval_status TEXT, status TEXT, started_at INTEGER,
  first_output_at INTEGER, completed_at INTEGER, duration_ms INTEGER, time_to_first_output_ms INTEGER,
  exit_code INTEGER, output_bytes INTEGER`;

/** 组装临时环境：真实 schema db + provider 夹具 + env 改道，返回路径集合 */
function buildEnv() {
  const tmp = mkdtempSync(join(tmpdir(), "zp-integ-"));
  const dbPath = join(tmp, "db.sqlite");

  // 写连接建表插数后关闭，再由服务层只读打开（与真机 WAL 并发形态一致）
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE model_usage (${MU_COLS})`);
  db.exec(`CREATE TABLE tool_usage (${TU_COLS})`);
  db.exec(
    `CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, path TEXT, title TEXT, project_id TEXT,
     parent_id TEXT, time_created INTEGER, time_updated INTEGER)`,
  );

  const now = Date.now();
  const insMu = db.prepare(
    `INSERT INTO model_usage (session_id, query_source, provider_id, model_id, status, started_at,
     first_token_at, completed_at, duration_ms, time_to_first_token_ms, input_tokens, output_tokens,
     reasoning_tokens, retry_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  // 数据按真实时序落库（rowid≈完成顺序）：3h 前的旧行先插（项目/热力底座），近 60s 新行后插
  // ——若旧行 rowid 靠后，服务层会把「最后一行」当作最近完成时刻（真实库不会这样，夹具须守时序）
  for (let i = 0; i < 8; i++) {
    const completed = now - 3 * 3600000 - (7 - i) * 60000;
    insMu.run("sess-root", "main_turn", "bigmodel-api", "glm-4.7", "completed",
      completed - 1400, completed - 1000, completed, 1400, 400, 900, 220, 10, 0);
  }
  insMu.run("sess-child", "subagent", "bigmodel-api", "glm-4.7", "completed",
    now - 8000, now - 7600, now - 7000, 700, 400, 300, 150, 5, 0);
  insMu.run("sess-root", "main_turn", "bigmodel-api", "glm-4.7", "error",
    now - 6000, null, now - 5000, 5000, null, 500, 0, 0, 1);
  // 近 60s 内 12 行（速率窗口样本），kimi 行最后落库（最近请求厂商断言锚点）
  for (let i = 0; i < 12; i++) {
    const completed = now - (12 - i) * 2000;
    insMu.run("sess-root", "main_turn", i === 11 ? "kimi-code-cn" : "bigmodel-api", "glm-4.7", "completed",
      completed - 1400, completed - 1000, completed, 1400, 400, 900, 220, 10, 0);
  }
  db.exec(
    `INSERT INTO session (id, directory, title, parent_id) VALUES
     ('sess-root', 'E:\\code\\plugin\\zcode\\ZPowerPack', '根会话', NULL),
     ('sess-child', NULL, '子代理', 'sess-root')`,
  );
  const insTu = db.prepare(
    `INSERT INTO tool_usage (session_id, tool_name, status, started_at, duration_ms) VALUES (?,?,?,?,?)`,
  );
  insTu.run("sess-root", "Bash", "ok", now - 30000, 500);
  insTu.run("sess-root", "Read", "ok", now - 20000, 60);
  insTu.run("sess-root", "Bash", "error", now - 10000, 900);
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

test("集成：真实 schema db + provider 夹具 → activate 三周期 → 快照/注册资源/迷你条全链断言", async () => {
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
    await new Promise((r) => setTimeout(r, 620)); // 3 个以上轮询周期
  } finally {
    if (handle) handle.stop();
    envKeys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }

  // ---- ① 快照文件兜底通道：真实路径解析 + 原子写 ----
  const snapshotPath = join(tmp, "cli", "zpowerpack", "last-snapshot.json");
  const snapText = readFileSync(snapshotPath, "utf8");
  const snap = JSON.parse(snapText);
  assert.ok(["live", "held"].includes(snap.rate.display.state), `三态应非 idle：${snap.rate.display.state}`);
  assert.equal(snap.rate.lastProviderId, "kimi-code-cn", "最近请求厂商=最后插入行");
  // Task 1 起 db-reader 行输出收窄为 USED_COLS（TTFT 列已裁）→ V1 直方图降级为空数组；
  // charts 报表随 V2 整体砍除，Task 4 重写 main.js 后本断言随 V1 形态退役
  assert.deepEqual(snap.charts.ttftHist, [], "TTFT 列已裁 → 直方图空数组降级不崩");
  assert.equal(snap.charts.toolStats[0].toolName, "Bash", "工具统计按频次排序");
  assert.equal(snap.charts.toolStats[0].calls, 2);

  // ---- ② 按项目归并：subagent 行经 parent 链归到根会话项目 ----
  const proj = snap.charts.byProject.find((p) => p.project === "E:\\code\\plugin\\zcode\\ZPowerPack");
  assert.ok(proj, "根会话项目应出现在按项目聚合");
  assert.ok(proj.requests > 20, "根会话行数应含 subagent 归并（>20）");

  // ---- ③ 额度引擎：三家实例全出卡（keyless → 官方不可用分支，不发请求） ----
  assert.equal(snap.quota.length, 3);
  const byId = Object.fromEntries(snap.quota.map((q) => [q.providerId, q]));
  assert.equal(byId["bigmodel-api"].windows.length, 2, "智谱=5h+周");
  assert.equal(byId["kimi-code-cn"].windows.length, 2, "Kimi=5h+月");
  assert.equal(byId["opencode-go-messages"].windows.length, 3, "OpenCode=5h+周+月");
  assert.equal(snap.quota[0].source, "unavailable", "无 apiKey → 官方不可用");

  // ---- ④ 注册资源：展示模型端到端可读（真数据绑定） ----
  const display = JSON.parse(calls.views[0].def.resources["zpowerpack://display"].read({ view: {} }));
  assert.ok(parseFloat(display.stage.valueText) > 0, "舞台速率应为正数");
  assert.equal(display.quota.rows.length, 3);
  assert.ok(display.quota.rows.every((r) => r.needsConfig), "keyless → 全部出「配置分母」提示");
  assert.equal(display.grid.tools[0].label, "Bash", "工具下钻数据就位");
  assert.ok(display.mini.text.length <= 40, "迷你条文本合规");

  // ---- ⑤ 密钥零泄漏：快照与展示输出不含 apiKey 字样/键 ----
  assert.ok(!snapText.includes("apiKey"), "快照文件不得出现 apiKey 字样");
  assert.ok(!JSON.stringify(display).includes("apiKey"), "展示模型不得出现 apiKey 字样");
  const raw = JSON.parse(readFileSync(providerPath, "utf8"));
  assert.equal(raw.config.providerConfigRules.providerRules.length, 3, "夹具自检");

  // ---- ⑥ 迷你条推送合规 ----
  const miniCalls = calls.slots.filter((s) => s.id === "zpowerpack-mini");
  assert.ok(miniCalls.length >= 1, "迷你条至少推送一次");
  assert.ok(miniCalls.every((s) => s.patch.text.length <= 40 && s.patch.tooltip.length <= 200));

  // ---- ⑦ 命令注册面（点击状态条回到看板） ----
  const cmd = calls.commands.find((c) => c.id === "zpowerpack-open-dashboard");
  assert.ok(cmd, "迷你条命令已注册");

  // 清理：Windows 下 sqlite 只读句柄释放有延迟，rm 失败容忍（临时目录由 OS 回收）
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // 句柄未释放时留待 OS 清理
  }
});
