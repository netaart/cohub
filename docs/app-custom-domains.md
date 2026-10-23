# App 自定义域名方案

状态：已实现（2026-10-22）。通用的 Cohub App 自定义域名能力。运维上线步骤见 `deploy/web/README.md`。

## 1. 目标与边界

**目标**

- 已发布的公开 App（静态 file/directory 与 port）可以绑定用户自有域名，例如 `app.example.com`。
- 证书签发、续期、TLS 终止全部由 Cloudflare for SaaS 负责；集群网关（Traefik）零改动、零新增证书、零新增路由。
- server、SDK、CLI、Web（桌面/移动）端到端可用；状态变更实时同步到各客户端。

**v1 不做**

- 泛域名（`*.example.com`，Cloudflare 仅 Enterprise 支持）。
- 根域名 A 记录接入（Apex proxying 为 Enterprise 付费项）；根域名仅在用户 DNS 支持 CNAME 拉平时可用。
- 预验证 / 零停机迁移（`_cf-custom-hostname`、TXT DCV），见 §5.1。
- 自动从 `cohub.live/.../w/slug` 或 `{id}.netaverses.cc` 跳转到自定义域名（后续）。
- `space` 可见性 App、board/file 类 App 绑定域名。
- 沙箱常驻、持久化、备份——这是 port App 托管可靠性问题，与域名正交。

## 2. 总体架构

```
用户 DNS:  app.example.com  CNAME  cname.cohub.live
                                │
                     ┌──────────▼───────────────────────────────┐
                     │ Cloudflare 边缘（cohub.live Zone，SaaS）   │
                     │ - Custom Hostname：DV 证书签发/续期/TLS    │
                     │ - WAF / 限速（按 hostname）                │
                     │ - 回退源 cohub.live → cohub-web（Worker） │
                     └──────────┬───────────────────────────────┘
                                │ entry.worker.ts：Host → App
                                │   GET {API}/api/apps/by-origin
              ┌─────────────────┴───────────────────┐
     content.kind = web                     content.kind = port
   复用 serveStandaloneApp                  全量反向代理（同 Zone 子请求）
   （OSS/CDN 静态资源）                     fetch https://s-<space>-<port>.cohub.live
                                                    │（现有 *.cohub.live 证书、现有 HTTPRoute）
                                                    ▼
                                            Traefik → 沙箱 Service
```

关键点：

- SaaS Zone 就是 `cohub.live`。自定义域名只存在于 Cloudflare 与 Cohub 数据库中；Traefik 看到的仍是 `s-<space>-<port>.cohub.live`，与今天直接访问完全相同。
- Worker 到 `s-…cohub.live` 是**同 Zone 子请求**：Worker 设置 `X-Real-IP` 后，上游收到的 `CF-Connecting-IP` 即访客真实 IP，App 无需改限流逻辑（跨 Zone 时会被替换为 `2a06:98c0:3600::103`，这是不选独立 Zone 的主要原因之一）。
- 现有 `{id}.netaverses.cc` 独立域名链路原样保留；自定义域名只扩展“域名 → App”的解析来源与 port 代理能力。
- 不使用 Cloudflare `custom_origin_server`：挂了 Worker 路由后它会被绕过；直接回源时 SNI/Host 是用户域名，Traefik 无对应证书。

## 3. Cloudflare 配置（运维，一次性）

