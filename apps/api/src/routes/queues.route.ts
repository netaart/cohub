import { exportQueuesPrometheusMetrics, getQueueSnapshots, getRedisHost } from "@cohub/infra/bullmq";
import { Hono } from "hono";
import { agentTurnQueue } from "../agent-turn-queue.js";
import { fsCdnQueue } from "../space-fs-cdn-queue.js";
import { taskQueue } from "../tasks.js";
import { config } from "../config.js";
import { workspaceUsageQueue } from "../workspace-usage.js";

const router = new Hono();

const describeRedisEndpoint = (value: string) => {
  try {
    const url = new URL(value);
    const db = url.pathname.replace(/^\//, "") || "0";
    return `${url.host}/${db}`;
  } catch {
    return getRedisHost(value);
  }
};

router.get("/", async (c) => {
  const queues = await getQueueSnapshots([taskQueue, agentTurnQueue, fsCdnQueue, workspaceUsageQueue], { redisUrl: config.bullmqRedisUrl });
  const bullmqRedisEndpoint = describeRedisEndpoint(config.bullmqRedisUrl);
  return c.json({
    ok: true,
    environment: config.env,
    bullmqRedisEndpoint,
    queues: queues.map((queue) => ({
      ...queue,
      environment: config.env,
      bullmqRedisEndpoint,
    })),
  });
});

router.get("/metrics", async (c) => {
  const metrics = await exportQueuesPrometheusMetrics([taskQueue, agentTurnQueue, fsCdnQueue, workspaceUsageQueue], {
    includeQueueDefinitionLabels: true,
  });
  return c.text(metrics, 200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
  });
});

export default router;
