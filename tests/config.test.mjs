/**
 * 插件配置模块 config.mjs 的单元测试。
 * 覆盖：cliStorageRoot 解析规则（复现 zcode.cjs gS()）、env 覆盖、插件配置原子读写、
 * provider 配置路径解析（V5 结论：~/.zcode/v2/ 不跟随 storage.dir）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";

import {
  resolveCliStorageRoot,
  resolveConfigPath,
  resolveProviderConfigPath,
  readPluginConfig,
  writePluginConfig,
} from "../scripts/migrate/config.mjs";

/** 造一个隔离的假用户主目录，可选拦截 <home>/.zcode/cli/config.json 写入 zcode 配置 */
function makeFakeHome(zcodeConfig) {
  const home = mkdtempSync(join(tmpdir(), "zpowerpack-config-test-"));
  const cliDir = join(home, ".zcode", "cli");
  if (zcodeConfig !== undefined) {
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(join(cliDir, "config.json"), JSON.stringify(zcodeConfig, null, 2), "utf8");
  }
  return home;
}

test("storage.dir 指向非 cli 目录时追加 cli 段", () => {
  const home = makeFakeHome({ storage: { dir: "D:\\zcode-data" } });
  const root = resolveCliStorageRoot({}, home);
  assert.equal(root, join("D:\\zcode-data", "cli"));
});

test("storage.dir 已以 cli 结尾时原样返回", () => {
  const home = makeFakeHome({ storage: { dir: "D:\\already\\cli" } });
  const root = resolveCliStorageRoot({}, home);
  assert.equal(root, "D:\\already\\cli");
});

test("无 zcode 配置文件时回退默认 ~/.zcode/cli", () => {
  const home = makeFakeHome();
  const root = resolveCliStorageRoot({}, home);
  assert.equal(root, join(home, ".zcode", "cli"));
});

test("ZCODE_STORAGE_DIR 环境变量优先于 config.json", () => {
  const home = makeFakeHome({ storage: { dir: "D:\\from-config" } });
  const root = resolveCliStorageRoot({ ZCODE_STORAGE_DIR: "D:\\from-env" }, home);
  assert.equal(root, join("D:\\from-env", "cli"));
});

test("ZCODE_STORAGE_DIR 以 cli 结尾时同样原样返回", () => {
  const home = makeFakeHome();
  const root = resolveCliStorageRoot({ ZCODE_STORAGE_DIR: "E:\\data\\cli" }, home);
  assert.equal(root, "E:\\data\\cli");
});

test("resolveConfigPath 默认位于 cliStorageRoot/zpowerpack/config.json", () => {
  const home = makeFakeHome({ storage: { dir: "D:\\zcode-data" } });
  const p = resolveConfigPath({}, home);
  assert.equal(p, join("D:\\zcode-data", "cli", "zpowerpack", "config.json"));
});

test("ZPOWERPACK_CONFIG 环境变量覆盖配置文件位置", () => {
  const home = makeFakeHome();
  const p = resolveConfigPath({ ZPOWERPACK_CONFIG: "C:\\any\\where\\cfg.json" }, home);
  assert.equal(p, "C:\\any\\where\\cfg.json");
});

test("resolveProviderConfigPath 默认固定在 ~/.zcode/v2（V5 结论：不跟随 storage.dir）", () => {
  const home = makeFakeHome({ storage: { dir: "D:\\zcode-data" } });
  const p = resolveProviderConfigPath({}, home);
  assert.equal(p, join(home, ".zcode", "v2", "provider_config.json"));
});

test("resolveProviderConfigPath 尊重 ZCODE_DATA_BASE_DIR 根改道", () => {
  const home = makeFakeHome();
  const p = resolveProviderConfigPath({ ZCODE_DATA_BASE_DIR: "D:\\zb" }, home);
  assert.equal(p, join("D:\\zb", ".zcode", "v2", "provider_config.json"));
});

test("resolveProviderConfigPath 尊重 ZCODE_PERSONAL_PROVIDER_CONFIG_FILE 整体改道", () => {
  const p = resolveProviderConfigPath({ ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "C:\\p.json" }, "C:\\Users\\x");
  assert.equal(p, "C:\\p.json");
});

test("writePluginConfig 后重读等值，文件 UTF-8 无 BOM 且末尾恰一个换行", async () => {
  const home = makeFakeHome();
  const cfgPath = resolveConfigPath({}, home);
  const cfg = { backupRoot: "D:\\backup", logDir: null, quota: { userLimits: {} }, windowRules: null };
  await writePluginConfig(cfgPath, cfg);
  const back = await readPluginConfig(cfgPath);
  assert.deepEqual(back, cfg);
  const raw = readFileSync(cfgPath);
  assert.equal(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf, false, "不得有 BOM");
  const text = raw.toString("utf8");
  assert.ok(text.endsWith("\n"), "末尾应有换行");
  assert.ok(!text.endsWith("\n\n"), "末尾不得多于一个换行");
});

test("readPluginConfig 对不存在的文件返回空对象而非抛错", async () => {
  const home = makeFakeHome();
  const p = resolveConfigPath({}, home);
  assert.equal(existsSync(p), false);
  const cfg = await readPluginConfig(p);
  assert.deepEqual(cfg, {});
});

test("resolveCliStorageRoot 忽略名为 xxxcli 的目录（仅精确匹配 cli）", () => {
  const home = makeFakeHome({ storage: { dir: "D:\\myclifoo" } });
  const root = resolveCliStorageRoot({}, home);
  assert.equal(basename(root), "cli");
  assert.equal(root, join("D:\\myclifoo", "cli"));
});
