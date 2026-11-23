/**
 * 看板交付面测试：manifest 扩展声明合规（修正后 schema + V2 slots 收敛/版本 bump）、
 * activate() 宿主接线（V2 素条链 + Task 6 增补：sync 资源/notify 句柄/会话作用域素条/订阅绑定降级）、
 * V2 展示模型纯函数（素条四态逐字/会话 focus 段/厂商行环色/趋势/结论的文案映射）、
 * Task 7 视图形约（卡片面板单文件自包含：无外链/渲染锚点/动效降级/双通道取数——文案零断言，
 * 数据文案已由 view-model 用例钉死，视图只哑渲染）。
 *
 * 背景：V1 view-model 映射用例随 charts 退役删除（Task 5）；映射本体已随 Task 8 死代码清零移除；
 * tick 60s 拍/节流/防重入用例属服务层契约，随 Task 4 落在 pipeline.test.mjs。宿主源码实证：
 * - engines.zcode 校验基准 = 扩展 API 版本 1.4.0（非应用版本）
 * - slots = plugin.json 顶层对象（slot id 做键），target 单键 {view|command: id}；
 *   slots.update 第三参=作用域（{sessionId}，2026-11-23 修订 #1）
 * - entry 形态视图宿主只伺服 pageUri + 注册资源 → 视图单文件自包含，文案映射上移 Node 侧
 * - composer 渲染组件不消费 badge → V2 素条推送不带 badge 字段
 * - workbench.onDidChange（{sessions:[{sessionId,...,focused}]}）+ context.get({sessionId})
 *   →{model:{providerId,...}}：聚焦会话感知与 tooltip 额度供应商（修订 #1/#2）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

import { activate, bindOnGenerate } from "../extension/main.js";
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
  // V2 收敛（2026-11-23 反馈 #3）：nav.primary 砍除，素条为唯一入口；迷你条在会话状态区
  assert.ok(!("nav.primary" in m.slots), "nav.primary 已随 V2 收敛删除（应用内无多余入口）");
  assert.ok(Array.isArray(m.slots["composer.status"]) && m.slots["composer.status"].length === 1);
});

test("manifest：slots 收敛 V2——仅 composer.status，条目 icon=gauge 且 target 指向已声明命令", () => {
  const m = readManifest();
  assert.deepEqual(Object.keys(m.slots), ["composer.status"], "唯一入口=素条（nav.primary/sidePane 均不保留）");
  // 条目逐字（brief 定案）：icon 取宿主 23 词表内的 gauge；点击经命令打开看板
  assert.deepEqual(m.slots["composer.status"], [
    { id: "zpowerpack-mini", order: 1, icon: "gauge", title: "ZPowerPack 用量速览", target: { command: "zpowerpack-open-dashboard" } },
  ]);
  const cmdId = m.slots["composer.status"][0].target.command;
  assert.ok(m.extension.contributes.commands.some((c) => c.id === cmdId), `command 未声明: ${cmdId}`);
});

test("manifest：版本 0.2.0（部署缓存按版本刷新）；description 为 V2 文案（实时速率/额度窗口/24h 趋势）", () => {
  const m = readManifest();
  // 部署机制（§六 2026-11-23 实证）：运行时加载安装时缓存副本，版本 bump 是缓存刷新的唯一触发
  assert.equal(m.version, "0.2.0");
  const d = m.description ?? "";
  assert.ok(d.includes("实时 token 速率"), "V2 文案应宣称实时速率");
  assert.ok(d.includes("额度窗口"), "V2 文案应宣称额度窗口");
  assert.ok(/24h.*趋势/.test(d), "V2 文案应宣称 24h 趋势");
  // V1 退役口径不得残留（速度/健康/时段统计随 charts 八报表退役）
  assert.ok(!d.includes("速度/健康/时段"), "不得再宣称速度/健康/时段统计");
});

test("marketplace 一致性：marketplace.json 版本与 plugin.json 对齐，描述为 V2 文案", () => {
  const m = readManifest();
  const market = JSON.parse(readFileSync(new URL("../marketplace.json", import.meta.url), "utf8"));
  const plugin = (market.plugins ?? []).find((p) => p.name === m.name);
  assert.ok(plugin, "marketplace.json 缺少 zpowerpack 条目");
  // 部署机制以版本 bump 触发缓存刷新：市场条目版本不同步则 0.2.0 永远不生效
  assert.equal(plugin.version, m.version, "marketplace 版本必须与 plugin.json 一致");
  const d = plugin.description ?? "";
  assert.ok(d.includes("实时 token 速率"), "市场描述应宣称实时速率");
  assert.ok(d.includes("额度窗口"), "市场描述应宣称额度窗口");
  assert.ok(!d.includes("速度/健康/时段"), "市场描述不得再宣称 V2 已退役的速度/健康/时段统计");
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

test("素条长度兜底：超长 providerName 截断为 text≤40/tooltip≤200 且非空（V1 素条拒收根因防复发）", () => {
  const now = 1732252927000;
  const snap = makeV2Snapshot(now);
  // 用户自定义供应商名可远超 25 字符（text 契约 40 的临界点）；此处取 200+ 同时压 tooltip
  const longName = "OpenCode Go Messages 企业年度旗舰订阅专用实例" + "超长供应商名称".repeat(20);
  snap.quota = [
    {
      providerId: "opencode-go",
      name: longName,
      windows: [
        { type: "rolling-5h", percent: 86, used: null, limit: null, source: "official", nextResetMs: now + 21600000 },
        { type: "weekly", percent: 57, used: null, limit: null, source: "official", nextResetMs: now + 108000000 },
        { type: "monthly", percent: 28, used: null, limit: null, source: "official", nextResetMs: now + 20 * 86400000 },
      ],
      nextResetMs: now + 21600000,
      percent: 86,
      source: "official",
    },
  ];
  snap.rate = {
    state: "idle",
    streams: [],
    totalTps: 0,
    subTps: 0,
    lastEventAt: now - 400000,
    lastProviderId: "opencode-go",
    lastFinal: { modelId: "glm-4.7", tps: 300, outputTokens: 1234, at: now - 400000 },
    fallback: null,
  };
  const dm = toDisplayModelV2(snap, now);
  // 宿主插槽硬校验 text≤40/tooltip≤200：越界会整条拒收（V1 provider id 超 40 导致素条从未显示）
  assert.ok(dm.strip.text.length > 0, "截断后不得为空");
  assert.ok(dm.strip.text.length <= 40, `素条 text 超 40 字符（插槽契约）: ${dm.strip.text.length}`);
  assert.ok(dm.strip.tooltip.length > 0, "tooltip 截断后不得为空");
  assert.ok(dm.strip.tooltip.length <= 200, `素条 tooltip 超 200 字符（插槽契约）: ${dm.strip.tooltip.length}`);
  // 截断保留厂商名开头（优先砍额度段，不丢主体身份）
  assert.ok(dm.strip.text.startsWith(longName.slice(0, 20)), "截断应保留厂商名前缀: " + dm.strip.text);
});

test("会话作用域素条：focus 段只取该会话流与聚焦供应商额度行；四态逐字；全局流不串扰", () => {
  const now = 1732252927000;
  const base = makeV2Snapshot(now);
  // 全局流含另一会话的请求（req-2）：素条必须按 focus.streams 过滤，不得把别会话速率算进来
  base.rate.streams.push({ requestId: "req-2", modelId: "glm-4.7", providerId: "bigmodel-api", isSub: false, tps: 500, phase: "streaming" });
  base.rate.totalTps = 928;
  const zhipu = base.quota[0];
  const kimi = base.quota[1];

  // 态① 会话生成中·仅主代理：速率=该会话流合计（428），水位=聚焦会话模型选择供应商首窗口
  const live = { ...base, focus: { sessionId: "sA", modelId: "glm-4.7", providerId: "bigmodel-api", quotaRow: zhipu, streams: base.rate.streams.slice(0, 1) } };
  const dm1 = toDisplayModelV2(live, now);
  assert.equal(dm1.strip.text, "428 tok/s · 5h 73%");
  assert.equal(dm1.strip.tooltip, "智谱 5h 73%（2h12m 后重置）· 周 41% · 主 428 tok/s · 点击查看详情");
  // 面板速率条仍为全局口径（focus 只作用于素条，面板四区不收窄）
  assert.equal(dm1.panel.rate.totalText, "928 tok/s");
  assert.equal(dm1.panel.rate.streams.length, 2);

  // 态② 会话内主+子并行：合计形态「主+子」+ 并行路数
  const parallel = { ...base, focus: { sessionId: "sA", modelId: null, providerId: "bigmodel-api", quotaRow: zhipu, streams: [
    base.rate.streams[0],
    { requestId: "req-3", modelId: "kimi-k2", providerId: "kimi-code-cn", isSub: true, tps: 96, phase: "streaming" },
  ] } };
  const dm2 = toDisplayModelV2(parallel, now);
  assert.equal(dm2.strip.text, "428+96 tok/s · 5h 73%");
  assert.ok(dm2.strip.tooltip.includes("主 428 · 子 96 tok/s（2 路并行）"), "会话内主子速率全量: " + dm2.strip.tooltip);

  // 态③ 会话空闲：跟随聚焦会话当前模型选择供应商（tooltip 额度=修订 #2，Kimi 行）
  const idle = { ...base, focus: { sessionId: "sA", modelId: "kimi-k2", providerId: "kimi-code-cn", quotaRow: kimi, streams: [] } };
  const dm3 = toDisplayModelV2(idle, now);
  assert.equal(dm3.strip.text, "Kimi 5h 12% · 月 27%");
  assert.ok(dm3.strip.tooltip.startsWith("Kimi 5h 12%"), "tooltip 额度头取聚焦供应商: " + dm3.strip.tooltip);
  assert.ok(dm3.strip.tooltip.endsWith("点击查看详情"));

  // 态④ 会话无数据：context 组合为 null 且该会话无事件 → 无供应商可跟 → 待机
  const none = { ...base, focus: { sessionId: "sA", modelId: null, providerId: null, quotaRow: null, streams: [] } };
  const dm4 = toDisplayModelV2(none, now);
  assert.equal(dm4.strip.text, "ZPowerPack 待机");
  assert.equal(dm4.strip.tooltip, "ZPowerPack 用量速览 · 点击打开看板");

  // 会话生成中但聚焦供应商无额度配置：只给速率，不编造水位（tooltip 无额度头）
  const noQuota = { ...base, focus: { sessionId: "sA", modelId: null, providerId: "opencode-go", quotaRow: null, streams: base.rate.streams.slice(0, 1) } };
  const dm5 = toDisplayModelV2(noQuota, now);
  assert.equal(dm5.strip.text, "428 tok/s");
  assert.equal(dm5.strip.tooltip, "主 428 tok/s · 点击查看详情");

  // focus 缺省 → 全局口径回退（行为与 V2 首版一致，既有用例全数保留）
  assert.equal(toDisplayModelV2(base, now).strip.text, "928 tok/s · 5h 73%");
});

test("面板会话作用域：opts.sessionId 按 reqSession 归属过滤速率流并重算合计；其余区仍全局", () => {
  const now = 1732252927000;
  const base = makeV2Snapshot(now);
  base.rate.streams.push({ requestId: "req-2", modelId: "kimi-k2", providerId: "kimi-code-cn", isSub: false, tps: 500, phase: "streaming" });
  base.rate.totalTps = 928;
  const reqSession = new Map([
    ["req-1", "sA"],
    ["req-2", "sB"],
  ]);

  // 指定会话只见本会话流；合计按过滤后的流重算（不得串入他会话数值）
  const a = toDisplayModelV2(base, now, { sessionId: "sA", reqSession });
  assert.deepEqual(a.panel.rate.streams.map((s) => s.modelId), ["glm-4.7"]);
  assert.equal(a.panel.rate.totalText, "428 tok/s");
  const b = toDisplayModelV2(base, now, { sessionId: "sB", reqSession });
  assert.deepEqual(b.panel.rate.streams.map((s) => s.modelId), ["kimi-k2"]);
  assert.equal(b.panel.rate.totalText, "500 tok/s");
  // 该会话无活跃流 → 空流列表（不拿他会话速率充数）
  assert.deepEqual(toDisplayModelV2(base, now, { sessionId: "sZ", reqSession }).panel.rate.streams, []);

  // 缺省会话 → 全局口径（现行行为）；空对象同义
  const global = toDisplayModelV2(base, now);
  assert.equal(global.panel.rate.streams.length, 2);
  assert.equal(global.panel.rate.totalText, "928 tok/s");
  assert.equal(toDisplayModelV2(base, now, {}).panel.rate.streams.length, 2);

  // 其余区（vendors/trend/conclusion）与素条不受会话过滤影响
  assert.deepEqual(a.panel.vendors, global.panel.vendors);
  assert.deepEqual(a.panel.trend, global.panel.trend);
  assert.deepEqual(a.panel.conclusion, global.panel.conclusion);
  assert.equal(a.strip.text, global.strip.text);
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

test("额度不可用：厂商行状态句「官方接口不可用」、ringPct=null、素条窗口段「额度不可用」", () => {
  const now = 1732252927000;
  const snap = makeV2Snapshot(now);
  // keyless/断网形态：官方失败 → 全部窗口 percent=null、source=unavailable（V2 最常见的失败态）
  snap.quota = [
    {
      providerId: "bigmodel-api",
      name: "智谱",
      windows: [
        { type: "rolling-5h", percent: null, used: 620, limit: null, source: "unavailable", nextResetMs: null },
        { type: "weekly", percent: null, used: null, limit: null, source: "unavailable", nextResetMs: null },
      ],
      nextResetMs: null,
      percent: null,
      source: "unavailable",
    },
  ];
  const dm = toDisplayModelV2(snap, now);
  // 厂商行：空环是缺口 0% 的视觉编码——ringPct 必须为 null，状态句不得再伪装成「滚动窗口」
  const v = dm.panel.vendors[0];
  assert.equal(v.ringPct, null, "官方失败时环百分比必须为 null（视图据此不画弧）");
  assert.equal(v.statusText, "官方接口不可用", "额度失败必须给官方接口不可用状态句");
  assert.equal(v.percents[0].pct, null, "窗口百分比未知，不得编造 0");
  // 素条生成中：速率保留，水位段给「额度不可用」（信息悬崖修复）
  assert.equal(dm.strip.text, "428 tok/s · 额度不可用");
  // 素条空闲：厂商名保留，窗口段给「额度不可用」
  snap.rate = {
    state: "idle",
    streams: [],
    totalTps: 0,
    subTps: 0,
    lastEventAt: now - 400000,
    lastProviderId: "bigmodel-api",
    lastFinal: { modelId: "glm-4.7", tps: 300, outputTokens: 1234, at: now - 400000 },
    fallback: null,
  };
  assert.equal(toDisplayModelV2(snap, now).strip.text, "智谱 额度不可用");
  // 会话作用域同口径（focus 段）：该会话模型选择供应商官方失败
  snap.rate = makeV2Snapshot(now).rate;
  const focused = { ...snap, focus: { sessionId: "sA", modelId: "glm-4.7", providerId: "bigmodel-api", quotaRow: snap.quota[0], streams: [] } };
  assert.equal(toDisplayModelV2(focused, now).strip.text, "智谱 额度不可用");
});

test("界面文案禁 P50/P95（沿用护栏）", () => {
  const now = 1732252927000;
  const out = JSON.stringify(toDisplayModelV2(makeV2Snapshot(now), now));
  assert.ok(!/P50|P95/.test(out), "展示模型不得出现 P50/P95 字样（术语映射在 view-model 完成）");
  // 空快照同受护栏约束
  assert.ok(!/P50|P95/.test(JSON.stringify(toDisplayModelV2(emptyV2Snapshot(now), now))));
});

// ---------------------------------------------------------------------------
// 三、activate() 宿主接线（V2）：注册视图（entry+注册资源）、命令、素条推送；快照文件兜底保留
// ---------------------------------------------------------------------------

/** 构造 mock ctx：记录 views/commands/slots 调用，模拟宿主注册表（slots 记录含作用域第三参） */
function makeMockCtx() {
  const calls = { views: [], commands: [], slots: [], opened: [] };
  return {
    calls,
    views: {
      register: (id, def) => calls.views.push({ id, def }),
      open: (id) => calls.opened.push(id),
    },
    commands: { register: (id, fn) => calls.commands.push({ id, fn }) },
    // 会话作用域素条（2026-11-23 修订 #1）：第三参=作用域（{sessionId}），单测断言其形态传递
    slots: { update: (id, patch, scope) => calls.slots.push({ id, patch, scope }) },
  };
}

