import { randomUUID } from "node:crypto";
import { redisCommandClient } from "../../redis.js";

const LOCK_TTL_MS = 180_000;
const REDIS_TIMEOUT_MS = 3_000;
const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export type SandboxProvisioningLease = {
  generation: string;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
};

async function boundedRedis<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Sandbox provisioning lock lookup timed out")), REDIS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function acquireSandboxProvisioningLease(spaceId: string): Promise<SandboxProvisioningLease | null> {
  const key = `sandbox:recover:${spaceId}`;
  const generation = randomUUID();
  const acquired = await boundedRedis(redisCommandClient.set(key, generation, "PX", LOCK_TTL_MS, "NX"));
  if (acquired !== "OK") return null;

  let owned = true;
  const assertOwned = async () => {
    if (!owned) throw new Error("Sandbox provisioning lease was lost");
    try {
      if (await boundedRedis(redisCommandClient.eval(RENEW, 1, key, generation, LOCK_TTL_MS)) !== 1) {
        throw new Error("Sandbox provisioning lease was lost");
      }
    } catch (error) {
      owned = false;
      throw error;
    }
  };
  const renewal = setInterval(() => {
    void assertOwned().catch(() => {});
  }, LOCK_TTL_MS / 3);
  renewal.unref();

  return {
    generation,
    assertOwned,
    async release() {
      owned = false;
      clearInterval(renewal);
      await boundedRedis(redisCommandClient.eval(RELEASE, 1, key, generation));
    },
  };
}
