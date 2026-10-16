# BullMQ queue trust boundary

Redis carries execution requests for task workers, system workers, and agents. Producers authenticate the complete JSON payload with HMAC-SHA256 using `BULLMQ_SIGNING_KEY`. Consumers verify it before dispatching a handler or updating business records. The signature binds the queue name, job name, and explicit job ID; recurring jobs bind their scheduler ID so BullMQ can create subsequent occurrences without access to the signing key. Bulk submissions use the same authentication.

Generate a separate 32-byte random key for each environment, encode it as 64 hexadecimal characters, and provision it through the secret manager. API, user worker, system worker, and agent in one environment need the same key. API and worker already import their Kubernetes Secret through `envFrom`; the agent deployment explicitly imports `BULLMQ_SIGNING_KEY`. Never reuse Redis passwords, `WORKER_SECRET`, or application signing keys. Missing or malformed keys fail startup/queue construction. There is no unsigned compatibility mode.

## Deployment and existing work

This changes the queue protocol. Deploy it in a coordinated maintenance window:

1. Restrict Redis to the private network and trusted service identities. Rotate exposed Redis credentials. Separate production and development instances and accounts; Redis logical DB numbers do not provide an ACL boundary. Give application-cache clients no access to BullMQ keys. Give queue service accounts only the commands/key patterns required by their actual BullMQ roles, including Lua and stream operations. Verify the ACL with the installed BullMQ version before deployment.
2. Stop producers, disable recurring schedules, and let trusted in-flight work finish. Inventory waiting, delayed, failed, and recurring jobs together with their authoritative database records. Preserve that inventory for recovery. Do not sign existing Redis payloads: a compromised queue cannot establish their authorization.
3. Stop consumers. Provision the environment's new signing key in API/worker and agent Secrets, and deploy all producers and consumers together. Preserve unsigned pending jobs for review; the new consumers reject them. Recreate authorized pending work through the API from authoritative database state. Account for previously completed side effects before resubmission.
4. Re-enable user cron jobs through the authenticated API so it rebuilds signed scheduler templates from database configuration. The system worker rebuilds its three system scheduler templates at startup. Confirm the expected schedules and remove retired unsigned schedules under the normal operations procedure.
5. Resume traffic and verify normal task, agent, and scheduled execution. Check authentication failures and resolve unsigned work against the inventory. Future key rotation uses the same coordinated drain/recreation procedure.

## Guarantees and remaining infrastructure requirements

Changing a payload, actor, target space, job type, queue name, job ID, or scheduler ID invalidates authentication. Changing the environment key also invalidates it. Rejected jobs cannot enter handler logic or the task failure database update. Completed filesystem-write payload redaction invalidates that job's signature, so a manual retry cannot execute redacted file content.

An attacker with Redis write access can still deny service, forge queue results/events, delete jobs, or replay an existing signed request under its original identity after manipulating Redis state. Recurring templates authenticate the payload and scheduler identity, not occurrence time or scheduling frequency. Authentication does not replace Redis network/ACL isolation, authoritative business authorization, or idempotency. Do not consider R06's infrastructure exposure remediated until network reachability, separate environment credentials, and effective ACLs have been checked by the infrastructure owner.

## Local integration validation

Run a dedicated Redis instance bound to loopback with persistence disabled. From `packages/infra`, run:

```sh
BULLMQ_TEST_REDIS_URL=redis://127.0.0.1:16386 node --import tsx --test src/bullmq/authenticated-queue.integration.ts
```

The integration test uses a unique queue prefix and removes only its own keys. It uses real BullMQ producers and consumers to verify normal, bulk, and recurring execution and rejection of unsigned, modified, or relocated jobs. It is separate from the default network-blocked unit suite.
