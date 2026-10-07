---
title: Files 与 Sandbox
description: 把 Space 工作区、Sandbox 运行时、端口和预览当作持久的项目表面。
---

Files 是 Space 的持久状态。Sandbox 是这些文件可被执行与预览的地方。

## 工作区文件

每个 Space 都有工作区文件系统。

你可以：

- 浏览目录树
- 打开并编辑文本文件
- 上传本地文件或目录
- 创建文件夹
- 删除或移动路径
- 对照最近 Save 查看待提交变更

Agent 使用同一工作区。重要变更应落在文件里，而不只存在于 Chat 文本。

## 什么适合放进文件

适合：

- 应用源码
- 项目文档与笔记
- 想保留的生成资产
- Agent 应重复运行的脚本
- Apps 的发布目标

避免把 Chat 历史当成唯一事实来源。

## Sandbox

Sandbox 是 Space 背后的运行时。

它提供：

- Agent 工具与你的命令所需的进程执行
- 实时预览的端口暴露
- 与其他 Spaces 的隔离

你通常会在这些时刻感知它：

- 安装依赖
- 启动 dev server
- 出现可预览端口
- 空闲后休眠，或配置变更后需要重启

### 规格与休眠

Space settings 可能包含：

- Sandbox 规格 / 尺寸
- 自动销毁或空闲休眠策略

更大规格可能需要更高套餐。部分设置变更后需要重启 Sandbox。

## 端口与实时预览

当进程监听受支持的公开端口时，Cohub 可以预览它。

适合端口预览的情况：

- 正在运行 dev server
- 结果是应用，而不是静态文件
- 想把该端口发布为 live App

静态 HTML 通常可直接作为文件预览，不必长期跑进程。

## Files 与 Chat 一起用

Cohub 的强模式是分屏协作：

1. 让 Agent 修改工作区
2. 打开受影响文件
3. 验证预览
4. 用更精确的 follow-up 继续 Chat

明确指向路径。「更新 `src/page.tsx`」比「修一下页面」更好。

## 上传

当 Agent 需要本地材料时上传：

- 设计参考
- CSV / JSON 输入
- 已有项目归档或源码目录
- 媒体资产

上传后，告诉 Agent 文件落在哪里。

## Diffs 与 Saves

待处理工作区变更可与最近 Save 比较。

用 diffs 来：

- 在下一条 prompt 前审查 Agent 修改
- 决定是否 Save
- 发现意外删除

Save 会冻结当前里程碑。详见 [Saves](/zh/docs/workspace/saves)。

## 本地目录作为 Runtime

进阶场景下，CLI 可把本地目录挂为 Space Runtime：

```bash
# 第一次创建并记住该目录的 Space，之后自动复用
cohub runtime up ./my-project
```

绑定按目录、账号和环境隔离，保存在 `~/.config/cohub/runtime-spaces.json`。
这适合让 Cohub Agents 直接面对本地工作树。详见 [CLI](/zh/docs/developers/cli)。

## 共享手机屏幕

当 Cohub Android 应用为某个 Space 提供服务时，还可以把手机屏幕共享给它。在手机上打开该 Space 的 Runtime 菜单，选择「共享屏幕」；
每次共享 Android 都会请求授权。之后，能管理该 Space 的人可以在 Web 或其他设备上通过「屏幕 → 查看」实时看到手机屏幕，
Space 的 Agent 也可以对它截图、读取屏幕上的控件。

如果希望人和 Agent 能在手机上点按、滑动和输入，选择「允许控制」，并在无障碍设置中启用 Cohub。控制只在共享屏幕期间生效。
你可以随时在 Runtime 菜单或通知中停止共享。

## 虚拟屏幕

云端沙箱可以运行一块虚拟屏幕。在 Space 顶部点屏幕按钮，选择「启动虚拟屏幕」：此后沙箱里启动的程序（比如 Agent 打开的浏览器）都会显示在上面，
你可以实时查看和操作。在同一处即可停止；沙箱停止时它也会结束。早于此功能创建的沙箱，需要在 Space 设置中「强制恢复」以更新。

## 实用建议

- 把可发布输出放在稳定路径
- 不要把密钥放进可能发布的工作区文件
- 若 UI 提示，重要运行时 / 配置变更后重启 Sandbox
- 预览看起来过期时，确认进程仍在运行、端口仍正确

## 相关

- [Chats](/zh/docs/workspace/chats)
- [Saves](/zh/docs/workspace/saves)
- [Apps](/zh/docs/create/apps)
