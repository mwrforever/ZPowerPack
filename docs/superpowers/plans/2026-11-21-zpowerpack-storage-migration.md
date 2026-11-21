# ZPowerPack 存储迁移向导 实施计划（Plan 1/2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `~/.zcode/cli` 数据目录安全迁移到用户指定磁盘：会话内预拷贝+写配置、重启后自动增量同步、manifest 可恢复、显式清理。

**Architecture:** Node 编排脚本（robocopy/通知为子进程）+ 会话内 SKILL 交互。全程不改名不移动旧数据；回滚=按 manifest 内嵌的 config 原值回写两行。

**Tech Stack:** Node ≥22.5（`node:sqlite`、`node:test`）、robocopy、零 npm 依赖。

**Spec:** `docs/superpowers/specs/2026-11-15-zpowerpack-design.md`（Part 1 / G1 / G5 / V2 / V5）

## Global Constraints

- 注释/日志/用户提示全中文；变量名英文；UTF-8 无 BOM；LF 行尾；文件末尾一个换行
- 零 npm 运行时依赖；测试用 `node:test`；哈希用 `node:crypto`
- 敏感值（apiKey、token）禁止出现在日志/manifest/任何输出中
- dry-run 模式必须存在且不产生任何写动作
- 破坏性操作仅存在"显式清理"一步，需双重确认
- 核心路径（config 写入、校验、manifest）单测 100%；每任务一提交（git commit）
- 平台：Windows（robocopy/tasklist/powershell 子进程）

## Review Focus

1. robocopy 退出码 0-7 是成功、≥8 才失败——按普通返回码处理会把成功当失败 → Task 4 测试钉死
2. config.json 含大量未知键（mcp/plugins…），写入 storage 两键不得丢失任何键 → Task 6 测试钉死
3. 预拷贝时源文件被 zcode 持续追加——必须靠退出后增量同步收敛，预拷贝校验失败不算致命 → Task 4/8 测试钉死
4. api key 可能出现在 provider_config 附近路径的读取中——任何输出/manifest 断言不含 `sk-`/密钥样式 → Task 3 测试钉死
5. waiter 在用户"秒重启"时与增量同步竞争——验收清单必须标注同步完成时间戳，未完成时提示先勿启动 → Task 8 输出钉死

---

### Task 1: 插件骨架与 git 初始化

**Files:**
- Create: `.zcode-plugin/plugin.json`、`.gitignore`、`package.json`、`extension/`、`skills/`、`scripts/migrate/`、`tests/` 目录占位

**Interfaces:**
- Produces: 仓库根 `E:\code\plugin\zcode\ZPowerPack`；`package.json` 含 `"test": "node --test tests/"` 与 `"lint": "node scripts/lint.mjs"`（lint 脚本本任务创建：仅检查 UTF-8 无 BOM + LF + 尾随空白）

- [ ] **Step 1: 创建 plugin.json**（name=zpowerpack，version=0.1.0，中文 description，skills/scripts 声明按 plugin-creator 规范；`engines.zcode` 与 `main`/`contributes` 字段留待 Plan 2 Task 1 的 V1 结论，本任务先不含）
- [ ] **Step 2: 创建 package.json / .gitignore / scripts/lint.mjs**（lint 检查所有源文件：无 BOM、无 CRLF、无尾随空白；输出违规清单，违规退出码 1）
- [ ] **Step 3: 验证骨架**：`node -e "JSON.parse(require('fs').readFileSync('.zcode-plugin/plugin.json','utf8'))"` 且 `npm test`（空测试目录）退出码 0 且 `npm run lint` 通过
- [ ] **Step 4: git init + 首次提交** `git init && git add -A && git commit -m "chore: zpowerpack 插件骨架"`

### Task 2: 插件配置模块 config.mjs

**Files:**
- Create: `scripts/migrate/config.mjs`
- Test: `tests/config.test.mjs`

