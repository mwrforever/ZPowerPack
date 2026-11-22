/**
 * 实时速率状态机：官方 models.onDidGenerate 流式事件驱动（纯内存，无 IO、无定时器）。
 *
 * V2 口径（取代旧 rate.mjs 的 EMA/窗口加权/三态保持）：
 * - 展示值=官方推送值原样，本模块不做任何平滑/加权/保持；
 * - 活跃流 Map<requestId, 流>：streaming 事件建流/刷新，final 事件删流并记 lastFinal；
 * - 三态判定：存在 streaming 流 → live；最近事件距今 ≤ IDLE_AFTER_MS → recent；超 → idle
 *   （recent/idle 的末值由 lastFinal 原样带出，视图据此展示数据时刻速率而非 0）；
 * - requestTps 自 rate.mjs 原样迁入（订阅不可达兜底链与降级路径共用）。
 *
 * 事件载荷键名契约（camelCase 基线；Task 0 真机探针实测如有出入，由控制者安排映射调整）：
 * {sessionId, requestId, model:{providerId, modelId}, phase:"streaming"|"final",
 *  outputTokensPerSecond, outputTokens?, timeToFirstTokenMs?}
 */

/** 空闲判定阈值（毫秒）：无流且最近事件距今超过该值 → idle（沿用旧保持上限 5 分钟口径） */
const IDLE_AFTER_MS = 300000;

/** 数值保留 2 位小数（requestTps 展示口径，迁移自 rate.mjs 不改动） */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * 单请求生成速率（token 每秒）——自 rate.mjs 原样迁入，订阅兜底链共用。
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
 * 创建实时速率状态机实例（每个看板服务一份，单线程事件循环内使用，无并发风险）。
 * @returns {{
 *   onEvent(ev: object, now: number, subagentIds: Set<string>): void,
 *   snapshot(now: number): object,
 *   noteFallbackRow(row: object): void
 * }} onEvent=事件入口（now 为事件到达时刻，epoch 毫秒）；
 *     snapshot=当前快照（now 为取快照时刻）；
 *     noteFallbackRow=订阅不可达兜底入口
 */
export function createLiveRate() {
  /** 活跃流：Map<requestId, {requestId, modelId, providerId, isSub, tps, phase}>（phase 恒为 streaming，final 即删） */
  const streams = new Map();
  let lastEventAt = null; // 最近事件时刻（epoch 毫秒，任意 phase，recent/idle 判定时钟）
  let lastProviderId = null; // 最近事件厂商（素条空闲态「跟随最近请求厂商」用）
  let lastFinal = null; // 最近 final 末值 {modelId, tps, outputTokens, at} | null
  let fallback = null; // 兜底 {tps, completedAt} | null（noteFallbackRow 写入）

  return {
    /**
     * 事件入口：官方推送载荷直录，不做平滑。
     * @param {object} ev camelCase 契约载荷（键名见模块头注释）
     * @param {number} now 事件到达时刻（epoch 毫秒，宿主回调到达时间）
     * @param {Set<string>} subagentIds Task 1 subagentSessionIds 产出的子代理会话集合（空集=全部按主会话）
     */
    onEvent(ev, now, subagentIds) {
      // 最近事件信息每次全量刷新（素条空闲态跟随、三态判定共用同一时钟）
      lastEventAt = now;
      lastProviderId = ev.model.providerId;

      if (ev.phase === "streaming") {
        // 建流/刷新：同 requestId 重复推送以末次为准（官方持续推送瞬时速率）
        streams.set(ev.requestId, {
          requestId: ev.requestId,
          modelId: ev.model.modelId,
          providerId: ev.model.providerId,
          // isSub 由会话归属判定：子代理速率单独分列（subTps）
          isSub: subagentIds.has(ev.sessionId),
          tps: ev.outputTokensPerSecond,
          phase: "streaming",
        });
        return;
      }
      // final 收流：删流并记末值；漏 final 导致的滞留流属宿主事件丢失，本层不补偿
      streams.delete(ev.requestId);
      lastFinal = {
        modelId: ev.model.modelId,
        tps: ev.outputTokensPerSecond,
        outputTokens: ev.outputTokens ?? null, // 契约中 final 才带产出，缺失时置 null 保形稳定
        at: now,
      };
    },

    /**
     * 当前快照（渲染契约，Task 4/5 消费）。
     * @param {number} now 取快照时刻（epoch 毫秒）
     * @returns {{state: "live"|"recent"|"idle", streams: object[], totalTps: number, subTps: number,
     *            lastEventAt: number|null, lastProviderId: string|null,
     *            lastFinal: {modelId, tps, outputTokens, at}|null, fallback: {tps, completedAt}|null}}
     *          state=live 时速率按流给；recent/idle 无流但末值在 lastFinal（不显示 0）；
     *          fallback 与流并存时流优先（由 state=live 表达），兜底行不参与状态判定
     */
    snapshot(now) {
      const rows = [...streams.values()];
      // 三态判定：有流即 live；无流按最近事件时刻判 recent/idle（兜底行不参与判定）
      let state;
      if (rows.length > 0) {
        state = "live";
      } else if (lastEventAt !== null && now - lastEventAt <= IDLE_AFTER_MS) {
        state = "recent";
      } else {
        state = "idle";
      }
      // 主/子代理分列合计（官方推送值原样求和，无加权）
      let totalTps = 0;
      let subTps = 0;
      for (const s of rows) {
        totalTps += s.tps;
        if (s.isSub) subTps += s.tps;
      }
      return { state, streams: rows, totalTps, subTps, lastEventAt, lastProviderId, lastFinal, fallback };
    },

    /**
     * 兜底入口：订阅不可达时由服务层喂最新完成行。
     * 只存 requestTps(row) 与 completedAt，不参与状态判定（视图按数据时刻渲染）。
     * @param {object} row db-reader 输出的 camelCase 完成行
     */
    noteFallbackRow(row) {
      fallback = { tps: requestTps(row), completedAt: row.completedAt };
    },
  };
}
