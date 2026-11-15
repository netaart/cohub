import { createDrizzlePermissionStore } from "@cohub/core/permissions";
import { deliverTurnReplies } from "@cohub/core/sessions";
import { createLogger } from "@cohub/infra/logging";
import { SESSION_TURN_REPLY_JOB, type SessionTurnReplyJobData } from "@cohub/protocol";
import type { Job } from "bullmq";
import { db } from "../../../db.js";
import { getPromptTemplateService } from "../../../prompt-templates.js";
import { getSessionDomainServices } from "../../../session-services.js";
import { getSkillService } from "../../../skills.js";
import { registerSystemJob } from "../../registry.js";

const logger = createLogger({ serviceName: "cohub-worker" });
const services = getSessionDomainServices({ promptTemplateService: getPromptTemplateService(), skillService: getSkillService() });
const permissions = createDrizzlePermissionStore(db);

registerSystemJob(SESSION_TURN_REPLY_JOB, async (job: Job) => {
  const { turnId } = job.data as SessionTurnReplyJobData;
  const delivered = await deliverTurnReplies({ db, services, permissions, logger }, turnId);
  return { turnId, delivered: delivered.length };
});
