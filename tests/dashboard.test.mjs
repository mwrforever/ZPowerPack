/**
 * 看板交付面测试：manifest 扩展声明合规（修正后 schema）、activate() 宿主接线、
 * V2 展示模型纯函数（素条四态逐字/厂商行环色/趋势/结论的文案映射）。
 *
 * 背景：V1 view-model 映射用例随 charts 退役删除（Task 5，映射本体待 Task 8 清零）；
 * activate/tick 用例属 main.js 契约（Task 4/6 范围处理）。宿主源码实证：
 * - engines.zcode 校验基准 = 扩展 API 版本 1.4.0（非应用版本）
 * - slots = plugin.json 顶层对象（slot id 做键），target 单键 {view|command: id}
 * - entry 形态视图宿主只伺服 pageUri + 注册资源 → 视图单文件自包含，文案映射上移 Node 侧
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { activate, tick, start } from "../extension/main.js";
import { toDisplayModelV2 } from "../extension/view-model.mjs";

/** 读取插件 manifest（被测对象：仓库根 .zcode-plugin/plugin.json） */
function readManifest() {
  return JSON.parse(readFileSync(new URL("../.zcode-plugin/plugin.json", import.meta.url), "utf8"));
}

// ---------------------------------------------------------------------------
// 一、manifest 扩展声明合规（修正后 schema——错一条就装不上，探针实测教训）
// ---------------------------------------------------------------------------

test("manifest 扩展声明：engines.zcode 锁扩展 API ^1.4.0（非应用版本）", () => {
  const m = readManifest();
  assert.equal(m.extension?.engines?.zcode, "^1.4.0");
});

test("manifest 扩展声明：extension 子对象只含宿主 strict 允许的键", () => {
  const m = readManifest();
  const allowed = new Set(["engines", "main", "activationEvents", "grants", "protocols", "contributes"]);
  for (const key of Object.keys(m.extension)) assert.ok(allowed.has(key), `extension 内不允许未知键: ${key}`);
  // slots 必须在顶层，嵌在 extension 内会被 strict 校验拒掉（探针实测坑）
  assert.ok(!("slots" in m.extension), "slots 不得嵌在 extension 内");
});

test("manifest：slots 顶层对象形态，键在宿主词表内，条目 target 单键且指向已声明 view/command", () => {
  const m = readManifest();
  assert.equal(typeof m.slots, "object", "slots 应为对象（slot id 做键）");
  const vocab = new Set(["nav.primary", "sidePane.launcher", "composer.status", "file.viewer", "composer.mention"]);
  for (const [slotId, items] of Object.entries(m.slots)) {
    assert.ok(vocab.has(slotId), `未知 slot: ${slotId}`);
    assert.ok(Array.isArray(items), `${slotId} 条目应为数组`);
    for (const item of items) {
      assert.match(item.id, /^[a-z0-9._-]{1,64}$/);
      const targetKeys = Object.keys(item.target ?? {});
      assert.equal(targetKeys.length, 1, "target 必须是单键对象（kind 做键）");
      const kind = targetKeys[0];
      const id = item.target[kind];
      if (kind === "view") assert.ok(m.extension.contributes.views.some((v) => v.id === id), `view 未声明: ${id}`);
      if (kind === "command")
        assert.ok(m.extension.contributes.commands.some((c) => c.id === id), `command 未声明: ${id}`);
    }
  }
  // 看板入口在主导航；迷你条在会话状态区（锁定决策：位置 A/B）
  assert.ok(Array.isArray(m.slots["nav.primary"]) && m.slots["nav.primary"].length === 1);
  assert.ok(Array.isArray(m.slots["composer.status"]) && m.slots["composer.status"].length === 1);
});

test("manifest：main 为插件根内相对路径（不得绝对/含 ..）", () => {
  const main = readManifest().extension.main;
  assert.ok(!/^([a-zA-Z]:|[\\/])/.test(main), "main 不得为绝对路径");
  assert.ok(!main.split(/[\\/]+/).some((seg) => seg === ".."), "main 不得越出插件根");
});

// ---------------------------------------------------------------------------
// 二、V2 展示模型：素条四态逐字 + 面板四区（设计稿 §五 为构图权威，§五.6 表格为素条唯一权威）
// ---------------------------------------------------------------------------

