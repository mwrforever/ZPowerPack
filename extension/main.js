/**
 * ZPowerPack 扩展服务层：1s 轮询聚合管线 + 视图消费的唯一快照契约（buildSnapshot）。
 *
 * 架构（Plan 2 Task 1 V1 静态结论）：扩展 main 注册视图，数据经快照送达——推送（server factory
 * 资源更新，待探针动态确认 ctx 形态后接线）与拉取式文件（<cliStorageRoot>/zpowerpack/last-snapshot.json
 * 原子写）双通道就绪。运行环境 = 扩展宿主 Node 进程。
 *
 * 快照字段即 Task 8 的渲染契约：rate（三态+主/子代理分列+按模型）、quota（实例×窗口）、
 * charts 七组（吞吐对比/首字等待/上下文→速率/时段热力/按项目/工具统计/厂商稳定性）。
 * 快照序列化结果不得含任何密钥（apiKey 只在 quota-fetch 请求头内出现，永不进入数据流）。
 */

import { writeFileSync, renameSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";

import { windowedRate, displayRate, ema } from "./core/rate.mjs";
import { windowBounds, usageInWindow, percent } from "./core/quota.mjs";
import { fetchLimit } from "./core/quota-fetch.mjs";
import { matchTemplateFamily } from "./core/providers.mjs";
import { resolveDbPath, openDb, fetchNewModelUsage, fetchToolUsage, fetchSessions } from "./core/db-reader.mjs";
import { resolveCliStorageRoot, resolveProviderConfigPath } from "../scripts/migrate/config.mjs";
import RULES from "./core/window-rules.json" with { type: "json" };

/** 速率窗口默认值（§五：窗口时长可配置） */
const RATE_WINDOW_MS = 60000;
/** 环形缓冲保留时长（charts 历史报表的时间底座，24h） */
const BUFFER_RETAIN_MS = 24 * 3600000;

/** 数值保留 2 位 */
const round2 = (n) => Math.round(n * 100) / 100;

/** 分位数（线性插值；sorted 升序数组） */
function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return round2(sorted[0]);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return round2(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}

/** 单请求生成时长（毫秒）：first_token_at 优先，缺失兜底 duration_ms */
function genMsOf(row) {
  if (typeof row.firstTokenAt === "number" && typeof row.completedAt === "number") return row.completedAt - row.firstTokenAt;
  if (typeof row.durationMs === "number") return row.durationMs;
  return 0;
}

/** 产出 token 数：output + reasoning（reasoning 计入产出） */
function outputOf(row) {
  return (row.outputTokens ?? 0) + (row.reasoningTokens ?? 0);
}

/**
 * 构建视图快照（纯函数，唯一输出契约）。
 * @param {{rows: object[], toolRows?: object[], quotaRows?: object[], now: number,
 *          rateState: {prevValue?: number, emaValue?: number, asOf?: number, lastNewRowMs?: number|null},
 *          projectBySession?: Record<string, string>}} input
 *          rows=环形缓冲内的 model_usage 行；quotaRows=额度引擎产出（已剥离密钥）；
 *          projectBySession=sessionId→项目目录（已按 parent 链归到根会话）
 * @returns {{generatedAt: number, rate: object, quota: object[], charts: object}} 序列化安全（无密钥）
 */
export function buildSnapshot(input) {
  const { rows, toolRows = [], quotaRows = [], now, rateState = {}, projectBySession = {} } = input;

  // ---- 速率区：主口径 + main/subagent 分列 + 按模型明细 ----
  const windowed = windowedRate(rows, { now, windowMs: RATE_WINDOW_MS });
  const mainRate = windowedRate(rows.filter((r) => r.querySource !== "subagent"), { now, windowMs: RATE_WINDOW_MS });
  const subRate = windowedRate(rows.filter((r) => r.querySource === "subagent"), { now, windowMs: RATE_WINDOW_MS });

  // EMA 平滑链：上一展示值 → 当前窗口值，再进三态判定
  const currentValue = windowed.genRate !== null ? ema(rateState.emaValue ?? rateState.prevValue ?? 0, windowed.genRate) : null;
  const display = displayRate(
    {
      currentValue,
      prevValue: rateState.prevValue ?? 0,
      asOf: rateState.asOf ?? 0,
      sampleDurationMs: windowed.sampleDurationMs,
      lastNewRowMs: rateState.lastNewRowMs,
    },
    { now },
  );

  // byModel：数组化并按最近完成行降序（视图明细行顺序契约）
  const byModel = [...windowed.byModel.entries()]
    .map(([modelId, v]) => ({ modelId, ...v }))
    .sort((a, b) => b.lastCompletedAt - a.lastCompletedAt);

  const rate = {
    main: { genRate: mainRate.genRate, throughput: mainRate.throughput },
    subagent: { genRate: subRate.genRate, throughput: subRate.throughput },
    windowed: { genRate: windowed.genRate, throughput: windowed.throughput, sampleDurationMs: windowed.sampleDurationMs },
    byModel,
    display,
  };

  // ---- 额度区：透传额度引擎产出（shape 固定为视图契约）----
  const quota = quotaRows.map((q) => ({
    providerId: q.providerId,
    name: q.name,
    windows: (q.windows ?? []).map((w) => ({
      type: w.type,
      percent: w.percent,
      used: w.used,
      limit: w.limit,
      source: w.source,
      nextResetMs: w.nextResetMs ?? null,
    })),
    nextResetMs: q.nextResetMs ?? null,
    percent: q.percent ?? null,
    source: q.source,
  }));

  // ---- charts 七组（24h 环形缓冲为底座；界面文案映射在视图层做，快照保留标准名）----
  const completed = rows.filter((r) => r.status === "completed" && genMsOf(r) > 0 && outputOf(r) > 0);

  // 吞吐对比：按模型 tps 分位数 + 平均延迟
  const byModelAgg = new Map();
  for (const r of completed) {
    const key = r.modelId ?? "(未知模型)";
    const agg = byModelAgg.get(key) ?? { tpsList: [], latencyList: [] };
    agg.tpsList.push((outputOf(r) / genMsOf(r)) * 1000);
    if (typeof r.timeToFirstTokenMs === "number") agg.latencyList.push(r.timeToFirstTokenMs);
    byModelAgg.set(key, agg);
  }
  const throughput = [...byModelAgg.entries()].map(([modelId, a]) => {
    const sorted = [...a.tpsList].sort((x, y) => x - y);
    return {
      modelId,
      tpsP50: quantile(sorted, 0.5),
      tpsP95: quantile(sorted, 0.95),
      avgLatencyMs: a.latencyList.length ? round2(a.latencyList.reduce((s, x) => s + x, 0) / a.latencyList.length) : null,
      samples: sorted.length,
    };
  });

  // 首字等待：按模型 TTFT 分位数（缺失该列时降级为空数组）
  const latency = [...byModelAgg.entries()]
    .filter(([, a]) => a.latencyList.length > 0)
    .map(([modelId, a]) => {
      const sorted = [...a.latencyList].sort((x, y) => x - y);
      return { modelId, ttftP50: quantile(sorted, 0.5), ttftP95: quantile(sorted, 0.95), samples: sorted.length };
    });

  // 上下文→速率散点（input_tokens vs tps）
  const ctxVsRate = completed.map((r) => ({
    inputTokens: r.inputTokens ?? 0,
    tps: round2((outputOf(r) / genMsOf(r)) * 1000),
    modelId: r.modelId ?? "(未知模型)",
  }));

  // 按项目：sessionId → 根会话项目目录聚合
  const byProjectMap = new Map();
  for (const r of rows) {
    const project = projectBySession[r.sessionId] ?? "(未知项目)";
    const agg = byProjectMap.get(project) ?? { project, tokens: 0, requests: 0 };
    agg.tokens += (r.inputTokens ?? 0) + outputOf(r);
    agg.requests++;
    byProjectMap.set(project, agg);
  }
  const byProject = [...byProjectMap.values()].sort((a, b) => b.tokens - a.tokens);

  // 工具统计：频次/耗时/错误
  const toolMap = new Map();
  for (const t of toolRows) {
    const name = t.toolName ?? "(未知工具)";
    const agg = toolMap.get(name) ?? { toolName: name, calls: 0, errors: 0, totalDurationMs: 0 };
    agg.calls++;
    if (t.status && t.status !== "ok" && t.status !== "success") agg.errors++;
    agg.totalDurationMs += t.durationMs ?? 0;
    toolMap.set(name, agg);
  }
  const toolStats = [...toolMap.values()]
    .map((t) => ({ ...t, avgDurationMs: t.calls ? round2(t.totalDurationMs / t.calls) : 0 }))
    .sort((a, b) => b.calls - a.calls);

  // 厂商稳定性：error 率 + 重试率（按 providerId）
  const healthMap = new Map();
  for (const r of rows) {
    const agg = healthMap.get(r.providerId) ?? { providerId: r.providerId, requests: 0, errors: 0, retries: 0 };
    agg.requests++;
    if (r.status === "error") agg.errors++;
    if ((r.retryCount ?? 0) > 0) agg.retries++;
    healthMap.set(r.providerId, agg);
  }
  const providerHealth = [...healthMap.values()].map((h) => ({
    providerId: h.providerId,
    requests: h.requests,
    errorRate: h.requests ? round2(h.errors / h.requests) : 0,
    retryRate: h.requests ? round2(h.retries / h.requests) : 0,
  }));

  // 时段热力图：7×24（本地时区，星期×小时，token 总量）
  const heatmap = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const r of rows) {
    const t = typeof r.startedAt === "number" ? r.startedAt : r.completedAt;
    if (typeof t !== "number") continue;
    const d = new Date(t);
    heatmap[d.getDay()][d.getHours()] += (r.inputTokens ?? 0) + outputOf(r);
  }

  return {
    generatedAt: now,
    rate,
    quota,
    charts: { throughput, latency, ctxVsRate, byProject, toolStats, providerHealth, heatmap },
  };
}

