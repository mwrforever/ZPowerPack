/**
 * 当前会话实时 token 速率状态机（v0.3 最小口径，纯内存、无 IO、无定时器）。
 *
 * 数据源：宿主官方 models.onDidGenerate 流式事件（载荷 outputTokensPerSecond 为官方算好的
 * 实时速率，直接采用，不做 EMA/窗口加权/平滑）。宿主只推送 querySource=main_turn 的请求，
 * 子代理请求在宿主侧被过滤，故本模块只维护主代理流。
 *
 * 展示口径（2026-11-23 用户终局裁剪；2026-11-24 实测校准）：
 * - 生成中：活跃流速率均值的官方估算值，前缀 `~` 表示「字符估算」（宿主按 chunk 字符数
 *   ÷3 估算 token，实测与真实 token 速率偏差约 -26%~+26%，内容相关）；
 * - 首帧过滤：每个请求的第一条 streaming 事件只建状态、不上屏——宿主首帧窗口仅几毫秒，
 *   官方值会爆到数千 tok/s（实测 4667 tok/s），属计算伪影，不是真实生成速度；
 * - 大块伪影过滤：单块 reasoning/tool 字符可达近万，累计估算瞬间超过 MAX_LIVE_TPS，
 *   这类值不上屏（保持上一个合理值或等 final），避免「突然跳出一万多」；
 * - 主代理停工（final）：官方按真实 usage token ÷ 生成时长给值，保留为该会话末值，
 *   素条展示「之前的速率」且不带 `~`（精值）；
 * - 滞留流守卫：取消/失败请求可能收不到 final（宿主推送泵只在完成指标到达时发 final），
 *   活跃流静默超过 STALE_STREAM_MS 即视为结束——不再显示 `~` 假装仍在生成；
 * - 会话从未产生事件：displayFor 返回 null，调用方隐藏素条，不展示占位文案。
 */

/** 滞留流判定阈值（毫秒）：生成期宿主推送间隔 ≤1.5s，60s 静默必已结束/丢失 */
export const STALE_STREAM_MS = 60000;

/**
 * 生成中估算值的合理上限（tok/s）：超过即视为分块伪影，不上屏。
 * 依据（2026-11-24 真机校准）：宿主 streaming = chunk 字符数÷3÷毫秒，大块 reasoning/tool
 * 分块（实测单块近 1 万字符）在 500ms 窗口内可算出 1 万+ tok/s；本机近 30 天全部合法
 * final 上限约 1003 tok/s（deepseek-flash）/878（GLM-5.3），2000 留足余量。
 */
export const MAX_LIVE_TPS = 2000;

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
 *     displayFor=按会话取素条文案（无任何数据/全部流滞留 → null）；
 *     expire=清理滞留流（调用方看门狗定时调用）
 */
export function createRateBoard() {
  /**
   * 会话状态：sessionId → {active: Map<requestId, {tps, at}>, started: Set<requestId>, last: number|null}
   * started=已见过首帧的请求（首帧只登记不上屏，防爆点）；last=最近 final 的真实速率；
   * at=该流末次事件时刻（滞留判定）。
   */
  const sessions = new Map();

  /** 过滤滞留流（不删除）：now 与流末次事件相距超过阈值即视为已结束 */
  const freshStreams = (state, now) =>
    [...state.active.values()].filter((s) => now - s.at <= STALE_STREAM_MS);

  return {
    /**
     * 官方生成事件入口：载荷直录，不做平滑与补帧。
     * @param {object} ev 宿主事件载荷（键名契约：sessionId/requestId/phase/outputTokensPerSecond）
     * @param {number} [now] 事件到达时刻（缺省当前时刻；滞留判定用）
     * @returns {boolean} true=展示值可能变化（调用方需要刷新素条）；false=脏数据/首帧/未知状态
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
        state = { active: new Map(), started: new Set(), last: null };
        sessions.set(sessionId, state);
      }
      // streaming：同一 requestId 以末次官方推送值为准（官方持续推送累计平均速率）
      if (ev?.phase === "streaming") {
        // 首帧窗口只有几毫秒，官方 chars/3 值会爆到数千 tok/s（实测伪影）——只登记不上屏
        if (!state.started.has(requestId)) {
          state.started.add(requestId);
          return false;
        }
        // 大块 reasoning/tool 分块造成的累计估算尖峰（实测 1 万+ tok/s）不是真实速率——
        // 不上屏，保留上一合理值；短请求最终由 final 精值收口
        if (tps > MAX_LIVE_TPS) return false;
        state.active.set(requestId, { tps, at: now });
        return true;
      }
      // final：收流并记真实速率——主代理停工后素条继续展示该值（「之前的速率」精值）
      if (ev?.phase === "final") {
        state.started.delete(requestId);
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
     * @returns {string|null} 生成中「~428 tok/s」（字符估算）；停工后「120.8 tok/s」（真实 token）；
     *          null=该会话从未收到事件或全部流已滞留且无 final（素条须隐藏）
     */
    displayFor(sessionId, now = Date.now()) {
      const state = sessions.get(sessionId);
      if (!state) return null;
      // 生成中：未滞留活跃流的均值（单流即原值；多流为防御性口径），`~` 标注字符估算
      const live = freshStreams(state, now);
      if (live.length > 0) {
        let sum = 0;
        for (const s of live) sum += s.tps;
        return `~${fmtRate(sum / live.length)} tok/s`;
      }
      // 停工后：展示该会话最后一次 final 的真实速率（无 final → 无值可展示）
      if (state.last !== null) return `${fmtRate(state.last)} tok/s`;
      return null;
    },

    /**
     * 清理滞留流（取消/失败请求收不到 final 时防内存增长）：删除超时活跃流。
     * @param {number} [now] 当前时刻（缺省当前时刻）
     * @returns {void}
     */
    expire(now = Date.now()) {
      for (const state of sessions.values()) {
        for (const [requestId, s] of state.active) {
          if (now - s.at > STALE_STREAM_MS) {
            state.active.delete(requestId);
            // 首帧登记同样清理（该请求已不可能再产生可展示值）
            state.started.delete(requestId);
          }
        }
      }
    },
  };
}
