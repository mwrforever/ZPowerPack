/**
 * ZPowerPack 扩展服务层（v0.3 终局裁剪）：只做「当前会话实时 token 速率」常驻素条。
 *
 * 终局口径（2026-11-23 用户拍板）：额度/厂商/24h 趋势/结论/手动同步/详情面板全部砍除，
 * 插件只剩 composer.status 一条素条：
 * - 速率数据源 = 宿主官方 models.onDidGenerate 订阅（官方推送值原样，无平滑/无补帧）；
 *   宿主只推送 querySource=main_turn 的请求，子代理请求在宿主侧被过滤，故只展示主代理速率；
 * - 生成中显示官方字符估算值并加 `~`（宿主按 chunk 字符数÷3 估 token，实测偏差 -26%~+26%）；
 *   开场先展示该会话上一次 final 精值，累计 4 条 streaming（约 2s）后才切到实时估算——
 *   首帧窗口和大块 reasoning/tool 分块会算出万级伪影，不能一上来就采用；
 * - final 是官方真实 usage token ÷ 生成时长的精值，不带 `~`；停工后继续展示该值（「之前的速率」）；
 * - 作用域 = 当前会话（slots.update 第三参 {sessionId}），多窗口各自看到自己会话的值；
 *   目标会话集合来自 workbench.onDidChange / visibleSessions（宿主实证 API）；
 * - 为空不展示：会话从未产生生成事件 → 推送 visible:false，素条不出现。
 *
 * 本模块无 db 读取、无额度接口、无轮询定时器、无视图注册——全部状态在内存中随事件更新；
 * 仅有一个一次性滞留看门狗（取消/失败请求收不到 final 时清掉「生成中」假象，60s 无事件触发）。
 * 运行环境 = 扩展宿主 Node 进程，单线程事件循环（无并发风险）。
 */

import { createRateBoard, STALE_STREAM_MS } from "./core/live-rate.mjs";

/** 素条插槽 id（manifest slots.composer.status 条目 id，宿主按此键取值） */
const SLOT_ID = "zpowerpack-mini";

/** 素条点击目标命令 id：composer.status 条目必须挂命令目标（宿主 schema 硬约束），
 *  本插件无详情面板，命令处理器为空操作 */
const COMMAND_ID = "zpowerpack-rate-status";

/** 事件型推送节流间隔（毫秒）：流式期宿主每 ~500ms 推一次，1s 内只刷一次素条；
 *  final 不受节流约束（停工值必须立即上屏） */
const EVENT_THROTTLE_MS = 1000;

/**
 * 当前激活的服务句柄（模块级单例）：宿主停用/卸载只调用 module.deactivate() 且忽略
 * activate 的返回值（宿主源码实证），退场通道只能靠模块级记忆。
 */
let activeService = null;

/**
 * 订阅句柄退订归一：宿主订阅可能返回函数句柄或带 dispose/unsubscribe 方法的对象句柄；
 * 无法识别（undefined/null/其他）→ null（宿主销毁时自行回收，无需补偿）。
 * @param {*} bound 宿主订阅调用返回值
 * @returns {Function|null} 无参退订函数
 */
function toDisposer(bound) {
  if (typeof bound === "function") return bound;
  if (bound && typeof bound.dispose === "function") return () => bound.dispose();
  if (bound && typeof bound.unsubscribe === "function") return () => bound.unsubscribe();
  return null;
}

/**
 * 生成事件订阅绑定：按宿主实际存在的挂载形态逐一尝试，先成功者胜——同一事件重复订阅
 * 会双计速率，任一形态成功即停。
 * 候选顺序（3.19.1 真机实证 ctx.models.onDidGenerate 为函数直挂；其余为兼容形态）：
 * ① ctx.models.onDidGenerate(handler)；② 同名 .subscribe 对象（Rx 风格）；
 * ③ ctx.models.subscribe("onDidGenerate", handler) 通用入口。
 * @param {object} ctx 扩展上下文（宿主 activate 入参）
 * @param {Function} handler 事件处理函数
 * @param {Function} log 日志（中文；失败候选留痕）
 * @param {Function} onBound 绑定成功回调（收到宿主返回的订阅句柄，供 stop 退订）
 * @returns {string|null} 绑定成功的形态标签；null=全部候选失败（调用方记中文 warn，
 *          速率素条保持隐藏，激活不失败）
 */
