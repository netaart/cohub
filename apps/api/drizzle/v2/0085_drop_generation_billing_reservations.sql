-- Unsettled rows are the only record of a real prepaid debit; refuse to drop them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "v2"."generation_billing_reservations" WHERE "status" NOT IN ('settled', 'released')) THEN
    RAISE EXCEPTION 'v2.generation_billing_reservations has unsettled prepaid reserves; settle or release them before dropping the table';
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE "v2"."generation_billing_reservations" CASCADE;