/** 假数据源（V2 契约）：首拍回填一行完成数据，增量/额度/会话空返回（不碰真机 db/网络） */
function fakeDeps() {
  const now = 1732252927000;
  const row = {
    rowid: 1,
    sessionId: "s1",
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
  };
  return {
    fetchRecent: async () => ({ rows: [row], maxRowid: 1 }),
    fetchNew: async (cursor) => ({ rows: [], nextCursor: cursor }),
    fetchMaxRowid: async () => 1,
    fetchSessions: async () => [{ id: "s1", directory: "E:\\code\\plugin\\zcode\\ZPowerPack" }],
    fetchQuota: async () => [],
    now: () => now,
  };
}

test("activate：注册看板视图（entry 相对插件根）+ display/snapshot/sync 三个注册资源，空态 display 可读", async () => {
  const ctx = makeMockCtx();
  const stop = await runActivateOnce(ctx);
  try {
    assert.equal(ctx.calls.views.length, 1);
    const { id, def } = ctx.calls.views[0];
    assert.equal(id, "zpowerpack-dashboard");
    assert.equal(def.entry, "extension/view/index.html", "entry 相对插件根解析（探针 ENOENT 教训）");
    assert.equal(typeof def.onDidOpen, "function");
    // 注册资源：display 供视图取数（V2 展示模型 {strip, panel}），snapshot 供调试，sync 供手动即时拉取
    const display = def.resources["zpowerpack://display"];
    assert.ok(display, "缺少 zpowerpack://display 注册资源");
    assert.equal(display.mimeType, "application/json");
    const parsed = JSON.parse(display.read({ view: {} }));
    assert.ok(parsed.panel && typeof parsed.panel.rate.stateText === "string", "面板速率条可读");
    // 无事件无额度 → 素条空态（V2 展示模型形状）
    assert.equal(parsed.strip.text, "ZPowerPack 待机");
    assert.ok(def.resources["zpowerpack://snapshot"], "保留原始快照资源（调试通道）");
    assert.ok(def.resources["zpowerpack://sync"], "缺少 zpowerpack://sync 手动同步资源");
    assert.equal(def.resources["zpowerpack://sync"].mimeType, "application/json");
    // onDidOpen 消费宿主句柄入参不抛（临时：Task 0 采集段的记录函数在注入 deps 路径判空直跳）
    assert.doesNotThrow(() => def.onDidOpen({ view: {}, notify: () => {} }));
  } finally {
    stop();
  }
});

