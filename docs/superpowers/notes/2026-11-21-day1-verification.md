# ZPowerPack 第一天验证笔记（Plan 2 Task 1：V1/V3/V4/V5/V6）

> 计划文件名沿用 `2026-11-21`（计划指定），实际验证执行日：2026-11-22（zcode 3.19.0 → 3.19.1 更新后）。
> 本文是 Task 6/8 的决策依据：① 扩展形态判定；② main↔视图通道形态；③ 事件订阅通道有无；④ node:sqlite 可用性；⑤ v2 目录是否跟随 storage.dir；⑥ 额度接口调研表。
> 静态证据来源：3.19.1 `resources/app.asar` 提取源码（提取件在 SDD 工作区 `extract/`，git 不入库），引用均标注出处文件与特征串。

## 结论速览（Task 6/8 直接读这一节）

| # | 验证项 | 结论 | 置信 |
|---|---|---|---|
| V1-a | manifest 落地形态 | **`.zcode-plugin/plugin.json` 内嵌 `extension` 字段**（与 name/version/skills 同文件混装），非独立文件 | 静态（宿主源码 `if ("extension" in s)`）+ 探针动态待确认 |
| V1-b | feature gate | **未发现门控**：主进程无条件 fork 扩展宿主进程（`serviceName:"zcode-extension-host"`），未发现设置键/实验开关 | 静态 + 探针动态待确认 |
| V1-c | grants 词汇表 | `["sessions.read","sessions.write","sessions.fullAccess","notifications"]`——**无 fs/exec 类 grant**（Node API 默认可用性由探针确认） | 静态 |
| V1-d | main↔视图通道 | **MCP Apps 双向通道**：视图沙箱暴露 `window.zcode`（`callTool/readResource/listResources` + `notifications/resources/list_changed` 推送）；扩展侧 `views.register(id, {entry, onDidOpen} 或 server factory)` → **推送可用，Task 7 走推送** | 静态 + 探针动态待确认 |
| V1-e | 事件订阅通道 | 资源订阅通道存在（`resources/subscribe` + list_changed 推送）；请求级 usage 事件未发现（保持"完成时滑动窗口"口径） | 静态 |
| V1-f | slots 词汇表 | `nav.primary`（view/surface，app，每插件 1 项）、`sidePane.launcher`（view，workspace，5 项）、`composer.status`（command，session，1 项，patch={text≤40,tooltip≤200,visible,badge:1-9999\|"dot"}）、`file.viewer`、`composer.mention` | 静态 |
| V3 | node:sqlite（扩展宿主内） | 宿主为独立 Node 进程（ESM import 可用）；真机结果待探针回填 | 探针待回填 |
| V4 | db.sqlite 只读并发 | 真机结果待探针回填（预期 WAL 无碍） | 探针待回填 |
| V5 | `~/.zcode/v2/` 是否跟随 storage.dir | **不跟随**。v2 = `join(getDataBaseDir(), ".zcode", "v2")`；`getDataBaseDir = 编程设置值 \|\| env.ZCODE_DATA_BASE_DIR \|\| homedir`，**不经 config.json 的 storage.dir**（见下文证据） | 静态（迁移实测时按 V2 清单复核） |
| V6 | 三厂商额度接口 | 调研表见 §六（后台调研完成后回填） | 调研中 |

## 一、V1：扩展宿主（3.19.1 源码证据）

### 1. manifest 契约（关键修正：`extension` 内嵌字段）

`host/index.js` `resolvePluginManifest`（特征串 `if("extension"in s)`）：

```jsonc
// .zcode-plugin/plugin.json —— 基础字段与扩展声明同文件，扩展部分是 extension 子对象；slots 是顶层字段（2026-11-22 二次探测修正三处）
{
  "name": "...", "version": "...", "description": "...", "skills": "skills",
  "extension": {                                   // strictObject（PVe）仅允许 engines/main/activationEvents/grants/protocols/contributes，多一个键即 invalid
    "engines": { "zcode": "^1.4.0" },              // 必填。⚠ 对齐「扩展 API 版本」而非 zcode 应用版本：3.19.1 实测 host provides 1.4.0（首轮锁 ^3.19.1 → incompatible 被丢）
    "main": "extension/main.js",                   // 可选；必须插件根内相对路径（不得绝对/含 ..）
    "activationEvents": ["onAvailable"],            // 可选；onCommand:<id>/onView:<id> 会由宿主按 declares 自动补全（resolveActivationEvents）
    "grants": ["sessions.read"],                   // 可选；词汇表见下
    "contributes": { "commands": [{"id","title"}], "views": [{"id","title","icon?","scope?"}] },
    "protocols": {...}                             // 可选
  },
  "slots": {                                       // ⚠ 顶层字段（嵌在 extension 内会被 strict 拒）；对象按 slot id 做键（首轮误记为数组）
    "nav.primary": [ { "id": "…", "order?": 1, "icon?": "…", "title?": "…", "target": { "view": "probe-view" } } ]
  }
}
```