/** 造一份 V2 快照（Task 4 buildSnapshotV2 契约形状）：live 单主流量 + 三厂商额度 + 24 点趋势 + 外推结论 */
function makeV2Snapshot(now = 1732252927000) {
  return {
    generatedAt: now,
    rate: {
      state: "live",
      streams: [{ requestId: "req-1", modelId: "glm-4.7", providerId: "bigmodel-api", isSub: false, tps: 428, phase: "streaming" }],
      totalTps: 428,
      subTps: 0,
      lastEventAt: now,
      lastProviderId: "bigmodel-api",
      lastFinal: null,
      fallback: null,
    },
    quota: [
      {
        providerId: "bigmodel-api",
        name: "智谱",
        windows: [
          { type: "rolling-5h", percent: 73, used: 9.1e6, limit: 2.0e7, source: "official", nextResetMs: now + 7920000 },
          { type: "weekly", percent: 41, used: 2.4e7, limit: 2.0e8, source: "official", nextResetMs: now + 187200000 },
        ],
        nextResetMs: now + 7920000,
        percent: 73,
        source: "official",
      },
      {
        providerId: "kimi-code-cn",
        name: "Kimi",
        windows: [
          { type: "rolling-5h", percent: 12, used: 6.2e6, limit: 1.0e7, source: "official", nextResetMs: now + 3 * 86400000 },
          { type: "monthly", percent: 27, used: 1.7e7, limit: 5.0e7, source: "configured", nextResetMs: null },
        ],
        nextResetMs: now + 3 * 86400000,
        percent: 12,
        source: "official",
      },
      {
        providerId: "opencode-go",
        name: "OpenCode",
        windows: [
          { type: "rolling-5h", percent: 86, used: null, limit: null, source: "official", nextResetMs: now + 21600000 },
          { type: "weekly", percent: 57, used: null, limit: null, source: "official", nextResetMs: now + 108000000 },
          { type: "monthly", percent: 28, used: null, limit: null, source: "official", nextResetMs: now + 20 * 86400000 },
        ],
        nextResetMs: now + 21600000,
        percent: 86,
        source: "official",
      },
    ],
    // 24 点升序小时桶（Task 2 trendPoints 口径）：仅 21 点位有量，验证序号映射与累计
    trend: Array.from({ length: 24 }, (_, i) => ({ hourMs: now - (23 - i) * 3600000, tokens: i === 21 ? 8.2e6 : 0 })),
    conclusion: { instanceName: "智谱", pctNow: 73, pctAtReset: 118, resetMs: now + 7920000 },
  };
}

/** 造最小空快照（刚装/未配 provider 形态）：无流、无额度、无趋势、无结论 */
function emptyV2Snapshot(now) {
  return {
    generatedAt: now,
    rate: { state: "idle", streams: [], totalTps: 0, subTps: 0, lastEventAt: 0, lastProviderId: null, lastFinal: null, fallback: null },
    quota: [],
    trend: [],
    conclusion: null,
  };
}