test("activate：命令注册且处理函数打开看板视图；素条 slot 补丁合规（text≤40/tooltip≤200/badge 不推）", async () => {
  const ctx = makeMockCtx();
  const stop = await runActivateOnce(ctx);
  try {
    // 素条命令：点击状态条打开看板
    const cmd = ctx.calls.commands.find((c) => c.id === "zpowerpack-open-dashboard");
    assert.ok(cmd, "缺少 zpowerpack-open-dashboard 命令");
    await cmd.fn({});
    assert.deepEqual(ctx.calls.opened, ["zpowerpack-dashboard"]);
    // 素条补丁：宿主词表约束 text≤40 / tooltip≤200；V2 不再推送 badge（渲染侧从不消费）
    const slotCalls = ctx.calls.slots.filter((s) => s.id === "zpowerpack-mini");
    assert.ok(slotCalls.length >= 1, "tick 后应推送素条");
    const patch = slotCalls[slotCalls.length - 1].patch;
    assert.ok(patch.text.length <= 40);
    assert.ok(patch.tooltip.length <= 200);
    assert.ok(!("badge" in patch), "V2 素条推送不带 badge 字段");
  } finally {
    stop();
  }
});

test("activate：快照文件兜底保留；稳态素条不重复推送；生成事件点亮素条速率", async () => {
  const ctx = makeMockCtx();
  const dir = mkdtempSync(join(tmpdir(), "zp-act-"));
  const snapshotPath = join(dir, "last-snapshot.json");
  const deps = { ...fakeDeps(), now: () => 1732252927000 };
  const handle = await activate(ctx, { intervalMs: 5, snapshotPath, deps });
  try {
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(existsSync(snapshotPath), "文件兜底未写盘");
    const snap = JSON.parse(readFileSync(snapshotPath, "utf8"));
    // V2 快照契约：无 charts 键；无订阅事件 → 兜底链有值
    assert.ok(!("charts" in snap), "V2 快照无 charts 键");
    assert.equal(snap.rate.state, "idle");
    assert.ok(snap.rate.fallback, "无订阅事件时最新完成行进兜底链");
    assert.equal(snap.rate.fallback.tps, 566.67, "兜底=回填行的单请求速率（510 token ÷ 900ms）");

    // 稳态去重：无新事件/新行时素条推送计数不增长
    const before = ctx.calls.slots.filter((s) => s.id === "zpowerpack-mini").length;
    await new Promise((r) => setTimeout(r, 40));
    const after = ctx.calls.slots.filter((s) => s.id === "zpowerpack-mini").length;
    assert.equal(after, before, "稳态素条不应逐 tick 重复推送");

    // 生成事件（Task 6 绑定宿主订阅；此处直驱句柄）→ 素条点亮速率、快照转 live
    handle.onGenerateEvent(
      {
        sessionId: "s1",
        requestId: "r1",
        model: { providerId: "bigmodel-api", modelId: "glm-4.7" },
        phase: "streaming",
        outputTokensPerSecond: 428,
      },
      1732252927100,
    );
    const snap2 = JSON.parse(readFileSync(snapshotPath, "utf8"));
    assert.equal(snap2.rate.state, "live", "事件型 deliver 同步刷新快照文件");
    assert.equal(snap2.rate.totalTps, 428);
    // 素条推送经 context.get 异步排程（会话作用域通道），等一拍微任务落地后再断言
    await new Promise((r) => setTimeout(r, 30));
    const slotCalls = ctx.calls.slots.filter((s) => s.id === "zpowerpack-mini");
    const patch = slotCalls[slotCalls.length - 1].patch;
    assert.equal(patch.text, "428 tok/s", "live 单流素条=速率合计（无额度水位段不编造）");
  } finally {
    handle.stop();
  }
});

