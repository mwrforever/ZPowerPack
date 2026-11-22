---
name: restore-storage
description: 按 ZPowerPack 迁移 manifest 把 zcode 配置的 storage 两键还原为迁移前原值（回滚存储迁移）。当用户要求"恢复存储配置 / 回滚迁移 / zcode 迁移后异常想回到原状"时使用。
---

# 存储恢复（回滚）

把 `storage.dir` / `storage.sessionDbPath` 两键回写为 manifest 记录的迁移前原值。**旧数据全程未被移动或删除**，恢复配置即回到迁移前状态，无需搬动任何数据。

## 第一步：定位最新 manifest

manifest 位于迁移时配置的**备份根目录**下（默认 `<迁移目标>/zpowerpack-backup/manifest.json`）。查找规则按序尝试：

1. 问用户迁移时记录的 manifest 路径或迁移目标目录；
2. 默认位置：若用户知道目标目录（如 `D:\zcode-data`），则 `<目标>/zpowerpack-backup/manifest.json`；
3. 迁移日志（`logDir/migrate-*.log`）末尾记录的 manifest 路径。

## 第二步：执行恢复

```
node scripts/migrate/restore-storage.mjs --manifest <manifest 路径>
```

脚本会：打印原值快照 → 回写两键 → 重新读取校验逐键一致 → 输出恢复后的 cli 存储根。任一步失败都会中文报错并保持现状（不会写半截配置）。

## 第三步：提示用户

- **必须重启 ZCode** 后恢复才生效；
- 恢复后 zcode 回到迁移前的存储位置，会话历史/插件/模型与迁移前完全一致；
- 若此前已执行"显式清理"删除了旧数据，配置回滚后旧位置已无数据——此时不要再回滚，检查目标位置的数据与配置是否匹配。

## 何时使用

- 迁移后 zcode 启动异常、会话缺失、插件加载失败——先恢复配置回滚，再排查原因；
- 用户改变主意，不想迁移了——恢复配置即可（数据本来就没动）。
