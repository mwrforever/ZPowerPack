/**
 * 按 manifest 恢复存储配置：把 zcode config.json 的 storage 两键回写为迁移前原值并校验一致性。
 *
 * 用法：node scripts/migrate/restore-storage.mjs --manifest <manifest 路径>
 * 回滚语义（G5）：旧数据全程未被移动/删除，恢复配置两键即回到迁移前状态；恢复后需重启 zcode 生效。
 */

import { homedir as defaultHomedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { readManifest } from "./manifest.mjs";
import { restoreStoragePaths, readZcodeConfig } from "./zcode-config.mjs";
import { resolveCliStorageRoot } from "./config.mjs";

/**
 * 按 manifest 还原 storage 两键并校验恢复结果。
 * @param {{manifestPath: string, log?: Function, homedir?: string, env?: object}} opts
 * @returns {Promise<{restored: boolean, liveRoot: string}>} restored=true 表示两键已还原；liveRoot 为恢复后的解析存储根
 * @throws {Error} manifest 缺失/非法、config 缺失时抛出中文错误
 */
export async function restoreFromManifest(opts) {
  const { manifestPath, log = (line) => console.log(line), homedir = defaultHomedir(), env = process.env } = opts;
  const manifest = readManifest(manifestPath); // 缺失时抛「manifest 不存在」
  const snapshot = manifest.configSnapshot;
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error(`manifest 中没有 config 原值快照，无法恢复: ${manifestPath}`);
  }

  const zcodeConfigPath = join(homedir, ".zcode", "cli", "config.json");
  log(`按 manifest 还原 zcode 配置（原值快照: ${JSON.stringify(snapshot)}）`);
  restoreStoragePaths(zcodeConfigPath, snapshot);

  // 一致性校验：恢复后重新读取，storage 两键必须与快照原值逐键相等
  const after = readZcodeConfig(zcodeConfigPath);
  const check = (key) => {
    const prop = key === "storage.dir" ? "dir" : "sessionDbPath";
    const actual = typeof after?.storage?.[prop] === "string" ? after.storage[prop] : null;
    return actual === snapshot[key];
  };
  const badKeys = Object.keys(snapshot).filter((k) => !check(k));
  if (badKeys.length > 0) {
    throw new Error(`恢复后校验失败，以下键与原值不一致: ${badKeys.join(", ")}（当前 config: ${zcodeConfigPath}）`);
  }
  const liveRoot = resolveCliStorageRoot(env, homedir);
  log(`还原完成并通过校验。当前 cli 存储根: ${liveRoot}。需重启 ZCode 后生效。`);
  return { restored: true, liveRoot };
}

// ---- CLI 入口 ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const get = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const manifestPath = get("--manifest");
  if (!manifestPath) {
    console.error("用法: node scripts/migrate/restore-storage.mjs --manifest <manifest 路径>");
    process.exit(2);
  }
  try {
    await restoreFromManifest({ manifestPath, homedir: get("--home") ?? defaultHomedir() });
    process.exit(0);
  } catch (e) {
    console.error(`恢复中止：${e.message}`);
    process.exit(1);
  }
}