test("activate：sync 资源 read 触发一次即时额度拉取并返回 quota（quotaPending 绕过 60s TTL）", async () => {
  const ctx = makeMockCtx();
  const now = 1732252927000;
  let quotaPulls = 0;
  const deps = {
    ...fakeDeps(),
    // 固定时钟：60s TTL 永不过期 → 即时拉取只能来自 sync 的 quotaPending 通道
    fetchQuota: async () => {
      quotaPulls++;
      return [];
    },
    now: () => now,
  };
  const handle = await activate(ctx, { intervalMs: 5, deps });
  try {
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(quotaPulls, 1, "固定时钟下 TTL 内只有首拍拉一次");
    handle.stop(); // 停拍隔离：后续拉取只能来自 sync read 触发的即时拍
    await new Promise((r) => setTimeout(r, 10));
    const sync = ctx.calls.views[0].def.resources["zpowerpack://sync"];
    const parsed = JSON.parse(await sync.read({ view: {} }));
    assert.deepEqual(Object.keys(parsed), ["quota"], "sync 返回 {quota} 载荷");
    assert.deepEqual(parsed.quota, []);
    assert.equal(quotaPulls, 2, "sync read 置待办并立即跑一拍（绕过 TTL 重拉额度）");
  } finally {
    handle.stop();
  }
});

