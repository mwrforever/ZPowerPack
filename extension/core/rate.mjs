/**
 * 指标层：速率口径与平滑保持逻辑（纯函数，无 IO）。
 *
 * 口径（设计文档 §五，写死不得偏离）：
 * - 单请求 tps = (output_tokens + reasoning_tokens) ÷ (completed_at − first_token_at)/1000
 *   ——分母剔除 TTFT/prefill 段避免系统性低估；first_token_at 缺失兜底 duration_ms；
 *   reasoning 计入产出；仅取 status='completed' 且生成时长 >0；
 * - 窗口速率 = Σ产出 ÷ Σ生成时长（时长加权，天然抑制超短请求拉飞）；error 行不入速率；
 * - EMA 二次平滑（α=0.3 可配）抑制单条异常请求造成的跳动；
 * - 保持逻辑：窗口内无新完成行或 Σ生成时长 < 2s（样本不足，典型为长 TTFT/在飞期）→
 *   展示上一波速率并标注数据时刻，不展示 0；超保持上限（默认 5 分钟）→ 空闲态。
 */

/** 数值保留 2 位小数（展示口径） */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * 单请求生成速率（token 每秒）。
 * @param {object} row db-reader 输出的 camelCase 行
 * @returns {number|null} tps 保留 2 位；非 completed / 分母≤0 / 产出缺失 → null
 */
export function requestTps(row) {
  if (!row || row.status !== "completed") return null;
  const output = (row.outputTokens ?? 0) + (row.reasoningTokens ?? 0);
  if (!(output > 0)) return null;
  // 分母：优先 first_token_at→completed_at 的真实生成段；缺失时兜底 duration_ms（含 TTFT，口径稍粗）
  let genMs = null;
  if (typeof row.firstTokenAt === "number" && typeof row.completedAt === "number") {
    genMs = row.completedAt - row.firstTokenAt;
  } else if (typeof row.durationMs === "number") {
    genMs = row.durationMs;
  }
  if (!(genMs > 0)) return null;
  return round2((output / genMs) * 1000);
}

/**
 * EMA 指数平滑：prev + α×(next−prev)。
 * @param {number} prev 上一平滑值（无上波时首值即 next）
 * @param {number} next 当前窗口值
 * @param {number} [alpha=0.3] 平滑系数（0~1，越小越平滑）
 */
export function ema(prev, next, alpha = 0.3) {
  return prev + alpha * (next - prev);
}

/**
 * 滑动窗口速率聚合（时长加权）。
 * @param {object[]} rows db-reader 行数组（error 行由本函数剔除）
 * @param {{now: number, windowMs?: number}} opts now=当前时刻（epoch 毫秒）；windowMs 默认 60000
 * @returns {{genRate: number, throughput: number, sampleDurationMs: number,
 *            byModel: Map<string, {genRate: number, throughput: number, querySource: string, lastCompletedAt: number}>}}
 *          genRate=Σ产出/Σ生成时长；throughput=Σ产出/窗口秒；byModel 按最近完成行的 query_source 归属
 */
export function windowedRate(rows, opts) {
  const now = opts.now;
  const windowMs = opts.windowMs ?? 60000;
  const lower = now - windowMs;
  const windowSec = windowMs / 1000;

  let totalOutput = 0;
  let totalGenMs = 0;
  const byModel = new Map();

  for (const row of rows) {
    // 错误行不进速率（output=0 的失败请求会拉低速率；错误以事件指示另行呈现）
    if (row.status !== "completed") continue;
    if (typeof row.completedAt !== "number" || row.completedAt < lower || row.completedAt > now) continue;
    const genMs = genDurationMs(row);
    if (!(genMs > 0)) continue;
    const output = (row.outputTokens ?? 0) + (row.reasoningTokens ?? 0);

    totalOutput += output;
    totalGenMs += genMs;

    // 按模型聚合（时长加权同口径）
    const key = row.modelId ?? "(未知模型)";
    const cur = byModel.get(key) ?? { output: 0, genMs: 0, querySource: row.querySource, lastCompletedAt: 0 };
    cur.output += output;
    cur.genMs += genMs;
    // query_source 与 lastCompletedAt 取该模型最近完成行
    if (row.completedAt > cur.lastCompletedAt) {
      cur.lastCompletedAt = row.completedAt;
      cur.querySource = row.querySource;
    }
    byModel.set(key, cur);
  }

  const byModelOut = new Map();
  for (const [key, v] of byModel) {
    byModelOut.set(key, {
      genRate: v.genMs > 0 ? round2((v.output / v.genMs) * 1000) : null,
      throughput: round2(v.output / windowSec),
      querySource: v.querySource,
      lastCompletedAt: v.lastCompletedAt,
    });
  }

  return {
    genRate: totalGenMs > 0 ? round2((totalOutput / totalGenMs) * 1000) : null,
    throughput: round2(totalOutput / windowSec),
    sampleDurationMs: totalGenMs,
    byModel: byModelOut,
  };
}

/** 行的生成时长（毫秒）：first_token_at 优先，缺失兜底 duration_ms；均缺 → 0 */
function genDurationMs(row) {
  if (typeof row.firstTokenAt === "number" && typeof row.completedAt === "number") {
    return row.completedAt - row.firstTokenAt;
  }
  if (typeof row.durationMs === "number") return row.durationMs;
  return 0;
}

/**
 * 展示速率三态判定（live/held/idle）——保持逻辑的唯一入口，视图按 state 渲染徽标。
 * @param {{currentValue: number|null, prevValue: number, asOf: number,
 *          sampleDurationMs: number, lastNewRowMs: number|null}} state
 *          currentValue=当前窗口 genRate（EMA 后）；prevValue=上一波展示值；asOf=上一新样本时刻；
 *          sampleDurationMs=当前窗口Σ生成时长；lastNewRowMs=最近完成行时刻（null=窗口内无新行）
 * @param {{now: number, minSampleMs?: number, holdMaxMs?: number}} opts minSampleMs 默认 2000；holdMaxMs 默认 300000
 * @returns {{value: number, state: "live"|"held"|"idle", asOf: number}}
 *          held/idle 时 value=prevValue（held 不显示 0），asOf=数据时刻；live 时 value=currentValue
 */
export function displayRate(state, opts) {
  const now = opts.now;
  const minSampleMs = opts.minSampleMs ?? 2000;
  const holdMaxMs = opts.holdMaxMs ?? 300000;

  // 超保持上限：持续无新样本 → 空闲态（灰色）
  if (typeof state.asOf === "number" && now - state.asOf > holdMaxMs) {
    return { value: state.prevValue, state: "idle", asOf: state.asOf };
  }
  // 样本不足（典型为长 TTFT/在飞期）或窗口内无新完成行 → 保持上一波速率，不显示 0
  const insufficient = typeof state.sampleDurationMs !== "number" || state.sampleDurationMs < minSampleMs;
  if (insufficient || state.lastNewRowMs === null || state.lastNewRowMs === undefined) {
    return { value: state.prevValue, state: "held", asOf: state.asOf };
  }
  return { value: state.currentValue, state: "live", asOf: now };
}
