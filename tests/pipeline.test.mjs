/**
 * 扩展服务层 V2 的单元测试：buildSnapshotV2 快照契约 + computeConclusion 结论外推 +
 * tickV2 60s 拍管线（首拍回填/空窗守卫/节流/防重入/兜底链/滞留收口）+ computeQuota 兜底收窄。
 * 全部依赖注入假数据源，不碰真机 db/网络；快照契约断言与 view-model V2 输入形状一致。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildSnapshotV2,
  computeConclusion,
  computeQuota,
  tickV2,
  createState,
  createOnGenerateEvent,
  start,
} from "../extension/main.js";
import { createLiveRate } from "../extension/core/live-rate.mjs";
import { newBuckets, addRow, trendPoints } from "../extension/core/hourly.mjs";

/** 一小时的毫秒数（时间夹具用） */
const HOUR = 3600000;

/**
 * 造一行 db-reader camelCase 输出口径的完成行。
 * @param {{rowid: number, providerId?: string, completedAt: number, outputTokens?: number,
 *          reasoningTokens?: number, inputTokens?: number, status?: string}} spec 行字段（缺省值与真实行同量级）
 */
function makeRow(spec) {
  const { rowid, providerId = "p1", completedAt, outputTokens = 200, reasoningTokens = 10, inputTokens = 100, status = "completed" } = spec;
  return {
    rowid,
    sessionId: "sess1",
    providerId,
    modelId: "glm-4.7",
    status,
    startedAt: completedAt - 1000,
    firstTokenAt: completedAt - 800,
    completedAt,
    durationMs: 1000,
    inputTokens,
    outputTokens: status === "completed" ? outputTokens : 0,
    reasoningTokens: status === "completed" ? reasoningTokens : 0,
  };
}

// ---------------------------------------------------------------------------
// 一、buildSnapshotV2 快照契约（视图消费的唯一形状）
// ---------------------------------------------------------------------------

test("buildSnapshotV2 契约：五段齐全无 charts 键；rate=live 快照原样；quota 透传形状；序列化无密钥", () => {
  const now = 1732252927000;
  const live = createLiveRate();
  live.onEvent(
    { sessionId: "s1", requestId: "r1", model: { providerId: "p1", modelId: "glm-4.7" }, phase: "streaming", outputTokensPerSecond: 428 },
    now,
    new Set(),
  );
  const liveSnapshot = live.snapshot(now);
  const quotaRows = [
    {
      providerId: "p1",
      name: "实例甲",
      source: "unavailable",
      percent: null,
      nextResetMs: null,
      // requests 为额度引擎内部字段：快照透传必须剥离（窗口契约六键）
      windows: [{ type: "rolling-5h", used: 620, limit: null, percent: null, source: "unavailable", nextResetMs: null, requests: 9 }],
    },
  ];
  const trend = [{ hourMs: now, tokens: 620 }];
  const conclusion = { instanceName: "实例甲", pctNow: 73, pctAtReset: 104.2, resetMs: now + HOUR };

  const snap = buildSnapshotV2({ liveSnapshot, quotaRows, trend, conclusion, now });

  // 形状契约：五段齐全、charts 八报表随 V2 退役
  assert.equal(snap.generatedAt, now);
  for (const key of ["rate", "quota", "trend", "conclusion"]) assert.ok(key in snap, `缺少 ${key} 段`);
  assert.ok(!("charts" in snap), "V2 快照不得含 charts 键（八报表退役）");
  // rate=live-rate snapshot 原样带出（流态/末值/兜底键集完整）
  assert.equal(snap.rate.state, "live");
  assert.equal(snap.rate.totalTps, 428);
  assert.equal(snap.rate.lastProviderId, "p1");
  // quota 形状沿用 V1 透传：窗口六键、实例六键
  assert.equal(snap.quota.length, 1);
  assert.deepEqual(
    Object.keys(snap.quota[0].windows[0]).sort(),
    ["type", "percent", "used", "limit", "source", "nextResetMs"].sort(),
    "窗口契约六键（内部字段剥离）",
  );
  assert.deepEqual(
    Object.keys(snap.quota[0]).sort(),
    ["providerId", "name", "windows", "nextResetMs", "percent", "source"].sort(),
  );
  // trend/conclusion 原样透传
  assert.equal(snap.trend[0].tokens, 620);
  assert.equal(snap.conclusion.instanceName, "实例甲");
  // 序列化安全：不得含密钥样式
  const dumped = JSON.stringify(snap);
  assert.ok(!dumped.includes("sk-"), "快照不得含密钥样式");
  assert.ok(!dumped.includes("apiKey"), "快照不得含 apiKey 字样");
});

