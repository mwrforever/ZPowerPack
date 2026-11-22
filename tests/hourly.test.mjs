/**
 * 小时桶聚合（hourly.mjs）的单元测试。
 * 纯函数无 IO，覆盖：completedAt 落桶与 in/out 分开累计、prune 25 小时界保留、
 * 固定 24 点趋势（空桶补零/跨 provider 求和/空态友好）、5h 窗口整桶近似求和、
 * 缺列降级容错（Task 1 db-reader 行字段可能 undefined，不抛错）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { hourKey, newBuckets, addRow, prune, trendPoints, windowSum } from "../extension/core/hourly.mjs";

/** 一小时的毫秒数（epoch 小时桶粒度） */
const HOUR_MS = 3600000;
/** 测试基准时刻：epoch 第 100 小时的正中间（5h 窗口两端跨桶的典型形态） */
const NOW = 100 * HOUR_MS + 1800000;

/** 造一行 db-reader camelCase 行（缺省 token 字段补 0，模拟正常落库数据） */
function row(pid, completedAt, { inputTokens = 0, outputTokens = 0, reasoningTokens = 0 } = {}) {
  return { providerId: pid, completedAt, inputTokens, outputTokens, reasoningTokens };
}

test("hourKey：epoch 毫秒整除为小时序号，小时界上的时刻归当小时", () => {
  assert.equal(hourKey(100 * HOUR_MS + 1800000), 100);
  assert.equal(hourKey(100 * HOUR_MS), 100, "恰在小时界上归当小时");
  assert.equal(hourKey(101 * HOUR_MS - 1), 100, "小时末尾 1ms 仍归该小时");
});

test("落桶：行按 completedAt 归所属 provider 小时，in/out 分开累计", () => {
  const buckets = newBuckets();
  // startedAt 在别的小时也不影响落桶：归属只看 completedAt（E1 行在完成时落库）
  addRow(buckets, {
    ...row("p1", 100 * HOUR_MS + 1000, { inputTokens: 100, outputTokens: 40, reasoningTokens: 10 }),
    startedAt: 98 * HOUR_MS,
  });
  addRow(buckets, row("p1", 100 * HOUR_MS + 2000, { inputTokens: 50, outputTokens: 5 }));
  addRow(buckets, row("p2", 99 * HOUR_MS + 500, { inputTokens: 7, outputTokens: 3 }));

  assert.deepEqual(buckets.get("p1").get(100), { in: 150, out: 55, reqs: 2 }, "out 含 reasoning：40+10 与 5+0");
  assert.deepEqual(buckets.get("p2").get(99), { in: 7, out: 3, reqs: 1 });
  assert.equal(buckets.get("p1").has(98), false, "startedAt 所在小时不落桶");
});

test("prune：过期桶删除，25 小时界上的桶保留", () => {
  // 手工铺桶（直接按 newBuckets 契约构造），p2 只有过期桶：验证桶全过期的 provider 一并移除
  const buckets = newBuckets();
  buckets.set("p1", new Map([
    [74, { in: 1, out: 1, reqs: 1 }],
    [75, { in: 1, out: 1, reqs: 1 }],
    [76, { in: 1, out: 1, reqs: 1 }],
    [77, { in: 1, out: 1, reqs: 1 }],
    [100, { in: 1, out: 1, reqs: 1 }],
  ]));
  buckets.set("p2", new Map([[74, { in: 1, out: 1, reqs: 1 }]]));
  prune(buckets, NOW);
  assert.deepEqual([...buckets.get("p1").keys()].sort((a, b) => a - b), [76, 77, 100], "界上桶 76（H-24）保留，更早删除");
  assert.equal(buckets.has("p2"), false, "桶全过期的 provider 不留空 Map");

  // 自定义 keepHours=3：界 = 当前小时 - 2
  const b2 = newBuckets();
  b2.set("p1", new Map([
    [97, { in: 1, out: 1, reqs: 1 }],
    [98, { in: 1, out: 1, reqs: 1 }],
    [100, { in: 1, out: 1, reqs: 1 }],
  ]));
  prune(b2, NOW, 3);
  assert.deepEqual([...b2.get("p1").keys()].sort((a, b) => a - b), [98, 100]);
});

