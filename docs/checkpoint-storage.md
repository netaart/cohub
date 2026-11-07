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
- `SPACE_SYSTEM_ROOT/<spaceId>/repo` is a cache. The API and workers fetch missing packs from the manifest on first read and mark complete commits under `.git/cohub-complete/`. Deleting the cache loses nothing.

## Save

1. Load the parent's objects and the per-space stat index (`checkpoint-index.v1.json.gz` under the system dir).
2. Scan the workspace. A file whose type, mode, size, nanosecond mtime/ctime and inode all match the index reuses its blob without being read. Files touched within 3 seconds of a scan are marked racy and are hashed again next time.
3. Hash changed files with `git hash-object --no-filters` into a local object directory. Repository `.gitattributes` never change stored bytes. Files above `CHECKPOINT_ASSET_THRESHOLD_BYTES` are uploaded as assets and stored as pointers.
4. Write the tree from a temporary index, then `commit-tree` on the parent.
5. Pack `commit ^parent` into one pack, upload it, install it into the cache, and compute the parent diff with `diff-tree`.
6. Write the manifest: the parent's packs (with finished covers folded in) plus the new pack.
7. In one transaction, insert the checkpoint and move the head only if it still equals the parent (`head_checkpoint_id IS NOT DISTINCT FROM parent`). If the head moved, the save fails and nothing changes.
8. Update `latest` incrementally when its meta still names the parent; otherwise rebuild it. The meta is cleared first, so an interrupted update is rebuilt next time.

A parent without a manifest (pre-v3 history) makes the save a baseline: its pack holds the full closure and the manifest restarts at `seq` 0.

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

