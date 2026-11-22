/**
 * 官方分母获取：按厂商官方 usage 接口取限额/百分比，失败回退用户配置（V6 调研路由表）。
 *
 * 路由表来源（2026-11-22 调研，证据等级 A2）：智谱 quota/limit（bigmodel 站裸 key、zai 站 Bearer）、
 * Kimi coding/v1/usages（Bearer，新代际仅 used_ratio、旧代际字符串绝对值）、
 * OpenCode zen/go/v1/usage（Bearer，仅 percent）。
 *
 * 密钥纪律：apiKeyRef 为内存引用，仅用于本次请求头，用后即弃；任何日志/错误信息不得出现密钥值。
 */

/** 官方路由表：family + templateId 前缀 → {url, auth: "raw"|"bearer"}（未证实的家族不进表 → 不发请求） */
const OFFICIAL_ROUTES = [
  { family: "zhipu", templatePrefix: "bigmodel-", url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit", auth: "raw" },
  { family: "zhipu", templatePrefix: "zai-", url: "https://api.z.ai/api/monitor/usage/quota/limit", auth: "bearer" },
  { family: "kimi", templatePrefix: "kimi-", url: "https://api.kimi.com/coding/v1/usages", auth: "bearer" },
  { family: "opencode", templatePrefix: "opencode-", url: "https://opencode.ai/zen/go/v1/usage", auth: "bearer" },
];

/** 带超时的请求：超时视为失败（回退用户配置），不悬挂 */
async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      fetchImpl(url, options),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("官方接口超时")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 取额度分母/百分比。
 * @param {{family: string, templateId: string, apiKeyRef: string, rule: {type: string},
 *          userLimit: number|null, fetchImpl?: Function, timeoutMs?: number, log?: Function}} opts
 *          apiKeyRef 为内存引用（不落日志）；userLimit 为用户配置的兜底分母（可 null）
 * @returns {Promise<{limit: number|null, percent: number|null, nextResetMs: number|null,
 *                     source: "official"|"user-config"|"unavailable"}>}
 *          official=官方接口数据可用（绝对分母或百分比二者其一）；两者皆无时依次回退用户配置/不可用
 */
export async function fetchLimit(opts) {
  const { family, templateId, apiKeyRef, rule, userLimit } = opts;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const log = opts.log ?? (() => {});

  // 无官方路由的家族（如 deepseek/未证实分母的厂商）：不发请求，直接兜底
  const route = OFFICIAL_ROUTES.find((r) => r.family === family && templateId?.startsWith(r.templatePrefix));
  if (!route) {
    log(`[额度] ${family}/${templateId} 无已证实的官方分母接口，使用${userLimit ? "用户配置" : "不可用"}（rolling 窗口类型 ${rule?.type}）`);
    return fallback(userLimit, "user-config");
  }

  try {
    // 密钥仅在此处进入请求头，用后即弃；日志只记端点与窗口类型
    const headers = { Accept: "application/json", Authorization: route.auth === "bearer" ? `Bearer ${apiKeyRef}` : apiKeyRef };
    const res = await fetchWithTimeout(fetchImpl, route.url, { headers }, timeoutMs);
    if (!res.ok) {
      log(`[额度] ${family}/${templateId} 官方接口 HTTP ${res.status}，回退用户配置（窗口 ${rule?.type}）`);
      return fallback(userLimit, "user-config");
    }
    const body = await res.json();
    const parsed = parseOfficial(family, templateId, body, rule);
    if (parsed) {
      return {
        limit: typeof parsed.limit === "number" ? parsed.limit : null,
        percent: typeof parsed.percent === "number" ? Math.round(parsed.percent * 10) / 10 : null,
        nextResetMs: typeof parsed.nextResetMs === "number" ? parsed.nextResetMs : null,
        source: "official",
      };
    }
    // 响应结构不符（schema 演进/接口变更）→ 兜底
    log(`[额度] ${family}/${templateId} 官方响应无法解析（窗口 ${rule?.type}），回退用户配置`);
    return fallback(userLimit, "user-config");
  } catch (e) {
    log(`[额度] ${family}/${templateId} 官方接口失败（${e.name || "异常"}），回退用户配置（窗口 ${rule?.type}）`);
    return fallback(userLimit, "user-config");
  }
}

/** 兜底结果构造 */
function fallback(userLimit, source) {
  if (typeof userLimit === "number" && userLimit > 0) return { limit: userLimit, percent: null, nextResetMs: null, source };
  return { limit: null, percent: null, nextResetMs: null, source: "unavailable" };
}

/**
 * 按厂商解析官方响应 → {limit?, percent?, nextResetMs?}；无法解析返回 null。
 * 所有计数按 V6 结论做防御处理：Kimi 计数为字符串、字段可能缺失。
 */
function parseOfficial(family, templateId, body, rule) {
  if (family === "zhipu") return parseZhipu(body, rule);
  if (family === "kimi") return parseKimi(body, rule);
  if (family === "opencode") return parseOpencode(body, rule);
  return null;
}

/** 智谱：data.limits[]，5h=TOKENS_LIMIT&unit 3&number 5，周=unit 6；limit=usage+remaining（ credits 口径） */
function parseZhipu(body, rule) {
  const limits = body?.data?.limits;
  if (!Array.isArray(limits)) return null;
  const want = rule?.type === "weekly" ? (l) => l.type === "TOKENS_LIMIT" && l.unit === 6 : (l) => l.type === "TOKENS_LIMIT" && l.unit === 3 && l.number === 5;
  const hit = limits.find(want);
  if (!hit) return null;
  const limit =
    typeof hit.usage === "number" && typeof hit.remaining === "number" ? hit.usage + hit.remaining : null;
  return {
    limit,
    percent: typeof hit.percentage === "number" ? hit.percentage : null,
    nextResetMs: typeof hit.nextResetTime === "number" ? hit.nextResetTime : null,
  };
}

/** Kimi：新代际 usages map（仅比率）优先，旧代际 usage/limits（字符串绝对值）回退 */
function parseKimi(body, rule) {
  const keyByRule = { "rolling-5h": "limit_5h", weekly: "limit_7d", monthly: "limit_month_code" };
  const key = keyByRule[rule?.type];
  // 新代际：usages.<key>.used_ratio（0~1）
  const nu = key && body?.usages?.[key];
  if (nu && typeof nu.used_ratio === "number") {
    return { limit: null, percent: nu.used_ratio * 100, nextResetMs: nu.reset_time ? Date.parse(nu.reset_time) || null : null };
  }
  // 旧代际：limits[] 按 window 匹配（300 分钟=5h；TIME_UNIT_DAY 30=月），detail.limit 字符串绝对值
  const isMonthly = rule?.type === "monthly";
  const hit = Array.isArray(body?.limits)
    ? body.limits.find((l) =>
        isMonthly
          ? l?.window?.timeUnit === "TIME_UNIT_DAY" && Number(l?.window?.duration) >= 28
          : l?.window?.timeUnit === "TIME_UNIT_MINUTE" && Number(l?.window?.duration) <= 600,
      )
    : null;
  if (hit?.detail) {
    const limit = Number(hit.detail.limit ?? (Number(hit.detail.used) + Number(hit.detail.remaining)));
    const used = Number(hit.detail.used ?? (Number(hit.detail.limit) - Number(hit.detail.remaining)));
    return {
      limit: Number.isFinite(limit) && limit > 0 ? limit : null,
      percent: Number.isFinite(limit) && limit > 0 && Number.isFinite(used) ? (used / limit) * 100 : null,
      nextResetMs: hit.detail.resetTime ? Date.parse(hit.detail.resetTime) || null : null,
    };
  }
  // 更旧的 usage{limit, used} 形态
  if (body?.usage?.limit !== undefined) {
    const limit = Number(body.usage.limit);
    const used = Number(body.usage.used);
    if (Number.isFinite(limit) && limit > 0) {
      return {
        limit,
        percent: Number.isFinite(used) ? (used / limit) * 100 : null,
        nextResetMs: body.usage.resetTime ? Date.parse(body.usage.resetTime) || null : null,
      };
    }
  }
  return null;
}

/** OpenCode：usage.{rolling|weekly|monthly} 仅 percent + resetsAt（无绝对分母，V6 明确） */
function parseOpencode(body, rule) {
  const usage = body?.usage;
  if (!usage || typeof usage !== "object") return null;
  const keyByRule = { "rolling-5h": "rolling", weekly: "weekly", monthly: "monthly" };
  const hit = usage[keyByRule[rule?.type]];
  if (!hit || typeof hit.percent !== "number") return null;
  return {
    limit: null,
    percent: hit.percent,
    nextResetMs: hit.resetsAt ? Date.parse(hit.resetsAt) || null : null,
  };
}