| # | 位置 | 配置 |
|---|---|---|
| 1 | cohub.live → SSL/TLS → Custom Hostnames | 已启用（Free/Pro/Business 含 100 个，超出 $0.10/个/月） |
| 2 | Fallback Origin | 保持 `cohub.live`。它是 `cohub-web` 的 Worker 自定义域，自定义主机名的流量经回退源进入该 Worker，Host 头保持为用户域名（现有的 `cohub.neta.art` 即如此） |
| 3 | DNS | `cname.cohub.live  CNAME  cohub.live`，Proxied。这是给用户的 CNAME 目标 |
| 4 | Workers Routes | **不新增**。同一主机名上路由优先于 Worker 自定义域，`*/*` 会把 `dev.cohub.live` 抢到 prod Worker，还会拦下直连网关的子域名。**前置条件**：§8.1 的 Host 分流已上线（设置 `PUBLIC_SITE_HOST_SUFFIXES` 并部署 Web），再配置 secrets 开启功能 |
| 5 | Custom Hostnames 默认 | DV、HTTP 验证、最低 TLS 1.2 |
| 6 | API Token | 仅 cohub.live，权限 `Zone › SSL and Certificates › Edit`。写入 `cohub-api-secrets`（API 与 worker 共用）：`CLOUDFLARE_SAAS_API_TOKEN`、`CLOUDFLARE_SAAS_ZONE_ID`。所有 CF 调用都在 system worker 的检查任务里；API 只以 Zone ID 是否配置判断功能是否开启 |
| 7 | Cache Rule | 沙箱主机 `s-*.cohub.live`（prod）与 `d-*.cohub.live`（dev）→ Bypass cache（与 §8.4 的 `cache: "no-store"` 双保险；这也修复今天直连 `s-…` 时 `.pdf` 等默认可缓存扩展名被边缘缓存的隐患） |
| 8 | 安全规则 | 针对自定义主机名流量的限速规则，条件 `not (http.host eq "cohub.live" or ends_with(http.host, ".cohub.live"))`，例如每 IP 每 10s 300 次（cohub.live 为 Pro，支持按 `http.host` 写规则）。作用是在边缘挡掉刷量，保护 Traefik 与沙箱 |

保留名：不得为 `cohub.live` 本身创建自定义主机名（Cloudflare 限制）；§6 的拒绝列表同时覆盖其子域。

**dev 环境**：不开启。自定义主机名属于 Zone 级资源，dev 与 prod 共用 cohub.live，流量都经回退源进入 prod Worker，dev 建出的主机名无法访问。dev 不配 `CLOUDFLARE_SAAS_ZONE_ID`。

## 4. 数据模型

新表 `v2.app_domains`（drizzle 迁移）：

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `app_id` | uuid not null | v1 `unique(app_id)`，每个 App 一个域名 |
| `space_id` | uuid not null | 冗余，便于鉴权、清理与事件分发 |
| `hostname` | varchar(253) not null | 规范化后的小写 ASCII（punycode）；部分唯一索引 `unique(hostname) where status in ('provisioning','active','removing')` |
| `status` | varchar(16) not null | `pending` / `provisioning` / `active` / `failed` / `removing`，check 约束 |
| `verification_token` / `token_issued_at` | varchar(64) / timestamptz not null | `_cohub-challenge` TXT 期望值及签发时间；每次进入 `pending` 都重新生成，`pending` 的 7 天期限从签发时间算起 |
| `provider_hostname_id` | varchar(64) null | Cloudflare custom hostname id |
| `provider_status` | varchar(32) null | CF `status` 原值 |
| `certificate_status` | varchar(32) null | CF `ssl.status` 原值 |
| `error_code` / `error_message` | varchar / text null | 最近一次可操作错误 |
| `billing_claimed_at` | timestamptz null | 首次生效时在扣费前原子写入，保证每条绑定最多扣一次（§6.1） |
| `removal_intent` | varchar(8) null | `user` / `failure`，仅 `removing` 时非空，决定清理后删行还是落为 `failed` |
| `provider_unhealthy_since` | timestamptz null | CF 首次报告 `moved`/`deleted` 的时间，用于 §5.3 宽限期 |
| `verified_at` / `activated_at` / `last_checked_at` | timestamptz null | |
| `created_by` | varchar(255) not null | userUuid |
| `created_at` / `updated_at` | timestamptz | |

同一 hostname 可以同时存在多条 `pending`/`failed` 认领（不同 App），但最多一条处于独占状态（`provisioning`/`active`/`removing`）。只有独占行拥有 CF 主机名；删除规则见 §5.3。

## 5. 验证流程

### 5.1 DNS 记录与读取方

| 记录 | v1 是否需要 | 谁读取 | 作用 |
|---|---|---|---|
| `app.example.com  CNAME  cname.cohub.live` | 必需 | 访客 DNS 解析；**Cloudflare**（主机名 HTTP 验证）；**CA 经 Cloudflare**（证书 HTTP DCV，请求 `/.well-known/` 下的验证路径，由 CF 边缘直接应答，不进 Worker/Traefik） | 路由 + 让 Cloudflare 完成主机名验证与证书签发 |
| `_cohub-challenge.app.example.com  TXT  cohub-verify=<token>` | 必需 | **仅 Cohub API 检查任务**（`node:dns`，见 §5.4）。Cloudflare 不读 | 证明域名归属于发起绑定的 Cohub App；通过后才调用 CF API 创建主机名 |
| `_cf-custom-hostname.<host>  TXT` | 不需要 | Cloudflare | 预验证：切 CNAME 前先完成主机名验证（零停机迁移场景） |
| `_acme-challenge.<host>  TXT` 或 DCV 委托 CNAME | 不需要 | CA 经 Cloudflare | TXT DCV：切 CNAME 前先签发证书 |