**Interfaces:**
- Produces:
  - `resolveCliStorageRoot(env, homedir): string` —— `env.ZCODE_STORAGE_DIR` 或读 `~/.zcode/cli/config.json` 的 `storage.dir`，规则：basename==='cli' 原样，否则 `join(dir,'cli')`；默认 `join(homedir,'.zcode','cli')`（复现 zcode.cjs 的 `gS()`，源码已验证）
  - `resolveConfigPath(env, homedir): string` —— `env.ZPOWERPACK_CONFIG` → `<cliStorageRoot>/zpowerpack/config.json`
  - `readPluginConfig(path)`, `writePluginConfig(path, cfg)`（tmp+rename 原子写；键：`backupRoot`/`logDir`/`quota`/`windowRules`，均可空=默认）

- [ ] **Step 1: 写失败测试**：① 传 `storage.dir='D:\zcode-data'` → root=`D:\zcode-data\cli`；传 `D:\already\cli` → 原样；无配置 → `~/.zcode/cli`。② env 覆盖生效。③ writePluginConfig 后重读等值、文件无 BOM、末尾一个换行
- [ ] **Step 2: 运行 `node --test tests/config.test.mjs`** 预期 FAIL（模块不存在）
- [ ] **Step 3: 实现 config.mjs**（读 zcode config.json 时 try/catch 缺文件按默认处理）
- [ ] **Step 4: 运行测试** 预期 PASS；`npm run lint` 通过
- [ ] **Step 5: Commit** `feat: 插件配置模块（cliStorageRoot 解析/原子写）`

### Task 3: 迁移 manifest 模块 manifest.mjs

**Files:**
- Create: `scripts/migrate/manifest.mjs`
- Test: `tests/manifest.test.mjs`

**Interfaces:**
- Produces:
  - `initManifest(backupRoot, {targetRoot}): string`（返回 manifest 路径，文件含 `startedAt/targetRoot/phases[]/configSnapshot`）
  - `appendPhase(manifestPath, {phase, detail}): void`（追加且 fsync）
  - `snapshotConfigValues(manifestPath, original): void`（仅白名单键 `storage.dir`/`storage.sessionDbPath` 原值）
  - `readManifest(manifestPath): object`

- [ ] **Step 1: 写失败测试**：① init→append×2→read，phases 顺序与内容正确；② snapshot 后 manifest JSON 的键集合 === 白名单（喂含 `apiKey:'sk-xxx'` 的对象，断言输出不含该键与 `sk-` 子串）；③ 文件为 UTF-8 无 BOM
- [ ] **Step 2: 运行测试** 预期 FAIL
- [ ] **Step 3: 实现 manifest.mjs**
- [ ] **Step 4: 运行测试** PASS + lint
- [ ] **Step 5: Commit** `feat: 迁移 manifest（阶段轨迹/config 原值快照，不含敏感键）`

### Task 4: 拷贝引擎 copy.mjs（robocopy 封装 + 校验 + dry-run）

