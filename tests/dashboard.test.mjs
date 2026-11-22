/**
 * 看板交付面测试：manifest 扩展声明合规（修正后 schema）、activate() 宿主接线、
 * 以及 view-model 纯函数（快照 → 展示模型的全部文案映射/阈值/格式化）。
 *
 * 背景：V1 二次探测反转（notes §五）后 Task 8 回归扩展形态。宿主源码实证：
 * - engines.zcode 校验基准 = 扩展 API 版本 1.4.0（非应用版本）
 * - slots = plugin.json 顶层对象（slot id 做键），target 单键 {view|command: id}
 * - entry 形态视图宿主只伺服 pageUri + 注册资源 → 视图单文件自包含，文案映射上移 Node 侧
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { activate } from "../extension/main.js";
import { toDisplayModel } from "../extension/view-model.mjs";

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
// 二、view-model：快照 → 展示模型（锁定稿「聚焦主屏」的文案/阈值/格式化契约）
// ---------------------------------------------------------------------------

/** 造一份有代表性的快照（live 态、三厂商额度、各卡有数据） */
function makeSnapshot(now = 1732252927000) {
  return {
    generatedAt: now,
    rate: {
      main: { genRate: 312.4, throughput: null },
      subagent: { genRate: 116.2, throughput: null },
      windowed: { genRate: 428.6, throughput: null, sampleDurationMs: 4210 },
      byModel: [
        { modelId: "glm-4.7", genRate: 200.1, throughput: null, lastCompletedAt: now - 1000 },
      ],
      display: { value: 428.6, state: "live", asOf: now },
      lastProviderId: "bigmodel-api",
    },
    quota: [
      {
        providerId: "bigmodel-api",
        name: "智谱 GLM Coding",
        windows: [
          { type: "rolling-5h", percent: 45, used: 9.1e6, limit: 2.0e7, source: "official", nextResetMs: now + 7920000 },
          { type: "weekly", percent: 12, used: 2.4e7, limit: 2.0e8, source: "official", nextResetMs: now + 3 * 86400000 },
        ],
        percent: 45,
        source: "official",
      },
      {
        providerId: "kimi-code-cn",
        name: "Kimi Code",
        windows: [
          { type: "rolling-5h", percent: 62, used: 6.2e6, limit: 1.0e7, source: "official", nextResetMs: now + 11100000 },
          { type: "monthly", percent: 34, used: 1.7e7, limit: 5.0e7, source: "configured", nextResetMs: null },
        ],
        percent: 62,
        source: "official",
      },
      {
        providerId: "opencode-go",
        name: "OpenCode Go",
        windows: [
          { type: "rolling-5h", percent: 86, used: null, limit: null, source: "official", nextResetMs: now + 6000000 },
          { type: "weekly", percent: 57, used: null, limit: null, source: "official", nextResetMs: now + 86400000 },
          { type: "monthly", percent: 28, used: null, limit: null, source: "official", nextResetMs: now + 20 * 86400000 },
        ],
        percent: 86,
        source: "official",
      },
    ],
    charts: {
      throughput: [
        { modelId: "glm-4.7", tpsP50: 108.2, tpsP95: 165.4, avgLatencyMs: 812, samples: 40 },
        { modelId: "kimi-k3", tpsP50: 96.0, tpsP95: 140.0, avgLatencyMs: null, samples: 25 },
      ],
      latency: [
        { modelId: "glm-4.7", ttftP50: 1300, ttftP95: 5200, samples: 40 },
        { modelId: "kimi-k3", ttftP50: 1800, ttftP95: 6100, samples: 25 },
      ],
      ttftHist: [3, 9, 14, 8, 4, 2, 1, 0, 1, 1],
      ctxVsRate: [
        { inputTokens: 2000, tps: 150, modelId: "glm-4.7" },
        { inputTokens: 40000, tps: 130, modelId: "glm-4.7" },
        { inputTokens: 120000, tps: 123, modelId: "glm-4.7" },
      ],
      byProject: [
        { project: "ZPowerPack", tokens: 18.2e6, requests: 210 },
        { project: "网关后端", tokens: 10.3e6, requests: 96 },
      ],
      toolStats: [
        { toolName: "Bash", calls: 88, errors: 2, totalDurationMs: 44000, avgDurationMs: 500 },
      ],
      providerHealth: [
        { providerId: "bigmodel-api", requests: 100, errorRate: 0.004, retryRate: 0.02 },
        { providerId: "opencode-go", requests: 50, errorRate: 0.023, retryRate: 0.08 },
      ],
      heatmap: Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => (d === 3 && h >= 21 && h <= 22 ? 1e6 : 0))),
    },
  };
}

