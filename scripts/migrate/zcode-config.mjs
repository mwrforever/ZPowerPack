/**
 * zcode 配置写入器：迁移向导对 ~/.zcode/cli/config.json 的最小化写入。
 *
 * 核心约束（Review Focus #2）：zcode config.json 含大量未知键（mcp/plugins/enabledPlugins…），
 * 写入 storage 两键不得增删任何其它键；恢复 = 按记录的 oldValues 回写（原不存在的键删除，
 * storage 容器随之清空时整体移除）。文件形态与 zcode 一致：标准 JSON、2 空格缩进、末尾单换行。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

/** 去除文本可能存在的 UTF-8 BOM */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 读取 zcode config.json（实测为标准 JSON，无注释/尾逗号）。
 * @param {string} configPath 配置文件路径
 * @returns {object} 解析后的配置对象
 * @throws {Error} 文件不存在或非法 JSON 抛出（迁移前置检查由上层给出中文提示）
 */
export function readZcodeConfig(configPath) {
  if (!existsSync(configPath)) throw new Error(`zcode 配置不存在: ${configPath}`);
  return JSON.parse(stripBom(readFileSync(configPath, "utf8")));
}

/** 原子写回：2 空格缩进、末尾单换行、无 BOM；tmp+rename 防半写 */
function writeZcodeConfig(configPath, cfg) {
  mkdirSync(dirname(configPath), { recursive: true });
  const tmp = configPath + ".zpowerpack-tmp";
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  renameSync(tmp, configPath);
}

/**
 * 写入 storage 两键指向迁移目标。
 * @param {string} configPath zcode config.json 路径
 * @param {string} newCliRoot 迁移后的 cli 根目录（basename 应为 cli）
 * @returns {{oldValues: {"storage.dir": string|null, "storage.sessionDbPath": string|null},
 *            newValues: {"storage.dir": string, "storage.sessionDbPath": string}}}
 *          oldValues 供 manifest 快照与恢复；null 表示原键不存在（恢复时删除）
 */
export function applyStoragePaths(configPath, newCliRoot) {
  const cfg = readZcodeConfig(configPath);
  const oldValues = {
    "storage.dir": typeof cfg?.storage?.dir === "string" ? cfg.storage.dir : null,
    "storage.sessionDbPath": typeof cfg?.storage?.sessionDbPath === "string" ? cfg.storage.sessionDbPath : null,
  };
  const newValues = {
    // storage.dir 指向数据根（cliStorageRoot = 其下 cli 段，gS() 规则见设计文档 E2）
    "storage.dir": dirname(newCliRoot),
    // sessionDbPath 是字面默认值不随 storage.dir 派生（E2），必须显式一起改
    "storage.sessionDbPath": join(newCliRoot, "db", "db.sqlite"),
  };
  cfg.storage = { ...(cfg.storage ?? {}), dir: newValues["storage.dir"], sessionDbPath: newValues["storage.sessionDbPath"] };
  writeZcodeConfig(configPath, cfg);
  return { oldValues, newValues };
}

/**
 * 按 oldValues 恢复 storage 两键：值为 null 的键删除（原本不存在）；
 * storage 容器因此清空时整体移除该键，保证 restore 后与迁移前深比较相等。
 * @param {string} configPath zcode config.json 路径
 * @param {Record<"storage.dir"|"storage.sessionDbPath", string|null>} oldValues 迁移前原值
 */
export function restoreStoragePaths(configPath, oldValues) {
  const cfg = readZcodeConfig(configPath);
  const storage = { ...(cfg.storage ?? {}) };
  for (const [key, value] of Object.entries(oldValues)) {
    const prop = key === "storage.dir" ? "dir" : key === "storage.sessionDbPath" ? "sessionDbPath" : null;
    if (!prop) continue;
    if (value === null) delete storage[prop];
    else storage[prop] = value;
  }
  if (Object.keys(storage).length === 0) delete cfg.storage;
  else cfg.storage = storage;
  writeZcodeConfig(configPath, cfg);
}
