/**
 * v0.3 速率素条测试：速率状态机（仅主代理）+ 扩展接线（事件订阅/会话作用域推送/为空隐藏/
 * 停工保留末值）+ manifest 终局裁剪契约。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { activate, deactivate, bindOnGenerate } from "../extension/main.js";
import { createRateBoard, fmtRate, LIVE_WARMUP_EVENTS, RETRY_RESET_MS, STALE_STREAM_MS } from "../extension/core/live-rate.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** 组装生成事件载荷（宿主 camelCase 契约） */
function ev({ sessionId = "s1", requestId = "r1", phase = "streaming", tps = 428.6 } = {}) {
  return { sessionId, requestId, model: { providerId: "p", modelId: "m" }, phase, outputTokensPerSecond: tps };
}

/** 等待 activate 内 visibleSessions 初值拉取的微任务链落定 */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 组装 mock 扩展上下文。
 * @param {{workbench?: boolean, modelsForm?: "fn"|"object"|"subscribe", visibleSessions?: object[]}} opts
 */
function makeCtx(opts = {}) {
  const { workbench = true, modelsForm = "fn", visibleSessions = [{ sessionId: "s1" }] } = opts;
  const calls = { slots: [], commands: [], disposed: 0 };
  const listeners = { generate: null, workbench: null };
  const ctx = {
    slots: {
      update(id, patch, scope) {
        calls.slots.push({ id, patch, scope });
      },
    },
    commands: {
      register(id, handler) {
        calls.commands.push({ id, handler });
      },
    },
    models: {},
  };
  const handle = { dispose() { calls.disposed++; } };
  if (modelsForm === "fn") {
    ctx.models.onDidGenerate = (handler) => {
      listeners.generate = handler;
      return handle;
    };
  } else if (modelsForm === "object") {
    ctx.models.onDidGenerate = { subscribe: (handler) => { listeners.generate = handler; return handle; } };
  } else if (modelsForm === "subscribe") {
    // 直挂形态缺失/抛错后落到 models.subscribe 通用入口
    ctx.models.onDidGenerate = () => { throw new Error("该形态未实现"); };
    ctx.models.subscribe = (name, handler) => {
      assert.equal(name, "onDidGenerate");
      listeners.generate = handler;
      return handle;
    };
  }
  if (workbench) {
    ctx.workbench = {
      onDidChange: (cb) => { listeners.workbench = cb; return handle; },
      visibleSessions: async () => ({ sessions: visibleSessions }),
    };
  }
  return { ctx, calls, listeners };
}

// ---------------------------------------------------------------------------
// 速率状态机
// ---------------------------------------------------------------------------

test("fmtRate：1 位小数去尾零；非法数值返回 null", () => {
  assert.equal(fmtRate(428.6), "428.6");
  assert.equal(fmtRate(300), "300");
  assert.equal(fmtRate(120.77), "120.8");
  assert.equal(fmtRate(NaN), null);
  assert.equal(fmtRate(undefined), null);
});

test("速率状态机：开场先展示上一次精值，累计 4 条 streaming 后才切 ~ 估算（万级伪影不上屏）", () => {
  const board = createRateBoard();
  board.onEvent(ev({ phase: "final", tps: 120.8 }), 0);
  assert.equal(board.displayFor("s1", 0), "120.8 tok/s");

  // 新请求开场：前 4 条 streaming 全部不上屏，继续展示上一次精值（即使官方估算上万）
  for (let i = 1; i <= LIVE_WARMUP_EVENTS; i++) {
    assert.equal(board.onEvent(ev({ tps: 10000 }), i * 500), false, `第 ${i} 条 warm-up 不上屏`);
    assert.equal(board.displayFor("s1", i * 500), "120.8 tok/s", "开场继续展示上一次精值");
  }
  // 第 5 条（约 +2s）切到实时估算
  assert.equal(board.onEvent(ev({ tps: 428.66 }), (LIVE_WARMUP_EVENTS + 1) * 500), true);
  assert.equal(board.displayFor("s1", (LIVE_WARMUP_EVENTS + 1) * 500), "~428.7 tok/s");

  board.onEvent(ev({ phase: "final", tps: 130.4 }), (LIVE_WARMUP_EVENTS + 2) * 500);
  assert.equal(board.displayFor("s1"), "130.4 tok/s", "final 是真实 token 精值");
});

