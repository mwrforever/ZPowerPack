/**
 * 看板展示模型 V2：快照 → 前端可直渲染的展示 JSON（纯函数，无 IO/无 DOM）。
 *
 * 背景：宿主对 entry 形态视图只伺服 pageUri 与注册资源（探针实证），视图必须单文件
 * 自包含 → 文案映射/阈值/格式化全部上移到本模块（Node 侧可 TDD），沙箱内联脚本仅做
 * 哑绑定。V2 构图权威=设计稿 §五（卡片四区 + 常驻素条），素条四态逐字文案以 §五.6
 * 表格为唯一权威；界面禁 P50/P95 行话（历史拍板，映射规则：P50→典型/多数，P95→最慢）。
 */

/** 状态色板（锁定稿 OWN-WORLD：电青/薄荷/琥珀/紫 + 紧张态珊瑚扩展；V2 仅水位环用青/琥珀/珊瑚） */
const CYAN = "#6ee7ff";
const AMBER = "#ffcf7a";
const CORAL = "#ff8f6b";

/** 迷你条/水位行的窗口短名 */
const WINDOW_SHORT = { "rolling-5h": "5h", weekly: "周", monthly: "月" };

/**
 * 通用数字格式：1 位小数并去掉尾随 0（舞台巨字口径：428.6、300）。
 * @param {number|null|undefined} n 数值
 * @returns {string|null} 非数值返回 null（视图渲染 "—"）
 */