test("素条四态逐字：live 单流/并行合计/空闲水位/待机（≤40 字符全数断言）", () => {
  const now = 1732252927000;

  // 态① 生成中·仅主代理：速率合计 + 焦点厂商首窗口水位（设计 §五.6 逐字）
  const live = toDisplayModelV2(makeV2Snapshot(now), now);
  assert.equal(live.strip.text, "428 tok/s · 5h 73%");
  assert.ok(live.strip.text.length <= 40, "素条文本超 40 字符（插槽契约）");

  // 态② 生成中·主+子并行：合计形态「主+子」（素条取合计不并列各流）
  const parallel = makeV2Snapshot(now);
  parallel.rate.streams.push({ requestId: "req-2", modelId: "kimi-k2", providerId: "opencode-go", isSub: true, tps: 96, phase: "streaming" });
  parallel.rate.totalTps = 524;
  parallel.rate.subTps = 96;
  const dm2 = toDisplayModelV2(parallel, now);
  assert.equal(dm2.strip.text, "428+96 tok/s · 5h 73%");
  assert.ok(dm2.strip.text.length <= 40);
  // 速率数字口径：fmt1 一位小数去尾零（428.6→428.6、300→300）
  parallel.rate.streams[0].tps = 428.6;
  parallel.rate.totalTps = 524.6;
  assert.equal(toDisplayModelV2(parallel, now).strip.text, "428.6+96 tok/s · 5h 73%");
  const whole = makeV2Snapshot(now);
  whole.rate.streams[0].tps = 300;
  whole.rate.totalTps = 300;
  assert.equal(toDisplayModelV2(whole, now).strip.text, "300 tok/s · 5h 73%");
  // 焦点厂商无额度数据：生成中素条只给速率，不编造水位
  const noQuota = makeV2Snapshot(now);
  noQuota.quota = [];
  assert.equal(toDisplayModelV2(noQuota, now).strip.text, "428 tok/s");

  // 态③ 空闲：跟随最近请求厂商（quota.name 优先），首两个百分比窗口拼水位
  const idle = makeV2Snapshot(now);
  idle.rate = {
    state: "idle",
    streams: [],
    totalTps: 0,
    subTps: 0,
    lastEventAt: now - 400000,
    lastProviderId: "bigmodel-api",
    lastFinal: { modelId: "glm-4.7", tps: 300, outputTokens: 1234, at: now - 400000 },
    fallback: null,
  };
  const dm3 = toDisplayModelV2(idle, now);
  assert.equal(dm3.strip.text, "智谱 5h 73% · 周 41%");
  assert.ok(dm3.strip.text.length <= 40);
  // 厂商名缺省回退 providerId（不显示空名）
  const anon = makeV2Snapshot(now);
  anon.rate = { ...idle.rate };
  delete anon.quota[0].name;
  assert.equal(toDisplayModelV2(anon, now).strip.text, "bigmodel-api 5h 73% · 周 41%");
  // recent（final 后 ≤5 分钟）非生成中，素条同走空闲水位文案
  const recent = makeV2Snapshot(now);
  recent.rate = {
    ...idle.rate,
    state: "recent",
    lastEventAt: now - 45000,
    lastFinal: { modelId: "glm-4.7", tps: 300, outputTokens: 1234, at: now - 45000 },
  };
  assert.equal(toDisplayModelV2(recent, now).strip.text, "智谱 5h 73% · 周 41%");

  // 面板速率条（同夹具顺带断言）：live 各流并列 + 主子标注 + 合计
  assert.equal(dm2.panel.rate.stateText, "生成中");
  assert.equal(dm2.panel.rate.streams[0].modelId, "glm-4.7");
  assert.equal(dm2.panel.rate.streams[0].tpsText, "428");
  assert.equal(dm2.panel.rate.streams[0].isSubText, null);
  assert.equal(dm2.panel.rate.streams[1].modelId, "kimi-k2");
  assert.equal(dm2.panel.rate.streams[1].tpsText, "96");
  assert.equal(dm2.panel.rate.streams[1].isSubText, "子代理");
  assert.equal(dm2.panel.rate.totalText, "524 tok/s");
  // recent 面板：刚完成 + 末次值 + 完成于 Xs 前
  const dmR = toDisplayModelV2(recent, now);
  assert.equal(dmR.panel.rate.stateText, "刚完成");
  assert.equal(dmR.panel.rate.totalText, "300 tok/s");
  assert.equal(dmR.panel.rate.lastActivityText, "完成于 45s 前");
  // 空闲面板：不显示过期速率，只给活动时刻
  assert.equal(dm3.panel.rate.stateText, "空闲");
  assert.equal(dm3.panel.rate.totalText, null);
  assert.match(dm3.panel.rate.lastActivityText, /^上次活动 \d{2}:\d{2}$/);
  // 兜底链：订阅不可达时面板速率条直给最近完成行，素条仍走水位文案
  const fb = makeV2Snapshot(now);
  fb.rate = { ...idle.rate, fallback: { tps: 108.2, completedAt: now - 60000 } };
  const dmF = toDisplayModelV2(fb, now);
  assert.equal(dmF.strip.text, "智谱 5h 73% · 周 41%");
  assert.equal(dmF.panel.rate.totalText, "108.2 tok/s");
  assert.match(dmF.panel.rate.lastActivityText, /^上次活动 \d{2}:\d{2}$/);
  // 趋势区：24 点序号坐标 + 累计 foot
  assert.equal(live.panel.trend.points.length, 24);
  assert.deepEqual(live.panel.trend.points[0], { x: 0, y: 0 });
  assert.deepEqual(live.panel.trend.points[21], { x: 21, y: 8.2e6 });
  assert.equal(live.panel.trend.footText, "近 24 小时 · 累计 8.2M token");

  // 态④ 无数据（刚装/未配 provider）：待机固定文案
  const none = toDisplayModelV2(emptyV2Snapshot(now), now);
  assert.equal(none.strip.text, "ZPowerPack 待机");
  assert.ok(none.strip.text.length <= 40);
});

