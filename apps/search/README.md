# Cohub Search / 通用字符串搜索

`cohub-search` is a standalone Tantivy document engine. It accepts string fields
and arbitrary business types through a versioned JSON interface. A new type such
as `app`, `session`, or `custom.note` needs a producer mapping, not a Rust enum or
binary release. The engine never reads source files or connects to a database.

`cohub-search` 是独立的 Tantivy 文档引擎，通过版本化 JSON 接口接收字符串字段。
新增 `app`、`session`、`custom.note` 等业务类型只需增加数据映射，无需修改 Rust
类型或重新发布 binary。引擎不读取源文件，也不连接业务数据库。

## Platform Config / 平台配置

Schemas live in `<PLATFORM_CONFIG_ROOT>/platform/.cohub/search/<family>.json`.
The cloud sandbox mounts only that directory, read-only, at
`/configs/platform/.cohub/search`. Its workspace adapter reads
`workspace.candidates.json`; `COHUB_SEARCH_SCHEMA` can select a different path
for development. If the file is absent, the sandbox uses a built-in workspace
schema without writing Platform Config. Invalid JSON, incompatible fields, or
read errors do not trigger the fallback.

Schema 统一放在 `<PLATFORM_CONFIG_ROOT>/platform/.cohub/search/<family>.json`。
云端 sandbox 仅将该目录只读挂载到 `/configs/platform/.cohub/search`，
文件 Adapter 读取 `workspace.candidates.json`；开发环境可通过
`COHUB_SEARCH_SCHEMA` 指定路径。文件不存在时使用内置工作区 schema，不写入平台配置；
JSON 无效、字段不兼容或读取错误不会使用兜底配置。

Deployable examples are in `deploy/platform-config/platform/.cohub/search/`:
`workspace.candidates.json` overrides the built-in workspace definition;
`business.documents.json` demonstrates a separate string-document index.
The sandbox polls its workspace schema every five seconds after activation.
A canonical content hash ignores formatting and property order, but detects
field changes even without a schemaVersion bump. A changed definition builds a
separate generation while the active index still answers queries. File events
are queued during rebuilding and repaired by reconciliation when needed.
Only a successfully built candidate that still matches the latest config is
published. Invalid config or failed rebuilding leaves the active index serving.
Removing the override rebuilds with the built-in definition.

仓库样例位于 `deploy/platform-config/platform/.cohub/search/`：
`workspace.candidates.json` 用于工作区，`business.documents.json` 展示独立业务索引。
工作区定义可覆盖内置配置。激活后每五秒检查一次内容，忽略空白和属性顺序；即使未改
schemaVersion，字段变化也会触发独立代次重建。旧索引继续响应查询，文件事件排队并
在需要时重新同步补齐。候选构建成功且仍符合最新配置后才切换；配置无效或重建失败
保留当前索引。删除平台文件则通过同样的重建流程恢复内置定义。

The active generation is recorded atomically in `active.json`; each generation
stores the effective schema and index together. Restarts restore the last
published generation before retrying a changed or invalid platform config.
Retired processes stop after in-flight managed queries finish; their index
folders remain available for inspection and explicit cleanup. The configured
socket path is an atomically replaced symlink to the current private socket;
external clients should reconnect after a cutover. The generic binary itself
does not watch Platform Config. Other producers must orchestrate their own
rebuild/catch-up because only they can read their source data.

`active.json` 原子记录当前代次，各代次同时保存有效 schema 和索引。重启先恢复已发布
代次，再尝试平台新配置。旧进程在已有查询结束后停止，历史索引目录保留供检查和明确
清理。配置的 socket 路径通过原子替换链接指向当前私有 socket，外部客户端在切换后
应重连。通用 binary 不监听平台配置；其他业务写入方需要管理自己的重建与增量追平，
因为只有它们知道如何读取源数据。

## Interface / 接口

