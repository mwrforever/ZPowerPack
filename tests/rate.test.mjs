/**
 * 实时速率 live-rate.mjs 的单元测试（核心状态机，100% 覆盖）。
 *
 * 钉死 V2 口径：官方 onDidGenerate 流式事件驱动——streaming 建流、final 收流、
 * live/recent/idle 三态判定、camelCase 事件键名契约、noteFallbackRow 兜底；
 * 展示值=官方推送值原样（旧 EMA/窗口加权/三态保持口径全废，用例随之删除）。
 * requestTps 自 rate.mjs 原样迁移，四条边界用例保持不变。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { requestTps, createLiveRate } from "../extension/core/live-rate.mjs";

// ---- requestTps（自 rate.mjs 迁移，边界语义不变） ----

test("requestTps：output÷生成时长（毫秒换秒），303/2800ms → 108.21", () => {
  const row = { status: "completed", outputTokens: 303, completedAt: 317253, firstTokenAt: 314453 };
  assert.equal(requestTps(row), 108.21);
});

test("requestTps：first_token_at 缺失时按 duration_ms 兜底", () => {
  const row = { status: "completed", outputTokens: 303, completedAt: 83122, firstTokenAt: null, durationMs: 8012 };
  // 303 ÷ 8.012s = 37.818… → 保留 2 位 37.82（计划文档写 37.83 系四舍五入笔误，见 ledger 裁决）
  assert.equal(requestTps(row), 37.82);
});

test("requestTps：reasoning_tokens 计入产出", () => {
  const row = { status: "completed", outputTokens: 300, reasoningTokens: 3, completedAt: 317253, firstTokenAt: 314453 };
  assert.equal(requestTps(row), 108.21);
});

test("requestTps：非 completed / 分母≤0 / 缺产出 → null", () => {
  assert.equal(requestTps({ status: "error", outputTokens: 100, completedAt: 3000, firstTokenAt: 1000 }), null);
  assert.equal(requestTps({ status: "completed", outputTokens: 100, completedAt: 3000, firstTokenAt: 3000 }), null);
  assert.equal(requestTps({ status: "completed", outputTokens: 0, completedAt: 3000, firstTokenAt: 1000 }), null);
});

// ---- 官方流式事件状态机 createLiveRate ----

/** 构造 onDidGenerate 推送事件（camelCase 契约键名基线；Task 0 探针实测如有出入按 notes 调整映射） */
function evOf({ sessionId = "s-main", requestId, phase, tps, outputTokens, timeToFirstTokenMs }) {
  return {
    sessionId,
    requestId,
    model: { providerId: "zhipu", modelId: "glm-4.7" },
    phase,
    outputTokensPerSecond: tps,
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
  };
}

test("streaming 事件建流：单流 live，totalTps=流速率", () => {
  const live = createLiveRate();
  live.onEvent(evOf({ requestId: "r1", phase: "streaming", tps: 428 }), 1000, new Set());
  const snap = live.snapshot(1500);
  assert.equal(snap.state, "live");
  assert.equal(snap.streams.length, 1);
  assert.deepEqual(snap.streams[0], {
    requestId: "r1",
    modelId: "glm-4.7",
    providerId: "zhipu",
    isSub: false,
    tps: 428,
    phase: "streaming",
  });
  assert.equal(snap.totalTps, 428);
  assert.equal(snap.subTps, 0);
  assert.equal(snap.lastEventAt, 1000);
  assert.equal(snap.lastProviderId, "zhipu");
  assert.equal(snap.lastFinal, null);
  assert.equal(snap.fallback, null);
});

test("streaming 重复推送刷新速率：同 requestId 只更新流，不重复建流", () => {
  const live = createLiveRate();
  const subs = new Set();
  live.onEvent(evOf({ requestId: "r1", phase: "streaming", tps: 300 }), 1000, subs);
  // 官方流式期间持续推送瞬时速率，同流以末次推送为准（无平滑）
  live.onEvent(evOf({ requestId: "r1", phase: "streaming", tps: 428 }), 2000, subs);
  const snap = live.snapshot(2500);
  assert.equal(snap.streams.length, 1);
  assert.equal(snap.streams[0].tps, 428);
  assert.equal(snap.totalTps, 428);
});

test("多流并列：主+子代理双流，streams 两行、isSub 判定正确、subTps 只计子代理", () => {
  const live = createLiveRate();
  const subs = new Set(["s-sub"]);
  live.onEvent(evOf({ sessionId: "s-main", requestId: "r1", phase: "streaming", tps: 300 }), 1000, subs);
  live.onEvent(evOf({ sessionId: "s-sub", requestId: "r2", phase: "streaming", tps: 96 }), 1500, subs);
  const snap = live.snapshot(2000);
  assert.equal(snap.state, "live");
  assert.equal(snap.streams.length, 2);
  const main = snap.streams.find((s) => s.requestId === "r1");
  const sub = snap.streams.find((s) => s.requestId === "r2");
  assert.equal(main.isSub, false);
  assert.equal(sub.isSub, true);
  assert.equal(snap.totalTps, 396);
  assert.equal(snap.subTps, 96);
});

