/**
 * 额度窗口规则引擎的单元测试。
 * V6 调研裁决：厂商真实窗口是订阅日锚定/接口返回，本地 windowBounds 仅为分子聚合的兜底近似；
 * API 可用时以 nextResetMs 锚定精确边界。Qwen 不含规则表（用户拍板）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { windowBounds, percent } from "../extension/core/quota.mjs";
import rules from "../extension/core/window-rules.json" with { type: "json" };

const HOUR = 3600000;
const DAY = 86400000;

test("window-rules.json：三厂商窗口组合按用户拍板，Qwen 不含", () => {
  assert.deepEqual(rules.zhipu.map((r) => r.type), ["rolling-5h", "weekly"]);
  assert.deepEqual(rules.kimi.map((r) => r.type), ["rolling-5h", "monthly"]);
  assert.deepEqual(rules.opencode.map((r) => r.type), ["rolling-5h", "weekly", "monthly"]);
  assert.ok(!("qwen" in rules), "Qwen 已按用户决策移出额度范围");
  const ruleArrays = Object.values(rules).filter((rs) => Array.isArray(rs));
  assert.ok(ruleArrays.length >= 3);
  assert.ok(ruleArrays.every((rs) => rs.every((r) => r.source === "official-api")));
});

test("windowBounds：rolling-5h 无 API 锚定 → [now-5h, now]，nextReset=now", () => {
  const now = 1700000000000;
  const b = windowBounds({ type: "rolling-5h" }, now);
  assert.equal(b.startMs, now - 18000000);
  assert.equal(b.endMs, now);
  assert.equal(b.nextResetMs, now);
});

test("windowBounds：rolling-5h 有 API 锚定 → [nextReset-5h, nextReset]", () => {
  const now = 1700000000000;
  const reset = now + 2 * HOUR;
  const b = windowBounds({ type: "rolling-5h" }, now, { nextResetMs: reset });
  assert.equal(b.startMs, reset - 5 * HOUR);
  assert.equal(b.endMs, reset);
  assert.equal(b.nextResetMs, reset);
});

test("windowBounds：weekly 无锚定 → trailing 7 天兜底；有锚定 → [锚-7d, 锚]（订阅日对齐，非自然周）", () => {
  const now = 1700000000000;
  const b1 = windowBounds({ type: "weekly" }, now);
  assert.equal(b1.startMs, now - 7 * DAY);
  assert.equal(b1.endMs, now);
  assert.equal(b1.nextResetMs, null, "无 API 时重置时刻未知");

  const anchor = now + 3 * DAY;
  const b2 = windowBounds({ type: "weekly" }, now, { nextResetMs: anchor });
  assert.equal(b2.startMs, anchor - 7 * DAY, "官方重置时刻回推一个完整周期");
  assert.equal(b2.endMs, anchor);
  assert.equal(b2.nextResetMs, anchor);
});

test("windowBounds：monthly 无锚定 → trailing 30 天兜底；有锚定 → [锚-30d, 锚]（近似周期长）", () => {
  const now = 1700000000000;
  const b1 = windowBounds({ type: "monthly" }, now);
  assert.equal(b1.startMs, now - 30 * DAY);
  const anchor = now + 5 * DAY;
  const b2 = windowBounds({ type: "monthly" }, now, { nextResetMs: anchor });
  assert.equal(b2.startMs, anchor - 30 * DAY, "月周期长按 30 天近似（界面注明以官方重置时间为准）");
  assert.equal(b2.endMs, anchor);
});

test("percent：limit null/0 → null，否则保留 1 位", () => {
  assert.equal(percent(23000, null), null);
  assert.equal(percent(23, 0), null);
  assert.equal(percent(23, 100), 23.0);
  assert.equal(percent(1, 3), 33.3);
});
