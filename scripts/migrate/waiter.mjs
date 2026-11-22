/**
 * waiter 脱机衔接进程：等 ZCode 退出 → 增量同步收敛 → Windows Toast 通知 →（可选）自动拉起。
 *
 * 由迁移编排（main.mjs）在写完配置后派生：脱离当前会话独立运行，全程不触碰数据内容，
 * 只做 copyTree 重跑（robocopy /E 增量合并）与 backupDb 覆盖快照——源数据自始至终未被移动。
 */

import { spawn } from "node:child_process";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 默认子进程 runner：收集 stdout（与 copy.mjs 同形态，便于测试注入） */
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

/**
 * 轮询等待进程退出。
 * @param {{probe?: Function, processName?: string, pollMs?: number, timeoutMs?: number, runner?: Function}} opts
 *          probe 注入的自定义探测（返回 true=仍在运行）；默认用 tasklist 按 processName 探测；
 *          timeoutMs 缺省表示无限等待
 * @returns {Promise<void>} 进程已退出（probe 返回 false）时 resolve
 * @throws {Error} 超过 timeoutMs 仍在运行时抛出中文超时错误（用户应自行决定是否继续等待）
 */
export async function waitForExit(opts = {}) {
  const { processName = "ZCode.exe", pollMs = 2000, timeoutMs, runner = defaultRunner } = opts;
  const probe =
    opts.probe ??
    (async () => {
      // tasklist 按 CSV/无表头过滤指定映像名：匹配到行即视为进程仍在运行
      const { code, stdout } = await runner("tasklist", ["/FI", `IMAGENAME eq ${processName}`, "/FO", "CSV", "/NH"]);
      return code === 0 && stdout.toLowerCase().includes(processName.toLowerCase());
    });

  const startedAt = Date.now();
  while (await probe()) {
    if (timeoutMs !== undefined && Date.now() - startedAt >= timeoutMs) {
      throw new Error(`等待 ${processName} 退出超时（超过 ${timeoutMs}ms）。请关闭 ZCode 后重试，或手动完成重启衔接。`);
    }
    await sleep(pollMs);
  }
}

/**
 * 退出后增量同步：copyTree 重跑覆盖（robocopy /E 只补差量）→ db 在线备份覆盖 → 一致性校验。
 * @param {{srcRoot: string, destRoot: string, dbPath?: string, destDbPath?: string}} job
 *          dbPath/destDbPath 同时提供才执行数据库备份
 * @returns {Promise<void>} robocopy/备份失败时抛错；verify 不一致仅中文告警（预拷贝语义下不算致命，见 Review Focus #3）
 */
export async function runIncrementalSync(job) {
  const { copyTree } = await import("./copy.mjs");
  const { backupDb } = await import("./dbbackup.mjs");
  const { verifyTree } = await import("./copy.mjs");

  await copyTree(job.srcRoot, job.destRoot);
  if (job.dbPath && job.destDbPath) {
    await backupDb(job.dbPath, job.destDbPath);
  }
  const v = await verifyTree(job.srcRoot, job.destRoot);
  if (!v.ok) {
    // 收敛告警：多为 zcode 运行期产生的目标多余文件，下次同步仍会报告；不视为失败
    console.warn(`[waiter] 增量同步后仍有 ${v.mismatches.length} 处不一致（多为运行期新增，不影响数据完整性）：`);
    for (const m of v.mismatches.slice(0, 20)) console.warn(`  - ${m.path}: ${m.reason}`);
  }
}

/** PowerShell 单引号字面量转义：' → ''；并压平换行避免破坏单行 -Command */
function psLiteral(text) {
  return String(text).replace(/\r?\n/g, " ").replace(/'/g, "''");
}

/**
 * 弹出 Windows Toast 通知（纯 PowerShell 调用 Windows.UI.Notifications，零第三方依赖）。
 * @param {string} title 通知标题
 * @param {string} body 通知正文
 * @param {{runner?: Function}} opts runner 注入（测试 stub）
 */
export async function notifyWindows(title, body, opts = {}) {
  const runner = opts.runner ?? defaultRunner;
  // 以 PowerShell 自身 AUMID 作为通知来源，避免注册 AppUserModelID
  const script = [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
    "$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$t.GetElementsByTagName('text').Item(0).AppendChild($t.CreateTextNode('" + psLiteral(title) + "')) > $null",
    "$t.GetElementsByTagName('text').Item(1).AppendChild($t.CreateTextNode('" + psLiteral(body) + "')) > $null",
    "$n=[Windows.UI.Notifications.ToastNotification]::new($t)",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($n)",
  ].join("; ");
  const { code, stdout } = await runner("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
  if (code !== 0) {
    throw new Error(`Windows 通知发送失败(退出码 ${code})：${stdout.trim().slice(0, 200)}`);
  }
}

/**
 * 拉起 ZCode 桌面端（独立进程组，不阻塞父进程退出）。
 * @param {string} exePath ZCode.exe 绝对路径
 * @param {{spawnFn?: Function}} opts spawn 注入（测试 stub）
 */
export function launchZCode(exePath, opts = {}) {
  const spawnFn = opts.spawnFn ?? spawn;
  const child = spawnFn(exePath, [], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}
