# Platform Config samples / 平台配置样例

Place custom definitions in the existing Platform Config storage. Workspace
search has a built-in schema when its file is absent; these files override it.
Sandbox startup never writes or seeds shared Platform Config.

将自定义定义放入现有 Platform Config 存储。工作区 schema 文件不存在时使用内置配置，
平台文件可覆盖它；sandbox 启动不会写入或初始化共享平台配置。

```text
<PLATFORM_CONFIG_ROOT>/
└── platform/
    └── .cohub/
        └── search/
            ├── workspace.candidates.json
            └── business.documents.json
```

`PLATFORM_CONFIG_ROOT` defaults to `/configs` on the API. On the storage PVC,
this directory is `${CONFIGS_SUBPATH}/platform/.cohub/search`; new sandbox Pods
mount it read-only at `/configs/platform/.cohub/search`.

API 的 `PLATFORM_CONFIG_ROOT` 默认是 `/configs`；PVC 上的对应目录为
`${CONFIGS_SUBPATH}/platform/.cohub/search`，新 sandbox Pod 将其只读挂载到
`/configs/platform/.cohub/search`。

- `workspace.candidates.json`: optional override of the built-in workspace schema.
  `content` must use trigram, and `fingerprint` must be a stored keyword.
  工作区内置配置的可选覆盖：`content` 使用 trigram，`fingerprint` 使用可返回的 keyword。
- `business.documents.json`: example for a separately managed business index;
  it does not enable any App/Session producer by itself.
  独立业务索引示例，本身不会启用 App/Session 数据同步。

The workspace runtime polls every five seconds. Changed schema content builds
a separate index generation; queries keep using the active one until cutover.
Invalid config and failed builds leave the current index available. Removing
the override rebuilds with the built-in schema. Publish config files by atomic
rename to avoid partial JSON writes. Formatting-only changes do not rebuild.
Other business producers own their rebuild/catch-up lifecycle; the generic
binary does not watch or fetch Platform Config itself.

工作区 runtime 每五秒检查配置；内容变化后独立重建，切换前查询使用当前索引。
配置无效或构建失败不会替换当前索引，删除覆盖文件会重建为内置配置。
建议用原子重命名发布文件，避免读到半份 JSON；仅格式变化不触发重建。
其他业务写入方管理自己的重建和追平，通用 binary 不自行监听或读取平台配置。
