# Self-hosting Cohub

Cohub can be self-hosted. The open-source default runs **without hosted billing**.

## Architecture

Typical production shape:

- **Web**: SvelteKit (Cloudflare Workers or Node)
- **API**: Hono service
- **Worker**: BullMQ workers
- **Agent**: agent control service
- **Sandbox**: per-space runtime (Kubernetes)
- **Gateway**: external channels (Discord, Telegram, Feishu, WeChat, ...)
- **Postgres** + **Redis**
- **Local Git storage** for Space/Checkpoint repositories; optional Gitea-compatible mirror
- **S3-compatible object storage** for session/public/work assets
- **OIDC provider** (Logto or compatible) for user auth

## Quick start (development)

```bash
pnpm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
# fill required values, especially DATABASE_URL / REDIS_URL / OIDC settings
pnpm dev
```

## Checkpoint storage

Checkpoint content is stored in the local Git repository under `SPACE_SYSTEM_ROOT`; Postgres stores checkpoint metadata and commit hashes. Gitea is optional and only mirrors completed repositories when `GITEA_BASE_URL` and `GITEA_TOKEN` are both configured. Leave both unset for a self-hosted deployment without Gitea.

Git mirror authentication uses a temporary child-process HTTP header, not a credential-bearing remote URL. This prevents new tokens from being stored in `.git/config` or passed in command arguments; it does not isolate credentials from privileged or same-user processes. A legacy `cohub` remote is removed when that repository is mirrored again. Repositories no longer mirrored and older backups are not automatically scrubbed; audit them and rotate exposed credentials separately.

Git 镜像通过子进程的临时 HTTP Header 认证，不再将 Token 写入 remote URL、`.git/config` 或命令参数；这不提供对特权或同用户进程的凭据隔离。再次镜像时会移除旧 `cohub` remote；已停用镜像的仓库及历史备份不会自动清理，需单独审计并轮换已暴露凭据。

## Billing

Billing is **disabled by default**.

To enable the hosted Talesofai Billing provider:

1. Install `@talesofai-billing/sdk` (private package used by the official hosted product).
2. Set:

```bash
TALESOFAI_BILLING_BASE_URL=...
TALESOFAI_BILLING_BUSINESS_KEY=...
TALESOFAI_BILLING_ADMIN_API_KEY=...
```

Without these, API/worker use the disabled billing provider and commerce features stay off.

## Deploy templates

Kubernetes templates live under `deploy/`.

1. Copy `values.example.yaml` to `values.yaml` in each environment directory.
2. Copy `secrets.template.yaml` to `secrets.yaml` and fill secrets locally.
3. Run the local `deploy.sh` for that component.

Real environment values are intentionally not committed.

## Images

Example values use placeholder registries/domains. Point image repositories at your own builds; official sandbox images may still use `git.talesofai.com/talesofai/cohub-sandbox:...`.

`SANDBOX_IMAGE_PULL_SECRET` on the API is independent of Gitea mirror credentials. When unset, it keeps the legacy `gitea-registry` default, so existing deployments need no configuration change. Set it to another existing Secret in the Sandbox namespace to override, or explicitly set `SANDBOX_IMAGE_PULL_SECRET=` for public images to omit `imagePullSecrets`. Whitespace-only values also omit the Secret.

API 的 `SANDBOX_IMAGE_PULL_SECRET` 与 Gitea 镜像凭据无关。未设置时沿用 `gitea-registry`，现有部署无需补配置；非空时使用 Sandbox 命名空间中的指定 Secret。公开镜像可显式设置 `SANDBOX_IMAGE_PULL_SECRET=`，不生成 `imagePullSecrets`；仅含空白的值同样视为空。

## Auth

Official hosted defaults target the Cohub Logto tenant. Self-hosted deployments should override both web and API:

```bash
# Web (build-time)
PUBLIC_LOGTO_ENDPOINT=https://auth.example.com/
PUBLIC_LOGTO_APP_ID=...
PUBLIC_LOGTO_API_RESOURCE=https://api.example.com

# API / CLI (runtime)
LOGTO_ENDPOINT=https://auth.example.com
AUTH_RESOURCE=https://api.example.com
# CLI also accepts COHUB_AUTH_ISSUER / COHUB_AUTH_RESOURCE / COHUB_AUTH_CLIENT_ID
```

`PUBLIC_LOGTO_API_RESOURCE` and `AUTH_RESOURCE` must match the OIDC API resource / audience used when minting access tokens.

## Observability

OpenTelemetry tracing is **disabled for remote export by default**.

To export spans to your own collector:

```bash
# Prefer the traces-specific endpoint
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://otel.example.com/v1/traces

# Or set a base endpoint (Cohub appends /v1/traces)
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.com

# Optional tuning
OTEL_TRACE_SAMPLE_RATIO=0.1
OTEL_SDK_DISABLED=false
OTEL_CONSOLE_EXPORTER=false
```

Without these variables, services keep local instrumentation wiring but do not send telemetry to any external system.

## Security reports

See `SECURITY.md`. Prefer GitHub Private Vulnerability Reporting or email `dev@talesof.ai`.

## Known limits

- Full production still expects Kubernetes for sandboxes.
- Multimodal generation depends on configured model adapters/keys.
- Hosted billing/commerce is optional and not required for core Spaces/Sessions.