- 视图条目 schema（`wL`）：`{id: /^[a-z0-9._-]{1,64}$/, title: string|国际化表, icon?: /^[a-z0-9-]{1,48}$/ 名称（lucide）, scope?: 仅 "app"}`
- slots 条目 schema（`Ece`/parseManifestSlots）：`{id 必填, target 必填, title?, icon?, order?(-1000~1000)}`；target 为「kind 做键」的**单键**对象 `{"view"|"command"|"surface"|"tool": id}`（EVe 转为 {kind,id} 入声明 slotItems）；条目引用的 view/command 必须已在 contributes 声明（WVe 交叉校验，未声明条目丢弃记 problems）
- 激活事件正则：`^(onAvailable|onCommand:<id>|onView:<id>)$`；`onView/onCommand` 引用的 id 必须已声明
- 校验两级（`validateExtensionManifest`=vce）：先非严格探测 `engines.zcode` → 版本兼容检查（不满足报 incompatible）→ strictObject 全量校验 extension 子对象
- `engines.zcode` 兼容规则（`CVe`）：`^x.y.z` → 主版本必须相同（0.x 还须次版本相同）且 host 版本 ≥ 基线；`x.y.z` → 精确匹配；**版本基准 = 扩展 API 版本常量（`dg`，zcode 3.19.1 = "1.4.0"）**
- 激活：宿主 `import(<main>)` → 命名或默认导出含 `activate(ctx)` → `S.activate(ctx)`，**10 秒激活超时**；⚠ ESM 模块缓存跨声明刷新持久（卸载/重装/开关只推进声明 rev，不重启扩展宿主进程——代码变更须宿主进程重启即应用重启才生效，2026-11-22 实测）

### 2. 运行时形态与门控

- 扩展宿主 = 独立子进程（main/index.js `SV.fork("../extension-host/index.js", {serviceName:"zcode-extension-host", execArgv:["--no-warnings"]})`），网络代理设置经 `buildExtensionHostEnv` 注入
- fork 路径无条件执行，未发现 `extensionsEnabled` 类设置键或实验 flag → 判定无 feature gate（以探针装机为最终确认）

### 3. 消息通道（Task 7 架构落点）

- 扩展侧 API（`createExtensionContext`）：
  - `views.register(id, {entry: "view/index.html", onDidOpen(info?)})` —— entry 形态，宿主经 resources/read 伺服文件
  - `views.register(id, factory)` —— **server factory 形态**：扩展提供 MCP server，视图作为 MCP 客户端连接（`d.connect(m)`）
  - `views.open(id, scope?)`、`commands.register(id, fn)`、`slots.update(id, patch, data?)`；未声明 id 抛 `not-declared`
- 视图沙箱侧（plugin-sandbox-alias）：**`window.zcode`** = MCP Apps 客户端：`callTool(name, args)` / `readResource(uri)` / `listResources(cursor?)` / 资源变更推送 `setNotificationHandler("notifications/resources/list_changed", …)` / `getHostContext()`（主题 light/dark）/ `setWidgetState` / `openExternal`
- 通道结论：**推送 RPC 可用**（server factory + 资源订阅推送），拉取式是兜底而非唯一形态。Task 7 按推送实现，Task 8 视图经 `window.zcode` 取数

### 4. slots 词汇表（位置 A/B 落点）

| slot | targets | scope | 每插件上限 | patch 字段 |
|---|---|---|---|---|
| `nav.primary` | view, surface | app | 1 | text/tooltip/visible/badge |
| `sidePane.launcher` | view | workspace | 5 | 同上 |
| `composer.status` | command | session | 1 | text(≤40)/tooltip(≤200)/visible/badge(1-9999\|"dot") |
| `file.viewer` | view, surface | workspace | 5 | + fileExtensions |
| `composer.mention` | command, tool | session | 3 | — |

→ 看板入口（位置 A）= `nav.primary` slot 指向看板 view；迷你条（位置 B）= `composer.status` slot + 常驻 command 经 `slots.update` 推 text/badge/tooltip——spec §五位置 B 的"会话区顶部常驻条"以 composer.status 承载（40 字符文本 + 徽标，多窗口明细收进 tooltip 与点击打开的宽面板）。

