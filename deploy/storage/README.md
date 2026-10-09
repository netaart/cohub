# Shared storage access and backup isolation

This runbook defines the storage controls required for Kubernetes-hosted sandboxes. The infrastructure owner must apply and verify these controls for both development and production before signing off storage isolation.

## Repository coverage

The [sandbox Pod template](../../apps/api/src/templates/sandbox-pod.ts) mounts individual directories from shared PVCs. Kubernetes `subPath` selects the directory exposed inside the container. Authorization of a separate connection to the storage server is enforced by the server and network.

| Consumer | Storage access declared in this repository |
| --- | --- |
| Sandbox | Space workspace, public files and search index; read-only space sessions and platform/user agent configuration |
| API and fs-api | Environment-wide workspace, configuration, checkpoint and system directories |
| System worker | Environment-wide workspace, checkpoint and system directories |
| Configuration sync | Configuration files written by the [configuration sync workflow](../../.github/workflows/configs-sync.yml) |

The [API configuration](../../apps/api/src/config.ts) and deployment values select PVC names and directory prefixes. PV definitions, NAS access groups, NFS export rules, storage network enforcement and backup infrastructure are managed outside this repository. Their effective production settings require infrastructure evidence.

## Required access boundaries

| Source | Live storage | Backup storage |
| --- | --- | --- |
| Sandbox process network | Deny direct access to every storage endpoint, on every port and address family | Deny |
| Approved Kubernetes node mount clients | Allow only the exports needed for their assigned PVCs | Deny |
| API, fs-api and worker processes | Access their declared mounted directories; authorize application operations separately | Deny |
| Dedicated backup identity and host | Read the data needed for backup | Write through a restricted backup interface |
| Dedicated restore identity and host | Write only to an approved restore destination | Read the approved recovery point |

A node hosting sandboxes may need storage access for kubelet or CSI mounts. Enforce the sandbox network restriction before Pod traffic can be translated to the node's allowed source address. Verify the CNI and cloud network behavior: an allowlist of node IPs alone cannot distinguish a host mount from sandbox traffic masqueraded as that host.

Keep this restriction consistent with sandbox network isolation. Kubernetes NetworkPolicy allow rules are additive; another policy allowing the destination can restore access. Inspect the effective policy set, routing, SNAT, IPv4 and IPv6 behavior, and alternate storage addresses. A policy object existing in the API does not demonstrate enforcement.

For a platform where host mount traffic and sandbox traffic cannot be separated, isolate the sandbox network or storage service before admitting tenant execution. Preserve access for legitimate host mounts during that change.

## Storage server configuration

1. Inventory every live filesystem, export, mount target and protocol, including the public-files and search-index volumes. Map each PVC to its PV and actual backend. Resolve all storage endpoint addresses from the affected network.
2. Restrict each export or NAS access group to its approved mount clients. Remove broad VPC, Pod subnet, wildcard and public-source permissions. Account for node replacement and autoscaling in the managed client inventory.
3. Enable `root_squash`, or the provider's equivalent, on every NFS export accessible to application mount clients. Confirm the effective rule and its precedence, including alternate mount targets. Do not retain a more permissive matching rule.
4. Preserve the service UID/GID permissions needed by the workloads. Current templates use UID/GID 1000. Provision ownership and directory modes through the storage administration path; exercise ordinary file creation, rename and deletion before switching workloads.
5. Keep backend administration, snapshots, export configuration and storage credentials outside sandbox-accessible mounts. Limit their control-plane permissions to infrastructure and backup identities.

`AUTH_SYS` lets a client supply numeric UID/GID values. Root squash maps requests for root to an anonymous identity; another tenant's non-root UID remains a separate concern. These controls depend on excluding untrusted processes from direct storage access. Shared UID 1000 and directory permissions do not establish independent tenant identities at the NFS server.

If tenants must be allowed to connect to the storage protocol, provision independently authorized per-tenant storage with server-enforced identities and export boundaries. The shared-PVC layout requires the network boundary described above.

## Backup and historical configuration

Use a backup destination with an independent access policy and credentials. For NAS, this means a separate filesystem/export access boundary inaccessible to application mount clients. For object or managed backup storage, use a separate restricted destination and recovery identity. A different PVC or directory on the same broadly accessible filesystem does not establish that boundary.

