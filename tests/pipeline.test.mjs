/**
 * 扩展服务层的单元测试：buildSnapshot 纯函数（唯一视图契约）+ 轮询 tick 管线。
 * 200 行混合数据（subagent/error/多模型/跨 5h 边界），断言字段契约、排序、无密钥泄漏。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSnapshot, tick } from "../extension/main.js";

const HOUR = 3600000;

/** 造混合数据集：200 行（多模型/多 provider/subagent/error/跨窗口），返回 buildSnapshot 入参 */
function makeMixedInput(now = 1700001000000) {
  const rows = [];
  const models = ["glm-4.7", "glm-4.6", "kimi-k3", "claude-sonnet-4"];
  const providers = ["bigmodel-api", "bigmodel-api", "kimi-code-cn", "opencode-go-messages"];
  for (let i = 0; i < 200; i++) {
    const inWindow = i >= 190; // 最近 10 行落在 60s 速率窗口
    const completedAt = inWindow ? now - (200 - i) * 300 : now - 3 * HOUR - i * 60000;
    const isError = i % 8 === 5; // 少量 error 行（含速率窗口内的样本，如 i=197）
    const genMs = 800 + (i % 7) * 900;
    rows.push({
      id: i + 1,
      sessionId: "sess" + (i % 4),
      querySource: i % 5 === 0 ? "subagent" : "main_turn",
      providerId: providers[i % 4],
      modelId: models[i % 4],
      status: isError ? "error" : "completed",
      startedAt: completedAt - genMs - 400,
      firstTokenAt: completedAt - genMs,
      completedAt,
      durationMs: genMs + 400,
      inputTokens: 1000 + i * 37,
      outputTokens: isError ? 0 : 200 + (i % 11) * 30,
      reasoningTokens: isError ? 0 : 20,
      retryCount: i % 23 === 0 ? 1 : 0,
    });
  }
  const toolRows = [
    { id: 1, toolName: "Read", status: "ok", startedAt: now - HOUR, durationMs: 120, outputBytes: 500 },
    { id: 2, toolName: "Bash", status: "ok", startedAt: now - HOUR, durationMs: 800, outputBytes: 2000 },
    { id: 3, toolName: "Bash", status: "error", startedAt: now - HOUR, durationMs: 300, outputBytes: 0 },
  ];
  const quotaRows = [
    {
      providerId: "bigmodel-api",
      name: "智谱 GLM",
      windows: [
        { type: "rolling-5h", percent: 42.5, used: 51000, limit: 120000, source: "official", nextResetMs: now + 2 * HOUR },
        { type: "weekly", percent: 18, used: 108000, limit: 600000, source: "official", nextResetMs: now + 2 * DAY },
      ],
      nextResetMs: now + 2 * HOUR,
      percent: 42.5,
      source: "official",
    },
  ];
  return { rows, toolRows, quotaRows };
}

const DAY = 86400000;

test("buildSnapshot：字段契约齐全、byModel 按最近完成排序、三态合法", () => {
  const now = 1700001000000;
  const { rows, toolRows, quotaRows } = makeMixedInput(now);
  const snap = buildSnapshot({
    rows,
    toolRows,
    quotaRows,
    now,
    rateState: { prevValue: 100, emaValue: 100, asOf: now - 5000, lastNewRowMs: now - 300 },
    projectBySession: { sess0: "E:\\proj-a", sess1: "E:\\proj-b" },
  });

  // 速率区
  assert.ok(snap.rate, "rate 区存在");
  assert.ok(["live", "held", "idle"].includes(snap.rate.display.state), "三态合法: " + snap.rate.display.state);
  assert.ok(snap.rate.main && typeof snap.rate.main.genRate === "number", "main 口径含 genRate");
  assert.ok(snap.rate.subagent && "genRate" in snap.rate.subagent, "subagent 口径存在");
  assert.ok(Array.isArray(snap.rate.byModel) && snap.rate.byModel.length > 0);
  for (let i = 1; i < snap.rate.byModel.length; i++) {
    assert.ok(snap.rate.byModel[i - 1].lastCompletedAt >= snap.rate.byModel[i].lastCompletedAt, "byModel 按 lastCompletedAt 降序");
  }

  // 额度区：每实例含 windows 数组
  assert.ok(Array.isArray(snap.quota) && snap.quota.length === 1);
  assert.equal(snap.quota[0].providerId, "bigmodel-api");
  assert.ok(Array.isArray(snap.quota[0].windows) && snap.quota[0].windows.length === 2);
  assert.equal(snap.quota[0].windows[0].type, "rolling-5h");

  // charts 六组齐全
  for (const key of ["throughput", "latency", "ctxVsRate", "byProject", "toolStats", "providerHealth", "heatmap"]) {
    assert.ok(snap.charts[key] !== undefined, "charts." + key + " 存在");
  }
  assert.ok(Array.isArray(snap.charts.throughput) && snap.charts.throughput[0].modelId, "吞吐对比含 modelId");
  assert.ok(snap.charts.heatmap.length === 7 && snap.charts.heatmap[0].length === 24, "热力图 7×24");
  assert.ok(snap.charts.byProject.length >= 1, "按项目统计存在");
  assert.ok(snap.charts.toolStats.some((t) => t.toolName === "Bash"), "工具统计含 Bash");
});

