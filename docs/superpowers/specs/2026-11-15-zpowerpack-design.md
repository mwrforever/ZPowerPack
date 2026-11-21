# ZPowerPack 设计文档：zcode 存储迁移 + 用量看板

日期：2026-11-15（2026-11-21 修订：备份可配置/更新兼容性/套餐额度窗口）
状态：待用户审批（builder check 已完成，问题均已闭环）

## 一、意图与背景

为 ZCode Desktop（Electron 应用，Agent 运行时 `zcode.cjs`）做一个插件 **ZPowerPack**，解决两件事：

1. **存储迁移**：`~/.zcode/cli` 下的数据目录（核心是 `rollout/`，已 21GB、182 个 JSONL 文件）占用 C 盘，需要映射到用户可配置的磁盘位置。
2. **用量看板**：在 ZCode Desktop 内**原生内嵌**一个数据看板，展示 token/s 实时速率（单位 token 每秒）及一批 zcode 未覆盖的统计。

用户明确要求：看板必须是桌面端原生组合，不接受"另开浏览器"；统计指标要避开 zcode 内置用量页已有的内容。

## 二、目标 / 非目标 / 反目标

### 目标
- G1 迁移向导：安全地把整个 cli 数据目录迁到用户指定磁盘，可校验、可回滚。
- G2 看板 v1 指标（用户已选定）：
  1. 实时 token/s（滑动窗口，主会话 / subagent 分列）
  2. 模型吞吐对比（各 model_id 的 tps P50/P95 + 平均延迟）
  3. TTFT 首字延迟分布（官方 `time_to_first_token_ms` 字段，免费获得）
  4. 上下文长度 → 速率关系（input_tokens 分桶 vs tps）
  5. 按项目/工作区消耗统计（session 表 directory 关联）
  6. 工具调用统计（tool_usage：频次、耗时占比）
  7. Provider 稳定性对比（按 provider_id 的 error 率 / retry 率）
  8. 时段热力图（小时 × 星期 token 消耗）
- G3 看板以扩展视图（extension view）形式内嵌桌面端；若扩展宿主被 feature gate 门控，降级为 Gen UI 片段内联渲染。
- G4 **套餐额度窗口查询**（2026-11-21 定稿）：按 provider 实例（自动发现，不硬编码）展示各窗口用量，**窗口组合以用户拍板为准：智谱=5小时+周、Kimi=5小时+月、OpenCode=5小时+周+月；Qwen 移出额度范围**。分子取本地 model_usage 聚合，分母优先官方 usage 接口、用户配置兜底。保底覆盖三家：智谱（bigmodel/zai）、Kimi（kimi-code-*）、OpenCode（opencode-go/zen）。
- G5 **迁移轨迹可追溯且可恢复**（2026-11-22 简化）：无大数据备份；manifest 清单（含 config 原值快照、校验和、时间戳）与日志的位置为插件配置项（任意磁盘路径），提供按 manifest 的恢复能力。

### 非目标（v1 不做）
- 不解析 rollout JSONL 做统计（官方 db.sqlite 已是完备遥测索引，见证据 E1）。
- 不做成本估算、超限主动告警（额度**查询展示**在 G4 范围内，但阈值通知类告警排后续）、压缩事件统计、并发热度、延迟分布直方图（用户未选，排后续版本）。
- 不做流式逐 token 速率（数据源不存在：model_usage 行在请求**完成时**落库，无 running 中间态；滑动窗口方案已获认可）。
- 不做数据清理/老化删除（rollout 21GB 的清理是另一个话题）。
- 不支持 macOS/Linux（用户环境为 Windows 10/11；迁移逻辑用 robocopy/junction 等 Windows 机制）。

### 反目标（出现即失败）
- 迁移后 zcode 启动异常、丢会话历史、丢插件。
- 看板轮询拖慢 zcode 主进程（只读连接必须 WAL 模式、低频轮询）。
- 为凑指标展示而伪造数据（所有指标必须可追溯到 db 字段）。

## 三、已验证的关键事实（证据，builder 不必重查）

