/**
 * zcode 配置写入器的单元测试。
 * 覆盖：未知键保留（Review Focus #2）、storage 两键写入语义、按原值恢复（含键删除）、末尾单换行。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { readZcodeConfig, applyStoragePaths, restoreStoragePaths } from "../scripts/migrate/zcode-config.mjs";

/** 造一个含未知键的假 zcode config，返回其路径与原始对象 */
function makeZcodeConfig(storage) {
  const dir = mkdtempSync(join(tmpdir(), "zpowerpack-zcfg-"));
  const configPath = join(dir, "config.json");
  const cfg = {
    mcp: { servers: { fs: { command: "node" } } },
    plugins: { enabled: ["crawler@crawler"] },
    enabledPlugins: { crawler: true },
    theme: "dark",
  };
  if (storage !== undefined) cfg.storage = storage;
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return { configPath, original: cfg };
}

test("applyStoragePaths 写入 storage 两键且未知键全部保留", () => {
  const { configPath, original } = makeZcodeConfig(undefined);
  const newCliRoot = join("D:\\zcode-data", "cli");
  const r = applyStoragePaths(configPath, newCliRoot);
  // storage.dir = newCliRoot 父目录；sessionDbPath = newCliRoot/db/db.sqlite
  assert.equal(r.newValues["storage.dir"], dirname(newCliRoot));
  assert.equal(r.newValues["storage.sessionDbPath"], join(newCliRoot, "db", "db.sqlite"));

  const after = JSON.parse(readFileSync(configPath, "utf8"));
  // 原有未知键一个不少
  assert.deepEqual(after.mcp, original.mcp);
  assert.deepEqual(after.plugins, original.plugins);
  assert.deepEqual(after.enabledPlugins, original.enabledPlugins);
  assert.equal(after.theme, "dark");
  // storage 两键正确
  assert.equal(after.storage.dir, dirname(newCliRoot));
  assert.equal(after.storage.sessionDbPath, join(newCliRoot, "db", "db.sqlite"));
});

test("applyStoragePaths 返回的 oldValues 记录迁移前原值", () => {
  const { configPath } = makeZcodeConfig({ dir: "C:\\old\\root", sessionDbPath: "C:\\old\\db.sqlite" });
  const r = applyStoragePaths(configPath, join("D:\\new", "cli"));
  assert.equal(r.oldValues["storage.dir"], "C:\\old\\root");
  assert.equal(r.oldValues["storage.sessionDbPath"], "C:\\old\\db.sqlite");
});

test("restore 后 config 与迁移前深比较相等（原 storage 不存在 → 还原后无 storage 键）", () => {
  const { configPath, original } = makeZcodeConfig(undefined);
  const r = applyStoragePaths(configPath, join("D:\\new", "cli"));
  assert.equal(r.oldValues["storage.dir"], null, "原无 storage.dir 应记为 null");
  assert.equal(r.oldValues["storage.sessionDbPath"], null);
  restoreStoragePaths(configPath, r.oldValues);
  const after = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(after, original);
  assert.ok(!("storage" in after), "storage 键应整体移除");
});

test("restore 能还原原有 storage 值", () => {
  const { configPath, original } = makeZcodeConfig({ dir: "C:\\old\\root", sessionDbPath: "C:\\old\\db.sqlite" });
  const r = applyStoragePaths(configPath, join("D:\\new", "cli"));
  restoreStoragePaths(configPath, r.oldValues);
  const after = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(after, original);
});

test("写入文件为 2 空格缩进、UTF-8 无 BOM、末尾恰一个换行", () => {
  const { configPath } = makeZcodeConfig(undefined);
  applyStoragePaths(configPath, join("D:\\new", "cli"));
  const buf = readFileSync(configPath);
  assert.equal(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, false);
  const text = buf.toString("utf8");
  assert.ok(text.includes('\n  "mcp"'), "应为 2 空格缩进");
  assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"));
});

test("readZcodeConfig 读取返回解析对象", () => {
  const { configPath, original } = makeZcodeConfig(undefined);
  assert.deepEqual(readZcodeConfig(configPath), original);
});
