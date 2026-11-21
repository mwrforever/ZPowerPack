# ZPowerPack 用量看板与额度查询 实施计划（Plan 2/2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面端原生看板：实时 token/s（汇总+按模型、平滑保持）、吞吐/TTFT/上下文→速率/项目/工具/Provider 稳定性/时段热力图、四家保底的套餐额度窗口卡片。

**Architecture:** 官方 `db.sqlite` 只读轮询（1s 增量游标）→ 纯函数指标层 → extension view（plugin-sandbox + d3）渲染；V1 验证失败则降级 Gen UI 片段。额度=实例自动发现 + 窗口规则引擎 + 官方接口优先/用户配置兜底。

**Tech Stack:** Node ≥22.5（`node:sqlite`）、`node:test`、d3（沙箱 vendor 内置）、零 npm 依赖。

**Spec:** `docs/superpowers/specs/2026-11-15-zpowerpack-design.md`（Part 2 / G2 / G4 / E1 / E6 / V1-V6 / §七）

## Global Constraints

- 同 Plan 1 全部约束（中文注释日志、UTF-8/LF、零依赖、敏感值不落日志、每任务一提交）
- 所有 SQL 按列名取值，启动时探测表/列存在性，缺列降级隐藏对应指标（§七 兼容策略）
- 视图渲染遵循 plugin-sandbox 环境（d3 7.9 已 vendor；禁止假设 Node API 存在于视图侧）
- 指标口径以设计文档 §五"指标口径"为准（分母剔除 TTFT、EMA α=0.3、保持上限 5 分钟、样本阈值 2s、错误行不入速率）

## Review Focus

1. 在飞请求/长 TTFT 期窗口渐空——必须触发保持逻辑展示上一波速率而非 0 → Task 3 测试钉死
2. 超短请求（生成时长 <100ms）把 tps 拉到数万——EMA+时长加权必须抑制 → Task 3 测试钉死
3. zcode 更新后 db 列缺失/改名——按列名查询+列探测降级，不得抛错崩溃 → Task 2 测试钉死
4. provider_config.json 中 apiKey 字段——枚举结果与日志断言不含 key 值 → Task 4 测试钉死
5. 时区/周界——时段热力图与周额度按本地时区对齐（周一 00:00 本地），跨月/跨年边界 → Task 5 测试钉死

---

### Task 1: 第一天验证 V1/V3/V4/V5/V6（gate 任务）

**Files:**
- Create: `docs/superpowers/notes/2026-11-21-day1-verification.md`

**Interfaces:**
- Produces: 决策记录，供 Task 6/8 消费——① 扩展形态判定（extension view / Gen UI 兜底）；② main↔视图通道形态（推送 RPC / 拉取式）；③ 事件订阅通道有无（真流式升级判定）；④ `node:sqlite` 在扩展宿主可用性；⑤ v2 目录是否跟随 storage.dir；⑥ 各厂商额度接口调研表（智谱/Kimi/OpenCode/Qwen：端点、鉴权、窗口结构）+ 初始 WINDOW_RULES 数据

- [ ] **Step 1: V1 扩展验证**：向本机 zcode 安装最小扩展插件（manifest 含 `main`+`contributes.views`+`onView`）实测加载；记录 `.zcode-plugin/plugin.json` 是否接受扩展字段、是否 feature gate、grants 词汇表、消息通道形态
- [ ] **Step 2: V3/V4 验证**：扩展宿主内 `require('node:sqlite')` 实测；只读打开被主进程持有的 db.sqlite 实测并发
- [ ] **Step 3: V5 验证**：查 zcode.cjs v2 目录解析是否经 cliStorageRoot（grep `v2` 路径构造），记录结论
- [ ] **Step 4: V6 调研**：web 调研四家官方 usage/额度接口与窗口结构（智谱 coding plan、Kimi For Coding、OpenCode Zen、Qwen coding plan），写入调研表；未证实可得分母的厂商标记"用户配置兜底"
- [ ] **Step 5: Commit** `docs: 第一天验证结论与额度接口调研表`

### Task 2: db 读取层 db-reader.mjs

**Files:**
- Create: `extension/core/db-reader.mjs`
- Test: `tests/db-reader.test.mjs`