- **E1 官方遥测库**：`~/.zcode/cli/db/db.sqlite`（WAL 模式，含 -shm/-wal）内含：
  - `model_usage`（66,413 行，请求级）：列包括 `logical_request_id, attempt_index, session_id, turn_id, trace_id, assistant_message_id, parent_user_message_id, query_source, provider_id, model_id, variant, agent, mode, task_type, status, started_at, first_token_at, completed_at, duration_ms, time_to_first_token_ms, finish_reason, tool_call_count, input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, provider_total_tokens, computed_total_tokens, retry_count, retryable, cancelled_by_user, context_exceeded, error_type, error_code, error_message, raw_usage_json, provider_metadata_json`。`started_at` 等为 epoch 毫秒。status 取值：completed / error / cancelled（无 running，完成时落库）。query_source 分布：main_turn 16,293 / subagent 50,046 / session_title 86。
  - `turn_usage`（2,527 行，轮级）：含 `model_request_count, model_retry_count, tool_call_count, tool_error_count, time_to_first_token_ms` 等。
  - `tool_usage`（82,763 行，工具级）：`tool_name, side_effect_scope, read_only, destructive, approval_status, status, started_at, first_output_at, completed_at, duration_ms, time_to_first_output_ms, exit_code, output_bytes`。
  - `session`（1,404 行）：含 `directory, path, title, project_id, parent_id, time_created, time_updated` —— 按项目统计的关联表。
- **E2 存储重定向机制**（zcode.cjs 源码验证）：
  - 配置项 `storage.dir`（默认 `~/.zcode`），经 `gS()` 规整为 cli 根（basename 非 "cli" 则追加）；`rollout/exec/artifacts/agents/sessions/memories/plugins` 均由 cliStorageRoot 派生。
  - 配置项 `storage.sessionDbPath`（默认字面 `~/.zcode/cli/db/db.sqlite`，**不跟随 storage.dir 派生，必须显式一起改**）。
  - 环境变量等价物：`ZCODE_STORAGE_DIR` → storage.dir；`ZCODE_SESSION_DB_PATH`/`ZCODE_SESSION_DB` → storage.sessionDbPath。
  - **config.json 固定于 `~/.zcode/cli/config.json`，不跟随 storage.dir**（已验证解析代码 `join(homedir(), ".zcode", "cli", "config.json")`）——迁移向导改配置无鸡生蛋问题。项目级 config 可覆盖 storage.dir（本插件不用该能力）。
- **E3 扩展宿主**（用户已安装的 app.asar 提取验证）：
  - 扩展 manifest schema：`{ engines: { zcode: "^x.y.z" }, main: <插件根内路径>, activationEvents: ["onAvailable" | "onCommand:<id>" | "onView:<id>"], grants: [...], protocols: {...}, contributes: { commands: [{id,title}], views: [{id,title,icon?,scope?}] } }`。
  - 扩展 API：`commands.register(id, fn)`、`views.register({id, entry, onDidOpen})`（entry 为字符串资源路径或函数）、`slots.update(id, patch)`；未在 manifest 声明的 id 抛 "not-declared"。
  - 视图内容经 `resources/read` 提供（读 entry 文件），由 **plugin-sandbox** 渲染：预置 d3 7.9.0、lucide 图标、floating-ui、visualize.html/css 脚手架。沙箱 provenance：`contentKind: "gen-ui" | "extension"`；extension 要求 pluginId 且无 sessionId。
  - 兜底机制：Gen UI —— 会话目录 HTML 片段在桌面端内联渲染（`contentKind:"gen-ui"`，绑定 sessionId）。
