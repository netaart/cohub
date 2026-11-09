# Checkpoint Storage

A save costs a stat scan of the workspace plus the bytes that changed. Content stays in Git's object format. Object storage holds the history; Postgres stores only the checkpoint row and the space head.

## Layout

```text
checkpoint-packs/<spaceId>/pack-<checksum>.{pack,idx}   one pack per save or cover
checkpoint-manifests/<commit>.json                      packs needed to read <commit>
checkpoint-covers/<commit>/L<level>.json                compacted pack ending at <commit>
checkpoint-assets/...                                   large files and nested-repo bundles
```

- Every object is written once and never changed. Keys are content-addressed or derived from commit hashes.
- Invariant: the packs listed in `manifest(c).packs` contain every object reachable from commit `c`. Packs are self-contained (never thin), so each can be read alone.
- `SPACE_SYSTEM_ROOT/<spaceId>/repo` is a read cache for the API (checkpoint files and diffs), forks and compaction. They fetch missing packs from the manifest on first read and mark complete commits under `.git/cohub-complete/`. Saves never read or write it, and deleting it loses nothing.

## Save

A save needs only the workspace, the per-space stat index, `latest` and object storage. Everything it reuses is named by id and already lives in the parent's packs.

1. Read the parent's manifest and the stat index (`checkpoint-index.v1.ndjson.gz` under the system dir, streamed). The index records every file's stat and blob id and every directory's tree id; it is used only when it belongs to the parent.
2. Scan the workspace. A file whose type, mode, size, nanosecond mtime/ctime and inode all match the index reuses its blob without being read. Files touched within 3 seconds of a scan are marked racy and are hashed again next time. Relative symlinks are kept when their resolved real path stays inside the workspace (dangling ones when their text does); others are skipped with an `unsafe_symlink_target` warning. Restore creates symlinks after all files and checks them the same way.
3. Hash changed files with `git hash-object --no-filters` into a throwaway bare repository on worker-local disk. Repository `.gitattributes` never change stored bytes. Files above `CHECKPOINT_ASSET_THRESHOLD_BYTES` are uploaded as assets and stored as pointers.
4. Rebuild only the trees of directories with a changed or deleted path (`git mktree --missing`), reusing the index's tree ids for the rest, and write the commit object on the parent.
5. Pack exactly the objects written in steps 3–4 and upload the pack.
6. Diff against the parent from the change list. Up to 500 changes, old contents come from `latest` (each must hash to the id the index recorded) and git computes renames, line counts and patches on two small trees; past 500, or when `latest` does not match, the summary lists paths without line counts.
7. Write the manifest (the parent's packs, with finished covers folded in, plus the new pack) and stage the new stat index.
8. In one transaction, capture board snapshots, insert the checkpoint and move the head only if it still equals the parent (`head_checkpoint_id IS NOT DISTINCT FROM parent`). If the head moved, the save fails and nothing changes.
9. Finish: enqueue compaction, promote the staged index, and update `latest` by copying only the changed paths when it holds the parent, otherwise rebuild it from a scan. The meta is cleared first, so an interrupted update is rebuilt next time.

Saves are serialized per space by a Redis lock owned by the task run (2-minute TTL, renewed while running). If a worker dies after step 8, the retried task takes its lock back, finds the checkpoint it already committed (the checkpoint id is the task run id) and runs only step 9, deriving the changed paths from the staged and previous indexes.

A parent without a manifest (pre-v3 history) makes the save a parentless baseline: its pack holds the full snapshot, the manifest restarts at `seq` 0, and the API diffs it against the parent on demand.

## Compaction

Saves number their manifests along the commit chain (`seq`). After the save at `seq = s`, for each level `k` with `s` a multiple of 16^k, the system worker packs `commit ^commit~16^k` with full delta compression and records it as cover `L<k>` of that commit. Later saves replace the 16^k packs in that range with the cover. Covers are aligned, so a manifest holds at most about 15 packs per level plus the baseline. Existing manifests are never rewritten, and older checkpoints keep reading the packs they list.

## Nested Git repositories

Each repository is stored as a chain of bundles (`user-git-repos.v2.json`). The first link is a full bundle. Each later link holds only what the repository gained since the refs recorded at the previous save (`git bundle create --all --not <previous refs>`). When 16 links share a level, they are merged into one link at the next level. Restore unbundles the chain in order and recreates the refs. v1 single-bundle records still restore.

## Forks

A fork's alias checkpoint has the same commit as its source, so it shares the source's manifest. The new space's cache downloads those packs, and nothing is copied between repositories. Its first save continues the source's chain.

## Backfill

Pre-v3 commits stay readable from the cache repository. To move them into object storage, run once per environment:

```bash
tsx scripts/enqueue-checkpoint-storage-backfill.ts            # all spaces, paged
tsx scripts/enqueue-checkpoint-storage-backfill.ts --space-id <id>
```

The `checkpoint.storage_backfill` system job packs each space's legacy commits into one pack and writes a baseline manifest for every commit that has none. It is idempotent.

## Not yet

Orphaned objects are not collected yet. A failed save can leave an unreferenced pack or manifest behind. Collecting them would need a sweep with a grace period. Assets and bundles are shared by content, so they would need reference tracking first.