**Interfaces:**
- Consumes: Plan 1 Task 2 `resolveCliStorageRoot`（config.json 定位）
- Produces:
  - `resolveDbPath(env, homedir): string`（config.json `storage.sessionDbPath` → 默认 `~/.zcode/cli/db/db.sqlite`）
  - `openDb(path): {db, schema:{modelUsage: Set<列名>, turnUsage, toolUsage}}`（readonly；启动探测列）
  - `fetchNewModelUsage(db, cursor): {rows, nextCursor}`（rowid 游标；仅 SELECT 存在列；行结构 = 设计文档 E1 字段命名 camelCase）
  - `fetchToolUsage(db, sinceMs): rows[]`

- [ ] **Step 1: 写失败测试**：① 临时库按 E1 结构造 model_usage 30 行 → 首次 fetch 全量、游标推进、追加 5 行后只取增量；② 删掉一列（模拟旧版 schema）→ columnsExist=false → 行中该字段 undefined 不抛错；③ db 文件不存在 → 返回空 schema 与空行（不抛错，中文 warn 由调用层打）
- [ ] **Step 2: 运行** FAIL → **实现** → **PASS** + lint
- [ ] **Step 3: Commit** `feat: db.sqlite 只读增量读取层（列探测降级）`

### Task 3: 指标层 rate.mjs（核心，100% 覆盖）

**Files:**
- Create: `extension/core/rate.mjs`
- Test: `tests/rate.test.mjs`

**Interfaces:**
- Consumes: Task 2 行结构
- Produces:
  - `requestTps(row): number|null`（`= output_tokens ÷ (completed_at − first_token_at)`；first_token_at 缺失兜底 duration_ms；非 completed 或分母 ≤0 → null；reasoning 计入产出）
  - `windowedRate(rows, {windowMs=60000, now}): {genRate, throughput, sampleDurationMs, byModel: Map<modelId, {genRate, throughput, querySource, lastCompletedAt}>}`（时长加权；error 行剔除）
  - `ema(prev, next, alpha=0.3): number`
  - `displayRate(state, {now, minSampleMs=2000, holdMaxMs=300000}): {value, state:'live'|'held'|'idle', asOf}`（state 形参 = `{prevValue 上波值, asOf 上一新样本时刻, sampleDurationMs 当前窗口Σ生成时长, lastNewRowMs 最近完成行时刻}`；sampleDurationMs<2000 或无新行 → held 上波值；超 holdMaxMs → idle）

- [ ] **Step 1: 写失败测试**（用真实样本值）：① `requestTps({output:303, completed:…317253, first:…314453})` → 108.21（保留 2 位）；first 缺失 → 按 duration_ms=8012 → 37.83；非 completed → null；② windowedRate：3 行两模型 → byModel 分组、genRate=Σout/Σgen、error 行不计入；③ `ema(100,120,0.3)=106`；④ displayRate：sampleDurationMs=800 → held 且 value=上波值；now-asOf>300000 → idle；正常 → live；⑤ 超短请求（gen=80ms, out=50）与长请求（gen=30000ms, out=9000）混合 → genRate 不超过长请求速率 ±10%（平滑钉死）
- [ ] **Step 2: 运行** FAIL → **实现** → **PASS** + lint
- [ ] **Step 3: Commit** `feat: 速率口径（TTFT 剔除/加权窗口/EMA/保持逻辑）`

### Task 4: provider 发现 providers.mjs

**Files:**
- Create: `extension/core/providers.mjs`
- Test: `tests/providers.test.mjs`

**Interfaces:**
- Consumes: Plan 1 Task 2 路径解析
- Produces:
  - `discoverInstances(v2ProviderConfigPath): [{providerId, templateId, providerName, accessType}]`（不含任何 key 值；文件缺失 → 空数组 + 由调用层 warn）
  - `loadTemplates(builtinJsonPath): Map<templateId, {name, baseUrl, apiType, models[]}>`（防御解析：字段缺失容错）
  - `matchTemplateFamily(templateId): 'zhipu'|'kimi'|'opencode'|'qwen'|'other'`（`kimi-*`→kimi、`opencode-*`→opencode、`qwen-*`→qwen、`bigmodel-*|zai-*`→zhipu）