/**
 * 单个轮询周期：拉增量 → 入环形缓冲 → 裁剪 → 构建快照 → 送达视图（推送/文件兜底）。
 * 供 activate() 的定时器调用；测试直接驱动本函数。
 * @param {object} state 可变服务状态 {cursor, toolCursor, rows, prevValue, emaValue, asOf, lastNewRowMs, projectBySession}
 * @param {{fetchNew: Function, fetchTools: Function, fetchQuota: Function, fetchSessions: Function,
 *          deliver?: Function, snapshotPath?: string, now?: Function, log?: Function}} deps 全部可注入
 */
export async function tick(state, deps) {
  const now = (deps.now ?? Date.now)();
  const log = deps.log ?? (() => {});
  try {
    // 增量拉取（rowid 游标）
    const { rows: newRows, nextCursor } = await deps.fetchNew(state.cursor);
    if (newRows.length > 0) {
      state.rows.push(...newRows);
      state.cursor = nextCursor;
      state.lastNewRowMs = newRows[newRows.length - 1].completedAt ?? now;
    }
    // 环形缓冲裁剪：仅保留 BUFFER_RETAIN_MS 内的行（24h 报表底座）
    const cutoff = now - BUFFER_RETAIN_MS;
    while (state.rows.length > 0 && (state.rows[0].completedAt ?? 0) < cutoff) state.rows.shift();

    const [toolRows, quotaRows, sessionRows] = await Promise.all([
      deps.fetchTools(state.toolCursor ?? 0),
      deps.fetchQuota(now, state.rows),
      deps.fetchSessions(),
    ]);
    if (sessionRows.length > 0) state.projectBySession = resolveProjects(sessionRows);

    const snapshot = buildSnapshot({
      rows: state.rows,
      toolRows,
      quotaRows,
      now,
      rateState: state,
      projectBySession: state.projectBySession ?? {},
    });

    // 平滑链推进：display.value 已按三态取值（held/idle 保持 prevValue），作为下轮基准
    state.prevValue = snapshot.rate.display.value;
    state.emaValue = snapshot.rate.windowed.genRate !== null ? snapshot.rate.windowed.genRate : state.emaValue;
    state.asOf = state.lastNewRowMs ?? state.asOf;
    if (toolRows.length > 0) state.toolCursor = toolRows[toolRows.length - 1].startedAt ?? state.toolCursor ?? 0;

    // 送达：宿主推送（server factory 资源更新）与文件兜底（原子写）双通道
    if (deps.deliver) deps.deliver(snapshot);
    if (deps.snapshotPath) writeSnapshotFile(deps.snapshotPath, snapshot);
    log(`[看板] 快照已构建：rate=${snapshot.rate.display.state}，quota=${snapshot.quota.length} 实例，缓冲 ${state.rows.length} 行`);
  } catch (e) {
    // 轮询失败不致命：下一周期重试；日志不含数据细节
    log(`[看板] 轮询周期失败（${e?.name || "异常"}）：${e?.message ?? ""}`);
  }
}

