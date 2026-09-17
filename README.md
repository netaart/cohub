# Cohub

<p align="center">
  <a href="https://cohub.live/">Homepage</a> · <a href="https://neta.art/">Neta Studio</a> · <a href="#quick-start">quick start</a> · <a href="#docs">docs</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-666666?labelColor=333333" alt="Apache 2.0 license" /></a>
  <a href="https://github.com/talesofai/cohub/stargazers"><img src="https://img.shields.io/github/stars/talesofai/cohub?labelColor=333333&color=666666&logo=github" alt="GitHub stars" /></a>
</p>

---

<p align="center">
  <img src="https://public.cohub.run/s/f7000115-55d8-4d97-a0e4-d2a55b6ffa41/uploads/screenshot.4bcbcab1.webp" alt="Cohub Space — a project chat with the repo README open in preview" width="800" />
</p>

We burn 100 billion tokens per week inside our company within Cohub Spaces.

**A living space where people and agents create, play, and build together.**

- **Fun to start** — Open a Space and play with ideas, prompts, files, and agents.
- **Build together** — People and agents in one Space. Create together, save, and share.
- **Open everywhere** — Web, mobile, CLI, Discord, WeChat. The Space follows you.
- **Powerful for real work** — Games, apps, media, automations, custom homes — from playful to production.
- **Never start blank** — Fork a checkpoint into a new Space, or reference any Space with `@space` as context.

## Built in the open

Cohub is developed inside Cohub. The core dev workflow — specs, agent runs, reviews, and shipping — happens in a public Space. Watch how the product is built, by the product.

→ [cohub.live/tzwm/cohub](https://cohub.live/tzwm/cohub)

## Quick start

**Web** — open [cohub.live](https://cohub.live) and sign in.

**CLI** —

```bash
npm install -g @neta-art/cohub-cli
cohub auth login
```

**Self-host** — see [docs/self-hosting.md](docs/self-hosting.md).

## Docs

Product docs: [cohub.live/docs](https://cohub.live/docs) · [中文](https://cohub.live/docs/zh)

Source of truth: `docs/product/en/` · `docs/product/zh/`

Engineering notes: [self-hosting](docs/self-hosting.md) · [agent-sandbox-runtime](docs/agent-sandbox-runtime.md) · [app-authorization](docs/app-authorization.md) · [app-commerce](docs/app-commerce-guide.md) · [generations](docs/generations.md) · [space-hooks](docs/space-hooks.md)

Changelog: [CHANGELOG.md](CHANGELOG.md)

## Development

```bash
pnpm install
pnpm dev
```

Quality checks: `pnpm lint` · `pnpm typecheck` · `pnpm build`

## Thanks

Cohub's agent runtime is built on [pi](https://github.com/earendil-works/pi) — thank you for the foundation.

## License

Apache License 2.0 © Viscept Limited