test("素条 tooltip ≤200：三窗口+重置+主子速率全量且不截断关键信息", () => {
  const now = 1732252927000;

  // ① 生成中·仅主代理：厂商全窗口 + 首窗口重置说明 + 主速率（设计 §五.6 逐字）
  const live = toDisplayModelV2(makeV2Snapshot(now), now);
  assert.equal(live.strip.tooltip, "智谱 5h 73%（2h12m 后重置）· 周 41% · 主 428 tok/s · 点击查看详情");
  assert.ok(live.strip.tooltip.length <= 200, "tooltip 超 200 字符（插槽契约）");

  // ② 主+子并行：主子速率分别全量 + 并行路数；重置说明不因并行省略
  const parallel = makeV2Snapshot(now);
  parallel.rate.streams.push({ requestId: "req-2", modelId: "kimi-k2", providerId: "opencode-go", isSub: true, tps: 96, phase: "streaming" });
  parallel.rate.totalTps = 524;
  parallel.rate.subTps = 96;
  const dm2 = toDisplayModelV2(parallel, now);
  assert.ok(dm2.strip.tooltip.includes("智谱 5h 73%（2h12m 后重置）· 周 41%"), "额度头须含重置说明");
  assert.ok(dm2.strip.tooltip.includes("主 428 · 子 96 tok/s（2 路并行）"), "主子速率全量");
  assert.ok(dm2.strip.tooltip.endsWith("点击查看详情"));
  assert.ok(dm2.strip.tooltip.length <= 200);

  // ③ 空闲：同①去掉速率段（水位全窗口 + 重置说明保留）
  const idle = makeV2Snapshot(now);
  idle.rate = { state: "idle", streams: [], totalTps: 0, subTps: 0, lastEventAt: now - 400000, lastProviderId: "bigmodel-api", lastFinal: null, fallback: null };
  const dm3 = toDisplayModelV2(idle, now);
  assert.equal(dm3.strip.tooltip, "智谱 5h 73%（2h12m 后重置）· 周 41% · 点击查看详情");

  // 三窗口实例（OpenCode）：tooltip 枚举全部窗口，月窗口不截断
  const oc = makeV2Snapshot(now);
  oc.rate.lastProviderId = "opencode-go";
  const dmO = toDisplayModelV2(oc, now);
  assert.ok(dmO.strip.tooltip.includes("OpenCode 5h 86%（6h00m 后重置）· 周 57% · 月 28%"));
  assert.ok(dmO.strip.tooltip.length <= 200);

  // ④ 无数据：固定引导文案
  assert.equal(toDisplayModelV2(emptyV2Snapshot(now), now).strip.tooltip, "ZPowerPack 用量速览 · 点击打开看板");
});

test("厂商行：环色 60/85 双阈值；状态句相对/绝对两态；percents 枚举全部窗口（OpenCode 三枚）", () => {
  const now = 1732252927000;
  const dm = toDisplayModelV2(makeV2Snapshot(now), now);
  const vendors = dm.panel.vendors;
  assert.equal(vendors.length, 3);

  // 排序：5h 水位降序（最紧张的排最上）
  assert.deepEqual(vendors.map((v) => v.name), ["OpenCode", "智谱", "Kimi"]);

  // 环色双阈值（已用口径）：86 ≥85 珊瑚、73 ≥60 琥珀、12 <60 青
  assert.equal(vendors[0].ringPct, 86);
  assert.equal(vendors[0].ringColor, "#ff8f6b");
  assert.equal(vendors[1].ringPct, 73);
  assert.equal(vendors[1].ringColor, "#ffcf7a");
  assert.equal(vendors[2].ringPct, 12);
  assert.equal(vendors[2].ringColor, "#6ee7ff");

  // 状态句相对态：<48h 给「NhNmm 后重置」；≥85 紧张态加注
  assert.equal(vendors[1].statusText, "5h · 2h12m 后重置");
  assert.equal(vendors[0].statusText, "5h · 6h00m 后重置 · 余量紧张");
  // 状态句绝对态：>48h 给「MM-DD HH:mm 重置」（不编造相对时长）
  assert.match(vendors[2].statusText, /^5h · \d{2}-\d{2} \d{2}:\d{2} 重置$/);

  // 副行：官方 resetsAt → 剩余时长（设计「剩 2d 4h」口径）；仅 percent → 已用标注；多窗口并列
  assert.equal(vendors[1].subText, "周 · 剩 2d 4h");
  assert.equal(vendors[0].subText, "周 · 剩 1d 6h · 月 · 剩 20d 0h");
  assert.equal(vendors[2].subText, "月 · 已用 27%");

  // percents 枚举实例全部窗口（OpenCode 三枚全量）
  assert.deepEqual(vendors[0].percents, [
    { label: "5h", pct: 86 },
    { label: "周", pct: 57 },
    { label: "月", pct: 28 },
  ]);
  assert.deepEqual(vendors[1].percents, [
    { label: "5h", pct: 73 },
    { label: "周", pct: 41 },
  ]);
});

