import { QueueEvents } from "bullmq";
import { COHUB_AGENT_TURNS_QUEUE, createBullmqConnectionOptions } from "@cohub/infra/bullmq";
import { config } from "./config.js";

let agentQueueEvents: Promise<QueueEvents> | null = null;

/**
 * One shared listener for jobs the worker hands to the agent and waits on.
 * Lazy so importing a job module does not open a Redis connection.
 */
export function getAgentQueueEvents() {
  agentQueueEvents ??= (async () => {
    const events = new QueueEvents(COHUB_AGENT_TURNS_QUEUE, { connection: createBullmqConnectionOptions(config.bullmqRedisUrl) });
    await events.waitUntilReady();
    return events;
  })();
  return agentQueueEvents;
}
