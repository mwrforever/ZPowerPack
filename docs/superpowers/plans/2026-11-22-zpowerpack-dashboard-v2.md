# ZPowerPack 看板 V2 重设计 Implementation Plan

> **⚠ 已作废（2026-11-23 终局裁剪）**：用户最终拍板只保留「当前会话主代理实时 token 速率」素条，额度/趋势/结论/面板/同步全部砍除。本计划的任务分解（T1-T9）不再执行；终局实现见设计稿 §十一，实际代码 = `extension/main.js` + `extension/core/live-rate.mjs` + `tests/rate-strip.test.mjs`。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 AI Usage Widget 卡片形态重写看板（厂商行环形水位 + 实时速率 + 24h 趋势 + 结论句 + 手动同步），速率改走官方 `models.onDidGenerate` 流式事件，额度 60s 自动拉取，composer 素条为唯一入口，取数全推送、零逐秒全量扫描。

**Architecture:** 三层数据链——①事件层（`onDidGenerate` 订阅 → `live-rate.mjs` 活跃流状态机）；②聚合层（db 60s 增量拉取 → `hourly.mjs` per-instance 小时桶，24h 趋势与 5h 兜底分子同源）；③额度层（沿用 quota/quota-fetch，60s TTL + `zpowerpack://sync` 资源手动触发）。展示模型 `toDisplayModelV2` 在 Node 侧完成全部文案映射（可 TDD），沙箱视图哑渲染 + 订阅推送（`onDidOpen` 句柄 `notify`），轮询兜底。宿主素条（composer.status）四态文本，无 badge（渲染侧从不消费）。

**Tech Stack:** Node 24（node:sqlite 只读）、原生 ESM、node --test、单文件自包含 HTML（内联 SVG/CSS/JS）。

**Spec:** `docs/superpowers/specs/2026-11-22-zpowerpack-dashboard-v2-design.md`（本计划从其论证；执行者须同时读 spec §五 §六 §九）

## Global Constraints

- 注释/日志/文档全中文；UTF-8 无 BOM、LF（`node scripts/lint.mjs` 把关）；git 每任务一提交
- 测试命令 `npm test`（=裸 `node --test`；**禁止** `node --test tests/` 目录形式）；验证命令禁止管道吞退出码
- `npm run ci` = lint + 全量测试，pre-commit 钩子阻断，不合规模块不得提交
- apiKey 只进官方请求头，**永不入快照/日志/视图**；快照序列化前后无 `sk-` 样式子串
- 视图单文件自包含（外链 `<script src>` 必失败——宿主只伺服 pageUri+注册资源）
- 界面禁 P50/P95 行话；素条 text≤40、tooltip≤200
- 窗口组合沿用 `extension/core/window-rules.json`（智谱 5h+周 / Kimi 5h+月 / OpenCode 5h+周+月；Qwen 不入额度）
- **扩展代码变更须 zcode 应用重启生效**（ESM 缓存）——真机验证步骤一律含重启
- 任何「看起来在动但数据没动」的数字=失败；展示值必须可溯源（官方事件或落库行）
- **Task 0（真机探针）先跑**；若用户暂不便重启，Task 1–5（纯函数层）可先行，Task 6/7 的绑定形态必须等 Task 0 定案

## Review Focus

1. **事件风暴**：流式期高频事件不得逐事件重建快照/推素条（V1 卡顿教训同族）→ Task 4 测试「事件风暴：一秒多事件仅一拍送达」钉死
2. **回填与游标衔接**：激活首拍有界回填近 24h 后，增量游标必须从回填 max rowid 起，界上不重不漏 → Task 1 测试「回填后游标衔接不重不漏」+ Task 4 断言
3. **官方接口失败/限流**：额度不可用时面板出状态句不编数字；sync 按钮拉取中超时 10s 复位 → Task 5「额度不可用文案」+ Task 7「按钮超时复位」
4. **订阅不可达兜底**：`onDidGenerate` 绑定失败时速率条走最新落库行直给（附数据时刻），其余功能不受影响 → Task 4/5 兜底用例
5. **空数据冷启动**：刚安装/未配 provider/db 空 → 素条「ZPowerPack 待机」、面板空态，全链不抛错 → Task 5 空快照用例 + Task 8 集成空库