/** sessionId→项目目录：parent 链上溯到根会话，取根会话 directory；无 directory 用标题 */
function resolveProjects(sessionRows) {
  const byId = new Map(sessionRows.map((s) => [s.id, s]));
  const out = {};
  for (const s of sessionRows) {
    let cur = s;
    const seen = new Set();
    while (cur?.parentId && byId.has(cur.parentId) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.parentId);
    }
    out[s.id] = cur?.directory ?? cur?.title ?? "(未知项目)";
  }
  return out;
}

/** 快照文件原子写（视图拉取式兜底） */
function writeSnapshotFile(path, snapshot) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify(snapshot), "utf8");
    renameSync(tmp, path);
  } catch {
    // 文件兜底失败不影响推送通道
  }
}

/**
 * 启动轮询服务（扩展激活入口调用）。
 * @param {{intervalMs?: number, deliver?: Function, snapshotPath?: string, log?: Function,
 *          deps?: object}} opts deps 缺省时绑定真实数据源（db-reader/额度引擎）
 * @returns {{stop: Function}} 供停用
 */
export function start(opts = {}) {
  const intervalMs = opts.intervalMs ?? 1000;
  const log = opts.log ?? ((l) => console.log(l));
  const deps = opts.deps ?? realDeps(log);
  const state = { cursor: 0, toolCursor: 0, rows: [], prevValue: 0, emaValue: 0, asOf: 0, lastNewRowMs: null, projectBySession: {} };
  const runTick = () => void tick(state, { ...deps, deliver: opts.deliver, snapshotPath: opts.snapshotPath, log });
  const timer = setInterval(runTick, intervalMs);
  // 立即跑第一轮，避免首屏等一个间隔
  runTick();
  return { stop: () => clearInterval(timer) };
}