## 二、V3/V4：node:sqlite 与 db 只读并发（探针回填区）

- 静态预期：扩展宿主是完整 Node 进程（进程内见 `node:crypto` 等 import）；系统 Node v24.22.0 自带 node:sqlite；db.sqlite 为 WAL 模式只读安全（E1 已验证 80,935 行活跃写入）
- 探针实测结果：**待装机后回填**（`probe-diagnostics.json`：sqlite.imported / dbReadonly.opened / modelUsageRows / elapsedMs）

## 三、V5：v2 目录不跟随 storage.dir（源码证据链）

`host/chunk-VH3XR3TF.js`（host 侧路径根）：

```js
os = process.env.ZCODE_DATA_BASE_DIR?.trim() || null
xl = process.env.HOME?.trim() || is()          // homedir 兜底
function Gt(){ return ns || os || xl }          // getDataBaseDir（ns=编程设置值，桌面壳可调 setDataBaseDir）
function he(){ return join(Gt(), ".zcode") }    // getZCodeDataRootDir
function Ae(){ return join(he(), "v2") }        // getAppConfigDir
function Zh(){ return env覆写 ?? join(Ae(), "credentials.json") }
```

`host/index.js` @1387505：`personalFilePath: t.personalFilePath ?? HUe(ln(), qf)`（HUe=join，ln=Ae，qf="provider_config.json"）→ **provider_config.json = `<getDataBaseDir()>/.zcode/v2/provider_config.json`**。另有注入机制 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`/`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` env（`createNodeProviderRuntimePathEnv`）可整体改道。

- `getDataBaseDir` 链路**不含 config.json 的 `storage.dir`**（storage.dir→cliStorageRoot 是 Agent 运行时 zcode.cjs 的另一套机制，派生 rollout/exec/artifacts/agents/sessions/memories/plugins，见设计文档 E2）
- ⚠ 命名陷阱：storage root 下也存在 `"v2"` 子目录（`resolveSubagentStateFile` = join(storageRoot,"v2","agents-state.json")）——那是 agent 状态文件，与 provider 的 `~/.zcode/v2/` 无关
- **结论**：迁移向导**无需**迁移 `~/.zcode/v2/`；额度模块固定读 `~/.zcode/v2/provider_config.json`（代码可加 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` env 兜底）；E7 中"V5 未验证"事项关闭
- 残余风险（记录不阻塞）：桌面壳将来可能改 setDataBaseDir 来源，迁移实测（V2 清单）时复核一次 v2 实际落点

## 四、对计划的影响（Ruling 记录）

1. **Plan 2 Task 7 manifest 落点定案**：正式插件 manifest = `.zcode-plugin/plugin.json` 加 `extension` 字段（同文件混装，无需独立文件）；`activationEvents: ["onAvailable"]` 显式声明（启动即激活数据服务，view 激活事件由宿主自动补全）
2. **Task 7 通道实现**：server factory + 资源订阅推送为首选；entry 形态仅作视图静态外壳。`onDidOpen` 可用
3. **Task 8 位置 A/B**：入口 = `nav.primary` slot；迷你条 = `composer.status` slot（text+badge，明细进 tooltip；点击打开宽面板）
4. **Plan 1 Task 2 config.mjs 增补**：`resolveCliStorageRoot` 同时导出 provider 配置路径解析（固定 `~/.zcode/v2/`，env 兜底），供 Task 4 providers.mjs 消费
5. **版本兼容（§七）**：manifest `engines.zcode` 锁 `^1.4.0`（**扩展 API 版本命名空间**，zcode 3.19.1 实测 host provides 1.4.0；与 zcode 应用版本无关——首轮 `^3.19.1` 锁法已被 11:37 激活实测推翻）

## 五、探针装机与二次探测记录（2026-11-22——V1 判定最终反转：扩展路径可用）

