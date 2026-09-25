---
title: Chats
description: 使用 Chats 与 composer 和 Agent 协作 — 模型、turns、forks、skills 与分享。
---

Chat 是 Space 内的对话上下文。在 CLI / API 中，它是 **session**。

## 创建与打开 Chats

- **New Chat** 在当前 Space 开启新线程
- 侧栏列出最近 Chats，常按 labels 分组
- 跨 Space 的最近 Chats 也会出现在 sessions inbox

目标分叉时开多个 Chats；需要连续性时保持同一 Chat。

## Chat 结构

| 部分 | 作用 |
| --- | --- |
| Transcript | 消息、工具调用、流式输出 |
| Turns | 可导航的工作单元 |
| Composer | 输入、模型、附件、slash 工具 |
| Header / actions | 重命名、分享 / 访问、相关工具 |

## 侧栏

右侧栏把 Chat 的产出放在手边。

| Tab | 内容 |
| --- | --- |
| 本对话 | 这个 Chat 生成的媒体（含实时进度）和改动的文件 |
| 文件 | Space 文件树，本对话改动过的文件带有圆点标记 |
| 媒体 | Space 内全部生成结果，可按类型筛选 |
| 应用 | 已安装的 Apps |

改动的文件来自 Agent 的 write / edit 工具调用。shell 命令写入的文件不会归属到 Chat。CLI 可用 `cohub spaces sessions files <sessionId>` 查看同样的数据。

## Composer

Composer 是你驱动 Agent 的入口。

### 发送消息

- `Enter` 发送
- 需要绕过本地拦截时可用 force send
- 长说明可粘贴，也可作为文件附加

### 选择模型

按任务选择模型。UI 允许时，可在 turns 之间切换。

### 附件

当 Agent 需要工作区里还没有的素材时，附加图片或文件。

### Slash commands 与 skills

输入 `/` 浏览 prompt templates 与 skills。

- Prompt templates 插入结构化指令
- Skills 常以 `/skill:name` 出现
- 可用性取决于 Space、用户、平台和已挂载 Mods

Prompt templates 可通过 `{{cohub.session.id}}`、`{{cohub.space.id}}` 和 `{{cohub.user.uuid}}` 引用当前上下文。未知或不可用的变量会保留原文。

### Mentions

当你希望 Agent 拉取另一个你可访问 Space 的上下文时，使用 `@space`。粘贴公开 App URL 可创建 App mention，供 Agent 解析或下载。

Mentions 适合有意的上下文引用，不适合每条消息都用。

## 与 turns 协作

Chats 是 turn-based：

1. 你发送 prompt
2. Agent 流式响应，常伴随工具调用
3. Turn 结束
4. 你继续、fork，或停止

实用模式：

- 大改前先要计划
- 下一条指令前先检查文件 diff / 预览
- 想探索另一条路径时 fork

### Follow-ups

某些排队中的 follow-ups 可被 steer 或 cancel。当 Agent 正在执行、而下一条指令需要改变时使用。

## Forking

想保留当前历史、又探索不同路径时，fork Chat。

Forks 会保留谱系，方便比较方案，而不会覆盖原线程。

## 分享与访问

Chats 可以有超出 Space 默认策略的访问控制。

常见场景：

- 在共享 Space 内保持某个 Chat 私密
- 给特定线程更宽的只读访问
- 分享对话而不开放整个工作区

具体策略在 Chat / session access 与 Space settings 中。

## Labels 与组织

给 Chats 加 labels，让侧栏保持可扫读：

- 按功能
- 按状态（`todo`、`blocked`、`shipped`）
- 按协作者或 channel 来源

系统 labels 也可能按 user / channel / source 出现。

## 常用快捷键

| 动作 | 快捷键 |
| --- | --- |
| 全局搜索 | `⌘K` / `Ctrl K` |
| 新建 chat | `⌘O` / `Ctrl O` |
| 打开帮助 | `?` |
| 聚焦 composer | `i`（未在别处输入时） |
| 发送 | `Enter` |

完整列表见应用内帮助。

## 实用建议

- 尽量一个 Chat 一个目标
- 把持久项目状态放进文件，而不只写在 Chat 文案里
- 工作区到达好里程碑时 Save Space
- 若 Agent 迷失，重述目标并指向具体文件

## 相关

- [Spaces](/zh/docs/workspace/spaces)
- [Files 与 Sandbox](/zh/docs/workspace/files-and-sandbox)
- [Saves](/zh/docs/workspace/saves)