- [ ] **Step 1: 写失败测试**：fixture=脱敏 provider_config 片段（4 实例，含 apiKey 字段）+ builtin 片段（kimi-code-cn/opencode-go-messages/bigmodel-api/qwen-coding-plan-cn 模板）→ ① 枚举 4 实例且断言 JSON.stringify 结果不含 `sk-` 与 `apiKey` 值；② 模板对照 baseUrl 正确；③ family 归类 4 例正确
- [ ] **Step 2: 运行** FAIL → **实现** → **PASS** + lint
- [ ] **Step 3: Commit** `feat: provider 实例自动发现与模板对照（不硬编码厂商）`

### Task 5: 额度窗口引擎 quota.mjs

**Files:**
- Create: `extension/core/quota.mjs`、`extension/core/window-rules.json`（内置规则表=数据）
- Test: `tests/quota.test.mjs`

**Interfaces:**
- Consumes: Task 3/4
- Produces:
  - `window-rules.json`：`{ "<templateFamily|templateId>": [{type:'rolling-5h'|'weekly'|'monthly', reset:{dow?:1-7, dom?:1-31, tz:'local'}, source:'official-api'|'user-config'}] }`——初值来自 Task 1 V6 调研表；用户可在插件配置覆盖
  - `windowBounds(rule, now): {startMs, endMs, nextResetMs}`（rolling-5h=[now-5h,now]；weekly=本周一 00:00 本地→下周一；monthly=reset.dom 对齐，跨年正确）
  - `usageInWindow(rows, {providerId, bounds}): {input, output, requests}`
  - `percent(used, limit): number|null`（limit null/0 → null）

- [ ] **Step 1: 写失败测试**：① rolling-5h 边界=[now-18000000, now]、nextReset=now；② weekly：以周三 12:00 为 now → start=本周一 00:00 本地、跨年周界（12月31日为周一的用例）；③ monthly：dom=15、now=3月31日 → 3月15日 00:00 起；④ usageInWindow 过滤 providerId 与边界；⑤ percent(23000, null)=null、percent(23,100)=23.0
- [ ] **Step 2: 运行** FAIL → **实现**（规则表先按 V6 调研填 4 家初值，未证实窗口的厂商仅 rolling-5h）→ **PASS** + lint
- [ ] **Step 3: Commit** `feat: 额度窗口规则引擎（订阅周期对齐/规则即数据）`

### Task 6: 官方分母获取 quota-fetch.mjs

**Files:**
- Create: `extension/core/quota-fetch.mjs`
- Test: `tests/quota-fetch.test.mjs`

**Interfaces:**
- Consumes: Task 4/5；插件配置 `quota.userLimits`（分母兜底值）
- Produces: `fetchLimit({family, providerId, apiKeyRef, rule, userLimit, fetchImpl=global fetch, timeoutMs=8000}): Promise<{limit, source:'official'|'user-config'|'unavailable'}>`——官方接口按 V6 调研表路由；失败/超时/未证实 → 回退 userLimit；两者皆无 → unavailable。**apiKeyRef 为内存引用，请求头使用后即弃，不写日志**

- [ ] **Step 1: 写失败测试**：① stub fetch 返回 mock JSON → limit 取官方值 source='official'；② fetch reject → 回退 userLimit source='user-config'；③ 两者皆无 → {limit:null, source:'unavailable'}；④ 日志输出断言不含 key 值
- [ ] **Step 2: 运行** FAIL → **实现** → **PASS** + lint
- [ ] **Step 3: Commit** `feat: 额度分母获取（官方优先/配置兜底/密钥不落盘）`

### Task 7: 扩展服务层 extension/main.js

**Files:**
- Create: `extension/main.js`（按 Task 1 V1 结论落 manifest 声明；若 plugin.json 需合并扩展字段则同任务修改 `.zcode-plugin/plugin.json`）
- Test: `tests/pipeline.test.mjs`

**Interfaces:**
- Consumes: Task 2-6 全部
- Produces:
  - `buildSnapshot({rows, toolRows, quotaRows, now, rateState}): object`——纯函数，输出视图消费的唯一 JSON：`{rate:{main, subagent, byModel[], display}, quota:[{providerId, name, windows[], nextResetMs, percent, source}], charts:{throughput[], latency[], ctxVsRate[], byProject[], toolStats[], providerHealth[], heatmap[][]}}`
  - `start({intervalMs=1000})`：1s 轮询 fetchNewModelUsage → 增量 rows 入环形缓冲 → buildSnapshot → 按 V1 通道结论送达视图（推送 RPC 或写 `<cliStorageRoot>/zpowerpack/last-snapshot.json` 供拉取）

