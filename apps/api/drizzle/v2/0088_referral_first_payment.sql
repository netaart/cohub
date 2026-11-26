-- Referrals now qualify on the invitee's first payment: claims hold no quota and stay open for 30 days.
UPDATE "v2"."referrals"
SET "status" = 'pending',
  "quota_cycle" = NULL,
  "expires_at" = "claimed_at" + interval '30 days',
  "updated_at" = now()
WHERE "status" = 'pending'
  OR ("status" = 'expired' AND "claimed_at" + interval '30 days' > now());
