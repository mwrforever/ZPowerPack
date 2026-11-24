# Product

<!-- impeccable:product-schema 1 -->

## Platform

ZCode Desktop 扩展（扩展宿主 Node 进程）+ composer.status 宿主渲染素条；无独立视图、无沙箱页面。

## Stack

原生 ESM（`extension/main.js` + `extension/core/live-rate.mjs`），零运行时依赖；测试用 Node `node --test` 与 `node:sqlite`（仅迁移向导）。

## Users

单一核心用户：ZCode Desktop 重度使用者（开发者本人）。生成过程中扫一眼输入框旁，确认当前会话「现在跑多快」；不盯盘、不需要历史趋势。

## Product Purpose

把官方 `models.onDidGenerate` 推送的实时 token 速率（主代理）以常驻素条呈现在当前会话的输入控制台；为空不展示，主代理停工后保留最后速率。成功 = 生成中数字随官方推送跳动，停工后仍是最后值，切换会话各自独立。

## Positioning

zcode 界面内部有流式速率，但插件 API 只向扩展推送 `querySource=main_turn` 的事件；ZPowerPack 把这一个官方真值直接落到 composer.status，零轮询、零扫库、零平滑补丁。子代理请求在宿主侧被过滤，插件无法取得其速率（已知边界，不做落库近似）。

## Operating Context

- 数据源：`ctx.models.onDidGenerate` 订阅（事件载荷含 sessionId/requestId/phase/outputTokensPerSecond）
- 承载面：`slots.update("zpowerpack-mini", patch, {sessionId})`，宿主渲染图标 + 一行文本
- 会话目标：`ctx.workbench.onDidChange` + `visibleSessions()`
- 平台：Windows 10/11；中文日志与文案；插件同时包含存储迁移向导（skills/scripts），本产品描述只覆盖速率素条

## Capabilities and Constraints

- 素条值契约：`{text≤40, tooltip≤200, visible, badge}`；渲染组件过滤空 text、`visible:false` 隐藏；插件无样式/颜色/动效控制权
- 速率文案：生成中 `~428 tok/s`（宿主字符估算，前缀 `~` 明示非精值；每请求首帧不上屏防伪影）；停工后 `120.8 tok/s`（官方真实 usage token 精值，不带 `~`）
- 滞留守卫：取消/失败请求收不到 final 时，60s 静默后清除「生成中」状态（一次性看门狗，unref；stop 时清理），不长期显示 `~`
- 伪影上限：streaming 估算值 > 2000 tok/s 视为大块 reasoning/tool 分块造成的伪影，不上屏（保持上一合理值；final 精值不受影响）
- 为空不展示：会话自激活以来无事件 → `visible:false`，不显示占位文案
- 事件推送节流 1s（final 绕过）；同会话同值去重；宿主拒收不写去重键
- 插槽条目必须挂命令目标（宿主 schema 硬约束）→ 保留空操作命令 `zpowerpack-rate-status`
- 子代理实时速率不可得（宿主只推 main_turn，带 parentToolCallId 的 chunk 被丢弃）
- 无 db 读取、无额度接口、无定时器、无视图注册；apiKey 等敏感值完全不在本功能数据面内

## Brand Commitments

- 无自定义视觉：完全跟随宿主 composer.status 的 ghost 按钮样式（图标 + 等宽数字文本）
- 名称：ZPowerPack；文案中文（数字/单位保持原样）
- 不做主题化装饰、不做 badge（渲染侧不消费）

## Evidence on Hand

- 真机探针：`~/.zcode/cli/zpowerpack/v2-probe-diagnostics.json`（订阅形态 `ctx.models.onDidGenerate()` 绑定成功；事件键与实现一致；推送间隔 500-1500ms）
- 宿主源码：`out/host/index.js` 推送泵（`Rde="main_turn"`、`parentToolCallId` 过滤）；`out/main/chunk-2BVCDB7Q.js` 插槽 zod 契约与渲染过滤
- 仓库测试：`tests/rate-strip.test.mjs`（状态机/接线/manifest）

## Product Principles

1. 只展示官方真值：不做 EMA、窗口加权、持仓保持或补帧
2. 没有数据就不出现：空态隐藏，不编造「待机」文案
3. 零后台负担：无定时器、无 db 扫描、无网络请求，只在事件到达时更新内存与素条
4. 诚实边界：子代理速率拿不到就不显示，不拿落库行冒充实时

## Accessibility & Inclusion

- 文本由宿主渲染，字号/对比度/紧凑模式跟随宿主设置
- 只依赖宿主自带的数字等宽与截断行为，不引入动画（无 prefers-reduced-motion 关注点）