---

### Task 0: 订阅探针（真机 spike，产出定案而非产品代码）

**Files:**
- Modify: `.superpowers/sdd/2026-11-21-zpowerpack-dashboard/v1-probe/zpowerpack-probe/extension/main.js`（git 忽略区，不提交）
- Create: `docs/superpowers/notes/2026-11-22-v2-subscription-probe.md`

**Interfaces:**
- Produces（后续任务消费，写入 notes 文档）：
  - `SUBSCRIBE_FORM`：`"ctx.models.onDidGenerate"` 或其它实测形态，或 `"fallback"`（不可达）
  - `EVENT_KEYS`：实测事件载荷键名（预期 camelCase：sessionId/requestId/model/phase/outputTokensPerSecond/outputTokens/timeToFirstTokenMs）
  - `EVENT_CADENCE_MS`：流式期事件间隔实测值（定 Task 4 节流常数）
  - `VIEW_HANDLE_KEYS`：`onDidOpen` 入参键集（钉 `notify` 形态）
  - subagent 归属验证结论：事件 sessionId 是否落在 session 表 parent_id 非空集合内

- [ ] **Step 1: 扩展探针 main.js 四项探测**

保留现有 diag 骨架，新增：①候选订阅形态逐一 try/catch（`ctx.models?.onDidGenerate`、`ctx.sessions?.onDidChange*` 作对照、ctx 键枚举里任何含 subscribe/capabilities 的入口），成功者记录形态并把收到的前 20 个事件（含相邻间隔毫秒）累积进 `diag.generateEvents`；②`onDidOpen(info)` 记录 `Object.keys(info)` 与 `typeof info.notify`；③用 node:sqlite 读 session 表，记录 3 个最近活跃 sessionId 的 parent_id（对照事件 sessionId）。

- [ ] **Step 2: 语法自检**

Run: `node --check ".superpowers/sdd/2026-11-21-zpowerpack-dashboard/v1-probe/zpowerpack-probe/extension/main.js"`
Expected: 无输出（语法合法）

- [ ] **Step 3: 用户协作——真机采集**

用户操作：重启 zcode → 在任意会话发一条消息（触发模型生成）→ 回到本仓库。执行者读取插件根 `probe-diagnostics.json` 判读。**等不到用户时本任务挂起，先做 Task 1–5。**

- [ ] **Step 4: 写 notes 定案文档并提交**

`docs/superpowers/notes/2026-11-22-v2-subscription-probe.md`：记录四项定案 + 事件节奏 + 归属验证结论；若 `SUBSCRIBE_FORM=fallback`，标注启用兜底链并须回报用户（设计 §五.5）。
```bash
git add docs/superpowers/notes/2026-11-22-v2-subscription-probe.md
git commit -m "docs: V2 订阅探针定案（onDidGenerate 绑定形态/事件节奏/notify 句柄/归属验证）"
```

### Task 1: db-reader 收窄 + 有界回填 + subagent 判定

**Files:**
- Modify: `extension/core/db-reader.mjs`
- Test: `tests/db-reader.test.mjs`（现有用例适配 + 新增）

**Interfaces:**
- Produces:
  - 模块常量 `USED_COLS`：`rowid, session_id, provider_id, model_id, status, started_at, first_token_at, completed_at, duration_ms, input_tokens, output_tokens, reasoning_tokens`（增量与回填共用；行输出仅含这些列的 camelCase 映射）
  - `fetchNewModelUsage(db, schema, cursor)` 签名不变；`fetchRecentModelUsage(db, schema, sinceMs)` → `{ rows, maxRowid }`（`completed_at ≥ sinceMs`，ORDER BY rowid ASC，只取 USED_COLS）
  - `subagentSessionIds(sessionRows)` → `Set<string>`（parentId 非空且父在表内的 sessionId 集合）
  - **保留待清**：`fetchToolUsage`/`TOOL_USAGE_MAP` 本任务**不删**（`extension/main.js` 仍在导入，先删套件即红）；函数头加中文注释「退役：Task 4 切换导入，Task 8 清零」

