import type { GenerationPolicy } from "@cohub/protocol/generation";
import type { SpaceFsUploadTargetVersion } from "@cohub/protocol/fs";
import { createHash } from "node:crypto";
import type { Queue, JobsOptions, QueueOptions } from "bullmq";
import { COHUB_AGENT_TURNS_QUEUE, createBullmqConnectionOptions, createBullmqQueue, defaultJobRetention } from "../bullmq/index.js";

export const AGENT_SANDBOX_BASH_JOB_NAME = "sandbox_bash" as const;
export const AGENT_SANDBOX_BASH_ATOMIC_JOB_NAME = "sandbox_bash_atomic" as const;
export const AGENT_RUN_COMMAND_JOB_NAME = "run_command" as const;
export const AGENT_SANDBOX_FS_MUTATION_JOB_NAME = "sandbox_fs_mutation" as const;
export const AGENT_RUNTIME_RECOVERY_JOB_NAME = "runtime_recovery" as const;
export type AgentRuntimeRecoveryJobData = {
  spaceId: string;
  sessionId: string;
  expectedTurnId: string;
  expectedHarness: "pi" | "codex";
  expectedOwnerUserId: string;
  confirmation?: { actorUserId: string; revision: string };
};
export function enqueueRuntimeRecovery(queue: Queue, data: AgentRuntimeRecoveryJobData) {
  const suffix = data.confirmation ? `confirm-${data.confirmation.revision}` : `recover-${data.expectedTurnId}`;
  return queue.add(AGENT_RUNTIME_RECOVERY_JOB_NAME, data, {
    jobId: `runtime-${data.sessionId}-${suffix}`, attempts: data.confirmation ? 12 : 8, backoff: { type: "exponential", delay: data.confirmation ? 5000 : 1000 },
    removeOnComplete: true, removeOnFail: true,
  });
}

export type AgentSandboxBashUploadJobData = {
  spaceId: string;
  sessionId: string;
  uploadId: string;
  destinationRoot: string;
  materialize?: "atomic";
  downloadHost: string;
  files: Array<{
    relativePath: string;
    name: string;
    size: number;
    mimeType: string | null;
    downloadUrl: string;
    targetVersion?: SpaceFsUploadTargetVersion;
  }>;
  requestId?: string | null;
  trace?: Record<string, unknown>;
};

export type AgentRunCommandOrigin = {
  kind: "bash_tool_call";
  sessionId: string;
  turnId: string;
  toolCallId: string;
  requestId?: string | null;
};

export type AgentRunCommandJobData = {
  spaceId: string;
  sessionId?: string | null;
  taskRunId: string;
  command: string;
  cwd: string;
  source?: string | null;
  timeout?: number;
  userId?: string | null;
  /** App Action viewer context; execution actor remains userId. */
  viewerUserId?: string | null;
  appId?: string | null;
  appVersionId?: string | null;
  action?: string | null;
  sourceClientId?: string | null;
  model?: { provider: string; id: string } | null;
  generationPolicy?: GenerationPolicy | null;
  env?: Record<string, string> | null;
  executionScopes?: string[] | null;
  requestId?: string | null;
  trace?: Record<string, unknown>;
  origin?: AgentRunCommandOrigin | null;
};

export type AgentRunCommandJobResult = {
  ok: true;
  exitCode: number | null;
  termination?: {
    reason: "exited" | "timed_out" | "aborted";
    exitCode: number | null;
    timeoutSecs?: number;
    message?: string;
    outputTruncated?: boolean;
  };
  outputTruncated?: boolean;
  durationMs: number;
  output: string;
  truncated: boolean;
  content: Array<Record<string, unknown>>;
};

export type AgentBashJobData = AgentSandboxBashUploadJobData | AgentRunCommandJobData | AgentSandboxFsMutationJobData;

export function createAgentTurnsQueue<DataType = AgentBashJobData, ResultType = unknown>(redisUrl: string, telemetryServiceName: string) {
  return createBullmqQueue<DataType, ResultType>(COHUB_AGENT_TURNS_QUEUE, {
    redisUrl,
    telemetryServiceName,
  });
}

export function createAgentTurnsQueueConnection(redisUrl: string) {
  return createBullmqConnectionOptions(redisUrl);
}

export function createAgentTurnsQueueWithOptions<DataType = AgentBashJobData, ResultType = unknown>(
  options: Omit<QueueOptions, "connection" | "telemetry"> & {
    redisUrl: string;
    telemetryServiceName: string;
  },
) {
  return createBullmqQueue<DataType, ResultType>(COHUB_AGENT_TURNS_QUEUE, options);
}