One process owns one schema, one index directory and one private Unix socket.
Multiple business types share that index, identified by `(spaceId, type, id)`.
A different indexing policy uses a separate schema and process with the same
binary. There is no business-type registry or executable plugin loader.

每个进程管理一份 schema、一个索引目录和一个私有 Unix socket。不同业务类型可共享
索引，文档由 `(spaceId, type, id)` 唯一标识。不同检索策略可用同一个 binary
启动独立 schema 和进程，无需业务类型注册表或代码插件。

| Field kind / 字段模式 | Meaning / 含义 |
| --- | --- |
| `text` | Lowercase word tokens; query tokens are ANDed / 按小写词项检索，多个词项取交集 |
| `keyword` | Exact, case-sensitive string / 区分大小写的字符串精确匹配 |
| `trigram` | Lowercase 3-character candidates; query needs ≥3 characters / 小写三字符候选索引，查询至少三个字符 |

Values are always single strings. Set `stored: true` only for fields needed in
results. `_id`, `_type`, `_space` are reserved stored keyword fields. All query
terms and filters are ANDed. `equal` requires a keyword field; `prefix` and
`glob` require a stored field. An empty query lists documents. Trigram results
are candidates: the caller verifies exact substring/regex semantics against its
source, as workspace `rg` consumers do. New analyzers or engine fixes may still
require a binary release.

字段值始终是单个字符串，仅需在结果返回的字段设置 `stored: true`。
`_id`、`_type`、`_space` 是内置精确匹配字段。多个词项和过滤条件取交集；
`equal` 仅用于 keyword，`prefix` 和 `glob` 需要可返回字段。空查询列出文档。
trigram 返回候选，由调用方根据源数据验证精确子串或正则语义。
新增分词算法或引擎修复仍可能需要升级 binary。

Run from `apps/search` / 在 `apps/search` 目录运行：

```bash
SEARCH_SCHEMA=../../deploy/platform-config/platform/.cohub/search/business.documents.json
cargo run -- apply --schema "$SEARCH_SCHEMA" --index /tmp/cohub-documents \
  --input examples/documents.json
cargo run -- query --schema "$SEARCH_SCHEMA" --index /tmp/cohub-documents \
  --input examples/query.json
cargo run -- status --schema "$SEARCH_SCHEMA" --index /tmp/cohub-documents
cargo run -- serve --schema "$SEARCH_SCHEMA" --index /tmp/cohub-documents \
  --socket /tmp/cohub-documents-run/search.sock
```

CLI `apply` and `query` read one JSON request from `--input` or stdin. They open
an exclusive writer and must not run against an index already served by a
process; use HTTP for a running engine. The socket parent must have mode `0700`,
and the socket has mode `0600`.

CLI 的 `apply`、`query` 从文件或标准输入读取一个 JSON 请求，会独占索引写锁。
已运行的索引请通过 HTTP 访问。socket 目录权限为 `0700`，socket 权限为 `0600`。

```bash
curl --unix-socket /tmp/cohub-documents-run/search.sock http://localhost/status
curl --unix-socket /tmp/cohub-documents-run/search.sock \
  -H 'content-type: application/json' --data-binary @examples/query.json \
  http://localhost/query
```

| HTTP | Contract / 契约 |
| --- | --- |
| `GET /healthz` | Document protocol version / 文档协议版本 |
| `GET /status` | Generation, coverage, count, source cursor / 代次、覆盖状态、数量、来源游标 |
| `POST /documents/apply` | Conditional batch upsert/delete / 条件批量写入与删除 |
| `POST /query` | Hits, stored fields, cursor, pagination token / 命中、字段、游标、分页令牌 |

TypeScript producers use `SearchIndexClient` from `@cohub/sandbox-client` and
contracts from `@cohub/protocol/search`. These are trusted server-side producers,
not browser clients. Query authorization and result hydration remain with the
owning application. Never place cross-user private data into a user-controlled
sandbox or treat an index filter as an authorization check.

