/**
 * 官方分母获取模块的单元测试（V6 调研路由表 + stub fetch，不发真实网络请求）。
 * 覆盖：三厂商路由与鉴权头形态、官方值解析、失败回退用户配置、超时回退、密钥不落日志。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchLimit } from "../extension/core/quota-fetch.mjs";

/** 收集请求细节的 stub fetch */
function stubFetch(response, { reject = false, hang = false } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, headers: options?.headers ?? {} });
    if (reject) throw new Error("网络不可达");
    if (hang) return new Promise(() => {});
    return { ok: true, status: 200, json: async () => response };
  };
  return { impl, calls };
}

test("智谱 bigmodel 站：官方 limits 解析出绝对分母（usage+remaining），鉴权头无 Bearer", async () => {
  const { impl, calls } = stubFetch({
    code: 0,
    data: {
      level: "pro",
      limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 3000, remaining: 9000, percentage: 25, nextResetTime: 1770000000000 },
        { type: "TOKENS_LIMIT", unit: 6, usage: 12000, remaining: 48000, percentage: 20, nextResetTime: 1770100000000 },
      ],
    },
  });
  const r5h = await fetchLimit({
    family: "zhipu",
    templateId: "bigmodel-api",
    apiKeyRef: "sk-test-key-xyz",
    rule: { type: "rolling-5h" },
    userLimit: 500,
    fetchImpl: impl,
    log: () => {},
  });
  assert.equal(r5h.limit, 12000, "usage+remaining=分母");
  assert.equal(r5h.percent, 25);
  assert.equal(r5h.nextResetMs, 1770000000000);
  assert.equal(r5h.source, "official");
  assert.equal(calls[0].url, "https://open.bigmodel.cn/api/monitor/usage/quota/limit");
  assert.equal(calls[0].headers.Authorization, "sk-test-key-xyz", "bigmodel 站裸 key 无 Bearer（V6 实测）");

  const rWeek = await fetchLimit({ family: "zhipu", templateId: "bigmodel-api", apiKeyRef: "k", rule: { type: "weekly" }, userLimit: null, fetchImpl: impl, log: () => {} });
  assert.equal(rWeek.limit, 60000);
  assert.equal(rWeek.nextResetMs, 1770100000000);
});

test("智谱 zai 站：鉴权头加 Bearer 前缀", async () => {
  const { impl, calls } = stubFetch({ code: 0, data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 1, remaining: 2, percentage: 33, nextResetTime: 1 }] } });
  await fetchLimit({ family: "zhipu", templateId: "zai-api", apiKeyRef: "zai-token", rule: { type: "rolling-5h" }, userLimit: null, fetchImpl: impl, log: () => {} });
  assert.equal(calls[0].url, "https://api.z.ai/api/monitor/usage/quota/limit");
  assert.equal(calls[0].headers.Authorization, "Bearer zai-token", "zai 站 Bearer（V6：官方客户端行为）");
});

test("Kimi 新代际：仅 used_ratio → percent 来自官方、绝对分母回退用户配置", async () => {
  const { impl, calls } = stubFetch({
    usages: {
      limit_5h: { used_ratio: 0.2812, reset_time: "2026-11-22T05:49:16Z" },
      limit_month_code: { used_ratio: 0.7023, reset_time: "2026-11-30T00:00:00Z" },
    },
  });
  const r5h = await fetchLimit({
    family: "kimi",
    templateId: "kimi-code-cn",
    apiKeyRef: "sk-kimi-key",
    rule: { type: "rolling-5h" },
    userLimit: 400000,
    fetchImpl: impl,
    log: () => {},
  });
  assert.equal(r5h.limit, null, "新代际无绝对分母");
  assert.equal(r5h.percent, 28.1, "百分比保留 1 位");
  assert.equal(r5h.source, "official", "官方百分比可用即视为 official");
  assert.equal(calls[0].url, "https://api.kimi.com/coding/v1/usages");
  assert.equal(calls[0].headers.Authorization, "Bearer sk-kimi-key");
  assert.equal(calls[0].headers.Accept, "application/json");

  const rMonth = await fetchLimit({ family: "kimi", templateId: "kimi-code-cn", apiKeyRef: "k", rule: { type: "monthly" }, userLimit: 9000000, fetchImpl: impl, log: () => {} });
  assert.equal(rMonth.limit, null);
  assert.equal(rMonth.percent, 70.2);
});