结论：v1 的正常路径下，用户只加两条记录；Cloudflare 只依赖 CNAME，`_cohub-challenge` TXT 只给我们自己的程序用。

若用户域名存在 CAA 记录，需允许 Cloudflare 使用的 CA（Let's Encrypt、Google Trust Services 等），否则证书会卡在 pending；检查任务将此映射为 `certificate_failed` 并给出提示。

### 5.2 为什么要自有 TXT

借鉴 xLog `_xlog-challenge`：CNAME 指向 `cname.cohub.live` 只能证明“域名指向 Cohub”，不能证明“属于哪个 Cohub App”。没有 TXT，任何人都可以抢先认领一个已经指向我们的域名（例如前用户解绑后遗留的 CNAME）。

- TXT 只在**认领时**必须存在；匹配后才调用 CF 创建主机名，也避免为垃圾申请付费。
- 生效后不再依赖 TXT（用户可以删除），避免 DNS 抖动或误删导致正式站点下线。
- 只有**当下证明 DNS 控制权**（自己的 token 出现在 TXT 中）才能改变已有绑定；单纯提交 hostname 不会影响任何人。

### 5.3 状态与认领

```
add ──► pending ──自己的 TXT 匹配──► provisioning ──CF active 且 ssl active──► active
           │  (非独占，可多方并存)       (独占)                                  │
           │ 7 天未匹配                     │ CF 报错/7 天未签发               │ CF moved|deleted 持续 72h
           │                                ▼                                  ▼
           │                    removing（删除 CF 主机名，保留失败原因）◄────────┘
           ▼                                │
         failed ◄───────────────────────────┘
pending|failed ── remove ──► 直接删除行（不调用 CF）
provisioning|active ── remove ──► removing ──(按自身 provider_hostname_id 删除 CF 主机名)──► 删除行
```

- **认领**：`POST` 总是为调用方 App 创建一条 `pending` 认领并返回其专属 token，即使该 hostname 已被别的 App 占用。v1 每个 App 一条记录：已有独占记录返回 `app_domain_exists`；已有其他 hostname 的非独占记录则删除后新建（新 id，即新的一条绑定）；同一 hostname 的 `failed` 记录按“重新检查”处理。
- **token 一次性**：行每次进入 `pending`（新建、重置、从 `failed` 重新检查）都生成新 token。旧 token 即使还留在 DNS 里，也无法再次晋升。
- **晋升**：检查任务发现某条 `pending` 的 token 出现在 TXT 中，即在 §5.4 的 hostname 锁内晋升为 `provisioning`。若此时另一 App 持有该 hostname 的 `provisioning`/`active` 行，视为**迁移**，还要求持有方的 token 已不在 TXT 中（DNS 所有者明确撤销了旧绑定，否则记 `domain_in_use`）：旧行删除，其 `provider_hostname_id` 转给新行（CF 主机名不删不建）；若该 CF 主机名与证书已是 active，新行在同一步直接晋升为 `active` 并清理 `app-origin:<hostname>`，迁移不中断服务。旧 App 所在 Space 收到 `app.domain.removed`（`reason: "transferred"`）。持有方为 `removing` 时等待其完成。
- 其他 `pending` 认领不受影响；7 天未匹配转为 `failed(verification_expired)`，可通过“重新检查”回到 `pending`（新 token）。
- **删除**：`pending`/`failed` 行不拥有任何 CF 资源，直接删除行，不调用 CF。只有 `provisioning`/`active` 行进入 `removing`，并且只按自身 `provider_hostname_id` 删除 CF 主机名。
- `active` 后只看 Cloudflare：首次报告 `moved`（CNAME 不再指向我们）或 `deleted` 时记录 `provider_unhealthy_since`，并改为每小时检查。宽限期内一旦发现 CNAME 已恢复指向 `cname.cohub.live`（我们自己解析），或用户点“重新检查”，就用原 SSL 参数 `PATCH` 刷新该主机名（Cloudflare 要求 moved 状态显式刷新才会重新验证），不更换 token；CF 回到 active 时清空 `provider_unhealthy_since`。持续 72 小时未恢复 → 经清理后转为 `failed(dns_moved)`。
- **独占 → failed 必须先清理**：`provisioning`/`active` 因证书失败、超时或 `dns_moved` 要转为 `failed` 时，先进入 `removing`（保留 `error_code`，仍占用 hostname），按自身 `provider_hostname_id` 删除 CF 主机名；成功后清空 `provider_hostname_id` 并落为 `failed`，失败则保持 `removing` 退避重试。由此保证 `failed` 行从不持有 CF 资源，用户移除时可直接删行。`removing` 结束后的去向由 `removal_intent` 决定：`user`（用户移除、App/Space 删除）→ 删行；`failure` → `failed`。失败清理期间用户移除，将意图改为 `user`。