**Files:**
- Create: `scripts/migrate/copy.mjs`
- Test: `tests/copy.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `ROBOCOPY_OK_MAX = 7`
  - `copyTree(src, dest, {runner=spawn robocopy, dryRun}): Promise<{files,bytes}>` —— 参数 `/E /COPY:DAT /DCOPY:T /R:2 /W:1 /NFL /NDL /NJH`；退出码 ≤7 成功；dryRun 不 spawn，返回将要执行的 argv
  - `verifyTree(src, dest, {hashSampleRatio=0.05}): Promise<{ok, checked, mismatches[]}>` —— 大小全量比对 + 按 ratio 抽样 SHA256
  - `checkDiskSpace(path): Promise<{freeBytes}>`（`fs.statfs`）

- [ ] **Step 1: 写失败测试**：① 临时目录造 20 个文件（含中文文件名、子目录、空文件）→ copyTree 真实 robocopy → verifyTree ok=true；② 改目标一文件内容 → verifyTree ok=false 且 mismatches 含该文件；③ stub runner 返回码 8 → copyTree 抛中文错误"robocopy 失败(退出码 8)"；④ dryRun 返回的 argv 含 `/COPY:DAT` 且无文件变更（前后目录快照一致）；⑤ 中文文件名在 mismatches 中无乱码
- [ ] **Step 2: 运行测试** 预期 FAIL
- [ ] **Step 3: 实现 copy.mjs**（robocopy 路径列表用 `--out` 临时文件解析以计数）
- [ ] **Step 4: 运行测试** PASS + lint
- [ ] **Step 5: Commit** `feat: robocopy 拷贝引擎（退出码语义/校验/dry-run）`

### Task 5: db 在线备份 dbbackup.mjs

**Files:**
- Create: `scripts/migrate/dbbackup.mjs`
- Test: `tests/dbbackup.test.mjs`

**Interfaces:**
- Produces: `backupDb(dbPath, destPath): Promise<{pages}>` —— `node:sqlite` `DatabaseSync` 打开源（readonly）→ `backup(destPath)`；目标目录自动创建

- [ ] **Step 1: 写失败测试**：① 用 node:sqlite 造含 50 行的源库 → backupDb → 打开目标库行数=50 且源库可继续写（模拟在线）；② 源不存在 → 中文错误"源数据库不存在"
- [ ] **Step 2: 运行** FAIL → **实现** → **PASS** + lint
- [ ] **Step 3: Commit** `feat: sqlite 在线备份（规避 WAL 活跃写拷贝不一致）`

### Task 6: zcode 配置写入器 zcode-config.mjs

**Files:**
- Create: `scripts/migrate/zcode-config.mjs`
- Test: `tests/zcode-config.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `readZcodeConfig(configPath): object`（纯 JSON；zcode config.json 实测为标准 JSON）
  - `applyStoragePaths(configPath, newCliRoot): {oldValues, newValues}` —— 设 `storage.dir=newCliRoot 父目录`、`storage.sessionDbPath=join(newCliRoot,'db','db.sqlite')`；写回 2 空格缩进、末尾换行；**不得增删其它键**
  - `restoreStoragePaths(configPath, oldValues)` —— oldValues 键为 null 时删除该键，否则还原

- [ ] **Step 1: 写失败测试**：① 构造含 mcp/plugins/enabledPlugins 等键的 config → applyStoragePaths → 断言原键全部保留、storage 两键正确；② restore 后 config 与最初深比较相等（原 storage 为 null/不存在 → 还原后无 storage 键）；③ 末尾恰一个换行
- [ ] **Step 2: 运行** FAIL → **实现** → **PASS** + lint
- [ ] **Step 3: Commit** `feat: zcode 配置写入器（保留未知键/可回写）`

### Task 7: waiter.mjs（退出等待/增量同步/通知/拉起）

**Files:**
- Create: `scripts/migrate/waiter.mjs`
- Test: `tests/waiter.test.mjs`

**Interfaces:**
- Consumes: Task 4 `copyTree`、Task 5 `backupDb`
- Produces:
  - `waitForExit({probe=tasklist 探测, processName='ZCode.exe', pollMs=2000, timeoutMs}): Promise<void>`
  - `runIncrementalSync(job): Promise<void>`（job 含 srcRoot/destRoot/dbPath/destDbPath：copyTree 重跑覆盖 + backupDb 覆盖 + verifyTree）
  - `notifyWindows(title, body): Promise<void>`（powershell `Windows.UI.Notifications` Toast，无第三方依赖）
  - `launchZCode(exePath): void`（`spawn(detached:true).unref()`）

- [ ] **Step 1: 写失败测试**：① 注入 fake probe（前 2 次 true 后 false）→ waitForExit 完成；probe 永真 → timeoutMs 抛中文超时错误；② runIncrementalSync 对修改过的源文件重跑后目标一致；③ notifyWindows/launchZCode 以 stub runner 断言命令行含正确参数
- [ ] **Step 2: 运行** FAIL → **实现** → **PASS** + lint
- [ ] **Step 3: Commit** `feat: waiter（退出等待/增量同步/Toast/自动拉起）`

### Task 8: 迁移编排 main.mjs

**Files:**
- Create: `scripts/migrate/main.mjs`
- Test: `tests/main.test.mjs`

