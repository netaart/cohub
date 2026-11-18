---
title: Saves
description: 捕获不可变 Space checkpoints，查看 diffs，恢复，并从已知良好状态继续。
---

Save 是 Space 工作区的不可变快照。在 CLI / API 中，它是 **checkpoint**。

## 为什么需要 Saves

Chats 变化很快，文件也频繁变动。Saves 标记你愿意保留的状态。

用它来：

- 冻结可用里程碑
- 比较发生了什么变化
- 恢复已知良好工作区
- 从稳定基线分支出新探索

## 创建 Save

当工作区到达有意义状态时：

1. 打开 Saves
2. 创建新 Save
3. 写一句可扫读的备注
4. 如有 diff，先看一眼

适合 Save 的时机：

- 功能可用
- 高风险迁移成功
- 达到可演示状态
- 即将尝试大范围重写

不要每次小改都 Save。

## Diffs

Save 的价值很大程度来自你能看清它捕获了什么。

Cohub 可展示：

- 相对最近 Save 的待处理变更
- 某个 Save 的文件级 diffs

恢复或发布前读 diffs，尤其在长 Agent 会话之后。

## 恢复与继续

按你使用的流程，Save 可以成为：

- 当前 Space 的恢复点
- 继续工作的基线
- 后续比较的上下文

把 Saves 当作可站上去的历史，而不是 Chat 书签。

## Saves vs Chats vs Apps

| 对象 | 捕获什么 | 用于 |
| --- | --- | --- |
| Chat | 对话与 turns | 推理与迭代 |
| Save | 工作区快照 | 里程碑与恢复 |
| App | 已发布表面 | 对外分享结果 |

好的演示常常三者都需要：产出它的 Chat、冻结它的 Save、分享它的 App。

## 组织

用 labels 与命名让 Saves 可理解：

- `v1-landing-working`
- `before-auth-refactor`
- `demo-2026-07-18`

若团队共享 Space，Save 备注写给下一位读者，而不只写给自己。

## 实用建议

- 让 Agent 做大范围清理前先 Save
- 输出可发布时，先 Save，再从稳定路径发布 App
- 宁可少量清晰 Saves，也不要几十个噪声 Saves
- 出问题先找最近的 green Save，再临时发挥

## 相关

- [Files 与 Sandbox](/zh/docs/workspace/files-and-sandbox)
- [Apps](/zh/docs/create/apps)
- [快速开始](/zh/docs/learn/quick-start)