### 5.4 检查任务

- BullMQ 任务 `app_domain.check`（`COHUB_SYSTEM_QUEUE`，由 system worker 执行），每个域名固定 jobId，检查完用 `moveToDelayed` 自行改期；API 只写库并入队。`pending` 退避 30s → 2m → 10m → 1h，最长 7 天。
- 每小时的 `app_domain.sweep` 为检查逾期的域名补回丢失的任务。
- 常规任务正在运行时 API 发起的检查（例如用户移除域名）会另排一个独立的一次性任务（2 秒后执行，每次请求一个，API 返回前已入队）。它在域名仍需较快复查时继续，直到某次在该请求之后才开始的常规检查接手；它从不改动常规任务的排期，所以既不会漏掉变更，也不会推迟它。时间统一取 Redis 服务器时钟。
- 用户点击“重新检查”立即入队（每域名 30 秒冷却）。
- TXT 查询使用 `node:dns` 的 `Resolver`，显式指定公共解析器（1.1.1.1、8.8.8.8），任一命中即可；不新增依赖。
- `active` 域名每 6 小时查一次 CF 状态，分散执行（CF API 限额 1200 次/5 分钟）。

**CF 主机名的幂等与并发**

- 同一 hostname 的状态迁移与 CF 调用由 Redis 锁 `app-domain-lock:<hostname>`（带租期）串行化；CF 调用设 10s 超时，状态写入用短事务并以行当前状态为条件（compare-and-set），不在事务内等待 CF。
- **创建或采用**（仅在晋升为 `provisioning` 之后）：先 `GET /custom_hostnames?hostname=<h>`，已存在则采用（覆盖崩溃重试、运维手工创建、删除失败的遗留）；创建返回“重复”错误时同样回查采用。按 hostname 回查 CF 只用于这一步，绝不用于用户发起的删除。
- **采用时按状态处理**：`active` 或仍在验证中 → 直接使用；`moved`/`deleted`，或证书验证已超时/失败 → 用原 SSL 参数调用 `PATCH /custom_hostnames/<id>` 触发重新验证（Cloudflare 文档中的 Refresh）。`provisioning` 状态下用户点“重新检查”也走这个刷新逻辑，而不只是轮询。
- **删除**：`removing` 行按自身 `provider_hostname_id` 删除 CF 主机名，CF 返回 404 视为成功；失败保持 `removing` 并退避重试。`provider_hostname_id` 为空（创建前崩溃）时只删行；可能遗留的 CF 主机名会在下一次有人证明所有权并晋升时被采用。

## 6. 域名规范化与准入

规范化：`trim` → 去末尾 `.` → `new URL("https://" + input).hostname`（得到小写 punycode）→ 拒绝含端口、路径、`*`、IP 字面量、单标签、超长（>253 / 标签 >63）。

拒绝列表由现有配置推导：沙箱公网域名（`cohub.live`、`cohub.run`）、CNAME 目标所在 Zone、独立域名模板所在 Zone（如 `netaverses.cc`）、Web 主站域名，及其子域。CF 自身的保留域/公共后缀错误映射为 `domain_invalid`。

准入：

- App `status=published`、`visibility=public`、当前版本 `content.kind ∈ {web, port}`。
- 调用者在 App 所在 Space 拥有 `app.manage`。
- 配置了 `CLOUDFLARE_SAAS_ZONE_ID` 即对所有人开放（Token 只有 system worker 需要），由 §6.1 的费用控制数量。
- 检查任务在晋升前也会复核：App 已删除则直接丢弃认领；不再符合条件则保持 `pending` 并记 `app_not_eligible`，不会创建主机名或扣费。
- 余额足以支付 §6.1 的费用。

### 6.1 计费

