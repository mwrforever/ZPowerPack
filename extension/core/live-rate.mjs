/**
 * 当前会话实时 token 速率状态机（v0.3 最小口径，纯内存、无 IO、无轮询）。
 *
 * 数据源：宿主官方 models.onDidGenerate 流式事件（载荷 outputTokensPerSecond 为官方算好的
 * 实时速率，直接采用，不做 EMA/窗口加权/平滑）。宿主只推送 querySource=main_turn 的请求，
 * 子代理请求在宿主侧被过滤，故本模块只维护主代理流。
 *
 * 展示口径（2026-11-23 用户终局裁剪；2026-11-24 两次实测校准）：
 * - 新请求开场：先显示该会话上一次 final 的真实速率（精值，不带 `~`）；首帧窗口仅几毫秒、
 *   大块 reasoning/tool 分块也会把累计字符估算瞬间拉爆（实测 1 万+ tok/s），因此要求累计
 *   收到 LIVE_WARMUP_EVENTS 条 streaming（宿主推送 ≥500ms/条，约 2s）后才切到实时估算值；
 * - 热起来之后：显示活跃流的官方估算均值，前缀 `~` 表示「字符估算」（宿主按 chunk 字符数
 *   ÷3 估算 token，实测与真实 token 速率偏差约 -26%~+26%，内容相关）；
 * - 重试/停滞：同一 requestId 静默超过 RETRY_RESET_MS 视为宿主重置了累计窗口（retry 会
 *   清空 chars/firstChunkAt），重新进入 warm-up，避免把重试首帧当成万级速率；
 * - 主代理停工（final）：官方按真实 usage token ÷ 生成时长给值，保留为该会话末值，
 *   素条展示「之前的速率」且不带 `~`（精值）；
 * - 滞留流守卫：取消/失败请求可能收不到 final（宿主推送泵只在完成指标到达时发 final），
 *   活跃流静默超过 STALE_STREAM_MS 即视为结束——不再显示 `~` 假装仍在生成。
 */

/** 开场 warm-up（streaming 条数）：宿主 ≥500ms/条，4 条约 2s；此期间展示上一次 final 精值 */
export const LIVE_WARMUP_EVENTS = 4;

/** 重试/停滞重置判据（毫秒）：同一请求静默超过该值 → 视为宿主重置累计窗口，重新 warm-up */
export const RETRY_RESET_MS = 3000;

/** 滞留流判定阈值（毫秒）：生成期宿主推送间隔 ≤1.5s，60s 静默必已结束/丢失 */
export const STALE_STREAM_MS = 60000;

