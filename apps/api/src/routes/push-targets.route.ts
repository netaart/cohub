import { config } from "../config.js";
import { useUserPrincipal } from "../lib/middleware.js";
import { deleteUserPushTarget, upsertPushTarget } from "../push/push-targets.js";
import { createPushTargetsRouter } from "./push-targets-router.js";

const router = createPushTargetsRouter({
  getUser: useUserPrincipal,
  apnsTopics: () => config.apns?.topics ?? null,
  upsertPushTarget,
  deleteUserPushTarget,
});

export default router;
