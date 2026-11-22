/**
 * 指标层 rate.mjs 的单元测试（核心口径，100% 覆盖）。
 * 钉死设计文档 §五 的口径：TTFT 剔除、时长加权、EMA 平滑、保持逻辑、错误行剔除。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { requestTps, windowedRate, ema, displayRate } from "../extension/core/rate.mjs";

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

/** 造一行 model_usage 样本 */
function rowOf({ id, modelId = "glm-4.7", outputTokens, genMs, completedAt, status = "completed", querySource = "main_turn", reasoningTokens = 0 }) {
  return {
    id,
    modelId,
    querySource,
    status,
    outputTokens,
    reasoningTokens,
    firstTokenAt: completedAt - genMs,
    completedAt,
    durationMs: genMs,
  };
}

test("windowedRate：3 行两模型分组，genRate=Σout/Σgen，error 行不计入", () => {
  // 窗口 now=60000：60s 窗口内 3 行（模型 A×2、模型 B×1）+ 1 行 error（应剔除）
  const now = 60000;
  const rows = [
    rowOf({ id: 1, modelId: "A", outputTokens: 1000, genMs: 5000, completedAt: now - 10000 }), // 200 tps
    rowOf({ id: 2, modelId: "A", outputTokens: 500, genMs: 2500, completedAt: now - 5000 }), // 200 tps
    rowOf({ id: 3, modelId: "B", outputTokens: 300, genMs: 1000, completedAt: now - 2000, querySource: "subagent" }), // 300 tps
    rowOf({ id: 4, modelId: "A", outputTokens: 99999, genMs: 100, completedAt: now - 1000, status: "error" }),
  ];
  const r = windowedRate(rows, { now, windowMs: 60000 });
  // 主口径：Σout/Σgen = 1800/8.5 = 211.76
  assert.equal(r.genRate, 211.76);
  // 吞吐：Σout ÷ 窗口秒 = 1800/60 = 30
  assert.equal(r.throughput, 30);
  assert.equal(r.sampleDurationMs, 8500);
  assert.equal(r.byModel.size, 2, "error 行所属模型仍出现但仅按正常行聚合");
  const a = r.byModel.get("A");
  assert.equal(a.genRate, 200, "模型 A 两行各 200tps，加权后仍 200");
  assert.equal(a.throughput, 25);
  assert.equal(a.lastCompletedAt, now - 5000);
  assert.equal(a.querySource, "main_turn");
  assert.equal(r.byModel.get("B").querySource, "subagent");
  assert.ok(!JSON.stringify([...r.byModel.values()]).includes("99999"), "error 行产出不得计入");
});

test("windowedRate：窗口外的行不参与", () => {
  const now = 60000;
  const rows = [
    rowOf({ id: 1, outputTokens: 6000, genMs: 1000, completedAt: now - 120000 }), // 窗口外
    rowOf({ id: 2, outputTokens: 100, genMs: 1000, completedAt: now }),
  ];
  const r = windowedRate(rows, { now, windowMs: 60000 });
  assert.equal(r.genRate, 100);
  assert.equal(r.throughput, 1.67, "吞吐保留 2 位（100÷60s）");
});

test("ema(100, 120, 0.3) = 106", () => {
  assert.equal(ema(100, 120, 0.3), 106);
});

test("displayRate：样本不足（Σ生成时长<2s）→ held 且保持上波值", () => {
  const r = displayRate(
    { currentValue: 210, prevValue: 190, asOf: 5000, sampleDurationMs: 800, lastNewRowMs: 5900 },
    { now: 6000 },
  );
  assert.equal(r.state, "held");
  assert.equal(r.value, 190);
  assert.equal(r.asOf, 5000);
});

test("displayRate：窗口内无新完成行 → held（不显示 0）", () => {
  const r = displayRate(
    { currentValue: 210, prevValue: 190, asOf: 5000, sampleDurationMs: 8000, lastNewRowMs: null },
    { now: 6000 },
  );
  assert.equal(r.state, "held");
  assert.equal(r.value, 190);
});

test("displayRate：超过保持上限（5 分钟无新样本）→ idle", () => {
  const r = displayRate(
    { currentValue: 210, prevValue: 190, asOf: 0, sampleDurationMs: 8000, lastNewRowMs: 1000 },
    { now: 300001, holdMaxMs: 300000 },
  );
  assert.equal(r.state, "idle");
});

test("displayRate：样本充足且有新行 → live 当前值", () => {
  const r = displayRate(
    { currentValue: 210, prevValue: 190, asOf: 5000, sampleDurationMs: 8000, lastNewRowMs: 5900 },
    { now: 6000 },
  );
  assert.equal(r.state, "live");
  assert.equal(r.value, 210);
});

test("平滑钉死：超短请求与长请求混合，时长加权 genRate 不超过长请求速率 ±10%", () => {
  const now = 60000;
  const rows = [
    rowOf({ id: 1, outputTokens: 50, genMs: 80, completedAt: now - 1000 }), // 超短请求 625tps（会被加权稀释）
    rowOf({ id: 2, outputTokens: 9000, genMs: 30000, completedAt: now }), // 长请求 300tps
  ];
  const r = windowedRate(rows, { now, windowMs: 60000 });
  // 加权口径：(50+9000)/(0.08+30)s = 300.86 → 与长请求速率差 <1%
  assert.ok(Math.abs(r.genRate - 300) / 300 <= 0.1, "genRate=" + r.genRate + " 应落在长请求速率 ±10% 内");
});
