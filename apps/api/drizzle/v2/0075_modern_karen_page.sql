CREATE TABLE "v2"."session_goals" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"goal_id" uuid NOT NULL,
	"objective" text NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"token_budget" bigint,
	"created_sequence" integer NOT NULL,
	"harness" varchar(20) DEFAULT 'cohub' NOT NULL,
	"provider" varchar(100),
	"model" varchar(255),
	"access_mode" varchar(20) DEFAULT 'full_access' NOT NULL,
	"thinking_level" varchar(20),
	"created_by" varchar(255),
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "v2"."session_goals" ADD CONSTRAINT "session_goals_session_id_space_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "v2"."space_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "v2_idx_session_goals_status_updated" ON "v2"."session_goals" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "v2_idx_session_goals_created_by" ON "v2"."session_goals" USING btree ("created_by");