/**
 * 迁移编排 main.mjs 的单元测试。
 * 全部在临时目录 + 假 zcode config + 小型假数据树 + stub waiter 下运行。
 * 覆盖：dry-run 零写、真跑阶段序列与配置写入、空间闸门、敏感值不落输出、cleanup 白名单删除与双重确认。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { runMigration, cleanupOldData } from "../scripts/migrate/main.mjs";
import { readManifest } from "../scripts/migrate/manifest.mjs";

/** 组装一次迁移的完整临时环境：假 home（zcode config 含未知键与敏感键）+ 假 cli 数据树 + 目标目录 */
function makeMigrationEnv({ withSensitive = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "zpowerpack-main-home-"));
  const oldCliRoot = join(home, ".zcode", "cli");
  const cfg = {
    mcp: { servers: { fs: { command: "node" } } },
    plugins: { enabled: ["crawler@crawler"] },
    theme: "dark",
  };
  if (withSensitive) cfg.injectedCredential = "sk-test-secret-do-not-leak";
  mkdirSync(oldCliRoot, { recursive: true });
  writeFileSync(join(oldCliRoot, "config.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");

  // 假数据树：rollout/exec 两个子目录 + db.sqlite（含数据行）
  mkdirSync(join(oldCliRoot, "rollout", "sess1"), { recursive: true });
  writeFileSync(join(oldCliRoot, "rollout", "sess1", "run.jsonl"), "会话数据行\n", "utf8");
  mkdirSync(join(oldCliRoot, "exec"), { recursive: true });
  writeFileSync(join(oldCliRoot, "exec", "tool.bin"), "执行产物", "utf8");
  mkdirSync(join(oldCliRoot, "db"), { recursive: true });
  const db = new DatabaseSync(join(oldCliRoot, "db", "db.sqlite"));
  db.exec("CREATE TABLE model_usage (v TEXT)");
  db.prepare("INSERT INTO model_usage VALUES (?)").run("usage-row");
  db.close();

  // 未迁移目录（memories 不存在于源）与 v2 目录（应保持原位不迁移）
  mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
  writeFileSync(join(home, ".zcode", "v2", "provider_config.json"), "{}\n", "utf8");

  const target = join(mkdtempSync(join(tmpdir(), "zpowerpack-main-target-")), "migrate-here");
  return { home, oldCliRoot, target, configPath: join(oldCliRoot, "config.json") };
}

test("dry-run：manifest 不创建、zcode config 未被改、输出含预拷贝清单与体积、目标不落盘", async () => {
  const env0 = makeMigrationEnv();
  const logs = [];
  const r = await runMigration({ target: env0.target, dryRun: true, skipWaiter: true, homedir: env0.home, log: (l) => logs.push(l) });
  const output = logs.join("\n");
  assert.ok(output.includes("预拷贝文件清单与体积"), "应输出清单标题: " + output.slice(0, 400));
  assert.ok(output.includes("rollout"), "清单应含子目录名");
  assert.equal(existsSync(env0.target), false, "目标不得被创建");
  assert.equal(r.manifestPath, null, "dry-run 不创建 manifest");
  const cfgAfter = JSON.parse(readFileSync(env0.configPath, "utf8"));
  assert.ok(!("storage" in cfgAfter), "zcode config 不得被改");
});

test("真跑（skip-waiter）：阶段序列完整、config 两键已写、原值在 snapshot、目标数据与 db 就位", async () => {
  const env0 = makeMigrationEnv();
  const waiterCalls = [];
  const r = await runMigration({
    target: env0.target,
    skipWaiter: true,
    homedir: env0.home,
    waiter: async (job) => waiterCalls.push(job),
  });

  // manifest 位置在目标侧备份根
  assert.ok(r.manifestPath.startsWith(join(env0.target, "zpowerpack-backup")), "manifest 应在备份根目录");
  const manifest = readManifest(r.manifestPath);
  const phaseNames = manifest.phases.map((p) => p.phase);
  assert.deepEqual(phaseNames, ["space-check", "precopy", "verify", "config-write"]);

  // zcode config 两键已写且未知键保留
  const cfgAfter = JSON.parse(readFileSync(env0.configPath, "utf8"));
  assert.equal(cfgAfter.storage.dir, env0.target);
  assert.equal(cfgAfter.storage.sessionDbPath, join(env0.target, "cli", "db", "db.sqlite"));
  assert.equal(cfgAfter.theme, "dark");
  assert.deepEqual(cfgAfter.mcp, { servers: { fs: { command: "node" } } });

  // 原值快照：迁移前无 storage 配置 → 两键均为 null
  assert.equal(manifest.configSnapshot["storage.dir"], null);
  assert.equal(manifest.configSnapshot["storage.sessionDbPath"], null);

  // 数据落位：文件树 + db 行数一致
  assert.equal(readFileSync(join(env0.target, "cli", "rollout", "sess1", "run.jsonl"), "utf8"), "会话数据行\n");
  const d = new DatabaseSync(join(env0.target, "cli", "db", "db.sqlite"), { readOnly: true });
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM model_usage").get().n, 1);
  d.close();

  // v2 与源数据原样保留（全程不改名不移动旧数据；v2 按 V5 结论不迁移）
  assert.ok(existsSync(join(env0.home, ".zcode", "v2", "provider_config.json")), "v2 应留在 C 盘原位");
  assert.ok(existsSync(join(env0.oldCliRoot, "rollout", "sess1", "run.jsonl")), "源数据不得被移动/删除");

  // 记录的迁移清单（cleanup 依据）含 rollout/exec/db
  assert.ok(manifest.copied.includes("rollout"));
  assert.ok(manifest.copied.includes("exec"));
  assert.ok(manifest.copied.includes("db"));
  assert.ok(!manifest.copied.includes("v2"), "v2 不得进入迁移清单");
});