- **E4 运行时**：系统 Node v24.22.0（内置 `node:sqlite` 可用）；桌面端自带 node-runtime 目录。当前插件生态 manifest（`.zcode-plugin/plugin.json`）支持 skills/commands/hooks/mcpServers 组件；扩展型 manifest（E3）是否与 plugin.json 合并声明、还是独立 `.app.json` 类文件，**实施第一步必须验证**（见 §六 V1）。
- **E5 数据体量**：rollout 21GB/182 文件（单文件最大 1.2GB）；db.sqlite 仅数十 MB 级；66k 行查询毫秒级，无需物化缓存。
- **E6 provider 定义体系**（2026-11-21 验证）：
  - 用户实例：`~/.zcode/v2/provider_config.json`（`providerOrder` + `providerRules[]`：providerId/templateId/providerName/access.apiKey 引用/modelOrder）。当前实例：bigmodel-api、bigmodel-api-2、kimi-code-cn、opencode-go-messages×2。
  - 模板目录：`~/.zcode/v2/runtime/provider/windows-x86_64/<版本>/endpoint-<hash>/zcode-builtin.json`，CDN 下发自动刷新（34 个模板，含 `qwen-coding-plan-cn`、`kimi-code-cn/intl`、`opencode-go/zen` 系列、`bigmodel-api` 等；字段：templateId/名称映射/access.apiKeyManagementUrl/api.type/api.baseUrl/builtinModelIds）。
  - **模板与响应头均无限额元数据**：扫描真实响应头（bigmodel/opencode 系）无 x-ratelimit/quota 类字段；限额总量必须走官方 usage 接口或用户配置。
  - zcode 对智谱系有内置 entitlement 拉取（startPlanEntitlement/planProductId/entitlementCacheTtlMs），可复用。
- **E7 v2 目录与 config.json**：`~/.zcode/v2/`（provider_config.json、credentials.json、setting.json、tasks-index.sqlite 等）——v2 目录是否跟随 storage.dir 迁移未验证（V5）。

## 四、方案取舍（Approaches）

### 存储迁移
| 方案 | 取舍 | 结果 |
|---|---|---|
| A. 官方 `storage.dir` 整体迁移 | 走官方机制、升级不失效；C 盘 db/artifacts 等也随迁（体量小） | **选定**（用户拍板） |
| B. 仅 rollout 的 Windows Junction | 改动面最小；非官方机制 | 落选 |
| C. 双模式可配置 | 实现成本翻倍 | 落选 |

### 看板形态
| 方案 | 取舍 | 结果 |
|---|---|---|
| A. 本地 Web 服务 + 浏览器 | 实时性好但脱离桌面端 | 用户否决 |
| B. 桌面端原生内嵌（extension view，兜底 Gen UI） | 满足"原生组合"；风险是扩展宿主可能门控 | **选定** |
| C. 命令行输出 | 无实时性 | 落选 |

### 看板数据源
| 方案 | 取舍 | 结果 |
|---|---|---|
| A. 解析 rollout JSONL + 自建增量索引 | 数据最全；但 21GB 解析、自维护索引，成本高 | 落选 |
| B. 只读 db.sqlite 轮询 | 官方索引、字段超集（含 TTFT）、零索引成本；实时性同为"完成时可见" | **选定** |

## 五、设计

### Part 1 存储迁移向导

形态：插件 skill（`/zpowerpack:migrate-storage`）+ 交互式执行。核心 UX（用户拍板）：**先写入配置、提示重启生效、立即重启或稍后自己重启**；配一个自动化的"退出后增量同步"环节保证数据完整。

流程：
1. **前置检查（会话内）**：检测目标磁盘剩余空间 ≥ 当前数据量 × 1.2；展示将要迁移的内容清单与体积（rollout、db、artifacts、exec、agents、sessions、memories、plugins/cache）。
2. **预拷贝（会话内，zcode 运行中可安全进行）**：
   - rollout/exec/artifacts/agents/sessions/memories/plugins：robocopy 复制，不删源（`/COPY:DAT /DCOPY:T /R:2 /W:1`），完成后大小校验 + 抽样哈希。
   - db：**node:sqlite 在线备份 API**（`backup()`）做一致性快照到新位置——不依赖"zcode 已退出"，规避 WAL 活跃写时的文件复制不一致。