### 5.1 首轮判定及其误因（上午，结论已被推翻，保留作教训）
首轮判定「扩展宿主从未被拉起 → V1 失败 → Gen UI 兜底」，二次探测定位出三个误因：
1. **"window-ready 从未发出"系误判**：扩展宿主进程一直存在（当前主进程 10:31:39 启动即 `forked extension host pid=33160`→`status=running`→`paired window host`，与其它 NodeService utilityProcess 同类未区分）；且"主进程不落盘日志"结论错误——真实日志在 **`~/.zcode/v2/logs/YYYY-MM-DD.log`**（按天落盘，main/host/renderer 全前缀、host-log 转发），首轮未发现该证据源，导致动态证据缺位。
2. **激活链路发送方误记**：window-ready 的真实发送方是 **agent 宿主进程（out/host/index.js utilityProcess）的 `ks.announceReady()`**（本地服务就绪后无条件调用，经 `postToMain`→parentPort），不是"渲染端 window host"；主进程 `onHostProcessReady→trackWindowHost` 收到后 `a===0?Tt():(!o||o===D)&&ke()` 派生扩展宿主。静态链路全程无门控（`xg=zA(...)` 顶层无条件创建，`xg=null` 仅 app-quit 清理）。
3. **探针不激活的真正根因（日志铁证）**：`[extensions] extension incompatible zpowerpack-probe@zpowerpack-dev: requires extension API ^3.19.1, host provides 1.4.0`——首轮把 `engines.zcode` 当应用版本锁 `^3.19.1`，实际校验基准是**扩展 API 版本常量 1.4.0**（独立命名空间），主版本 3≠1 直接丢声明；另伴随 manifest 两处 schema 误记（slots 位置/形状，修正见 §一 1）。

### 5.2 修正探针后的完整验证（2026-11-22 11:37-11:45 实测，全绿）
探针 manifest（engines `^1.4.0` + slots 顶层对象形态）三副本同步修正后，插件管理页触发重解析：
- **激活链路日志**：`static table rev=3 extensions=1 items=1 (plugins changed)` → `extension resolved` → `activating (onAvailable)` → `activated in 73ms`；卸载重装复验 rev=13→15 再次激活成功（声明重解析免重启，打开插件管理「已安装/个人」页即触发 `plugin-management.listPlugins/getPluginsOverview`）。
- **UI 可见证据（截图实证）**：左侧主导航出现「ZPowerPack 探针」入口（nav.primary slot 渲染 ✓），角标 "1" = `slots.update` 徽标推送 ✓；点开入口 `onDidOpen` 触发 ✓（诊断记录 viewOpenInfo scope=app）。
- **probe-diagnostics.json（扩展宿主内真实运行，非 mock）**：ctx API 面 13 组全录（views.register/open、slots.update、sessions 全套、settings、notifications、grants.request 等）；**V3 ✅ node:sqlite 可用（DatabaseSync）**；**V4 ✅ 只读打开运行中 db.sqlite：82,238 行 / 68ms**；errors=[]。
- **views.register entry 解析基准实证**：entry 相对**插件根** join 解析（首轮探针写 `view/index.html` → ENOENT `…\0.0.1\view\index.html`；文件实在 extension/view/ 下，已改为 `extension/view/index.html` 三副本落盘）。
- **ESM 模块缓存实证**：修正 main.js 后卸载/重装/开关仅推进声明 rev，扩展宿主进程不重启、内存模块不重载（诊断 capturedAt 恒为 11:37:26 佐证）——**扩展代码变更须扩展宿主进程重启（=应用重启）才生效**。
- **重启终验（12:24）**：新主进程 `forked extension host pid=37384` → 探针 `activated in 68ms`（capturedAt 刷新 12:24:43=修复代码已加载）→ 用户点入口 `nav.primary open` → `view opened` → `view prepared` → `port attached` → **`page initialized`（视图 HTML 在 plugin-sandbox 渲染成功）**；window.zcode 桥接实证——页面 `readResource(location.href)` 请求经桥接抵达宿主 `extension-views.viewRequest`，返回 `ProtocolError: unknown view resource`（桥接通；沙箱 URL 非注册资源属预期边界）。

### 5.3 对计划的判定（修订，覆盖首轮）
- **V1 判定 = 成功且全项收官（重启终验通过）→ Task 8 视图回归扩展形态、Task 9 数据服务回归扩展 main.js 形态**；Gen UI 兜底保留为 §七 降级路径（API 版本不兼容时降级不崩溃）。
- **Task 8 渲染定案**：视图用 entry 形态（plugin-sandbox 渲染实证）；取数走 **server factory + 注册资源**（callTool/readResource 仅限注册 URI——探针 readResource 沙箱 URL 返回 unknown view resource，沙箱页面 URL 不可直接作资源读）。
- 探针使命完成后的卸载步骤不变（交接文档 §3.4）。

## 六、V6 额度接口调研表（2026-11-22 调研完成回填）