TypeScript 写入方使用 `@cohub/sandbox-client` 的 `SearchIndexClient`，类型定义位于
`@cohub/protocol/search`。这是可信服务端接口，不用于浏览器。业务层负责权限检查和
源数据读取；跨用户私有数据不能放入用户可控制的 sandbox，索引过滤不等于权限验证。

```typescript
import { SearchIndexClient } from "@cohub/sandbox-client";

const index = new SearchIndexClient("/tmp/cohub-documents-run/search.sock");
const status = await index.status();
await index.apply({
  expectedCursor: status.sourceCursor,
  cursor: "outbox-batch-42",
  coverage: "complete",
  changes: [{
    operation: "upsert",
    document: { spaceId: "space-1", type: "custom.note", id: "note-1" },
    fields: { title: "Project notes", content: "项目发布计划", label: "team" },
  }],
});
const result = await index.query({
  terms: [{ field: "title", value: "project" }],
  filters: [{ field: "_space", operation: "equal", value: "space-1" }],
  limit: 20,
});
```

## Durability and rebuilding / 持久化与重建

Use one ordered producer per index. Each batch carries the last acknowledged
`expectedCursor` and a new unique `cursor`. The engine atomically commits the
documents, coverage and cursor in Tantivy commit metadata, then refreshes its
reader before acknowledging success. Repeating the last identical batch is
idempotent; a reused cursor with different content or an outdated precondition
returns HTTP 409. A SHA-256 digest of the canonical batch identifies exact
retries. Old batches cannot resurrect a deleted document. A producer must keep
its batch/outbox until acknowledged; it must not attach a fresh cursor to old
content after a conflict.

每个索引由单一有序写入方负责。批次携带上次确认的 `expectedCursor` 和新的唯一
`cursor`；文档、覆盖状态、游标在同一次 Tantivy 提交中持久化，刷新读取后才返回成功。
最近一次相同批次可幂等重试，旧游标或同游标不同内容返回 HTTP 409。规范化批次的
SHA-256 摘要用于识别重试，旧批次不能恢复已删除文档。写入方保留批次／outbox
直到确认；冲突后不能给旧数据换个新游标强行覆盖。

A rebuild uses a new index directory and a source snapshot plus ordered catch-up.
Write `coverage: partial` until catch-up finishes, then commit `complete`.
Schema changes fail explicitly without deleting or migrating the existing index.
Corrupt indexes are preserved and require an explicit rebuild. The binary release
version, schema version and index generation are independent. A paginated reader
passes the returned `snapshot` on subsequent queries; a mutation or process
restart invalidates it with HTTP 409, so the caller restarts its scan.

重建使用新目录，通过源数据快照和有序增量追平；完成前标记 `partial`，追平后标记
`complete`。schema 不匹配时明确报错，不删除或自动迁移旧索引。损坏索引保留原状，
由运维明确重建。binary 版本、schema 版本和索引代次独立。
分页时传回 `snapshot`；写入或进程重启会使其失效并返回 409，调用方重新扫描。

Limits: 32 fields, 4 MiB per value, 8 MiB per document, 1,000 mutations and
32 MiB per batch; query limit 1–5,000, offset ≤1,000,000. Responses are bounded
to 32 MiB and can return fewer hits with `truncated: true`; advance pagination
by the number of returned hits. Batch errors do not partially accept changes. HTTP 400/422 means invalid input, 409 means conflict,
and 503 means unavailable/busy. Clients do not auto-retry writes.

限制：32 个字段、每值 4 MiB、每文档 8 MiB、每批 1,000 条／32 MiB；
查询返回 1–5,000 条，offset 不超过 1,000,000。响应限制为 32 MiB，可能提前返回
`truncated: true`，分页按实际返回条数前进。批次错误不会部分接收数据。
HTTP 400/422 为输入错误，409 为冲突，503 为不可用／繁忙；客户端不自动重试写入。

