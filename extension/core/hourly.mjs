/**
 * 小时桶增量聚合（24h 趋势与 5h 额度兜底分子的统一底座）。
 *
 * 纯函数无 IO：消费 Task 1 db-reader 输出的 camelCase 行，按 completedAt 把
 * token 用量 O(1) 落进「providerId → epoch 小时桶」，看板层只做纯读聚合：
 * - trendPoints：24h 折线唯一数据源（固定 24 点，空桶补零）；
 * - windowSum：官方额度拉取失败时 5h 兜底分子来源。**诚实口径**：与窗口有
 *   任何重叠的小时桶整桶计入，两端最多各溢出 1 小时（±1 小时粒度近似），
 *   仅作官方失败时的兜底展示，不冒充精确值——官方成功时一律以官方数为准。
 *
 * 降级约定（§七）：zcode 更新改表缺列时行字段可能为 undefined——completedAt
 * 或 providerId 缺失的行无法归位，整行跳过不抛错；token 字段缺值按 0 计，
 * 请求数照常累计。
 */

/** 一小时的毫秒数（epoch 小时桶粒度） */
const HOUR_MS = 3600000;

/**
 * epoch 毫秒 → epoch 小时序号（整除值）。
 * @param {number} ms epoch 毫秒时刻（来源：db-reader 行的 completedAt）
 * @returns {number} 该时刻所属小时的序号（如 3_600_000×100+5 → 100）
 */
export function hourKey(ms) {
  return Math.floor(ms / HOUR_MS);
}

/**
 * 新建空桶结构。
 * @returns {Map<string, Map<number, {in: number, out: number, reqs: number}>>}
 *          providerId →（epoch 小时序号 → {in, out, reqs} 小时桶）
 */
export function newBuckets() {
  return new Map();
}

/**
 * 单行落桶（O(新行)，看板增量轮询的写入口）。
 * @param {Map} buckets newBuckets() 创建的桶结构，本函数原地累加
 * @param {object} row db-reader camelCase 行；completedAt 缺失/非数值或
 *        providerId 缺失时整行跳过（降级不抛错）；token 字段缺值按 0 计
 */
export function addRow(buckets, row) {
  // 无完成时刻无法归位时间桶、无 provider 无法归属，均整行跳过（缺列降级容错）
  if (typeof row.completedAt !== "number" || !Number.isFinite(row.completedAt)) return;
  if (row.providerId == null || row.providerId === "") return;
  const h = hourKey(row.completedAt);
  let hours = buckets.get(row.providerId);
  if (!hours) {
    hours = new Map();
    buckets.set(row.providerId, hours);
  }
  let bucket = hours.get(h);
  if (!bucket) {
    bucket = { in: 0, out: 0, reqs: 0 };
    hours.set(h, bucket);
  }
  // out 含 output+reasoning：行口径 tokens = input+output+reasoning 落成 in+out
  bucket.in += count(row.inputTokens);
  bucket.out += count(row.outputTokens) + count(row.reasoningTokens);
  bucket.reqs += 1;
}

/** token 字段缺值容错：非有限数值一律按 0 计（防字符串拼接污染数值累计） */
function count(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * 清理过期小时桶（防长期运行内存增长）。
 * @param {Map} buckets 桶结构（原地删除）
 * @param {number} now 当前 epoch 毫秒
 * @param {number} keepHours 保留小时数，默认 25（当前小时 + 前 24 小时，
 *        恰覆盖 24 点趋势并留 1 小时余量）；界上的桶保留，桶全过期的
 *        provider 条目一并移除
 */
export function prune(buckets, now, keepHours = 25) {
  // 保留窗口 = 当前小时起共 keepHours 个桶，故界 = 当前小时序号 - (keepHours-1)
  const cutoff = hourKey(now) - (keepHours - 1);
  for (const [pid, hours] of buckets) {
    for (const h of hours.keys()) {
      // 早于界的小时桶整体过期（Map 迭代中删除安全，已访问键不受影响）
      if (h < cutoff) hours.delete(h);
    }
    if (hours.size === 0) buckets.delete(pid);
  }
}

/**
 * 24h 折线数据点（趋势唯一口径）。
 * @param {Map} buckets 桶结构（只读，不修改）
 * @param {number} now 当前 epoch 毫秒
 * @returns {{hourMs: number, tokens: number}[]} 固定 24 点升序（hourKey(now)-23
 *          至当前），跨 provider 求和、空桶补零；空 buckets 也返回 24 个零点
 */
export function trendPoints(buckets, now) {
  const endHour = hourKey(now);
  const points = [];
  for (let h = endHour - 23; h <= endHour; h++) {
    let tokens = 0;
    // 跨 provider 求和（不分 provider 的总用量）；in+out 即 input+output+reasoning
    for (const hours of buckets.values()) {
      const bucket = hours.get(h);
      if (bucket) tokens += bucket.in + bucket.out;
    }
    points.push({ hourMs: h * HOUR_MS, tokens });
  }
  return points;
}

/**
 * 时间窗内覆盖小时桶的整桶求和（官方额度拉取失败时 5h 兜底分子）。
 *
 * 近似口径（诚实标注）：与窗口有任何重叠的小时桶整桶计入，窗口两端最多
 * 各溢出 1 小时（±1 小时粒度），仅作兜底分子，不冒充精确值；官方拉取成功时
 * 不应使用本函数结果。
 *
 * @param {Map} buckets 桶结构（只读，不修改）
 * @param {string} providerId 目标 provider（额度按 provider 维度兜底）
 * @param {number} startMs 窗口起点 epoch 毫秒（含）
 * @param {number} endMs 窗口终点 epoch 毫秒（含）
 * @returns {{in: number, out: number, reqs: number}} 覆盖桶整桶之和；
 *          未知 provider 或无覆盖桶时返回零值，不抛错
 */
export function windowSum(buckets, providerId, startMs, endMs) {
  const sum = { in: 0, out: 0, reqs: 0 };
  const hours = buckets.get(providerId);
  if (!hours) return sum; // 未知 provider：无桶可计，直接零值
  for (const [h, bucket] of hours) {
    // 半开小时区间与窗口有交集 → 覆盖桶整桶计入（±1 小时近似的全部来源）
    if (h * HOUR_MS < endMs && (h + 1) * HOUR_MS > startMs) {
      sum.in += bucket.in;
      sum.out += bucket.out;
      sum.reqs += bucket.reqs;
    }
  }
  return sum;
}
