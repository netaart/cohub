# Cohub Web（SvelteKit）部署到 Cloudflare Workers

## 前提

- 已在 Cloudflare 创建 Worker
- 已配置好 GitHub Secrets：
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`
- 已确认 API 可访问

> 主域名的 Worker 路由已写入对应 Wrangler 配置，并启用 `assets.run_worker_first`。独立域名位于其它 Zone，其 Worker 通配路由在部署侧创建（不写入仓库）。

## Worker 入口

`wrangler.*.toml` 的 `main` 指向 `entry.worker.ts`：它先处理已发布 App 的独立域名，其余请求交给
SvelteKit adapter 生成的 Worker。

独立域名下每个 host 只对应一个 App，因此该 host 上的**所有**路径都归它；而 adapter 会把预渲染路径
（`/`、`/docs`、`/pricing` …）直接从静态资产返回，所以这层必须在 adapter 之前执行，否则独立域名首页会
返回主站落地页。

两个构建产物供入口引用，均由 `pnpm build` 生成：

| 产物 | 生成方式 |
|------|---------|
| `.svelte-kit/cloudflare/_worker.js` | SvelteKit adapter |
| `.svelte-kit/cloudflare/worker-entry-env.js` | `scripts/generate-worker-entry-env.mjs`，用 Vite 的 `loadEnv` 取 `PUBLIC_*` 值 |

入口是独立域名唯一的解析点：`vite dev`（SvelteKit dev server）与 `pnpm preview`（`wrangler dev`）都不经它，
所以这两个命令下独立域名不可用；验证请用已部署的 dev Worker。

> 注意：adapter 会把生成的 Worker 写到**它所读取配置**的 `main` 路径，因此构建期它读的是
> `wrangler.adapter.toml`（不含入口），部署用的 `wrangler.toml` / `wrangler.prod.toml` 才指向
> `entry.worker.ts`。改动这两组路径时务必保持同步。

## App 独立域名（可选）

已发布公开 App 的独立域名由部署配置决定，未配置时该功能关闭（API 不返回独立地址，Web 也不识别该类 host）。

| 位置 | 配置 | 说明 |
|------|------|------|
| API | `APP_STANDALONE_HOST_TEMPLATE` | 见 `deploy/api/*`；`{id}` 代入 App ID，如 `{id}.apps.example.com` |
| Web | `PUBLIC_APP_STANDALONE_HOST_TEMPLATE` | 构建期注入，取值自 GitHub Variable `APP_STANDALONE_HOST_TEMPLATE_DEV` / `APP_STANDALONE_HOST_TEMPLATE_PROD` |

启用独立域名还需在目标 Zone 完成：代理状态的通配 DNS 记录（如 `*.apps.example.com`）、覆盖该通配的 TLS 证书（Universal SSL 仅覆盖一级通配，二级通配需另行签发），以及指向 `cohub-web-dev` / `cohub-web` 的 Worker 通配路由。

验证（`<app-id>` 用真实已发布公开 App）：

```bash
# 首页必须是 App 自己的页面，而不是主站落地页
curl -s https://<app-id>.apps.example.com/ | head -c 200
# 非入口路径交给 App 资源（资源不存在时为资源源错误，而非主站页面）
curl -s -o /dev/null -w '%{http_code}\n' https://<app-id>.apps.example.com/assets/app.js
# 未发布/不存在的 App
curl -s https://<unknown-id>.apps.example.com/   # App not found
```

## 环境配置

| 环境 | Worker 名称 | 配置文件 | API 地址 |
|------|------------|---------|---------|
| dev | cohub-web-dev | `wrangler.toml` | `https://api-dev.cohub.live` |
| prod | cohub-web | `wrangler.prod.toml` | `https://api.cohub.live` |

## 本地部署

```bash
# 安装依赖
pnpm install

# 部署到 dev
pnpm -C apps/web build && pnpm -C apps/web deploy

# 部署到 prod
pnpm -C apps/web build && pnpm -C apps/web deploy:prod
```

## CI/CD

| 触发方式 | 部署环境 |
|---------|---------|
| push 到 `main` 分支 | dev（自动） |
| 手动触发 | 可选 dev 或 prod |

## Deploy inputs

Web deploy is driven by Cloudflare wrangler configs and CI env injection (see `.github/workflows/web-deploy-cloudflare.yml`). There is no Kubernetes `values.yaml` / `deploy.sh` for this component.

Do not commit real secrets or production-only credentials.

