/**
 * 看板展示模型 V2：快照 → 前端可直渲染的展示 JSON（纯函数，无 IO/无 DOM）。
 *
 * 背景：宿主对 entry 形态视图只伺服 pageUri 与注册资源（探针实证），视图必须单文件
 * 自包含 → 文案映射/阈值/格式化全部上移到本模块（Node 侧可 TDD），沙箱内联脚本仅做
 * 哑绑定。V2 构图权威=设计稿 §五（卡片四区 + 常驻素条），素条四态逐字文案以 §五.6
 * 表格为唯一权威；界面禁 P50/P95 行话（历史拍板，映射规则：P50→典型/多数，P95→最慢）。
 * V1 导出 toDisplayModel/ttftHistogram 为退役过渡件（main.js 仍在导入，见各自注释）。
 */

/** 状态色板（锁定稿 OWN-WORLD：电青/薄荷/琥珀/紫 + 紧张态珊瑚扩展） */
const CYAN = "#6ee7ff";
const MINT = "#34e3a2";
const AMBER = "#ffcf7a";
const PURPLE = "#a78bfa";
const CORAL = "#ff8f6b";
/** 报表行循环用色（按行序取色，与锁定稿四色一致） */
const ROW_PALETTE = [CYAN, MINT, AMBER, PURPLE];

/** 额度窗口中文名（宿主窗口类型 → 锁定稿文案） */
const WINDOW_LABELS = { "rolling-5h": "5 小时窗口", weekly: "本周额度", monthly: "本月额度" };
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
 * 报表数字格式：≥100 取整（108.2→108），<100 保留 1 位（88.7→88.7）——与锁定稿样例一致。
 * @param {number|null|undefined} n 数值
 * @returns {string|null}
 */
