---
title: 核心概念
description: 构成 Cohub 的对象 — Space、Chat、Save、Sandbox、App 等。
---

先记住这些对象。后面的产品能力都是它们的组合。

## Space

Space 是主要创作表面。

它在一个隔离环境里容纳 Chats、文件、Saves、任务、Apps 和设置。人和 Agent 共享同一份 Space 上下文。

当你需要一个可长期工作的地方，而不是一次性对话时，就创建一个 Space。

## Chat

Chat 是 Space 内的一段对话上下文。

每个 Chat 保留自己的历史、模型选择、turns 和 forks。你可以在同一个 Space 中并行多个 Chat，而不把目标混在一起。

在 CLI / API 中，这叫 **session**。

## Agent

Agent 是 Space 中的主动协作者。

它可以读取工作区文件、在 Sandbox 中执行命令、使用 skills，并把结果流式回 Chat。Agent 不是独立产品，而是在你的 Space 内工作。

## Save

Save 是 Space 工作区的不可变快照。

用它标记好状态、查看 diff、恢复，或从已知基线继续。Save 面向里程碑，不是每次按键。

在 CLI / API 中，这叫 **checkpoint**。

## Files

Files 是 Space 的工作区。

它们是 Agent 编辑的对象、你预览的内容，以及可发布的素材。把 Space 文件系统当作项目状态的真实来源。

## Sandbox

Sandbox 是 Space 背后的执行环境。

它负责跑进程、暴露预览端口，并把运行时工作隔离在产品表层之外。你通常会把它感受成「文件可用」和「端口可预览」。

## App

App 是已发布、可分享的表面。

可发布单个 HTML 文件、目录站点，或公开的 Sandbox 端口。App 有版本、权限和公开 URL：

```text
/:username/:spaceSlug/w/:appSlug
```

## Channel

Channel 把外部消息入口接到 Space。

例如 Discord、Telegram、飞书、微信。人可以从这些应用发消息；Agent 也可以通过绑定的 Space 回传结果。

## Label

Labels 用来在侧栏组织 Chats、Saves 和文件。

系统 labels 会按 source / user / channel 分组。用户 labels 让你不用反复重命名，也能建立自己的导航。

## Mod

Mod 把另一个 Space 以只读方式挂进当前 Space，通常位于 `/mods/<slug>`。

它让共享 skills、prompts 和基础工具进入 Space，而不必手工复制文件。

## Skill

Skill 是可在 Chat composer 中调用的可复用能力，常见形式是 `/skill:name`。

Skills 可能来自 Space、用户配置、平台默认，或已挂载的 Mods。

## Task

Task 是异步运行记录——生成任务、hook 运行、长任务等后台执行。

当你需要在 Chat 记录之外查看状态、历史或失败细节时，用 Tasks。

## Scheduled prompt

Scheduled prompt 会在稍后发送或重复发送 prompt。

一次性调度适合提醒；周期性调度适合固定节奏的 Agent 工作。API 层面与 cron jobs 和 scheduled prompts 相关。

## Permission

Permissions 决定成员、匿名访客和 Apps 能做什么。

Space 角色是 **host**、**builder**、**guest**。App 也会声明自身 scopes，需要运行时访问时请求 viewer 同意。