test("快照兜底收口：lastFinal 恒优先于 fallback（T5 审查集成确认——idle 不再显示过期兜底值）", () => {
  const now = 1732252927000;
  const base = {
    state: "idle",
    streams: [],
    totalTps: 0,
    subTps: 0,
    lastEventAt: now - 600000,
    lastProviderId: "p1",
    lastFinal: { modelId: "glm-4.7", tps: 300, outputTokens: 1234, at: now - 1000 },
    fallback: { tps: 108, completedAt: now - 600000 },
  };
  // final 末值更新 → 兜底旧值压制为 null，view-model 只取 lastFinal
  const a = buildSnapshotV2({ liveSnapshot: { ...base }, quotaRows: [], trend: [], conclusion: null, now });
  assert.equal(a.rate.fallback, null, "final 末值更新时兜底行不得再供视图取值");
  assert.equal(a.rate.lastFinal.tps, 300);
  // 兜底行更新（订阅挂掉后的接管形态）→ 保留
  const b = buildSnapshotV2({
    liveSnapshot: { ...base, lastFinal: { ...base.lastFinal, at: now - 900000 }, fallback: { tps: 108, completedAt: now - 60000 } },
    quotaRows: [],
    trend: [],
    conclusion: null,
    now,
  });
  assert.equal(b.rate.fallback.tps, 108, "兜底行比 final 更新时接管速率条");
});

// ---------------------------------------------------------------------------
// 二、tickV2 60s 拍管线
// ---------------------------------------------------------------------------

test("首拍回填：fetchRecentModelUsage 近 24h 落桶即弃，游标=回填 maxRowid，后续增量无重叠", async () => {
  const now = 1732252927000;
  const recentCalls = [];
  const newCalls = [];
  const recentRows = [makeRow({ rowid: 7, completedAt: now - 3 * HOUR }), makeRow({ rowid: 9, completedAt: now - 60000 })];
  const delivered = [];
  const deps = {
    fetchRecent: async (sinceMs) => {
      recentCalls.push(sinceMs);
      return { rows: recentRows, maxRowid: 9 };
    },
    fetchNew: async (cursor) => {
      newCalls.push(cursor);
      return { rows: [makeRow({ rowid: 10, completedAt: now })], nextCursor: 10 };
    },
    // 回填有行时不得触发 MAX(rowid) 兜底
    fetchMaxRowid: async () => {
      throw new Error("回填有行时不得触发 MAX(rowid) 兜底");
    },
    fetchSessions: async () => [],
    fetchQuota: async () => [],
    deliver: (s) => delivered.push(s),
    now: () => now,
    log: () => {},
  };

  const state = createState();
  await tickV2(state, deps);

  // 回填窗口=近 24h（V1 游标 0 全量拉是卡顿根因，禁止重演）
  assert.deepEqual(recentCalls, [now - 24 * HOUR]);
  assert.equal(state.cursor, 9, "游标=回填行最大 rowid");
  // 落桶即弃：两行 token 已进小时桶（310/行），state 不持有行数组
  const total = trendPoints(state.buckets, now).reduce((s, p) => s + p.tokens, 0);
  assert.equal(total, 620, "回填两行已落小时桶（100+200+10 每行）");
  // 首拍即产出快照（24 点趋势）
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].trend.length, 24);

  // 第二拍起走增量：游标从回填 maxRowid 起步 → 界后新行只出现在增量（不重不漏）
  await tickV2(state, deps);
  assert.deepEqual(newCalls, [9], "增量游标从回填 maxRowid 起步，无重叠");
  assert.equal(state.cursor, 10);
  const total2 = trendPoints(state.buckets, now).reduce((s, p) => s + p.tokens, 0);
  assert.equal(total2, 930, "增量行落桶且不重复计入回填行");
});

