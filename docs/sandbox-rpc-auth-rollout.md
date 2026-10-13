# Sandbox RPC Authentication Rollout

This change adds per-instance bearer authentication without changing the cloud
WebSocket topology, public exit IPs, node pools or NetworkPolicy configuration.
No database migration is required.

## Deployment order

1. Inventory the actual `SANDBOX_IMAGE`, existing Pod images and
   `imagePullPolicy` in production and development. Do not infer live settings
   from the application's default image.
2. Pin existing anonymous instances to their current immutable image before
   publishing a new mutable `latest` tag. Existing Pods using `latest` with
   `Always` may pull the new binary on an ordinary container restart while
   lacking its required token. Updating an API ConfigMap does not update an
   existing Pod spec. Replace affected Pods through the coordinated rollout;
   never restore anonymous authentication on the new server to handle this.
3. Upgrade Agent callers first and confirm all replicas are updated. They can
   still connect to nonce-less legacy cloud instances, including metadata that
   contains only `podIp`. Existing APIs that call sandbox RPC also need the new
   client before they access authenticated instances.
4. Upgrade API provisioning and its RPC callers, then select the authenticated
   sandbox image using an immutable tag/digest. Avoid provisioning authenticated
   instances while any required Agent/API caller still lacks authentication.
5. Recreate a controlled canary through the existing sandbox rollout/recover
   workflow. Confirm setup, RPC, background execution, reconnect, cancellation,
   file/port watchers, preview and health checks. Verify missing/wrong tokens
   are rejected before Upgrade, and that credentials never appear in ordinary
   setup output.
6. Replace remaining cloud instances gradually. Record which existing instances
   have no nonce or lack the authenticated server; those instances remain
   insecure even though upgraded callers can still use them. Check established
   connections and confirm replacement closes them.

The checked cluster configuration at review time used a fixed production image
(`v2.62.0`) and a dev SHA image (`sha-6694684`); inspected Pods used
`IfNotPresent`, not `latest`/`Always`. This is a point-in-time observation, not a
rollout guarantee. Keep the mutable-image check in the deployment checklist.

## Legacy compatibility exit condition

An absent/null `rpcTokenNonce` omits client authentication only. Invalid nonce
values remain errors, and a 401 never falls back to anonymous access. The server
always requires its RPC token, independent of database metadata.

Remove the nonce-less client compatibility branch after all deployed cloud
instances and standby/recovery image configurations use authentication and the
agreed rollback window has closed. Check all Spaces, not only active connections.
Until then, treat remaining anonymous instances as an explicit security debt.

## Rollback

Prefer rolling forward to a fixed authenticated build. If rolling back callers
that lack RPC authentication, they cannot control authenticated instances.
Pause new task dispatch/provisioning, drain affected work, and either keep
compatible callers or coordinate caller/image rollback with replacement of the
instances created under the authenticated release. Do not silently remove server
authentication. A rollback to an old anonymous image reopens the vulnerability
and requires an explicit operational/security decision.

## Platform-key rotation

RPC tokens derive from `APP_ENCRYPTION_KEY`, a space ID and a random per-instance
nonce using the `sandbox-rpc-v1` domain. Changing that key changes every derived
RPC token, while existing sandbox processes retain their old token. Coordinate
API/Agent key replacement with recreation of authenticated instances. Also follow
the existing encrypted-secret migration procedure for other uses of this key.
There is no automatic dual-key or anonymous fallback.

## Provisioning and report failures

Initial creation and replacement use the same per-space provisioning lease
(`sandbox:recover:<spaceId>`), with periodic renewal and owner-checked release.
Creation claims a database generation and creates a `provisioning` placeholder
when no row exists, without replacing an existing instance's credentials.
Prompt recovery no longer performs an unfenced upsert before acquiring the lease.

Credentials are published only after Pod creation succeeds and lease ownership
is rechecked. Claims, credential publication, recovery completion and failure
cleanup are conditional on the database generation, so a delayed old operation
cannot overwrite a successor even if its Redis lease expired. Failure cleanup
may mark only its own unfinished generation as an error, allowing recovery after
lease loss without corrupting a newer instance. Replacement deletion uses a Pod
UID precondition. Endpoint invalidation also clears the database generation so
stopped/cleaned instances cannot be republished by late work. An `ensure` conflict
preserves active credentials and status; a replacement conflict remains an
actionable error.

The lease uses the existing Redis service and the generation is stored in JSONB
metadata; no new service, network change or schema migration is introduced.

A freshly created Pod can report before its database credentials are committed.
The report client retries briefly without changing credentials: at most three
attempts within an overall ten-second deadline, for connection failures,
403 during the publication window, 409, 429 and server errors. Persistent failures
remain errors; 400/401 fail immediately. A Kubernetes lookup 404 returns 409,
and other lookup failures return 503. Report writes remain conditional on both
the current report-token hash and the generation read with that snapshot, so a
stale report cannot restore an older generation while credentials are unchanged.

Monitor persistent report failures, authentication rejections, create conflicts,
provisioning duration and Kubernetes API latency. A bounded retry is not a promise
of delivery during a prolonged outage.

## Security boundary

`env.Load()` retains report/RPC credentials in Config and removes them from the
process environment before setup or tool spawning. These names are system-reserved.
This prevents direct environment inheritance; it does not provide same-UID
process/memory or `/proc` isolation. The bearer authorizes one sandbox instance,
not individual RPC methods or service principals. Existing plaintext `ws://`
transport is unchanged; TLS and network isolation remain separate concerns.