每条绑定一次性扣 **$5**（常量 `APP_DOMAIN_PRICE_USD`），沿用现有 `spaceWalletBilling`：Space 钱包余额足够则由 Space 整笔支付，否则由发起绑定的用户（`created_by`）整笔支付，不拆分。

| 时机 | 动作 |
|---|---|
| `POST` 认领 | 用现有 usage gate 预检余额，不足返回 `insufficient_balance`，不创建记录 |
| `pending` → `provisioning` | 创建 CF 主机名前再预检一次；不足则保持 `pending` 并记 `insufficient_balance`，充值后“重新检查”继续 |
| 首次变为 `active` | 原子写入 `billing_claimed_at`（已有值则跳过），再调用 `recordUsage`：`usageType: "app.domain"`、`sourceId: <domainId>`、`operationId: app-domain:<domainId>`、`reason: Custom domain <hostname>` |

- **只在生效时扣费**：证书没签下来、用户中途放弃，都不收费。
- **每条绑定最多一次**：同一行从 `failed` 重新检查、`moved` 后恢复都不再扣。移除后重新添加、或迁移到另一个 App，是新的一条绑定，重新扣费。
- **不退款**：移除、App 删除、`dns_moved` 失效都不退。
- **扣费异常**：与现有钱包策略一致，扣费请求抛错或超时时只记录日志供人工核对，不重试、不换付款方，绑定照常生效；`overage` 同样只记日志。网站可用性不依赖计费服务。
- **未配置计费**（自托管）：不预检、不扣费。
- 新增 `COHUB_BILLING_USAGE_TYPES.appDomain = "app.domain"`；余额流水里自动显示为 “App Domain”。

## 7. API

接口在 `app-domains.route.ts`，挂载于 `/api/apps`（并按双挂载约定挂于 `/api/works`），鉴权 `app.manage`。`GET` 返回 `{ domains, enabled, priceUsd, cnameTarget }`。

```
GET    /api/apps/:id/domains
POST   /api/apps/:id/domains                { hostname }
POST   /api/apps/:id/domains/:domainId/check
DELETE /api/apps/:id/domains/:domainId
```

响应体：

```ts
type AppDomainRecord = {
  id: string;
  appId: string;
  spaceId: string;
  hostname: string;
  url: string; // https://<hostname>
  status: "pending" | "provisioning" | "active" | "failed" | "removing";
  dnsRecords: Array<{
    type: "CNAME" | "TXT";
    name: string;
    value: string;
    purpose: "routing" | "ownership";
    satisfied: boolean | null;
  }>;
  certificateStatus: string | null;
  error: { code: AppDomainErrorCode; message: string } | null;
  verifiedAt: string | null;
  activatedAt: string | null;
  lastCheckedAt: string | null;
  priceUsd: number;
  charged: boolean;
};

type AppDomainErrorCode =
  | "domain_invalid"
  | "domain_reserved"
  | "domain_in_use"
  | "app_domain_exists"
  | "app_not_eligible"
  | "ownership_not_found"
  | "verification_expired"
  | "insufficient_balance"
  | "dns_moved"
  | "certificate_failed"
  | "provider_unavailable";
```

错误信息为简洁英文，例如 `TXT record _cohub-challenge.app.example.com not found; expected cohub-verify=<token>`。

App 记录不变；域名只经上述接口与实时事件获取。

### 7.1 `/api/apps/by-origin` 扩展

解析顺序：

1. 若 hostname 命中 `{id}` 模板 → 原逻辑。
2. 否则查 `app_domains`（`status='active'`）→ App。
3. App 仍需 `published` 且非 `space` 可见。

已被某个 App 占用（`provisioning`/`active`/`removing`）但当前不能提供服务的域名返回 404 `app_origin_unavailable`，与未绑定的 `app_origin_not_found` 区分，授权代理据此拒绝回退到白名单。

- Redis 缓存 `app-origin:<hostname>` 只记 hostname → appId（正向 60s、负向 30s），域名状态变化时主动删除；App 状态、可见性与内容每次实时读取，所以发布与下线无需清缓存。
- port 内容沿用现有 `getAppContent` 的 `{ kind: "port", url, port }`。该 URL 今天已经由 `/api/apps/:id/public`、`by-slug` 公开返回，v1 不假装隐藏；封住直连属于后续的仅边缘访问模式。
- 自定义域名的响应 `Cache-Control: no-store`，不叠加 HTTP 缓存层。

