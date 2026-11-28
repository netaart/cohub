import {
  createNotifier,
  deliverNotification,
  sendNotificationDigest,
  turnNotifications,
} from "@cohub/core/notifications";
import { COHUB_SYSTEM_QUEUE, createBullmqQueue, defaultJobRetention } from "@cohub/infra/bullmq";
import { createLogger } from "@cohub/infra/logging";
import { createEmailTransport, createPushSenders, PermanentEmailError, readPushConfig } from "@cohub/infra/notifications";
import {
  NOTIFICATION_DELIVER_JOB,
  NOTIFICATION_EMAIL_JOB,
  NOTIFICATION_TURN_JOB,
  visibleDeviceIds,
  visibleDevicesKey,
  type NotificationDeliverJobData,
  type NotificationEmailJobData,
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
const queue = createBullmqQueue<NotificationDeliverJobData | NotificationEmailJobData>(COHUB_SYSTEM_QUEUE, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-worker-notifications",
});
const email = createEmailTransport({ url: config.emailUrl, from: config.emailFrom, serviceName: "cohub-worker" });
const senders = createPushSenders(readPushConfig());

const notifier = createNotifier({
  db,
  logger,
  publish: (event) => redisCommandClient.publish(REALTIME_OUTBOUND_CHANNEL, JSON.stringify(event)),
  deliver: (rows) => queue.addBulk(rows.map((row) => ({
    name: NOTIFICATION_DELIVER_JOB,
    data: { notificationId: row.id, revision: row.revision },
    opts: {
      jobId: `notification-deliver-${row.id}-${row.revision}`,
      delay: PUSH_DELAY_MS,
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      ...defaultJobRetention,
      removeOnComplete: true,
    },
  }))),
});

registerSystemJob(NOTIFICATION_TURN_JOB, async (job: Job) => {
  const data = job.data as NotificationTurnJobData;
  const records = await notifier.notify(await turnNotifications(db, data));
  return { turnId: data.turnId, event: data.event, notified: records.length };
});

const scheduleDigest = (userId: string, jobId = `notification-email-${userId}`) =>
  queue.add(NOTIFICATION_EMAIL_JOB, { userId }, {
    jobId,
    delay: EMAIL_DIGEST_DELAY_MS,
    attempts: 3,
    backoff: { type: "exponential", delay: 60_000 },
    removeOnComplete: true,
    removeOnFail: true,
  });

registerSystemJob(NOTIFICATION_DELIVER_JOB, async (job: Job) => {
  const data = job.data as NotificationDeliverJobData;
  const result = await deliverNotification({
    db,
    senders,
    logger,
    visibleDevices: async (userId) => visibleDeviceIds(await redisCommandClient.hgetall(visibleDevicesKey(userId))),
    scheduleEmail: email ? (userId) => scheduleDigest(userId) : undefined,
  }, data);
  const attempt = (data.attempt ?? 0) + 1;
  if (result.retryTargetIds.length > 0 && attempt <= PUSH_RETRIES) {
    await queue.add(NOTIFICATION_DELIVER_JOB, { ...data, targetIds: result.retryTargetIds, attempt }, {
      jobId: `notification-deliver-${data.notificationId}-${data.revision}-retry-${attempt}`,
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
    const result = await sendNotificationDigest({ db, email, webOrigin: config.webOrigin, apiOrigin: config.apiOrigin, signingKey: config.appEncryptionKey }, userId);
    if (result.more) await scheduleDigest(userId, `notification-email-${userId}-${Date.now()}`);
    return result;
  } catch (error) {
    if (!(error instanceof PermanentEmailError)) throw error;
    logger.error("[Notifications] email refused", { userId, error: error.message });
    return { sent: 0, refused: true };
  }
});