test("趋势：固定 24 点升序，空桶补零，跨 provider 求和", () => {
  const buckets = newBuckets();
  addRow(buckets, row("p1", 100 * HOUR_MS, { inputTokens: 100, outputTokens: 50 })); // 当前小时
  addRow(buckets, row("p2", 100 * HOUR_MS, { inputTokens: 10, outputTokens: 5 }));
  addRow(buckets, row("p1", 77 * HOUR_MS, { inputTokens: 1, reasoningTokens: 1 })); // 24h 窗口最老一小时

  const pts = trendPoints(buckets, NOW);
  assert.equal(pts.length, 24, "固定 24 点");
  assert.equal(pts[0].hourMs, 77 * HOUR_MS, "起点 = hourKey(now)-23");
  assert.equal(pts[23].hourMs, 100 * HOUR_MS, "终点 = 当前小时");
  // 升序且逐点恰差 1 小时（折线连续的保证）
  for (let i = 1; i < pts.length; i++) {
    assert.equal(pts[i].hourMs - pts[i - 1].hourMs, HOUR_MS, `第 ${i} 点与上一点差 1 小时`);
  }
  assert.equal(pts[0].tokens, 2, "最老小时 in1+out1（reasoning 计入 out）");
  assert.equal(pts[23].tokens, 165, "当前小时跨 provider 求和：100+50+10+5");
  assert.equal(pts[5].tokens, 0, "无数据的小时补零");
});

test("趋势：空 buckets 也返回 24 个零点（视图空态友好）", () => {
  const pts = trendPoints(newBuckets(), NOW);
  assert.equal(pts.length, 24);
  assert.ok(pts.every((p) => p.tokens === 0), "全部为零");
  assert.equal(pts[0].hourMs, 77 * HOUR_MS);
});

test("窗口求和：5h 界跨桶时覆盖桶整桶计入（近似口径）；未知 provider 返回零值", () => {
  const buckets = newBuckets();
  // 5h 窗口两端均落在小时中间（官方额度拉取失败兜底的典型查询形态）
  const startMs = NOW - 5 * HOUR_MS; // 第 95 小时中间
  const endMs = NOW; // 第 100 小时中间
  addRow(buckets, row("p1", 94 * HOUR_MS, { inputTokens: 999 })); // 窗口外：不整桶计入
  addRow(buckets, row("p1", 95 * HOUR_MS + 1, { inputTokens: 10, outputTokens: 5 })); // 起点所在桶整桶计入
  addRow(buckets, row("p1", 97 * HOUR_MS, { inputTokens: 100, outputTokens: 50 })); // 窗口中段
  addRow(buckets, row("p1", 100 * HOUR_MS + 1, { inputTokens: 1, outputTokens: 1 })); // 终点所在桶整桶计入

  assert.deepEqual(windowSum(buckets, "p1", startMs, endMs), { in: 111, out: 56, reqs: 3 });
  assert.deepEqual(windowSum(buckets, "nope", startMs, endMs), { in: 0, out: 0, reqs: 0 }, "未知 provider 零值");
});

test("降级行容错：completedAt/providerId 缺失整行跳过，token 缺值按 0 计", () => {
  const buckets = newBuckets();
  addRow(buckets, { providerId: "p1", completedAt: undefined, inputTokens: 100 }); // 无完成时刻
  addRow(buckets, { completedAt: 100 * HOUR_MS, inputTokens: 50 }); // 无 providerId
  assert.equal(buckets.size, 0, "无法归位的行不产生桶");

  addRow(buckets, { providerId: "p1", completedAt: 100 * HOUR_MS }); // token 字段全缺：按 0 计，请求数照常累计
  addRow(buckets, { providerId: "p1", completedAt: 100 * HOUR_MS + 5, inputTokens: 30 }); // 仅 in 有值
  assert.deepEqual(buckets.get("p1").get(100), { in: 30, out: 0, reqs: 2 });
});