> 证据等级：A1=官方文档原文｜A2=官方客户端/官方 CLI 源码｜B=官方接口实测样例｜C=社区开源工具源码。完整报告与 Sources 见会话记录；此处为实现决策所需的最小集合。Qwen 按用户 2026-11-21 拍板**移出额度查询范围**（不调研、规则表不含）。

| 厂商 | 端点 | 鉴权 | 响应要点 | 窗口与重置 | 证据 |
|---|---|---|---|---|---|
| 智谱 BigModel 站 | `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit` | `Authorization: <apiKey>`（**无 Bearer**；团队套餐加 `?type=2` + `Bigmodel-Organization/Project` 头） | `data.limits[]`：`type`/`unit`/`usage`/`remaining`/`percentage`/`nextResetTime`；`data.level` 档位。取数：5h=`TOKENS_LIMIT&unit===3&number===5`，周=`TOKENS_LIMIT&unit===6`；月度 MCP 额度=`TIME_LIMIT&unit===5`（非套餐积分，不展示） | 5h=滚动（官方文档"动态刷新"）；**周=订阅日起 7 天周期，非固定周一**；重置卡会即时改变重置时间——`nextResetTime`（毫秒）为唯一权威 | A2（zcode 自带 `BigModelUsageQuotaProvider`，asar 验证）+ C |
| 智谱 Z.ai 站 | `GET https://api.z.ai/api/monitor/usage/quota/limit` | `Authorization: Bearer <token>`（官方客户端对 zai family 加 Bearer） | 同上 | 同上 | A2 |
| Kimi For Coding | `GET https://api.kimi.com/coding/v1/usages`（国际站 `api.kimi.ai`） | `Authorization: Bearer <sk-kimi-…>` + `Accept: application/json` | 新代际 `usages` map：`limit_5h`/`limit_7d`(老套餐)/`limit_month_code`/`limit_month_total`，各 `{used_ratio 0~1, reset_time ISO}`；旧代际 `usage{limit,used,resetTime}` + `limits[{window{duration,timeUnit}, detail{limit,used/remaining,resetTime}}]`；**计数全是字符串** | 5h=滚动；月=`limit_month_code`；官方已取消新会员周限制（老套餐多返回 `limit_7d`，忽略即可）；重置时间接口返回 | A2（官方 kimi-code CLI zod schema）+ B |
| OpenCode Go/Zen | `GET https://opencode.ai/zen/go/v1/usage` | `Authorization: Bearer <apiKey 或 OAuth>`（社区实测纯 API Key 可不带 org 头） | `usage.rolling/weekly/monthly` 各 `{status:"ok"\|"rate-limited", percent, resetsAt}`；**只有百分比无绝对分母**；403=workspace 未订阅 Go | rolling=5h、weekly=周、monthly=月——与锁定三窗口逐一对应；`resetsAt` 接口返回 | A2（官方 opencode `usage-limits.ts`）+ C |

### 对 Plan 2 实现的修正性影响（覆盖计划中的日历对齐假设）

1. **重置时间一律取接口返回**（`nextResetTime`/`reset_time`/`resetsAt`），**不做本地推算**：智谱周窗口是订阅日锚定的 7 天周期（且重置卡会即时改变它）、Kimi 月窗口疑似订阅日锚定、OpenCode 未文档化——计划 Task 5 的"weekly=本周一 00:00 本地/monthly=dom 对齐"假设被调研推翻。
2. **窗口规则表（window-rules.json）初值定稿**：智谱=`rolling-5h + weekly`（source: official-api）；Kimi=`rolling-5h + monthly`（official-api）；OpenCode=`rolling-5h + weekly + monthly`（official-api）；Qwen 不含。**windowBounds 仅作分子聚合的本地近似与 API 不可达时的兜底**：5h=[now-5h,now]；周兜底=[now-7d,now]（trailing 7 天，界面注明"以官方重置时间为准"）；月兜底=[now-30d,now]。
3. **分母口径**：智谱给绝对值+百分比；Kimi 新代际与 OpenCode 只给百分比/比率 → **Kimi/OpenCode 绝对分母未证实 → 用户配置兜底**（界面直接展示官方百分比 + 用户配置的绝对限额）。
4. **解析层防御点**：Kimi 两代际响应并存（先读 `usages` map，缺字段回退 `usage/limits`，计数为字符串）；OpenCode 403/404 = "未订阅/端点不可用"走兜底；智谱团队套餐 `?type=2`+组织头（个人套餐不发送）。
5. Task 6 `fetchLimit` 路由表按上表端点/鉴权实现；`nextResetMs` 一并取回供额度卡展示重置时间。