test("Kimi 旧代际：usage/limits 字符串计数解析出绝对分母", async () => {
  const { impl } = stubFetch({
    usage: { limit: "1000", used: "250", resetTime: "2026-10-01T00:00:00.000Z" },
    limits: [
      { window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "300", used: "120", resetTime: "2026-09-26T18:00:00.000Z" } },
    ],
  });
  const r = await fetchLimit({ family: "kimi", templateId: "kimi-code-cn", apiKeyRef: "k", rule: { type: "rolling-5h" }, userLimit: 999, fetchImpl: impl, log: () => {} });
  assert.equal(r.limit, 300, "旧代际 limits[].detail.limit 为绝对分母（字符串数字）");
  assert.equal(r.source, "official");
});

test("OpenCode：usage 三窗口百分比，无绝对分母 → official + percent", async () => {
  const { impl, calls } = stubFetch({
    usage: {
      rolling: { status: "ok", percent: 42, resetsAt: "2026-10-24T17:00:00.000Z" },
      weekly: { status: "ok", percent: 18, resetsAt: "2026-10-24T17:00:00.000Z" },
      monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-10-24T17:00:00.000Z" },
    },
  });
  const r = await fetchLimit({ family: "opencode", templateId: "opencode-go-messages", apiKeyRef: "oc-key", rule: { type: "monthly" }, userLimit: 123, fetchImpl: impl, log: () => {} });
  assert.equal(r.limit, null);
  assert.equal(r.percent, 100);
  assert.equal(r.nextResetMs, Date.parse("2026-10-24T17:00:00.000Z"));
  assert.equal(r.source, "official");
  assert.equal(calls[0].url, "https://opencode.ai/zen/go/v1/usage");
  assert.equal(calls[0].headers.Authorization, "Bearer oc-key");
});

test("fetch reject → 回退用户配置 source=user-config；用户配置也没有 → unavailable", async () => {
  const { impl } = stubFetch(null, { reject: true });
  const r1 = await fetchLimit({ family: "kimi", templateId: "kimi-code-cn", apiKeyRef: "k", rule: { type: "rolling-5h" }, userLimit: 500, fetchImpl: impl, log: () => {} });
  assert.deepEqual({ limit: r1.limit, source: r1.source }, { limit: 500, source: "user-config" });
  const r2 = await fetchLimit({ family: "kimi", templateId: "kimi-code-cn", apiKeyRef: "k", rule: { type: "rolling-5h" }, userLimit: null, fetchImpl: impl, log: () => {} });
  assert.deepEqual({ limit: r2.limit, source: r2.source }, { limit: null, source: "unavailable" });
});

test("官方响应 HTTP 500 → 回退用户配置", async () => {
  const impl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const r = await fetchLimit({ family: "zhipu", templateId: "bigmodel-api", apiKeyRef: "k", rule: { type: "rolling-5h" }, userLimit: 777, fetchImpl: impl, log: () => {} });
  assert.deepEqual({ limit: r.limit, source: r.source }, { limit: 777, source: "user-config" });
});

test("超时 → 回退用户配置（不悬挂）", async () => {
  const { impl } = stubFetch(null, { hang: true });
  const r = await fetchLimit({ family: "kimi", templateId: "kimi-code-cn", apiKeyRef: "k", rule: { type: "rolling-5h" }, userLimit: 321, fetchImpl: impl, timeoutMs: 30, log: () => {} });
  assert.deepEqual({ limit: r.limit, source: r.source }, { limit: 321, source: "user-config" });
});

test("未证实分母的厂商（other 家族）→ 直接用户配置/不可用，不发请求", async () => {
  const { impl, calls } = stubFetch({});
  const r = await fetchLimit({ family: "other", templateId: "deepseek", apiKeyRef: "k", rule: { type: "rolling-5h" }, userLimit: 88, fetchImpl: impl, log: () => {} });
  assert.deepEqual({ limit: r.limit, source: r.source }, { limit: 88, source: "user-config" });
  assert.equal(calls.length, 0, "无官方路由不得发请求");
});

test("密钥绝不落日志", async () => {
  const { impl } = stubFetch({ code: 0, data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 1, remaining: 2, percentage: 33, nextResetTime: 1 }] } });
  const logs = [];
  const key = "sk-super-secret-do-not-log-987654";
  await fetchLimit({ family: "zhipu", templateId: "bigmodel-api", apiKeyRef: key, rule: { type: "rolling-5h" }, userLimit: null, fetchImpl: impl, log: (l) => logs.push(String(l)) });
  assert.ok(!logs.join("\n").includes(key), "日志不得含密钥: " + logs.join(" | "));
});
