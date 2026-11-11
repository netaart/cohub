# Cohub API 部署

## 目录结构

```
deploy/api/
├── manifests/              # K8s 资源模板
│   ├── configmap.tmpl.yaml
│   ├── deployment.tmpl.yaml
│   ├── service.tmpl.yaml
│   ├── httproute.tmpl.yaml
│   └── migration-job.tmpl.yaml
├── prod/                   # Prod 环境
│   ├── values.yaml
│   ├── secrets.yaml        # 不提交 git
│   ├── rbac.yaml
│   ├── deploy.sh
│   ├── run-migration.sh
│   └── README.md
└── dev/                    # Dev 环境
    ├── values.yaml
    ├── secrets.yaml        # 不提交 git
    ├── rbac.yaml
    ├── deploy.sh
    ├── run-migration.sh
    └── README.md
```

## 环境差异

| 配置项 | Prod | Dev |
|-------|------|-----|
| Namespace | `cohub` | `cohub-dev` |
| Sessions Namespace | `cohub-sessions` | `cohub-sessions-dev` |
| App Name | `cohub-api` | `cohub-api-dev` |
| Hostname | `api.cohub.live` | `api-dev.cohub.live` |
| ENV | `prod` | `dev` |

## 快速开始

### Prod 环境

```bash
cd deploy/api/prod

# 1. 配置 secrets
cp secrets.template.yaml secrets.yaml
vim secrets.yaml

# 2. 运行迁移
./run-migration.sh

# 3. 部署
./deploy.sh
```

### Dev 环境

```bash
cd deploy/api/dev

# 1. 配置 secrets
vim secrets.yaml

# 2. 运行迁移
./run-migration.sh

# 3. 部署
./deploy.sh
```

## 前置条件

- [ ] `cohub-agent-pvc` PVC 已创建（sessions namespace 中）
- [ ] 镜像已推送到 registry
- [ ] secrets.yaml 已配置
- [ ] CI 已配置 `GITEA_NPM_TOKEN` secret（仅构建期使用，用于读取 `git.talesofai.com/api/packages/talesofai/npm/` 私有 npm 包）

## Sandbox 专用节点池

API 通过 `SANDBOX_NODE_SELECTOR` 和 `SANDBOX_TOLERATIONS` 控制新建 sandbox Pod 的调度位置。当前 CI 发布 API 时只更新 Deployment image，因此不要把这两个参数写进 `deploy.sh`；在 live Deployment 上设置 env，后续 `kubectl set image` 会保留这些 env。

对应节点池需要配置同名 label 和 taint。优先在云厂商的节点池配置里设置；临时验证时可以对节点执行：

```bash
kubectl label node <node> cohub.run/workload=sandbox
kubectl taint node <node> cohub.run/workload=sandbox:NoSchedule
```

启用 dev：

```bash
kubectl set env deployment/cohub-api-dev -n cohub-dev \
  SANDBOX_NODE_SELECTOR=cohub.run/workload=sandbox \
  SANDBOX_TOLERATIONS=cohub.run/workload=sandbox:NoSchedule
kubectl rollout status deployment/cohub-api-dev -n cohub-dev --timeout=300s
```

启用 prod：

```bash
kubectl set env deployment/cohub-api -n cohub \
  SANDBOX_NODE_SELECTOR=cohub.run/workload=sandbox \
  SANDBOX_TOLERATIONS=cohub.run/workload=sandbox:NoSchedule
kubectl rollout status deployment/cohub-api -n cohub --timeout=300s
```

回滚 dev：

```bash
kubectl set env deployment/cohub-api-dev -n cohub-dev \
  SANDBOX_NODE_SELECTOR- SANDBOX_TOLERATIONS-
kubectl rollout status deployment/cohub-api-dev -n cohub-dev --timeout=300s
```

回滚 prod：

```bash
kubectl set env deployment/cohub-api -n cohub \
  SANDBOX_NODE_SELECTOR- SANDBOX_TOLERATIONS-
kubectl rollout status deployment/cohub-api -n cohub --timeout=300s
```

Recover/recreate 会删除旧 Pod 并用当前模板创建新 Pod，因此配置生效后的新 sandbox 或被 recover 的旧 sandbox 会自然落到专用节点池。

如需把指定用户放到其他节点池并调整 request 比例，在 platform config 中维护 `platform/.cohub/sandbox/placements.yaml`，格式见 `docs/sandbox-environments.md` 的 Node pool placement。修改后运行 Configs Sync，无需重启 API。

## 可选 Billing 配置

API 支持可插拔 Talesofai Billing。`secrets.yaml` 中以下三项全部非空时启用，任意一项留空时自动禁用 billing：

- `TALESOFAI_BILLING_BASE_URL`
- `TALESOFAI_BILLING_BUSINESS_KEY`
- `TALESOFAI_BILLING_ADMIN_API_KEY`

禁用时 API 仍可启动，业务侧会跳过 LLM billing preflight 和 usage record，前端余额入口会隐藏。

可选的 `TALESOFAI_BILLING_SPACE_WALLET_BUSINESS_KEY` 仅启用 Space 钱包，必须与个人 billing business 不同，并在 API、task worker、system worker 中保持一致。未配置或与个人 business 相同时，个人扣费照常，钱包充值关闭。钱包 business 不配置默认套餐，并使用自己的公开一次性充值商品（`meta.appName = "cohub"`、`business / purchased / usd_micro_cent`）。不要通过关闭个人默认套餐来规避免费额度。完整配置、迁移与验收边界见 [`docs/space-wallet.md`](../../docs/space-wallet.md)。

Cohub 当前使用的 credit type 是 `usd_micro_cent`，语义为美元的 micro-cent 最小单位：

- `1 usd_micro_cent = $0.00000001`
- `100_000_000 usd_micro_cent = $1`
- free plan 每月赠送 `$10` 时，billing grant amount 应为 `1_000_000_000`

API 会把余额和透支状态按美元展示给前端，但写入 billing 的 usage amount 使用 `usd_micro_cent` 原始单位。

## Values files

This repository ships `values.example.yaml` only.

```bash
cp values.example.yaml values.yaml
# edit values.yaml for your environment
./deploy.sh
```

Do not commit real `values.yaml` or `secrets.yaml`.