test("view-model：舞台三态文案映射——live 无徽标，held 显示保持，idle 显示空闲", () => {
  const now = 1732252927000;
  const live = toDisplayModel(makeSnapshot(now), now);
  assert.equal(live.stage.state, "live");
  assert.equal(live.stage.valueText, "428.6");
  assert.equal(live.stage.badgeText, null, "live 态不显示保持/空闲徽标");
  assert.equal(live.stage.main, "312.4");
  assert.equal(live.stage.subagent, "116.2");

  // held：改快照再跑映射（映射函数无状态，输入即快照）
  const heldSnap = makeSnapshot(now);
  heldSnap.rate.display = { value: 300, state: "held", asOf: now - 60000 };
  const dm = toDisplayModel(heldSnap, now);
  assert.match(dm.stage.badgeText, /^保持上次速度/, "held 徽标文案");
  assert.equal(dm.stage.valueText, "300");

  // idle 且无历史值：不显示 0，给空闲徽标
  const idleSnap = makeSnapshot(now);
  idleSnap.rate.display = { value: 0, state: "idle", asOf: now - 400000 };
  const di = toDisplayModel(idleSnap, now);
  assert.match(di.stage.badgeText, /空闲/);
  assert.equal(di.stage.valueText, "—");
});

test("view-model：额度水位行——60/85 双信号转色、重置文案相对/绝对两态、来源标注", () => {
  const now = 1732252927000;
  const dm = toDisplayModel(makeSnapshot(now), now);
  assert.equal(dm.quota.rows.length, 3);

  const zhipu = dm.quota.rows[0];
  assert.equal(zhipu.name, "智谱 GLM Coding");
  assert.equal(zhipu.srcLabel, "官方余量");
  // 45% 已用 → 安全区（青）；重置 <48h → 相对时长文案
  assert.equal(zhipu.windows[0].pct, 45);
  assert.equal(zhipu.windows[0].barColor, "#6ee7ff");
  assert.match(zhipu.windows[0].footText, /后重置/);
  // 周窗口重置 3 天后 → 绝对日期文案
  assert.match(zhipu.windows[1].footText, /重置$/);

  // 62% 已用 → 琥珀警示；86% 已用 → 珊瑚紧张（阈值双信号）
  const kimi = dm.quota.rows[1];
  assert.equal(kimi.windows[0].barColor, "#ffcf7a");
  const oc = dm.quota.rows[2];
  assert.equal(oc.windows[0].barColor, "#ff8f6b");
  assert.match(oc.windows[0].footText, /紧张/);
  // monthly 无重置时间（订阅日未知）→ 文案不给假时间
  assert.equal(kimi.windows[1].footText, "订阅日重置");
});

test("view-model：界面文案禁 P50/P95 术语——速度行取典型/最慢，首字等待 foot 取多数/最慢", () => {
  const now = 1732252927000;
  const dm = toDisplayModel(makeSnapshot(now), now);
  const out = JSON.stringify(dm);
  assert.ok(!/P50|P95/.test(out), "展示模型不得出现 P50/P95 字样（术语映射在 view-model 完成）");
  // 速度对比行：亮段=典型，白刻度=最慢
  const row = dm.grid.speed.rows[0];
  assert.equal(row.valueText, "108/165");
  assert.ok(row.widthPct > 0 && row.markerLeft > row.widthPct, "白刻度在亮段右侧（最慢>典型）");
  // 首字等待 foot：多数/最慢用人话（最慢取全模型最大 TTFT）
  assert.match(dm.grid.ttft.foot, /多数[^\d]*1[–-]2\s*秒/);
  assert.match(dm.grid.ttft.foot, /最慢约\s*6\.1\s*秒/);
});

test("view-model：首字等待直方图——桶计数归一化为高度百分比，空数据给空态", () => {
  const now = 1732252927000;
  const dm = toDisplayModel(makeSnapshot(now), now);
  assert.equal(dm.grid.ttft.hist.length, 10);
  assert.equal(Math.max(...dm.grid.ttft.hist), 100, "最高桶=100%");

  const empty = makeSnapshot(now);
  empty.charts.ttftHist = [];
  const de = toDisplayModel(empty, now);
  assert.equal(de.grid.ttft.hasData, false);
  assert.equal(de.grid.ttft.hist.length, 0);
});