- [ ] **Step 1: 写失败测试**：构造 200 行混合数据（含 subagent/error/多模型/跨 5h 边界）→ buildSnapshot 断言：rate.display.state 合法、byModel 按 lastCompletedAt 排序、quota 每实例含 windows 数组、charts 六组字段齐全、序列化结果不含 key
- [ ] **Step 2: 运行** FAIL → **实现**（轮询/通道按 V1 结论；视图侧拉取式则实现 last-snapshot.json 原子写）→ **PASS** + lint
- [ ] **Step 3: Commit** `feat: 扩展服务层（1s 聚合管线/快照输出）`

### Task 8: 看板视图 view/index.html + view.js

**Files:**
- Create: `extension/view/index.html`、`extension/view/view.js`

**Interfaces:**
- Consumes: Task 7 快照 JSON（字段即契约）
- Produces: **构图契约 = 锁定稿「聚焦主屏」**（方向契约 `.impeccable/surfaces/dashboard.md`，构图基准 `.impeccable/mocks/decision/focus-stage.html`——2026-11-21 用户锁定，前四轮其它候选全部淘汰）。交互规范逐条落地：窗口条 60%/85% 转色（颜色+文案双信号）、live/held/idle 三态徽标（held 不显示 0）、时间范围切换仅作用历史报表、报表卡展开下钻（按模型明细/工具统计）、空态/加载骨架/「配置分母」按钮；窗口组合按 spec §五（智谱 5h+周/Kimi 5h+月/OpenCode 5h+周+月，无 Qwen）；界面文案经术语映射（禁 P50/P95）；主题令牌优先读宿主变量，缺失回退锁定稿默认值；迷你常驻条仅当 Task 1 V1 确认 slots 通道可用时实现（复用同一快照，仅显示当前会话厂商）

- [ ] **Step 1: 实现视图**：舞台（速率巨字+背景 60s 速率历史线+held/idle 徽标）→ 流光缝 → 额度水位行（智谱[5h|周]·Kimi[5h|月]·OpenCode[5h|周|月]）→ 2×3 无边框报表网格（速度对比/首字等待/上下文→速度/时段热力/按项目/谁家更稳，每卡带描述句）；工具调用与按模型明细为报表卡下钻
- [ ] **Step 2: 数据一致性抽验**：真机安装打开视图，人工抽 2 项与 sqlite 手查对比（当日 output 总量、某模型典型速度），误差=0
- [ ] **Step 3: 对照锁定稿验收**：舞台/额度行/网格构图逐项过 focus-stage.html；四种状态（held/idle/分母未配置/空态+加载骨架）；对比度 ≥4.5:1（小字）；窄宽不溢出
- [ ] **Step 4: Commit** `feat: 原生看板视图（聚焦主屏构图/额度水位/报表网格/状态覆盖）`

### Task 9: （条件）Gen UI 兜底形态

仅当 Task 1 判定扩展宿主不可用（V1 失败）时执行：
- Create: `skills/dashboard/SKILL.md`（生成快照 → 输出 HTML 片段到会话目录内联渲染；数据层复用 Task 7，快照以文件交换，刷新由命令触发）
- [ ] **Step 1: 实现并冒烟**（会话内 `/zpowerpack:dashboard` 渲染成功）；**Step 2: Commit** `feat: Gen UI 兜底看板`。V1 通过则本任务跳过并在计划上标注"不执行"

### Task 10: 集成测试与全量验收

**Files:**
- Create: `tests/integration.test.mjs`

- [ ] **Step 1: 集成测试**：临时目录组装 真实 schema 的 db.sqlite + provider_config/builtin fixture + 配置 → 启动服务层 3 个轮询周期 → 断言快照端到端正确且文件无敏感值
- [ ] **Step 2: 全量** `npm test`（Plan 1+2 全部测试）与 `npm run lint` 通过；CI 脚本入 package.json（`pre-commit` 钩子跑 lint+test）
- [ ] **Step 3: 真机验收**：安装→桌面端打开看板→对照验收清单（9 指标组/额度 4 卡/速率保持逻辑观察 1 次长 TTFT 场景）
- [ ] **Step 4: Commit** `test: 集成测试与 CI 约束` → 版本号升至 0.1.0 正式并更新 marketplace.json