**Interfaces:**
- Consumes: Task 2-7 全部导出
- Produces: CLI `node scripts/migrate/main.mjs --target <目录> [--dry-run] [--skip-waiter] [--keep-old]` 与 `node scripts/migrate/main.mjs cleanup --manifest <path>`（按 manifest 反查源端旧数据子目录，脚本内二次确认后删除；仅删 manifest 记录过的子目录）；迁移范围含 v2 目录与否按 Plan 2 Task 1 的 V5 结论定（默认不含，v2 留 C 盘）；阶段输出中文日志到 `logDir/migrate-<ts>.log`

- [ ] **Step 1: 写失败测试**（全部在临时目录 + 假 zcode config + 小型假数据树 + stub waiter）：① `--dry-run`：manifest 不创建、zcode config 未被改、输出含"预拷贝文件清单与体积"；② 真跑（skip-waiter）：顺序断言 manifest phases = 空间检查→预拷贝→校验→写配置，config 两键已写、原值在 snapshot、verify ok；③ 目标空间不足（stub statfs 返回 0）→ 在预拷贝前中止且中文报错；④ 输出不含任何 `sk-`；⑤ cleanup：对非 manifest 记录的目录拒绝删除；确认输入后仅删记录内子目录
- [ ] **Step 2: 运行** FAIL → **实现** → **PASS** + lint
- [ ] **Step 3: Commit** `feat: 迁移编排（阶段串联/dry-run/空间闸门）`

### Task 9: 迁移向导 SKILL.md

**Files:**
- Create: `skills/migrate-storage/SKILL.md`（name/description 中文 frontmatter）

**Interfaces:**
- Consumes: Task 8 CLI

- [ ] **Step 1: 写 SKILL.md**：会话内流程=① 读取/确认目标目录与备份根目录（默认 `<target>/zpowerpack-backup/`，可改）→ ② 展示体积清单 → ③ 调 `--dry-run` 展示报告 → ④ 用户确认 → ⑤ 真跑 → ⑥ 提示重启衔接两路径（立即重启=脚本接管自动拉起；稍后=Toast 后自行重启）→ ⑦ 首启验收清单（会话历史/插件/模型/rollout 位置）+ 同步完成时间戳核对 → ⑧ 显式清理命令（双重确认）。全程中文
- [ ] **Step 2: 真机冒烟**：本机对临时小目录完整走一遍 dry-run + 真跑（skip-waiter），验收 SKILL 输出
- [ ] **Step 3: Commit** `feat: 存储迁移向导技能`

### Task 10: 恢复流程 restore-storage.mjs + SKILL.md

**Files:**
- Create: `scripts/migrate/restore-storage.mjs`、`skills/restore-storage/SKILL.md`
- Test: `tests/restore.test.mjs`

**Interfaces:**
- Consumes: Task 3 manifest、Task 6 restoreStoragePaths

- [ ] **Step 1: 写失败测试**：用 Task 8 场景产物 → restore 后 zcode config 与迁移前深比较相等；manifest 缺失 → 中文报错
- [ ] **Step 2: 运行** FAIL → **实现**（CLI `--manifest <path>`）→ **PASS** + lint
- [ ] **Step 3: SKILL.md**（列出最新 manifest 路径的查找规则 + 提示需重启 zcode 生效）
- [ ] **Step 4: Commit** `feat: 按 manifest 恢复存储配置`

### Task 11: 本地市场与真机验收

**Files:**
- Create: `marketplace.json`（根级，source "./"，中文 displayName/description）

- [ ] **Step 1: 写 marketplace.json**（plugin-creator 规范字段）
- [ ] **Step 2: 校验**：plugin.json 与 marketplace 名称/版本/描述一致；`npm test`（全量）与 `npm run lint` 通过
- [ ] **Step 3: 真机验收清单输出**：指导用户在 zcode 中添加本地市场并安装插件；安装后运行 `/zpowerpack:migrate-storage` 对真实环境 dry-run
- [ ] **Step 4: Commit** `chore: 本地市场条目与验收清单`
