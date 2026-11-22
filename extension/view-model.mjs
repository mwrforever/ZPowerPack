/**
 * 看板展示模型：快照 → 前端可直渲染的展示 JSON（纯函数，无 IO/无 DOM）。
 *
 * 背景（Task 8 Ruling）：宿主对 entry 形态视图只伺服 pageUri 与注册资源（探针实证），
 * 视图必须单文件自包含 → 文案映射/阈值/格式化全部上移到本模块（Node 侧可 TDD），
 * 沙箱内联脚本仅做哑绑定。锁定稿「聚焦主屏」为构图权威；界面禁 P50/P95 术语，
 * 映射规则：P50→典型/多数，P95→最慢。
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

/**
 * 快照 → 展示模型（唯一入口；全部输出为可直接 innerText/样式绑定的值）。
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