test("空窗回填守卫：有历史但 24h 无新行 → 游标用 MAX(rowid) 初始化（禁 V1 冷启动全量拉重演）", async () => {
  const now = 1732252927000;
  let maxRowidCalls = 0;
  const newCalls = [];
  const deps = {
    // 有历史但近 24h 无完成行：回填零行且 maxRowid=0
    fetchRecent: async () => ({ rows: [], maxRowid: 0 }),
    fetchNew: async (cursor) => {
      newCalls.push(cursor);
      return { rows: [], nextCursor: cursor };
    },
    fetchMaxRowid: async () => {
      maxRowidCalls++;
      return 80000;
    },
    fetchSessions: async () => [],
    fetchQuota: async () => [],
    now: () => now,
    log: () => {},
  };

  const state = createState();
  await tickV2(state, deps);
  assert.equal(maxRowidCalls, 1, "回填零行时必须用 MAX(rowid) 初始化游标");
  assert.equal(state.cursor, 80000, "游标=全表最大 rowid（而非 0 全量拉 8 万历史行）");

  await tickV2(state, deps);
  assert.deepEqual(newCalls, [80000], "后续增量从 MAX(rowid) 起步，历史行不重拉");
});

test("60s 拍：增量逐拍拉取；额度与会话不逐拍重打（60s 节流）", async () => {
  let clock = 1000000;
  const counts = { recent: 0, new: 0, sessions: 0, quota: 0 };
  const deps = {
    fetchRecent: async () => {
      counts.recent++;
      return { rows: [], maxRowid: 0 };
    },
    fetchMaxRowid: async () => 0,
    fetchNew: async (cursor) => {
      counts.new++;
      return { rows: [], nextCursor: cursor };
    },
    fetchSessions: async () => {
      counts.sessions++;
      return [];
    },
    fetchQuota: async () => {
      counts.quota++;
      return [];
    },
    now: () => clock,
    log: () => {},
  };

  const state = createState();
  await tickV2(state, deps); // 首拍：回填 + 首拉额度/会话
  clock += 30000;
  await tickV2(state, deps); // TTL 内 → 额度/会话走缓存
  clock += 30000;
  await tickV2(state, deps); // 累计 60s → 过期重打

  assert.equal(counts.recent, 1, "回填仅首拍一次");
  assert.equal(counts.new, 2, "db 增量每拍拉取（不受节流影响）");
  assert.equal(counts.quota, 2, "60s 窗口内额度只打一次，过期重打");
  assert.equal(counts.sessions, 2, "60s 窗口内会话只读一次，过期重读");
});

test("手动同步待办：quotaPending 置位即绕过 60s TTL 重拉额度（Task 6 sync 资源挂点）", async () => {
  let clock = 1000000;
  let quotaCalls = 0;
  const deps = {
    fetchRecent: async () => ({ rows: [], maxRowid: 0 }),
    fetchMaxRowid: async () => 0,
    fetchNew: async (cursor) => ({ rows: [], nextCursor: cursor }),
    fetchSessions: async () => [],
    fetchQuota: async () => {
      quotaCalls++;
      return [];
    },
    now: () => clock,
    log: () => {},
  };

  const state = createState();
  await tickV2(state, deps); // 首拍拉一次
  clock += 1000;
  await tickV2(state, deps); // TTL 内 → 缓存
  assert.equal(quotaCalls, 1);

  state.quotaPending = true; // sync 资源 read 回调置位（Task 6 接线）
  await tickV2(state, deps);
  assert.equal(quotaCalls, 2, "待办置位即绕过 TTL 立即重拉");
  assert.equal(state.quotaPending, false, "拉取后待办清零");
});