3. **配置写入（会话内）**：在**备份根目录**（用户可配置，默认 `<storage.dir 新位置>/zpowerpack-backup/`，允许改为任意磁盘路径——见 G5）写入 manifest（记录 `storage.dir`/`storage.sessionDbPath` 改动前后的原值、时间戳、阶段日志）——**不复制整个 config.json、不存在大数据备份**；随后写入 `storage.dir` 与 `storage.sessionDbPath`（指向新位置下的对应路径）。写入后立即提示重启生效；同时开始监测旧位置是否仍在增长（若增长异常加速，warn 提示疑似热加载已生效，建议尽快重启——见 V2）。
4. **重启衔接（脱机 waiter，自动）**：挂一个脱离进程等待 ZCode.exe 完全退出，随后执行**增量同步**（rollout 用 robocopy 增量补齐预拷贝后的变化；db 重跑在线备份覆盖快照——量级秒~分钟）。两种路径：
   - **立即重启**：脚本接管——等退出 → 增量同步 → 自动拉起 ZCode.exe。体感"点一下，几十秒后回到新存储"。
   - **稍后自己重启**：waiter 完成增量同步后弹 Windows 通知；用户之后任意时刻重启。残余风险：同步完成前几秒内重启会缺尾巴——验收清单标注同步完成时间戳，可补跑。
   - 每个阶段写 `manifest.json` 追加记录（时间戳、阶段、源/目标路径、文件清单、大小、SHA256 校验），manifest 是**恢复能力的依据**：提供 `/zpowerpack:restore-storage` 按最新 manifest 反向恢复（还原 config 备份、校正目录），并校验恢复后一致性。
5. **首启验收（重开会话）**：输出人工验收清单（会话历史可见、插件加载正常、模型可用、rollout 落在新位置）+ 同步完成时间戳核对。
6. **显式清理**：用户确认验收通过后，执行清理命令删除 C 盘旧数据子目录（双重确认交互）；C 盘空间此时才释放。
7. **回滚**：按 manifest 中记录的 config 原值把 `storage.dir`/`storage.sessionDbPath` 两行改回即回到原状——旧数据全程未被移动/删除（直至第 6 步显式清理）。

边界与风险：
- 配置热加载风险：写配置后若 zcode 立即热加载 storage.dir，新写入会直接落新位置——增量同步收敛后无数据丢失，但列为 V2 验证项，向导做旧位置增长监测并告警。
- plugins/cache 迁移后若加载异常（V2 验证项），回退策略：plugins/cache 用 Junction 指回新位置或保留在 C 盘。
- waiter 脚本全部中文日志，日志与备份同放**备份根目录**下的 `logs/`（位置可配置，见 G5）。
- 禁止在未通过校验前执行任何删除；所有删除仅存在于第 6 步显式清理。
- **插件自身配置文件**：`<cliStorageRoot>/zpowerpack/config.json`（解析顺序：环境变量 `ZPOWERPACK_CONFIG` 覆盖 → cliStorageRoot 下默认位置）。保存备份根目录、日志目录、额度分母配置、窗口规则覆盖等；向导迁移数据时把该目录一并带入新位置（配置跟随数据，迁移后无需重配）。

### Part 2 用量看板

**架构**：扩展型插件。

```
ZPowerPack/
  .zcode-plugin/plugin.json      # 基础 manifest（若 E4 验证需合并声明则在此扩展）
  extension/main.js              # 扩展入口：views.register、数据服务
  extension/view/index.html      # 看板视图（plugin-sandbox 渲染，d3 可用）
  skills/migrate-storage/SKILL.md
  scripts/migrate-storage.ps1    # 迁移脚本
```

