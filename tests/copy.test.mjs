/**
 * 拷贝引擎 copy.mjs 的单元测试。
 * 覆盖：真实 robocopy 拷贝与校验、损坏检出、退出码语义（0-7 成功/≥8 失败）、dry-run 零写动作、中文名无乱码。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ROBOCOPY_OK_MAX, copyTree, verifyTree, checkDiskSpace } from "../scripts/migrate/copy.mjs";

/** 造一棵源数据树：20 个文件（含中文名、三层子目录、空文件），返回 {src, files} */
function makeSourceTree() {
  const src = mkdtempSync(join(tmpdir(), "zpowerpack-copy-src-"));
  const files = [];
  const dirs = [src, join(src, "子目录甲"), join(src, "子目录甲", "深层"), join(src, "sub-b")];
  for (const d of dirs.slice(1)) mkdirSync(d, { recursive: true });
  let n = 0;
  for (const d of dirs) {
    for (let i = 0; i < 5; i++) {
      n++;
      const name = n % 3 === 0 ? `文件-${n}-中文名.jsonl` : `file-${n}.jsonl`;
      const p = join(d, name);
      // 空文件与有内容文件交错，覆盖两种形态
      writeFileSync(p, n % 4 === 0 ? "" : `内容行 ${n}\n`.repeat(1 + (n % 5)), "utf8");
      files.push(p);
    }
  }
  return { src, files };
}

/** 递归快照目录（相对路径 + 大小 + 内容字节数），用于 dry-run 前后一致性断言 */
function snapshotDir(root) {
  const out = new Map();
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full, join(rel, name));
      else out.set(join(rel, name), st.size + ":" + readFileSync(full).length);
    }
  };
  walk(root, ".");
  return out;
}

test("ROBOCOPY_OK_MAX 等于 7（robocopy 退出码 0-7 均为成功）", () => {
  assert.equal(ROBOCOPY_OK_MAX, 7);
});

test("copyTree 真实 robocopy 拷贝 20 文件树后 verifyTree 全量一致", async () => {
  const { src, files } = makeSourceTree();
  const dest = join(mkdtempSync(join(tmpdir(), "zpowerpack-copy-dst-")), "cli");
  const r = await copyTree(src, dest);
  assert.equal(r.files, files.length, "拷贝计数应等于源文件数");
  assert.ok(r.bytes > 0 || files.some((f) => statSync(f).size === 0), "字节计数合法");
  const v = await verifyTree(src, dest);
  assert.equal(v.ok, true, JSON.stringify(v.mismatches ?? []));
  assert.ok(v.checked >= files.length, "校验文件数不少于源文件数");
});

test("目标文件被改动后 verifyTree ok=false 且 mismatches 定位到该文件（中文名无乱码）", async () => {
  const { src, files } = makeSourceTree();
  const dest = join(mkdtempSync(join(tmpdir(), "zpowerpack-copy-dst2-")), "cli");
  await copyTree(src, dest);
  // 挑中文名文件改动内容
  const target = files.find((f) => f.includes("中文名"));
  assert.ok(target, "源树应含中文名文件");
  const rel = target.slice(src.length + 1);
  writeFileSync(join(dest, rel), "被篡改的内容", "utf8");
  const v = await verifyTree(src, dest, { hashSampleRatio: 1 });
  assert.equal(v.ok, false);
  const hit = v.mismatches.find((m) => typeof m === "string" ? m.includes("中文名") : m.path.includes("中文名"));
  assert.ok(hit, "mismatches 应含被改动的中文名文件");
  assert.ok(!JSON.stringify(v.mismatches).includes("\uFFFD"), "中文名不得乱码");
});

test("stub runner 退出码 8 时 copyTree 抛中文错误", async () => {
  const src = makeSourceTree().src;
  const dest = join(mkdtempSync(join(tmpdir(), "zpowerpack-copy-dst3-")), "cli");
  const fakeRunner = async () => ({ code: 8, stdout: "错误输出" });
  await assert.rejects(() => copyTree(src, dest, { runner: fakeRunner }), (e) => {
    assert.ok(e.message.includes("robocopy 失败(退出码 8)"), "错误信息应含退出码语义: " + e.message);
    return true;
  });
});

test("dry-run 不产生任何写动作且返回的 argv 含 /COPY:DAT", async () => {
  const { src } = makeSourceTree();
  const dest = join(mkdtempSync(join(tmpdir(), "zpowerpack-copy-dst4-")), "cli");
  const before = snapshotDir(src);
  let spawnCalled = 0;
  const guardRunner = async () => { spawnCalled++; return { code: 0, stdout: "" }; };
  const r = await copyTree(src, dest, { dryRun: true, runner: guardRunner });
  assert.equal(spawnCalled, 0, "dry-run 不得调用 robocopy");
  assert.ok(Array.isArray(r.argv) && r.argv.includes("/COPY:DAT"), "argv 应含 /COPY:DAT");
  assert.deepEqual(snapshotDir(src), before, "源树不得被改动");
  assert.equal(existsSync(dest), false, "目标不得被创建");
});

test("checkDiskSpace 返回正的可用字节数", async () => {
  const r = await checkDiskSpace(tmpdir());
  assert.ok(r.freeBytes > 0, "可用空间应为正数: " + r.freeBytes);
});
