# Sandbox 网络隔离

`dev/` 和 `prod/` 使用同一份 Kubernetes NetworkPolicy，选择对应 sessions namespace 中所有带 `app=agent-sandbox` 标签的 Pod，包括已经运行的沙箱。策略同时启用 ingress 和 egress 默认拒绝，仅开放下列路径。

| 方向 | 来源或目标 | 端口 |
| --- | --- | --- |
| 入站 | 同环境 API、worker、user-worker、system-worker、gateway Pod | TCP 8788、3000、5173 |
| 入站 | `kube-system` 中的 Traefik Pod | TCP 3000、5173 |
| 出站 | `kube-system` 中的 CoreDNS Pod | UDP/TCP 53 |
| 出站 | 同环境 API Pod，供沙箱上报状态 | TCP 8787 |
| 出站 | 排除特殊地址范围后的 IPv4 公网 | 全部 |

公网规则排除私网、回环、链路本地、共享地址、保留地址和 Azure 平台虚拟地址。阿里云 `100.100.100.200` 包含在被排除的 `100.64.0.0/10` 中，AWS/GCP 等使用的 `169.254.169.254` 包含在 `169.254.0.0/16` 中。IPv6 出站保持默认拒绝，包括 IPv6 元数据和 NAT64 路径。公网 npm、Git、模型服务及用户应用仍可使用 IPv4。

## 部署条件与影响

合并后 API 的 dev/prod 发布流程，以及 `deploy/api/{dev,prod}/deploy.sh`，均会在更新 API Deployment 前应用策略。修改本目录会触发 API 发布工作流。已有沙箱无需重建；策略应用后，访问内网数据库、Redis、Kubernetes API、其他沙箱和 IPv6 公网的连接会受到限制。已建立连接的处理由 CNI 决定。

部署前必须核查：

- CNI 已启用 NetworkPolicy 的 ingress/egress 执行能力。仅成功创建资源无法证明流量已被阻止。
- Pod、Service、VPC 和节点地址范围均包含在排除的网段中。使用公网地址作为内部地址时，应将实际网段加入 `ipBlock.except`。
- CoreDNS 使用 `k8s-app=kube-dns`，Traefik 使用 `app.kubernetes.io/name=traefik`，且均位于 `kube-system`。NodeLocal DNS、hostNetwork 代理和其他 DNS 配置需要按实际网络提供精确规则。
- API、worker、gateway 标签与仓库部署清单一致。namespaceSelector 与 podSelector 位于同一个 peer 内，必须同时满足。
- 没有其他选择沙箱的 NetworkPolicy 放开更广泛的流量。Kubernetes 将多个策略允许的连接取并集。
- 标准 NetworkPolicy 对本节点通信、hostNetwork 和 Service 地址转换的处理存在实现边界。节点防火墙/CNI 主机策略和云平台应同时阻止沙箱通过节点访问元数据、节点服务和内部代理。需要在实际 CNI 上验证这些边界。

策略保留沙箱访问 API 的 TCP 8787；该服务上的接口授权仍由 API 实现。公网代理、API 代理等间接访问路径需要各自的目标地址和权限校验。

## 节点 RAM 角色

节点角色及实例元数据配置由云平台管理，本仓库没有相应 IaC。云资源负责人需要检查沙箱节点池绑定的实例角色，移除业务 OSS、数据库、密钥管理和账号管理权限，仅保留节点运行必要权限；业务权限使用独立工作负载身份。节点池元数据访问设置、节点防火墙和 CNI 主机策略应共同限制租户访问实例凭据。若已有凭据泄露，应封堵访问路径并撤销或轮换受影响权限。

## 验证

静态检查使用真实 `kubectl kustomize` 渲染两个环境，通过 Kubernetes 1.30 严格 schema 校验，并检查命名空间、通信例外、元数据地址覆盖及部署调用顺序：

```bash
python3 -m pip install -r deploy/sandbox-network/requirements-test.txt
python3 deploy/sandbox-network/test_policy.py
```

部署验收应在目标 CNI 中使用受控的临时沙箱执行：DNS 的 UDP/TCP 查询、IPv4 公网 HTTPS、API 状态上报、API/worker/gateway 控制连接、Traefik 公开端口均应成功；连接受控的其他租户 Pod、Redis、Kubernetes API、节点服务及云元数据地址应被阻止。跨节点、同节点、Service IP 和 Pod IP 均需覆盖，禁止读取或保存元数据凭据。完成后删除验收资源。此 PR 的本地检查不包含线上流量验证或云权限修改。