## Workspace integration / 工作区接入

The Go sandbox owns the workspace adapter: `rg` enumerates eligible files with
nested `.gitignore` and filewatch exclusions; Go reads UTF-8 text and writes
`file` documents. Binary files, symlinks and files over 4 MiB are excluded.
Fingerprints are stored with content in the same commit. Reconciliation checks
metadata before rereading files; ordinary edits read only changed files. New
paths, directory operations and ignore changes trigger a metadata scan.
`fs.search` still returns workspace candidate paths with prefix/glob filtering.

Go sandbox 负责文件 Adapter：`rg` 按嵌套 `.gitignore` 和监听排除规则枚举文件，
Go 读取 UTF-8 文本并写入 `file` 文档，跳过二进制、符号链接和大于 4 MiB 的文件。
指纹和内容同时提交；同步先比较元数据，普通编辑只读变化文件。
新路径、目录操作、忽略规则变化触发元数据扫描。`fs.search` 仍返回工作区候选路径。

This is the first release: binary 0.1.0, document protocol v1 and workspace
schema v1. The adapter reads its definition from Platform Config and stores
index data at `<COHUB_SEARCH_INDEX_DIR>/generations/<id>/index`, with an immutable
schema snapshot beside it. The workspace contract requires
family `workspace.candidates`, `content` as trigram, and `fingerprint` as a stored
keyword; the schema version is supplied by configuration. First startup builds
from the workspace; subsequent starts reconcile the persistent index.
Other business types use external producers through the same document interface.

这是首版实现：binary 0.1.0、文档协议 v1、工作区 schema v1。
Adapter 从 Platform Config 或内置配置读取定义，索引保存于
`<COHUB_SEARCH_INDEX_DIR>/generations/<id>/index`，同级保存该代次的 schema 快照。
文件索引要求 family 为 `workspace.candidates`、`content` 为 trigram、`fingerprint`
为可返回的 keyword，schema 版本由配置指定。首次启动构建，后续启动同步持久化索引。
其他业务类型通过外部写入方接入同一文档接口。

## Release / 发布

Ordinary project tags do not publish Search. Source and adapter changes run CI;
release explicitly from an existing `vX.Y.Z` tag containing this workflow:
普通项目标签不会发布 Search；源码与 Adapter 变更运行 CI，需要发布时手动选择标签：

```bash
gh workflow run search-release.yml --ref vX.Y.Z
```

The static linux/amd64 release is published at:
静态 linux/amd64 binary 发布地址：

```text
https://public.cohub.live/search/latest.json
https://public.cohub.live/search/<version>/cohub-search-linux-amd64
https://public.cohub.live/search/<version>/cohub-search-linux-amd64.sha256
```

Versioned assets upload before serialized `latest.json` promotion. Older/equal
versions never replace the pointer. Promotion reads OSS directly and requires
`oss:GetObject` on `cohub-public/search/latest.json` in addition to upload rights.
Only `NoSuchKey` permits first creation; other read errors abort promotion.
Sandbox downloads verify SHA-256 and install atomically; running processes do
not auto-upgrade. `COHUB_SEARCH_VERSION` can pin a release.

版本文件上传成功后串行更新 `latest.json`，旧版／同版本不覆盖指针。更新直接读取 OSS，
除上传权限外还需要该对象的 `oss:GetObject`。仅 `NoSuchKey` 允许首次创建，其他读取
错误终止更新。sandbox 校验 SHA-256 后原子安装，运行中不自动升级，可通过
`COHUB_SEARCH_VERSION` 固定版本。

## Verification / 验证

```bash
cargo fmt --all -- --check
cargo test --locked --all-targets
cargo clippy --locked --all-targets --all-features -- -D warnings
# From apps/sandbox / 在 apps/sandbox 目录
COHUB_SEARCH_TEST_BIN=../search/target/debug/cohub-search go test -race ./search
```
