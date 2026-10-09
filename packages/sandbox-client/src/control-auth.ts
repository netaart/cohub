import { createPrivateKey, createPublicKey } from "node:crypto";
import { SignJWT } from "jose";

export const SANDBOX_CONTROL_TOKEN_TTL_SECONDS = 60;

function signingKey() {
  const pem = process.env.SANDBOX_CONTROL_PRIVATE_KEY;
  if (!pem) throw new Error("SANDBOX_CONTROL_PRIVATE_KEY is required for cloud sandboxes");
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Sandbox control key must be Ed25519");
  return key;
}

export function getSandboxControlPublicKey(): string {
  return createPublicKey(signingKey()).export({ type: "spki", format: "pem" }).toString();
}

export async function createSandboxConnectionHeaders(input: {
  wsUrl: string;
  spaceId: string;
  identity: string;
  workerSecret?: string;
}): Promise<Record<string, string>> {
  if (new URL(input.wsUrl).pathname.startsWith("/internal/sandbox-relay/")) {
    if (!input.workerSecret) throw new Error("WORKER_SECRET is required for the sandbox relay");
    return { "x-worker-secret": input.workerSecret };
  }
  if (!input.spaceId || !input.identity) throw new Error("Sandbox space and caller identity are required");
  const token = await new SignJWT({ spaceId: input.spaceId })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .setIssuer("cohub-platform")
    .setAudience("cohub-sandbox-control")
    .setSubject(input.identity)
    .setIssuedAt()
    .setExpirationTime(`${SANDBOX_CONTROL_TOKEN_TTL_SECONDS}s`)
    .sign(signingKey());
  return { Authorization: `Bearer ${token}` };
}
