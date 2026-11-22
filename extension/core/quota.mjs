/**
 * 额度窗口规则引擎：窗口边界计算、分子聚合、百分比（纯函数）+ 内置规则表（规则即数据）。
 *
 * V6 调研裁决（覆盖计划中的日历对齐假设）：智谱周窗口是订阅日锚定的 7 天周期、重置卡会即时改变
 * 重置时间、Kimi 月窗口疑似订阅锚定、OpenCode 未文档化——重置时刻一律以官方接口返回值为唯一权威；
 * 本模块的 windowBounds 仅在两种场景使用：① 分子聚合的本地窗口；② 官方接口不可达时的兜底展示
 * （trailing 窗口，界面必须注明"以官方重置时间为准"）。
 */

/**
 * 计算窗口边界。
 * @param {{type: "rolling-5h"|"weekly"|"monthly"}} rule 窗口规则（来自 window-rules.json）
 * @param {number} now 当前时刻（epoch 毫秒）
 * @param {{nextResetMs?: number|null}} [anchors] 官方接口返回的下次重置时刻（有则精确锚定）
 * @returns {{startMs: number, endMs: number, nextResetMs: number|null}}
 *          rolling-5h=[now-5h,now]（锚定=[锚-5h,锚]）；weekly=trailing 7d 或 [锚-7d,锚]；
 *          monthly=trailing 30d 或 [锚-30d,锚]（周期长按 30 天近似）
 */
export function windowBounds(rule, now, anchors = {}) {
  const anchor = typeof anchors.nextResetMs === "number" ? anchors.nextResetMs : null;
  switch (rule.type) {
    case "rolling-5h":
      // 5h 滚动窗口：无锚定时以"现在"为窗口末端（重置时刻未知，展示层用官方 nextResetTime）
      return anchor !== null
        ? { startMs: anchor - 5 * 3600000, endMs: anchor, nextResetMs: anchor }
        : { startMs: now - 5 * 3600000, endMs: now, nextResetMs: now };
    case "weekly":
      // 订阅日锚定 7 天周期：有官方锚定回推完整周期；无锚定 trailing 7 天兜底
      return anchor !== null
        ? { startMs: anchor - 7 * 86400000, endMs: anchor, nextResetMs: anchor }
        : { startMs: now - 7 * 86400000, endMs: now, nextResetMs: null };
    case "monthly":
      // 月窗口周期长不可本地推知（28~31 天），统一按 30 天近似
      return anchor !== null
        ? { startMs: anchor - 30 * 86400000, endMs: anchor, nextResetMs: anchor }
        : { startMs: now - 30 * 86400000, endMs: now, nextResetMs: null };
    default:
      throw new Error(`未知窗口类型: ${rule?.type ?? String(rule)}`);
  }
}

/**
 * 窗口内分子聚合：某 provider 实例在该边界内的 token 与请求数。
 * @param {object[]} rows db-reader 行数组
 * @param {{providerId: string, bounds: {startMs: number, endMs: number}}} opts
 * @returns {{input: number, output: number, requests: number}}
 *          input=Σinput_tokens；output=Σ(output+reasoning)（与速率分子口径一致）；
 *          requests=行数（含 error 行——错误请求同样消耗额度）
 */
export function usageInWindow(rows, opts) {
  const { providerId, bounds } = opts;
  let input = 0;
  let output = 0;
  let requests = 0;
  for (const row of rows) {
    if (row.providerId !== providerId) continue;
    // 分子按 started_at 计入（§五：请求发起时刻落窗口），缺失兜底 completed_at
    const t = typeof row.startedAt === "number" ? row.startedAt : row.completedAt;
    if (typeof t !== "number" || t < bounds.startMs || t > bounds.endMs) continue;
    input += row.inputTokens ?? 0;
    output += (row.outputTokens ?? 0) + (row.reasoningTokens ?? 0);
    requests++;
  }
  return { input, output, requests };
}

/**
 * 百分比（保留 1 位）。
 * @param {number} used 已用量
 * @param {number|null} limit 限额（null/0 → 无法计算，返回 null；0 限额会除零且无业务意义）
 * @returns {number|null} used/limit×100 保留 1 位
 */
export function percent(used, limit) {
  if (typeof limit !== "number" || limit <= 0) return null;
  return Math.round((used / limit) * 1000) / 10;
}