export function fmtSmart(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return n >= 100 ? String(Math.round(n)) : fmt1(n);
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

/** 时刻文案：HH:MM:SS（本地时区）；非法时刻返回 null */
function timeText(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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

/** 额度来源标注（官方接口/用户配置/不可用 → 锁定稿三种标签） */
function srcLabelOf(source) {
  if (source === "official") return "官方余量";
  if (source === "user") return "分母已配置";
  return "未配置分母";
}

// 退役：Task 4 切换导入，Task 8 清零
/**
 * 首字等待直方图分桶：以缓冲区内带 timeToFirstTokenMs 的完成行为底，10 桶计数后归一化为高度百分比。
 * @param {object[]} rows 环形缓冲行（含 timeToFirstTokenMs 的进桶）
 * @returns {number[]} 长度 10 的百分比数组；无数据返回 []
 */
export function ttftHistogram(rows) {
  const values = rows
    .map((r) => (typeof r?.timeToFirstTokenMs === "number" ? r.timeToFirstTokenMs : null))
    .filter((v) => v !== null && v >= 0);
  if (values.length === 0) return [];
  const max = Math.max(...values) || 1;
  const buckets = new Array(10).fill(0);
  for (const v of values) buckets[Math.min(9, Math.floor((v / max) * 10))]++;
  const peak = Math.max(...buckets);
  return buckets.map((c) => (peak ? Math.round((c / peak) * 100) : 0));
}

// 退役：Task 4 切换导入，Task 8 清零
/**
 * 快照 → 展示模型（V1 入口；全部输出为可直接 innerText/样式绑定的值）。
 * @param {object} snap buildSnapshot 产物
 * @param {number} now 当前时刻（渲染时刻）
 * @returns {object} 展示模型（stage/quota/grid/dock/mini）
 */
export function toDisplayModel(snap, now) {
  const rate = snap?.rate ?? {};
  const display = rate.display ?? {};
  const isLive = display.state === "live";

  // ---- 舞台：巨字 + 主/子分列 + 三态徽标 ----
  const valueText = isLive || (typeof display.value === "number" && display.value > 0) ? fmt1(display.value) ?? "—" : "—";
  let badgeText = null;
  if (display.state === "held") badgeText = `保持上次速度 · 长请求在飞 · 数据时刻 ${timeText(display.asOf) ?? "—"}`;
  if (display.state === "idle") badgeText = display.asOf ? `空闲 · 上次活动 ${timeText(display.asOf)}` : "空闲 · 尚无数据";

  const stage = {
    state: display.state ?? "idle",
    valueText,
    main: fmt1(rate.main?.genRate),
    subagent: fmt1(rate.subagent?.genRate),
    asOfText: `数据时刻 ${timeText(isLive ? now : display.asOf) ?? "—"}`,
    badgeText,
  };

  // ---- 额度水位行：实例 × 窗口（条/百分比/重置说明；双信号阈值） ----
  const quotaRows = (snap?.quota ?? []).map((q) => ({
    name: q.name ?? q.providerId,
    srcLabel: srcLabelOf(q.source),
    needsConfig: (q.windows ?? []).some((w) => w.source !== "official" && w.limit == null),
    windows: (q.windows ?? []).map((w) => {
      const pct = typeof w.percent === "number" ? Math.round(w.percent) : null;
      const color = quotaColor(pct);
      return {
        label: WINDOW_LABELS[w.type] ?? w.type,
        pct,
        barColor: color,
        // 已用口径的补充说明：分母已知给已用体量，未知省略（不编造）
        usedText: typeof w.used === "number" && typeof w.limit === "number" ? `已用 ${fmtTok(w.used)}` : null,
        footText: resetText(w.nextResetMs, now, w.type, typeof pct === "number" && pct >= 85),
      };
    }),
  }));

  const quota = {
    rows: quotaRows,
    emptyText: quotaRows.length === 0 ? "未发现 provider 配置，额度卡待配置后可用" : null,
  };

  // ---- 速度对比（P50→典型、P95→最慢；白刻度=最慢，亮段=典型） ----
  const throughput = [...(snap?.charts?.throughput ?? [])]
    .filter((t) => typeof t.tpsP50 === "number")
    .sort((a, b) => b.tpsP50 - a.tpsP50);
  const maxP95 = Math.max(...throughput.map((t) => t.tpsP95 ?? 0), 1);
  const speed = {
    hasData: throughput.length > 0,
    rows: throughput.map((t, i) => ({
      label: t.modelId,
      widthPct: Math.round((t.tpsP50 / maxP95) * 100),
      markerLeft: Math.round(((t.tpsP95 ?? t.tpsP50) / maxP95) * 100),
      color: ROW_PALETTE[i % ROW_PALETTE.length],
      valueText: `${fmtSmart(t.tpsP50)}/${fmtSmart(t.tpsP95)}`,
    })),
    foot: "亮段=典型速度 · 白刻度=慢的时候",
    // 下钻一：实时按模型速率（60s 窗口口径）
    detail: (rate.byModel ?? []).map((m) => ({
      modelId: m.modelId,
      genRateText: fmt1(m.genRate),
    })),
  };

  // ---- 首字等待：真实分布直方图 + 多数/最慢 foot（术语映射） ----
  // 直方图计数归一化为高度百分比（峰值桶=100，与锁定稿视觉比例一致）
  const histRaw = Array.isArray(snap?.charts?.ttftHist) ? snap.charts.ttftHist : [];
  const histPeakRaw = Math.max(...histRaw, 0);
  const hist = histPeakRaw > 0 ? histRaw.map((c) => Math.round((c / histPeakRaw) * 100)) : [];
  const ttftRows = snap?.charts?.latency ?? [];
  const p50s = ttftRows.map((l) => l.ttftP50).filter((x) => typeof x === "number");
  const p95Max = Math.max(...ttftRows.map((l) => l.ttftP95).filter((x) => typeof x === "number"), 0);
  const ttft = {
    hasData: hist.length > 0,
    hist,
    foot:
      p50s.length > 0
        ? `多数 ${Math.round(Math.min(...p50s) / 1000)}–${Math.round(Math.max(...p50s) / 1000)} 秒 · 最慢约 ${fmt1(p95Max / 1000)} 秒`
        : "暂无首字等待数据",
  };

  // ---- 上下文→速率：散点 + 首末分位降幅 foot（诚实计算，样本不足不编结论） ----
  const scatter = (snap?.charts?.ctxVsRate ?? []).slice().sort((a, b) => a.inputTokens - b.inputTokens);
  const maxIn = Math.max(...scatter.map((d) => d.inputTokens), 1);
  const maxTps = Math.max(...scatter.map((d) => d.tps), 1);
  let ctxFoot = "样本积累中，暂不足以判断";
  if (scatter.length >= 3) {
    const head = scatter.slice(0, Math.max(1, Math.floor(scatter.length / 3)));
    const tail = scatter.slice(-Math.max(1, Math.floor(scatter.length / 3)));
    const avg = (arr) => arr.reduce((s, x) => s + x.tps, 0) / arr.length;
    const first = avg(head);
    const last = avg(tail);
    if (first > 0 && last < first) ctxFoot = `接近上限时约降 ${Math.round(((first - last) / first) * 100)}%`;
  }
  const ctx = {
    hasData: scatter.length >= 3,
    dots: scatter.map((d) => ({
      left: Math.max(1, Math.min(98, Math.round((d.inputTokens / maxIn) * 100))),
      top: Math.max(2, Math.min(92, Math.round((1 - d.tps / maxTps) * 100))),
    })),
    foot: ctxFoot,
  };

  // ---- 时段热力：7×24 聚合 24 小时列 + h0-h3 分级 + 峰值 foot ----
  const heat7x24 = snap?.charts?.heatmap ?? [];
  const hourTotals = new Array(24).fill(0);
  let heatTotal = 0;
  for (const day of heat7x24) {
    if (!Array.isArray(day)) continue;
    day.forEach((v, h) => {
      hourTotals[h] += typeof v === "number" ? v : 0;
      heatTotal += typeof v === "number" ? v : 0;
    });
  }
  const heatMax = Math.max(...hourTotals, 0);
  const peakHour = hourTotals.indexOf(heatMax);
  const levelOf = (v) => (v <= 0 ? "h0" : v <= heatMax / 3 ? "h1" : v <= (heatMax * 2) / 3 ? "h2" : "h3");
  const heat = {
    hasData: heatMax > 0,
    cells: hourTotals.map((v) => ({ level: levelOf(v) })),
    foot: heatMax > 0 ? `峰值 ${String(peakHour).padStart(2, "0")}:00–${String(peakHour).padStart(2, "0")}:59 · 累计 ${fmtTok(heatTotal)} token` : "暂无时段数据",
  };

  // ---- 按项目消耗（24h 环形缓冲底座） ----
  const projects = (snap?.charts?.byProject ?? []).slice(0, 6);
  const maxTok = Math.max(...projects.map((p) => p.tokens), 1);
  const grid = {
    speed,
    ttft,
    ctx,
    heat,
    projects: {
      hasData: projects.length > 0,
      rows: projects.map((p, i) => ({
        label: p.project,
        widthPct: Math.round((p.tokens / maxTok) * 100),
        color: ROW_PALETTE[i % ROW_PALETTE.length],
        valueText: fmtTok(p.tokens),
      })),
      foot: "近 24 小时 · subagent 归入父项目",
    },
    // 谁家更稳：失败率行 + 悬停重试率（快照契约自带 errorRate/retryRate，直接消费）
    health: {
      hasData: (snap?.charts?.providerHealth ?? []).length > 0,
      rows: (snap?.charts?.providerHealth ?? [])
        .slice()
        .sort((a, b) => (a.errorRate ?? 0) - (b.errorRate ?? 0))
        .map((h) => {
          const pct = (h.errorRate ?? 0) * 100;
          const retryPct = (h.retryRate ?? 0) * 100;
          return {
            label: h.providerId,
            widthPct: Math.max(2, Math.round(pct * 4)),
            color: pct < 1 ? MINT : pct < 3 ? AMBER : CORAL,
            valueText: `${(Math.round(pct * 10) / 10).toFixed(1)}%`,
            hover: `失败率 ${(Math.round(pct * 10) / 10).toFixed(1)}% · 重试率 ${(Math.round(retryPct * 10) / 10).toFixed(1)}%`,
          };
        }),
      foot: "失败率 · 悬停看重试率",
    },
    // 下钻二数据：工具调用统计（按频次）
    tools: (snap?.charts?.toolStats ?? []).slice(0, 8).map((t) => ({
      label: t.toolName,
      calls: t.calls,
      errors: t.errors,
      avgMs: t.avgDurationMs,
    })),
  };

  // ---- 迷你条与视图内 dock：跟随最近请求厂商 ----
  const lastProviderId = rate.lastProviderId ?? null;
  const lastSnapQuota = (snap?.quota ?? []).find((q) => q.providerId === lastProviderId);
  const providerName = lastSnapQuota?.name ?? lastProviderId;
  const providerWindows = (lastSnapQuota?.windows ?? []).map((w) => {
    const pct = typeof w.percent === "number" ? Math.round(w.percent) : null;
    return { shortLabel: WINDOW_SHORT[w.type] ?? w.type, pct, barColor: quotaColor(pct), footText: resetText(w.nextResetMs, now, w.type, typeof pct === "number" && pct >= 85) };
  });

  const dock = {
    providerName: providerName ?? "—",
    rateText: `${valueText} tok/s`,
    windows: providerWindows,
    followNote: "跟随最近请求的厂商",
  };

  // 迷你条文本 ≤40：速率 + 厂商 + 第一个窗口水位；无额度窗口（厂商不在规则表内）仍显示速率
  // tooltip 给厂商全名与窗口明细；徽标仅 live 态发 dot（活动指示）
  let mini = { text: "ZPowerPack 待机 · 等待新请求", tooltip: "ZPowerPack 用量速览", badge: null };
  if (lastProviderId) {
    const w0 = providerWindows[0] ?? null;
    const stateMark = isLive ? "" : display.state === "held" ? "保持 " : "待机 ";
    mini = {
      text: w0
        ? `${stateMark}${valueText} tok/s · ${lastProviderId} ${w0.shortLabel} ${w0.pct ?? "?"}%`
        : `${stateMark}${valueText} tok/s · ${lastProviderId}`,
      tooltip: w0
        ? `${providerName} · ${w0.shortLabel}窗口 ${w0.pct ?? "?"}%（${w0.footText}）` +
          (providerWindows[1] ? ` · ${providerWindows[1].shortLabel} ${providerWindows[1].pct ?? "?"}%` : "")
        : `${providerName} · 暂无额度窗口`,
      badge: isLive ? "dot" : null,
    };
  }

  return {
    generatedAt: snap?.generatedAt ?? null,
    now,
    stage,
    quota,
    grid,
    dock,
    mini,
  };
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
 * 素条/面板共同跟随的焦点厂商额度：快照 rate.lastProviderId → quota 同名实例。
 * 设计定案：生成中的水位段与空闲态都跟随「最近请求厂商」，厂商名优先用 quota.name。
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
 * ③ 空闲「智谱 5h 73% · 周 41%」（跟随最近请求厂商，首两个有百分比的窗口）；
 * ④ 无数据「ZPowerPack 待机」（刚装/未配 provider/尚无请求）。
 * tooltip：①②③=焦点厂商全窗口额度头 + 主子速率段 + 点击引导；④=固定引导文案。
 * @param {object} snap Task 4 buildSnapshotV2 产物
 * @param {number} now 渲染时刻
 * @returns {{text: string, tooltip: string}}
 */
function stripOf(snap, now) {
  const rate = snap?.rate ?? {};
  const streams = Array.isArray(rate.streams) ? rate.streams : [];
  const focus = focusQuotaOf(snap);

  if (rate.state === "live" && streams.length > 0) {
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

  // ④ 无数据：无最近请求厂商可跟随 → 待机（刚装/未配 provider）
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
 * V2 快照 → 展示模型（唯一入口）：素条四态（composer.status 承载，宿主渲染无样式自由度）
 * + 面板四区（速率条/厂商行/趋势/结论）。全部输出为可直接 innerText/样式绑定的值。
 * @param {object} snap Task 4 buildSnapshotV2 产物（{generatedAt, rate, quota, trend, conclusion}）
 * @param {number} now 当前时刻（渲染时刻）
 * @returns {object} {strip: {text, tooltip}, panel: {rate, vendors, trend, conclusion}}
 */
export function toDisplayModelV2(snap, now) {
  return {
    strip: stripOf(snap, now),
    panel: {
      rate: ratePanelOf(snap?.rate ?? {}, now),
      vendors: vendorsOf(snap?.quota ?? [], now),
      trend: trendOf(snap?.trend ?? []),
      conclusion: conclusionOf(snap?.conclusion ?? null),
    },
  };
}