test("兜底链：无订阅事件时 tick 内最新完成行 noteFallbackRow，快照 rate.fallback 有值", async () => {
  const now = 1732252927000;
  const rows = [
    makeRow({ rowid: 1, completedAt: now - 60000, outputTokens: 100 }),
    makeRow({ rowid: 2, completedAt: now - 30000, outputTokens: 900, reasoningTokens: 0 }),
    makeRow({ rowid: 3, completedAt: now, status: "error" }), // 错误行不入兜底链
  ];
  const delivered = [];
  const deps = {
    fetchRecent: async () => ({ rows, maxRowid: 3 }),
    fetchNew: async (cursor) => ({ rows: [], nextCursor: cursor }),
    fetchSessions: async () => [],
    fetchQuota: async () => [],
    deliver: (s) => delivered.push(s),
    now: () => now,
    log: () => {},
  };

  const state = createState();
  await tickV2(state, deps);

  // 最新「完成」行=rowid2：900 token ÷ 800ms 生成段 = 1125 tps
  assert.ok(delivered[0].rate.fallback, "快照 rate.fallback 有值");
  assert.equal(delivered[0].rate.fallback.completedAt, now - 30000);
  assert.equal(delivered[0].rate.fallback.tps, 1125, "兜底=最新完成行的单请求速率");
});

test("滞留流守卫：流静默超 10 分钟按 final 收口（记 lastFinal、删流），状态不再恒 live", async () => {
  const startAt = 1732252927000;
  const state = createState();
  const ev = (requestId, tps) => ({
    sessionId: "s1",
    requestId,
    model: { providerId: "p1", modelId: "glm-4.7" },
    phase: "streaming",
    outputTokensPerSecond: tps,
  });
  // 两路流在 11 分钟前活跃后宿主丢失 final → 滞留形态
  state.live.onEvent(ev("r1", 100), startAt, state.subagentIds);
  state.live.onEvent(ev("r2", 50), startAt, state.subagentIds);

  const now = startAt + 11 * 60000;
  const delivered = [];
  const deps = {
    fetchNew: async (cursor) => ({ rows: [], nextCursor: cursor }),
    fetchSessions: async () => [],
    fetchQuota: async () => [],
    deliver: (s) => delivered.push(s),
    now: () => now,
    log: () => {},
  };
  state.cursor = 1; // 越过回填拍直接走增量

  await tickV2(state, deps);
  const rate = delivered[0].rate;
  assert.equal(rate.streams.length, 0, "滞留流已按 final 收口删除");
  assert.notEqual(rate.state, "live", "状态不得恒 live");
  assert.ok(rate.lastFinal, "收口记 lastFinal（末值不丢）");
  assert.equal(rate.lastFinal.tps, 50, "按最后活跃流的末值收口");
  assert.equal(rate.state, "recent", "收口时刻即最近事件 → recent 态");
});

test("事件风暴：一秒内多事件仅一次快照重建与 deliver（EVENT_THROTTLE_MS 节流）", () => {
  const now = 1732252927000;
  const state = createState();
  const delivered = [];
  const onGenerateEvent = createOnGenerateEvent(state, { deliver: (s) => delivered.push(s), log: () => {} });
  const ev = (requestId, tps) => ({
    sessionId: "s1",
    requestId,
    model: { providerId: "p1", modelId: "glm-4.7" },
    phase: "streaming",
    outputTokensPerSecond: tps,
  });

  onGenerateEvent(ev("r1", 100), now);
  onGenerateEvent(ev("r1", 200), now + 200);
  onGenerateEvent(ev("r2", 50), now + 400);
  assert.equal(delivered.length, 1, "1 秒内三事件仅一次快照重建与 deliver");

  // live 恒直录：流状态机不受节流影响
  const snap = state.live.snapshot(now + 500);
  assert.equal(snap.streams.length, 2);
  assert.equal(snap.totalTps, 250);

  // 节流窗口过后下一事件恢复重建，快照反映最新流态
  onGenerateEvent(ev("r2", 60), now + 1100);
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1].rate.totalTps, 260);
});