test("view-model：上下文→速率卡——散点归一 + 趋势降幅 foot（诚实计算）", () => {
  const now = 1732252927000;
  const dm = toDisplayModel(makeSnapshot(now), now);
  assert.ok(dm.grid.ctx.hasData);
  assert.equal(dm.grid.ctx.dots.length, 3);
  assert.match(dm.grid.ctx.foot, /降\s*1[0-9]%/, "首末对比降幅文案（150→123 ≈ 18%）");
});

test("view-model：时段热力——7×24 聚合为 24 小时列，分级 h0-h3，foot 给峰值时段与累计", () => {
  const now = 1732252927000;
  const dm = toDisplayModel(makeSnapshot(now), now);
  assert.equal(dm.grid.heat.cells.length, 24);
  assert.equal(dm.grid.heat.cells[21].level, "h3", "峰值小时达到最高档");
  assert.match(dm.grid.heat.foot, /21:00–21:59/);
  assert.match(dm.grid.heat.foot, /2\.0M/);
});

test("view-model：按项目与厂商稳定性卡——行排序/比例条/失败率行，缺数空态", () => {
  const now = 1732252927000;
  const dm = toDisplayModel(makeSnapshot(now), now);
  assert.equal(dm.grid.projects.rows[0].label, "ZPowerPack");
  assert.equal(dm.grid.projects.rows[0].valueText, "18.2M");
  assert.equal(dm.grid.health.rows[0].label, "bigmodel-api");
  assert.equal(dm.grid.health.rows[0].valueText, "0.4%");
  assert.match(dm.grid.health.rows[0].hover, /重试率\s*2(\.0)?%/);

  const empty = makeSnapshot(now);
  empty.charts.byProject = [];
  empty.charts.providerHealth = [];
  const de = toDisplayModel(empty, now);
  assert.equal(de.grid.projects.hasData, false);
  assert.equal(de.grid.health.hasData, false);
});

test("view-model：视图内 dock 与迷你条——跟随最近请求厂商，text≤40，live 发 dot 徽标", () => {
  const now = 1732252927000;
  const dm = toDisplayModel(makeSnapshot(now), now);
  // 迷你条（composer.status 承载）：文本≤40 且含速率与当前厂商窗口
  assert.ok(dm.mini.text.length <= 40, `迷你条文本超长: ${dm.mini.text}`);
  assert.match(dm.mini.text, /428\.6/);
  assert.match(dm.mini.text, /45%/);
  assert.equal(dm.mini.badge, "dot", "live 态发 dot 活动徽标");
  assert.ok(dm.mini.tooltip.length <= 200, "tooltip≤200");
  assert.ok(dm.mini.tooltip.includes("智谱 GLM Coding"), "tooltip 给厂商全名与窗口明细");
  // 视图内 dock 同源：厂商名 + 速率 + 该厂商窗口
  assert.equal(dm.dock.providerName, "智谱 GLM Coding");
  assert.equal(dm.dock.windows.length, 2);

  // 无请求数据：不显示 0 速率，给待机文案且不发徽标
  const idle = makeSnapshot(now);
  idle.rate.display = { value: 0, state: "idle", asOf: 0 };
  idle.rate.lastProviderId = null;
  const di = toDisplayModel(idle, now);
  assert.match(di.mini.text, /待机/);
  assert.equal(di.mini.badge, null);
});

test("view-model：空快照全链不抛错且各卡空态标注", () => {
  const now = 1732252927000;
  const empty = toDisplayModel(
    { generatedAt: now, rate: { main: {}, subagent: {}, windowed: {}, byModel: [], display: { value: 0, state: "idle", asOf: 0 }, lastProviderId: null }, quota: [], charts: { throughput: [], latency: [], ttftHist: [], ctxVsRate: [], byProject: [], toolStats: [], providerHealth: [], heatmap: Array.from({ length: 7 }, () => Array(24).fill(0)) } },
    now,
  );
  assert.equal(empty.quota.rows.length, 0);
  assert.equal(empty.quota.emptyText, "未发现 provider 配置，额度卡待配置后可用");
  assert.equal(empty.grid.speed.hasData, false);
  assert.equal(empty.stage.valueText, "—");
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