/** 速率文案精度：1 位小数并去掉尾随 0（428.6、300），与宿主数字字体观感一致 */
export function fmtRate(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const v = Math.round(n * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/**
 * 创建速率状态机（每个扩展激活一份；宿主单线程事件循环，无并发风险）。
 * @returns {{
 *   onEvent(ev: object, now?: number): boolean,
 *   displayFor(sessionId: string, now?: number): string|null,
 *   expire(now?: number): void
 * }} onEvent=官方生成事件入口（返回 true 表示展示值可能变化，调用方据此触发素条刷新）；
 *     displayFor=按会话取素条文案（无历史值且无活跃流 → null）；
 *     expire=清理滞留流（调用方看门狗定时调用）
 */
export function createRateBoard() {
  /**
   * 会话状态：
   * sessionId → {active: Map<requestId, {tps, at}>, requests: Map<requestId, {events, lastEventAt}>, last: number|null}
   * active=热起来之后的活跃流；requests=每请求已收 streaming 条数与末次时刻（warm-up/重试判定）；
   * last=最近 final 的真实速率（开场占位与停工后展示）。
   */
  const sessions = new Map();

  /** 过滤滞留流（不删除）：now 与流末次事件相距超过阈值即视为已结束 */
  const freshStreams = (state, now) =>
    [...state.active.values()].filter((s) => now - s.at <= STALE_STREAM_MS);

  return {
    /**
     * 官方生成事件入口：载荷直录，不做平滑与补帧。
     * @param {object} ev 宿主事件载荷（键名契约：sessionId/requestId/phase/outputTokensPerSecond）
     * @param {number} [now] 事件到达时刻（缺省当前时刻；重试/滞留判定用）
     * @returns {boolean} true=展示值可能变化（调用方需要刷新素条）；false=脏数据/开场 warm-up/重置
     */
    onEvent(ev, now = Date.now()) {
      const sessionId = ev?.sessionId;
      const requestId = ev?.requestId;
      const tps = ev?.outputTokensPerSecond;
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      if (typeof requestId !== "string" || requestId.length === 0) return false;
      if (typeof tps !== "number" || !Number.isFinite(tps) || tps < 0) return false;

      let state = sessions.get(sessionId);
      if (!state) {
        state = { active: new Map(), requests: new Map(), last: null };
        sessions.set(sessionId, state);
      }
      // streaming：同一 requestId 以末次官方推送值为准（官方持续推送累计平均速率）
      if (ev?.phase === "streaming") {
        const req = state.requests.get(requestId);
        if (!req) {
          // 首条 streaming：只登记（首帧窗口仅几毫秒，官方 chars/3 值会爆到数千 tok/s）
          state.requests.set(requestId, { events: 1, lastEventAt: now });
          return false;
        }
        // 重试会清空宿主累计 chars/firstChunkAt，下一次推送同样是「首帧」——
        // 静默超过阈值即视为宿主重置，重新 warm-up（继续显示上一次精值）
        if (now - req.lastEventAt > RETRY_RESET_MS) {
          req.events = 1;
          req.lastEventAt = now;
          state.active.delete(requestId);
          return false;
        }
        req.events += 1;
        req.lastEventAt = now;
        // 开场 warm-up：继续展示上一次 final 精值，不展示尚未收敛的估算（含大块分块尖峰）
        if (req.events <= LIVE_WARMUP_EVENTS) return false;
        state.active.set(requestId, { tps, at: now });
        return true;
      }
      // final：收流并记真实速率——主代理停工后素条继续展示该值（「之前的速率」精值）
      if (ev?.phase === "final") {
        state.requests.delete(requestId);
        state.active.delete(requestId);
        state.last = tps;
        return true;
      }
      return false;
    },

    /**
     * 按会话取素条展示文案（本插件唯一展示契约）。
     * @param {string} sessionId 会话 id（宿主 slots.update 会话作用域键）
     * @param {number} [now] 渲染时刻（缺省当前时刻；用于剔除滞留流）
     * @returns {string|null} 开场/停工「120.8 tok/s」（上一次真实 token 精值）；
     *          生成中「~428 tok/s」（字符估算）；null=无历史值且无活跃流（素条须隐藏）
     */
    displayFor(sessionId, now = Date.now()) {
      const state = sessions.get(sessionId);
      if (!state) return null;
      // 生成中（已过热身）：未滞留活跃流的均值，`~` 标注字符估算
      const live = freshStreams(state, now);
      if (live.length > 0) {
        let sum = 0;
        for (const s of live) sum += s.tps;
        return `~${fmtRate(sum / live.length)} tok/s`;
      }
      // 开场 warm-up / 停工后：展示该会话上一次 final 的真实速率（无历史 → 不展示）
      if (state.last !== null) return `${fmtRate(state.last)} tok/s`;
      return null;
    },

    /**
     * 清理滞留流与请求时钟（取消/失败请求收不到 final 时防内存增长）。
     * @param {number} [now] 当前时刻（缺省当前时刻）
     * @returns {void}
     */
    expire(now = Date.now()) {
      for (const state of sessions.values()) {
        for (const [requestId, s] of state.active) {
          if (now - s.at > STALE_STREAM_MS) state.active.delete(requestId);
        }
        for (const [requestId, req] of state.requests) {
          if (now - req.lastEventAt > STALE_STREAM_MS) state.requests.delete(requestId);
        }
      }
    },
  };
}
