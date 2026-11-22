/**
 * SQLite 在线备份模块：用 node:sqlite 的 backup() 生成一致性快照。
 *
 * 选型原因（设计文档 Part 1 流程 2）：迁移预拷贝阶段 zcode 仍在运行、db 处于 WAL 活跃写，
 * 直接文件复制可能得到撕裂快照；backup() 在线备份 API 在不阻塞源库写入的前提下保证页一致性。
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

/**
 * 在线备份源数据库到目标路径。
 * @param {string} dbPath 源库路径（须已存在；以只读方式打开，不影响 zcode 主进程的写锁）
 * @param {string} destPath 目标库路径（父目录不存在时自动创建）
 * @returns {Promise<{pages: number}>} 备份页数（模块级 backup() 的返回值）
 * @throws {Error} 源库不存在时抛出中文错误；备份失败时透传底层错误
 */
export async function backupDb(dbPath, destPath) {
  if (!existsSync(dbPath)) {
    throw new Error(`源数据库不存在: ${dbPath}`);
  }
  mkdirSync(dirname(destPath), { recursive: true });

  // 只读打开源库 → 模块级 backup(源实例, 目标路径) 流式拷贝页（Node 24 形态：非 DatabaseSync 方法）
  const src = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const pages = await backup(src, destPath);
    return { pages };
  } finally {
    src.close();
  }
}
