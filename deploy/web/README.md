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
| `.svelte-kit/cloudflare/worker-entry-deps.js` | `scripts/generate-worker-entry-deps.mjs`，用 Vite 的 `loadEnv` 取 `PUBLIC_*` 值，并列出 adapter 不认识的构建产物 |

开启 `run_worker_first` 后，adapter 只返回它清单里的静态资产（`static/`、预渲染页面、`_app/`）。
vite-plugin-pwa 构建时生成的 `sw.js`、`workbox-*.js`、`manifest.webmanifest` 不在其中，由入口直接从
`ASSETS` 返回，否则会 404。

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


## App 自定义域名（可选）

用户自有域名通过 Cloudflare for SaaS 接入 `cohub.live` Zone，证书由 Cloudflare 签发与续期，集群网关无需改动。设计见 `docs/app-custom-domains.md`。

| 位置 | 配置 | 说明 |
|------|------|------|
| API / system worker | `CLOUDFLARE_SAAS_ZONE_ID`、`CLOUDFLARE_SAAS_API_TOKEN` | 写入 `cohub-api-secrets`（两者共用）。API 只看 Zone ID 是否配置来开启功能，Token 只有 system worker 使用 |
| API / system worker | `APP_CUSTOM_DOMAIN_CNAME_TARGET` | 可选，默认 `cname.cohub.live` |
| Web | `PUBLIC_SITE_HOST_SUFFIXES` | 构建期注入，取值自 GitHub Variable `SITE_HOST_SUFFIXES_DEV` / `SITE_HOST_SUFFIXES_PROD`，如 `cohub.live,cohub.run` |

`PUBLIC_SITE_HOST_SUFFIXES` 列出由主站服务的 Zone，须覆盖所有指向该 Worker 的主站 host（含仍在使用的 `*.workers.dev` 等）。配置后，入口把其它所有 host 当作自定义域名：查不到绑定一律返回 404，绝不渲染主站。第一个 Zone 必须是开启 Cloudflare for SaaS 的 Zone（`cohub.live`），port App 只会被代理到该 Zone 内的沙箱主机（prod 为 `s-…`，dev 为 `d-…`），以保证同 Zone 转发拿到访客真实 IP；因此 API 的 `SANDBOX_PUBLIC_DOMAINS` 第一项也必须是该 Zone。

上线顺序（不可颠倒）：

1. 设置 `SITE_HOST_SUFFIXES_PROD`（如 `cohub.live,cohub.run,cohub.neta.art`，含所有经回退源进入该 Worker 的主站别名）并部署 Web，确认主站、主站别名与独立域名行为不变。dev 留空
2. `cohub.live` 的 Custom Hostnames 回退源保持 `cohub.live`（它绑定 `cohub-web`，自定义主机名的流量经回退源进入 Worker，Host 不变）；添加 `cname.cohub.live  CNAME  cohub.live`（Proxied）作为用户的 CNAME 目标
3. 不新增 Worker 路由：同一主机名上路由优先于 Worker 自定义域，`*/*` 会抢走 `dev.cohub.live` 及直连网关的子域名
4. Cache Rule：`s-*.cohub.live`、`d-*.cohub.live` → Bypass cache
5. 仅 prod 配置 API/worker secrets，执行数据库迁移并重启。dev 不配 `CLOUDFLARE_SAAS_ZONE_ID`：自定义主机名属于整个 Zone，流量只会进入 prod Worker

验证：

```bash
# 未绑定的自定义主机名返回 Worker 404
curl -s -o /dev/null -w '%{http_code}\n' https://<test-hostname>/
```