- **数据层**（extension main，Node 侧）：`node:sqlite` 只读打开 db.sqlite（`mode=ro`）。db 路径解析顺序：config.json 的 `storage.sessionDbPath` → 默认 `~/.zcode/cli/db/db.sqlite`（与迁移向导天然衔接，迁移后自动读新位置）。1s 轮询 `model_usage`/`tool_usage` 增量（按 `started_at`/rowid 游标）；结果送达视图的方式待 V1 结论：宿主有推送/RPC 通道则推，否则视图拉取式（定时重取资源/slots 刷新）。
- **展示位置与设计稿**（2026-11-22 定稿，设计稿：`原型/zpowerpack-看板设计稿.html`，已浏览器实机校验）：
  - 位置 A（主选）：桌面端活动栏新增"用量看板"入口 → app-scope 宽视图区（约 1200px 自适应），整幅看板在此渲染；能力探测失败自动落位置 C；
  - 位置 B（速览条，2026-11-21 行为定稿）：会话区顶部常驻条，**默认只展示当前会话选中的厂商**——机制：跟随「最近一次请求的 provider」（model_usage 最新 completed 行，自动切换），用户可在插件配置锁定固定厂商；展示内容 = 该厂商的实时速率 + 其全部窗口的额度微缩条（智谱 2 条 / Kimi 2 条 / OpenCode 3 条），点击直达宽面板对应卡片——**依赖 slots 通道，V1 验证可用才做**；
  - 位置 C（兜底）：会话内 Gen UI 片段，`/zpowerpack:dashboard` 生成，刷新由命令触发；
  - 视觉令牌取自桌面端真实主题（--accent = interactive-orange rgb(238 134 12)），嵌入时优先读宿主主题变量，缺失用设计稿默认值；六色图表系列（--chart-1..6）与语义色（success/warn/danger）分工；
  - 信息架构：额度卡行 → 速率区 → 三组七图（速度：吞吐对比/TTFT；健康：上下文→速率/Provider 稳定性；习惯：时段热力/按项目/工具统计），粘性锚点 + 时间范围切换（仅作用历史图）；
  - 组件交互规范（额度卡单开下钻、窗口条 60%/85% 转色、速率三态徽标 live/held/idle、held 不显示 0、图表悬停十字线 tooltip、模型行点击联动高亮、空态/加载骨架/接口不可用态）——以设计稿 §05 清单为实现与验收依据。

- **视图层**（plugin-sandbox）：原生 HTML+d3。**布局 = 「聚焦主屏」锁定稿**（2026-11-21 用户锁定，方向契约与构图基准：`.impeccable/surfaces/dashboard.md` + `.impeccable/mocks/decision/focus-stage.html`）：
  1. **舞台**（顶部 300px）：实时速率巨字（主/子代理分列）+ 背景 60s 速率历史线渐变穿行 + 「保持上次速度/空闲」徽标——无卡片框，以辉光与留白立层级
  2. **额度水位行**（无边框三组）：智谱[5小时|周] · Kimi[5小时|月] · OpenCode[5小时|周|月]，每窗口=用量条+百分比+重置说明+「偏快留意」提示；Qwen 不出现
  3. **2×3 无边框报表网格**（每卡标题下一句描述）：模型速度对比（典型速度/慢的时候）、首字等待、对话越长会变慢吗（散点+趋势）、时段热力、按项目消耗、谁家更不容易翻车
  4. **迷你常驻条 dock**：仅显示当前会话选中厂商（跟随最近请求 provider，可锁定）+ 速率 + 该厂商全部窗口条
  5. 按模型速率明细行、工具调用统计：收在报表网格卡片的展开/悬浮下钻中，不做独立首屏区

- **额度模块**（G4，2026-11-21 强化）：
  - **实例自动发现**：解析 `~/.zcode/v2/provider_config.json` 枚举 provider 实例（providerId/templateId/providerName/access 类型），templateId 对照 `zcode-builtin.json` 模板（CDN 缓存，防御性解析）得名称/baseUrl；**不硬编码厂商清单**——智谱/Kimi/OpenCode/Qwen 四家为保底适配目标，目录里出现什么就查什么（含未来的独立 qwen 实例 `qwen-coding-plan-cn`）。
  - **窗口规则引擎**：每个 templateId 一组窗口规则 `[{type: rolling-5h | weekly | monthly, 重置边界, 分母来源}]`。规则以**数据表**内置，**窗口组合以用户拍板为准（2026-11-21）**：智谱 = 5 小时滚动 + 周额度；Kimi = 5 小时滚动 + 月额度；OpenCode = 5 小时滚动 + 周额度 + 月额度（三窗口）；**Qwen 移出额度查询范围**（官方接口放弃，仅保留通用统计中的模型维度）。周/月窗口按**订阅周期对齐**（各厂商的重置日规则入表）；随厂商官方变化更新规则表，用户可在插件配置中覆盖任意规则。
  - **分子**：db.sqlite `model_usage` 按 (provider 实例 × model_id × 窗口) 聚合（5h 滑动窗口按 `started_at`；周/月按重置边界），token 与请求数两个口径。
  - **分母（官方接口优先 + 用户配置兜底，用户拍板）**：智谱系复用 zcode 内置 entitlement 数据或同源接口；Kimi/OpenCode/Qwen 实施时调研官方 usage 接口（V6）；任一厂商接口不可得 → 该厂商卡片显示本地用量并提示"可配置限额分母"，用户在插件配置里填入后显示百分比与剩余。apiKey 仅从 provider_config.json 引用（不落日志、不进 manifest）。
  - **模型维度下钻**：卡片可展开按 model_id 拆分（如 opencode 套餐内的 qwen3.8-max / minimax / claude 消耗占比）。