export function bindOnGenerate(ctx, handler, log = () => {}, onBound = () => {}) {
  const models = ctx?.models;
  /** 句柄登记失败不得误判为绑定失败（否则会继续尝试下一候选造成事件双计） */
  const notifyBound = (bound) => {
    try {
      onBound(bound);
    } catch {
      // 句柄登记失败不影响已成功的订阅本身
    }
  };
  // 候选 1/2：ctx.models.onDidGenerate——函数（调用即订阅）或带 subscribe 方法的对象（Rx 风格），二者互斥
  if (typeof models?.onDidGenerate === "function") {
    try {
      notifyBound(models.onDidGenerate(handler));
      return "ctx.models.onDidGenerate()";
    } catch (e) {
      log(`[ZPowerPack] 订阅形态 ctx.models.onDidGenerate() 绑定失败：${e?.message ?? ""}`);
    }
  } else if (models?.onDidGenerate && typeof models.onDidGenerate.subscribe === "function") {
    try {
      notifyBound(models.onDidGenerate.subscribe(handler));
      return "ctx.models.onDidGenerate.subscribe()";
    } catch (e) {
      log(`[ZPowerPack] 订阅形态 ctx.models.onDidGenerate.subscribe() 绑定失败：${e?.message ?? ""}`);
    }
  }
  // 候选 3：models 命名空间上的通用 subscribe 入口
  if (typeof models?.subscribe === "function") {
    try {
      notifyBound(models.subscribe("onDidGenerate", handler));
      return 'ctx.models.subscribe("onDidGenerate", cb)';
    } catch (e) {
      log(`[ZPowerPack] 订阅形态 ctx.models.subscribe("onDidGenerate", cb) 绑定失败：${e?.message ?? ""}`);
    }
  }
  return null;
}

/**
 * 扩展激活入口：绑定生成事件订阅 + 会话目标感知 + 素条推送。
 *
 * 职责（全部为终局裁剪后的最小集）：
 * - 速率状态：createRateBoard 按事件维护每会话主代理流与最后 final 值；
 * - 素条推送：ctx.slots.update(SLOT_ID, patch, {sessionId})，同会话同值去重；
 *   无数据会话推 visible:false（为空不展示），有数据推 text（≤40 字符硬约束内）；
 * - 会话目标：workbench.onDidChange 感知可见会话，激活时 visibleSessions() 补初值；
 *   订阅不可达 → 只推最近事件会话（无事件则什么都不推）。
 *
 * @param {object} ctx 扩展上下文（models/slots/commands/workbench 宿主 API）
 * @param {{log?: Function}} opts 测试可注入日志
 * @returns {Promise<{stop: Function, onGenerateEvent: Function}>} 服务句柄
 *          （宿主不消费返回值；测试直驱 onGenerateEvent 验证推送链路）
 */