test("防重入：慢周期进行中不叠加并发拉取（V1 根因护栏保留）", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const mark = () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
  };
  const deps = {
    fetchRecent: async () => {
      mark();
      await new Promise((r) => setTimeout(r, 60));
      inFlight--;
      return { rows: [], maxRowid: 0 };
    },
    fetchMaxRowid: async () => 0,
    fetchNew: async (cursor) => {
      mark();
      await new Promise((r) => setTimeout(r, 60));
      inFlight--;
      return { rows: [], nextCursor: cursor };
    },
    fetchSessions: async () => [],
    fetchQuota: async () => [],
  };
  const handle = start({ intervalMs: 10, deps, log: () => {} });
  await new Promise((r) => setTimeout(r, 250));
  handle.stop();
  // 无护栏时 250ms/10ms 间隔会叠出 ~25 轮并发；有护栏任意时刻至多 1 轮在飞
  assert.equal(maxInFlight, 1, "任意时刻至多一轮拉取在飞");
});

test("轮询容错：单拍数据源异常不致命，下一拍恢复", async () => {
  let clock = 1000000;
  let failNew = false;
  const delivered = [];
  const deps = {
    fetchRecent: async () => ({ rows: [], maxRowid: 0 }),
    fetchMaxRowid: async () => 0,
    fetchNew: async (cursor) => {
      if (failNew) throw new Error("模拟库读取失败");
      return { rows: [], nextCursor: cursor };
    },
    fetchSessions: async () => [],
    fetchQuota: async () => [],
    deliver: (s) => delivered.push(s),
    now: () => clock,
    log: () => {},
  };
  const state = createState();
  await tickV2(state, deps); // 首拍成功（回填路径）
  clock += 60000;
  failNew = true;
  await tickV2(state, deps); // 增量抛错 → 捕获不外抛
  clock += 60000;
  failNew = false;
  await tickV2(state, deps); // 恢复
  assert.equal(delivered.length, 2, "异常拍跳过送达，恢复拍继续");
  assert.equal(state.cursor, 0);
});

// ---------------------------------------------------------------------------
// 三、computeConclusion 结论外推（30 分钟官方 percent 采样 → 撑得到/撑不到）
// ---------------------------------------------------------------------------

