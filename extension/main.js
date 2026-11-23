/**
 * ZPowerPack 扩展服务层（V2）：60s 拍增量聚合 + 官方流式事件驱动实时速率 + 视图消费的唯一快照契约。
 *
 * 架构（V2 重设计定案，docs/superpowers/specs/2026-11-22-zpowerpack-dashboard-v2-design.md）：
 * - 实时速率：官方 models.onDidGenerate 流式事件直录（live-rate 状态机），无 EMA/无窗口加权/
 *   无三态保持——展示值=官方推送值原样；订阅绑定由本模块 bindOnGenerate 接线（候选形态
 *   先成功者胜，全败降级兜底链）；素条按会话作用域推送（2026-11-23 修订 #1：workbench
 *   感知可见会话 + events 的 sessionId 过滤，slots.update 第三参 {sessionId}）；
 * - 聚合层：db 只做 60s rowid 增量拉取落小时桶（hourly.mjs），激活首拍有界回填近 24h
 *   （禁 V1 游标 0 全量拉 8 万行的卡顿事故重演）；24h 趋势与 5h 额度兜底分子同源小时桶，
 *   任何时刻不重扫全量缓冲；charts 八报表全量计算退役；
 * - 额度层：官方接口 60s 一拉（TTL 缓存 + quotaPending 手动同步待办，sync 注册资源置位即拉）；
 *   本地分子兜底收窄至 5h 窗口（§五.3 裁量），周/月官方失败只出状态句；tooltip 额度跟随
 *   聚焦会话当前模型选择的供应商（修订 #2：context.get，null 回退该会话最近请求供应商）；
 * - 快照契约 buildSnapshotV2：{generatedAt, rate, quota, trend, conclusion}，序列化安全无密钥
 *   （apiKey 只在额度请求头内出现，永不进入数据流）；
 * - 快照文件（<cliStorageRoot>/zpowerpack/last-snapshot.json 原子写）保留为兜底通道；
 *   视图推送链（§五.8）：onDidOpen 存 notify 句柄，数据更新一律 notify display。
 * 运行环境 = 扩展宿主 Node 进程，单线程事件循环（状态无并发风险，防重入护栏防定时器叠加）。
 */