test("速率状态机：同请求以末次官方推送值为准；多流取均值（新流 warm-up 期间看旧流）", () => {
  const board = createRateBoard();
  for (let i = 0; i <= LIVE_WARMUP_EVENTS; i++) board.onEvent(ev({ requestId: "r1", tps: 300 }), i * 500);
  assert.equal(board.displayFor("s1", LIVE_WARMUP_EVENTS * 500), "~300 tok/s");

  // r2 开场 4 条：不参与展示，继续显示 r1 的值
  for (let i = 0; i < LIVE_WARMUP_EVENTS; i++) board.onEvent(ev({ requestId: "r2", tps: 500 }), 3000 + i * 500);
  assert.equal(board.displayFor("s1", 4500), "~300 tok/s", "r2 尚在 warm-up，不参与展示");

  board.onEvent(ev({ requestId: "r2", tps: 500 }), 3000 + LIVE_WARMUP_EVENTS * 500);
  assert.equal(board.displayFor("s1", 5000), "~400 tok/s", "r2 过热身后与 r1 取均值");
});

test("速率状态机：会话隔离；final 后新一轮逐条 warm-up 保持上一精值，满 4 条后换新估算", () => {
  const board = createRateBoard();
  board.onEvent(ev({ sessionId: "s1", phase: "final", tps: 90 }), 0);
  board.onEvent(ev({ sessionId: "s2", phase: "final", tps: 200 }), 0);
  assert.equal(board.displayFor("s1"), "90 tok/s");
  assert.equal(board.displayFor("s2"), "200 tok/s");

  for (let i = 1; i <= LIVE_WARMUP_EVENTS; i++) {
    board.onEvent(ev({ sessionId: "s1", requestId: "r9", tps: 250 }), i * 500);
    assert.equal(board.displayFor("s1"), "90 tok/s", `第 ${i} 条 warm-up 保持上一精值`);
  }
  board.onEvent(ev({ sessionId: "s1", requestId: "r9", tps: 250 }), (LIVE_WARMUP_EVENTS + 1) * 500);
  assert.equal(board.displayFor("s1", (LIVE_WARMUP_EVENTS + 1) * 500), "~250 tok/s");
  assert.equal(board.displayFor("s2"), "200 tok/s", "其他会话不受影响");
});

test("速率状态机：缺键/非数值速率事件静默忽略（不编造数据）", () => {
  const board = createRateBoard();
  board.onEvent({});
  board.onEvent(ev({ tps: Number.NaN }));
  board.onEvent({ sessionId: "s1", requestId: "r1", phase: "streaming", outputTokensPerSecond: "428" });
  assert.equal(board.displayFor("s1"), null);
});

test("速率状态机：请求静默超 3s 视为宿主重试/重置，重新 warm-up 并保留上一精值", () => {
  const board = createRateBoard();
  board.onEvent(ev({ phase: "final", tps: 120 }), 0);
  for (let i = 0; i <= LIVE_WARMUP_EVENTS; i++) board.onEvent(ev({ tps: 150 }), 1000 + i * 500);
  assert.equal(board.displayFor("s1", 1000 + LIVE_WARMUP_EVENTS * 500), "~150 tok/s");

  // 静默超过阈值后同一 requestId 再推：宿主已清空累计窗口，重新 warm-up，回到上一精值
  const gapAt = 1000 + LIVE_WARMUP_EVENTS * 500 + RETRY_RESET_MS + 1;
  assert.equal(board.onEvent(ev({ tps: 10000 }), gapAt), false, "重试首帧不上屏");
  assert.equal(board.displayFor("s1", gapAt), "120 tok/s", "回到上一精值");
  for (let i = 1; i < LIVE_WARMUP_EVENTS; i++) board.onEvent(ev({ tps: 10000 }), gapAt + i * 500);
  assert.equal(board.displayFor("s1", gapAt + (LIVE_WARMUP_EVENTS - 1) * 500), "120 tok/s");
  board.onEvent(ev({ tps: 140 }), gapAt + LIVE_WARMUP_EVENTS * 500);
  assert.equal(board.displayFor("s1", gapAt + LIVE_WARMUP_EVENTS * 500), "~140 tok/s");
});

