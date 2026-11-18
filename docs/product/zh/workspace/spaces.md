---
title: Spaces
description: 在 Cohub 中创建、打开、配置 Space，并把它当作主要工作单元。
---

Space 是 Cohub 的工作单元。Chats、文件、Saves、Apps 和设置都属于某个 Space。

## 创建 Space

在应用中：

1. 创建新 Space
2. 起一个方便扫读的名字
3. 打开它并开始 Chat

创建时或之后可配置：

- 公开 slug
- 头像
- 描述
- 默认 Mods

按工作目标命名，而不是按工具命名。`launch-page-v1` 比 `test` 更好。

## 打开与切换 Spaces

用侧栏 Space 切换器或命令面板在 Spaces 之间移动。

每个 Space 各自保留：

- Chat 列表
- 文件与 Sandbox 状态
- Saves
- Apps
- 成员与访问策略

最近 Space 记忆能帮你回到上次位置，但若上下文不对，先看 Space 头部确认。

## Space 首页

进入 Space 通常会落在新建或当前 Chat。

从这里可以：

- 再开一个 Chat
- 打开文件 / 预览
- 查看 Saves
- 管理 Apps
- 打开 Space settings

## 身份与公开 URL 片段

一个 Space 可以有：

- **内部 id** — CLI / SDK 使用的稳定 id
- **Name** — 显示名称
- **Slug** — 可公开寻址时的路径片段

公开 Apps 依赖 username + space slug + app slug：

```text
/:username/:spaceSlug/w/:appSlug
```

发布重要内容前，先设好可读的 space slug。

## 早期值得知道的设置

| 设置 | 为什么重要 |
| --- | --- |
| Members | 谁能查看、编辑、管理 |
| Access | 登录用户 / 匿名用户默认角色 |
| Channels | 外部聊天入口 |
| Mods | 只读挂载的能力 |
| Sandbox | 规格、休眠、恢复 |
| Env | 运行时环境变量 |
| Commerce | 启用时给 Apps 用的产品 |

日常创作很少需要一次配齐。等协作或发布真正需要时再配置。

## Space 中的 Mods

Spaces 可以把其他 Spaces 挂为 Mods。

- 挂载内容通常只读，位于 `/mods/<slug>`
- Mods 中的 prompts 与 skills 可提供给 Agent
- 变更 Mods 可能重启 Sandbox

先保持简单：不确定时继续用默认 base Mod。

## 好的 Space 习惯

- 尽量一个重要事项对应一个 Space
- 同一事项内用多个 Chats 并行推进
- 大改前先 Save
- 从稳定文件 / 端口目标发布 Apps
- 优先用 labels，而不是无休止重命名 Chat

## 相关

- [Chats](/zh/docs/workspace/chats)
- [Files 与 Sandbox](/zh/docs/workspace/files-and-sandbox)
- [Saves](/zh/docs/workspace/saves)
- [Apps](/zh/docs/create/apps)
