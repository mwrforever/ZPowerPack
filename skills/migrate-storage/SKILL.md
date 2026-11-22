---
name: migrate-storage
description: 把 zcode 数据目录（~/.zcode/cli，主要是 rollout 遥测与 db）安全迁移到用户指定的磁盘位置：预拷贝→写配置→重启衔接→验收→显式清理，全程可回滚。当用户要求"迁移 zcode 存储 / 释放 C 盘空间 / 移动 rollout 到其他盘"时使用。
---

# 存储迁移向导

把 `~/.zcode/cli` 数据目录迁移到用户指定磁盘。核心脚本 `scripts/migrate/main.mjs`（Node，Windows）。

**三条铁律（向导全程反复向用户申明）：**
1. 全程不改名、不移动、不删除旧数据——删除只存在于最后一步"显式清理"，且需双重确认；
2. 回滚 = 按 manifest 记录的 config 原值回写 `storage.dir` / `storage.sessionDbPath` 两行（用 restore-storage 技能）；
3. v2 目录（provider 配置）不迁移（已验证不跟随 storage.dir），config.json 固定原地。

## 会话内流程

### ① 确认目标目录与备份根目录
- 问用户要目标目录（如 `D:\zcode-data`）；备份根默认 `<目标>/zpowerpack-backup/`，允许用户改为任意磁盘路径。
- 向用户展示迁移范围：`rollout / exec / artifacts / agents / sessions / memories / plugins` 七个子目录 + `db`（在线备份）；**不含** v2 与 config.json。

### ② 展示体积清单
- 跑 `node scripts/migrate/main.mjs --target <目标> --dry-run --skip-waiter`，把输出的"预拷贝文件清单与体积"原样呈现给用户（含"合计约 X 个文件 / Y GB"）。

### ③ dry-run 确认
- 用户看过清单后明确确认（"确认开始迁移"）。如有异议，回到 ①。

### ④ 真跑
- 去掉 `--dry-run` 执行真跑：`node scripts/migrate/main.mjs --target <目标> [--zcode-exe <ZCode.exe 路径>]`
  - 默认会派生脱机 waiter（等 ZCode 完全退出 → 增量同步 → Windows Toast 通知 → 自动拉起）；
  - 用户选择"稍后自己重启"时无需额外参数；选"立即重启"时加 `--zcode-exe` 传入 ZCode.exe 绝对路径实现自动拉起。
- 脚本写完配置后即提示用户重启生效。**manifest 路径**（`<目标>/zpowerpack-backup/manifest.json`）必须告知用户并保留。

### ⑤ 重启衔接说明（告知用户两条路径）
- **立即重启**：waiter 接管——等退出 → 增量同步（秒~分钟）→ 自动拉起 ZCode；
- **稍后自己重启**：同步完成后弹 Toast；用户任意时刻重启。注意：同步完成前几秒内重启会缺尾巴——以 Toast/日志中的**同步完成时间戳**为准，未完成前勿启动。

### ⑥ 首启验收清单（重启后在新会话中执行）
逐项核对并让用户确认：
1. 会话历史完整可见；2. 插件正常加载（Settings → 插件）；3. 模型可用（发一条测试消息）；
4. 新会话的 rollout 落在新位置（`<目标>/cli/rollout/` 有新文件）；5. manifest 中"增量同步完成"时间戳早于首次启动时间。

### ⑦ 显式清理（验收全部通过后）
- 运行 `node scripts/migrate/main.mjs cleanup --manifest <manifest 路径>`；
- 脚本会列出将删除的旧数据子目录并**双重确认**（两次 y）；仅删除 manifest 记录的条目，config.json 与未记录目录一律保留；
- 清理完成 C 盘空间才释放。

### ⑧ 异常与回滚
- 任何一步失败：旧数据完好无损，直接用 restore-storage 技能按 manifest 还原 config 两键即可回到迁移前状态；
- 迁移后发现 zcode 异常：同样走 restore-storage，无需手工改配置。

## 边界与风险提示（向导须主动告知）
- 配置写入后若 zcode 立即热加载（V2 验证项），新写入会落新位置——增量同步会收敛，无数据丢失，但建议写完配置尽快重启；
- plugins/cache 若加载异常，回退方案：对 plugins 用 Junction 指回新位置或保留 C 盘（出现时再处理，属 V2 验证项）。
