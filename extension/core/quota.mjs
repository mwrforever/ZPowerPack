/**
 * 额度窗口规则引擎：窗口边界计算、分子聚合、百分比（纯函数）+ 内置规则表（规则即数据）。
 *
 * V6 调研裁决（覆盖计划中的日历对齐假设）：智谱周窗口是订阅日锚定的 7 天周期、重置卡会即时改变
 * 重置时间、Kimi 月窗口疑似订阅锚定、OpenCode 未文档化——重置时刻一律以官方接口返回值为唯一权威；
 * V2 收窄后本模块的 windowBounds 仅服务两种场景：① 5h 兜底分子聚合的本地窗口；
 * ② 官方接口不可达时窗口边界的近似（trailing 窗口）。周/月已不做本地分子（24h 底座对
 * 7d/30d 天然算不准），weekly/monthly 分支保留为规则表能力，当前仅测试覆盖。
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
      // 规则表保留、当前仅测试覆盖（V2 已删周本地分子）：订阅日锚定 7 天周期，无锚定 trailing 7 天兜底
      return anchor !== null
        ? { startMs: anchor - 7 * 86400000, endMs: anchor, nextResetMs: anchor }
        : { startMs: now - 7 * 86400000, endMs: now, nextResetMs: null };
    case "monthly":
      // 规则表保留、当前仅测试覆盖（V2 已删月本地分子）：周期长不可本地推知，统一按 30 天近似
      return anchor !== null
        ? { startMs: anchor - 30 * 86400000, endMs: anchor, nextResetMs: anchor }
        : { startMs: now - 30 * 86400000, endMs: now, nextResetMs: null };
    default:
      throw new Error(`未知窗口类型: ${rule?.type ?? String(rule)}`);
  }
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
