import { createNotifier, deliverPush, sendNotificationDigest, turnNotifications } from "@cohub/core/notifications";
import { COHUB_SYSTEM_QUEUE, createBullmqQueue, defaultJobRetention } from "@cohub/infra/bullmq";
import { createLogger } from "@cohub/infra/logging";
import {
  createEmailTransport,
  createPushSenders,
  createRedisEmailOutbox,
  PermanentEmailError,
  readPushConfig,
} from "@cohub/infra/notifications";
import {
  NOTIFICATION_EMAIL_JOB,
  NOTIFICATION_PUSH_JOB,
  NOTIFICATION_TURN_JOB,
  visibleDeviceIds,
  visibleDevicesKey,
  type NotificationEmailJobData,
  type NotificationPushJobData,
  type NotificationTurnJobData,
} from "@cohub/protocol";
import { REALTIME_OUTBOUND_CHANNEL } from "@cohub/protocol/realtime";
import type { Job } from "bullmq";
import { config } from "../../../config.js";
import { db } from "../../../db.js";
import { redisCommandClient } from "../../../redis.js";
import { registerSystemJob } from "../../registry.js";

const PUSH_DELAY_MS = 5_000;
const PUSH_RETRIES = 3;
const EMAIL_DIGEST_DELAY_MS = 10 * 60_000;

const logger = createLogger({ serviceName: "cohub-worker" });
const queue = createBullmqQueue<NotificationPushJobData | NotificationEmailJobData>(COHUB_SYSTEM_QUEUE, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-worker-notifications",
});
const email = createEmailTransport({ url: config.emailUrl, from: config.emailFrom, serviceName: "cohub-worker" });
const outbox = createRedisEmailOutbox(redisCommandClient);
const senders = createPushSenders(readPushConfig());

const pushJobId = (data: NotificationPushJobData) =>
  `notification-push-${data.notice.id}-${data.revision ?? 0}${data.attempt ? `-retry-${data.attempt}` : ""}`;

// One digest per user per window: a window's job runs after the window closes, so it sees every entry added in it.
const scheduleDigest = (userId: string, jobId = `notification-email-${userId}-${Math.floor(Date.now() / EMAIL_DIGEST_DELAY_MS)}`) =>
  queue.add(NOTIFICATION_EMAIL_JOB, { userId }, {
    jobId,
    delay: EMAIL_DIGEST_DELAY_MS,
    attempts: 3,
    backoff: { type: "exponential", delay: 60_000 },
    removeOnComplete: true,
    removeOnFail: true,
  });

const notifier = createNotifier({
  db,
  logger,
  publish: (event) => redisCommandClient.publish(REALTIME_OUTBOUND_CHANNEL, JSON.stringify(event)),
  push: (jobs) => queue.addBulk(jobs.map((data) => ({
    name: NOTIFICATION_PUSH_JOB,
    data,
    opts: {
      jobId: pushJobId(data),
      delay: PUSH_DELAY_MS,
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      ...defaultJobRetention,
      removeOnComplete: true,
    },
  }))),
  email: email
    ? async (entries) => {
      await outbox.add(entries);
      await Promise.all([...new Set(entries.map((entry) => entry.userId))].map((userId) => scheduleDigest(userId)));
    }
    : undefined,
});

registerSystemJob(NOTIFICATION_TURN_JOB, async (job: Job) => {
  const data = job.data as NotificationTurnJobData;
  const sent = await notifier.notify(await turnNotifications(db, data));
  return { turnId: data.turnId, event: data.event, notified: sent.length };
});

registerSystemJob(NOTIFICATION_PUSH_JOB, async (job: Job) => {
  const data = job.data as NotificationPushJobData;
  const result = await deliverPush({
    db,
    senders,
    logger,
    visibleDevices: async (userId) => visibleDeviceIds(await redisCommandClient.hgetall(visibleDevicesKey(userId))),
  }, data);
  const attempt = (data.attempt ?? 0) + 1;
  if (result.retryTargetIds.length > 0 && attempt <= PUSH_RETRIES) {
    const retry = { ...data, targetIds: result.retryTargetIds, attempt };
    await queue.add(NOTIFICATION_PUSH_JOB, retry, {
      jobId: pushJobId(retry),
      delay: PUSH_DELAY_MS * 6 ** attempt,
      ...defaultJobRetention,
      removeOnComplete: true,
    });
  }
  return result;
});

registerSystemJob(NOTIFICATION_EMAIL_JOB, async (job: Job) => {
  const { userId } = job.data as NotificationEmailJobData;
  if (!email) return { sent: 0 };
  try {
    const result = await sendNotificationDigest({ db, email, outbox, webOrigin: config.webOrigin, apiOrigin: config.apiOrigin, signingKey: config.appEncryptionKey }, userId);
    if (result.more) await scheduleDigest(userId, `notification-email-${userId}-more-${Date.now()}`);
    return result;
  } catch (error) {
    if (!(error instanceof PermanentEmailError)) throw error;
    logger.error("[Notifications] email refused", { userId, error: error.message });
    return { sent: 0, refused: true };
  }
});