test("activate：onDidOpen 保存 notify 句柄，数据更新时 notify(display)；onDidClose 清引用后不再推送", async () => {
  const ctx = makeMockCtx();
  const deps = { ...fakeDeps(), now: () => 1732252927000 };
  const handle = await activate(ctx, { intervalMs: 5, deps });
  try {
    const notifyCalls = [];
    let closeCb = null;
    // 模拟宿主打开视图：句柄带 notify(uri) 与 onDidClose(cb)（推送链 §五.8 实证形状）
    ctx.calls.views[0].def.onDidOpen({ notify: (uri) => notifyCalls.push(uri), onDidClose: (cb) => (closeCb = cb) });
    await new Promise((r) => setTimeout(r, 40));
    // tick deliver → 已打开的视图收到 display 更新通知（重读注册资源）
    assert.ok(notifyCalls.length >= 1, "视图打开后应至少收到一次 display 通知");
    assert.ok(notifyCalls.every((u) => u === "zpowerpack://display"), "通知 uri 固定为 display");
    // 关闭视图：宿主回调清引用 → 后续数据更新不再向已关闭视图推送
    closeCb();
    const countAtClose = notifyCalls.length;
    handle.onGenerateEvent(
      { sessionId: "s1", requestId: "r1", model: { providerId: "bigmodel-api", modelId: "glm-4.7" }, phase: "streaming", outputTokensPerSecond: 200 },
      1732252927100,
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(notifyCalls.length, countAtClose, "视图关闭后不得再收到通知");
  } finally {
    handle.stop();
  }
});

test("activate：display read 按会话作用域过滤面板速率（callInfo.scope 直取优先，视图实例映射兜底，缺省全局）", async () => {
  const ctx = makeMockCtx();
  const now = 1732252927000;
  const deps = { ...fakeDeps(), now: () => now };
  const handle = await activate(ctx, { intervalMs: 5, deps });
  try {
    await new Promise((r) => setTimeout(r, 40));
    // 两会话各一路在飞流（事件间隔 ≥1s 以跨过事件型 deliver 节流）
    handle.onGenerateEvent(
      { sessionId: "sA", requestId: "rA", model: { providerId: "bigmodel-api", modelId: "glm-4.7" }, phase: "streaming", outputTokensPerSecond: 111 },
      now + 1000,
    );
    handle.onGenerateEvent(
      { sessionId: "sB", requestId: "rB", model: { providerId: "kimi-code-cn", modelId: "kimi-k2" }, phase: "streaming", outputTokensPerSecond: 222 },
      now + 3000,
    );
    const read = ctx.calls.views[0].def.resources["zpowerpack://display"].read;

    // ① 无调用方信息 → 全局口径（现行行为）
    assert.equal(JSON.parse(read()).panel.rate.streams.length, 2);
    // ② callInfo 直接携带 scope.sessionId → 优先级最高
    const a = JSON.parse(read({ scope: { kind: "session", sessionId: "sA" } }));
    assert.deepEqual(a.panel.rate.streams.map((s) => s.modelId), ["glm-4.7"]);
    assert.equal(a.panel.rate.totalText, "111 tok/s");
    // ③ onDidOpen 记录「视图实例 → 会话」，read 仅带视图标识也可解析
    let closeCb = null;
    ctx.calls.views[0].def.onDidOpen({
      view: { id: "v-b" },
      scope: { kind: "session", sessionId: "sB" },
      notify: () => {},
      onDidClose: (cb) => (closeCb = cb),
    });
    const b = JSON.parse(read({ view: { id: "v-b" } }));
    assert.deepEqual(b.panel.rate.streams.map((s) => s.modelId), ["kimi-k2"]);
    assert.equal(b.panel.rate.totalText, "222 tok/s");
    // ④ 视图关闭清除归属映射 → 同标识读回归全局口径
    closeCb();
    assert.equal(JSON.parse(read({ view: { id: "v-b" } })).panel.rate.streams.length, 2);
    // ⑤ 未知视图标识 / 非会话 scope → 全局口径（不猜会话归属）
    assert.equal(JSON.parse(read({ view: { id: "v-unknown" } })).panel.rate.streams.length, 2);
    assert.equal(JSON.parse(read({ scope: { kind: "workspace" } })).panel.rate.streams.length, 2);
    // ⑥ 空串会话 id 不是有效归属（M15）：不得作为过滤键清空面板速率
    assert.equal(JSON.parse(read({ scope: { kind: "session", sessionId: "" } })).panel.rate.streams.length, 2, "空串 scope.sessionId 必须走全局口径");
    assert.equal(JSON.parse(read({ sessionId: "" })).panel.rate.streams.length, 2, "空串顶层 sessionId 必须走全局口径");
    ctx.calls.views[0].def.onDidOpen({ view: { id: "v-empty" }, scope: { kind: "session", sessionId: "" }, notify: () => {}, onDidClose: () => {} });
    assert.equal(JSON.parse(read({ view: { id: "v-empty" } })).panel.rate.streams.length, 2, "空串会话不得写入视图归属映射");
  } finally {
    handle.stop();
  }
});

test("display 读取按当前时刻重算相对时间（全局口径不得返回冻结缓存）", async () => {
  const ctx = makeMockCtx();
  const deps = { ...fakeDeps(), now: () => 1732252927000 };
  // 60s 间隔：只跑激活首拍，避免拍子插入干扰相对时间断言
  const handle = await activate(ctx, { intervalMs: 60000, deps });
  try {
    await new Promise((r) => setTimeout(r, 40)); // 首拍送达，latestSnapshot 就绪
    const t0 = Date.now();
    handle.onGenerateEvent(
      { sessionId: "s1", requestId: "r1", model: { providerId: "bigmodel-api", modelId: "glm-4.7" }, phase: "streaming", outputTokensPerSecond: 428 },
      t0 - 1000,
    );
    handle.onGenerateEvent(
      { sessionId: "s1", requestId: "r1", model: { providerId: "bigmodel-api", modelId: "glm-4.7" }, phase: "final", outputTokensPerSecond: 415 },
      t0,
    );
    const read = ctx.calls.views[0].def.resources["zpowerpack://display"].read;
    const first = JSON.parse(read()).panel.rate.lastActivityText;
    // 等 1.2s 再读同一快照：相对时间文案必须前进（缓存对象会让「完成于 0s 前」冻结一分钟）
    await new Promise((r) => setTimeout(r, 1200));
    const second = JSON.parse(read()).panel.rate.lastActivityText;
    assert.match(first, /^完成于 \d+s 前$/, "recent 态应给「完成于 Xs 前」: " + first);
    assert.match(second, /^完成于 \d+s 前$/, "recent 态应给「完成于 Xs 前」: " + second);
    assert.notEqual(second, first, "相对时间文案必须随读取时刻前进（不得冻结到下一拍）");
  } finally {
    handle.stop();
  }
});

test("activate：stop 统一退订宿主订阅——函数句柄与对象句柄各退订一次，重复 stop 幂等", async () => {
  const ctx = makeMockCtx();
  let generateDisposed = 0;
  let workbenchDisposed = 0;
  // 两种宿主句柄形态：onDidGenerate 返回函数；workbench.onDidChange 返回 {dispose}
  ctx.models = { onDidGenerate: () => () => { generateDisposed++; } };
  ctx.workbench = { onDidChange: () => ({ dispose: () => { workbenchDisposed++; } }) };
  const handle = await activate(ctx, { intervalMs: 5, deps: fakeDeps() });
  await new Promise((r) => setTimeout(r, 30));
  handle.stop();
  assert.equal(generateDisposed, 1, "onDidGenerate 函数句柄应在 stop 时调用");
  assert.equal(workbenchDisposed, 1, "workbench 对象句柄 dispose 应在 stop 时调用");
  // 重复 stop（宿主销毁与服务自身停用双路径）不得重复退订
  handle.stop();
  assert.equal(generateDisposed, 1, "重复 stop 不得重复退订");
  assert.equal(workbenchDisposed, 1, "重复 stop 不得重复退订");
});

test("deactivate：宿主停用入口停 60s 拍、退订各一次、清视图推送句柄", async () => {
  // 宿主只调 module.deactivate() 且忽略 activate 返回值（C1）：模块级句柄是唯一退场通道
  const { deactivate } = await import("../extension/main.js");
  assert.equal(typeof deactivate, "function", "插件必须导出 deactivate（否则停用/卸载后服务永不退场）");
  const ctx = makeMockCtx();
  let generateDisposed = 0;
  let workbenchDisposed = 0;
  // 两种宿主句柄形态：onDidGenerate 返回函数；workbench.onDidChange 返回 {dispose}
  ctx.models = { onDidGenerate: () => () => { generateDisposed++; } };
  ctx.workbench = { onDidChange: () => ({ dispose: () => { workbenchDisposed++; } }) };
  let newFetches = 0;
  const deps = {
    ...fakeDeps(),
    fetchNew: async (cursor) => {
      newFetches++;
      return { rows: [], nextCursor: cursor };
    },
  };
  const handle = await activate(ctx, { intervalMs: 5, deps });
  await new Promise((r) => setTimeout(r, 40));
  // 打开视图：deactivate 后 viewPort 必须清空，否则仍在向宿主已销毁的视图推送
  const notifyCalls = [];
  ctx.calls.views[0].def.onDidOpen({ notify: (uri) => notifyCalls.push(uri), onDidClose: () => {} });
  deactivate();
  // 等在飞拍落地（stop 只清定时器，不打断已开始的拍），再取停拍基线
  await new Promise((r) => setTimeout(r, 40));
  const fetchAtStop = newFetches;
  const notifyAtStop = notifyCalls.length;
  assert.equal(generateDisposed, 1, "生成事件订阅应在 deactivate 时退订一次");
  assert.equal(workbenchDisposed, 1, "workbench 订阅应在 deactivate 时退订一次");
  // 事件入口仍可被直驱，但视图句柄已清：不得再 notify 已销毁视图
  handle.onGenerateEvent(
    { sessionId: "s1", requestId: "r1", model: { providerId: "bigmodel-api", modelId: "glm-4.7" }, phase: "streaming", outputTokensPerSecond: 200 },
    Date.now(),
  );
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(newFetches, fetchAtStop, "deactivate 后 60s 拍不得再触发（interval 已清）");
  assert.equal(notifyCalls.length, notifyAtStop, "deactivate 后不得再向已销毁视图推送");
  // 重复 deactivate（停用 + 卸载双路径）不得重复退订或抛错
  assert.doesNotThrow(() => deactivate());
  assert.equal(generateDisposed, 1, "重复 deactivate 不得重复退订");
  assert.equal(workbenchDisposed, 1, "重复 deactivate 不得重复退订");
});

test("activate：素条推送失败不记去重键——宿主拒收后下一拍必须重试", async () => {
  const ctx = makeMockCtx();
  let attempts = 0;
  // 模拟宿主插槽校验拒绝（V1 长名越界形态）：抛出后去重键不得写入，否则同值永不重试
  ctx.slots = { update: () => { attempts++; throw new Error("插槽校验拒绝"); } };
  const deps = { ...fakeDeps(), now: () => 1732252927000 };
  const handle = await activate(ctx, { intervalMs: 5, deps, log: () => {} });
  try {
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(attempts >= 2, `首次推送失败后不得写入去重键，后续拍必须重试（实际 ${attempts} 次）`);
  } finally {
    handle.stop();
  }
});

test("activate：素条按会话分别推送——workbench 可见会话各得本会话值，slots.update 第三参传 {sessionId}", async () => {
  const ctx = makeMockCtx();
  const now = 1732252927000;
  // workbench 模拟（宿主实证形状）：两窗口两会话，sA 聚焦；初值经 visibleSessions 拉取
  ctx.workbench = {
    onDidChange: () => {},
    visibleSessions: async () => ({
      sessions: [
        { sessionId: "sA", workspace: "E:\\w1", isDraft: false, focused: true },
        { sessionId: "sB", workspace: "E:\\w2", isDraft: false, focused: false },
      ],
    }),
  };
  // context.get 模拟（宿主实证）：sA 已选模型 → 供应商 bigmodel-api；sB 新会话未发首条 → null 走回退
  ctx.context = {
    get: async ({ sessionId }) => (sessionId === "sA" ? { model: { providerId: "bigmodel-api", modelId: "glm-4.7", contextWindow: 128000 } } : null),
  };
  const zhipuRow = {
    providerId: "bigmodel-api",
    name: "智谱",
    windows: [
      { type: "rolling-5h", percent: 73, used: 9.1e6, limit: 2.0e7, source: "official", nextResetMs: now + 7920000 },
      { type: "weekly", percent: 41, used: 2.4e7, limit: 2.0e8, source: "official", nextResetMs: now + 187200000 },
    ],
    nextResetMs: now + 7920000,
    percent: 73,
    source: "official",
  };
  const deps = { ...fakeDeps(), fetchQuota: async () => [zhipuRow], now: () => now };
  const handle = await activate(ctx, { intervalMs: 5, deps });
  try {
    await new Promise((r) => setTimeout(r, 80));
    const mini = (sid) => ctx.calls.slots.filter((s) => s.id === "zpowerpack-mini" && s.scope?.sessionId === sid);
    // sA 空闲：context 模型选择 → 智谱额度行 → 水位文案（tooltip 额度=聚焦会话当前模型选择供应商）
    const a = mini("sA");
    assert.ok(a.length >= 1, "sA 应收到会话作用域素条");
    assert.equal(a[a.length - 1].patch.text, "智谱 5h 73% · 周 41%");
    // 重置文案随真实渲染时刻走绝对/相对两态，断言骨架不绑时钟
    assert.match(a[a.length - 1].patch.tooltip, /^智谱 5h 73%（.+）· 周 41% · 点击查看详情$/);
    // sB 空闲：组合上下文 null 且该会话无事件 → 待机
    const b = mini("sB");
    assert.ok(b.length >= 1, "sB 应收到会话作用域素条");
    assert.equal(b[b.length - 1].patch.text, "ZPowerPack 待机");
    // V2 素条不推 badge（渲染侧从不消费）
    assert.ok(ctx.calls.slots.every((s) => !("badge" in s.patch)));

    // sA 发起生成：事件按 sessionId 归入该会话 → sA 素条点亮速率，sB 不受串扰
    handle.onGenerateEvent(
      { sessionId: "sA", requestId: "req-a", model: { providerId: "kimi-code-cn", modelId: "kimi-k2" }, phase: "streaming", outputTokensPerSecond: 300 },
      now + 2000,
    );
    await new Promise((r) => setTimeout(r, 40));
    const a2 = mini("sA");
    assert.equal(a2[a2.length - 1].patch.text, "300 tok/s · 5h 73%", "会话生成中=该会话流速率+聚焦供应商水位");
    assert.ok(a2[a2.length - 1].patch.tooltip.includes("主 300 tok/s"), "tooltip 速率段取该会话流: " + a2[a2.length - 1].patch.tooltip);
    assert.equal(mini("sB")[mini("sB").length - 1].patch.text, "ZPowerPack 待机", "他会有事件不串扰本会话素条");

    // 同值去重：稳态（无新事件）下同会话素条推送计数不增长
    const before = mini("sA").length;
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(mini("sA").length, before, "同会话同值不重复推送");
  } finally {
    handle.stop();
  }
});

test("activate：workbench 不可达降级——素条推给最近事件会话（无事件时全局待机）；订阅绑定全败仅中文 warn", async () => {
  const ctx = makeMockCtx(); // 无 workbench/context/models：三条宿主面全降级
  const logs = [];
  const deps = { ...fakeDeps(), now: () => 1732252927000 };
  const handle = await activate(ctx, { intervalMs: 5, deps, log: (l) => logs.push(l) });
  try {
    await new Promise((r) => setTimeout(r, 50));
    // 无事件 → 无会话可指：全局素条（待机）兜底可见（刚装形态）
    const unscoped = ctx.calls.slots.filter((s) => s.id === "zpowerpack-mini" && s.scope === undefined);
    assert.ok(unscoped.length >= 1, "降级初期应推全局素条");
    assert.equal(unscoped[unscoped.length - 1].patch.text, "ZPowerPack 待机");
    // 降级留痕：workbench 与生成事件订阅均中文 warn（激活不失败，兜底行接管速率）
    assert.ok(logs.some((l) => l.includes("workbench") && l.includes("不可达")), "workbench 降级需日志标注: " + logs.join("|"));
    assert.ok(logs.some((l) => l.includes("生成事件订阅不可达")), "订阅绑定全败需中文 warn");
    // 事件到达 → 降级对象=最近有事件的会话，素条作用域推给该会话
    handle.onGenerateEvent(
      { sessionId: "sX", requestId: "rX", model: { providerId: "bigmodel-api", modelId: "glm-4.7" }, phase: "streaming", outputTokensPerSecond: 250 },
      1732252927100,
    );
    await new Promise((r) => setTimeout(r, 40));
    const scoped = ctx.calls.slots.filter((s) => s.id === "zpowerpack-mini" && s.scope?.sessionId === "sX");
    assert.ok(scoped.length >= 1, "降级后事件会话应收到作用域素条");
    assert.equal(scoped[scoped.length - 1].patch.text, "250 tok/s", "无额度数据只给速率，不编造水位");
  } finally {
    handle.stop();
  }
});

// ---------------------------------------------------------------------------
// 四、bindOnGenerate 订阅绑定（Task 6 接线：候选序列与临时探测段一致，先成功者胜）
// ---------------------------------------------------------------------------

test("bindOnGenerate：候选序列先成功者胜——函数直挂优先，后续形态不再尝试（防事件双计）", () => {
  const tried = [];
  const handler = () => {};
  const ctx = {
    models: {
      onDidGenerate: (cb) => {
        tried.push("direct");
        return () => {};
      },
      subscribe: (topic, cb) => {
        tried.push("models.subscribe");
        return {};
      },
    },
    subscribe: (topic, cb) => {
      tried.push("ctx.subscribe:" + topic);
      return {};
    },
  };
  assert.equal(bindOnGenerate(ctx, handler, () => {}), "ctx.models.onDidGenerate()");
  assert.deepEqual(tried, ["direct"], "任一形态绑定成功即停（同一事件重复订阅会双计速率）");
});

test("bindOnGenerate：函数直挂抛错 → 逐候选降级到 models.subscribe 通用入口", () => {
  const handler = () => {};
  const ctx = {
    models: {
      onDidGenerate: () => {
        throw new Error("宿主拒绝直挂");
      },
      subscribe: (topic) => {
        assert.equal(topic, "onDidGenerate", "通用入口的事件名应为短名 onDidGenerate");
      },
    },
  };
  const logs = [];
  assert.equal(bindOnGenerate(ctx, handler, (l) => logs.push(l)), 'ctx.models.subscribe("onDidGenerate", cb)');
  assert.ok(logs.some((l) => l.includes("绑定失败")), "失败候选需中文日志: " + logs.join("|"));
});

test("bindOnGenerate：subscribe 对象形态（Rx 风格）在函数缺位时接住", () => {
  const bound = [];
  const ctx = { models: { onDidGenerate: { subscribe: (cb) => bound.push(cb) } } };
  const handler = () => {};
  assert.equal(bindOnGenerate(ctx, handler, () => {}), "ctx.models.onDidGenerate.subscribe()");
  assert.equal(bound[0], handler, "订阅回调必须是传入的事件处理函数");
});

test("bindOnGenerate：ctx 顶层 subscribe 双签名——事件全名优先，短名次之，全败返回 null", () => {
  const handler = () => {};
  // 全名成功 → 短名不试
  const topics = [];
  const ctxFull = {
    subscribe: (topic, cb) => {
      topics.push(topic);
      if (topic === "models.onDidGenerate") return {};
      throw new Error("未知事件");
    },
  };
  assert.equal(bindOnGenerate(ctxFull, handler, () => {}), 'ctx.subscribe("models.onDidGenerate", cb)');
  assert.deepEqual(topics, ["models.onDidGenerate"]);
  // 全名失败 → 短名接住
  const ctxShort = {
    subscribe: (topic) => {
      if (topic === "onDidGenerate") return {};
      throw new Error("x");
    },
  };
  assert.equal(bindOnGenerate(ctxShort, handler, () => {}), 'ctx.subscribe("onDidGenerate", cb)');
  // 全部候选失败 → null（调用方据此记中文 warn，tickV2 兜底行接管速率）
  const logs = [];
  const ctxNone = {
    subscribe: () => {
      throw new Error("宿主无订阅面");
    },
  };
  assert.equal(bindOnGenerate(ctxNone, handler, (l) => logs.push(l)), null);
  assert.ok(logs.length >= 2, "双签名两次失败均应留痕");
});

// ---------------------------------------------------------------------------
// 五、视图形约（Task 7 卡片面板全量重写：单文件自包含哑渲染。文案零断言——数据文案
//     已由上方 view-model 用例钉死，此处只钉视图侧形状/接线契约，重构视图不破文案用例）
// ---------------------------------------------------------------------------

/** 读取视图源文件（被测对象：extension/view/index.html 单文件自包含） */
function readView() {
  return readFileSync(new URL("../extension/view/index.html", import.meta.url), "utf8");
}

test("视图自包含：无外链 script、零外部 URL 引用；五渲染锚点 data-testid 齐；内联脚本语法可编译", () => {
  const html = readView();
  // 宿主对 entry 形态视图只伺服 pageUri + 注册资源（V1 探针实证）：外链 script/字体必失败
  assert.ok(!/<script[^>]*\bsrc=/i.test(html), "不得存在外链 script（宿主不伺服外部脚本）");
  assert.ok(!/https?:\/\//i.test(html), "视图零外部 URL 引用（字体走本地栈、SVG 免 xmlns 外链形态）");
  // 差异渲染与真机定位的稳定锚点：速率条/厂商行/趋势/同步按钮/结论句
  for (const tid of ["rate-bar", "vendor-row", "trend-chart", "sync-btn", "conclusion-line"]) {
    assert.ok(html.includes(`data-testid="${tid}"`), `缺少 data-testid="${tid}"`);
  }
  // 内联脚本语法编译（node:vm）：语法错误不得在其它用例全绿下蒙混过关
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  assert.equal(scripts.length, 1, "视图只允许一段内联脚本（单文件自包含铁律）");
  assert.doesNotThrow(() => new vm.Script(scripts[0]), "内联脚本必须通过语法编译");
});

test("视图健壮性：panel.rate/trend 缺失防御；render 抛错不提前隐藏遮罩；取数 inFlight 双路径复位", () => {
  const html = readView();
  // 段缺失防御：渲染函数入口把入参归一为空对象，缺失段退化为空态而非抛错
  assert.match(html, /function renderRate\(rate\) \{\s*rate = rate \|\| \{\};/, "renderRate 未对 rate 缺失做防御");
  assert.match(html, /function renderTrend\(trend\) \{\s*trend = trend \|\| \{\};/, "renderTrend 未对 trend 缺失做防御");
  // 遮罩隐藏必须在全部渲染成功之后：脚本文本序上位于结论句绑定之后
  const bootHideIdx = html.indexOf('el("boot").classList.add("hide")');
  const conclusionIdx = html.indexOf('setNum(el("conclusion-line")');
  assert.ok(conclusionIdx > 0 && bootHideIdx > conclusionIdx, "遮罩隐藏必须在结论句渲染之后（抛错时不得错误隐藏）");
  // refresh 成功分支 try/catch：渲染异常不得吞掉首帧遮罩提示
  assert.match(html, /readDisplay\(\)\.then\(function \(dm\) \{\s*try \{[\s\S]*?render\(dm\);[\s\S]*?\} catch/, "refresh 成功分支缺少渲染 try/catch");
  // 取数 inFlight 护栏：1s 轮询 + 订阅 + sync 共用入口，在飞时跳过并复位
  assert.match(html, /if \(inFlight\) return;/, "刷新入口缺少 inFlight 护栏");
  assert.match(html, /\.finally\(function \(\) \{ inFlight = false; \}\)/, "inFlight 必须在 finally 复位");
  // 同步抛错路径（I6）：readDisplay/readResource 同步 throw 时 finally 未注册，必须在 catch 复位
  assert.match(html, /try \{\s*(?:\/\/[^\n]*\n\s*)*readDisplay\(\)\.then\(/, "readDisplay 必须在 try 中调用（同步抛错不得越过复位）");
  assert.match(
    html,
    /try \{\s*(?:\/\/[^\n]*\n\s*)*readDisplay\(\)\.then\([\s\S]*?\} catch \(e\) \{\s*(?:\/\/[^\n]*\n\s*)?inFlight = false;/,
    "同步抛错必须在 catch 中复位 inFlight（防轮询永久锁死）",
  );
});

test("额度不可用视图契约：ringPct 为 null 时不画弧，环底降透明度（空环不得读成 0%）", () => {
  const html = readView();
  assert.match(html, /var hasPct = typeof v\.ringPct === "number";/, "视图须显式区分 ringPct 缺失（不得按 0 画弧）");
  assert.match(html, /var ring = hasPct\s*\?/, "环形弧只能由 hasPct 分支生成（null 时不画弧）");
  assert.match(html, /ring-empty/, "缺额度时环底应降透明度（未知态与 0% 区分）");
});

test("视图失败态：缺 panel 段写「数据不可用」文案；启动后渲染异常 console.error 留痕", () => {
  const html = readView();
  // 载荷整体畸形（缺 panel 段）：不得静默 return 让遮罩永停「正在连接」
  assert.match(html, /if \(!dm \|\| !dm\.panel\) \{[\s\S]*?数据不可用/, "缺 panel 段必须回写数据不可用文案");
  // boot 之后的渲染异常需 console.error 供真机开发者工具定位（失败不假动：画面保持最后真值）
  assert.match(html, /console\.error\("\[看板\] 渲染失败"/, "渲染异常必须 console.error 留痕");
});

test("动效契约：数字节点挂 300ms 过渡类；prefers-reduced-motion 全关；仅呼吸圆点与同步旋转两枚功能动画", () => {
  const html = readView();
  // 数字变化 300ms 过渡：.num-t 类定义带 300ms transition，且数字节点实际挂类
  assert.match(html, /\.num-t\s*\{[^}]*transition[^}]*\.3s/, "缺少 .num-t 数字过渡类（300ms）");
  assert.match(html, /class="[^"]*num-t/, "数字节点须实际挂 num-t 类");
  // 无障碍降级：媒体查询内动画与过渡全部关闭（简报动效契约）
  assert.match(
    html,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?animation:none[\s\S]*?transition:none/,
    "prefers-reduced-motion 降级须同时关动画与过渡",
  );
  // 呼吸圆点必须为 CSS keyframes；装饰性动画零容忍——keyframes 白名单仅两枚功能动画
  const kf = [...html.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)].map((m) => m[1]);
  assert.ok(kf.includes("breath"), "呼吸圆点必须为 CSS keyframes 动画");
  assert.deepEqual(
    [...new Set(kf)].sort(),
    ["breath", "spin"],
    "keyframes 白名单仅呼吸圆点/同步旋转（装饰性逐字滚动等动画禁令）: " + kf.join(","),
  );
});

test("取数与同步接线：display/sync 双注册资源；订阅 typeof 探测静默 + 1s 轮询兜底；10s 超时复位 + 失败中文提示", () => {
  const html = readView();
  // 取数主通道 + 手动同步通道（注册资源 read 调用逐字 URI）
  assert.ok(html.includes('readResource("zpowerpack://display")'), "取数主通道必须读 display 注册资源");
  assert.ok(html.includes('readResource("zpowerpack://sync")'), "同步按钮必须读 sync 注册资源");
  // 防御性双通道：订阅形态 typeof 探测（沙箱 window.zcode 暴露性真机校准点未证实）+ 轮询兜底常驻
  assert.match(html, /typeof[^;]{0,80}subscribe/, "缺少订阅形态 typeof 探测");
  assert.match(html, /POLL_FALLBACK_MS\s*=\s*1000/, "缺少 POLL_FALLBACK_MS=1000 轮询兜底常量");
  // 同步按钮行为契约：拉取中禁用+旋转、10s 超时复位、失败文案逐字（视图侧唯一固定交互文案）
  assert.match(html, /SYNC_TIMEOUT_MS\s*=\s*10000/, "缺少 SYNC_TIMEOUT_MS=10000 超时复位常量");
  assert.match(html, /\.busy[^{]*\{[^}]*animation:\s*spin/, "拉取中旋转图标态缺失");
  assert.ok(html.includes("同步失败：官方接口不可达"), "同步失败中文提示缺失（简报钉死文案）");
});

/**
 * 以注入依赖驱动 activate 若干 tick 后返回 stop 句柄。
 * activate(ctx, opts) 返回 {stop, onGenerateEvent}（宿主消费句柄；测试直驱事件入口）。
 * @param {object} ctx mock 扩展上下文
 * @param {{ticks?: number, intervalMs?: number}} opts 可注入项
 * @returns {Promise<Function>} stop 句柄
 */
async function runActivateOnce(ctx, opts = {}) {
  const { ticks = 2, intervalMs = 5 } = opts;
  const deps = { ...fakeDeps(), now: () => 1732252927000 };
  const handle = await activate(ctx, { intervalMs, deps });
  await new Promise((r) => setTimeout(r, intervalMs * ticks + 30));
  return handle.stop;
}