export const buildAgentSandboxBashJobId = (uploadId: string) => `sandbox-bash-${uploadId}`;
export const buildAgentRunCommandJobId = (taskRunId: string) => `run-command-${taskRunId}`;
/**
 * Serialize a mutation in fixed field order so semantically identical requests
 * always produce the same job id regardless of JSON key ordering.
 */
function canonicalizeMutation(mutation: AgentSandboxFsMutationOperation): string {
  switch (mutation.operation) {
    case "write":
      return JSON.stringify([
        "write",
        mutation.path,
        mutation.content,
        mutation.encoding ?? "utf-8",
        mutation.exclusive ?? false,
        mutation.expected ?? null,
      ]);
    case "mkdir":
      return JSON.stringify(["mkdir", mutation.path]);
    case "delete":
      return JSON.stringify(["delete", mutation.path, mutation.recursive ?? false]);
    case "move":
      return JSON.stringify(["move", mutation.fromPath, mutation.toPath]);
    case "reconcile":
      return JSON.stringify(["reconcile"]);
  }
}

/**
 * Job id is scoped by spaceId so a colliding mutationId across spaces never
 * reuses the same BullMQ job, and bound to a canonical payload hash so the
 * same mutationId used with different content cannot observe a stale result.
 * mutationId is expected to be a safe token.
 */
export const buildAgentSandboxFsMutationJobId = (spaceId: string, mutationId: string, mutation: AgentSandboxFsMutationOperation) => {
  const payloadHash = createHash("sha1").update(canonicalizeMutation(mutation)).digest("hex").slice(0, 16);
  return `sandbox-fs-${spaceId}-${mutationId}-${payloadHash}`;
};

export function enqueueAgentRunCommandJob(queue: Queue, input: AgentRunCommandJobData, options: JobsOptions = {}) {
  return queue.add(AGENT_RUN_COMMAND_JOB_NAME, input, {
    jobId: buildAgentRunCommandJobId(input.taskRunId),
    attempts: 1,
    ...defaultJobRetention,
    ...options,
  });
}

/**
 * Sandbox filesystem mutation job. The agent executes the mutation against the
 * sandbox over its existing connection pool (no new sandbox RPCs), so watchers
 * inside the sandbox observe the change through their own filesystem events.
 *
 * The job id is derived from the mutationId so a client retry reuses the same
 * job instead of issuing a second mutation.
 */
export type AgentSandboxFsMutationOperation =
  | {
      operation: "write";
      path: string;
      content: string;
      encoding?: "utf-8" | "base64";
      expected?: { mtimeMs: number; size: number };
      exclusive?: boolean;
    }
  | {
      operation: "mkdir";
      path: string;
    }
  | {
      operation: "delete";
      path: string;
      recursive?: boolean;
    }
  | {
      operation: "move";
      fromPath: string;
      toPath: string;
    }
  | {
      /** Tell the sandbox its workspace changed behind its back. */
      operation: "reconcile";
    };

export type AgentSandboxFsMutationJobData = {
  spaceId: string;
  mutationId: string;
  mutation: AgentSandboxFsMutationOperation;
  requestId?: string | null;
  trace?: Record<string, unknown>;
};

export type AgentSandboxFsMutationJobResult =
  | {
      ok: true;
      result: {
        path?: string;
        fromPath?: string;
        toPath?: string;
        size?: number;
        mtimeMs?: number;
        created?: boolean;
        createdDirs?: string[];
        deleted?: boolean;
        nodeType?: "file" | "dir" | "unknown";
      };
    }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
    };

export const sandboxFsMutationJobRetention = {
  removeOnComplete: { age: 300, count: 200 },
  removeOnFail: { age: 300, count: 200 },
} satisfies Pick<JobsOptions, "removeOnComplete" | "removeOnFail">;

export function enqueueAgentSandboxFsMutationJob(queue: Queue, input: AgentSandboxFsMutationJobData, options: JobsOptions = {}) {
  return queue.add(AGENT_SANDBOX_FS_MUTATION_JOB_NAME, input, {
    jobId: buildAgentSandboxFsMutationJobId(input.spaceId, input.mutationId, input.mutation),
    attempts: 1,
    // Completed write payloads are redacted by the worker, so this retention
    // window preserves idempotency without retaining file content in Redis.
    ...sandboxFsMutationJobRetention,
    ...options,
  });
}