- **指标口径与界面文案**（统一约定，写死在代码注释里；2026-11-21 强化：**界面禁止出现 P50/P95/P99、分位数等生产监控术语**，每个指标必须配一句"这个数字在说什么"的平实描述，否则用户不知道指标是干什么的）：
  - 术语界面映射（代码内部仍用标准名，渲染到界面时替换）：P50 →「典型速度（一半请求快于它）」；P95 →「慢的时候大约这个数」；TTFT →「首字等待：按下发送到蹦出第一个字的时间」；tps →「每秒生成的 token 数」；重试率 →「失败后自动重试的比例」；滑动窗口 →「最近 60 秒」；held →「保持上次速度」；idle →「空闲」；
  - 每张报表卡带一行描述（description），回答"这个指标帮我判断什么"（如吞吐对比 →「哪家模型平时吐字快？慢起来会多慢？」；上下文→速率 →「对话越长模型会变慢吗？」）；
  - 单请求 tps = `output_tokens ÷ (completed_at − first_token_at)`——分母剔除 TTFT/prefill 段，避免系统性低估；`first_token_at` 缺失时兜底 `duration_ms`；reasoning_tokens 计入产出；仅取 `status='completed'` 且生成时长 >0；
  - 单请求 tps = `output_tokens ÷ (completed_at − first_token_at)`——分母剔除 TTFT/prefill 段，避免系统性低估；`first_token_at` 缺失时兜底 `duration_ms`；reasoning_tokens 计入产出；仅取 `status='completed'` 且生成时长 >0；
  - 顶栏实时速率双口径：主数字=生成速度（最近 60s 完成请求 Σoutput ÷ Σ生成时长，时长加权）；副数字=窗口吞吐（Σoutput ÷ 60s，含空闲）；刷新间隔 1s；主会话/subagent 按 query_source 分列，另出按 model_id 明细行；
  - **平滑与保持**（2026-11-22 强化）：① 窗口时长可配置（默认 60s），时长加权本身即平滑；② 主数字叠加 EMA 二次平滑（默认 α=0.3，可配置），抑制单条异常请求（超短请求把 tps 拉飞）造成的跳动；③ **保持逻辑**：窗口内无新完成请求、或窗口内 Σ生成时长 < 2s（样本不足，典型为长 TTFT/在飞期）→ 直接展示上一波速率并标注数据时刻，**不展示 0**；持续无新数据超过保持上限（默认 5 分钟）→ 转灰色"空闲"态；④ `status='error'` 的行不进速率（output=0 的错误请求不拉低速率），错误以事件指示呈现；TTFT 阶段因分母已剔除、且不产生完成行，天然不拉低速率；
  - 吞吐对比仅统计窗口/时间范围内的 completed 请求，按 model_id 分组取典型值与慢时值（内部 P50/P95，界面用上方映射文案）；
  - Provider 稳定性 = error 行数 / 总行数（按 provider_id），retry = `retry_count>0` 行占比；
  - 按项目 = model_usage.session_id → session.directory（parent_id 链上溯到根会话，subagent 归属其父会话项目）。
- **兜底**：若扩展宿主验证不可用（V1 失败），看板改为 Gen UI 片段：数据层照旧（以 skill/command 形式运行 Node 轮询进程），视图输出 HTML 到会话目录内联渲染，刷新由用户点击/命令触发。