test("目标空间不足：预拷贝前中止并中文报错，config 未被改", async () => {
  const env0 = makeMigrationEnv();
  const logs = [];
  await assert.rejects(
    () =>
      runMigration({
        target: env0.target,
        skipWaiter: true,
        homedir: env0.home,
        checkDiskSpaceFn: async () => ({ freeBytes: 0 }),
        log: (l) => logs.push(l),
      }),
    (e) => {
      assert.ok(e.message.includes("磁盘空间不足"), "应报空间不足: " + e.message);
      return true;
    },
  );
  const cfgAfter = JSON.parse(readFileSync(env0.configPath, "utf8"));
  assert.ok(!("storage" in cfgAfter), "中止时 config 不得被改");
  assert.equal(existsSync(join(env0.target, "cli")), false, "中止时不得开始预拷贝");
});

test("输出不含任何 sk- 凭据样式子串", async () => {
  const env0 = makeMigrationEnv();
  const logs = [];
  await runMigration({ target: env0.target, skipWaiter: true, homedir: env0.home, log: (l) => logs.push(l) });
  assert.ok(!logs.join("\n").includes("sk-"), "输出不得含 sk-");
});

test("默认 waiter 派生被调用：收到源/目标/db 作业参数", async () => {
  const env0 = makeMigrationEnv();
  const waiterCalls = [];
  await runMigration({
    target: env0.target,
    skipWaiter: false,
    homedir: env0.home,
    waiter: async (job) => waiterCalls.push(job),
  });
  assert.equal(waiterCalls.length, 1, "应派生一次 waiter");
  assert.equal(waiterCalls[0].srcRoot, env0.oldCliRoot);
  assert.equal(waiterCalls[0].destRoot, join(env0.target, "cli"));
  assert.equal(waiterCalls[0].dbPath, join(env0.oldCliRoot, "db", "db.sqlite"));
  assert.equal(waiterCalls[0].destDbPath, join(env0.target, "cli", "db", "db.sqlite"));
});

test("cleanup：确认后仅删除 manifest 记录的子目录，未知目录与 config.json 保留", async () => {
  const env0 = makeMigrationEnv();
  const r = await runMigration({ target: env0.target, skipWaiter: true, homedir: env0.home });

  // 旧 cli 根下放一个未记录的目录与文件，验证白名单语义
  mkdirSync(join(env0.oldCliRoot, "not-recorded-dir"), { recursive: true });
  writeFileSync(join(env0.oldCliRoot, "not-recorded-dir", "keep.txt"), "保留", "utf8");

  let confirmCalls = 0;
  const confirmFn = async (summary) => {
    confirmCalls++;
    // 第一次确认为清单摘要（应列出将删除的目录），第二次为最终确认文案
    if (confirmCalls === 1) assert.ok(summary.includes("rollout"), "确认摘要应列出将删除的目录");
    return true;
  };
  await cleanupOldData({ manifestPath: r.manifestPath, confirmFn, homedir: env0.home });

  assert.ok(confirmCalls >= 2, "应双重确认");
  assert.equal(existsSync(join(env0.oldCliRoot, "rollout")), false, "已记录子目录应删除");
  assert.equal(existsSync(join(env0.oldCliRoot, "exec")), false);
  assert.equal(existsSync(join(env0.oldCliRoot, "db")), false);
  assert.equal(existsSync(join(env0.oldCliRoot, "not-recorded-dir", "keep.txt")), true, "未记录目录必须保留");
  assert.equal(existsSync(env0.configPath), true, "config.json 必须保留");
  // 目标侧数据不受影响
  assert.equal(existsSync(join(env0.target, "cli", "rollout", "sess1", "run.jsonl")), true);
});

test("cleanup：确认被拒绝时不删除任何内容", async () => {
  const env0 = makeMigrationEnv();
  const r = await runMigration({ target: env0.target, skipWaiter: true, homedir: env0.home });
  let confirmCalls = 0;
  const confirmFn = async () => {
    confirmCalls++;
    return false;
  };
  await cleanupOldData({ manifestPath: r.manifestPath, confirmFn, homedir: env0.home });
  assert.equal(existsSync(join(env0.oldCliRoot, "rollout")), true, "拒绝后源数据应保留");
});

test("cleanup：manifest 缺失时中文报错且不删除", async () => {
  const missing = join(tmpdir(), "zpowerpack-no-manifest-" + Date.now() + ".json");
  await assert.rejects(() => cleanupOldData({ manifestPath: missing, confirmFn: async () => true }), (e) => {
    assert.ok(e.message.includes("manifest"), "错误信息: " + e.message);
    return true;
  });
});
