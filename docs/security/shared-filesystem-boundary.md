# Shared workspace filesystem boundary (R01)

The API/fs-api and CDN worker mount storage shared by multiple Spaces. A tenant can create symlinks in its own workspace. Lexical path normalization and a check of the last component do not stop an intermediate directory from redirecting an operation into another Space or the service filesystem. Checking `realpath` and reopening the pathname later also leaves a replacement race.

## Boundary

`packages/core/src/space-fs/pinned.ts` owns shared-volume path access:

- Open the configured workspace directory with `O_DIRECTORY | O_NOFOLLOW`; verify its descriptor resolves to the exact expected absolute path. Workspace IDs must be single safe path components. A redirected workspace root fails closed.
- Open each parent directory with `O_DIRECTORY | O_NOFOLLOW` relative to the preceding descriptor through Linux `/proc/self/fd`.
- Open file leaves with `O_NOFOLLOW | O_NONBLOCK`. Validate regular-file metadata on that descriptor, then read/write/stream from the same descriptor. Writers check versions and file type before truncating.
- List entries through an opened directory. Rename and unlink operate on the final directory entry, so a symlink itself can still be moved or removed. Recursive deletion walks pinned directories and never descends into a symlink.
- Keep descriptor ownership explicit. API operations close handles in `finally`; HTTP streams own their file descriptor until EOF/cancellation. Invalid ranges, queue failures, stale jobs and early returns close handles as well.

This backend deliberately requires Linux with `/proc/self/fd`. It does not fall back to pathname-based access on unsupported hosts. The configured storage mount and tenant-parent directories must remain platform-owned; tenant processes must not be able to rename other tenants' roots or remount storage. This change does not implement NFS export isolation or repair an already compromised storage service (R05).

## Covered consumers

- API/fs-api tree, single-file and batch reads, stream/download, version probes, write/create, directory creation, rename, deletion and direct uploads.
- Filtered views read `.gitignore` using the same safe file opener. A symlinked ignore file is rejected even when a prior filter is cached. Cache identity includes device/inode.
- Preview and download routes consume a validated file handle instead of reopening an absolute pathname. Preview Range responses and cancellation retain normal behavior.
- The CDN worker uploads from an opened handle and verifies the same file after transfer. It revalidates queued paths independently of the API.

Cloud sandbox mutation dispatch and local sandbox RPC continue through their existing backend. This fix covers shared-PVC operations and their CDN consumer, not an assertion that every sandbox or publication subsystem is secure.

## Behavior changes

Shared-volume file operations reject paths through any symlink, including an intermediate symlink that points within the same workspace. Symlink entries remain visible in a directory listing and can be renamed/deleted without following their targets. A symlinked `.gitignore` fails the filtered request rather than silently weakening visibility rules.

The API JSON shapes for ordinary files are unchanged. `streamSpaceFile` is an internal API whose `target` pathname is replaced by an owned `file` handle; both HTTP consumers were updated together. Storage mount provisioning must precede API use. Workspace creation preserves the existing `0775` permissions through directory handles.

## CDN rollout

Manifest, object, failure and job keys use namespace `v2`. New code therefore does not reuse entries made by older pathname-based readers. Expect cold-cache responses and warmup load immediately after rollout. Roll out API, fs-api and worker builds together; an old process still has its old behavior until replaced.

Changing the namespace does **not** revoke old public object URLs, purge CDN edges, erase historical leaked files, or rotate exposed credentials. After the code is deployed, the incident owner must identify and retire the old `fs-cache/spaces/...` / `dev/fs-cache/spaces/...` objects and associated edge caches according to retention requirements, and handle credential rotation separately. This implementation performs no online cleanup or deployment.

## Regression checks

Run with the repository's pinned dependencies:

```bash
pnpm --filter @cohub/core test
pnpm --filter @cohub/api test:fs-boundary
pnpm --filter @cohub/worker test:fs-boundary
pnpm --filter @cohub/core typecheck
pnpm --filter @cohub/api typecheck
pnpm --filter @cohub/worker typecheck
pnpm --filter @cohub/api lint
pnpm --filter @cohub/worker lint
```

The dedicated suites use fresh local temporary directories and fake Redis/object-storage services. They never contact a real Space, database, object bucket or CDN. Cases cover parent/leaf/dangling links, links replaced after validation, range streams, cancelled requests, writes before truncation, recursive deletion, mixed batch failures, queued CDN paths and descriptor leaks. Regression cases also preserve native directory entry names, normalized trailing slashes, explicit recursive deletion and failure without creating rename destinations.