test("速率状态机：滞留流（取消/失败无 final）超时后不再假装生成中；final 精值永久保留", () => {
  const board = createRateBoard();
  for (let i = 0; i <= LIVE_WARMUP_EVENTS; i++) board.onEvent(ev({ tps: 120 }), i * 500);
  const liveAt = LIVE_WARMUP_EVENTS * 500;
  assert.equal(board.displayFor("s1", liveAt), "~120 tok/s");

  const staleAt = liveAt + STALE_STREAM_MS + 1;
  assert.equal(board.displayFor("s1", staleAt), null, "滞留且无 final → 隐藏，不显示 ~ 假装在跑");
  board.expire(staleAt);
  assert.equal(board.displayFor("s1", staleAt), null);

  // final 精值不受滞留清理影响：停工后「之前的速率」永久保留
  const board2 = createRateBoard();
  for (let i = 0; i <= LIVE_WARMUP_EVENTS; i++) board2.onEvent(ev({ tps: 120 }), i * 500);
  board2.onEvent(ev({ phase: "final", tps: 121 }), (LIVE_WARMUP_EVENTS + 1) * 500);
  board2.expire(999999999);
  assert.equal(board2.displayFor("s1", 999999999), "121 tok/s");
});

// ---------------------------------------------------------------------------
// 扩展接线
// ---------------------------------------------------------------------------

test("activate：可见会话无数据 → 推 visible:false（为空不展示）；不注册视图/资源", async () => {
  const { ctx, calls } = makeCtx({ visibleSessions: [{ sessionId: "s1" }, { sessionId: "s2" }] });
  const handle = await activate(ctx, { log: () => {} });
  await flush();
  assert.deepEqual(calls.slots, [
    { id: "zpowerpack-mini", patch: { text: "", visible: false }, scope: { sessionId: "s1" } },
    { id: "zpowerpack-mini", patch: { text: "", visible: false }, scope: { sessionId: "s2" } },
  ]);
  assert.equal(calls.commands.length, 1, "命令注册（composer.status 目标）");
  assert.equal(calls.commands[0].id, "zpowerpack-rate-status");
  assert.equal(typeof calls.commands[0].handler, "function");
  assert.equal(ctx.views, undefined, "不得注册详情面板");
  handle.stop();
});

test("activate：生成事件点亮当前会话素条，final 后继续展示之前的速率；同值去重", async () => {
  const { ctx, calls, listeners } = makeCtx({ visibleSessions: [{ sessionId: "s1" }, { sessionId: "s2" }] });
  await activate(ctx, { log: () => {} });
  await flush();
  calls.slots.length = 0;

  // 只给 s1 推事件：开场 4 条 streaming 全部不上屏（先展示上一次精值/无历史则隐藏）；第 5 条才点亮
  for (let i = 0; i < LIVE_WARMUP_EVENTS; i++) {
    listeners.generate(ev({ sessionId: "s1", tps: 10000 }), 1000 + i * 500);
    assert.deepEqual(calls.slots, [], `第 ${i + 1} 条 warm-up 不上屏`);
  }
  listeners.generate(ev({ sessionId: "s1", tps: 428.66 }), 1000 + LIVE_WARMUP_EVENTS * 500);
  assert.deepEqual(calls.slots, [
    { id: "zpowerpack-mini", patch: { text: "~428.7 tok/s", visible: true }, scope: { sessionId: "s1" } },
  ]);

  // final 绕过节流立即上屏（真实 token 精值）；s2 仍隐藏但同值已推过 → 不重复推
  calls.slots.length = 0;
  listeners.generate(ev({ sessionId: "s1", phase: "final", tps: 120.77 }), 1000 + (LIVE_WARMUP_EVENTS + 1) * 500);
  assert.deepEqual(calls.slots, [
    { id: "zpowerpack-mini", patch: { text: "120.8 tok/s", visible: true }, scope: { sessionId: "s1" } },
  ]);

  // 同一 final 值重复到达 → 去重零推送
  calls.slots.length = 0;
  listeners.generate(ev({ sessionId: "s1", phase: "final", tps: 120.77 }), 1000 + (LIVE_WARMUP_EVENTS + 2) * 500);
  assert.equal(calls.slots.length, 0);
  deactivate();
});

