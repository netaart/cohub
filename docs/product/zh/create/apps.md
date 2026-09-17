---
title: Apps
description: 把 Space 中的文件、目录或端口发布为可分享的 Cohub App，支持版本与权限。
---

App 是从 Space 发布出来的可分享表面。

当某样东西应被直接打开时使用 Apps：静态页、小站点、demo 应用，或可请求 Cohub 权限的运行时。

## App 是什么

App 属于一个 Space，并记录：

| 字段 | 含义 |
| --- | --- |
| Slug | URL 中的公开名 |
| Status | `published` 或 `disabled` |
| Target type | `file`、`directory` 或 `port` |
| Target ref | 路径或端口号 |
| App scopes | 发布时直接授予 App 的权限 |

公开 URL 形态：

```text
/:username/:spaceSlug/w/:appSlug
```

## 选择目标

| 目标 | 最适合 | 说明 |
| --- | --- | --- |
| File | 单个 HTML 文档 | 路径以 `.html` / `.htm` 结尾；大小 1 byte – 1 GiB |
| Directory | 静态站点 | 必须包含 `index.html`，1–1000 个文件，总计 ≤ 1 GiB |
| Port | Sandbox 中的 live app | 进程须监听受支持的公开端口 |

选择能匹配输出的最简单目标。

## 从 UI 发布

1. 在 Space 中准备文件、目录或运行中的端口
2. 打开其预览
3. 点击 **Publish**
4. 设置 App slug
5. 在 **App can** 下选择直接授予 App 的 scope
6. 发布并打开公开 URL

App 也会出现在 Space 侧栏的 Apps 下。

## 管理 App

在 App 管理页你可以：

- 在 workspace 中预览 App，与管理页并排查看
- 在新标签页打开公开页
- 编辑 slug、目标、状态与权限
- 从当前目标发布新版本
- 禁用或删除 App
- 复制 App id 供 CLI / SDK 使用

预览标签以 App id 为键，可通过 `?window=app:<appId>` 深链，并与文件、Board、
port 预览共用 workspace 的标签预算。Space 中的 Agent 可以在发起对话的标签页
打开同一预览，并调用 App 暴露的方法：

```bash
cohub desktop open <app> --call selection.get
cohub desktop open <app> --call board.focus --data '{"nodeId":"n1"}'
```

重要行为：

- 编辑目标只影响**下一次**版本来源
- 公开页在你 publish / 更新版本后变化
- 禁用会让 App 从公开 by-slug 访问中消失

## 版本

App 是所选目标的版本化快照。

这意味着你可以在 Space 中持续迭代，再在输出就绪时有意发布。把 version publish 当发布动作，而不是自动保存。

## 权限

App 在某个 Space 上的有效权限是两类授权的并集 — 任一来源即可：

1. **App scopes** — 发布时直接授予的八个有界 scope（`space.view`、`session.view`、`file.view`、`file.edit`、`taskrun.view`、`session.prompt.readonly`、`session.prompt.fullaccess`、`command.execute`），仅作用于 App 自己的 Space。
2. **访客授权（viewer grants）** — 访客在运行时通过授权对话框授予的、其自身持有的任意权限，可作用于其选择的任意 Space。授权按 Space 独立保存，有效期 14 天，且永远不会超出访客自己的访问范围。访客可随时查看与撤销（`cohub apps grants`、`cohub apps revoke`）。

当 App 在发布运行时中使用 Cohub SDK 读取上下文、prompt、生成，或访问被批准资源时，这很重要。

如果 App 只是静态 HTML，可能几乎不需要运行时 scope。

## Runtime 说明

`context()`、访客授权和 commerce API 只在 Cohub 托管的**已发布** App runtime 中工作。

它们不会在原始静态资源 URL 或随意本地预览壳中生效。开发这些能力时，请对着已发布 App。

## 从 CLI 发布

`apps publish` 默认根据 runtime 自动判断来源：本地 CLI 使用本地文件系统路径，Cohub
Sandbox 使用 Space 工作区路径。也可以用 `--source workspace` 或 `--source local`
显式覆盖。

```bash
cohub -s <spaceId> apps publish demo --file ./dist/index.html
cohub -s <spaceId> apps publish site --dir ./dist
cohub -s <spaceId> apps publish site --source workspace --dir dist
cohub -s <spaceId> apps publish app --port 5173
```

常用后续：

```bash
cohub -s <spaceId> apps ls --json
cohub apps get <appId|url|username/space/app> --json
cohub apps stats <appId|url|username/space/app>
cohub apps download <appId|url|username/space/app> --output <path>
cohub apps publish-version <appId>
```

`apps download` 直接从 CDN 恢复新发布的文件或目录产物，并校验 checksum。带有配套资源的 HTML 文件会恢复为目录 bundle。Board 和 port App 不支持下载。

## 推广链接

推广链接为每个渠道提供不可变 URL 与分渠道统计：

```bash
cohub apps promotions create <app> --name "Launch video A" --provider meta \
  --utm-source instagram --utm-medium paid_social --utm-campaign launch_2026
cohub apps promotions list <app>
cohub apps promotions stats <app> <promotion-id>
```

`generic`（默认）只在本地记录落地与就绪事件，不加载第三方代码。`meta` 会额
外把 App ready、首次注册、购买确认与进入结账事件发送给部署侧配置的 Meta
Pixel 与 Conversions API。归因按 App 存入本地存储 30 天，登录与结账跳转都能
保留；Cohub 不保留访客级推广记录。

## 常见问题

| 现象 | 检查项 |
| --- | --- |
| 无法生成公开链接 | 所有者有 username，且 Space 有 slug |
| File App 发布失败 | 目标在 1 byte – 1 GiB；Board 文件有效且引用 ≤1000 个资源、≤1 GiB |
| Directory App 发布失败 | 包含 `index.html`，1–1000 个文件，总计 ≤1 GiB |
| App 能打开但 Cohub API 失败 | 必须运行在已发布 App runtime 内；检查 `appScopes` 与 `context().permissions` |
| 授权被拒绝 | 访客本身必须已在目标 Space 持有全部所请求的权限 |
| 账户数据返回 403 | 对应的 `user.*` scope 需要单独授权 |

## 实用建议

- 广泛分享 URL 前先稳定路径
- 重大发布里程碑前先 Save
- 使用清晰 slug：`pitch`、`v1`、`docs-demo`
- 只需下线时优先 disable，而不是 delete
- 对 SDK 驱动的 App，刻意选择 scopes — 最小权限优先

## 相关

- [App 开发](/zh/docs/developers/apps)
- [快速开始](/zh/docs/learn/quick-start)
- [Files 与 Sandbox](/zh/docs/workspace/files-and-sandbox)
- [SDK](/zh/docs/developers/sdk)
