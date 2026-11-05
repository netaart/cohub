CREATE TABLE "v2"."generation_billing_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_run_id" uuid NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"space_id" uuid,
	"model" varchar(255) NOT NULL,
	"usage_type" varchar(100) NOT NULL,
	"payer_type" varchar(20) NOT NULL,
	"payer_id" varchar(255) NOT NULL,
	"reserve_usd" numeric(18, 8) NOT NULL,
	"actual_usd" numeric(18, 8),
	"settle_overage" boolean DEFAULT false NOT NULL,
	"discount_multiplier" numeric(8, 5) DEFAULT '1' NOT NULL,
	"reserve_operation_id" varchar(255) NOT NULL,
	"settle_operation_id" varchar(255),
	"reversal_operation_id" varchar(255),
	"status" varchar(20) DEFAULT 'reserving' NOT NULL,
	"reversal_receipt" jsonb,
	"last_error" text,
	"expires_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "v2_chk_generation_billing_reservations_status" CHECK ("v2"."generation_billing_reservations"."status" in ('reserving', 'held', 'running', 'settling', 'settled', 'releasing', 'released')),
	CONSTRAINT "v2_chk_generation_billing_reservations_reserve_usd" CHECK ("v2"."generation_billing_reservations"."reserve_usd" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_generation_billing_reservations_task_run" ON "v2"."generation_billing_reservations" USING btree ("task_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_generation_billing_reservations_reserve_operation" ON "v2"."generation_billing_reservations" USING btree ("reserve_operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_generation_billing_reservations_settle_operation" ON "v2"."generation_billing_reservations" USING btree ("settle_operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_generation_billing_reservations_reversal_operation" ON "v2"."generation_billing_reservations" USING btree ("reversal_operation_id");--> statement-breakpoint
CREATE INDEX "v2_idx_generation_billing_reservations_payer" ON "v2"."generation_billing_reservations" USING btree ("payer_type","payer_id","status");--> statement-breakpoint
CREATE INDEX "v2_idx_generation_billing_reservations_status_expires" ON "v2"."generation_billing_reservations" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "v2_idx_generation_billing_reservations_user_created" ON "v2"."generation_billing_reservations" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "v2_idx_generation_billing_reservations_space_created" ON "v2"."generation_billing_reservations" USING btree ("space_id","created_at");