test("结论句：外推文本含实例名与「推算」标注；样本不足占位", () => {
  const now = 1732252927000;
  // 撑不到：外推水位 >100%（设计 §五.1 逐字）
  const dm = toDisplayModelV2(makeV2Snapshot(now), now);
  assert.equal(dm.panel.conclusion.text, "按近半小时速度，智谱 5h 撑不到重置（推算）");
  // 撑得到：外推水位 ≤100%
  const ok = makeV2Snapshot(now);
  ok.conclusion = { instanceName: "智谱", pctNow: 73, pctAtReset: 96, resetMs: now + 7920000 };
  assert.equal(toDisplayModelV2(ok, now).panel.conclusion.text, "按近半小时速度，智谱 5h 撑得到重置（推算）");
  // 样本不足（Task 4 返回 null）：占位不编造
  const thin = makeV2Snapshot(now);
  thin.conclusion = null;
  assert.equal(toDisplayModelV2(thin, now).panel.conclusion.text, "消耗速度尚不足以推算");
});

test("空快照全链不抛错：素条=待机、面板各空态", () => {
  const now = 1732252927000;
  const dm = toDisplayModelV2(emptyV2Snapshot(now), now);
  assert.equal(dm.strip.text, "ZPowerPack 待机");
  assert.equal(dm.strip.tooltip, "ZPowerPack 用量速览 · 点击打开看板");
  // 速率条空态：无流、无末值、无兜底、无活动时刻
  assert.equal(dm.panel.rate.stateText, "空闲");
  assert.deepEqual(dm.panel.rate.streams, []);
  assert.equal(dm.panel.rate.totalText, null);
  assert.equal(dm.panel.rate.lastActivityText, null);
  // 厂商行/趋势/结论空态
  assert.deepEqual(dm.panel.vendors, []);
  assert.deepEqual(dm.panel.trend.points, []);
  assert.equal(dm.panel.trend.footText, "近 24 小时 · 暂无消耗");
  assert.equal(dm.panel.conclusion.text, "消耗速度尚不足以推算");
});

test("界面文案禁 P50/P95（沿用护栏）", () => {
  const now = 1732252927000;
  const out = JSON.stringify(toDisplayModelV2(makeV2Snapshot(now), now));
  assert.ok(!/P50|P95/.test(out), "展示模型不得出现 P50/P95 字样（术语映射在 view-model 完成）");
  // 空快照同受护栏约束
  assert.ok(!/P50|P95/.test(JSON.stringify(toDisplayModelV2(emptyV2Snapshot(now), now))));
});

// ---------------------------------------------------------------------------
// 三、activate() 宿主接线：注册视图（entry+注册资源）、命令、迷你条；快照文件兜底保留
// ---------------------------------------------------------------------------

/** 构造 mock ctx：记录 views/commands/slots 调用，模拟宿主注册表 */
function makeMockCtx() {
  const calls = { views: [], commands: [], slots: [], opened: [] };
  return {
    calls,
    views: {
      register: (id, def) => calls.views.push({ id, def }),
      open: (id) => calls.opened.push(id),
    },
    commands: { register: (id, fn) => calls.commands.push({ id, fn }) },
    slots: { update: (id, patch) => calls.slots.push({ id, patch }) },
  };
}

