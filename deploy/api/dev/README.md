# Dev 环境部署

## 目录结构

```
dev/
├── values.yaml        # Dev 环境配置（可提交 git）
├── secrets.yaml       # 敏感配置（不提交 git）
├── rbac.yaml          # Dev 环境 RBAC 配置
├── deploy.sh          # 部署脚本
└── run-migration.sh   # 数据库迁移脚本
```

## 部署步骤

### 1. 配置 secrets.yaml

复制并填写敏感配置：

```bash
# 编辑 secrets.yaml，填入真实值
vim secrets.yaml
```

需要填写的字段：
- `DATABASE_URL` - 数据库连接地址
- `REDIS_URL` - Redis 连接地址
- `LITELLM_API_KEY` - LiteLLM API key
- `GENERATION_API_KEY` - Generation SDK API key used by the Worker; configure it on the deployment, not in a Space
- `APP_ENCRYPTION_KEY` - 应用级密钥（用于加密存储凭据、签名会话与执行授权 token）
- `WORKER_SECRET` - Worker 通信密钥
- `TURN_OBJECT_S3_ACCESS_KEY_ID` / `TURN_OBJECT_S3_SECRET_ACCESS_KEY` - Turn 中间消息 OSS 写入凭证
- `PUBLIC_ASSET_OSS_ACCESS_KEY_ID` / `PUBLIC_ASSET_OSS_SECRET_ACCESS_KEY` - 公开资产 OSS 写入凭证（用于头像和旧客户端附件上传）
- `USER_UPLOAD_S3_ACCESS_KEY_ID` / `USER_UPLOAD_S3_SECRET_ACCESS_KEY` - R2 用户上传凭证（用于聊天附件和 Space 临时上传）
- `LOGTO_M2M_APP_ID` / `LOGTO_M2M_APP_SECRET` - Logto M2M 应用凭证

可选字段：
- `TALESOFAI_BILLING_BASE_URL` / `TALESOFAI_BILLING_BUSINESS_KEY` / `TALESOFAI_BILLING_ADMIN_API_KEY` - Talesofai Billing 插件配置，三项全部非空时启用；任意一项留空时禁用。Dev billing 地址通常是 `https://billing-dev.example.com/v1`。

Billing 启用后，Cohub 使用 `usd_micro_cent` credit type：`1 usd_micro_cent = $0.00000001`，`100_000_000` 单位等于 `$1`。free plan 每月赠送 `$10` 时，billing grant amount 应为 `1_000_000_000`。

同时请确认 `values.yaml` 中已填写：
- `PUBLIC_ASSET_OSS_ENDPOINT` / `PUBLIC_ASSET_OSS_PUBLIC_ENDPOINT` / `PUBLIC_ASSET_OSS_REGION` / `PUBLIC_ASSET_OSS_BUCKET` / `PUBLIC_ASSET_CDN_BASE_URL` / `APP_ASSET_CDN_BASE_URL` (formerly `WORK_ASSET_CDN_BASE_URL`) - 头像、旧附件和 Work asset 配置
- `APP_STANDALONE_HOST_TEMPLATE` - App 独立域名模板，`{id}` 为 App ID（如 `{id}-dev.apps.example.com`）；不配置则不提供独立域名
- `USER_UPLOAD_S3_ENDPOINT` / `USER_UPLOAD_S3_REGION` / `CHAT_ATTACHMENT_S3_BUCKET` / `CHAT_ATTACHMENT_PUBLIC_BASE_URL` / `SPACE_UPLOAD_S3_BUCKET` - R2 用户上传配置；聊天 Bucket 绑定公开域名，Space Bucket 保持私有并为 `uploads/`、`dev/uploads/` 配置 3 天生命周期

两个 R2 Bucket 都需要为 `WEB_ORIGIN` 配置浏览器直传 CORS：允许 `PUT`，允许 `Content-Type`、`Cache-Control`、`Content-Disposition` 请求头，并暴露 `ETag`。公共文件使用的 OSS Bucket 还需允许 `x-oss-forbid-overwrite` 与 `Content-Length`。聊天附件 Bucket 绑定 `CHAT_ATTACHMENT_PUBLIC_BASE_URL` 对应的 Custom Domain；Space 上传 Bucket 不开放公共访问。

CI 构建还需要配置 `GITEA_NPM_TOKEN` secret。该 token 只在构建期用于读取 `git.talesofai.com/api/packages/talesofai/npm/` 中的私有 npm 包，不是 API 运行时 secret。

### 2. 运行数据库迁移

```bash
./run-migration.sh [IMAGE_TAG]
```

### 3. 部署应用

```bash
./deploy.sh
```

## 环境差异

| 配置项 | Prod | Dev |
|-------|------|-----|
| Namespace | cohub | cohub-dev |
| Sessions Namespace | cohub-sessions | cohub-sessions-dev |
| App Name | cohub-api | cohub-api-dev |
| Replicas | 1+ | 1 |
| Hostname | api.cohub.live | api-dev.cohub.live |

## 常用命令

```bash
# 查看 Pod 状态
kubectl get pods -n cohub-dev -l app.kubernetes.io/name=cohub-api-dev

# 查看日志
kubectl logs -n cohub-dev -l app.kubernetes.io/name=cohub-api-dev -f

# 查看 Session Pods
kubectl get pods -n cohub-sessions-dev
```

## Values files

This repository ships `values.example.yaml` only.

```bash
cp values.example.yaml values.yaml
# edit values.yaml for your environment
./deploy.sh
```

Do not commit real `values.yaml` or `secrets.yaml`.
