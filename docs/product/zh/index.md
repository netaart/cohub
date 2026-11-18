---
title: 概览
description: Cohub 是人和 Agent 共同创作、保存、分享，并基于真实上下文继续构建的 living Space。
---

Cohub 是一个让人和 Agent 共同创作的共享工作区。

打开一个 Space，对话、编辑文件、在 Sandbox 中运行工具、保存有价值的时刻，并发布可分享的 Apps。同一套能力也可通过 Web、CLI 和 SDK 使用。

## 你能做什么

- 从一个 Space 开始，而不是空白聊天
- 与能读文件、跑命令、保持上下文的 Agent 协作
- 在工作值得保留时创建 Save
- 把文件、目录或端口发布为 App
- 之后再用 CLI、SDK、Channel 和 hooks 自动化

## 主循环

```text
创建 Space
  → 与 Agent 对话
  → 编辑文件 / 在 Sandbox 中运行
  → 创建 Save
  → 发布 App
```

这就是产品本身。其余能力都是在扩展它：Labels、Channels、Mods、Skills、定时 prompt、commerce 和开发者 API。

## 适合谁

- 希望 Agent 在真实工作区里协作，而不只是聊天记录里回复的构建者
- 共同创作应用、媒体、原型或自动化的团队
- 希望 CLI / SDK 与产品表面一致的开发者

## 接下来读什么

| 目标 | 页面 |
| --- | --- |
| 弄清核心词汇 | [核心概念](/zh/docs/learn/core-concepts) |
| 看懂界面结构 | [产品地图](/zh/docs/learn/product-map) |
| 几分钟走通闭环 | [快速开始](/zh/docs/learn/quick-start) |
| 使用终端 | [CLI](/zh/docs/developers/cli) |
| 做集成 | [SDK](/zh/docs/developers/sdk) |

## 产品语言

这些文档以 Cohub UI 术语为准：

| UI | CLI / API |
| --- | --- |
| Chat | Session |
| Save | Checkpoint |
| Task | Task run |
| Scheduled prompt | Cron job / 定时 `spaces prompt` |

开发者章节会使用 API 名称，并回映到 UI 术语。