/** 假数据源：单轮返回一行数据与一个额度实例（不碰真机 db/网络） */
function fakeDeps() {
  const now = 1732252927000;
  const row = {
    sessionId: "s1",
    querySource: "main_turn",
    providerId: "bigmodel-api",
    modelId: "glm-4.7",
    status: "completed",
    startedAt: now - 1200,
    firstTokenAt: now - 900,
    completedAt: now,
    durationMs: 1200,
    inputTokens: 1000,
    outputTokens: 500,
    reasoningTokens: 10,
    timeToFirstTokenMs: 300,
    retryCount: 0,
  };
  return {
    fetchNew: async () => ({ rows: [row], nextCursor: 1 }),
    fetchTools: async () => [],
    fetchSessions: async () => [{ id: "s1", directory: "E:\\code\\plugin\\zcode\\ZPowerPack" }],
    fetchQuota: async () => [],
  };
}

test("activate：注册看板视图（entry 相对插件根）+ 快照与展示模型两个注册资源", async () => {
  const ctx = makeMockCtx();
  const stop = await runActivateOnce(ctx);
  try {
    assert.equal(ctx.calls.views.length, 1);
    const { id, def } = ctx.calls.views[0];
    assert.equal(id, "zpowerpack-dashboard");
    assert.equal(def.entry, "extension/view/index.html", "entry 相对插件根解析（探针 ENOENT 教训）");
    assert.equal(typeof def.onDidOpen, "function");
    // 注册资源：display 供沙箱 1s 轮询，snapshot 供调试
    const display = def.resources["zpowerpack://display"];
    assert.ok(display, "缺少 zpowerpack://display 注册资源");
    assert.equal(display.mimeType, "application/json");
    const parsed = JSON.parse(display.read({ view: {} }));
    assert.equal(parsed.stage.state, "live");
    assert.equal(typeof parsed.generatedAt, "number");
    assert.ok(def.resources["zpowerpack://snapshot"], "保留原始快照资源（调试通道）");
  } finally {
    stop();
  }
});

test("activate：命令注册且处理函数打开看板视图；迷你条 slot 补丁合规（text≤40/badge 合法）", async () => {
  const ctx = makeMockCtx();
  const stop = await runActivateOnce(ctx);
  try {
    // 迷你条命令：点击状态条打开看板
    const cmd = ctx.calls.commands.find((c) => c.id === "zpowerpack-open-dashboard");
    assert.ok(cmd, "缺少 zpowerpack-open-dashboard 命令");
    await cmd.fn({});
    assert.deepEqual(ctx.calls.opened, ["zpowerpack-dashboard"]);
    // 迷你条补丁：宿主词表约束 text≤40 / tooltip≤200 / badge 1-9999|"dot"
    const slotCalls = ctx.calls.slots.filter((s) => s.id === "zpowerpack-mini");
    assert.ok(slotCalls.length >= 1, "tick 后应推送迷你条");
    const patch = slotCalls[slotCalls.length - 1].patch;
    assert.ok(patch.text.length <= 40);
    assert.ok(patch.tooltip.length <= 200);
    assert.ok(patch.badge === "dot" || (typeof patch.badge === "number" && patch.badge >= 1 && patch.badge <= 9999));
  } finally {
    stop();
  }
});

test("activate：快照文件兜底通道保留（原子写仍生效），稳态迷你条不重复推送", async () => {
  const ctx = makeMockCtx();
  const dir = mkdtempSync(join(tmpdir(), "zp-act-"));
  const snapshotPath = join(dir, "last-snapshot.json");
  const deps = { ...fakeDeps(), now: () => 1732252927000 };
  const handle = await activate(ctx, { intervalMs: 5, snapshotPath, deps });
  try {
    // 冷启动三态过渡（idle→held→live）允许若干次推送；等过渡完成进入稳态
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(existsSync(snapshotPath), "文件兜底未写盘");
    const snap = JSON.parse(readFileSync(snapshotPath, "utf8"));
    assert.equal(snap.rate.display.state, "live");
    assert.equal(snap.rate.lastProviderId, "bigmodel-api", "快照带最近请求厂商（迷你条数据源）");

    // 稳态去重：live 值稳定后，再跑若干 tick 推送计数不应增长
    const countBefore = ctx.calls.slots.filter((s) => s.id === "zpowerpack-mini").length;
    await new Promise((r) => setTimeout(r, 40));
    const countAfter = ctx.calls.slots.filter((s) => s.id === "zpowerpack-mini").length;
    assert.equal(countAfter, countBefore, "稳态迷你条不应逐 tick 重复推送");
  } finally {
    handle.stop();
  }
});

