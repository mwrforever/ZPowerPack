/**
 * provider 实例自动发现与模板对照（不硬编码厂商清单）。
 *
 * 数据源（V5/E6 已验证）：
 * - 实例：~/.zcode/v2/provider_config.json 的 config.providerConfigRules.providerRules[]
 *   （providerId/templateId/providerName/config.access.type/apiKey——apiKey 仅在本模块引用，绝不外泄）；
 * - 模板：~/.zcode/v2/runtime/provider/<平台>/<版本>/endpoint-<hash>/zcode-builtin.json 的
 *   config.providerConfigRules.templateRules[]（CDN 下发，字段缺失需容错）。
 * 家族归类供额度窗口规则表路由（window-rules.json 以 templateFamily|templateId 为键）。
 */

import { existsSync, readFileSync } from "node:fs";

/** 去除文本可能存在的 UTF-8 BOM */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 安全解析 JSON：缺文件/非法 JSON 返回 null（调用方按空数据处理，防御性解析） */
function parseJsonSafe(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(stripBom(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/**
 * 枚举用户配置的 provider 实例。
 * @param {string} v2ProviderConfigPath provider_config.json 路径
 * @returns {Array<{providerId: string, templateId: string, providerName: string, accessType: string}>}
 *          文件缺失/非法/无实例 → 空数组（warn 由调用层打）；结果不含任何 apiKey 值
 */
export function discoverInstances(v2ProviderConfigPath) {
  const doc = parseJsonSafe(v2ProviderConfigPath);
  if (!doc) return [];
  const rules = doc?.config?.providerConfigRules?.providerRules;
  if (!Array.isArray(rules)) return [];
  const out = [];
  for (const r of rules) {
    if (!r || typeof r.providerId !== "string") continue;
    out.push({
      providerId: r.providerId,
      templateId: typeof r.templateId === "string" ? r.templateId : null,
      providerName: typeof r.providerName === "string" ? r.providerName : r.providerId,
      accessType: typeof r?.config?.access?.type === "string" ? r.config.access.type : null,
      // 刻意不携带 apiKey：额度分母请求需要时由 quota-fetch 在内存中即时取用（Task 6），不进任何中间结构
    });
  }
  return out;
}

/**
 * 对照模板清单：templateId → {name, baseUrl, apiType, models}。
 * @param {string} builtinJsonPath zcode-builtin.json 路径
 * @returns {Map<string, {name: string, baseUrl: string|null, apiType: string|null, models: string[]}>}
 *          文件缺失/非法/无模板 → 空 Map；模板缺 api 段 → baseUrl/apiType 为 null 不抛错
 */
export function loadTemplates(builtinJsonPath) {
  const doc = parseJsonSafe(builtinJsonPath);
  const tpl = doc?.config?.providerConfigRules?.templateRules;
  const out = new Map();
  if (!Array.isArray(tpl)) return out;
  for (const t of tpl) {
    if (!t || typeof t.templateId !== "string") continue;
    const nameMap = t.templateNameMap ?? {};
    const name = nameMap["zh-CN"] ?? nameMap["en-US"] ?? t.templateId;
    out.set(t.templateId, {
      name,
      baseUrl: typeof t?.config?.api?.baseUrl === "string" ? t.config.api.baseUrl : null,
      apiType: typeof t?.config?.api?.type === "string" ? t.config.api.type : null,
      models: Array.isArray(t?.config?.builtinModelIds) ? t.config.builtinModelIds.filter((m) => typeof m === "string") : [],
    });
  }
  return out;
}

/**
 * templateId → 厂商家族归类（额度窗口规则表的路由键）。
 * @param {string} templateId 模板标识
 * @returns {"zhipu"|"kimi"|"opencode"|"qwen"|"other"}
 */
export function matchTemplateFamily(templateId) {
  if (typeof templateId !== "string") return "other";
  if (templateId.startsWith("bigmodel-") || templateId.startsWith("zai-")) return "zhipu";
  if (templateId.startsWith("kimi-")) return "kimi";
  if (templateId.startsWith("opencode-")) return "opencode";
  if (templateId.startsWith("qwen-")) return "qwen";
  return "other";
}
