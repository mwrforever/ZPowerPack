/**
 * db 在线备份模块的单元测试。
 * 覆盖：node:sqlite backup() 一致性快照、备份后源库仍可写（在线语义）、源缺失的中文报错。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { backupDb } from "../scripts/migrate/dbbackup.mjs";

/** 造一个含 n 行的源库，返回 db 路径 */
function makeSourceDb(n) {
  const dir = mkdtempSync(join(tmpdir(), "zpowerpack-dbbackup-"));
  const dbPath = join(dir, "src.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)");
  const ins = db.prepare("INSERT INTO t (val) VALUES (?)");
  for (let i = 0; i < n; i++) ins.run("行" + i);
  db.close();
  return dbPath;
}

test("backupDb 备份 50 行库后目标行数一致，且源库可继续写入（在线语义）", async () => {
  const src = makeSourceDb(50);
  const dest = join(tmpdir(), "zpowerpack-dbbackup-out-" + Date.now() + ".sqlite");
  const r = await backupDb(src, dest);
  assert.ok(r.pages > 0, "应返回页数");

  // 目标库行数 = 50
  const destDb = new DatabaseSync(dest, { readOnly: true });
  assert.equal(destDb.prepare("SELECT COUNT(*) AS n FROM t").get().n, 50);
  destDb.close();

  // 在线语义：备份完成后源库仍可继续写入并读回
  const srcDb = new DatabaseSync(src);
  srcDb.prepare("INSERT INTO t (val) VALUES (?)").run("备份后新写入");
  assert.equal(srcDb.prepare("SELECT COUNT(*) AS n FROM t").get().n, 51);
  srcDb.close();
});

test("源数据库不存在时抛中文错误", async () => {
  const missing = join(tmpdir(), "zpowerpack-dbbackup-nope-" + Date.now() + ".sqlite");
  await assert.rejects(() => backupDb(missing, join(tmpdir(), "out.sqlite")), (e) => {
    assert.ok(e.message.includes("源数据库不存在"), "错误信息: " + e.message);
    return true;
  });
});

test("备份目标自动创建缺失的父目录", async () => {
  const src = makeSourceDb(3);
  const dest = join(tmpdir(), "zpowerpack-dbbackup-nested-" + Date.now(), "deep", "out.sqlite");
  await backupDb(src, dest);
  const db = new DatabaseSync(dest, { readOnly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM t").get().n, 3);
  db.close();
});