### 合规约束（来自全局规范）
- 注释/日志/文档全中文；变量名英文；UTF-8 无 BOM；LF 行尾。
- 核心路径（迁移的配置写入与数据校验、看板数据层查询）单测 100% 覆盖；脚本类 ≥80%。
- 迁移核心脚本用 Node（系统 node v24 已具备，逻辑可纳入 node:test 覆盖；robocopy/Windows 通知以子进程调用），dry-run 模式必须存在；所有破坏性操作（改名/删除）仅在校验通过后执行且默认可回滚。

## 六、留给实施者验证的事项（实施第一天）

- **V1**：扩展型 manifest 的落地形态——`.zcode-plugin/plugin.json` 是否接受 `main/contributes` 字段，或需要独立文件；当前构建中扩展宿主是否被 feature gate（找开关或实验 flag）。**同时确认扩展 main ↔ plugin-sandbox 视图之间是否存在推送/RPC 消息通道**（若仅有 views.register/resources-read/slots.update 这类声明式面，视图侧改为拉取式：定时重取可刷新资源或 slots 刷新）、**是否存在运行时事件订阅通道**（若可订阅请求/usage 事件，实时 token/s 从"完成时滑动窗口"升级为真·流式速率）；并确认 manifest `grants` 词汇表中读文件/执行脚本所需的声明。任一失败则走 Gen UI 兜底。
- **V2**：写配置后 zcode 是否热加载 storage.dir（写后监测旧位置增长）；storage.dir 迁移后 plugins/cache 与 memories 的实际行为；db 迁移后历史会话完整性。
- **V3**：`node:sqlite` 在扩展宿主内是否可用（若宿主不带内置 sqlite 绑定，改用只读解析或自带 sqlite3 依赖——需符合"不要求用户装工具链"约束，依赖随插件分发）；`backup()` 在主进程持有写锁时的可用性。
- **V4**：db.sqlite 被主进程持有写锁时的只读并发表现（WAL 应无碍，实测确认）。
- **V5**：`~/.zcode/v2/` 目录（provider_config.json、credentials.json）是否跟随 storage.dir 迁移——决定额度模块读取 provider 配置的路径解析逻辑。
- **V6**：各厂商官方 usage/额度接口调研（web 调研 + 实测）：智谱 coding plan 用量接口（与 zcode 内置 entitlement 同源性）、Kimi For Coding（api.kimi.com/coding/v1）额度端点、OpenCode Zen（opencode.ai）usage 端点、Qwen coding plan（coding.dashscope.aliyuncs.com）额度端点；产出各模板的窗口规则表（5h/周/月结构、重置边界）初版。

## 七、版本兼容策略（回答"zcode 更新后还会生效吗"）

- **存储迁移：基本免疫更新。** 写入的是官方配置键（`storage.dir`/`storage.sessionDbPath`，E2 源码验证），数据搬迁是文件系统操作，与 zcode 版本无关。zcode 升级不会撤销这两项配置。
- **看板：大概率生效，但存在兼容窗口期，策略是"降级不崩溃"。** 三个依赖各配防御：
  1. db.sqlite 表结构会演进（schema_migration 已 25 版）→ 启动时探测表/列存在性，查询按列名取，缺列降级隐藏对应指标；
  2. 扩展宿主 API 无稳定性承诺 → manifest `engines.zcode` 锁定验证过的版本范围；启动时能力探测（views/消息通道），不满足则自动落 Gen UI 兜底形态；
  3. provider 模板目录由 CDN 动态下发 → 防御性解析（字段缺失不致命，解析失败回退用户配置）。
- 插件本体安装在 plugins/cache（跟随 storage.dir），zcode 更新应用本体不会移除插件；zcode 大版本升级后若看板异常，按 §六 V 清单重验并跟随适配。

## 八、给 builder 的裁量范围

- 视图视觉细节（布局微调、配色跟随桌面主题变量）。
- 轮询与游标的具体实现（rowid vs started_at）。
- 迁移脚本的错误码与日志格式。
- d3 图表的具体封装方式。
- 测试的具体框架选型（Node 内置 test runner 优先）。