export async function activate(ctx, opts = {}) {
  const log = opts.log ?? ((l) => console.log(l));
  // 速率状态机（每会话主代理流 + 最后 final 值；无 IO，纯内存）
  const board = createRateBoard();
  // 订阅退订句柄（stop 统一调用；宿主销毁时也安全）
  const disposers = [];
  // 可见会话缓存（workbench 载荷：{sessions:[{sessionId, workspace, isDraft, focused}]}）
  let visibleSessions = [];
  let workbenchOk = false;
  // 最近收到生成事件的会话：workbench 订阅不可达时的素条降级目标
  let lastEventSession = null;
  // 素条同值去重：sessionId → 最近一次「visible|text」（宿主拒收不写键，下一拍可重试）
  const lastPushed = new Map();
  // 事件型推送节流时钟（final 绕过）
  let lastPushAt = 0;
  // 滞留流看门狗（一次性定时器，非轮询）：取消/失败请求收不到 final 时，60s 静默后清流并刷新
  let staleTimer = null;

  /** 重置滞留流看门狗：每次生成事件后重新计时，超时清理滞留流并刷新素条 */
  const armStaleWatchdog = () => {
    if (staleTimer !== null) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      staleTimer = null;
      board.expire(Date.now());
      refreshNow();
    }, STALE_STREAM_MS);
    // 看门狗不阻止宿主进程退出（扩展宿主生命周期由应用决定）
    staleTimer.unref?.();
  };

  /**
   * 推送单个会话的素条值（无数据的会话推隐藏，不展示占位文案）。
   * @param {string} sessionId 会话 id（slots.update 会话作用域键）
   * @returns {void}
   */
  const pushStrip = (sessionId) => {
    const text = board.displayFor(sessionId, Date.now());
    const patch = text === null ? { text: "", visible: false } : { text, visible: true };
    const key = `${patch.visible}|${patch.text}`;
    if (lastPushed.get(sessionId) === key) return;
    try {
      // 第三参=会话作用域（宿主 schema 实证：{sessionId} 与 slots scope 逐字吻合）
      ctx.slots.update(SLOT_ID, patch, { sessionId });
      // 宿主接受后才记去重键：越界/校验拒绝不得写键，否则同值永不重试（V1 素条静默消失根因防复发）
      lastPushed.set(sessionId, key);
    } catch (e) {
      log(`[ZPowerPack] 素条推送失败（${e?.name || "异常"}）：${e?.message ?? ""}`);
    }
  };

  /** 当前推送目标：workbench 可见会话全集；不可达 → 最近事件会话；再无 → 空集（不推全局值） */
  const targets = () => {
    if (workbenchOk) return visibleSessions.map((s) => s.sessionId);
    return lastEventSession === null ? [] : [lastEventSession];
  };

  /** 立即刷新全部目标会话的素条（去重后只推变化值；会话集合变更等宿主事件不占事件节流窗口） */
  const refreshNow = () => {
    for (const sessionId of new Set(targets())) pushStrip(sessionId);
  };

  /**
   * 事件型刷新节流：1s 内只刷一次；final 立即刷（停工值不得滞留）。
   * @param {number} now 事件到达时刻（epoch 毫秒）
   * @param {boolean} immediate 是否绕过节流（final / 会话集合变更）
   */
  const refresh = (now, immediate = false) => {
    if (!immediate && now - lastPushAt < EVENT_THROTTLE_MS) return;
    lastPushAt = now;
    for (const sessionId of new Set(targets())) pushStrip(sessionId);
  };

  // 会话目标感知：workbench 载荷变化 → 立即按新集合刷新（新会话补推、无数据会话隐藏）
  const applyWorkbench = (payload) => {
    const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
    visibleSessions = sessions.filter((s) => typeof s?.sessionId === "string" && s.sessionId.length > 0);
    refreshNow();
  };

  try {
    const wb = ctx?.workbench;
    if (typeof wb?.onDidChange === "function") {
      const dispose = toDisposer(wb.onDidChange(applyWorkbench));
      if (dispose) disposers.push(dispose);
      workbenchOk = true;
    } else if (typeof wb?.onDidChange?.subscribe === "function") {
      // Rx 风格对象挂载（与生成事件候选序列同思路的形态兼容）
      const dispose = toDisposer(wb.onDidChange.subscribe(applyWorkbench));
      if (dispose) disposers.push(dispose);
      workbenchOk = true;
    }
    if (workbenchOk) {
      log("[ZPowerPack] workbench 会话订阅已绑定");
      // 初值拉取：订阅载荷只在未来变更时到达，激活时已可见的会话需主动补一次
      if (typeof wb.visibleSessions === "function") {
        Promise.resolve(wb.visibleSessions())
          .then(applyWorkbench)
          .catch((e) => log(`[ZPowerPack] 可见会话初值拉取失败（${e?.message ?? ""}）`));
      }
    } else {
      log("[ZPowerPack] workbench 会话订阅不可达，素条只跟随最近事件会话");
    }
  } catch (e) {
    workbenchOk = false;
    log(`[ZPowerPack] workbench 会话订阅不可达（${e?.message ?? ""}），素条只跟随最近事件会话`);
  }

  try {
    // composer.status 条目必须挂命令目标（宿主 schema 硬约束）；无详情面板 → 点击空操作
    ctx.commands.register(COMMAND_ID, () => {});
  } catch (e) {
    log(`[ZPowerPack] 命令注册失败（${e?.name || "异常"}）：${e?.message ?? ""}`);
  }

  /**
   * 生成事件入口：状态机直录官方推送值 → 按节流刷新素条。
   * 开场 warm-up 事件被状态机吞掉（先展示上一次精值，约 2s 后才切实时估算），不占节流时钟；
   * final 立即刷新（真实 token 速率马上上屏），streaming 1s 内多事件只刷一次。
   * @param {object} ev 宿主事件载荷（sessionId/requestId/model/phase/outputTokensPerSecond）
   * @param {number} [now] 事件到达时刻（缺省取当前时刻；测试可注入）
   */
  const onGenerateEvent = (ev, now = Date.now()) => {
    // 状态机内部以真实到达时刻记录 warm-up/滞留时钟（now 仅用于推送节流，测试可注入）
    const changed = board.onEvent(ev);
    if (typeof ev?.sessionId === "string" && ev.sessionId.length > 0) lastEventSession = ev.sessionId;
    // 任何生成事件都重置滞留看门狗（含 final：同会话可能还有其他在飞流）
    armStaleWatchdog();
    // warm-up 事件被忽略时不刷新，避免把节流窗口浪费在没有展示值的事件上
    if (ev?.phase === "final" || changed) refresh(now, ev?.phase === "final");
  };

  // 订阅绑定：全败 → 中文 warn，素条保持隐藏（无数据即不展示），激活不失败
  // 绑定的句柄登记进 disposers，stop 时统一退订（不留悬挂订阅）
  const activeForm = bindOnGenerate(ctx, onGenerateEvent, log, (bound) => {
    const dispose = toDisposer(bound);
    if (dispose) disposers.push(dispose);
  });
  if (activeForm !== null) log(`[ZPowerPack] 生成事件订阅已绑定（${activeForm}）`);
  else log("[ZPowerPack] 生成事件订阅不可达，速率素条将保持隐藏");

  /**
   * 停用入口（宿主生命周期契约）：清理滞留看门狗 + 统一退订本激活登记的宿主订阅
   * （句柄取走即清空，重复调用幂等）；无视图句柄需要清理。
   */
  const stop = () => {
    // 先清看门狗（否则停用后仍可能触发一次素条推送）
    if (staleTimer !== null) {
      clearTimeout(staleTimer);
      staleTimer = null;
    }
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch (e) {
        log(`[ZPowerPack] 退订失败（${e?.name || "异常"}）：${e?.message ?? ""}`);
      }
    }
  };

  // 模块级记忆服务句柄：宿主停用/卸载经 deactivate() 退场（只调本函数且忽略 activate 返回值）
  activeService = { stop };
  // 返回事件入口供测试直驱；宿主不消费返回值
  return { stop, onGenerateEvent };
}

/**
 * 停用入口（宿主生命周期契约）：退订本激活登记的全部宿主订阅。
 * 宿主在停用/卸载/更新插件时只调用本函数（无参）且忽略 activate 返回值——必须经模块级
 * activeService 找回句柄；调用后置 null 使重复调用幂等（不误停新激活实例）。
 * @returns {void}
 */
export function deactivate() {
  const service = activeService;
  // 先清引用再停：即使 stop 过程异常也不留下半死句柄供下次误用
  activeService = null;
  service?.stop();
}
