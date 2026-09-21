# Cohub Search

`cohub-search` is the standalone Tantivy indexer used by sandbox workspaces.
It owns the index writer and exposes a small HTTP API over a Unix socket.
The current provider is `workspace.candidates`: it returns candidate paths for
exact `rg` verification, rather than replacing grep semantics.

## Release artifacts

Version tags build a static `linux/amd64` musl binary. GitHub Release assets
are private; the public download is:

```text
https://public.cohub.live/search/latest.json
https://public.cohub.live/search/<version>/cohub-search-linux-amd64
https://public.cohub.live/search/<version>/cohub-search-linux-amd64.sha256
```

Versioned uploads run independently. A separate serialized job promotes
`latest.json` only to a newer `vX.Y.Z`; rerunning older or equal versions leaves
it unchanged. Promotion reads OSS directly, not the CDN. Release credentials
need `oss:GetObject` for `cohub-public/search/latest.json` in addition to the
existing upload permissions. Only a missing object allows first-time creation;
other read errors fail without updating the pointer.

版本文件独立上传，`latest.json` 由单独的串行任务更新，且只允许升级到更高的
`vX.Y.Z`。旧版或同版本重跑不会覆盖指针。更新时直接读取 OSS，不经过 CDN；
发布凭据除上传权限外，还需对 `cohub-public/search/latest.json` 拥有
`oss:GetObject` 权限。仅对象不存在时允许首次创建，其他读取错误会终止更新。

```bash
VERSION=v2.42.0
curl -fsSL "https://public.cohub.live/search/${VERSION}/cohub-search-linux-amd64" -o cohub-search-linux-amd64
curl -fsSL "https://public.cohub.live/search/${VERSION}/cohub-search-linux-amd64.sha256" -o cohub-search-linux-amd64.sha256
sha256sum -c cohub-search-linux-amd64.sha256
chmod +x cohub-search-linux-amd64
```

## Local usage

```bash
cargo run -- serve \
  --workspace /path/to/workspace \
  --index /tmp/cohub-search-index \
  --socket /tmp/cohub-search/search.sock \
  --ignore node_modules \
  --ignore custom/cache

curl --unix-socket /tmp/cohub-search/search.sock http://localhost/status
curl --unix-socket /tmp/cohub-search/search.sock -X POST http://localhost/index/full
curl --unix-socket /tmp/cohub-search/search.sock \
  -H 'content-type: application/json' \
  -d '{"literals":["workspace"],"limit":20}' \
  http://localhost/query
```

Repeat `--ignore` on `serve`, `full`, `update`, `query`, and `status` to exclude
directory names or workspace-relative directory prefixes. The sandbox passes its
normalized filewatch ignore rules as `--ignore=pattern`.

The index stores workspace-relative paths and lower-cased 3-gram content. It is
used to produce candidate paths; `rg` remains responsible for exact matching,
line numbers, context, and regular-expression semantics.

## API

- `GET /healthz`
- `GET /status` (family, generation, schema, analyzer, coverage)
- `POST /index/full` (manual or recovery fallback)
- `POST /index/reconcile` (compare the persistent file snapshot with the workspace)
- `POST /index/update` with `{ "changes": [...] }`
- `POST /query` with `{ "literals": [...], "pathPrefix": "", "glob": "...", "limit": 1000 }`

Search literals must contain at least 3 non-whitespace characters. The
service default socket directory is private (`0700`) and the socket is
`0600`.

Incremental updates are coalesced for three seconds before a Tantivy commit.
The index directory contains a manifest with the family, generation, schema,
analyzer version, and a persistent file snapshot. Restart reconciliation uses
file metadata first, so a valid index is reused without rereading every file.
Full builds remain available for first creation and recovery. The sandbox
runtime treats this binary as an optional workspace-search feature: new cloud
sandboxes resolve `latest.json`, verify the immutable release checksum, and
start the indexer when available.

The indexer skips binary files, files larger than 4 MiB, VCS metadata, common
package-manager directories, and build/cache output.