test("activate：streaming 1s 节流只刷一次，final 绕过；warm-up 事件不占节流窗口", async () => {
  const { ctx, calls, listeners } = makeCtx({ visibleSessions: [{ sessionId: "s1" }] });
  await activate(ctx, { log: () => {} });
  await flush();
  calls.slots.length = 0;

  // 前 4 条 warm-up：不上屏、不占节流
  for (let i = 0; i < LIVE_WARMUP_EVENTS; i++) listeners.generate(ev({ tps: 100 }), 2000 + i * 500);
  // 第 5 条：立即上屏
  listeners.generate(ev({ tps: 200 }), 2000 + LIVE_WARMUP_EVENTS * 500);
  // 第 6 条：1s 内被节流
  listeners.generate(ev({ tps: 250 }), 2000 + LIVE_WARMUP_EVENTS * 500 + 100);
  assert.equal(calls.slots.length, 1, "1s 内后续可展示事件被节流");
  assert.equal(calls.slots[0].patch.text, "~200 tok/s");

  listeners.generate(ev({ phase: "final", tps: 300 }), 2000 + LIVE_WARMUP_EVENTS * 500 + 200);
  assert.equal(calls.slots.length, 2, "final 不受节流约束");
  assert.equal(calls.slots[1].patch.text, "300 tok/s");
  deactivate();
});

test("activate：workbench 不可达 → 只跟随最近事件会话；无事件时零推送", async () => {
  const { ctx, calls, listeners } = makeCtx({ workbench: false });
  await activate(ctx, { log: () => {} });
  await flush();
  assert.equal(calls.slots.length, 0, "无会话目标时不得推全局值");

  listeners.generate(ev({ sessionId: "s9", phase: "final", tps: 88 }), 1000);
  assert.deepEqual(calls.slots, [
    { id: "zpowerpack-mini", patch: { text: "88 tok/s", visible: true }, scope: { sessionId: "s9" } },
  ]);
  deactivate();
});

test("activate：workbench 变更 → 新会话按自身数据补推（有值上屏、无值隐藏）", async () => {
  const { ctx, calls, listeners } = makeCtx({ visibleSessions: [{ sessionId: "s1" }] });
  await activate(ctx, { log: () => {} });
  await flush();
  listeners.generate(ev({ sessionId: "s2", phase: "final", tps: 300 }), 1000);
  calls.slots.length = 0;

  // 用户切到 s2：s2 有历史精值上屏；s1 的隐藏值激活时已推过 → 去重不重复推
  listeners.workbench({ sessions: [{ sessionId: "s1" }, { sessionId: "s2" }] });
  assert.deepEqual(calls.slots, [
    { id: "zpowerpack-mini", patch: { text: "300 tok/s", visible: true }, scope: { sessionId: "s2" } },
  ]);
  deactivate();
});

test("activate：素条推送失败不记去重键——同值重试必须发生", async () => {
  const { ctx, calls, listeners } = makeCtx({ visibleSessions: [{ sessionId: "s1" }] });
  let fail = true;
  ctx.slots.update = (id, patch, scope) => {
    if (fail) throw new Error("patch 校验失败");
    calls.slots.push({ id, patch, scope });
  };
  await activate(ctx, { log: () => {} });
  await flush();
  assert.equal(calls.slots.length, 0, "初值推送被宿主拒收");

  fail = false;
  // 同一隐藏值重试（workbench 变更触发立即刷新）：失败时若写了去重键，这里就不会推
  listeners.workbench({ sessions: [{ sessionId: "s1" }] });
  assert.deepEqual(calls.slots, [
    { id: "zpowerpack-mini", patch: { text: "", visible: false }, scope: { sessionId: "s1" } },
  ]);
  deactivate();
});

