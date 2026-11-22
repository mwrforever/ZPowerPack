/**
 * 存储迁移编排（CLI + 可注入核心）。
 *
 * 流程（设计文档 §五 Part 1）：空间检查 → 预拷贝（robocopy 不删源 + db 在线备份）→ 校验（大小全量+哈希抽样）
 * → 写配置（storage 两键 + manifest 原值快照）→（可选派生脱机 waiter 做退出后增量同步）。
 * 全程不改名不移动旧数据；清理是独立的显式命令（cleanupOldData，双重确认，仅删 manifest 记录过的条目）。
 * v2 目录不迁移（Plan 2 Task 1 V5 结论：不跟随 storage.dir）。
 *
 * 用法：
 *   node scripts/migrate/main.mjs --target <目录> [--dry-run] [--skip-waiter] [--zcode-exe <路径>]
 *   node scripts/migrate/main.mjs cleanup --manifest <manifest 路径>
 */

import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { homedir as defaultHomedir } from "node:os";
import { dirname, join, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { resolveCliStorageRoot } from "./config.mjs";
import { initManifest, appendPhase, snapshotConfigValues, readManifest, recordCopied } from "./manifest.mjs";
import { copyTree, verifyTree, checkDiskSpace } from "./copy.mjs";
import { backupDb } from "./dbbackup.mjs";
import { applyStoragePaths } from "./zcode-config.mjs";

/** 迁移范围：cliStorageRoot 派生的数据子目录（E2）；config.json 固定原地不动，v2 不迁移 */
const COPY_SUBDIRS = ["rollout", "exec", "artifacts", "agents", "sessions", "memories", "plugins"];

/** 空间闸门系数：数据量 × 1.2（设计文档 §五 前置检查） */
const SPACE_FACTOR = 1.2;

/** 字节数中文格式化（日志/清单展示用） */
function fmtBytes(n) {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + " GB";
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

/** 递归统计目录的文件数与字节数（子目录不存在返回零值） */
function statTree(dir) {
  if (!existsSync(dir)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else {
        files++;
        bytes += st.size;
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

/**
 * 执行迁移（可注入核心，CLI 与测试共用）。
 * @param {{target: string, dryRun?: boolean, skipWaiter?: boolean, env?: object, homedir?: string,
 *          checkDiskSpaceFn?: Function, waiter?: Function, launch?: string,
 *          log?: (line: string) => void}} opts
 *          waiter 注入签名：async (job) => void，job 含 srcRoot/destRoot/dbPath/destDbPath/notifyTitle/notifyBody/launch
 * @returns {Promise<{manifestPath: string|null, copied: string[]}>} dry-run 时 manifestPath 为 null
 * @throws {Error} 空间不足等前置失败时抛出中文错误（此时 config 未被改、预拷贝未开始）
 */
export async function runMigration(opts) {
  const {
    target,
    dryRun = false,
    skipWaiter = false,
    env = process.env,
    homedir = defaultHomedir(),
    checkDiskSpaceFn = checkDiskSpace,
    waiter,
    launch,
    log = (line) => console.log(line),
  } = opts;

  const oldCliRoot = resolveCliStorageRoot(env, homedir);
  const newCliRoot = join(target, "cli");
  const backupRoot = join(target, "zpowerpack-backup");
  const zcodeConfigPath = join(homedir, ".zcode", "cli", "config.json");

  // 数据盘点（dry-run 与真跑共用；不存在的子目录跳过并提示）
  const present = COPY_SUBDIRS.filter((d) => existsSync(join(oldCliRoot, d)));
  const missing = COPY_SUBDIRS.filter((d) => !existsSync(join(oldCliRoot, d)));
  const dbPath = join(oldCliRoot, "db", "db.sqlite");
  const hasDb = existsSync(dbPath);
  const sizes = new Map(present.map((d) => [d, statTree(join(oldCliRoot, d))]));
  const totalBytes = [...sizes.values()].reduce((s, x) => s + x.bytes, 0);
  const totalFiles = [...sizes.values()].reduce((s, x) => s + x.files, 0);

  log(`cli 存储根（迁移源）: ${oldCliRoot}`);
  log(`迁移目标: ${target}（cli 根 ${newCliRoot}）`);
  log("预拷贝文件清单与体积：");
  for (const d of present) log(`  ${d}: ${sizes.get(d).files} 个文件，${fmtBytes(sizes.get(d).bytes)}`);
  if (hasDb) log(`  db: ${fmtBytes(statSync(dbPath).size)}（node:sqlite 在线备份，规避 WAL 活跃写拷贝不一致）`);
  for (const d of missing) log(`  ${d}: 源不存在，跳过`);
  log(`v2 目录按 V5 结论不迁移，保留在原位置（provider 配置不跟随 storage.dir）。`);
  log(`合计约 ${totalFiles} 个文件 / ${fmtBytes(totalBytes)}；v2 与 config.json 不在迁移范围。`);

  if (dryRun) {
    log("【dry-run】以上为迁移计划，未产生任何写动作，zcode 配置未修改。");
    return { manifestPath: null, copied: [] };
  }

  // manifest 是恢复能力的依据：从这里开始每个阶段即时落盘
  const manifestPath = initManifest(backupRoot, { targetRoot: target });

  // 空间闸门：先建目标目录再实测目标卷可用空间
  mkdirSync(target, { recursive: true });
  const needBytes = Math.ceil(totalBytes * SPACE_FACTOR);
  const { freeBytes } = await checkDiskSpaceFn(target);
  if (freeBytes < needBytes) {
    throw new Error(
      `磁盘空间不足：迁移需约 ${fmtBytes(needBytes)}（数据量 ${fmtBytes(totalBytes)} × ${SPACE_FACTOR}），` +
        `目标卷仅剩 ${fmtBytes(freeBytes)}。已中止，未开始预拷贝，zcode 配置未被修改。`,
    );
  }
  appendPhase(manifestPath, { phase: "space-check", detail: `需 ${fmtBytes(needBytes)}，目标卷可用 ${fmtBytes(freeBytes)}` });
  log(`空间检查通过：可用 ${fmtBytes(freeBytes)} ≥ 需求 ${fmtBytes(needBytes)}`);

  // 预拷贝：robocopy 不删源不删目标；db 走在线备份
  const copied = [];
  for (const d of present) {
    const r = await copyTree(join(oldCliRoot, d), join(newCliRoot, d));
    copied.push(d);
    log(`预拷贝 ${d}：${r.files} 个文件 / ${fmtBytes(r.bytes)} → ${join(newCliRoot, d)}`);
  }
  if (hasDb) {
    const destDbPath = join(newCliRoot, "db", "db.sqlite");
    const r = await backupDb(dbPath, destDbPath);
    copied.push("db");
    log(`预拷贝 db：在线备份完成（${r.pages} 页）→ ${destDbPath}`);
  }
  recordCopied(manifestPath, copied);
  appendPhase(manifestPath, { phase: "precopy", detail: `已复制: ${copied.join(", ")}` });

  // 校验：大小全量 + 哈希抽样；源仍在被 zcode 追加，不一致不算致命（增量同步收敛，Review Focus #3）
  const verifyIssues = [];
  for (const d of present) {
    const v = await verifyTree(join(oldCliRoot, d), join(newCliRoot, d));
    if (!v.ok) verifyIssues.push(...v.mismatches.map((m) => `${d}/${m.path}: ${m.reason}`));
  }
  if (hasDb) {
    const destDb = new DatabaseSync(join(newCliRoot, "db", "db.sqlite"), { readOnly: true });
    const check = destDb.prepare("PRAGMA quick_check").get();
    destDb.close();
    if (Object.values(check)[0] !== "ok") verifyIssues.push("db: 目标库 quick_check 未通过");
  }
  appendPhase(manifestPath, {
    phase: "verify",
    detail: verifyIssues.length === 0 ? "全部一致" : `${verifyIssues.length} 处差异（预拷贝语义下正常，退出后增量同步收敛）`,
  });
  if (verifyIssues.length > 0) {
    log(`校验提示：${verifyIssues.length} 处差异（源仍在写入属正常，重启后增量同步收敛）：`);
    for (const line of verifyIssues.slice(0, 10)) log(`  - ${line}`);
  } else {
    log("校验通过：目标与源全部一致。");
  }

  // 写配置：applyStoragePaths 返回原值，快照进 manifest（回滚依据），随后提示重启
  const { oldValues, newValues } = applyStoragePaths(zcodeConfigPath, newCliRoot);
  snapshotConfigValues(manifestPath, {
    storage: { dir: oldValues["storage.dir"], sessionDbPath: oldValues["storage.sessionDbPath"] },
  });
  appendPhase(manifestPath, {
    phase: "config-write",
    detail: `storage.dir=${newValues["storage.dir"]}, storage.sessionDbPath=${newValues["storage.sessionDbPath"]}`,
  });
  log("zcode 配置已写入（storage.dir 与 storage.sessionDbPath 两键），需重启 ZCode 后生效。");

  // 重启衔接：默认派生脱机 waiter（等退出 → 增量同步 → Toast → 可选拉起）
  if (!skipWaiter) {
    const job = {
      srcRoot: oldCliRoot,
      destRoot: newCliRoot,
      dbPath: hasDb ? dbPath : null,
      destDbPath: hasDb ? join(newCliRoot, "db", "db.sqlite") : null,
      notifyTitle: "ZPowerPack 存储迁移",
      notifyBody: "增量同步完成，可随时重启 ZCode",
      launch: launch ?? null,
    };
    if (waiter) {
      await waiter(job);
    } else {
      spawnWaiterProcess(job);
    }
    appendPhase(manifestPath, { phase: "waiter", detail: "脱机衔接已派生（等待退出→增量同步→通知）" });
    log("脱机 waiter 已派生：等 ZCode 完全退出后自动增量同步并通知。");
  }

  return { manifestPath, copied };
}

/** 派生脱机 waiter 子进程（detached，独立于本会话存续） */
function spawnWaiterProcess(job, { log = (l) => console.log(l) } = {}) {
  const { spawn } = spawnModule();
  const waiterCli = fileURLToPath(new URL("./waiter.mjs", import.meta.url));
  const args = [waiterCli, "--src", job.srcRoot, "--dest", job.destRoot];
  if (job.dbPath && job.destDbPath) args.push("--db", job.dbPath, "--destDb", job.destDbPath);
  if (job.notifyTitle) args.push("--notify", `${job.notifyTitle}|${job.notifyBody ?? ""}`);
  if (job.launch) args.push("--launch", job.launch);
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

/** 按旧 cli 根的 configSnapshot 原值还原迁移前的旧根路径（与 gS() 规则一致） */
function oldCliRootFromSnapshot(configSnapshot, homedir) {
  const dir = configSnapshot?.["storage.dir"];
  if (typeof dir !== "string" || dir.trim().length === 0) return join(homedir, ".zcode", "cli");
  const trimmed = dir.trim();
  return basename(trimmed) === "cli" ? trimmed : join(trimmed, "cli");
}

/**
 * 显式清理：按 manifest 记录删除源端旧数据子目录（迁移验收通过后的最后一步）。
 * 白名单语义：仅 manifest.copied 内的条目会被删除；config.json 与未记录目录一律保留；
 * 目标根不得等于源根（防误删新数据）；双重确认（两次确认均须通过）。
 * @param {{manifestPath: string, confirmFn: Function, log?: Function, homedir?: string}} opts
 *          confirmFn(summary) => Promise<boolean>：两次调用分别用于清单确认与最终确认
 * @returns {Promise<{deleted: string[]}>}
 * @throws {Error} manifest 缺失/源根与目标根相同/确认被拒绝
 */
export async function cleanupOldData(opts) {
  const { manifestPath, confirmFn, log = (line) => console.log(line), homedir = defaultHomedir() } = opts;
  const manifest = readManifest(manifestPath); // 缺失时抛「manifest 不存在」
  const oldRoot = oldCliRootFromSnapshot(manifest.configSnapshot, homedir);
  const newCliRoot = join(manifest.targetRoot, "cli");
  if (oldRoot === newCliRoot || oldRoot === manifest.targetRoot) {
    throw new Error(`源根 ${oldRoot} 与迁移目标相同，拒绝清理（防误删新数据）`);
  }
  if (!Array.isArray(manifest.copied) || manifest.copied.length === 0) {
    throw new Error("manifest 未记录任何已复制条目，拒绝清理");
  }

  const targets = manifest.copied.map((name) => ({ name, path: join(oldRoot, name) }));
  const summary =
    `即将删除旧数据（源根 ${oldRoot}）：\n` +
    targets.map((t) => `  - ${t.name} → ${t.path}`).join("\n") +
    `\nconfig.json 与未记录的目录/文件一律保留。此操作不可撤销。`;
  log(summary);

  // 双重确认：第一次确认清单，第二次最终确认
  if (!(await confirmFn(summary))) {
    log("已取消：未删除任何内容。");
    return { deleted: [] };
  }
  if (!(await confirmFn("最终确认：确认删除以上旧数据子目录？"))) {
    log("最终确认未通过：未删除任何内容。");
    return { deleted: [] };
  }

  const deleted = [];
  for (const t of targets) {
    if (existsSync(t.path)) {
      rmSync(t.path, { recursive: true, force: true });
      log(`已删除 ${t.name}（${t.path}）`);
    } else {
      log(`跳过 ${t.name}（不存在）`);
    }
    deleted.push(t.name);
  }
  log("显式清理完成，C 盘空间已释放。");
  return { deleted };
}

// ---- CLI 入口 ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const log = (l) => console.log(l);
  const get = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  if (args[0] === "cleanup") {
    const manifestPath = get("--manifest");
    if (!manifestPath) {
      console.error("用法: node scripts/migrate/main.mjs cleanup --manifest <manifest 路径>");
      process.exit(2);
    }
    // 交互式双重确认：readline 输入 y 才视为通过
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const confirmFn = async () => (await rl.question("确认？(y/N) ")).trim().toLowerCase() === "y";
    try {
      await cleanupOldData({ manifestPath, confirmFn, log });
      process.exit(0);
    } catch (e) {
      console.error(`清理中止：${e.message}`);
      process.exit(1);
    } finally {
      rl.close();
    }
  } else {
    const target = get("--target");
    if (!target) {
      console.error("用法: node scripts/migrate/main.mjs --target <目录> [--dry-run] [--skip-waiter] [--zcode-exe <路径>]");
      console.error("      node scripts/migrate/main.mjs cleanup --manifest <manifest 路径>");
      process.exit(2);
    }
    try {
      await runMigration({
        target,
        dryRun: args.includes("--dry-run"),
        skipWaiter: args.includes("--skip-waiter"),
        launch: get("--zcode-exe") ?? null,
        log,
      });
    } catch (e) {
      console.error(`迁移中止：${e.message}`);
      process.exit(1);
    }
  }
}
