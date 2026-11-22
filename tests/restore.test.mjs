/**
 * 恢复流程模块的单元测试：按 manifest 反向恢复 zcode config 的 storage 两键并校验一致性。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMigration } from "../scripts/migrate/main.mjs";
import { restoreFromManifest } from "../scripts/migrate/restore-storage.mjs";

/** 与 main.test 同构的迁移环境（migration → restore 往返用） */
function makeMigrationEnv(originalStorage) {
  const home = mkdtempSync(join(tmpdir(), "zpowerpack-restore-home-"));
  const oldCliRoot = join(home, ".zcode", "cli");
  const cfg = { mcp: { a: 1 }, theme: "dark" };
  if (originalStorage !== undefined) cfg.storage = originalStorage;
  mkdirSync(oldCliRoot, { recursive: true });
  writeFileSync(join(oldCliRoot, "config.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");
  mkdirSync(join(oldCliRoot, "rollout"), { recursive: true });
  writeFileSync(join(oldCliRoot, "rollout", "s.jsonl"), "数据", "utf8");
  const target = join(mkdtempSync(join(tmpdir(), "zpowerpack-restore-target-")), "new-home");
  return { home, oldCliRoot, target, configPath: join(oldCliRoot, "config.json"), originalCfg: cfg };
}

test("迁移后 restore：config 与迁移前深比较相等（原无 storage）", async () => {
  const env0 = makeMigrationEnv(undefined);
  const r = await runMigration({ target: env0.target, skipWaiter: true, homedir: env0.home, log: () => {} });

  const logs = [];
  const out = await restoreFromManifest({ manifestPath: r.manifestPath, homedir: env0.home, log: (l) => logs.push(l) });
  assert.equal(out.restored, true);

  const after = JSON.parse(readFileSync(env0.configPath, "utf8"));
  assert.deepEqual(after, env0.originalCfg, "restore 后应与迁移前完全一致");
  assert.ok(!("storage" in after), "storage 键应整体移除");
  assert.ok(logs.join("\n").includes("还原"), "应输出还原日志");
});

test("迁移后 restore：原有 storage 值被还原", async () => {
  const env0 = makeMigrationEnv({ dir: "C:\\原\\根", sessionDbPath: "C:\\原\\db.sqlite" });
  const r = await runMigration({ target: env0.target, skipWaiter: true, homedir: env0.home, log: () => {} });
  await restoreFromManifest({ manifestPath: r.manifestPath, homedir: env0.home, log: () => {} });
  const after = JSON.parse(readFileSync(env0.configPath, "utf8"));
  assert.deepEqual(after, env0.originalCfg);
});

test("manifest 缺失时中文报错", async () => {
  const missing = join(tmpdir(), "zp-no-manifest-" + Date.now() + ".json");
  await assert.rejects(() => restoreFromManifest({ manifestPath: missing, homedir: tmpdir(), log: () => {} }), (e) => {
    assert.ok(e.message.includes("manifest"), "错误信息: " + e.message);
    return true;
  });
});
