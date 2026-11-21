# Product

<!-- impeccable:product-schema 1 -->

## Platform

web（渲染于 ZCode Desktop 的 plugin-sandbox：Electron 内嵌 WebView，非浏览器直开）

## Stack

extension 沙箱原生 HTML/CSS/JS + d3 7.9（沙箱 vendor 预置，无框架、零 npm 运行时依赖）；数据层 Node ≥22.5（`node:sqlite`）由扩展宿主提供。

## Users

单一核心用户：ZCode Desktop 重度使用者（开发者本人），在编码工作流中随时打开看板监控自己的模型消耗与套餐余量；盯盘时心态是"扫一眼得到答案"，也会在长会话期间挂着持续观察。

## Product Purpose

ZPowerPack 插件为 zcode 补齐官方未覆盖的可观测能力：实时 token 速率（含平滑保持策略）、模型吞吐对比、TTFT、上下文→速率关系、按项目消耗、工具调用统计、Provider 稳定性、时段热力图、套餐额度窗口（5h/订阅周期，智谱/Kimi/OpenCode/Qwen 保底）。成功 = 打开看板 3 秒内回答"现在跑多快、还剩多少额度"。

## Positioning

zcode 官方用量页只有消耗类统计；ZPowerPack 独有的机制是：请求级遥测的实时滑动窗口速率（官方无）、按 provider 实例的订阅周期额度对齐（官方无）、以及不解析 21GB JSONL 而直接读官方 db.sqlite 的零成本数据层。

## Operating Context

- 数据源：`db.sqlite`（WAL 只读，1s 轮询增量）；`provider_config.json` + `zcode-builtin.json`（模板目录，CDN 刷新）
- 渲染环境：plugin-sandbox（预置 d3/lucide/visualize 脚手架；视图侧无 Node API）
- 双形态：独立全页视图（桌面端导航入口打开）+ 迷你常驻态（速率+额度精简版）
- 平台：Windows 10/11；中文界面

## Capabilities and Constraints

- 数据契约：`buildSnapshot` 输出的唯一 JSON（rate/quota/charts 三组字段，设计文档 §五 口径）
- 明确未决：迷你常驻态的宿主承载能力未验证（Plan 2 Task 1 V1），不可行时迷你态降级为会话内 Gen UI 片段
- 错误行不入速率；held/idle 状态必须可见区分
- 敏感值（apiKey）不进视图层

## Brand Commitments

- 视觉方向由用户明确钉死：**高级炫酷的暗色流光样式**，要求微交互效果与数值变动动画
- 名称：ZPowerPack；界面语言中文（数字/单位/模型名保持原样）

## Evidence on Hand

- 真实数据结构：db.sqlite model_usage/turn_usage/tool_usage/session 表（设计文档 E1 字段清单）
- 真实 provider 配置样例（脱敏）与 34 个模板目录（E6）
- 真实速率样本：单请求 tps=108.21（output=303, 生成时长 2800ms）

## Product Principles

1. 盯盘三秒原则：首屏必须直接回答"现在多快/还剩多少"，任何点击不得是前置条件
2. 真实数据永远优先于装饰；held/idle 状态宁可诚实也不美化
3. 原生感：跟随桌面端暗色环境，但流光个性必须存在
4. 每个数字可溯源：视图上任何值都能对应到 db 字段或配置项

## Accessibility & Inclusion

- 速率保持（held）与空闲（idle）不能仅靠颜色区分，需文字标注
- 数值动画不得遮挡数字本体可读性；动效尊重系统减少动态偏好（prefers-reduced-motion 降级为直接跳变）