- [ ] **Step 1: 失败测试**

```js
it("回填查询：只取 USED_COLS 且 maxRowid 为界，界上 completed_at 恰等于 sinceMs 的行包含在内", () => { /* 断言 rows 字段集 === camelCase(USED_COLS) 且 maxRowid === 最大 rowid */ });
it("回填后游标衔接不重不漏：fetchRecentModelUsage.maxRowid 起增量拉取，不重复、不丢行", () => {});
it("subagentSessionIds：parentId 非空且父存在 → 入集合；根会话/父缺失 → 不入", () => {});
it("fetchNewModelUsage：输出行仅含 USED_COLS 的 camelCase 字段（不含 finish_reason 等已裁列）", () => {});
```
现有 `fetchToolUsage` 用例直接删除（功能随报表砍除）。

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL（`fetchRecentModelUsage is not defined` / 字段集断言不符）

- [ ] **Step 3: 实现**

db-reader.mjs：新增 `USED_COLS` 常量与两查询共用列选择；`subagentSessionIds` 纯函数（遍历 sessionRows 建 id 集合后判定）；`fetchToolUsage`/`TOOL_USAGE_MAP` 保留并加退役注释（消费方 Task 4 切换，孤儿 Task 8 清）。

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: PASS 全绿

- [ ] **Step 5: 提交**

```bash
git add extension/core/db-reader.mjs tests/db-reader.test.mjs
git commit -m "refactor: db-reader 列收窄+有界回填查询+subagent 判定（工具表读取随报表砍除）"
```

### Task 2: 小时桶聚合 hourly.mjs

**Files:**
- Create: `extension/core/hourly.mjs`
- Test: `tests/hourly.test.mjs`（新建）

**Interfaces:**
- Produces:
  - `hourKey(ms) → number`（epoch 小时整除值）
  - `newBuckets() → Map<string, Map<number, {in: number, out: number, reqs: number}>>`（providerId → 小时桶）
  - `addRow(buckets, row)`：行按 `completedAt` 落所属 provider 桶；tokens= input+output+reasoning
  - `prune(buckets, now, keepHours = 25)`
  - `trendPoints(buckets, now)` → `[{hourMs: number, tokens: number}]` 升序**固定 24 点**（`hourKey(now)-23` 至当前，空桶补 0——折线连续）
  - `windowSum(buckets, providerId, startMs, endMs)` → `{in, out, reqs}`（覆盖的小时整桶计入；±1 小时粒度近似，**模块头注释诚实标注**：仅作官方失败时 5h 兜底分子，不冒充精确值）
- Consumes: Task 1 的 camelCase 行

- [ ] **Step 1: 失败测试**

```js
it("落桶：行按 completedAt 归所属 provider 小时，in/out 分开累计", () => {});
it("prune：过期桶删除，25 小时界上的桶保留", () => {});
it("趋势：固定 24 点升序，空桶补零，跨 provider 求和", () => {});
it("窗口求和：5h 界跨桶时覆盖桶整桶计入（近似口径）；未知 provider 返回零值", () => {});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL（`Cannot find module .../hourly.mjs`）

- [ ] **Step 3: 实现 hourly.mjs**

纯函数无 IO；trendPoints 对空 buckets 也返回 24 个零点（视图空态友好）。

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add extension/core/hourly.mjs tests/hourly.test.mjs
git commit -m "feat: 增量小时桶（24h 趋势与 5h 兜底分子统一底座，O(新行) 落桶）"
```

### Task 3: 实时速率 live-rate.mjs（rate.mjs 退役）

**Files:**
- Create: `extension/core/live-rate.mjs`
- 保留待清: `extension/core/rate.mjs`（main.js 仍在导入，本任务不删；Task 4 切换导入时删除文件）
- Test: `tests/rate.test.mjs`（重写；旧 windowedRate/ema/displayRate 用例随口径废除删除）