/** 读取 provider_config 文档（内存引用，不落日志；读不到返回 null） */
function readProviderDoc(path) {
  try {
    if (!existsSync(path)) return null;
    let text = readFileSync(path, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 额度计算：每实例 × 每窗口（规则表按家族路由）→ 官方分母优先 + 本地分子聚合。
 * @param {object|null} providerDoc provider_config.json 文档（含 apiKey，仅在内存引用）
 * @param {number} now 当前时刻
 * @param {object[]} rows 环形缓冲行（本地分子）
 * @param {Function} log 日志
 * @returns {Promise<object[]>} quotaRows（buildSnapshot 输入；无密钥）
 */
async function computeQuota(providerDoc, now, rows, log) {
  const rulesList = providerDoc?.config?.providerConfigRules?.providerRules;
  if (!Array.isArray(rulesList)) return [];
  const out = [];
  for (const inst of rulesList) {
    if (!inst || typeof inst.providerId !== "string") continue;
    const family = matchTemplateFamily(inst.templateId);
    // 窗口组合：具体 templateId 键优先于家族键；无规则（含 Qwen）→ 不出额度卡
    const windows = RULES[inst.templateId] ?? RULES[family];
    if (!Array.isArray(windows) || windows.length === 0) continue;

    const apiKeyRef = inst?.config?.access?.apiKey ?? null;
    const computed = [];
    for (const rule of windows) {
      // 官方分母优先（密钥只进请求头）；用户配置兜底留插件配置接入点（quota.userLimits，后续版本）
      const official = apiKeyRef
        ? await fetchLimit({ family, templateId: inst.templateId, apiKeyRef, rule, userLimit: null, log })
        : { limit: null, percent: null, nextResetMs: null, source: "unavailable" };
      const bounds = windowBounds(rule, now, { nextResetMs: official.nextResetMs });
      const usage = usageInWindow(rows, { providerId: inst.providerId, bounds });
      const used = usage.input + usage.output;
      computed.push({
        type: rule.type,
        used,
        limit: official.limit,
        // 官方百分比优先（与厂商窗口口径一致）；否则本地 used/limit 近似
        percent: official.percent ?? percent(used, official.limit),
        source: official.source,
        nextResetMs: official.nextResetMs,
        requests: usage.requests,
      });
    }

    // 主百分比取 rolling-5h 窗口（额度卡标题口径）
    const rolling = computed.find((w) => w.type === "rolling-5h") ?? computed[0];
    const resets = computed.map((w) => w.nextResetMs).filter((t) => typeof t === "number");
    out.push({
      providerId: inst.providerId,
      name: inst.providerName ?? inst.providerId,
      windows: computed,
      nextResetMs: resets.length ? Math.min(...resets) : null,
      percent: rolling?.percent ?? null,
      source: rolling?.source ?? "unavailable",
    });
  }
  return out;
}

/** 真实数据源绑定（扩展宿主内运行；路径解析与迁移向导共用 config.mjs 规则） */
function realDeps(log) {
  const homedir = os.homedir();
  const opened = openDb(resolveDbPath(process.env, homedir));
  if (!opened.db) log("[看板] 未找到官方遥测库（db.sqlite），看板将显示空态");
  // provider 文档读入内存一次，apiKey 仅在额度请求头内即时引用，绝不进入快照/日志
  const providerDoc = readProviderDoc(resolveProviderConfigPath(process.env, homedir));
  if (!providerDoc) log("[看板] 未找到 provider 配置（provider_config.json），额度卡不可用");

  return {
    fetchNew: async (cursor) => (opened.db ? fetchNewModelUsage(opened.db, opened.schema, cursor) : { rows: [], nextCursor: cursor }),
    fetchTools: async (sinceMs) => (opened.db ? fetchToolUsage(opened.db, opened.schema, sinceMs) : []),
    fetchSessions: async () => (opened.db ? fetchSessions(opened.db, opened.schema) : []),
    fetchQuota: async (now, rows) => computeQuota(providerDoc, now, rows, log),
    log,
  };
}

/** 默认快照落盘位置：<cliStorageRoot>/zpowerpack/last-snapshot.json（拉取式兜底通道） */
function defaultSnapshotPath() {
  return join(resolveCliStorageRoot(process.env, os.homedir()), "zpowerpack", "last-snapshot.json");
}

/**
 * 扩展激活入口：注册看板视图并启动轮询服务。
 * 说明：server factory 推送通道的 ctx 形态待探针动态确认后接线；当前以 entry 视图 + 快照文件
 * 双保险起步（activate 内不抛错，任何失败降级为空态看板）。
 * @param {object} ctx 扩展上下文（views/commands/slots 宿主 API）
 */
export async function activate(ctx) {
  try {
    ctx.views.register("zpowerpack-dashboard", { entry: "extension/view/index.html" });
  } catch (e) {
    console.warn(`[ZPowerPack] 视图注册失败（${e?.name || "异常"}）：${e?.message ?? ""}`);
  }
  try {
    start({ snapshotPath: defaultSnapshotPath(), log: (l) => console.log(l) });
  } catch (e) {
    console.warn(`[ZPowerPack] 轮询服务启动失败（${e?.name || "异常"}）：${e?.message ?? ""}`);
  }
}
