/**
 * provider 发现模块的单元测试（脱敏 fixture）。
 * 覆盖：实例枚举（含 apiKey 字段但结果绝不携带）、模板对照（防御解析）、templateId 家族归类。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverInstances, loadTemplates, matchTemplateFamily } from "../extension/core/providers.mjs";

/** 造脱敏的 provider_config.json 与 zcode-builtin.json fixture，返回两个路径 */
function makeFixtures() {
  const dir = mkdtempSync(join(tmpdir(), "zpowerpack-providers-"));
  const providerConfigPath = join(dir, "provider_config.json");
  const builtinPath = join(dir, "zcode-builtin.json");

  writeFileSync(
    providerConfigPath,
    JSON.stringify({
      schemaVersion: 1,
      config: {
        providerOrder: ["bigmodel-api", "kimi-code-cn", "opencode-go-messages", "qwen-instance"],
        providerConfigRules: {
          providerRules: [
            {
              providerId: "bigmodel-api",
              templateId: "bigmodel-api",
              providerName: "智谱 GLM 主力",
              config: { access: { type: "api_key", apiKey: "sk-test-aaaa11.bbb22ccc" }, modelOrder: ["glm-4.7"] },
            },
            {
              providerId: "kimi-code-cn",
              templateId: "kimi-code-cn",
              providerName: "Kimi 编程套餐",
              config: { access: { type: "api_key", apiKey: "sk-kimi-test-333" }, modelOrder: ["kimi-k3"] },
            },
            {
              providerId: "opencode-go-messages",
              templateId: "opencode-go-messages",
              providerName: "OpenCode Go",
              config: { access: { type: "oauth", apiKey: "oc_oauth_token_x" }, modelOrder: [] },
            },
            {
              providerId: "qwen-instance",
              templateId: "qwen-coding-plan-cn",
              providerName: "Qwen 编程套餐",
              config: { access: { type: "api_key", apiKey: "sk-qwen-test-55" }, modelOrder: ["qwen3.8-max"] },
            },
          ],
        },
        modelConfigRules: {},
      },
    }),
    "utf8",
  );

  writeFileSync(
    builtinPath,
    JSON.stringify({
      schemaVersion: 1,
      revision: 7,
      config: {
        providerConfigRules: {
          templateRules: [
            {
              templateId: "bigmodel-api",
              templateNameMap: { "zh-CN": "智谱 BigModel", "en-US": "Zhipu BigModel" },
              config: {
                access: { type: "api_key", apiKeyManagementUrl: "https://open.bigmodel.cn" },
                api: { type: "responses", baseUrl: "https://open.bigmodel.cn/api" },
                builtinModelIds: ["glm-4.7", "glm-4.6"],
              },
            },
            {
              templateId: "kimi-code-cn",
              templateNameMap: { "zh-CN": "Kimi 编程", "en-US": "Kimi Coding" },
              config: {
                access: { type: "api_key", apiKeyManagementUrl: "https://www.kimi.com/code/console" },
                api: { type: "messages", baseUrl: "https://api.kimi.com/coding/v1" },
                builtinModelIds: ["kimi-k3"],
              },
            },
            {
              templateId: "opencode-go-messages",
              templateNameMap: { "zh-CN": "OpenCode Go", "en-US": "OpenCode Go" },
              config: {
                access: { type: "oauth" },
                api: { type: "messages", baseUrl: "https://opencode.ai/zen/go/v1" },
                builtinModelIds: ["claude-sonnet-4"],
              },
            },
            {
              // 防御解析样例：缺 api 段的模板不得让 loadTemplates 抛错
              templateId: "qwen-coding-plan-cn",
              templateNameMap: { "zh-CN": "Qwen 编程套餐" },
              config: { access: { type: "api_key" } },
            },
          ],
        },
      },
    }),
    "utf8",
  );

  return { providerConfigPath, builtinPath };
}

test("discoverInstances：枚举 4 实例且结果不含任何 apiKey 值", async () => {
  const { providerConfigPath } = makeFixtures();
  const list = discoverInstances(providerConfigPath);
  assert.equal(list.length, 4);
  assert.deepEqual(list[0], { providerId: "bigmodel-api", templateId: "bigmodel-api", providerName: "智谱 GLM 主力", accessType: "api_key" });
  assert.equal(list[2].accessType, "oauth");
  const dumped = JSON.stringify(list);
  assert.ok(!dumped.includes("sk-"), "枚举结果不得含密钥样式: " + dumped);
  assert.ok(!dumped.includes("oc_oauth_token_x"), "枚举结果不得含 token 值");
  assert.ok(!dumped.includes("apiKey"), "枚举结果不得含 apiKey 字段");
});

test("discoverInstances：文件缺失返回空数组（warn 由调用层打）", () => {
  const list = discoverInstances(join(tmpdir(), "zp-no-pc-" + Date.now() + ".json"));
  assert.deepEqual(list, []);
});

test("loadTemplates：模板对照 baseUrl/apiType/模型清单，缺 api 段容错", async () => {
  const { builtinPath } = makeFixtures();
  const tpl = loadTemplates(builtinPath);
  assert.equal(tpl.size, 4);
  const big = tpl.get("bigmodel-api");
  assert.equal(big.name, "智谱 BigModel");
  assert.equal(big.baseUrl, "https://open.bigmodel.cn/api");
  assert.equal(big.apiType, "responses");
  assert.deepEqual(big.models, ["glm-4.7", "glm-4.6"]);
  const qwen = tpl.get("qwen-coding-plan-cn");
  assert.equal(qwen.name, "Qwen 编程套餐");
  assert.equal(qwen.baseUrl, null, "缺 api 段 → baseUrl null 而非抛错");
  assert.deepEqual(qwen.models, []);
});

test("loadTemplates：文件缺失/非法 JSON 返回空 Map", () => {
  assert.equal(loadTemplates(join(tmpdir(), "zp-no-tpl-" + Date.now() + ".json")).size, 0);
  const dir = mkdtempSync(join(tmpdir(), "zpowerpack-providers-bad-"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{这不是JSON", "utf8");
  assert.equal(loadTemplates(bad).size, 0);
});

test("matchTemplateFamily：四家族归类正确", () => {
  assert.equal(matchTemplateFamily("kimi-code-cn"), "kimi");
  assert.equal(matchTemplateFamily("kimi-code-intl"), "kimi");
  assert.equal(matchTemplateFamily("opencode-go-messages"), "opencode");
  assert.equal(matchTemplateFamily("opencode-zen-chat"), "opencode");
  assert.equal(matchTemplateFamily("qwen-coding-plan-cn"), "qwen");
  assert.equal(matchTemplateFamily("bigmodel-api"), "zhipu");
  assert.equal(matchTemplateFamily("zai-api"), "zhipu");
  assert.equal(matchTemplateFamily("moonshot-kimi"), "other");
  assert.equal(matchTemplateFamily("deepseek"), "other");
});