import { writeFileSync, renameSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";

import { windowBounds, percent } from "./core/quota.mjs";
import { fetchLimit } from "./core/quota-fetch.mjs";
import { matchTemplateFamily } from "./core/providers.mjs";
import { resolveDbPath, openDb, fetchNewModelUsage, fetchRecentModelUsage, fetchMaxRowid, fetchSessions, subagentSessionIds } from "./core/db-reader.mjs";
import { newBuckets, addRow, prune, trendPoints, windowSum } from "./core/hourly.mjs";
import { createLiveRate } from "./core/live-rate.mjs";
import { toDisplayModelV2 } from "./view-model.mjs";
import { resolveCliStorageRoot, resolveProviderConfigPath } from "../scripts/migrate/config.mjs";
import RULES from "./core/window-rules.json" with { type: "json" };

/** 60s 拍间隔（设计 §五.3：速率靠事件、趋势小时粒度、额度 60s 自动——看板开关不影响拍频） */
const TICK_MS = 60000;
/** 额度官方接口节流间隔（60 秒）：官方窗口分钟级动态，逐拍重打易触发厂商限流 */
const QUOTA_TTL_MS = 60000;
/** session 表全量重读节流间隔（60 秒）：会话元数据变化低频，主/子代理归属判定走缓存 */
const SESSIONS_TTL_MS = 60000;
/** 事件型 deliver 节流间隔（毫秒）：流式期官方每秒多推，一秒内仅重建一次快照（事件风暴护栏） */
const EVENT_THROTTLE_MS = 1000;
/** 首拍有界回填窗口（近 24h）：一次性查询落桶即弃，游标从回填行最大 rowid 起步 */
const BACKFILL_MS = 24 * 3600000;
/** 滞留流收口阈值：流事件静默超 10 分钟即视为宿主丢失 final（控制者裁决，T3 审查 Minor #4） */
const STALE_STREAM_MS = 10 * 60000;
/** 结论采样序列长度上限：60s 一拉 × 30 ≈ 近 30 分钟官方 percent（结论外推的时间底座） */
const PERCENT_HISTORY_MAX = 30;
/** 结论外推最少采样数：<5 个不给推算（样本不足由 view-model 出诚实占位句） */
const CONCLUSION_MIN_SAMPLES = 5;

/**
 * 新建服务状态（tickV2/事件入口的唯一可变载体，快照全部数据源）。
 * @returns {{cursor: number|null, buckets: Map, live: object, subagentIds: Set<string>,
 *           sessionsAt: number, quotaRows: object[], quotaAt: number,
 *           percentHistory: Map<string, Array<{t: number, pct: number}>>, quotaPending: boolean}}
 *          cursor=null 标记首拍未回填（首拍走有界回填后恒为数值）；
 *          percentHistory=providerId→官方 percent 采样序列（≤30 个）；
 *          quotaPending=手动同步待办（Task 6 的 sync 资源 read 回调置位，本拍绕过 TTL 即拉）
 */
export function createState() {
  return {
    cursor: null,
    buckets: newBuckets(),
    live: createLiveRate(),
    subagentIds: new Set(),
    sessionsAt: 0,
    quotaRows: [],
    quotaAt: 0,
    percentHistory: new Map(),
    quotaPending: false,
  };
}

/**
 * 构建视图快照 V2（纯函数，唯一输出契约；输入形状与 view-model toDisplayModelV2 的消费契约一致）。
 * @param {{liveSnapshot: object, quotaRows?: object[], trend?: object[], conclusion?: object|null,
 *          now: number}} input
 *          liveSnapshot=live-rate snapshot 原样（state/streams/totalTps/subTps/lastEventAt/
 *          lastProviderId/lastFinal/fallback）；quotaRows=额度引擎产出（已剥离密钥）；
 *          trend=hourly trendPoints 24 点；conclusion=computeConclusion 产物或 null
 * @returns {{generatedAt: number, rate: object, quota: object[], trend: object[], conclusion: object|null}}
 *          序列化安全（无密钥）；无 charts 键（八报表随 V2 退役）
 */
export function buildSnapshotV2(input) {
  const { liveSnapshot, quotaRows = [], trend = [], conclusion = null, now } = input;
  // rate=live-rate snapshot 原样带出；唯一数据侧裁量：final 末值更新时压制过期兜底行
  // （T5 审查集成确认——idle+fallback 且 lastFinal 更新时视图不得再显示兜底旧值；
  // view-model 按「谁新取谁」取末值，数据侧保证 lastFinal 恒优先即可，兜底行仅在
  // 比最后 final 更新时才供视图取值=订阅挂掉后的接管形态）
  const rate = { ...liveSnapshot };
  if (rate.fallback && rate.lastFinal && rate.lastFinal.at >= rate.fallback.completedAt) {
    rate.fallback = null;
  }
  // quota 形状沿用 V1 透传：实例/窗口契约键固定，额度引擎内部字段剥离、nextResetMs 归一 null
  const quota = (quotaRows ?? []).map((q) => ({
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
  return { generatedAt: now, rate, quota, trend, conclusion };
}

/**
 * 结论句外推（纯函数）：对 5h 水位最高的实例，用官方 percent 采样首尾斜率线性外推至重置时刻。
 * 「撑得到/撑不到」的措辞由 view-model 完成；本函数只产出数值与诚实边界。
 * @param {object[]} quotaRows 额度引擎产出（percent=rolling-5h 口径的当前水位）
 * @param {Map<string, Array<{t: number, pct: number}>>} percentHistory
 *        providerId→采样序列（时间递增、≤30 个；官方失败样本不入列）
 * @param {number} now 当前时刻（epoch 毫秒；重置时刻已过则外推无意义）
 * @returns {{instanceName: string, pctNow: number, pctAtReset: number, resetMs: number}|null}
 *          样本 <5、增量≈0、无时间跨度、无官方重置时刻或重置已过 → null
 *          （「消耗速度尚不足以推算」占位由 view-model 处理，不在这里编造）
 */
export function computeConclusion(quotaRows, percentHistory, now) {
  // 取 5h 水位最高的实例作为外推对象（快照契约 percent=rolling-5h 口径）
  let top = null;
  for (const q of quotaRows ?? []) {
    if (typeof q?.percent !== "number") continue;
    if (top === null || q.percent > top.percent) top = q;
  }
  if (top === null) return null;
  const samples = percentHistory?.get(top.providerId) ?? [];
  if (samples.length < CONCLUSION_MIN_SAMPLES) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  // 采样无时间跨度（同刻多样本）→ 斜率不可求，不编造
  if (!(last.t > first.t)) return null;
  // 增量 ≈0 → 水位静止无法推算（官方 percent 精度 0.1，慢消耗 30 分钟零增量是真实形态）
  const delta = last.pct - first.pct;
  if (!(Math.abs(delta) > 0)) return null;
  // 重置时刻以官方为唯一权威：无官方 nextResetMs 或已过重置 → 无处外推
  const head = (top.windows ?? []).find((w) => w?.type === "rolling-5h") ?? (top.windows ?? [])[0] ?? null;
  const resetMs = head?.nextResetMs;
  if (typeof resetMs !== "number" || !Number.isFinite(resetMs) || resetMs <= now) return null;
  // 线性外推：首尾斜率推至重置时刻（界面标注「推算」，非精确预言）
  const slope = delta / (last.t - first.t); // 百分点/毫秒
  const pctAtReset = last.pct + slope * (resetMs - last.t);
  return {
    instanceName: top.name ?? top.providerId,
    pctNow: last.pct,
    // 与官方 percent 同精度（0.1 百分点），避免视图出现长尾小数
    pctAtReset: Math.round(pctAtReset * 10) / 10,
    resetMs,
  };
}

/**
 * 单个轮询周期（60s 拍）：数据拉取（首拍回填/增量）→落桶→滞留收口→会话刷新→
 * 额度拉取→percentHistory 追加→快照→送达（推送/文件兜底）。
 * 供 activate 的定时器调用；测试直接驱动本函数（节奏常量由 start 的 intervalMs 注入覆盖）。
 * @param {object} state createState 产物（可变服务状态）
 * @param {{fetchRecent: Function, fetchMaxRowid: Function, fetchNew: Function,
 *          fetchSessions: Function, fetchQuota: Function, deliver?: Function,
 *          snapshotPath?: string, now?: Function, log?: Function}} deps 全部可注入
 */
export async function tickV2(state, deps) {
  const now = (deps.now ?? Date.now)();
  const log = deps.log ?? (() => {});
  try {
    // ---- ① 数据拉取：首拍有界回填，其后 rowid 增量 ----
    if (state.cursor == null) {
      // 首拍回填：近 24h 一次性有界查询，行落桶即弃（游标与桶不做跨重启持久化，
      // 重启代价=一次有界回填；V1 游标 0 全量拉 8 万行是卡顿根因，禁止重演）
      const { rows, maxRowid } = await deps.fetchRecent(now - BACKFILL_MS);
      for (const row of rows) addRow(state.buckets, row);
      // 空窗回填守卫（T1 审查真风险）：有历史但 24h 无新行时回填零行、maxRowid=0，
      // 若游标照抄 0，首拍增量会从 0 全量拉 8 万历史行——改用全表 MAX(rowid) 初始化
      state.cursor = maxRowid > 0 ? maxRowid : await deps.fetchMaxRowid();
      noteNewestFallback(state, rows);
      log(`[看板] 首拍回填完成：${rows.length} 行落桶，增量游标=${state.cursor}`);
    } else {
      const { rows: newRows, nextCursor } = await deps.fetchNew(state.cursor);
      if (newRows.length > 0) {
        // 增量行 O(1) 落小时桶（24h 趋势与 5h 兜底分子同源），不持有行数组
        for (const row of newRows) addRow(state.buckets, row);
        state.cursor = nextCursor;
        noteNewestFallback(state, newRows);
      }
    }
    // 桶裁剪：每实例仅保留 25 小时桶（当前+前 24h），防长期运行内存增长
    prune(state.buckets, now);

    // 滞留流守卫：宿主丢失 final 事件的流按 final 收口（详见函数注释）
    closeStaleStreams(state, now, log);

    // ---- ② 会话刷新（60s 节流）：主/子代理归属判定的唯一数据源 ----
    if (now - (state.sessionsAt ?? 0) >= SESSIONS_TTL_MS) {
      const sessionRows = await deps.fetchSessions();
      state.sessionsAt = now;
      state.subagentIds = subagentSessionIds(sessionRows);
    }

    // ---- ③ 额度拉取（60s 节流；手动同步待办绕过 TTL 即拉） ----
    let quotaRows = state.quotaRows ?? [];
    if (state.quotaPending || now - (state.quotaAt ?? 0) >= QUOTA_TTL_MS) {
      quotaRows = await deps.fetchQuota(now, state.buckets);
      state.quotaRows = quotaRows;
      state.quotaAt = now;
      // 拉取成功才清待办；失败保留，下一拍重试（sync 的即时性承诺不因单次失败丢失）
      state.quotaPending = false;
      // 官方 percent 采样入列（结论外推底座）；缓存期不重复入列防零增量稀释斜率
      appendPercentHistory(state.percentHistory, quotaRows, now);
    }

    // ---- ④ 快照组装 + 送达（宿主推送/文件兜底双通道） ----
    const snapshot = assembleAndDeliver(state, quotaRows, now, deps);
    log(`[看板] 快照已构建：rate=${snapshot.rate.state}，quota=${snapshot.quota.length} 实例，游标=${state.cursor}`);
  } catch (e) {
    // 轮询失败不致命：状态保持上一拍口径，下一周期重试；日志不含数据细节
    log(`[看板] 轮询周期失败（${e?.name || "异常"}）：${e?.message ?? ""}`);
  }
}

/**
 * 官方生成事件入口工厂（activate 在 Task 6 绑定到宿主 models.onDidGenerate 订阅）。
 * live.onEvent 恒执行（流状态机直录官方推送值，节流不吞事件）；快照重建与 deliver
 * 按 EVENT_THROTTLE_MS 节流：一秒内多事件仅一次重建（事件风暴护栏，60s 拍兜底收尾）。
 * @param {object} state createState 产物（读取 quotaRows/buckets/percentHistory 组装快照）
 * @param {{deliver?: Function, snapshotPath?: string, log?: Function}} deps 送达通道
 * @returns {(ev: object, now?: number) => void} 事件处理函数（now 缺省取宿主到达时刻）
 */
export function createOnGenerateEvent(state, deps = {}) {
  // 节流时钟：仅统计「事件型」deliver（60s 拍的 deliver 不占事件窗口，速率变化即时上屏）
  let lastDeliverAt = 0;
  return (ev, now = Date.now()) => {
    const log = deps.log ?? (() => {});
    try {
      // 事件恒直录流状态机（官方推送值原样，无平滑）——subagentIds 由 60s 拍刷新
      state.live.onEvent(ev, now, state.subagentIds);
      // 距上次事件型 deliver < 1s → 只更新 live，不重建快照
      if (now - lastDeliverAt < EVENT_THROTTLE_MS) return;
      lastDeliverAt = now;
      assembleAndDeliver(state, state.quotaRows ?? [], now, deps);
    } catch (e) {
      // 事件回调异常不外抛宿主：订阅通道不因单次组装失败而中断
      log(`[看板] 事件处理失败（${e?.name || "异常"}）：${e?.message ?? ""}`);
    }
  };
}

/**
 * 组装快照并送达（tickV2 与事件入口共用的唯一出口：构建→deliver→文件兜底）。
 * @param {object} state 服务状态
 * @param {object[]} quotaRows 本拍额度产出（增量拍用缓存行，事件拍用 state 缓存）
 * @param {number} now 本拍时刻（epoch 毫秒）
 * @param {{deliver?: Function, snapshotPath?: string}} deps 送达通道
 * @returns {object} 快照（{generatedAt, rate, quota, trend, conclusion}）
 */
function assembleAndDeliver(state, quotaRows, now, deps) {
  const snapshot = buildSnapshotV2({
    liveSnapshot: state.live.snapshot(now),
    quotaRows,
    trend: trendPoints(state.buckets, now),
    conclusion: computeConclusion(quotaRows, state.percentHistory, now),
    now,
  });
  if (deps.deliver) deps.deliver(snapshot);
  if (deps.snapshotPath) writeSnapshotFile(deps.snapshotPath, snapshot);
  return snapshot;
}

/**
 * 兜底链（§五.5）：把本拍最新完成行喂给 live-rate 兜底入口。
 * 订阅链正常时官方 final 末值（lastFinal）恒更新，buildSnapshotV2 会按「lastFinal 恒优先」
 * 压制过期兜底行，故无条件喂入安全；订阅挂掉后兜底行（比 lastFinal 新）自动接管速率条。
 * @param {object} state 服务状态
 * @param {object[]} rows 本拍新增/回填行（rowid 升序，末位最新；可为空数组）
 */
function noteNewestFallback(state, rows) {
  // 倒序找最新「完成」行：error 行产出为 0，速率算不出真实值，不入兜底链
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]?.status === "completed") {
      state.live.noteFallbackRow(rows[i]);
      return;
    }
  }
}

/**
 * 滞留流守卫（每拍）：流事件静默超 10 分钟的流按 final 收口——记 lastFinal 末值、删流。
 * 依据（T3 审查 Minor #4 控制者裁决）：宿主若丢失 final 事件，流会永久滞留致 state 恒 live
 * （「看起来在动但数据没动」的反目标形态）。live-rate 流对象不带各自时间戳（公开契约无此键），
 * 以状态机级 lastEventAt（任意事件都会刷新）作全部滞留流的静默时钟：任一流活跃都会顶新时钟，
 * 故「时钟停超 10 分钟」必意味着全部现存流都已滞留。收口走 onEvent 公开契约（不侵入
 * live-rate 内部）：合成 final 使状态机自然记末值、删流并转入 recent 态。
 * @param {object} state 服务状态
 * @param {number} now 本拍时刻（epoch 毫秒）
 * @param {Function} log 日志
 */
function closeStaleStreams(state, now, log) {
  const snap = state.live.snapshot(now);
  if (snap.streams.length === 0) return;
  if (snap.lastEventAt === null || now - snap.lastEventAt <= STALE_STREAM_MS) return;
  for (const s of snap.streams) {
    // 合成 final 事件：速率取流上末次官方推送值；产出数缺失按契约置 null（保形稳定）
    state.live.onEvent(
      {
        requestId: s.requestId,
        model: { providerId: s.providerId, modelId: s.modelId },
        phase: "final",
        outputTokensPerSecond: s.tps,
      },
      now,
      state.subagentIds,
    );
  }
  log(`[看板] ${snap.streams.length} 路流静默超 10 分钟，按 final 收口（宿主 final 丢失守卫）`);
}

/**
 * 官方 percent 采样入列（结论外推底座；仅在额度实际拉取后调用）。
 * @param {Map<string, Array<{t: number, pct: number}>>} percentHistory 采样序列集（原地更新）
 * @param {object[]} quotaRows 本拍额度产出
 * @param {number} now 采样时刻（epoch 毫秒）
 */
function appendPercentHistory(percentHistory, quotaRows, now) {
  for (const q of quotaRows ?? []) {
    // 官方失败（percent=null）不入列：null 会污染外推斜率，也不该假装有水位
    if (typeof q?.percent !== "number") continue;
    const list = percentHistory.get(q.providerId) ?? [];
    list.push({ t: now, pct: q.percent });
    // 只保留最近 30 个采样（先进先出，时间恒递增）
    if (list.length > PERCENT_HISTORY_MAX) list.splice(0, list.length - PERCENT_HISTORY_MAX);
    percentHistory.set(q.providerId, list);
  }
}

/** 快照文件原子写（视图拉取式兜底通道） */
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
 * 启动轮询服务（扩展激活入口调用；测试经 intervalMs 注入短间隔覆盖 60s 节奏）。
 * @param {{intervalMs?: number, deliver?: Function, snapshotPath?: string, log?: Function,
 *          deps?: object}} opts deps 缺省时绑定真实数据源（db-reader/额度引擎）
 * @returns {{stop: Function, onGenerateEvent: Function, syncQuota: Function}} stop 供停用；
 *          onGenerateEvent 供 Task 6 绑定宿主 models.onDidGenerate 订阅；
 *          syncQuota 供 sync 注册资源 read 回调即时拉取额度（quotaPending 绕过 TTL 即拉）
 */
export function start(opts = {}) {
  const intervalMs = opts.intervalMs ?? TICK_MS;
  const log = opts.log ?? ((l) => console.log(l));
  const deps = opts.deps ?? realDeps(log);
  const state = createState();
  // 防重入护栏（V1 根因教训）：上一轮（HTTP/慢查询）未完成时跳过本拍——
  // 避免 setInterval 叠加并发拉取拖垮宿主与网络栈
  let running = false;
  /**
   * 立即跑一拍并返回本轮 Promise；已有拍在飞时跳过（返回已决议 Promise）——
   * syncQuota 的即时性由 quotaPending 兜底：在飞拍掠过额度步时待办保留给下一拍。
   */
  const runTickNow = () => {
    if (running) return Promise.resolve();
    running = true;
    return tickV2(state, { ...deps, deliver: opts.deliver, snapshotPath: opts.snapshotPath, log }).finally(() => {
      running = false;
    });
  };
  const timer = setInterval(() => {
    void runTickNow();
  }, intervalMs);
  // 立即跑第一轮（首拍回填），避免首屏等一个间隔
  void runTickNow();
  return {
    stop: () => clearInterval(timer),
    onGenerateEvent: createOnGenerateEvent(state, { deliver: opts.deliver, snapshotPath: opts.snapshotPath, log }),
    // 手动同步通道（Task 6 sync 资源接线）：置待办绕过 60s TTL，立即跑一拍送达
    syncQuota: async () => {
      state.quotaPending = true;
      await runTickNow();
    },
  };
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
 * 额度计算（V2 兜底收窄）：每实例 × 每窗口（规则表按家族路由）→ 官方分母/百分比优先。
 * 收窄裁量（§五.3）：本地分子兜底仅限 5h 窗口——bounds 由 quota.mjs windowBounds 换算
 * （官方锚定或 [now-5h,now]），分子取小时桶整桶和（±1 小时近似，仅兜底不冒充精确）；
 * 周/月窗口删除本地分子（24h 底座对 7d/30d 天然算不准，V1 全缓冲周分子依赖
 * 「进程连活 7 天」属隐性失真）——官方失败 used=null，仅由 view-model 出状态句
 * 「官方接口不可用」。
 * @param {object|null} providerDoc provider_config.json 文档（含 apiKey，仅在内存引用）
 * @param {number} now 当前时刻（epoch 毫秒）
 * @param {Map} buckets 小时桶（5h 兜底分子唯一来源）
 * @param {Function} log 日志
 * @returns {Promise<object[]>} quotaRows（buildSnapshotV2 输入；无密钥）
 */
export async function computeQuota(providerDoc, now, buckets, log) {
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
      // 本地分子仅 5h 窗口（收窄裁量见函数注释）
      let used = null;
      if (rule.type === "rolling-5h") {
        const bounds = windowBounds(rule, now, { nextResetMs: official.nextResetMs });
        const sum = windowSum(buckets, inst.providerId, bounds.startMs, bounds.endMs);
        used = sum.in + sum.out;
      }
      // 官方百分比优先（与厂商窗口口径一致）；本地近似仅在「有分子且分母已知」时给出
      const localPct = used === null ? null : percent(used, official.limit);
      computed.push({
        type: rule.type,
        used,
        limit: official.limit,
        percent: official.percent ?? localPct,
        source: official.source,
        nextResetMs: official.nextResetMs,
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
  // 经共享单例打开（临时：Task 0 采集段与本函数共用同一只读连接，避免重复 openDb；T8 随采集段还原为直接 openDb）
  const opened = sharedOpenDb(homedir);
  if (!opened.db) log("[看板] 未找到官方遥测库（db.sqlite），看板将显示空态");
  // provider 文档读入内存一次，apiKey 仅在额度请求头内即时引用，绝不进入快照/日志
  const providerDoc = readProviderDoc(resolveProviderConfigPath(process.env, homedir));
  if (!providerDoc) log("[看板] 未找到 provider 配置（provider_config.json），额度卡不可用");

  return {
    // 首拍有界回填（近 24h 行落桶即弃）
    fetchRecent: async (sinceMs) => (opened.db ? fetchRecentModelUsage(opened.db, opened.schema, sinceMs) : { rows: [], maxRowid: 0 }),
    // 空窗回填守卫：回填零行时的游标初始化兜底
    fetchMaxRowid: async () => (opened.db ? fetchMaxRowid(opened.db) : 0),
    // 其后每拍 rowid 增量
    fetchNew: async (cursor) => (opened.db ? fetchNewModelUsage(opened.db, opened.schema, cursor) : { rows: [], nextCursor: cursor }),
    fetchSessions: async () => (opened.db ? fetchSessions(opened.db, opened.schema) : []),
    fetchQuota: async (now, buckets) => computeQuota(providerDoc, now, buckets, log),
    log,
  };
}

/** 默认快照落盘位置：<cliStorageRoot>/zpowerpack/last-snapshot.json（拉取式兜底通道） */
function defaultSnapshotPath() {
  return join(resolveCliStorageRoot(process.env, os.homedir()), "zpowerpack", "last-snapshot.json");
}

/** 空快照的展示模型默认值：注册资源 read 在首次 deliver 前的可读形态（经真实空链路构造防形状漂移） */
const EMPTY_DISPLAY = toDisplayModelV2(
  buildSnapshotV2({
    liveSnapshot: createLiveRate().snapshot(0),
    quotaRows: [],
    trend: trendPoints(newBuckets(), 0),
    conclusion: null,
    now: 0,
  }),
  0,
);

/**
 * 生成事件订阅绑定（Task 6 接线）：宿主 ctx 的订阅挂载形态未定案（Task 0 真机采集在途），
 * 按临时探测段的候选序列逐一尝试、先绑定成功者胜——同一事件重复订阅会双计速率，任一
 * 形态成功即停。序列与 probeSubscribeCandidates 一致：models.onDidGenerate 函数直挂 →
 * 同名 .subscribe 对象（互斥）→ models.subscribe 通用入口 → ctx 顶层 subscribe（全名/短名双猜）。
 * @param {object} ctx 扩展上下文（宿主 activate 入参，可能不含 models 命名空间）
 * @param {Function} handler 事件处理函数（activate 的会话追踪包装后入口）
 * @param {Function} log 日志（中文；每个失败候选留痕，供真机诊断对照）
 * @returns {string|null} 绑定成功的形态标签；null=全部候选失败（订阅不可达，速率由
 *          tickV2 兜底行接管，激活不失败——由调用方记中文 warn）
 */
export function bindOnGenerate(ctx, handler, log = () => {}) {
  const models = ctx?.models;
  // 候选 1/2：ctx.models.onDidGenerate——函数（调用即订阅）或带 subscribe 方法的对象（Rx 风格），二者互斥
  if (typeof models?.onDidGenerate === "function") {
    try {
      models.onDidGenerate(handler);
      return "ctx.models.onDidGenerate()";
    } catch (e) {
      log(`[ZPowerPack] 订阅形态 ctx.models.onDidGenerate() 绑定失败：${e?.message ?? ""}`);
    }
  } else if (models?.onDidGenerate && typeof models.onDidGenerate.subscribe === "function") {
    try {
      models.onDidGenerate.subscribe(handler);
      return "ctx.models.onDidGenerate.subscribe()";
    } catch (e) {
      log(`[ZPowerPack] 订阅形态 ctx.models.onDidGenerate.subscribe() 绑定失败：${e?.message ?? ""}`);
    }
  }
  // 候选 3：models 命名空间上的通用 subscribe 入口（backend:"pump" 的统一通道可能形态）
  if (typeof models?.subscribe === "function") {
    try {
      models.subscribe("onDidGenerate", handler);
      return 'ctx.models.subscribe("onDidGenerate", cb)';
    } catch (e) {
      log(`[ZPowerPack] 订阅形态 ctx.models.subscribe("onDidGenerate", cb) 绑定失败：${e?.message ?? ""}`);
    }
  }
  // 候选 4：ctx 顶层通用 subscribe——事件全名优先、短名次之（挂载签名未知双猜）
  if (typeof ctx?.subscribe === "function") {
    try {
      ctx.subscribe("models.onDidGenerate", handler);
      return 'ctx.subscribe("models.onDidGenerate", cb)';
    } catch (e) {
      log(`[ZPowerPack] 订阅形态 ctx.subscribe("models.onDidGenerate", cb) 绑定失败：${e?.message ?? ""}`);
    }
    try {
      ctx.subscribe("onDidGenerate", handler);
      return 'ctx.subscribe("onDidGenerate", cb)';
    } catch (e) {
      log(`[ZPowerPack] 订阅形态 ctx.subscribe("onDidGenerate", cb) 绑定失败：${e?.message ?? ""}`);
    }
  }
  return null;
}

/**
 * 扩展激活入口：注册看板视图（entry + 三注册资源）、素条命令、绑定宿主订阅、启动 60s 拍。
 *
 * 素条推送形态 = view-model V2 的 strip（composer.status 插槽契约 text≤40/tooltip≤200），
 * V2 不再推送 badge（渲染组件从不消费）。Task 6 接线四件事：
 * - 会话作用域素条（2026-11-23 修订 #1）：workbench.onDidChange 订阅感知可见会话，
 *   slots.update 第三参 {sessionId} 按会话分别推送；速率只算该会话的流（events 的
 *   sessionId 过滤）；订阅不可达 → 素条对象降级「最近有事件的会话」（无事件时全局素条兜底）；
 * - tooltip 额度（修订 #2）：聚焦会话当前模型选择的供应商（context.get({sessionId})），
 *   组合上下文为 null（新会话未发首条）→ 回退该会话最近请求供应商；
 * - 推送链（§五.8）：onDidOpen 存 {notify}、onDidClose 清引用；数据更新（60s 拍、
 *   事件节流拍、sync 即时拍）一律 notify("zpowerpack://display")；
 * - sync 资源（§五.4）：read 置 quotaPending 即时拉取官方额度并返回 {quota}。
 *
 * @param {object} ctx 扩展上下文（views/commands/slots/workbench/context/models 宿主 API）
 * @param {{intervalMs?: number, snapshotPath?: string, deps?: object, log?: Function}} opts
 *        宿主只传 ctx；opts 供测试注入（注入 deps 时不落默认快照文件，避免测试污染真机）
 * @returns {Promise<{stop: Function, onGenerateEvent: Function}>} 服务句柄
 *          （宿主不消费返回值；测试直驱 onGenerateEvent 验证会话素条链路）
 */
export async function activate(ctx, opts = {}) {
  const log = opts.log ?? ((l) => console.log(l));

  // 最新快照/展示模型缓存：注册资源 read 的唯一数据源，由 deliver 回调刷新
  let latestSnapshot = null;
  let latestDisplay = null;
  // 视图句柄缓存（推送链 §五.8）：onDidOpen 保存 {notify}，onDidClose 清引用防向已关闭视图推送
  let viewPort = null;
  // 会话作用域状态（修订 #1）：requestId→sessionId 归属（素条流过滤依据）
  const reqSession = new Map();
  // sessionId→最近请求供应商（组合上下文为 null 时的 tooltip 回退，事件到达时刷新）
  const sessionProvider = new Map();
  // 最近有事件的会话：workbench 订阅不可达时的素条降级对象
  let lastEventSession = null;
  // workbench 订阅绑定结果与可见会话缓存（载荷形状 {sessions:[{sessionId, workspace, isDraft, focused}]}）
  let workbenchOk = false;
  let visibleSessions = [];
  // 素条同值去重：作用域键（会话 id，全局=""）→ 最近一次 text|tooltip（按作用域各自去重）
  const lastStripKeys = new Map();
  // 素条推送编排：context.get 为异步 call，deliver 同步段只做缓存刷新与排程（事件风暴护栏）
  let stripsBusy = false;
  let stripsDirty = false;

  /** 素条推送：文本+tooltip 相同则跳过（防 60s 拍/事件流刷屏）；V2 不推 badge（渲染侧从不消费） */
  const pushStrip = (strip, scope) => {
    const scopeKey = typeof scope?.sessionId === "string" ? scope.sessionId : "";
    const key = `${strip.text}|${strip.tooltip}`;
    if (lastStripKeys.get(scopeKey) === key) return;
    lastStripKeys.set(scopeKey, key);
    try {
      // 第三参=会话作用域（宿主源码实证；真机形态不符由探测段诊断揭示后校准）
      ctx.slots.update("zpowerpack-mini", { text: strip.text, tooltip: strip.tooltip, visible: true }, scope);
    } catch (e) {
      log(`[ZPowerPack] 素条推送失败（${e?.name || "异常"}）：${e?.message ?? ""}`);
    }
  };

  /** 数据更新通知（推送链 §五.8）：打开中的视图重读 display 注册资源；视图未开/已关则跳过 */
  const notifyDisplay = () => {
    if (viewPort === null) return;
    try {
      viewPort.notify("zpowerpack://display");
    } catch (e) {
      log(`[看板] 视图通知失败（${e?.name || "异常"}）：${e?.message ?? ""}`);
    }
  };

  /**
   * 素条按会话分别推送（修订 #1）：对每个目标会话组装 focus 段（该会话的流 +
   * 聚焦供应商额度行）后经 view-model 出四态文案；多窗口各自看到自己会话的值。
   * tooltip 额度供应商（修订 #2）：context.get({sessionId}) 的当前模型选择优先，
   * 组合上下文为 null（新会话未发首条）→ 回退该会话最近请求供应商（sessionProvider）。
   */
  const pushStrips = async () => {
    const snap = latestSnapshot;
    if (snap === null) return;
    // 目标会话：workbench 可见会话全集；订阅不可达 → 最近事件会话；再无 → 全局素条（刚装形态兜底）
    const targets = workbenchOk ? visibleSessions.map((s) => s.sessionId) : lastEventSession === null ? [] : [lastEventSession];
    if (targets.length === 0) {
      pushStrip(latestDisplay.strip);
      return;
    }
    for (const sessionId of targets) {
      // 该会话当前模型选择（组合上下文；读不到按 null 走回退，不中断其余会话的推送）
      let model = null;
      try {
        model = (await ctx?.context?.get?.({ sessionId }))?.model ?? null;
      } catch {
        model = null;
      }
      const providerId = typeof model?.providerId === "string" ? model.providerId : (sessionProvider.get(sessionId) ?? null);
      // 素条 tooltip 额度窗口取该供应商的 quota 实例；供应商不在规则表内 → null（不编造水位）
      const quotaRow = providerId === null ? null : ((snap.quota ?? []).find((q) => q?.providerId === providerId) ?? null);
      // 速率只算该会话的流：requestId→sessionId 归属过滤（events 的 sessionId 口径）
      const streams = (snap.rate?.streams ?? []).filter((s) => reqSession.get(s?.requestId) === sessionId);
      const dm = toDisplayModelV2(
        { ...snap, focus: { sessionId, modelId: model?.modelId ?? null, providerId, quotaRow, streams } },
        Date.now(),
      );
      pushStrip(dm.strip, { sessionId });
    }
  };

  /** 素条推送排程：在飞合并、后到快照标脏重跑（1s 事件节流 + context.get 异步下不叠加并发推送） */
  const scheduleStripPush = () => {
    if (stripsBusy) {
      stripsDirty = true;
      return;
    }
    stripsBusy = true;
    void pushStrips()
      .catch((e) => log(`[ZPowerPack] 素条推送编排失败（${e?.name || "异常"}）：${e?.message ?? ""}`))
      .finally(() => {
        stripsBusy = false;
        if (stripsDirty) {
          stripsDirty = false;
          scheduleStripPush();
        }
      });
  };

  // 送达回调：双缓存刷新 + 视图通知 + 素条排程（快照文件由 start 的 snapshotPath 通道写）
  const deliver = (snapshot) => {
    latestSnapshot = snapshot;
    latestDisplay = toDisplayModelV2(snapshot, Date.now());
    notifyDisplay();
    scheduleStripPush();
  };

  try {
    ctx.views.register("zpowerpack-dashboard", {
      // entry 相对插件根解析（V1 探针 ENOENT 实证教训）
      entry: "extension/view/index.html",
      // info=宿主打开视图时传入的句柄（临时：Task 0 采集段消费键集与 notify 形态，T8 移除后仅保留日志）
      onDidOpen: (info) => {
        log("[看板] 视图已打开");
        recordProbeViewOpen(info);
        // 推送链（§五.8）：保存 notify 句柄，数据更新时通知视图重读 display
        viewPort = typeof info?.notify === "function" ? { notify: info.notify } : null;
        try {
          // 视图关闭由宿主回调：清引用，防向已关闭视图推送通知
          info?.onDidClose?.(() => {
            viewPort = null;
          });
        } catch (e) {
          log(`[看板] 视图关闭回调注册失败（${e?.message ?? ""}）`);
        }
      },
      resources: {
        // 展示模型：视图取数资源（V2 素条/面板文案映射已在 view-model 完成）
        "zpowerpack://display": {
          mimeType: "application/json",
          read: () => JSON.stringify(latestDisplay ?? EMPTY_DISPLAY),
        },
        // 原始快照：调试通道（无密钥）
        "zpowerpack://snapshot": {
          mimeType: "application/json",
          read: () => JSON.stringify(latestSnapshot ?? {}),
        },
        // 手动同步（§五.4）：read 置待办绕过 60s TTL 即拉官方额度 → 返回 {quota}；
        // 同拍的 deliver 通道负责 notify display（视图重读后即时重渲）
        "zpowerpack://sync": {
          mimeType: "application/json",
          read: async () => {
            await handle.syncQuota();
            return JSON.stringify({ quota: (latestSnapshot ?? {}).quota ?? [] });
          },
        },
      },
    });
  } catch (e) {
    log(`[ZPowerPack] 视图注册失败（${e?.name || "异常"}）：${e?.message ?? ""}`);
  }

  try {
    // 素条命令：点击状态条打开看板（唯一入口）
    ctx.commands.register("zpowerpack-open-dashboard", async () => {
      await ctx.views.open("zpowerpack-dashboard");
    });
  } catch (e) {
    log(`[ZPowerPack] 命令注册失败（${e?.name || "异常"}）：${e?.message ?? ""}`);
  }

  // ---- 聚焦会话感知（修订 #1）：workbench 订阅 + 初值拉取 ----
  /** workbench 载荷 → 可见会话缓存（素条按会话分别推送的对象集；载荷形状宿主实证） */
  const applyWorkbench = (payload) => {
    const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
    visibleSessions = sessions.filter((s) => typeof s?.sessionId === "string");
  };
  try {
    const wb = ctx?.workbench;
    if (typeof wb?.onDidChange === "function") {
      wb.onDidChange(applyWorkbench);
      workbenchOk = true;
    } else if (typeof wb?.onDidChange?.subscribe === "function") {
      // Rx 风格对象挂载（与生成事件候选序列同思路的形态兼容）
      wb.onDidChange.subscribe(applyWorkbench);
      workbenchOk = true;
    }
    if (workbenchOk) {
      log("[ZPowerPack] workbench 会话订阅已绑定");
      // 初值拉取：订阅载荷只在未来变更时到达，激活时已可见的会话需主动补一次
      if (typeof wb.visibleSessions === "function") {
        Promise.resolve(wb.visibleSessions())
          .then(applyWorkbench)
          .catch((e) => log(`[ZPowerPack] 可见会话初值拉取失败（${e?.message ?? ""}）`));
      }
    } else {
      log("[ZPowerPack] workbench 会话订阅不可达，素条降级为最近事件会话");
    }
  } catch (e) {
    workbenchOk = false;
    log(`[ZPowerPack] workbench 会话订阅不可达（${e?.message ?? ""}），素条降级为最近事件会话`);
  }

  // 测试注入 deps 时不落默认快照文件（防真机副作用）；生产无 opts 时写默认路径
  const snapshotPath = opts.snapshotPath ?? (opts.deps ? undefined : defaultSnapshotPath());
  const handle = start({ intervalMs: opts.intervalMs, snapshotPath, deps: opts.deps, deliver, log });

  // 事件入口包装：先记会话归属（素条流过滤/tooltip 回退供应商的数据底座）再转发服务层；
  // 追踪段独立捕获——归属失败不吞事件（速率直录不受影响）
  const onGenerateEvent = (ev, now = Date.now()) => {
    try {
      if (typeof ev?.sessionId === "string" && typeof ev?.requestId === "string") {
        reqSession.set(ev.requestId, ev.sessionId);
        // final 收流后映射即删（防长期运行无界增长；素条只过滤活跃流，历史归属无用）
        if (ev.phase === "final") reqSession.delete(ev.requestId);
        if (typeof ev?.model?.providerId === "string") sessionProvider.set(ev.sessionId, ev.model.providerId);
        lastEventSession = ev.sessionId;
      }
    } catch {
      // 归属追踪失败不影响事件转发
    }
    handle.onGenerateEvent(ev, now);
  };

  // 订阅绑定（候选序列同临时探测段，先成功者胜）：全败 → 中文 warn，速率走 tickV2 兜底行（§五.5）
  const activeForm = bindOnGenerate(ctx, onGenerateEvent, log);
  if (activeForm !== null) log(`[ZPowerPack] 生成事件订阅已绑定（${activeForm}）`);
  else log("[ZPowerPack] 生成事件订阅不可达（候选形态全败），速率走落库兜底链");

  // ---- 临时：Task 0 采集段（T8 移除）----
  // 探针插件已卸载：订阅形态探测并入本次激活，供 V2 首次真机部署同轮采集定案；
  // 独立 try/catch——任何探测失败绝不影响上方已完成的服务行为（全同步快速操作，10 秒激活预算内）。
  // opts.deps 注入（单元测试）时跳过：mock ctx 无探测价值，且防真机诊断文件污染。
  if (!opts.deps) {
    try {
      runProbeCollection(ctx, log);
    } catch (e) {
      log(`[ZPowerPack] Task 0 采集段失败（不影响服务，${e?.name || "异常"}）：${e?.message ?? ""}`);
    }
  }
  // 返回包装后的事件入口（测试直驱可验证会话素条链路）；宿主不消费返回值
  return { stop: handle.stop, onGenerateEvent };
}

/* ============================================================================
 * 临时：Task 0 采集段（T8 移除）——探针插件已卸载后的替代采集路径。
 *
 * 职责：候选订阅形态逐一 try/catch 探测（models.onDidGenerate 函数直挂/.subscribe 对象双猜、
 * models.subscribe 通用入口、ctx 顶层 subscribe 双签名、ctx 键含 subscribe/capabilities/protocol
 * 兜底枚举、sessions.onDidChange* 对照），绑定成功后前 20 条生成事件累积（含相邻间隔毫秒），
 * onDidOpen 入参键集与 notify 形态，session 表最近 3 活跃会话 parent_id 采样。
 * 诊断原子写 <cliStorageRoot>/zpowerpack/v2-probe-diagnostics.json（tmp+rename 防撕裂）。
 * 本段只读 ctx 与只读 db，不注册宿主资源、不推送素条；任何失败入 errors 不外抛。
 * 宿主为单线程事件循环且单次激活，模块级容器无并发与重入风险。
 * ========================================================================== */

/** 生成事件累积上限：流式期事件高频到达，超出即丢弃，防诊断文件无限膨胀 */
const PROBE_EVENT_LIMIT = 20;

/** 最近一次生成事件的毫秒时刻：相邻间隔毫秒的原始数据（节流常数定案依据） */
let probeLastEventAt = null;

/** 诊断容器（模块级）：runProbeCollection 建立，事件/onDidOpen 回调持续填充；null=采集未启用（记录函数判空直跳） */
let probeDiag = null;

/** 只读 db 打开结果单例：realDeps 与采集段共用同一连接，采集段不重复 openDb（T8 随采集段还原为 realDeps 局部调用） */
let probeSharedDb = null;
function sharedOpenDb(homedir) {
  if (probeSharedDb === null) probeSharedDb = openDb(resolveDbPath(process.env, homedir));
  return probeSharedDb;
}

/** 诊断文件位置：<cliStorageRoot>/zpowerpack/v2-probe-diagnostics.json（与快照文件同目录） */
function probeDiagPath() {
  return join(resolveCliStorageRoot(process.env, os.homedir()), "zpowerpack", "v2-probe-diagnostics.json");
}

/** 诊断原子写盘（tmp+rename，读到半写状态不可能）；失败入 errors 不抛（诊断通道不干扰服务） */
function flushProbeDiag() {
  try {
    mkdirSync(dirname(probeDiagPath()), { recursive: true });
    const tmp = probeDiagPath() + ".tmp";
    writeFileSync(tmp, JSON.stringify(probeDiag, null, 2), "utf8");
    renameSync(tmp, probeDiagPath());
  } catch (e) {
    probeDiag?.errors?.push("诊断写盘失败: " + (e?.message ?? String(e)));
  }
}

/**
 * 生成事件记录（候选绑定成功后由宿主回调）：前 20 条含相邻间隔毫秒与载荷键集，逐条即写盘
 * （流式期宿主若中途退出，已采事件不丢失）；达到上限直接丢弃。
 * @param {...*} args 宿主回调实参（直挂形态为 (payload)；通用 subscribe 通道可能为
 *                  (topic, payload)，实参类型序可区分载荷位置）
 */
function recordProbeEvent(...args) {
  if (!probeDiag || probeDiag.generateEvents.length >= PROBE_EVENT_LIMIT) return;
  const now = Date.now();
  // 首条无前驱间隔记 null；后续记录与上一条的毫秒差（事件到达节奏的原始数据）
  const intervalMs = probeLastEventAt === null ? null : now - probeLastEventAt;
  probeLastEventAt = now;
  const ev = args[0];
  let keys = null;
  let payload = null;
  try {
    keys = Object.keys(ev ?? {});
    // 序列化钉死载荷键名与取值形态（函数类字段会丢，对键名定案无影响）
    payload = JSON.parse(JSON.stringify(ev ?? null));
  } catch (e) {
    payload = "事件序列化失败: " + (e?.message ?? String(e));
  }
  probeDiag.generateEvents.push({
    at: new Date().toISOString(),
    intervalMs,
    argTypes: args.slice(0, 3).map((a) => (a === null ? "null" : typeof a)),
    keys,
    payload,
  });
  // 首个事件到达时刷新 session 采样：触发生成的会话可能激活后才创建，保证归属对照覆盖
  if (probeDiag.generateEvents.length === 1) {
    probeDiag.sessionParentSample = probeSessionParentSample(sharedOpenDb(os.homedir()).db);
  }
  flushProbeDiag();
}

/**
 * 对照组事件记录（ctx.sessions.onDidChange* 绑定）：只记首条键集与载荷。
 * 目的：models 候选全败而对照组有事件 → 问题出在挂载/授权而非订阅机制本身；
 * 只记一条，避免会话变更高频刷爆诊断文件。
 * @param {object} ev 宿主推送的会话变更事件载荷
 */
function recordProbeControlEvent(ev) {
  if (!probeDiag || probeDiag.modelsSubscribe.controlFirstEvent) return;
  let keys = null;
  let payload = null;
  try {
    keys = Object.keys(ev ?? {});
    payload = JSON.parse(JSON.stringify(ev ?? null));
  } catch (e) {
    payload = "序列化失败: " + (e?.message ?? String(e));
  }
  probeDiag.modelsSubscribe.controlFirstEvent = { at: new Date().toISOString(), keys, payload };
  flushProbeDiag();
}

/**
 * 单个候选形态的绑定尝试：任何异常都归入该候选的失败记录，不影响其余候选探测。
 * @param {string} form 形态标签（与 SUBSCRIBE_FORM 定案一一对应，如 "ctx.models.onDidGenerate()"）
 * @param {Function} bind 执行绑定的闭包（内部调用宿主 API），返回宿主给出的句柄
 * @returns {{ok: boolean, handle?: unknown}} ok=true 表示绑定调用未抛异常（句柄可能是任意形态）
 */
function probeTryBind(form, bind) {
  try {
    const handle = bind();
    probeDiag.modelsSubscribe.candidates.push({
      form,
      result: "bound",
      // 句柄形态是定案依据：函数句柄还是带 dispose/unsubscribe 的对象句柄
      handleType: handle === null ? "null" : typeof handle,
      handleKeys: handle && typeof handle === "object" ? Object.keys(handle) : null,
    });
    return { ok: true, handle };
  } catch (e) {
    probeDiag.modelsSubscribe.candidates.push({ form, result: "error: " + (e?.message ?? String(e)) });
    return { ok: false };
  }
}

/**
 * 候选订阅形态逐一探测：宿主声明表含 models.onDidGenerate（kind:"subscribe"）但扩展 ctx 的
 * 挂载形态未知，按可能性从高到低尝试；任一形态绑定成功即停，避免同一事件被重复订阅
 * 导致事件双计、间隔失真。
 * @param {object} ctx 扩展上下文（宿主 activate 入参，可能不含 models 命名空间）
 */
function probeSubscribeCandidates(ctx) {
  const models = ctx?.models;
  let generateBound = false;

  // 候选 1/2：ctx.models.onDidGenerate——函数（调用即订阅）或带 subscribe 方法的对象（Rx 风格），二者互斥
  if (typeof models?.onDidGenerate === "function") {
    const r = probeTryBind("ctx.models.onDidGenerate()", () => models.onDidGenerate(recordProbeEvent));
    if (r.ok) {
      generateBound = true;
      probeDiag.modelsSubscribe.activeForm = "ctx.models.onDidGenerate()";
    }
  } else if (models?.onDidGenerate && typeof models.onDidGenerate.subscribe === "function") {
    const r = probeTryBind("ctx.models.onDidGenerate.subscribe()", () => models.onDidGenerate.subscribe(recordProbeEvent));
    if (r.ok) {
      generateBound = true;
      probeDiag.modelsSubscribe.activeForm = "ctx.models.onDidGenerate.subscribe()";
    }
  } else {
    // 两种直挂形态都不存在：记录实际类型与 models 键集，作为 fallback 形态的判读证据
    probeDiag.modelsSubscribe.candidates.push({
      form: "ctx.models.onDidGenerate",
      result: "skip",
      actualType: models?.onDidGenerate === undefined ? "undefined" : typeof models.onDidGenerate,
      modelsKeys: models ? Object.keys(models) : null,
    });
  }

  // 候选 3：models 命名空间上的通用 subscribe 入口（backend:"pump" 的统一通道可能形态）
  if (typeof models?.subscribe === "function") {
    if (!generateBound) {
      const r = probeTryBind('ctx.models.subscribe("onDidGenerate", cb)', () => models.subscribe("onDidGenerate", recordProbeEvent));
      if (r.ok) {
        generateBound = true;
        probeDiag.modelsSubscribe.activeForm = 'ctx.models.subscribe("onDidGenerate", cb)';
      }
    } else {
      probeDiag.modelsSubscribe.candidates.push({
        form: "ctx.models.subscribe",
        result: "skip: 已由 " + probeDiag.modelsSubscribe.activeForm + " 绑定，避免事件双计",
      });
    }
  } else {
    probeDiag.modelsSubscribe.candidates.push({
      form: "ctx.models.subscribe",
      result: "skip",
      actualType: models?.subscribe === undefined ? "undefined" : typeof models.subscribe,
    });
  }

  // 候选 4：ctx 顶层通用 subscribe（宿主存在通用订阅机制但扩展侧挂载签名未知）；
  // 仅在前面形态全败时按「事件全名/短名」两种猜测尝试，成功一种即停
  if (!generateBound && typeof ctx?.subscribe === "function") {
    const r1 = probeTryBind('ctx.subscribe("models.onDidGenerate", cb)', () => ctx.subscribe("models.onDidGenerate", recordProbeEvent));
    if (r1.ok) {
      generateBound = true;
      probeDiag.modelsSubscribe.activeForm = 'ctx.subscribe("models.onDidGenerate", cb)';
    } else {
      const r2 = probeTryBind('ctx.subscribe("onDidGenerate", cb)', () => ctx.subscribe("onDidGenerate", recordProbeEvent));
      if (r2.ok) {
        generateBound = true;
        probeDiag.modelsSubscribe.activeForm = 'ctx.subscribe("onDidGenerate", cb)';
      }
    }
  }

  // 兜底枚举：ctx 顶层任何含 subscribe/capabilities/protocol 的入口只做形态记录不绑定，
  // 为下一轮探测或 fallback 定案提供挂载证据
  try {
    for (const key of Object.keys(ctx ?? {})) {
      if (/subscribe|capabilities|protocol/i.test(key)) {
        const v = ctx[key];
        probeDiag.modelsSubscribe.candidates.push({
          form: "ctx." + key,
          result: "inspect-only",
          type: typeof v,
          objectKeys: v && typeof v === "object" ? Object.keys(v) : null,
        });
      }
    }
  } catch (e) {
    probeDiag.errors.push("ctx 顶层 subscribe/capabilities/protocol 枚举失败: " + (e?.message ?? String(e)));
  }

  // 对照组：ctx.sessions 的 onDid* / subscribe* 入口——验证订阅回调通道在本宿主的可触发性
  try {
    const sessions = ctx?.sessions;
    const sessionEventKeys = sessions
      ? Object.keys(sessions).filter((k) => (/^onDid/.test(k) || /^subscribe/.test(k)) && typeof sessions[k] === "function")
      : [];
    probeDiag.modelsSubscribe.control = { sessionEventKeys, controlForm: null, controlHandleType: null };
    if (sessionEventKeys.length > 0) {
      // 取第一个事件键作对照绑定：其事件与生成事件无关，仅验证回调通道可被宿主触发
      const key = sessionEventKeys[0];
      const r = probeTryBind("ctx.sessions." + key + "()", () => sessions[key](recordProbeControlEvent));
      if (r.ok) {
        probeDiag.modelsSubscribe.control.controlForm = "ctx.sessions." + key + "()";
        probeDiag.modelsSubscribe.control.controlHandleType = r.handle === null ? "null" : typeof r.handle;
      }
    }
  } catch (e) {
    probeDiag.modelsSubscribe.control = { error: e?.message ?? String(e) };
  }
}

/**
 * session 表采样：最近活跃 3 个会话的 id/parent_id（事件 sessionId 主/子代理归属判读的对照数据）。
 * 列按 PRAGMA table_info 探测选用（兼容宿主 schema 演进与测试夹具：归档/时间列缺失时降级查询，
 * 缺表/查询失败返回 ok=false，由调用方入诊断 errors，不抛出）。
 * @param {DatabaseSync|null} db realDeps 已开的只读连接（采集段不新开连接）
 * @returns {{ok: boolean, rows?: object[], error?: string|null, sampledAt: string}}
 *          ok=true 时 rows 为 snake_case 原始行（id/parent_id/time_updated）；
 *          ok=false 时无 rows，error 为失败原因
 */
function probeSessionParentSample(db) {
  const base = { sampledAt: new Date().toISOString() };
  if (!db) return { ...base, ok: false, error: "遥测库不可用（realDeps 未开出只读连接）" };
  try {
    const cols = db.prepare("PRAGMA table_info(session)").all().map((c) => c.name);
    if (!cols.includes("id")) return { ...base, ok: false, error: "session 表不存在或无 id 列" };
    const selectCols = ["id", "parent_id", "time_updated"].filter((c) => cols.includes(c));
    // 活跃过滤：归档/删除列存在才加（真实库有而部分 schema 没有——缺列降级为全表倒序，不冒错）
    const where = ["time_archived", "time_deleted"].filter((c) => cols.includes(c)).map((c) => `"${c}" IS NULL`);
    const order = cols.includes("time_updated") ? ' ORDER BY "time_updated" DESC' : "";
    const sql =
      `SELECT ${selectCols.map((c) => `"${c}"`).join(", ")} FROM session` +
      (where.length > 0 ? " WHERE " + where.join(" AND ") : "") +
      order +
      " LIMIT 3";
    return { ...base, ok: true, rows: db.prepare(sql).all(), error: null };
  } catch (e) {
    return { ...base, ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * onDidOpen 入参记录（T4 视图钩子的临时采集接线）：句柄键集与 notify 形态。
 * JSON.stringify 会丢函数字段，notify 须单独 typeof 记录才能钉死句柄形态；
 * 采集未启用（probeDiag=null，单元测试注入 deps 路径）时判空直跳，不产生任何副作用。
 * @param {object|null} info 宿主打开视图时传入的句柄信息（键集与 notify 形态的采集对象）
 */
function recordProbeViewOpen(info) {
  if (!probeDiag) return;
  try {
    probeDiag.viewOpenInfo = {
      at: new Date().toISOString(),
      keys: info ? Object.keys(info) : null,
      notifyType: typeof info?.notify,
      payload: JSON.parse(JSON.stringify(info ?? null)),
    };
    flushProbeDiag();
  } catch (e) {
    probeDiag.errors.push("onDidOpen 记录失败: " + (e?.message ?? String(e)));
  }
}

/**
 * 采集段主入口（activate 末尾调用；opts.deps 注入的单元测试路径已在外层跳过）：
 * 建诊断容器 → ctx 键枚举 → 候选订阅逐一绑定 → session 采样 → 首次写盘。
 * 后续生成事件/onDidOpen/对照组事件到达由各记录函数增量写盘；
 * 任何单项失败入 errors 不外抛，整体失败由 activate 外层 try/catch 兜住。
 * @param {object} ctx 扩展上下文（宿主 activate 入参）
 * @param {Function} log 日志（仅整体完成打一行中文提示，不打印载荷细节）
 */
function runProbeCollection(ctx, log) {
  probeDiag = {
    capturedAt: new Date().toISOString(),
    note: "临时：Task 0 采集（T8 移除）——探针插件已卸载，宿主一次重启内采集订阅形态定案",
    // ctx API 面：键名 + 每键值类型/对象键集（正式实现的宿主 API 使用依据）
    ctxApi: null,
    // 订阅候选结论：candidates=每形态绑定结果（bound/skip/error + 句柄类型），activeForm=首个绑定成功形态
    modelsSubscribe: { candidates: [], activeForm: null, control: null, controlFirstEvent: null },
    // 生成事件累积：≤20 条含相邻间隔毫秒（事件节奏与载荷键名的原始数据）
    generateEvents: [],
    // onDidOpen 句柄记录：视图首次打开时由 recordProbeViewOpen 填充
    viewOpenInfo: null,
    // session 采样：最近 3 活跃会话 id/parent_id（事件归属对照）
    sessionParentSample: null,
    errors: [],
  };

  // ① ctx 键枚举：键名 + 值类型（函数/对象键集/原始类型）
  try {
    probeDiag.ctxApi = {};
    for (const key of Object.keys(ctx ?? {})) {
      const v = ctx[key];
      probeDiag.ctxApi[key] =
        typeof v === "function" ? "function" : v && typeof v === "object" ? { objectKeys: Object.keys(v) } : typeof v;
    }
  } catch (e) {
    probeDiag.errors.push("ctx 枚举失败: " + (e?.message ?? String(e)));
  }

  // ② 候选订阅逐一探测（绑定成功者的事件由 recordProbeEvent 累积）
  try {
    probeSubscribeCandidates(ctx);
  } catch (e) {
    probeDiag.errors.push("订阅候选探测整体失败: " + (e?.message ?? String(e)));
  }

  // ③ session 采样（复用 realDeps 已开的只读连接；查询失败入诊断不抛）
  try {
    probeDiag.sessionParentSample = probeSessionParentSample(sharedOpenDb(os.homedir()).db);
  } catch (e) {
    probeDiag.sessionParentSample = { ok: false, error: e?.message ?? String(e) };
  }

  flushProbeDiag();
  log("[ZPowerPack] Task 0 采集段完成，诊断已写盘（临时，T8 移除）");
}
