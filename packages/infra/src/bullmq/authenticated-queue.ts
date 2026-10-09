import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Queue, UnrecoverableError, type BulkJobOptions, type Job, type JobsOptions, type JobSchedulerTemplateOptions, type QueueOptions, type RepeatOptions } from "bullmq";

const AUTH_FIELD = "__cohubQueueAuth";
type Binding = { jobId: string } | { schedulerId: string };
type Authentication = { version: 1; binding: Binding; signature: string };

export class QueueAuthenticationError extends UnrecoverableError {
  constructor() {
    super("Queue job authentication failed");
  }
}

export function readQueueSigningKey(): Buffer {
  const value = process.env.BULLMQ_SIGNING_KEY;
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error("BULLMQ_SIGNING_KEY must contain 32 random bytes encoded as 64 hex characters");
  }
  return Buffer.from(value, "hex");
}

function payloadObject(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new QueueAuthenticationError();
  }
  return Object.fromEntries(Object.entries(data).filter(([key]) => key !== AUTH_FIELD));
}

function signatureFor(key: Buffer, queue: string, name: string, binding: Binding, data: unknown): Buffer {
  return createHmac("sha256", key)
    .update(JSON.stringify(["cohub-queue-v1", queue, name, binding, data]))
    .digest();
}

function signData<Data>(key: Buffer, queue: string, name: string, binding: Binding, data: Data): Data & { __cohubQueueAuth: Authentication } {
  // 在签名前完成与 BullMQ 一致的 JSON 转换，避免 undefined 或 toJSON 改变载荷。
  const payload = payloadObject(JSON.parse(JSON.stringify(data)));
  return Object.assign(payload, {
    [AUTH_FIELD]: {
      version: 1 as const,
      binding,
      signature: signatureFor(key, queue, name, binding, payload).toString("hex"),
    },
  }) as Data & { __cohubQueueAuth: Authentication };
}

export function authenticateQueueJob(job: Pick<Job, "id" | "name" | "queueName" | "data" | "repeatJobKey">, key: Buffer): void {
  const payload = payloadObject(job.data);
  const auth = job.data[AUTH_FIELD] as Authentication | undefined;
  if (auth?.version !== 1 || !auth.binding || typeof auth.binding !== "object" || Array.isArray(auth.binding) || typeof auth.signature !== "string" || !/^[a-f0-9]{64}$/.test(auth.signature)) {
    throw new QueueAuthenticationError();
  }
  const binding = auth.binding;
  if ("jobId" in binding) {
    if (typeof binding.jobId !== "string" || binding.jobId !== job.id || job.repeatJobKey) {
      throw new QueueAuthenticationError();
    }
  } else if ("schedulerId" in binding) {
    if (typeof binding.schedulerId !== "string" || binding.schedulerId !== job.repeatJobKey || !job.id?.startsWith(`repeat:${binding.schedulerId}:`)) {
      throw new QueueAuthenticationError();
    }
  } else {
    throw new QueueAuthenticationError();
  }
  const expected = signatureFor(key, job.queueName, job.name, binding, payload);
  if (!timingSafeEqual(expected, Buffer.from(auth.signature, "hex"))) {
    throw new QueueAuthenticationError();
  }
}

export class AuthenticatedQueue<Data = unknown, Result = unknown, Name extends string = string> extends Queue<Data, Result, Name, Data, Result, Name> {
  private readonly signingKey: Buffer;

  constructor(name: string, options: QueueOptions, signingKey = readQueueSigningKey()) {
    super(name, options);
    this.signingKey = signingKey;
  }

  protected override addJob(name: Name, data: Data, opts: JobsOptions = {}) {
    const jobId = opts.jobId ?? randomUUID();
    return super.addJob(name, signData(this.signingKey, this.name, name, { jobId }, data), { ...opts, jobId });
  }

  override addBulk(jobs: { name: Name; data: Data; opts?: BulkJobOptions }[]) {
    return super.addBulk(jobs.map(({ name, data, opts }) => {
      const jobId = opts?.jobId ?? randomUUID();
      return { name, data: signData(this.signingKey, this.name, name, { jobId }, data), opts: { ...opts, jobId } };
    }));
  }

  override upsertJobScheduler(schedulerId: Name, repeat: Omit<RepeatOptions, "key">, template?: { name?: Name; data?: Data; opts?: JobSchedulerTemplateOptions }) {
    if (!template || template.data === undefined) throw new Error("Scheduled jobs require an explicit payload");
    const name = template.name ?? schedulerId;
    return super.upsertJobScheduler(schedulerId, repeat, {
      ...template,
      name,
      data: signData(this.signingKey, this.name, name, { schedulerId }, template.data),
    });
  }
}
