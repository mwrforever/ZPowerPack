/**
 * 迁移 manifest 模块：迁移全程的阶段轨迹与 config 原值快照，是恢复能力（G5）的依据。
 *
 * manifest 为单文件 JSON（UTF-8 无 BOM、末尾单换行），位于备份根目录下，结构：
 * { startedAt, targetRoot, phases: [{phase, detail, at}], configSnapshot: {"storage.dir": …, "storage.sessionDbPath": …} | null }
 *
 * 敏感值零容忍：configSnapshot 仅接受白名单键（storage.dir / storage.sessionDbPath），
 * 其余任何键（含 apiKey 类）一律不落盘——由 snapshotConfigValues 在写入侧强制过滤。
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, openSync, closeSync, fsyncSync } from "node:fs";
import { join, dirname } from "node:path";

/** config 原值快照白名单：仅允许记录这两键的迁移前原值（回滚依据） */
const SNAPSHOT_WHITELIST = new Set(["storage.dir", "storage.sessionDbPath"]);

/** manifest 文件名（固定，恢复流程按此查找） */
const MANIFEST_NAME = "manifest.json";

/**
 * 在备份根目录初始化 manifest 文件。
 * @param {string} backupRoot 备份根目录（不存在则自动创建）
 * @param {{targetRoot: string}} opts 迁移目标根目录
 * @returns {string} manifest 文件绝对路径
 */
export function initManifest(backupRoot, opts) {
  mkdirSync(backupRoot, { recursive: true });
  const manifestPath = join(backupRoot, MANIFEST_NAME);
  const manifest = {
    startedAt: new Date().toISOString(),
    targetRoot: opts.targetRoot,
    // 迁移时的实际源根（cleanup 的权威依据；快照反推仅作旧 manifest 兜底）
    sourceRoot: typeof opts.sourceRoot === "string" ? opts.sourceRoot : null,
    phases: [],
    configSnapshot: null,
    copied: [],
  };
  writeAtomic(manifestPath, manifest);
  return manifestPath;
}

/**
 * 追加一条阶段记录并立即 fsync——崩溃/断电后阶段轨迹不丢（G5 可追溯）。
 * @param {string} manifestPath manifest 路径（须已 init）
 * @param {{phase: string, detail: string}} entry 阶段名与详情（中文日志语义）
 */
export function appendPhase(manifestPath, entry) {
  const manifest = readManifest(manifestPath);
  manifest.phases.push({ phase: entry.phase, detail: entry.detail, at: new Date().toISOString() });
  writeAtomic(manifestPath, manifest, { fsync: true });
}

/**
 * 快照 config 迁移前原值（仅白名单键；白名单外的键一律丢弃，敏感值不落盘）。
 * @param {string} manifestPath manifest 路径
 * @param {object} original 迁移前的完整 zcode config 对象（可含任意敏感键，此处不透传）
 */
export function snapshotConfigValues(manifestPath, original) {
  const manifest = readManifest(manifestPath);
  const storage = original?.storage ?? {};
  // 两键恒在：不存在的原键记 null（恢复语义：null = 还原时删除该键）
  manifest.configSnapshot = {
    "storage.dir": typeof storage.dir === "string" ? storage.dir : null,
    "storage.sessionDbPath": typeof storage.sessionDbPath === "string" ? storage.sessionDbPath : null,
  };
  // 双保险：只保留白名单键（此过滤防未来改动引入泄漏）
  manifest.configSnapshot = Object.fromEntries(
    Object.entries(manifest.configSnapshot).filter(([k]) => SNAPSHOT_WHITELIST.has(k)),
  );
  writeAtomic(manifestPath, manifest);
}

/**
 * 记录本次迁移实际复制的条目清单（cleanup 白名单的唯一依据：仅清单内条目可被显式清理）。
 * @param {string} manifestPath manifest 路径
 * @param {string[]} copied 子目录名数组（如 ["rollout","exec","db"]）
 */
export function recordCopied(manifestPath, copied) {
  const manifest = readManifest(manifestPath);
  manifest.copied = [...copied];
  writeAtomic(manifestPath, manifest);
}

/**
 * 读取 manifest。
 * @param {string} manifestPath manifest 路径
 * @returns {object} manifest 对象；文件不存在抛出（恢复流程由上层给出中文报错）
 */
export function readManifest(manifestPath) {
  if (!existsSync(manifestPath)) throw new Error(`manifest 不存在: ${manifestPath}`);
  let text = readFileSync(manifestPath, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 容错 BOM
  return JSON.parse(text);
}

/** 原子写 JSON 文件：tmp + rename；可选 fsync 确保落盘 */
function writeAtomic(path, obj, { fsync = false } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  const text = JSON.stringify(obj, null, 2) + "\n";
  if (fsync) {
    // appendPhase 要求阶段轨迹即时持久化：写 + fsync 后再改名
    const fd = openSync(tmp, "w");
    try {
      writeFileSync(fd, text, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } else {
    writeFileSync(tmp, text, "utf8");
  }
  renameSync(tmp, path);
}
