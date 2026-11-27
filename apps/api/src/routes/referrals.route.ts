import { Hono } from "hono";
import { claimReferral, getPublicReferral, REFERRAL_REWARD } from "../referrals.js";
import { useAuth } from "../lib/middleware.js";

const router = new Hono();
const CODE_PATTERN = /^[A-Za-z0-9_-]{8,32}$/;

router.get("/:code", async (c) => {
  const code = c.req.param("code");
  if (!CODE_PATTERN.test(code)) return c.json({ message: "referral not found" }, 404);

  const referral = await getPublicReferral(code);
  if (!referral) return c.json({ message: "referral not found" }, 404);

  return c.json({
    code,
    inviter: referral.profile?.userUuid
      ? referral.profile
      : {
          userUuid: referral.inviterUserId,
          username: null,
          displayName: "A Cohub user",
          avatarUrl: null,
        },
    reward: REFERRAL_REWARD,
  });
});

router.post("/:code/claim", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const code = c.req.param("code");
  if (!CODE_PATTERN.test(code)) return c.json({ message: "referral not found" }, 404);

  const result = await claimReferral(code, user);
  if (!result) return c.json({ message: "referral not found" }, 404);
  if (result.status === "self") return c.json({ message: "this is your referral link", status: "self" }, 409);
  if (result.status === "existing_user") {
    return c.json({ message: "referrals are for new users", status: "existing_user" }, 409);
  }
  if (result.status === "already_claimed") {
    return c.json({ message: "a different referral was already applied", status: "already_claimed" }, 409);
  }
  const { created, ...body } = result;
  return c.json(body, created ? 201 : 200);
});

export default router;