test("结论外推：30 分钟采样线性外推撑得到/撑不到；样本不足或增量≈0 → null", () => {
  const now = 1732252927000;
  const row = (percent, nextResetMs) => ({
    providerId: "p1",
    name: "实例甲",
    percent,
    windows: [{ type: "rolling-5h", percent, nextResetMs }],
    nextResetMs,
    source: "unavailable",
  });
  const resetMs = now + HOUR;

  // 撑不到：30 分钟 6 采样 60→73（斜率 13/30min），1 小时后外推 104.2 > 100
  const rising = new Map([["p1", Array.from({ length: 6 }, (_, i) => ({ t: now - (5 - i) * 300000, pct: 60 + i * 2.6 }))]]);
  const c1 = computeConclusion([row(73, resetMs)], rising, now);
  assert.ok(c1, "样本充足且有增量应产出结论");
  assert.equal(c1.instanceName, "实例甲");
  assert.equal(c1.pctNow, 73);
  assert.equal(c1.pctAtReset, 104.2);
  assert.equal(c1.resetMs, resetMs);

  // 撑得到：增量 3 → 1 小时后外推 80.2 ≤ 100
  const gentle = new Map([["p1", Array.from({ length: 6 }, (_, i) => ({ t: now - (5 - i) * 300000, pct: 70 + i * 0.6 }))]]);
  const c2 = computeConclusion([row(73, resetMs)], gentle, now);
  assert.equal(c2.pctAtReset, 80.2);

  // 样本 <5 → null（消耗速度尚不足以推算）
  const thin = new Map([["p1", [{ t: now - 60000, pct: 70 }, { t: now, pct: 73 }]]]);
  assert.equal(computeConclusion([row(73, resetMs)], thin, now), null);

  // 增量 ≈0 → null（水位静止无法推算，不编造）
  const flat = new Map([["p1", Array.from({ length: 6 }, (_, i) => ({ t: now - (5 - i) * 300000, pct: 73 }))]]);
  assert.equal(computeConclusion([row(73, resetMs)], flat, now), null);

  // 无官方重置时刻 → 无法外推 → null（重置时刻以官方为唯一权威）
  assert.equal(computeConclusion([row(73, null)], rising, now), null);

  // 多实例取 5h 水位最高者外推
  const rows2 = [row(73, resetMs), { ...row(90, now + 2 * HOUR), providerId: "p2", name: "实例乙" }];
  const hist = new Map([
    ["p1", rising.get("p1")],
    ["p2", Array.from({ length: 6 }, (_, i) => ({ t: now - (5 - i) * 300000, pct: 88 + i * 0.4 }))],
  ]);
  const c3 = computeConclusion(rows2, hist, now);
  assert.equal(c3.instanceName, "实例乙", "取 5h 水位最高实例");
});

// ---------------------------------------------------------------------------
// 四、computeQuota 兜底收窄（§五.3：5h 分子走小时桶；周/月无本地分子）
// ---------------------------------------------------------------------------

test("额度兜底收窄：5h 分子取 windowSum（小时桶）；周/月官方失败 used=null 无本地分子", async () => {
  const now = 1732252927000;
  const buckets = newBuckets();
  // 近 5h 两个覆盖桶（各 310 token）+ 窗口外旧桶（不得计入 5h 分子）
  addRow(buckets, makeRow({ rowid: 1, completedAt: now - 3 * HOUR }));
  addRow(buckets, makeRow({ rowid: 2, completedAt: now - HOUR }));
  addRow(buckets, makeRow({ rowid: 3, completedAt: now - 10 * HOUR }));
  // keyless 夹具：无 apiKey → 官方不可用分支，不发任何请求
  const doc = {
    config: {
      providerConfigRules: {
        providerRules: [{ providerId: "p1", templateId: "bigmodel-api", providerName: "实例甲", config: { access: { type: "api_key" } } }],
      },
    },
  };

  const rows = await computeQuota(doc, now, buckets, () => {});
  assert.equal(rows.length, 1);
  const windows = rows[0].windows;
  assert.equal(windows.length, 2, "智谱家族=5h+周");

  const five = windows[0];
  assert.equal(five.type, "rolling-5h");
  assert.equal(five.used, 620, "5h 分子=窗口覆盖小时桶整桶和（310×2，窗口外旧桶不计入）");
  assert.equal(five.source, "unavailable", "无 apiKey → 官方不可用");
  assert.equal(five.percent, null, "官方百分比缺失且无分母 → 不编造本地百分比");

  const weekly = windows[1];
  assert.equal(weekly.type, "weekly");
  assert.equal(weekly.used, null, "周窗口删除本地分子兜底（官方失败仅出状态句）");
  assert.equal(weekly.percent, null);

  // 主百分比=rolling-5h 口径
  assert.equal(rows[0].percent, null);

  // 无规则实例（Qwen 家族）不出额度卡
  const qwenDoc = {
    config: { providerConfigRules: { providerRules: [{ providerId: "q1", templateId: "qwen-max", providerName: "Q", config: {} }] } },
  };
  assert.deepEqual(await computeQuota(qwenDoc, now, buckets, () => {}), []);
});
