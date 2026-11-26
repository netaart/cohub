-- Referrals now qualify on the invitee's first payment: claims hold no quota and stay open for 30 days.
-- Claims capped by the old claim-time reservation reopen with the full reward.
UPDATE "v2"."referrals"
SET "status" = 'pending',
  "quota_cycle" = NULL,
  "expires_at" = "claimed_at" + interval '720 hours',
  "inviter_reward_amount_usd" = CASE WHEN "status" = 'capped' THEN '5' ELSE "inviter_reward_amount_usd" END,
  "invitee_reward_amount_usd" = CASE WHEN "status" = 'capped' THEN '5' ELSE "invitee_reward_amount_usd" END,
  "updated_at" = now()
WHERE "status" = 'pending'
  OR ("status" IN ('expired', 'capped') AND "claimed_at" + interval '720 hours' > now());
