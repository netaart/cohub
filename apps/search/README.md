# Cohub Search

`cohub-search` is the standalone Tantivy indexer used by sandbox workspaces.
It owns the index writer and exposes a small HTTP API over a Unix socket.
`workspace.candidates` returns content candidates for exact `rg` verification;
`workspace.paths` serves `fs.find`-style path globs from a persistent snapshot.

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
  -d '{"pattern":"handle(Search|Grep)","limit":512}' \
  http://localhost/query
curl --unix-socket /tmp/cohub-search/search.sock \
  -H 'content-type: application/json' \
  -d '{"pattern":"/workspace/**/*.ts","fullPath":true,"limit":20}' \
  http://localhost/paths/query
```

Repeat `--ignore` on `serve`, `full`, `update`, `query`, and `status` to exclude
directory names or workspace-relative directory prefixes. The sandbox passes its
normalized filewatch ignore rules as `--ignore=pattern`.

## Contract

The index never answers a search by itself. `/query` returns rg targets that
together search exactly what one `rg` walk of `pathPrefix` would search, and
`/paths/query` returns what one `fd --glob` walk would list. The agent runs rg
and fd on those targets, so rg and fd stay responsible for matching, line
numbers, context, regular-expression semantics, and errors.

The walk domain mirrors the agent's invocations: hidden files included,
`.gitignore` and `.ignore` applied outside git repositories, symlinks not
followed, `.git` excluded at any depth, and only files, directories and
symlinks listed. Directories and files matching `--ignore` are outside the
watched domain; the index reports them as `dirs` and `walkFiles` for rg and fd
to walk. A plan has three lists:

- `files`: text files whose trigrams can satisfy the pattern, searched as
  explicit rg arguments. The index has already applied ignore rules and the
  glob.
- `walkFiles`: files rg must search through a directory walk. Files are
  indexed up to their first NUL byte, where rg's walk stops; files over
  4 MiB without an early NUL and unreadable files are not indexed at all.
  With a whitelist `--glob`, rg also searches files ignore rules hide, so those
  are listed here too.
- `dirs`: directories outside the watched domain.

Content is normalized the way rg reads it: BOM-marked UTF-16 is transcoded,
invalid UTF-8 is replaced without disturbing valid text, and characters are
folded per character to the Unicode simple case-folding orbit rg uses for
`--ignore-case`. Patterns are parsed with rg's regex parser; literal runs,
small classes and alternations become AND/OR trigram queries. Patterns that
cannot be narrowed, fail to parse, or yield too many targets get a `fallback`
reason instead of a plan.

## API

- `GET /healthz` returns `{ "ok": true, "apiVersion": 2 }`
- `GET /status` (family, generation, schema, analyzer, state, coverage)
- `POST /index/full` (manual or recovery fallback)
- `POST /index/reconcile` (compare the index with the workspace)
- `POST /index/update` with `{ "changes": [{ "path", "oldPath?", "kind" }] }`
- `POST /query` with `{ "pattern", "fixedStrings", "caseInsensitive", "pathPrefix", "glob", "limit" }`
  returns `{ "files", "walkFiles", "dirs" }` or `{ "fallback" }`
- `POST /paths/query` with `{ "pattern", "pathPrefix", "fullPath", "limit" }`
  returns `{ "matches", "truncated", "dirs" }` or `{ "fallback" }`

Fallback reasons: `stale` (not verified by this process yet), `partial`
(accepted work not applied, or a failed job awaiting a rescan), `rules`
(`.rgignore`, `.fdignore`, `.git/info/exclude` or a global git excludes file
present), `scope` (root is not an indexed directory), `pattern`, `glob` (a
whitelist glob names a directory ignore rules hide), and `targets`.

The service default socket directory is private (`0700`) and the socket is
`0600`.

## Coverage

Every accepted job gets a sequence number and jobs run in order; coverage is
`complete` only when the newest accepted job has run, no failed job awaits a
rescan, and this process has verified the index with a full reconcile.
Incremental updates are coalesced for 500 ms before a Tantivy commit. The
sandbox adds its own checks before it asks: its file watcher must be healthy
and settled, and every batch it received must have been accepted here.

Each file's document stores its path, size, mtime, ctime and content kind, so
a reconcile compares the workspace with the committed index itself and reads
only files whose fingerprint changed. Directories, excluded entries and
rule-hidden entries are kept in memory and rebuilt by each reconcile. An index
written by another schema or analyzer version is rebuilt from scratch; a
corrupt one is moved aside for inspection. The sandbox runtime treats this
binary as an optional workspace-search feature: new cloud sandboxes resolve
`latest.json`, verify the immutable release checksum, start the indexer when
available, and only query it when `/healthz` reports the API version they
speak.