**Interfaces:**
- Produces:
  - `requestTps(row)` 签名不变（从 rate.mjs 迁入；兜底链与降级路径共用）
  - `createLiveRate()` → `{ onEvent(ev, now, subagentIds), snapshot(now), noteFallbackRow(row) }`
  - `onEvent` 的 `ev` 键名以 Task 0 notes `EVENT_KEYS` 为准（预期：`{sessionId, requestId, model:{providerId,modelId}, phase:"streaming"|"final", outputTokensPerSecond, outputTokens?, timeToFirstTokenMs?}`）
  - `snapshot(now)` → `{ state: "live"|"recent"|"idle", streams: [{requestId, modelId, providerId, isSub, tps, phase}], totalTps, subTps, lastEventAt, lastProviderId, lastFinal: {modelId, tps, outputTokens, at} | null, fallback: {tps, completedAt} | null }`（`lastProviderId`=最近事件厂商，Task 5 素条跟随用）
  - state 判定：存在 phase=streaming 流 → `live`；否则 lastEventAt 距 now ≤ `IDLE_AFTER_MS`(=300000) → `recent`；超 → `idle`
  - `noteFallbackRow(row)`：订阅不可达时由服务层喂最新完成行（内部存 requestTps(row) 与 completedAt）
- Consumes: Task 1 `subagentSessionIds` 产出的 Set

- [ ] **Step 1: 失败测试**

```js
it("requestTps 迁移：303/2800ms → 108.21（四条边界用例原样保留）", () => {});
it("streaming 事件建流：单流 live，totalTps=流速率", () => {});
it("多流并列：主+子代理双流，streams 两行、isSub 判定正确、subTps 只计子代理", () => {});
it("final 事件收流：流消失转 recent，lastFinal 记末值", () => {});
it("空闲 5 分钟 → idle；recent 态保留末值不显示 0", () => {});
it("事件键名契约：camelCase 载荷直录（Task 0 定案键名不一致时按 notes 调整映射并有单测）", () => {});
it("兜底：noteFallbackRow 后 snapshot.fallback 有值，与流并存时流优先", () => {});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL（模块不存在 + 旧用例删除后计数变化）

- [ ] **Step 3: 实现 live-rate.mjs（rate.mjs 保留待 Task 4）**

`Map<requestId, 流>`；final 即删流记 lastFinal；无 EMA/无窗口加权/无三态保持——展示值=官方推送值原样。

- [ ] **Step 4: 全仓死代码校验**

Run: `grep -rn "core/rate.mjs" extension tests`
Expected: 仅 `extension/main.js` 一处导入残留（Task 4 切换后清零），其余无引用

- [ ] **Step 5: 运行确认通过 + 提交**

```bash
npm test
git add extension/core/live-rate.mjs tests/rate.test.mjs
git commit -m "feat: 实时速率改官方流式事件驱动（live-rate 状态机；EMA/窗口加权/三态保持全废）"
```

### Task 4: 快照契约 buildSnapshotV2 + 60s 拍 tickV2

**Files:**
- Modify: `extension/main.js`
- Test: `tests/main.test.mjs`（重写）

**Interfaces:**
- Produces:
  - `buildSnapshotV2({ liveSnapshot, quotaRows, trend, conclusion, now })` → `{ generatedAt, rate, quota, trend, conclusion }`（quota 形状沿用现有透传；**无 charts 键**；序列化安全无密钥）
  - `computeConclusion(quotaRows, percentHistory, now)` → `{ instanceName, pctNow, pctAtReset, resetMs } | null`：percentHistory=`Map<providerId, [{t, pct}] ≤30>`，对 5h 水位最高实例线性外推至 resetMs；样本 <5 或增量≈0 → null（「消耗速度尚不足以推算」由 view-model 占位）
  - `tickV2(state, deps)`：防重入保留；节奏常量 `TICK_MS=60000`（测试注入短间隔）、`QUOTA_TTL_MS=60000`、`SESSIONS_TTL_MS=60000`；流程=增量拉取→`addRow`/`prune`→sessions 刷新→`subagentSessionIds`→quota 拉取→percentHistory 追加→快照→deliver
  - state 新形态：`{ cursor, buckets, live, subagentIds, sessionsAt, quotaRows, quotaAt, percentHistory, quotaPending }`
  - `onGenerateEvent(ev, now)`：事件入口（activate 绑定，见 Task 6）——`live.onEvent` 后**节流**：距上次事件型 deliver < `EVENT_THROTTLE_MS`(=1000，Task 0 节奏可校) 则只更新 live 不重建快照
  - `computeQuota` 兜底收窄（设计 §五.3 裁量）：**5h 窗口分子改走 `windowSum(buckets, providerId, startMs, endMs)`**（bounds 由 quota.mjs `windowBounds` 换算为 startMs/endMs）；**周/月窗口删除本地分子兜底**——官方失败时 `used=null`，仅由 view-model 出状态句「官方接口不可用」
- Consumes: Task 1 `fetchNewModelUsage`/`fetchRecentModelUsage`/`subagentSessionIds`；Task 2 `addRow`/`prune`/`trendPoints`/`windowSum`；Task 3 `createLiveRate`/`requestTps`

- [ ] **Step 1: 失败测试**

```js
it("60s 拍：一拍内完成增量落桶+快照；额度与会话不逐拍重打（60s 节流）", () => {});
it("首拍回填：fetchRecentModelUsage 近 24h 落桶即弃，游标=回填 maxRowid，后续增量无重叠", () => {});
it("事件风暴：一秒内多事件仅触发一次快照重建与 deliver（节流）", () => {});
it("防重入：慢周期进行中不叠加并发拉取（沿用 V1 根因护栏）", () => {});
it("结论句：30 分钟采样外推撑得到/撑不到；样本不足 → null", () => {});
it("额度兜底收窄：5h 分子取 windowSum（小时桶）；周/月官方失败 used=null 无本地分子", () => {});
it("快照无密钥：序列化结果不含 sk- 样式子串（沿用）", () => {});
it("兜底链：无订阅时 tick 内最新完成行 noteFallbackRow，快照 rate.fallback 有值", () => {});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL（buildSnapshotV2 未定义）

