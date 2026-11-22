/**
 * 迁移 manifest 模块的单元测试。
 * 覆盖：init/append/read 的阶段轨迹、config 原值白名单快照（敏感键绝不落盘）、编码合规。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initManifest, appendPhase, snapshotConfigValues, readManifest } from "../scripts/migrate/manifest.mjs";

function makeTempRoot() {
  const root = mkdtempSync(join(tmpdir(), "zpowerpack-manifest-test-"));
  return root;
}

test("init → append×2 → read：phases 顺序与字段完整", async () => {
  const backupRoot = makeTempRoot();
  const manifestPath = initManifest(backupRoot, { targetRoot: "D:\\zcode-data" });
  const manifest = readManifest(manifestPath);
  assert.equal(manifest.targetRoot, "D:\\zcode-data");
  assert.ok(manifest.startedAt, "应含 startedAt 时间戳");
  assert.deepEqual(manifest.phases, [], "初始 phases 为空");
  assert.equal(manifest.configSnapshot, null, "初始 configSnapshot 为空");

  appendPhase(manifestPath, { phase: "precopy", detail: "rollout 21GB 预拷贝完成" });
  appendPhase(manifestPath, { phase: "verify", detail: "抽样哈希 5% 全部一致" });
  const after = readManifest(manifestPath);
  assert.equal(after.phases.length, 2);
  assert.equal(after.phases[0].phase, "precopy");
  assert.equal(after.phases[1].detail, "抽样哈希 5% 全部一致");
  assert.ok(after.phases[0].at, "每条阶段记录应含时间戳");

  rmSync(backupRoot, { recursive: true, force: true });
});

test("snapshotConfigValues 仅落白名单键：apiKey 与 sk- 值绝不出现", async () => {
  const backupRoot = makeTempRoot();
  const manifestPath = initManifest(backupRoot, { targetRoot: "D:\\zcode-data" });
  // 模拟喂入含敏感值的完整 config 对象
  snapshotConfigValues(manifestPath, {
    storage: { dir: "C:\\Users\\x\\.zcode", sessionDbPath: "C:\\Users\\x\\.zcode\\cli\\db\\db.sqlite" },
    mcp: { server: "x" },
    injectedSecret: "sk-abcdef123456",
  });
  const raw = readFileSync(manifestPath, "utf8");
  assert.ok(!raw.includes("sk-"), "manifest 不得包含 sk- 子串");
  assert.ok(!raw.includes("injectedSecret"), "manifest 不得包含白名单外键名");
  const manifest = readManifest(manifestPath);
  assert.deepEqual(manifest.configSnapshot, {
    "storage.dir": "C:\\Users\\x\\.zcode",
    "storage.sessionDbPath": "C:\\Users\\x\\.zcode\\cli\\db\\db.sqlite",
  });
  rmSync(backupRoot, { recursive: true, force: true });
});

test("manifest 文件为 UTF-8 无 BOM、末尾单换行", async () => {
  const backupRoot = makeTempRoot();
  const manifestPath = initManifest(backupRoot, { targetRoot: "D:\\t" });
  const buf = readFileSync(manifestPath);
  assert.equal(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, false, "不得有 BOM");
  const text = buf.toString("utf8");
  assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"), "末尾恰一个换行");
  rmSync(backupRoot, { recursive: true, force: true });
});

test("initManifest 返回路径位于备份根目录且目录自动创建", async () => {
  const backupRoot = join(makeTempRoot(), "nested", "backup");
  const manifestPath = initManifest(backupRoot, { targetRoot: "D:\\t" });
  assert.ok(manifestPath.startsWith(backupRoot), "manifest 应在备份根目录内");
  assert.ok(readManifest(manifestPath), "路径可直接读取");
  rmSync(backupRoot, { recursive: true, force: true });
});
