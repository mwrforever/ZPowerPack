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
// .zcode-plugin/plugin.json —— 基础字段与扩展声明同文件，扩展部分是 extension 子对象
{
  "name": "...", "version": "...", "description": "...", "skills": "skills",
  "extension": {
    "engines": { "zcode": "^3.19.1" },          // 必填，^x.y.z 或 x.y.z（isExtensionEngineCompatible：^锁主版本，x.y.z 精确）
    "main": "extension/main.js",                 // 可选；必须插件根内相对路径（不得绝对/含 ..）
    "activationEvents": ["onAvailable"],         // 可选；onCommand:<id>/onView:<id> 会由宿主按 declares 自动补全（resolveActivationEvents）
    "grants": ["sessions.read"],                 // 可选；词汇表见下
    "contributes": { "commands": [{"id","title"}], "views": [{"id","title","icon?","scope?"}] },
    "protocols": {...}                           // 可选
  },
  "slots": [ { "id","order?","icon?","title?","target":{ "kind":"view|command|surface|tool","id" }, "slot":"nav.primary|..." } ]
}
```

- 视图条目 schema（`wL`）：`{id: /^[a-z0-9._-]{1,64}$/, title: string|国际化表, icon?: /^[a-z0-9-]{1,48}$/ 名称（lucide）, scope?: 仅 "app"}`
- 激活事件正则：`^(onAvailable|onCommand:<id>|onView:<id>)$`；`onView/onCommand` 引用的 id 必须已声明
- 校验两级（`validateExtensionManifest`）：先非严格探测 `engines.zcode` → 版本兼容检查（不满足报 incompatible）→ strictObject 全量校验 extension 子对象
- `engines.zcode` 兼容规则（`CVe`）：`^x.y.z` → 主版本必须相同（0.x 还须次版本相同）；`x.y.z` → 精确匹配
- 激活：宿主 `import(<main>)` → 命名或默认导出含 `activate(ctx)` → `S.activate(ctx)`，**10 秒激活超时**

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
5. **版本兼容（§七）**：manifest `engines.zcode` 锁 `^3.19.1`（主版本 3 内兼容）

## 五、探针装机记录（动态实测，待回填）

- 探针源：SDD 工作区 `v1-probe/`（git 忽略，不入库；验证后整目录删除 + 用户侧卸载插件/移除市场）
- 探针覆盖：manifest 混装校验、onAvailable 即时激活、nav.primary slot 渲染、views.register(entry+onDidOpen)、slots.update、ctx API 面、node:sqlite 导入、db 只读聚合、视图 window.zcode 探测、fetch 相对资源
- 实测结果：待回填

## 六、V6 额度接口调研表（回填区）

- Qwen：按用户 2026-11-21 拍板**移出额度查询范围**（官方接口放弃，规则表不含 Qwen），不再调研分母接口
- 智谱 / Kimi / OpenCode：调研进行中，完成后回填端点/鉴权/响应字段/窗口重置边界/证据等级
