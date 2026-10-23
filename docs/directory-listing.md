# Directory listing

`SpaceFilesApi.list()` and checkpoint `files.list()` keep their existing call shapes:

```ts
const tree = await files.list("src");
const treeWithFetch = await files.list("src", customFetch);
```

These calls collect all available pages and return `{ path, entries }`. CLI `spaces files ls` / `list` uses the same behavior, including `--json`. A failed later page rejects the whole call; a partial listing is not reported as a successful full result.

For bounded requests, opt into pagination on the same method:

```ts
const page = await files.list("src", {
  pagination: true,
  limit: 1000,
  cursor, // Omit for the first page.
  signal,
  fetch: customFetch,
});
```

The existing `/fs/tree` routes accept `pagination=true`, `limit` (1–5000, default 1000), and `cursor`. Without pagination they return the legacy response shape. Paged responses add:

- `nextCursor`: an opaque continuation cursor, or `null` when no continuation is available.
- `truncated`: entries unavailable because a legacy backend imposed a cap. This is independent of whether another page exists.

An empty page can have a continuation cursor, for example after visibility filtering. Follow `nextCursor`, not the number of returned entries. Pagination advances in deterministic name order; aggregate SDK results retain directory-first display sorting.

## Backends and compatibility

- **Cloud Space:** API reads shared storage directly. It enumerates names per request and only stats the selected page, with bounded concurrency. No Sandbox upgrade is required.
- **Local Space, new Sandbox:** API checks the existing capability handshake for `fsTreePagination`, then uses paginated `fs.tree` at depth 1. Recursive, non-paginated `fs.tree` retains its existing behavior and limits.
- **Local Space, old Sandbox:** API keeps the existing `fs.tree` request with `limit: 1000`. Missing pagination support does not cause an upgrade error. Explicit API pagination can split this bounded result, preserving `truncated`; old full-list calls retain `{ path, entries }` and may still be incomplete.
- **Checkpoint:** API reads and caches the full immutable Git tree, without the former 1000-entry slice. Tree cache version `v2` prevents reuse of old truncated cache entries. Existing Git output-byte and timeout protections still apply and fail explicitly rather than returning a partial tree.
- **New SDK against old API:** an unpaged response ends iteration. Explicit pagination reports unknown completeness conservatively as `truncated: true`.

Cursors are bound to the directory and relevant options, and resume after the last returned name. Live listings are weakly consistent, like `readdir`: directory changes do not invalidate cursors, unchanged entries are never repeated or skipped, and entries added, removed, or renamed meanwhile may or may not appear. Clients converge through file change events, not through listing errors. Old live cursors remain valid; their embedded directory revisions are ignored. Checkpoint cursors also bind to the resolved checkpoint ID, including when the caller uses `latest`; a different checkpoint returns `directory_changed` (409), requiring a restart.

Older Local Sandboxes still reject listings that race a write. The API retries from the beginning after 100 / 250 ms when it owns the listing start, discarding partial results. An expired caller-held cursor, or exhausted retries, still returns `directory_changed` (409). SDK full-list calls and the web file tree can restart these listings; paged callers must restart explicitly. Sandboxes without pagination retain their existing `truncated` flag and limits; when a capped listing is split into API pages, the capped subset can differ between pages, so `truncated: true` results may skip entries.

## Web cache safety

The file tree uses cached data first, with an early page preview for cold directories and a final update after collection. Intermediate pages are not persisted as complete directories. Complete results pass the existing epoch check before replacing a cache record. Truncated results preserve cached entries and are not committed as complete snapshots. Failed later pages do not modify the directory cache.

The implementation intentionally avoids a persistent directory index or server-side listing sessions. Paging bounds response size and metadata IO, but name enumeration still scales with directory size; full-list callers still pay the memory cost of collecting their result.
