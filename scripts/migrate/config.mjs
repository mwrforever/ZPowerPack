/**
 * ZPowerPack 插件配置模块：解析 zcode 的 cli 存储根与插件自身配置文件路径，提供原子读写。
 *
 * 路径解析复现 zcode.cjs 的官方规则（设计文档 E2）：
 * - storage.dir（或 env ZCODE_STORAGE_DIR）→ basename 为 "cli" 原样使用，否则追加 "cli" 段；
 * - zcode config.json 固定于 <home>/.zcode/cli/config.json，不跟随 storage.dir；
 * - provider 配置固定于 <根>/.zcode/v2/provider_config.json，不跟随 storage.dir（V5 源码验证，
 *   根 = env ZCODE_DATA_BASE_DIR 或用户主目录，可被 ZCODE_PERSONAL_PROVIDER_CONFIG_FILE 整体改道）。
 *
 * 本模块为纯同步/无副作用设计（仅显式读写函数有 IO），供迁移向导与看板数据层共用。
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";

/** 读取文本文件并去除可能存在的 UTF-8 BOM（容错他人写入的带 BOM 文件） */
function readTextNoBom(path) {
  let text = readFileSync(path, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

/**
 * 解析 zcode cli 存储根目录。
 * @param {NodeJS.ProcessEnv} env 环境变量对象（测试注入用；生产传 process.env）
 * @param {string} homedir 用户主目录（测试注入用；生产传 os.homedir()）
 * @returns {string} cli 存储根：env ZCODE_STORAGE_DIR 优先，其次 config.json 的 storage.dir，默认 <home>/.zcode/cli
 */
export function resolveCliStorageRoot(env, homedir) {
  // 规则复现 zcode.cjs gS()：basename 非 "cli" 则追加 cli 段
  const normalize = (dir) => (basename(dir.trim()) === "cli" ? dir.trim() : join(dir.trim(), "cli"));

  // 环境变量等价物优先（E2：ZCODE_STORAGE_DIR → storage.dir）
  const fromEnv = env?.ZCODE_STORAGE_DIR?.trim();
  if (fromEnv) return normalize(fromEnv);

  // zcode config.json 固定于 <home>/.zcode/cli/config.json（不跟随 storage.dir）
  try {
    const cfg = JSON.parse(readTextNoBom(join(homedir, ".zcode", "cli", "config.json")));
    const dir = cfg?.storage?.dir;
    if (typeof dir === "string" && dir.trim().length > 0) return normalize(dir);
  } catch {
    // 缺文件/非法 JSON 均按默认处理（zcode 未迁移过时 storage.dir 通常不存在）
  }
  return join(homedir, ".zcode", "cli");
}

/**
 * 解析 ZPowerPack 插件自身配置文件路径。
 * @param {NodeJS.ProcessEnv} env 环境变量对象
 * @param {string} homedir 用户主目录
 * @returns {string} env ZPOWERPACK_CONFIG 优先；否则 <cliStorageRoot>/zpowerpack/config.json
 */
export function resolveConfigPath(env, homedir) {
  const fromEnv = env?.ZPOWERPACK_CONFIG?.trim();
  if (fromEnv) return fromEnv;
  return join(resolveCliStorageRoot(env, homedir), "zpowerpack", "config.json");
}

/**
 * 解析 provider 个人配置文件（provider_config.json）路径。
 * V5 结论：该文件不跟随 storage.dir 迁移，固定于 <数据根>/.zcode/v2/。
 * @param {NodeJS.ProcessEnv} env 环境变量对象
 * @param {string} homedir 用户主目录
 * @returns {string} env ZCODE_PERSONAL_PROVIDER_CONFIG_FILE 整体改道优先；
 *                    否则 <env ZCODE_DATA_BASE_DIR 或 home>/.zcode/v2/provider_config.json
 */
export function resolveProviderConfigPath(env, homedir) {
  const whole = env?.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim();
  if (whole) return whole;
  const base = env?.ZCODE_DATA_BASE_DIR?.trim() || homedir;
  return join(base, ".zcode", "v2", "provider_config.json");
}

/**
 * 读取插件自身配置。
 * @param {string} path 配置文件路径
 * @returns {Promise<object>} 文件不存在返回空对象（各键取默认值）；非法 JSON 抛出（调用方决定降级策略）
 */
export async function readPluginConfig(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readTextNoBom(path));
}

/**
 * 原子写入插件自身配置（tmp + rename，避免写一半被读到）。
 * 统一 2 空格缩进、UTF-8 无 BOM、末尾恰一个换行；父目录不存在时自动创建。
 * @param {string} path 目标路径
 * @param {object} cfg 配置对象（键：backupRoot/logDir/quota/windowRules，均可空 = 默认）
 */
export async function writePluginConfig(path, cfg) {
  mkdirSync(dirname(path), { recursive: true });
  const text = JSON.stringify(cfg, null, 2) + "\n";
  const tmp = path + ".tmp";
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}
