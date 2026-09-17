# Cohub

<p align="center">
  <a href="https://cohub.live/">Homepage</a> · <a href="https://neta.art/">Neta Studio</a> · <a href="#quick-start">快速开始</a> · <a href="#docs">文档</a> · <a href="README.md">English</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-666666?labelColor=333333" alt="Apache 2.0 license" /></a>
  <a href="https://github.com/talesofai/cohub/stargazers"><img src="https://img.shields.io/github/stars/talesofai/cohub?labelColor=333333&color=666666&logo=github" alt="GitHub stars" /></a>
</p>

---

<p align="center">
  <img src="https://public.cohub.run/s/f7000115-55d8-4d97-a0e4-d2a55b6ffa41/uploads/screenshot.4bcbcab1.webp" alt="Cohub Space — 项目聊天与仓库 README 预览" width="800" />
</p>

我们公司每周在 Cohub Spaces 里消耗 1000 亿 token。

**人和 Agent 共同创作、玩耍、构建的 living space。**

- **Fun to start** — 打开一个 Space，马上开始玩想法、提示词、文件和 Agent。
- **Build together** — 人和 Agent 在同一个 Space 里。共同创作、保存、分享。
- **Open everywhere** — Web、移动端、CLI、Discord、WeChat，Space 会跟着你走。
- **Powerful for real work** — 游戏、应用、媒体、自动化、自定义主页——从随手玩到正式产出。
- **Never start blank** — 从一个 Checkpoint fork 出新的 Space，或在 session 里用 `@space` 引用任意 Space 作为上下文。

## Built in the open

Cohub 用 Cohub 开发。核心开发流程——需求、Agent 运行、Review、发布——都在一个公开的 Space 里进行。围观产品是如何用产品构建的。

→ [cohub.live/tzwm/cohub](https://cohub.live/tzwm/cohub)

## Quick start

**Web** — 打开 [cohub.live](https://cohub.live) 并登录。

**CLI** —

```bash
npm install -g @neta-art/cohub-cli
cohub auth login
```

**Self-host** — 见 [docs/self-hosting.md](docs/self-hosting.md)。

## Docs

产品文档：[cohub.live/docs/zh](https://cohub.live/docs/zh) · [English](https://cohub.live/docs)

内容源：`docs/product/zh/` · `docs/product/en/`

工程文档：[self-hosting](docs/self-hosting.md) · [agent-sandbox-runtime](docs/agent-sandbox-runtime.md) · [app-authorization](docs/app-authorization.md) · [app-commerce](docs/app-commerce-guide.md) · [generations](docs/generations.md) · [space-hooks](docs/space-hooks.md)

Changelog：[CHANGELOG.md](CHANGELOG.md)

## Development

```bash
pnpm install
pnpm dev
```

质量检查：`pnpm lint` · `pnpm typecheck` · `pnpm build`

## Thanks

Cohub 的 Agent Runtime 基于 [pi](https://github.com/earendil-works/pi) 构建，感谢它提供的基石。

## License

Apache License 2.0 © Viscept Limited