/**
 * 以注入依赖驱动 activate 若干 tick 后返回 stop 句柄。
 * activate(ctx, opts) 返回 {stop}（宿主不消费返回值；测试与运维用）。
 * @param {object} ctx mock 扩展上下文
 * @param {{snapshotPath?: string, ticks?: number, intervalMs?: number}} opts 可注入项
 * @returns {Promise<Function>} stop 句柄
 */
async function runActivateOnce(ctx, opts = {}) {
  const { ticks = 2, intervalMs = 5, snapshotPath } = opts;
  const deps = { ...fakeDeps(), now: () => 1732252927000 };
  const handle = await activate(ctx, { intervalMs, snapshotPath, deps });
  await new Promise((r) => setTimeout(r, intervalMs * ticks + 30));
  return handle.stop;
}

// ---------------------------------------------------------------------------
// 四、tick 调度与节流（性能修复：真机实测打开看板导致整体卡顿的根因闭环）
// ---------------------------------------------------------------------------

/** 造可计数的假数据源（全部即时返回，带调用计数） */
function countingDeps(nowFn) {
  const counts = { new: 0, tools: 0, sessions: 0, quota: 0 };
  return {
    counts,
    fetchNew: async () => { counts.new++; return { rows: [], nextCursor: 0 }; },
    fetchTools: async () => { counts.tools++; return []; },
    fetchSessions: async () => { counts.sessions++; return []; },
    fetchQuota: async () => { counts.quota++; return []; },
    ...(nowFn ? { now: nowFn } : {}),
  };
}

test("tick 防重入：慢周期进行中调度器不叠加并发拉取（HTTP 叠加拖垮宿主的根因）", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const deps = {
    fetchNew: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 60));
      inFlight--;
      return { rows: [], nextCursor: 0 };
    },
    fetchTools: async () => [],
    fetchSessions: async () => [],
    fetchQuota: async () => [],
  };
  const handle = start({ intervalMs: 10, deps });
  await new Promise((r) => setTimeout(r, 220));
  handle.stop();
  // 无护栏时 220ms/10ms 间隔会叠出 ~20 轮并发；有护栏任意时刻至多 1 轮在飞
  assert.equal(maxInFlight, 1, "任意时刻至多一轮拉取在飞");
});

test("额度 TTL：窗口内多轮不打官方接口，过期后重打（5 分钟节流）", async () => {
  let clock = 1000000;
  const deps = countingDeps(() => clock);
  const state = { cursor: 0, toolCursor: 0, rows: [], toolRows: [], prevValue: 0, emaValue: 0, asOf: 0, lastNewRowMs: null, projectBySession: {} };

  await tick(state, deps); // 首轮即打
  clock += 60000;
  await tick(state, deps); // TTL 内 → 缓存
  clock += 60000;
  await tick(state, deps); // TTL 内 → 缓存
  assert.equal(deps.counts.quota, 1, "5 分钟窗口内只打一次额度接口");

  clock += 300000;
  await tick(state, deps); // 过期 → 重打
  assert.equal(deps.counts.quota, 2, "过期后重新拉官方额度");
});

test("会话节流：session 表不逐秒全量重读（30 秒节流）", async () => {
  let clock = 1000000;
  const deps = countingDeps(() => clock);
  const state = { cursor: 0, toolCursor: 0, rows: [], toolRows: [], prevValue: 0, emaValue: 0, asOf: 0, lastNewRowMs: null, projectBySession: {} };

  await tick(state, deps); // 首轮即读
  clock += 10000;
  await tick(state, deps); // 节流内 → 缓存
  clock += 10000;
  await tick(state, deps); // 节流内 → 缓存
  clock += 15000;
  await tick(state, deps); // 累计 35s > 30s → 重读
  assert.equal(deps.counts.sessions, 2, "30 秒内 session 只全量读两次");
  // 快照仍逐秒产出（额度/会话走缓存不阻塞速率链路）
  assert.ok(deps.counts.new >= 4, "模型增量读取不受节流影响");
});