授权代理（`app-auth`）：`by-origin` 命中某个 App 时，只接受该 App 自己的 `appId`，不再回退到 `.neta.art` 等后缀白名单（与现有 `{id}` 主机一致）。白名单只说明域名可信，而自定义域名上跑的是某个 App 的代码，不能借白名单以其他 App 的名义申请授权。实现上即 `originAccepted = resolved ? resolved.id === appId : isLegacyAppOriginAllowed(...)`。

### 7.2 生命周期联动

| 事件 | 处理 |
|---|---|
| App 下线（disabled） | 保留绑定；边缘 404 |
| App 删除 / Space 删除 | 入队删除 CF 主机名与行 |
| App 可见性改为 space / 内容类型变为 board/file | 保留绑定，边缘 404；UI 显示 `app_not_eligible` |
| 发布新版本 | 清 `app-origin:<hostname>` |

解绑或下线后的最长生效延迟 = Worker 内存缓存 TTL（30s）。

### 7.3 实时事件

新增 Space 域事件 `app.domain.updated`（payload：`{ domain: AppDomainRecord }`）与 `app.domain.removed`（`{ appId, domainId, hostname, reason: "removed" | "transferred" }`），沿用 `dispatchSpaceDomainEvent`；Web/桌面据此更新本地缓存与 UI，无需轮询。token 本就公开发布在 DNS 中，对 Space 成员可见不构成泄露。

## 8. 边缘 Worker

改动集中在 `apps/web/entry.worker.ts` 与 `src/lib/server/standalone-*.ts`。

### 8.1 Host 判定

经回退源进入 cohub-web 的请求按 hostname 分流：`{id}` 模板 → 现有独立域名逻辑；`PUBLIC_SITE_HOST_SUFFIXES` 列出的主站 Zone → SvelteKit；其余 → 自定义域名候选，查不到直接 404。

`PUBLIC_SITE_HOST_SUFFIXES` 一经配置，分流即**无条件生效**：自定义域名候选绝不落入 SvelteKit，以免在第三方域名上渲染 Cohub 主站、登录页与授权页。该 Web 版本必须先于配置 secrets 开启功能上线；未配置时行为与现状一致。主站别名（如 `cohub.neta.art`）也经回退源进入，必须列入 `PUBLIC_SITE_HOST_SUFFIXES`。

### 8.2 App 解析缓存

- isolate 内存缓存（现有 30s / 128 条）→ API（Redis）。不使用 `caches.default`：它按机房存储，无法全局主动失效。
- 404 同样缓存 30s，防止扫描流量打穿到 API。
- `asAppDetail` 放开 `content.kind === "port"`，并按沙箱主机的精确模式校验上游：`^https://<prefix>-<uuid>-<port>\.cohub\.live$`，`prefix` 与 `getSandboxPublicHostname` 一致（prod 为 `s`，dev 为 `d`，取自 `PUBLIC_COHUB_ENV`），Zone 必须是 `PUBLIC_SITE_HOST_SUFFIXES` 的第一项（SaaS Zone），端口属于 `SANDBOX_PUBLIC_PORTS`。既杜绝开放代理，也排除 `api.`、`dev.` 等主机以及跨 Zone 的 `cohub.run`（会丢失真实 IP）。

### 8.3 静态 App

直接复用 `serveStandaloneApp`；资源仍来自 OSS/CDN，不经过 Traefik。

### 8.4 port App 反向代理