- [ ] **Step 3: 实现**

main.js：删除 buildSnapshot/tick/quantile/genMsOf/charts 八组计算与 BUFFER_RETAIN_MS 环形缓冲；导入切换为 live-rate/hourly/view-model V2 与 db-reader 新函数，**切换后删除 `extension/core/rate.mjs` 文件**；tickV2 按 Interfaces 流程组装；writeSnapshotFile 兜底通道保留。

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add extension/main.js tests/main.test.mjs
git commit -m "feat: V2 服务层（60s 单拍/增量落桶/事件节流/结论外推；charts 全量计算退役）"
```

### Task 5: 展示模型 view-model V2（素条四态 + 面板）

**Files:**
- Modify: `extension/view-model.mjs`（全量重写；保留 fmt1/fmtTok/fmtSmart/resetText/quotaColor/srcLabelOf 等仍在用的辅助）
- Test: `tests/dashboard.test.mjs`（重写）

**Interfaces:**
- Produces:
  - `toDisplayModelV2(snap, now)` → `{ strip: { text, tooltip }, panel: { rate, vendors, trend, conclusion } }`
  - `panel.rate` = `{ stateText, streams: [{modelId, tpsText, isSubText}], totalText, lastActivityText }`
  - `panel.vendors` = `[{ name, ringPct, ringColor, statusText, subText, percents: [{label, pct}] }]`（按 5h 水位降序；percents 枚举实例全部窗口）
  - `panel.trend` = `{ points: [{x: 序号, y: tokens}], footText }`；`panel.conclusion` = `{ text }`（null 结论 → 「消耗速度尚不足以推算」占位）
  - 素条四态**逐字文案**（设计 §五.6 表格为唯一权威）：
    - live 单流：`428 tok/s · 5h 73%`；并行：`428+96 tok/s · 5h 73%`
    - 空闲：`智谱 5h 73% · 周 41%`（跟随最近请求厂商，取自快照 rate.lastProviderId——live-rate snapshot 需带出最近事件 providerId）
    - 无数据：`ZPowerPack 待机`
  - **保留待清**：V1 导出 `toDisplayModel`/`ttftHistogram` 暂留（`extension/main.js` 仍导入，先删套件即红；Task 4 切换导入、Task 8 清零）；charts 映射函数随重写消失
- Consumes: Task 4 快照契约

- [ ] **Step 1: 失败测试**

```js
it("素条四态逐字：live 单流/并行合计/空闲水位/待机（≤40 字符全数断言）", () => {});
it("素条 tooltip ≤200：三窗口+重置+主子速率全量且不截断关键信息", () => {});
it("厂商行：环色 60/85 双阈值；状态句相对/绝对两态；percents 枚举全部窗口（OpenCode 三枚）", () => {});
it("结论句：外推文本含实例名与「推算」标注；样本不足占位", () => {});
it("空快照全链不抛错：素条=待机、面板各空态", () => {});
it("界面文案禁 P50/P95（沿用护栏）", () => {});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL（`toDisplayModelV2 is not defined`）

