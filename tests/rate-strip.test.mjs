/**
 * v0.3 速率素条测试：速率状态机（仅主代理）+ 扩展接线（事件订阅/会话作用域推送/为空隐藏/
 * 停工保留末值）+ manifest 终局裁剪契约。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { activate, deactivate, bindOnGenerate } from "../extension/main.js";
import { createRateBoard, fmtRate, STALE_STREAM_MS, MAX_LIVE_TPS } from "../extension/core/live-rate.mjs";

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

test("速率状态机：首帧只建状态不上屏；第二条 streaming 显示 ~ 估算值；final 显示精值", () => {
  const board = createRateBoard();
  assert.equal(board.displayFor("s1"), null, "无事件会话不可展示");
  assert.equal(board.onEvent(ev({ tps: 4666.67 })), false, "首帧窗口仅几毫秒，官方值属伪影，不上屏");
  assert.equal(board.displayFor("s1"), null);
  assert.equal(board.onEvent(ev({ tps: 428.66 })), true);
  assert.equal(board.displayFor("s1"), "~428.7 tok/s", "生成中加 ~ 标注字符估算");
  assert.equal(board.onEvent(ev({ phase: "final", tps: 120.77 })), true);
  assert.equal(board.displayFor("s1"), "120.8 tok/s", "停工后是真实 token 精值，不带 ~");
});

test("速率状态机：同请求 streaming 以末次官方推送值为准；多流取均值", () => {
  const board = createRateBoard();
  board.onEvent(ev({ requestId: "r1", tps: 100 })); // 首帧，不上屏
  board.onEvent(ev({ requestId: "r1", tps: 300 }));
  assert.equal(board.displayFor("s1"), "~300 tok/s");
  board.onEvent(ev({ requestId: "r2", tps: 500 })); // 新请求首帧，不上屏
  assert.equal(board.displayFor("s1"), "~300 tok/s");
  board.onEvent(ev({ requestId: "r2", tps: 500 }));
  assert.equal(board.displayFor("s1"), "~400 tok/s");
});

test("速率状态机：会话隔离；final 后新一轮 streaming 先保留精值，第二帧起换新估算", () => {
  const board = createRateBoard();
  board.onEvent(ev({ sessionId: "s1", tps: 100 }));
  board.onEvent(ev({ sessionId: "s1", tps: 100 }));
  board.onEvent(ev({ sessionId: "s2", tps: 200 }));
  board.onEvent(ev({ sessionId: "s2", tps: 200 }));
  assert.equal(board.displayFor("s1"), "~100 tok/s");
  assert.equal(board.displayFor("s2"), "~200 tok/s");
  board.onEvent(ev({ sessionId: "s1", phase: "final", tps: 90 }));
  assert.equal(board.displayFor("s1"), "90 tok/s");
  board.onEvent(ev({ sessionId: "s1", requestId: "r9", tps: 250 })); // 新一轮首帧：保持上一精值
  assert.equal(board.displayFor("s1"), "90 tok/s");
  board.onEvent(ev({ sessionId: "s1", requestId: "r9", tps: 250 }));
  assert.equal(board.displayFor("s1"), "~250 tok/s");
});

test("速率状态机：缺键/非数值速率事件静默忽略（不编造数据）", () => {
  const board = createRateBoard();
  board.onEvent({});
  board.onEvent(ev({ tps: Number.NaN }));
  board.onEvent({ sessionId: "s1", requestId: "r1", phase: "streaming", outputTokensPerSecond: "428" });
  assert.equal(board.displayFor("s1"), null);
});

test("速率状态机：大块分块伪影（>合理上限）不上屏，保持上一合理值/等 final", () => {
  const board = createRateBoard();
  board.onEvent(ev({ tps: 100 }), 1000); // 首帧忽略
  assert.equal(board.onEvent(ev({ tps: 10000 }), 1500), false, "万级估算视为分块伪影");
  assert.equal(board.displayFor("s1", 1600), null, "没有上一值时不显示伪影");

  board.onEvent(ev({ tps: 120 }), 2000);
  assert.equal(board.displayFor("s1", 2100), "~120 tok/s");
  assert.equal(board.onEvent(ev({ tps: MAX_LIVE_TPS + 1 }), 2500), false);
  assert.equal(board.displayFor("s1", 2600), "~120 tok/s", "保持上一个合理估算");

  board.onEvent(ev({ phase: "final", tps: 130 }), 3000);
  assert.equal(board.displayFor("s1", 3000), "130 tok/s", "final 精值不受上限过滤影响");
});

test("速率状态机：滞留流（取消/失败无 final）超时后不再假装生成中；final 精值永久保留", () => {
  const board = createRateBoard();
  board.onEvent(ev({ tps: 100 }), 1000); // 首帧忽略
  board.onEvent(ev({ tps: 120 }), 1500);
  assert.equal(board.displayFor("s1", 2000), "~120 tok/s");

  const staleAt = 1500 + STALE_STREAM_MS + 1;
  assert.equal(board.displayFor("s1", staleAt), null, "滞留且无 final → 隐藏，不显示 ~ 假装在跑");
  board.expire(staleAt);
  assert.equal(board.displayFor("s1", staleAt), null);

  // final 精值不受滞留清理影响：停工后「之前的速率」永久保留
  const board2 = createRateBoard();
  board2.onEvent(ev({ tps: 100 }), 1000);
  board2.onEvent(ev({ tps: 120 }), 1500);
  board2.onEvent(ev({ phase: "final", tps: 121 }), 2000);
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

  // 只给 s1 推事件：首帧不上屏（防爆点），第二条 streaming 才点亮；s2 保持隐藏
  listeners.generate(ev({ sessionId: "s1", tps: 4666.67 }), 1000);
  assert.deepEqual(calls.slots, [], "首帧伪影不上屏");
  listeners.generate(ev({ sessionId: "s1", tps: 428.66 }), 1100);
  assert.deepEqual(calls.slots, [
    { id: "zpowerpack-mini", patch: { text: "~428.7 tok/s", visible: true }, scope: { sessionId: "s1" } },
  ]);

  // final 绕过节流立即上屏（真实 token 精值）；s2 仍隐藏但同值已推过 → 不重复推
  calls.slots.length = 0;
  listeners.generate(ev({ sessionId: "s1", phase: "final", tps: 120.77 }), 1200);
  assert.deepEqual(calls.slots, [
    { id: "zpowerpack-mini", patch: { text: "120.8 tok/s", visible: true }, scope: { sessionId: "s1" } },
  ]);

  // 同一 final 值重复到达 → 去重零推送
  calls.slots.length = 0;
  listeners.generate(ev({ sessionId: "s1", phase: "final", tps: 120.77 }), 1250);
  assert.equal(calls.slots.length, 0);
  deactivate();
});

test("activate：streaming 1s 节流只刷一次，final 绕过；首帧不占节流窗口", async () => {
  const { ctx, calls, listeners } = makeCtx({ visibleSessions: [{ sessionId: "s1" }] });
  await activate(ctx, { log: () => {} });
  await flush();
  calls.slots.length = 0;

  listeners.generate(ev({ tps: 100 }), 2000); // 首帧：不上屏、不占节流
  listeners.generate(ev({ tps: 200 }), 2500); // 第二条：立即上屏
  listeners.generate(ev({ tps: 250 }), 2600); // 1s 内：被节流
  assert.equal(calls.slots.length, 1, "1s 内第二条可展示事件被节流");
  assert.equal(calls.slots[0].patch.text, "~200 tok/s");

  listeners.generate(ev({ phase: "final", tps: 300 }), 2700);
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

test("manifest：0.3.2、无视图入口、composer.status 单条且命令目标已声明", () => {
  const plugin = JSON.parse(readFileSync(join(ROOT, ".zcode-plugin", "plugin.json"), "utf8"));
  assert.equal(plugin.version, "0.3.2");
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