export function fmt1(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const v = Math.round(n * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/**
 * token 体量格式：≥1e6 → "x.xM"；≥1e3 → "x.xK"；否则原值取整。
 * @param {number|null|undefined} n token 数
 * @returns {string|null}
 */
export function fmtTok(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  if (n >= 1e6) return (Math.round((n / 1e6) * 10) / 10).toFixed(1) + "M";
  if (n >= 1e3) return (Math.round((n / 1e3) * 10) / 10).toFixed(1) + "K";
  return String(Math.round(n));
}

/**
 * 额度重置文案：≤48h 给相对时长（"2h12m 后重置"），更远给绝对时刻（"MM-DD HH:mm 重置"）。
 * @param {number|null} nextResetMs 官方返回的重置时刻
 * @param {number} now 当前时刻
 * @param {string} windowType 窗口类型（无官方时刻时按类型给诚实兜底）
 * @param {boolean} tight 是否 ≥85%（紧张态加注）
 */
function resetText(nextResetMs, now, windowType, tight) {
  const tightSuffix = tight ? " · 余量紧张" : "";
  if (typeof nextResetMs !== "number" || !Number.isFinite(nextResetMs)) {
    // 官方未返回重置时刻：不编造日期，按窗口类型给兜底说明
    return windowType === "rolling-5h" ? `滚动窗口${tightSuffix}` : `订阅日重置${tightSuffix}`;
  }
  const remain = nextResetMs - now;
  if (remain > 0 && remain <= 48 * 3600000) {
    const h = Math.floor(remain / 3600000);
    const m = Math.floor((remain % 3600000) / 60000);
    return `${h}h${String(m).padStart(2, "0")}m 后重置${tightSuffix}`;
  }
  const d = new Date(nextResetMs);
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} 重置${tightSuffix}`;
}

/**
 * 已用百分比水位色（60/85 双信号阈值；百分比口径=已用）。
 * @param {number|null} pct 已用百分比
 * @returns {string} 色值
 */
function quotaColor(pct) {
  if (typeof pct !== "number") return CYAN;
  if (pct >= 85) return CORAL;
  if (pct >= 60) return AMBER;
  return CYAN;
}

// ---------------------------------------------------------------------------
// V2 展示模型（素条四态 + 面板四区）：素条文案以设计稿 §五.6 表格为唯一权威
// ---------------------------------------------------------------------------

/** 时刻文案：HH:MM（速率条「上次活动」口径，分钟粒度）；非法时刻返回 null */
function hmText(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 剩余时长文案（厂商行副行「剩 Nd Nh」口径）：≥24h 给天+时，不足一天沿用相对时长「NhNmm」。
 * @param {number} remainMs 剩余毫秒数（调用方保证 >0）
 * @returns {string} 如 "2d 4h" / "6h00m"
 */
function remainText(remainMs) {
  const h = Math.floor(remainMs / 3600000);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }
  const m = Math.floor((remainMs % 3600000) / 60000);
  return `${h}h${String(m).padStart(2, "0")}m`;
}

/**
 * 素条全局口径的焦点厂商额度：快照 rate.lastProviderId → quota 同名实例。
 * 会话作用域素条（修订 #1/#2）由 snap.focus 段接管，本函数仅服务 focus 缺省的全局/
 * 降级形态——生成中的水位段与空闲态跟随「最近请求厂商」，厂商名优先用 quota.name。
 * @param {object} snap Task 4 buildSnapshotV2 产物
 * @returns {object|null} 焦点实例的 quota 行；无最近请求或实例无额度配置返回 null
 */
function focusQuotaOf(snap) {
  const pid = snap?.rate?.lastProviderId;
  if (!pid) return null;
  return (snap?.quota ?? []).find((q) => q?.providerId === pid) ?? null;
}

/**
 * 焦点厂商额度头（tooltip 用）：枚举实例全部窗口「短名 pct%」，首窗口带官方重置说明
 * （≤48h 相对时长 / 更远绝对时刻；无官方时刻整体省略括注，不编造）。
 * 如「智谱 5h 73%（2h12m 后重置）· 周 41% · 月 12%」；无百分比的窗口跳过。
 * @param {object} focus 焦点实例 quota 行
 * @param {number} now 渲染时刻
 * @returns {string} 厂商名 + 窗口枚举（无任何百分比时仅厂商名）
 */
function quotaHeadOf(focus, now) {
  const name = focus.name ?? focus.providerId;
  const segs = (focus.windows ?? [])
    .map((w, i) => {
      if (typeof w?.percent !== "number") return null;
      let seg = `${WINDOW_SHORT[w.type] ?? w.type} ${Math.round(w.percent)}%`;
      // 首窗口重置说明：素条 tooltip 的关键信息之一，不可截断
      if (i === 0 && typeof w.nextResetMs === "number" && Number.isFinite(w.nextResetMs)) {
        seg += `（${resetText(w.nextResetMs, now, w.type, false)}）`;
      }
      return seg;
    })
    .filter(Boolean);
  if (segs.length === 0) return name;
  // 分隔符口径（设计 §五.6 逐字）：段尾是全角括号时后接「· 」，其余「 · 」
  let head = segs[0];
  for (let i = 1; i < segs.length; i++) head += `${head.endsWith("）") ? "· " : " · "}${segs[i]}`;
  return `${name} ${head}`;
}

/**
 * 素条四态（设计 §五.6 表格逐字；composer.status 插槽契约 text≤40 / tooltip≤200）：
 * ① 生成中·仅主代理「428 tok/s · 5h 73%」；② 主+子并行「428+96 tok/s · 5h 73%」（素条取合计）；
 * ③ 空闲「智谱 5h 73% · 周 41%」（首两个有百分比的窗口）；
 * ④ 无数据「ZPowerPack 待机」（刚装/未配 provider/尚无请求）。
 * tooltip：①②③=焦点厂商全窗口额度头 + 主子速率段 + 点击引导；④=固定引导文案。
 *
 * 取值口径二选一（2026-11-23 修订 #1/#2）：
 * - snap.focus 在位（会话作用域）：流=该会话的流（activate 按 events sessionId 过滤后的列表）、
 *   额度=该会话当前模型选择供应商的 quota 行（组合上下文 null 时由 activate 回退最近请求供应商）；
 * - focus 缺省（全局口径）：流=快照全量流、额度跟随最近请求厂商——与 V2 首版行为一致。
 * @param {object} snap Task 4 buildSnapshotV2 产物（可携带 activate 组装的 focus 段）
 * @param {number} now 渲染时刻
 * @returns {{text: string, tooltip: string}}
 */
function stripOf(snap, now) {
  const seg = snap?.focus ?? null;
  if (seg) {
    // 会话作用域：流与额度行已由 activate 按会话备好，这里只做文案映射（纯函数可 TDD）
    return stripOfSegments(Array.isArray(seg.streams) ? seg.streams : [], seg.quotaRow ?? null, now);
  }
  // 全局口径：有流即 live（live-rate snapshot 契约保证 state=live ⟺ streams 非空，双重判定冗余保留）
  const streams = Array.isArray(snap?.rate?.streams) ? snap.rate.streams : [];
  return stripOfSegments(snap?.rate?.state === "live" ? streams : [], focusQuotaOf(snap), now);
}

/**
 * 素条四态文案（流列表 + 焦点额度行 → text/tooltip；素条与 tooltip 的唯一取值逻辑）。
 * @param {object[]} streams 本口径下的活跃流（live 判定=列表非空）
 * @param {object|null} focus 焦点额度行（水位段与 tooltip 额度头的唯一来源；null=无额度数据不编造）
 * @param {number} now 渲染时刻
 * @returns {{text: string, tooltip: string}}
 */
function stripOfSegments(streams, focus, now) {
  if (streams.length > 0) {
    // 主/子速率合计：素条唯一实时数字，fmt1 一位小数去尾零（428.6→428.6、300→300）
    const mainTps = streams.reduce((s, x) => (x?.isSub ? s : s + (x?.tps ?? 0)), 0);
    const subTps = streams.reduce((s, x) => (x?.isSub ? s + (x?.tps ?? 0) : s), 0);
    const rateText = subTps > 0 ? `${fmt1(mainTps)}+${fmt1(subTps)}` : fmt1(mainTps);
    // 水位段：焦点厂商首窗口（额度契约排序，rolling-5h 在首）；无额度数据时省略，不编造水位
    const headWin = (focus?.windows ?? [])[0] ?? null;
    const headPct = typeof headWin?.percent === "number" ? Math.round(headWin.percent) : null;
    const head = headPct === null ? null : `${WINDOW_SHORT[headWin.type] ?? headWin.type} ${headPct}%`;
    const text = head === null ? `${rateText} tok/s` : `${rateText} tok/s · ${head}`;
    // 速率段：单流「主 428 tok/s」；并行「主 428 · 子 96 tok/s（N 路并行）」
    const rateSeg = subTps > 0 ? `主 ${fmt1(mainTps)} · 子 ${fmt1(subTps)} tok/s（${streams.length} 路并行）` : `主 ${fmt1(mainTps)} tok/s`;
    const tooltip = focus === null ? `${rateSeg} · 点击查看详情` : `${quotaHeadOf(focus, now)} · ${rateSeg} · 点击查看详情`;
    return { text, tooltip };
  }

  // ④ 无数据：无焦点额度行可跟 → 待机（刚装/未配 provider/该会话尚无请求）
  if (focus === null) return { text: "ZPowerPack 待机", tooltip: "ZPowerPack 用量速览 · 点击打开看板" };

  // ③ 空闲（含 recent：非生成中一律走水位文案）：首两个有百分比的窗口（≤40 字符约束）
  const name = focus.name ?? focus.providerId;
  const segs = (focus.windows ?? [])
    .filter((w) => typeof w?.percent === "number")
    .slice(0, 2)
    .map((w) => `${WINDOW_SHORT[w.type] ?? w.type} ${Math.round(w.percent)}%`);
  const text = segs.length > 0 ? `${name} ${segs.join(" · ")}` : name;
  // tooltip 同①去掉速率段：全窗口额度头 + 点击引导
  const tooltip = `${quotaHeadOf(focus, now)} · 点击查看详情`;
  return { text, tooltip };
}

/**
 * 面板速率条（事件驱动，唯一实时元素）：各活跃流并列显示；recent 给末次值 +「完成于 X 前」；
 * 空闲给「上次活动 HH:MM」；订阅不可达时兜底行直给最近完成行速率（§五.5 兜底链）。
 * @param {object} rate 快照 rate 段（Task 3 live-rate snapshot 形状）
 * @param {number} now 渲染时刻
 * @returns {{stateText: string, streams: Array<{modelId, tpsText, isSubText}>, totalText: string|null, lastActivityText: string|null}}
 */
function ratePanelOf(rate, now) {
  const streams = Array.isArray(rate.streams) ? rate.streams : [];
  const isLive = rate.state === "live" && streams.length > 0;
  const lastFinal = rate.lastFinal ?? null;
  const fallback = rate.fallback ?? null;
  // 最近数据行：final 末值与兜底完成行谁新取谁（订阅挂掉后由兜底行接管速率条）
  const lastData =
    lastFinal || fallback
      ? [lastFinal ? { tps: lastFinal.tps, at: lastFinal.at } : null, fallback ? { tps: fallback.tps, at: fallback.completedAt } : null]
          .filter(Boolean)
          .sort((a, b) => a.at - b.at)
          .pop()
      : null;

  // 各流并列显示：裸数字（单位由视图统一附加），子代理标注归属
  const rows = streams.map((s) => ({
    modelId: s?.modelId ?? "—",
    tpsText: fmt1(s?.tps ?? 0),
    isSubText: s?.isSub ? "子代理" : null,
  }));

  // 合计/末值/兜底：live 合计；recent 末次值；空闲仅兜底链给值（不显示过期速率）
  let totalText = null;
  if (isLive) {
    const total = typeof rate.totalTps === "number" ? rate.totalTps : streams.reduce((s, x) => s + (x?.tps ?? 0), 0);
    totalText = `${fmt1(total)} tok/s`;
  } else if (rate.state === "recent") {
    totalText = lastData === null ? null : `${fmt1(lastData.tps)} tok/s`;
  } else if (fallback) {
    totalText = `${fmt1(fallback.tps)} tok/s`;
  }

  // 活动时刻：live 不给（速率即当下）；recent「完成于 Xs 前」；空闲「上次活动 HH:MM」
  let lastActivityText = null;
  const activityAt = Math.max(rate.lastEventAt ?? 0, lastFinal?.at ?? 0, fallback?.completedAt ?? 0);
  if (!isLive && activityAt > 0) {
    if (rate.state === "recent" && lastData) {
      const sec = Math.max(0, Math.round((now - lastData.at) / 1000));
      lastActivityText = sec < 60 ? `完成于 ${sec}s 前` : `完成于 ${Math.round(sec / 60)}m 前`;
    } else {
      const hm = hmText(activityAt);
      lastActivityText = hm === null ? null : `上次活动 ${hm}`;
    }
  }

  return { stateText: isLive ? "生成中" : rate.state === "recent" ? "刚完成" : "空闲", streams: rows, totalText, lastActivityText };
}

/**
 * 面板厂商行：每实例一行，环=5h 已用%（60/85 双阈值语义色），按 5h 水位降序（最紧张最上）。
 * 状态句=官方重置时刻（相对 ≤48h / 绝对更远 / 无值诚实兜底，≥85 沿用「余量紧张」加注）；
 * 副行=次级窗口（周/月）并列剩余时长，仅百分比时给「已用」标注。
 * @param {object[]} quotaRows 快照 quota 段（V1 透传形状，首窗口即 rolling-5h）
 * @param {number} now 渲染时刻
 * @returns {Array<{name, ringPct, ringColor, statusText, subText, percents}>}
 */
function vendorsOf(quotaRows, now) {
  const rows = (quotaRows ?? []).map((q) => {
    const windows = Array.isArray(q?.windows) ? q.windows : [];
    // 环与排序水位：首窗口（额度契约排序，rolling-5h 在首）
    const head = windows[0] ?? null;
    const headShort = head === null ? null : WINDOW_SHORT[head.type] ?? head.type;
    const ringPct = typeof head?.percent === "number" ? Math.round(head.percent) : null;
    // 状态句：紧张态（≥85）加注沿用 V1 口径；无官方时刻给诚实兜底，不编造日期
    const statusText = head === null ? null : `${headShort} · ${resetText(head.nextResetMs, now, head.type, ringPct !== null && ringPct >= 85)}`;
    // 副行：官方 resetsAt → 剩余时长；仅 percent → 已用标注；两者皆无的窗口跳过
    const subText =
      windows
        .slice(1)
        .map((w) => {
          const short = WINDOW_SHORT[w?.type] ?? w?.type;
          if (typeof w?.nextResetMs === "number" && Number.isFinite(w.nextResetMs) && w.nextResetMs > now) {
            return `${short} · 剩 ${remainText(w.nextResetMs - now)}`;
          }
          return typeof w?.percent === "number" ? `${short} · 已用 ${Math.round(w.percent)}%` : null;
        })
        .filter(Boolean)
        .join(" · ") || null;
    // 右侧百分比枚举：实例全部窗口（OpenCode 三枚）
    const percents = windows.map((w) => ({
      label: WINDOW_SHORT[w?.type] ?? w?.type,
      pct: typeof w?.percent === "number" ? Math.round(w.percent) : null,
    }));
    return { name: q.name ?? q.providerId, ringPct, ringColor: quotaColor(ringPct), statusText, subText, percents };
  });
  // 5h 水位降序；无 5h 数据的实例沉底（不编造水位参与排序）
  rows.sort((a, b) => (b.ringPct ?? -1) - (a.ringPct ?? -1));
  return rows;
}

/**
 * 面板趋势区：小时桶 24 点 → 序号坐标折线（x=序号，y=token 数）；foot 给诚实累计。
 * @param {object[]} trend Task 2 trendPoints 产物（固定 24 点升序，空桶补 0）
 * @returns {{points: Array<{x: number, y: number}>, footText: string}}
 */
function trendOf(trend) {
  const points = (Array.isArray(trend) ? trend : []).map((p, i) => ({
    x: i,
    y: typeof p?.tokens === "number" ? p.tokens : 0,
  }));
  const total = points.reduce((s, p) => s + p.y, 0);
  return {
    points,
    footText: total > 0 ? `近 24 小时 · 累计 ${fmtTok(total)} token` : "近 24 小时 · 暂无消耗",
  };
}

/**
 * 面板结论句：Task 4 线性外推产物只做措辞——pctAtReset>100 撑不到，≤100 撑得到；
 * null（样本 <5 或增量 ≈0）给占位不编造；「推算」标注为诚实语言（非精确预言）。
 * @param {object|null} conclusion 快照 conclusion 段（Task 4 computeConclusion 产物）
 * @returns {{text: string}}
 */
function conclusionOf(conclusion) {
  if (!conclusion || typeof conclusion !== "object") return { text: "消耗速度尚不足以推算" };
  const verdict = typeof conclusion.pctAtReset === "number" && conclusion.pctAtReset > 100 ? "撑不到" : "撑得到";
  return { text: `按近半小时速度，${conclusion.instanceName ?? "当前实例"} 5h ${verdict}重置（推算）` };
}

/**
 * 面板速率段的会话过滤（2026-11-23 修订 #1 面板作用域承接）：
 * 按 requestId→sessionId 归属映射把流列表收窄到指定会话，并按过滤后的流重算合计，
 * 防止面板巨字串入他会话速率；其余字段（state/lastFinal/fallback）保持快照原样——
 * final 事件后归属映射即删（T6 reqSession 口径），末值无法按会话归属，不做猜测。
 * @param {object} rate 快照 rate 段
 * @param {{sessionId?: string, reqSession?: Map<string, string>}} [opts]
 *        sessionId=调用方视图所属会话（无则全局口径）；reqSession=requestId→sessionId 归属映射
 * @returns {object} 过滤后的 rate 段（缺省会话时原样返回）
 */
function scopedRateOf(rate, opts) {
  const sessionId = typeof opts?.sessionId === "string" ? opts.sessionId : null;
  if (sessionId === null) return rate;
  const reqSession = opts?.reqSession;
  const streams = (Array.isArray(rate?.streams) ? rate.streams : []).filter(
    (s) => reqSession instanceof Map && reqSession.get(s?.requestId) === sessionId,
  );
  // 合计随过滤后的流重算：live 态下视图巨字直接消费 totalTps
  const totalTps = streams.reduce((sum, s) => sum + (typeof s?.tps === "number" ? s.tps : 0), 0);
  return { ...rate, streams, totalTps };
}

/**
 * V2 快照 → 展示模型（唯一入口）：素条四态（composer.status 承载，宿主渲染无样式自由度）
 * + 面板四区（速率条/厂商行/趋势/结论）。全部输出为可直接 innerText/样式绑定的值。
 * snap.focus 为可选段（2026-11-23 修订 #1/#2，activate 按「聚焦会话」组装）：
 * {sessionId, modelId, providerId, quotaRow, streams}——在位时素条只取该段（该会话的流
 * 与该会话当前模型选择供应商的额度行），面板四区默认仍走全局快照。
 * @param {object} snap Task 4 buildSnapshotV2 产物（{generatedAt, rate, quota, trend, conclusion, focus?}）
 * @param {number} now 当前时刻（渲染时刻）
 * @param {{sessionId?: string, reqSession?: Map<string, string>}} [opts] 面板会话作用域
 *        （修订 #1）：sessionId 在位时 panel.rate 的流只保留该会话（reqSession 归属映射），
 *        其余区（vendors/trend/conclusion）不受影响；缺省 → 全局口径（现行行为）
 * @returns {object} {strip: {text, tooltip}, panel: {rate, vendors, trend, conclusion}}
 */
export function toDisplayModelV2(snap, now, opts) {
  return {
    strip: stripOf(snap, now),
    panel: {
      rate: ratePanelOf(scopedRateOf(snap?.rate ?? {}, opts), now),
      vendors: vendorsOf(snap?.quota ?? [], now),
      trend: trendOf(snap?.trend ?? []),
      conclusion: conclusionOf(snap?.conclusion ?? null),
    },
  };
}