Include historical copies, configuration snapshots, filesystem snapshots, recycle bins and migration leftovers in the inventory. Apply retention, encryption and restore permissions to every retained copy. Encryption at rest must be combined with access controls on the decrypted contents.

The [system PVC migration script](migrate-system-pvc.sh) retains its source directories. Include those directories in the inventory and retention decision. Verify a complete independent backup and the migrated data before approving removal of any retained source data.

Keep secret values out of agent configuration intended for sandbox mounts. Backups containing previously stored credentials remain sensitive after the live file is changed. Revoke exposed credentials, restrict access to retained copies, then issue replacement credentials after the exposure paths are closed. Retention and incident requirements determine whether historical copies are retained under restricted access or removed by their owner.

Restore into a restricted staging destination, verify the selected recovery point, and review historical configuration before exposing restored directories to workloads. Restore procedures must preserve the current storage and secret-access policies.

## Implementation order

The infrastructure owner records each step and its evidence in the private deployment change record. Application owners verify workload behavior; the credential owner handles revocation and replacement.

1. **Establish the inventory.** Record environment, namespace, PVC, PV, backend filesystem/export, all endpoint addresses, approved clients, effective export rules, backup destinations and the configuration repository responsible for each resource. Keep exported infrastructure configuration and any secret material outside this repository.
2. **Prepare recovery and permissions.** Verify an independent restricted recovery point. Provision the service-owned directories and test host mount behavior with root squash enabled. If data movement is needed, define a write pause and final synchronization so the copy includes concurrent changes.
3. **Enforce the network boundary.** Block sandbox access to live and backup storage across all endpoint addresses and protocols while retaining approved host mounts. Check already running sandboxes as well as new Pods. Remove overlapping permissive policies. Keep tenant execution paused wherever enforcement cannot be demonstrated.
4. **Restrict server exports.** Apply the approved client allowlists and root squash settings. Verify existing connections and newly established mounts; retire superseded mount targets and permissive rules after their consumers have moved.
5. **Isolate historical data.** Move retained backups to the independently restricted destination if necessary, verify restore integrity and retention, and retire application access to the old destination. Removal of historical data requires the data owner's approval and a verified recovery point.
6. **Complete credential replacement.** Confirm revocation of affected old credentials and install replacement credentials through the trusted secret-management path. Exclude replacements from sandbox-readable configuration and restores of historical configuration.
7. **Run the acceptance checks.** Record results for every environment and backend before resuming affected tenant execution or closing the storage finding. Make node-pool, CNI, NAS access-group and backup changes re-run the relevant checks.

## Acceptance evidence

Perform runtime checks in an infrastructure-approved environment using dedicated test spaces and non-sensitive test files. Do not read another customer's files or use historical credentials as test material.

| Check | Required result and evidence |
| --- | --- |
| Backend inventory | Every sandbox, API, fs-api and worker PVC resolves to a reviewed backend; every mount target and backup destination has an owner and effective access policy |
| Sandbox direct storage access | Network enforcement denies every storage endpoint from existing and newly created sandboxes, including alternate addresses and IPv6; evidence identifies the enforced rule and the observed source after any translation |
| Approved host mounts | Kubelet/CSI can establish fresh mounts and continue normal I/O; replacement nodes receive exactly the reviewed mount permissions |
| Root identity mapping | Server/provider configuration and a non-sensitive administrative test demonstrate root requests receive the intended anonymous identity; ordinary UID/GID 1000 operations still work |
| Space boundaries | Two dedicated test spaces retain their own workspace/public/index access and their declared read-only session/configuration mounts; the network boundary denies direct protocol access to the shared backend |
| Application operations | API/fs-api file operations, checkpoints, system-worker jobs and configuration sync complete successfully with the restricted storage permissions |
| Backup access | Application nodes and sandbox networks cannot read the backup destination or list historical configurations; only approved backup/restore identities have their specified access |
| Recovery | A selected recovery point restores correctly into the restricted staging destination with metadata and permissions preserved; historical secrets are reviewed before any workload receives the restored content |
| Credential handling | The responsible owner records revocation and replacement status without including secret values in the evidence |

A completed review records the deployed configuration revision, environment, verification time, owner and evidence for each row. A missing backend configuration or unperformed runtime check leaves the storage finding open. Changes to application source or this runbook alone do not establish that production storage is isolated.