- [ ] **Step 3: 实现 view-model V2**

保留 fmt 辅助与额度文案函数；素条四态逐字实现；charts 映射函数随重写消失；V1 导出 `toDisplayModel`/`ttftHistogram` 暂留（消费方 Task 4 切换导入，Task 8 清零）。

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add extension/view-model.mjs tests/dashboard.test.mjs
git commit -m "feat: V2 展示模型（素条四态+面板厂商行/趋势/结论；charts 映射退役）"
```

### Task 6: manifest 收敛 + activate 接线（订阅绑定/notify/素条/sync）

**Files:**
- Modify: `.zcode-plugin/plugin.json`
- Modify: `extension/main.js`（activate）
- Test: `tests/manifest.test.mjs`、`tests/main.test.mjs`

**Interfaces:**
- Produces:
  - manifest `slots`：**删除 `nav.primary`**；`composer.status` 条目 `{ id: "zpowerpack-mini", order: 1, icon: "gauge", title: "ZPowerPack 用量速览", target: { command: "zpowerpack-open-dashboard" } }`；description 更新为 V2 文案（不再宣称速度/健康/时段统计）
  - `activate(ctx, opts)`：views.register 三个资源——`zpowerpack://display`（V2 展示模型）、`zpowerpack://snapshot`（原始快照调试）、`zpowerpack://sync`（read 触发即时额度拉取并返回 `{ quota }`，成功后 notify display）；`onDidOpen(info)` 保存 `{ notify }`（键形态按 Task 0 notes），`onDidClose` 清引用
  - `bindOnGenerate(ctx, handler)`：按 Task 0 `SUBSCRIBE_FORM` 绑定；try/catch 失败 → 中文 warn + `subscriptionOk=false`（tickV2 走兜底行喂给 `live.noteFallbackRow`）
  - 素条推送 `pushStrip(strip)`：**无 badge 字段**；同值去重保留
- Consumes: Task 0 定案；Task 4 `onGenerateEvent`/`tickV2`；Task 5 `toDisplayModelV2`

- [ ] **Step 1: 失败测试**

```js
it("manifest：slots 无 nav.primary；composer.status 条目 icon=gauge 且 target 指向已声明命令", () => {});
it("activate：注册三资源（display/snapshot/sync）；sync read 触发一次即时额度拉取并返回 quota", () => {});
it("activate：onDidOpen 保存 notify 句柄，数据更新时调用 notify(display)（注入句柄夹具）", () => {});
it("activate：素条推送无 badge 字段；同值去重", () => {});
it("订阅绑定失败降级：bindOnGenerate 抛错被吞为 warn，激活不失败，tick 走兜底行", () => {});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL（manifest 断言不符 / sync 资源未注册）

- [ ] **Step 3: 实现 manifest 收敛与 activate 接线**

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add .zcode-plugin/plugin.json extension/main.js tests/manifest.test.mjs tests/main.test.mjs
git commit -m "feat: 唯一入口接线（manifest 收敛 composer/gauge；订阅绑定+notify 推送+sync 资源；素条去 badge）"
```

### Task 7: 视图全量重写（单文件卡片面板）