test("final 事件收流：流消失转 recent，lastFinal 记末值", () => {
  const live = createLiveRate();
  const subs = new Set();
  live.onEvent(evOf({ requestId: "r1", phase: "streaming", tps: 428 }), 1000, subs);
  live.onEvent(evOf({ requestId: "r1", phase: "final", tps: 415, outputTokens: 8300 }), 9000, subs);
  const snap = live.snapshot(10000);
  assert.equal(snap.state, "recent");
  assert.equal(snap.streams.length, 0);
  assert.equal(snap.totalTps, 0);
  assert.deepEqual(snap.lastFinal, { modelId: "glm-4.7", tps: 415, outputTokens: 8300, at: 9000 });
  assert.equal(snap.lastEventAt, 9000);
  assert.equal(snap.lastProviderId, "zhipu");
});

test("final 事件不带 outputTokens：lastFinal.outputTokens 置 null 保形稳定（契约可选键兜底分支）", () => {
  const live = createLiveRate();
  const subs = new Set();
  live.onEvent(evOf({ requestId: "r1", phase: "streaming", tps: 428 }), 1000, subs);
  // 契约中 outputTokens 为可选键：宿主 final 载荷缺失时末值记录须保持形状稳定（null 而非 undefined）
  live.onEvent(evOf({ requestId: "r1", phase: "final", tps: 415 }), 9000, subs);
  const snap = live.snapshot(10000);
  assert.deepEqual(snap.lastFinal, { modelId: "glm-4.7", tps: 415, outputTokens: null, at: 9000 });
});

test("空闲 5 分钟 → idle；recent 态保留末值不显示 0", () => {
  const live = createLiveRate();
  const subs = new Set();
  live.onEvent(evOf({ requestId: "r1", phase: "streaming", tps: 428 }), 1000, subs);
  live.onEvent(evOf({ requestId: "r1", phase: "final", tps: 415, outputTokens: 8300 }), 9000, subs);

  // final 后 4 分钟：recent 态无流，末值由 lastFinal 带出（视图展示数据时刻速率，不显示 0）
  let snap = live.snapshot(9000 + 240000);
  assert.equal(snap.state, "recent");
  assert.equal(snap.streams.length, 0);
  assert.equal(snap.totalTps, 0);
  assert.equal(snap.lastFinal.tps, 415);

  // 恰 5 分钟边界 → 仍 recent；超 1 毫秒 → idle
  snap = live.snapshot(9000 + 300000);
  assert.equal(snap.state, "recent");
  snap = live.snapshot(9000 + 300001);
  assert.equal(snap.state, "idle");
  // idle 后末值与最近厂商仍带出（素条空闲态跟随最近请求厂商）
  assert.equal(snap.lastFinal.tps, 415);
  assert.equal(snap.lastProviderId, "zhipu");
});

test("事件键名契约：camelCase 载荷直录（Task 0 定案键名不一致时按 notes 调整映射并有单测）", () => {
  const live = createLiveRate();
  // 蛇形诱饵键：实现必须只认 camelCase 契约键，误读蛇形键则本用例红
  const ev = {
    sessionId: "s-1",
    requestId: "r-1",
    model: { providerId: "zhipu", modelId: "glm-4.7" },
    phase: "streaming",
    outputTokensPerSecond: 428,
    timeToFirstTokenMs: 812,
    session_id: "s-decoy",
    request_id: "r-decoy",
    model_id: "decoy-model",
    provider_id: "decoy-provider",
    output_tokens_per_second: 999,
  };
  live.onEvent(ev, 1000, new Set(["s-1"]));
  const snap = live.snapshot(1100);
  assert.equal(snap.streams.length, 1);
  assert.equal(snap.streams[0].requestId, "r-1");
  assert.equal(snap.streams[0].modelId, "glm-4.7");
  assert.equal(snap.streams[0].providerId, "zhipu");
  assert.equal(snap.streams[0].tps, 428);
  assert.equal(snap.streams[0].isSub, true, "isSub 取决于 sessionId 是否命中子代理集合");
  assert.equal(snap.lastProviderId, "zhipu");
});

test("兜底：noteFallbackRow(null) 不抛错（row 缺失契约兜底）", () => {
  const live = createLiveRate();
  // requestTps 已容 null，completedAt 读取必须同样兜底：内部调用方虽已过滤，契约不得脆弱
  assert.doesNotThrow(() => live.noteFallbackRow(null));
  const snap = live.snapshot(1000);
  assert.deepEqual(snap.fallback, { tps: null, completedAt: null }, "缺失行兜底为 null 值而非抛错");
  assert.equal(snap.state, "idle");
});

test("兜底：noteFallbackRow 后 snapshot.fallback 有值，与流并存时流优先", () => {
  const live = createLiveRate();
  // 订阅不可达：服务层喂最新完成行（303 tokens / 2800ms → 108.21）
  live.noteFallbackRow({ status: "completed", outputTokens: 303, completedAt: 314453, firstTokenAt: 311653 });
  let snap = live.snapshot(320000);
  assert.deepEqual(snap.fallback, { tps: 108.21, completedAt: 314453 });
  // 兜底行不参与状态判定：无事件仍 idle（视图按 fallback 数据时刻渲染）
  assert.equal(snap.state, "idle");

  // 与流并存：状态与速率按流给（流优先由 state=live 表达），fallback 原样带出
  live.onEvent(evOf({ requestId: "r1", phase: "streaming", tps: 428 }), 320100, new Set());
  snap = live.snapshot(320200);
  assert.equal(snap.state, "live");
  assert.equal(snap.totalTps, 428);
  assert.deepEqual(snap.fallback, { tps: 108.21, completedAt: 314453 });
});