| 项 | 规则 |
|---|---|
| 方法 | 全部透传（含 POST/PUT/PATCH/DELETE/OPTIONS） |
| 目标 | 以上游 origin 为基准逐个赋值 `pathname`、`search`（不做 URL 解析，`//evil.example` 这类路径不会跳到别的主机），再校验 origin 未变；`redirect: "manual"` |
| 请求体 | 流式透传，不缓冲。上限默认 30 MiB（可配）：`Content-Length` 超限直接 413；无 `Content-Length`（HTTP/2 流、chunked）时经计数 `TransformStream` 透传，累计超限即中止上游请求并返回 413 |
| 请求头 | 透传 Cookie、Origin、Content-Type、Authorization、`X-CSRF-Token` 等业务头；移除 hop-by-hop 头（WebSocket 升级请求保留 `Upgrade`/`Connection`）、`Host`、客户端传入的 `X-Forwarded-*`、`X-Cohub-*` |
| 追加头 | `X-Real-IP: <CF-Connecting-IP>`（同 Zone 子请求下即上游的 `CF-Connecting-IP`）、`X-Forwarded-Host: <自定义域名>`、`X-Forwarded-Proto: https`。Traefik 对非信任来源可能覆盖 `X-Forwarded-*`，因此 App 生成绝对 URL 时以配置的公开 origin 为准 |
| WebSocket | 带 `Upgrade: websocket` 时透传给 `fetch`，原样返回 101 响应 |
| 重定向 | 绝对地址的 `Location` 指向上游 origin 时改写为自定义域名 origin；相对地址原样返回，由浏览器按当前页面解析 |
| Set-Cookie | 删除所有 `Domain=` 属性，服务端下发的 Cookie 统一为仅当前主机有效 |
| 缓存 | 子请求显式 `cache: "no-store"`（不读不写 Zone 缓存，否则 `.pdf` 等默认可缓存扩展名可能把需登录的附件缓存给匿名访客），并由 §3 第 7 步的 Cache Rule 兜底；不加缓存头；SSE/流式响应原样透传 |
| 注入 | 不注入 runtime 脚本、不加 Cohub bar |
| 上游失败 | 仅在 `fetch` 异常或 Cloudflare 52x（520–526）时返回简洁的 “App is offline” 页面（`no-store`）；App 自己返回的 502/503/504 原样透传 |

**父域 Cookie 的信任边界**：删除 `Domain=` 只约束服务端响应头，约束不了页面 JavaScript。任何跑在 `app.example.com` 上的内容（静态 App 也一样）都能写入 `Domain=example.com` 的 Cookie，浏览器也会把父域 Cookie 发给子域。绑定子域名即意味着父域信任该 App 的代码：父域的登录 Cookie 应使用 `__Host-` 前缀（不可被子域覆盖，也不会发给子域）；不信任时应换用独立的可注册域名。Web 绑定界面对子域名展示这一提示。

### 8.5 可观测性（后续）

v1 未实现。计划：Worker 采样日志记录 hostname、appId、kind、上游状态码、耗时；不记录 Cookie/Authorization/查询串中的 `code`、`state`。

## 9. 对集群网关的影响

| 维度 | 影响 |
|---|---|
| 证书 | 无新增；签发/续期/存储在 Cloudflare，DCV 由 CF 边缘应答 |
| TLS 握手 | 访客握手终止于边缘；边缘到 Traefik 复用现有 `*.cohub.live` 连接 |
| 路由 | 无新增 HTTPRoute；不因增删域名触发 Traefik 重载 |
| 流量 | 与直接访问 `s-…` 同性质；可能因传播而放大 → 由限速规则 + Worker 负向缓存 + （可选）Traefik `inFlightReq` 兜底 |

上线前后对比 Traefik 指标：活跃连接、TLS 握手速率、p99 延迟、5xx。

## 10. 客户端

### 10.1 SDK（`@neta-art/cohub`）

- `apps.listDomains(appId)`、`addDomain(appId, hostname)`、`checkDomain(appId, domainId)`、`removeDomain(appId, domainId)`，与 `listPromotions` 等现有方法同一风格。
- 类型导出 `AppDomainRecord`、`AppDomainListResponse`、`AppDomainErrorCode` 等；`space.events` 支持 `app.domain.updated` / `app.domain.removed`。
- `app-runtime` 的 `createOriginAppResolver` 已基于 Origin 调 `/api/apps/by-origin`，自定义域名上的 App 自动获得 Cohub 身份与授权桥，无需改动。

### 10.2 CLI

```bash
cohub apps domains ls <app>
cohub apps domains add <app> app.example.com
cohub apps domains check <app> app.example.com
cohub apps domains rm <app> app.example.com --yes
```

`add`/`check` 输出待添加的 DNS 记录表与当前状态；`add` 需要 `--yes` 确认 $5 费用（非交互环境不带则报错）；`--json` 返回 `AppDomainRecord`；`<domain>` 可以是 hostname 或 id。

### 10.3 Web（桌面/移动）

- 位置：App 设置面板 → “自定义域名”区块。
- 空状态：一个输入框 + 添加按钮，按钮上标明 $5。余额不足时错误旁提供现有充值入口。
- 已添加：域名 + 状态标记；DNS 记录表（类型 / 名称 / 值，每格可复制，已满足的行打勾）；“重新检查”“移除”。`active` 后记录表折叠，显示可点击的 `https://` 链接。
- 移动端：记录以卡片纵向堆叠，长值换行显示且可复制。
- 数据：每个 App 的域名列表单独写入 IndexedDB 的 `app_domains` 存储（来自 `GET /domains` 与事件），首屏用本地数据渲染完整面板，后台静默刷新；`app.domain.*` 事件实时替换，不出现整块加载态。
- 文案全部走 Paraglide（中/英），一次只渲染一种语言。