**Files:**
- Modify: `extension/view/index.html`（全量重写）
- Test: `tests/dashboard.test.mjs`（视图形约新增）、`tests/integration.test.mjs`（改造）

**Interfaces:**
- Consumes: Task 5 `panel` 形状；Task 6 `zpowerpack://display`/`sync` 资源；Task 0 订阅形态
- 视觉契约（设计 §五.1 唯一权威）：深色大圆角卡片、厂商行（内联 SVG 环 `stroke-dasharray` + 状态句 + percents 右对齐）、速率条（活跃流并列 + 呼吸圆点）、24h 面积折线（内联 SVG path，无外链）、结论句、右上角手动同步按钮（拉取中 disabled+旋转，10s 超时复位，失败中文 toast）
- 动效：数字变化 `transition 300ms`；`prefers-reduced-motion` 下全部关闭；无逐字滚动等装饰性动画
- 取数：优先订阅（`window.zcode` 订阅形态按 Task 0 notes）+ 1s 轮询兜底常量 `POLL_FALLBACK_MS`

- [ ] **Step 1: 失败测试**

```js
it("视图自包含：无外链 script/无 http 引用；关键节点 data-testid 齐（rate-bar/vendor-row/trend-chart/sync-btn/conclusion-line）", () => {});
it("动效契约：含 prefers-reduced-motion 媒体查询；数字节点带 transition 类", () => {});
```
integration.test.mjs 改造：真实 schema db + 注入事件夹具 → activate → display 资源输出 V2 形状全链断言 + sync read 触发断言。

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL（视图形约断言不符）

- [ ] **Step 3: 实现视图重写**

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add extension/view/index.html tests/dashboard.test.mjs tests/integration.test.mjs
git commit -m "feat: V2 卡片视图（AI Usage Widget 形态/订阅推送取数/手动同步/动效含降级）"
```

### Task 8: 死代码清零 + CI 全绿收口

**Files:**
- Modify: 按扫描结果清理（extension/ tests/ 全仓）

- [ ] **Step 1: 死代码扫描**

Run: `grep -rn "windowedRate\|displayRate\|ttftHistogram\|providerHealth\|byProject\|toolStats\|fetchToolUsage\|usageInWindow" extension tests`
Expected: 无残留（usageInWindow 随 5h 兜底改走 windowSum 而退役；windowBounds/percent 保留；`extension/core/rate.mjs` 文件已随 Task 4 删除；view-model V1 导出 toDisplayModel/ttftHistogram 清零；历史遗留死代码按惯例指出不擅删，**本次改动产生的**必须清零）

- [ ] **Step 2: 空库集成用例**

integration.test.mjs 增空库场景：activate 不抛错、素条=待机、display 空态。

- [ ] **Step 3: 全量 CI**

Run: `npm run ci`
Expected: lint 通过 + 全量测试全绿（新契约计数，旧 116 中已废用例删除）

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "test: V2 收口（空库集成+死代码清零+CI 全绿）"
```

### Task 9: 真机验收（用户协作）

**Files:** 无代码变更；产出验收记录追加到 notes。

- [ ] **Step 1: 用户操作：更新插件并重启 zcode**

插件源=仓库根（marketplace "./"），代码已就位；ESM 缓存须重启。重启后随便发一条消息触发生成。

- [ ] **Step 2: 逐项验收（设计 §八 + 用户判读）**

①素条出现在模型选择器左侧、四态正确（生成/并行/空闲/待机）、悬停 tooltip 全量；②应用内无 nav/侧栏多余入口；③面板：速率条生成中实时动、厂商行环与重置句、24h 趋势、结论句；④额度 60s 自动到 + 手动按钮 ≤10s 返回；⑤**打开看板无整端卡顿**（V1 遗留疑问一并确认）；⑥输出无密钥泄漏。任何一项不过 → 修复循环（对应任务回炉）。

- [ ] **Step 3: 提交验收记录 + 探针卸载提醒**

```bash
git add docs/superpowers/notes/
git commit -m "docs: V2 真机验收记录"
```
提醒用户桌面端卸载 zpowerpack-probe 与 zpowerpack-dev 市场（交接 §3.2 遗留）。
