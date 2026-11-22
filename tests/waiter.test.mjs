/**
 * waiter 模块的单元测试。
 * 覆盖：退出轮询（probe 注入/超时中文报错）、增量同步收敛、Toast 与拉起的子进程参数。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { waitForExit, runIncrementalSync, notifyWindows, launchZCode } from "../scripts/migrate/waiter.mjs";

test("waitForExit：probe 前两次 true 后 false → 正常完成", async () => {
  let calls = 0;
  const probe = async () => ++calls <= 2;
  const t0 = Date.now();
  await waitForExit({ probe, pollMs: 10 });
  assert.ok(Date.now() - t0 >= 10, "应至少轮询过一次间隔");
  assert.ok(calls >= 3, "应轮询到 probe 返回 false");
});

test("waitForExit：probe 永真且超过 timeoutMs → 抛中文超时错误", async () => {
  const probe = async () => true;
  await assert.rejects(() => waitForExit({ probe, pollMs: 10, timeoutMs: 120 }), (e) => {
    assert.ok(e.message.includes("超时"), "错误信息应含『超时』: " + e.message);
    assert.ok(e.message.includes("ZCode"), "错误信息应含进程名: " + e.message);
    return true;
  });
});

test("waitForExit：默认 probe 生成 tasklist 命令探测指定进程名", async () => {
  // 拦截 runner 观察 tasklist 调用参数；进程不存在 → 返回结果即可完成
  const calls = [];
  const runner = async (file, args) => {
    calls.push({ file, args });
    return { code: 0, stdout: "信息: 没有运行的任务匹配指定标准。" };
  };
  await waitForExit({ processName: "ZCode.exe", pollMs: 10, runner });
  assert.equal(calls.length, 1, "进程不存在时应只探测一次");
  assert.equal(calls[0].file, "tasklist");
  assert.ok(calls[0].args.some((a) => a.includes("ZCode.exe")), "tasklist 应按进程名过滤");
});

test("runIncrementalSync：预拷贝后修改源文件，重跑后目标收敛一致", async () => {
  const src = mkdtempSync(join(tmpdir(), "zpowerpack-waiter-src-"));
  const destRoot = join(mkdtempSync(join(tmpdir(), "zpowerpack-waiter-dst-")), "cli");
  mkdirSync(join(src, "rollout"), { recursive: true });
  writeFileSync(join(src, "rollout", "a.jsonl"), "第一版内容", "utf8");
  writeFileSync(join(src, "b.txt"), "bbbb", "utf8");

  // 首次同步（模拟预拷贝）
  await runIncrementalSync({ srcRoot: src, destRoot });
  // 源继续变化（模拟 zcode 运行中追加）
  writeFileSync(join(src, "rollout", "a.jsonl"), "第一版内容\n第二版追加", "utf8");
  writeFileSync(join(src, "rollout", "c.jsonl"), "新文件", "utf8");

  await runIncrementalSync({ srcRoot: src, destRoot });
  assert.equal(readFileSync(join(destRoot, "rollout", "a.jsonl"), "utf8"), "第一版内容\n第二版追加");
  assert.equal(readFileSync(join(destRoot, "rollout", "c.jsonl"), "utf8"), "新文件");
  assert.equal(readFileSync(join(destRoot, "b.txt"), "utf8"), "bbbb");
});

test("runIncrementalSync：dbPath/destDbPath 提供时对数据库做在线备份覆盖", async () => {
  const src = mkdtempSync(join(tmpdir(), "zpowerpack-waiter-src2-"));
  const destRoot = join(mkdtempSync(join(tmpdir(), "zpowerpack-waiter-dst2-")), "cli");
  writeFileSync(join(src, "x.txt"), "x", "utf8");
  const { DatabaseSync } = await import("node:sqlite");
  const dbPath = join(src, "db.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE t (v TEXT)");
  db.prepare("INSERT INTO t VALUES (?)").run("v1");
  db.close();
  const destDbPath = join(destRoot, "db.sqlite");

  await runIncrementalSync({ srcRoot: src, destRoot, dbPath, destDbPath });
  const d = new DatabaseSync(destDbPath, { readOnly: true });
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM t").get().n, 1);
  d.close();

  // 源库继续变化 → 再次同步覆盖快照
  const db2 = new DatabaseSync(dbPath);
  db2.prepare("INSERT INTO t VALUES (?)").run("v2");
  db2.close();
  await runIncrementalSync({ srcRoot: src, destRoot, dbPath, destDbPath });
  const d2 = new DatabaseSync(destDbPath, { readOnly: true });
  assert.equal(d2.prepare("SELECT COUNT(*) AS n FROM t").get().n, 2, "第二次备份应覆盖为最新快照");
  d2.close();
});

test("notifyWindows：以 powershell Toast 调用且标题正文含于命令行", async () => {
  const calls = [];
  const runner = async (file, args) => {
    calls.push({ file, args });
    return { code: 0, stdout: "" };
  };
  await notifyWindows("迁移同步完成", "数据已收敛，可随时重启 ZCode", { runner });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "powershell");
  const cmdline = calls[0].args.join(" ");
  assert.ok(cmdline.includes("-NoProfile"), "应禁用 PS 配置文件");
  assert.ok(cmdline.includes("迁移同步完成"), "标题应含于命令行");
  assert.ok(cmdline.includes("数据已收敛，可随时重启 ZCode"), "正文应含于命令行");
});

test("notifyWindows：正文含单引号时正确转义（不破坏 PS 语法）", async () => {
  const calls = [];
  const runner = async (file, args) => {
    calls.push({ file, args });
    return { code: 0, stdout: "" };
  };
  await notifyWindows("标题'含引号", "正文'也有", { runner });
  const cmdline = calls[0].args.join(" ");
  assert.ok(cmdline.includes("标题''含引号"), "PS 单引号应翻倍转义: " + cmdline);
});

test("launchZCode：detached + unref 拉起指定可执行文件", async () => {
  let captured = null;
  const spawnFn = (exe, args, opts) => {
    captured = { exe, args, opts };
    return { unref() { captured.unrefCalled = true; } };
  };
  launchZCode("E:\\app\\ZCode.exe", { spawnFn });
  assert.equal(captured.exe, "E:\\app\\ZCode.exe");
  assert.equal(captured.opts.detached, true);
  assert.equal(captured.opts.stdio, "ignore");
  assert.equal(captured.unrefCalled, true);
});