## 11. 用户绑定流程

1. 在 App 设置（或 `cohub apps domains add`）输入域名，确认 $5 费用，得到两条 DNS 记录。
2. 在自己的 DNS 添加：
   - `app  CNAME  cname.cohub.live`（建议 DNS only；若用户自己的 Cloudflare 开了代理即为 O2O，其缓存/WAF 规则会先作用于该域名）
   - `_cohub-challenge.app  TXT  cohub-verify=<token>`
3. 等待 `active`（HTTP 验证通常数分钟），之后可删除 TXT。
4. 子域名绑定前阅读 §8.4 的 Cookie 信任边界提示。

port App 若要生成绝对 URL、OAuth 回调等，需自行把公开 origin 配置为自定义域名。

## 12. 上线与后续

服务端、边缘、SDK、CLI、Web 一次交付。上线按 `deploy/web/README.md` 的顺序：先发布带 Host 分流的 Web，再配置 Cloudflare 与路由，最后配置 secrets 开启功能。出口标准：静态 App 与 port App 各一个经自定义域名通过 §13 边缘用例；Traefik 指标无变化。

后续（按需）：仅边缘访问模式（Worker 追加密钥请求头，该 Space 的 HTTPRoute 按头匹配，封住 `s-…` 直连）；主域名跳转；预验证；CF Webhook；请求唤醒沙箱；按域名访问统计。

## 13. 测试

- 单元：hostname 规范化与拒绝列表、状态迁移、并存认领与迁移、失败后旧 token 不能再晋升、在 active 持有方存在时取消 pending 认领、在待采用的手工 CF 主机名存在时取消 pending 认领（均不触及 CF）、TXT 校验、by-origin 解析顺序、Worker Host 分流（开关关闭时未知 Host 404）、请求头过滤/追加、Location 与 Set-Cookie 改写、上游精确模式、无 `Content-Length` 的超限请求体；计费：余额不足拒绝认领与晋升、仅首次 active 扣费一次、`failed` 恢复与 moved 恢复不重复扣、扣费抛错不重试且绑定照常生效、未配置计费时免费。
- 集成：CF API 以假服务替身覆盖创建 / 重复创建与采用 / 采用 moved 主机名并刷新 / active → moved → DNS 恢复 → 刷新 → active / 创建成功后证书失败的清理 / 删除返回 5xx 时保持 removing / pending / active / moved / 删除与并发删除 / 限流 / 5xx。
- 边缘：dev Worker + 显式测试路由，覆盖静态 App、port App、POST 上传、WebSocket、SSE、App 下线 404、负向缓存；登录后请求私有附件、再匿名请求同一 URL，两次都到达上游且后者被拒。
- 压测：同一 port App 分别直连 `s-…` 与经自定义域名，对比延迟与 Traefik 指标。

## 14. 已决定

1. cohub.live 升级到 Pro。
2. CF API Token 由负责人配置到 system worker 的 k8s Secret（`CLOUDFLARE_SAAS_API_TOKEN`、`CLOUDFLARE_SAAS_ZONE_ID`）；普通配置 `APP_CUSTOM_DOMAIN_CNAME_TARGET=cname.cohub.live`。
3. 每条绑定从余额扣 $5（§6.1）。

## 附：xLog 对照

| | xLog | 本方案 |
|---|---|---|
| 路由记录 | CNAME → `cname.xlog.app`（阿里云 NLB，非 Cloudflare） | CNAME → `cname.cohub.live`（CF for SaaS） |
| 归属证明 | TXT `_xlog-challenge.<host>` = handle，请求路径上持续依赖 | TXT `_cohub-challenge.<host>` = token，仅认领时校验 |
| Host 解析 | 每次请求经 DoH 查 TXT（Redis 缓存） | 数据库权威绑定 + Redis/内存缓存，不在请求路径上查 DNS |
| 证书 | 不在仓库内管理 | CF 签发/续期，状态入库并实时推送 |
| 动态应用 | Next.js 单体内部 rewrite | 边缘反向代理到沙箱，网关零改动 |