test("buildSnapshot：error 行不入速率但计入 provider 稳定性", () => {
  const now = 1700001000000;
  const { rows, toolRows, quotaRows } = makeMixedInput(now);
  const snap = buildSnapshot({ rows, toolRows, quotaRows, now, rateState: { prevValue: 100, emaValue: 100, asOf: now, lastNewRowMs: now } });
  const health = snap.charts.providerHealth;
  const withError = health.find((h) => h.requests > 0 && h.errorRate > 0);
  assert.ok(withError, "应有 provider 呈现非零错误率");
  const inWindowRows = rows.filter((r) => now - r.completedAt <= 60000);
  assert.ok(inWindowRows.some((r) => r.status === "error"), "窗口内确实有 error 行");
  // error 行产出为 0——若计入速率，genRate 会明显偏低；此处仅断言速率存在（口径由 rate.mjs 测试钉死）
  assert.ok(snap.rate.main.genRate === null || snap.rate.main.genRate > 0);
});

test("buildSnapshot：序列化结果不含密钥样式", () => {
  const now = 1700001000000;
  const { rows, toolRows, quotaRows } = makeMixedInput(now);
  const snap = buildSnapshot({ rows, toolRows, quotaRows, now, rateState: { prevValue: 1, emaValue: 1, asOf: now, lastNewRowMs: now } });
  const dumped = JSON.stringify(snap);
  assert.ok(!dumped.includes("sk-"), "快照不得含密钥样式");
  assert.ok(!dumped.includes("apiKey"), "快照不得含 apiKey 字段");
});

test("tick：游标推进、快照送达视图、可选文件落盘无敏感值", async () => {
  const now = 1700001000000;
  const { rows } = makeMixedInput(now);
  let fetchCalls = 0;
  const fetchNew = async (cursor) => {
    fetchCalls++;
    // 模拟第一轮拉到 200 行、第二轮无增量
    return cursor === 0 ? { rows, nextCursor: 200 } : { rows: [], nextCursor: 200 };
  };
  const delivered = [];
  const dir = mkdtempSync(join(tmpdir(), "zpowerpack-pipeline-"));
  const snapshotPath = join(dir, "last-snapshot.json");

  const state = { cursor: 0, rows: [], prevValue: 100, emaValue: 100, asOf: now - 5000, lastNewRowMs: null };
  const deps = {
    fetchNew,
    fetchTools: async () => [],
    fetchQuota: async () => [],
    fetchSessions: async () => [],
    deliver: (snap) => delivered.push(snap),
    snapshotPath,
    now: () => now,
    log: () => {},
  };

  await tick(state, deps);
  assert.equal(fetchCalls, 1, "tick 执行一次拉取");
  assert.equal(state.cursor, 200, "游标推进");
  assert.equal(delivered.length, 1, "快照送达一次");
  assert.ok(existsSync(snapshotPath), "可选快照文件已落盘");
  const fileDump = readFileSync(snapshotPath, "utf8");
  assert.ok(!fileDump.includes("sk-"), "落盘文件无密钥样式");

  await tick(state, deps);
  assert.equal(delivered.length, 2, "第二轮空增量仍送达（视图持续刷新）");
  assert.equal(state.cursor, 200);
});