test("bindOnGenerate：函数直挂优先；抛错降级 models.subscribe；全败返回 null", () => {
  const direct = makeCtx({ modelsForm: "fn" });
  const form = bindOnGenerate(direct.ctx, () => {}, () => {});
  assert.equal(form, "ctx.models.onDidGenerate()");

  const fallback = makeCtx({ modelsForm: "subscribe" });
  assert.equal(bindOnGenerate(fallback.ctx, () => {}, () => {}), 'ctx.models.subscribe("onDidGenerate", cb)');

  const none = { ctx: {} };
  assert.equal(bindOnGenerate(none.ctx, () => {}, () => {}), null);
});

test("stop/deactivate：退订生成订阅与 workbench 订阅各一次，重复 deactivate 幂等", async () => {
  const { ctx, calls } = makeCtx();
  const handle = await activate(ctx, { log: () => {} });
  await flush();
  handle.stop();
  handle.stop();
  assert.equal(calls.disposed, 2, "生成订阅 + workbench 订阅各退订一次");
  deactivate();
  assert.equal(calls.disposed, 2, "重复 deactivate 不重复退订");
});

// ---------------------------------------------------------------------------
// manifest 终局裁剪契约
// ---------------------------------------------------------------------------

test("manifest：0.3.3、无视图入口、composer.status 单条且命令目标已声明", () => {
  const plugin = JSON.parse(readFileSync(join(ROOT, ".zcode-plugin", "plugin.json"), "utf8"));
  assert.equal(plugin.version, "0.3.3");
  assert.equal(plugin.extension.engines.zcode, "^1.4.0");
  assert.ok(!plugin.extension.main.startsWith("/") && !plugin.extension.main.includes(".."), "main 必须是插件根内相对路径");
  assert.equal(plugin.extension.contributes.views, undefined, "详情面板已砍除");
  const commands = plugin.extension.contributes.commands;
  assert.equal(commands.length, 1);
  assert.match(commands[0].id, /^[a-z0-9._-]{1,64}$/, "命令 id 必须符合宿主 schema");
  assert.equal(commands[0].id, "zpowerpack-rate-status");

  const items = plugin.slots?.["composer.status"];
  assert.equal(items.length, 1, "composer.status 每插件仅一条");
  const item = items[0];
  assert.match(item.id, /^[a-z0-9._-]{1,64}$/, "插槽条目 id 必须符合宿主 schema");
  assert.equal(item.id, "zpowerpack-mini");
  assert.match(item.icon, /^[a-z0-9-]{1,48}$/, "图标必须在宿主命名词表内");
  assert.equal(item.icon, "gauge");
  assert.ok(Number.isInteger(item.order) && item.order >= -1000 && item.order <= 1000, "order 必须是 -1000..1000 整数");
  assert.ok(typeof item.title === "string" && item.title.length >= 1 && item.title.length <= 80, "title 长度 1..80");
  assert.equal(Object.keys(item.target).length, 1, "target 只能有一个键（宿主 schema refine）");
  assert.deepEqual(item.target, { command: commands[0].id }, "插槽目标指向已声明命令（宿主 schema 硬约束）");
  assert.equal(item.target.view, undefined, "不得指向视图");
});

test("manifest：描述只承诺实时速率（不再宣传额度/趋势）；marketplace 版本同步", () => {
  const plugin = JSON.parse(readFileSync(join(ROOT, ".zcode-plugin", "plugin.json"), "utf8"));
  for (const banned of ["额度", "趋势", "看板", "套餐"]) {
    assert.ok(!plugin.description.includes(banned), `描述不得再含「${banned}」`);
  }
  const market = JSON.parse(readFileSync(join(ROOT, "marketplace.json"), "utf8"));
  const entry = market.plugins.find((p) => p.name === "zpowerpack");
  assert.equal(entry.version, plugin.version, "marketplace 版本必须与 plugin.json 同步（部署缓存按版本刷新）");
  assert.equal(entry.description, plugin.description);
});
