/**
 * 拷贝引擎：robocopy 封装 + 目标树校验 + 磁盘空间检查。
 *
 * 关键语义（Review Focus #1）：robocopy 退出码 0-7 均为成功（1=有文件复制、2=有多余文件等
 * 位标志组合），仅 ≥8 视为失败——按普通进程约定判非零会把成功当失败。
 *
 * 预拷贝期间源文件可能被 zcode 持续追加（Review Focus #3）：本引擎不做删除、不做强一致，
 * 校验失败仅报告不致命，收敛交给退出后增量同步（waiter 重跑 copyTree）。
 */

import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { statfs, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";

/** robocopy 成功退出码上限：0-7 成功，≥8 失败 */
export const ROBOCOPY_OK_MAX = 7;

/** robocopy 固定参数：递归、数据+属性+时间戳、目录时间戳、重试 2 次/等 1 秒、精简输出 */
const COPY_ARGS = ["/E", "/COPY:DAT", "/DCOPY:T", "/R:2", "/W:1", "/NFL", "/NDL", "/NJH"];

/**
 * 默认 runner：真实 spawn robocopy，收集 stdout 供错误报告。
 * @returns {Promise<{code: number, stdout: string}>}
 */
function defaultRunner(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stdout += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout }));
  });
}

/** 递归收集 root 下所有文件的 {相对路径, 大小}（相对路径统一正斜杠便于跨调用比较） */
function walkFiles(root, rel = "") {
  const out = [];
  for (const name of readdirSync(join(root, rel))) {
    const relPath = rel ? rel + "/" + name : name;
    const st = statSync(join(root, relPath));
    if (st.isDirectory()) out.push(...walkFiles(root, relPath));
    else out.push({ rel: relPath, size: st.size });
  }
  return out;
}

/**
 * 以 robocopy 复制目录树（不删除目标多余文件，不移动源文件）。
 * @param {string} src 源目录
 * @param {string} dest 目标目录（不存在由 robocopy 创建）
 * @param {{runner?: Function, dryRun?: boolean}} opts runner 注入（测试 stub）；dryRun 仅返回计划 argv 不产生写动作
 * @returns {Promise<{files: number, bytes: number, argv?: string[]}>} files/bytes 为源树统计（应拷贝集），dryRun 时附 argv
 * @throws {Error} robocopy 退出码 ≥8 时抛出中文错误（含退出码与输出尾部）
 */
export async function copyTree(src, dest, opts = {}) {
  // 计数取自源树 walk（robocopy 汇总表字节为人类单位 m/g，解析脆弱；源树统计确定且可测）
  const srcFiles = walkFiles(src);
  const files = srcFiles.length;
  const bytes = srcFiles.reduce((sum, f) => sum + f.size, 0);
  const argv = [src, dest, ...COPY_ARGS];

  if (opts.dryRun) return { files, bytes, argv };

  const runner = opts.runner ?? defaultRunner;
  const { code, stdout } = await runner("robocopy", argv);
  if (code > ROBOCOPY_OK_MAX) {
    const tail = stdout.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
    throw new Error(`robocopy 失败(退出码 ${code})：${tail || "无输出"}`);
  }
  return { files, bytes };
}

/**
 * 校验目标树与源树一致性：相对路径集合比对 + 全量大小比对 + 按 ratio 抽样 SHA256。
 * @param {string} src 源目录
 * @param {string} dest 目标目录
 * @param {{hashSampleRatio?: number}} opts 抽样比例（0~1，默认 0.05；1 为全量哈希）
 * @returns {Promise<{ok: boolean, checked: number, mismatches: Array<{path: string, reason: string}>}>}
 *          mismatches 的 path 为源树相对路径（正斜杠），中文名原样无乱码
 */
export async function verifyTree(src, dest, opts = {}) {
  const ratio = opts.hashSampleRatio ?? 0.05;
  const srcFiles = walkFiles(src);
  const mismatches = [];
  const srcRel = new Map(srcFiles.map((f) => [f.rel, f.size]));
  const destRel = new Map(walkFiles(dest).map((f) => [f.rel, f.size]));

  // 源侧逐文件：缺失 / 大小不一致直接记；完好的进入哈希抽样池
  const intact = [];
  for (const [rel, size] of srcRel) {
    if (!destRel.has(rel)) {
      mismatches.push({ path: rel, reason: "目标缺失" });
    } else if (destRel.get(rel) !== size) {
      mismatches.push({ path: rel, reason: "大小不一致" });
    } else {
      intact.push(rel);
    }
  }
  // 目标侧多余文件（预拷贝语义下不删除，仅报告）
  for (const rel of destRel.keys()) {
    if (!srcRel.has(rel)) mismatches.push({ path: rel, reason: "目标多余" });
  }

  // 确定性抽样：排序后每隔 sampleEvery 个抽 1 个，ratio=1 时全量
  const sampleEvery = ratio >= 1 ? 1 : Math.max(1, Math.ceil(1 / ratio));
  const sample = intact.filter((_, i) => i % sampleEvery === 0);
  for (const rel of sample) {
    const h1 = createHash("sha256").update(await readFileBuffer(src, rel)).digest("hex");
    const h2 = createHash("sha256").update(await readFileBuffer(dest, rel)).digest("hex");
    if (h1 !== h2) mismatches.push({ path: rel, reason: "哈希不一致" });
  }

  const checked = srcRel.size + destRel.size;
  return { ok: mismatches.length === 0, checked, mismatches };
}

/** 读取 root 下相对路径文件内容（verifyTree 内部辅助） */
async function readFileBuffer(root, rel) {
  return readFile(join(root, rel.split("/").join(sep)));
}

/**
 * 检查路径所在卷的可用空间。
 * @param {string} path 任意已存在目录/文件路径
 * @returns {Promise<{freeBytes: number}>} 非特权用户可用字节数（bavail × bsize）
 */
export async function checkDiskSpace(path) {
  const s = await statfs(path);
  return { freeBytes: Number(s.bavail) * Number(s.bsize) };
}
