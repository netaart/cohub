# Sandbox control authentication

Cloud `/sandbox` connections require an Ed25519 JWT before the HTTP upgrade. The issuer is `cohub-platform`, audience is `cohub-sandbox-control`, `spaceId` names the target Space, and `sub` names the API or Agent instance. Credentials last 60 seconds. Every reconnect signs a fresh credential for the current endpoint. The attach identity must match the authenticated subject. Established connections keep their authenticated identity until disconnect; token expiry limits admission, and key rotation requires disconnecting existing sessions.

API and Agent require the same `SANDBOX_CONTROL_PRIVATE_KEY` (PKCS8 PEM) within an environment. fs-api uses the API Secret. Generate this key with `openssl genpkey -algorithm ED25519` and store it in the deployment Secrets. Use distinct keys for dev and prod. Keep the private key out of Space variables, Pod metadata, logs and user-controlled containers. API derives `SANDBOX_CONTROL_PUBLIC_KEY` and injects only that public key into each cloud sandbox Pod. A cloud listener refuses to start without a valid public key. Local dial-out sandboxes retain gateway relay authentication.

## Deployment

1. Add the private key to the API and Agent Secrets. Build the sandbox image and set the API's desired sandbox image to that version.
2. Deploy API, fs-api and Agent with these changes and matching Secrets in a coordinated maintenance window. API deployment applies `sandbox-network-policy.yaml`; control connections can be interrupted until all client Pods carry the `cohub.live/sandbox-control-client=true` label supplied by their deployment templates. The policy namespace matches the supplied dev/prod manifests; adjust it when using custom namespaces. The label also covers preview API deployments.
3. Recreate all existing cloud sandbox Pods through the existing sandbox rollout workflow. Existing Pods acquire the public key only when recreated. Coordinate this rollout with running sessions because Pod replacement interrupts processes. Keep cloud sandbox creation paused while API replicas with different provisioning versions coexist.
4. Verify authorized API/Agent connections, HTTP 401 for missing/invalid credentials, healthy `/healthz` and `/readyz`, and denied TCP 8788 connections from another sandbox. Confirm all Pods run the authenticated image before declaring rollout complete.

The NetworkPolicy selects `app=agent-sandbox`. TCP 8788 is admitted only from the matching environment's API/fs-api and Agent Pods. Other TCP ports and UDP/SCTP traffic retain their existing reachability for user applications and RTC. Kubernetes node health probes remain available. The cluster CNI must enforce NetworkPolicy and `endPort`; audit other policies because Kubernetes combines allow rules additively. Changing a policy does not guarantee termination of already established flows, so Pod recreation is part of this rollout.

For key rotation, update platform Secrets, restart API/fs-api/Agent, and recreate sandboxes with the new public key in a coordinated maintenance window. In-flight connections and processes are interrupted. There is no unauthenticated migration mode.

## Validation

Run `go test ./...` and `go vet ./...` in `apps/sandbox`, plus the sandbox-client, API and Agent checks. `TestSandboxControlAuthentication` uses a real HTTP/WebSocket server and real signing keys to exercise authentication failures before upgrade, valid attachment, caller mismatch and unauthenticated health probes. `control-auth.test.ts` verifies credential claims and relay routing.
