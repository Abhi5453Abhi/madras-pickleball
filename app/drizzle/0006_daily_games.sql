CREATE TYPE "public"."participation_source" AS ENUM('self', 'host');--> statement-breakpoint
CREATE TYPE "public"."participation_state" AS ENUM('joined', 'confirmed', 'waitlisted', 'withdrawn', 'checked_in', 'played', 'absent');--> statement-breakpoint
CREATE TYPE "public"."session_kind" AS ENUM('open_play', 'booked');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('draft', 'open', 'live', 'ended', 'locked', 'cancelled');--> statement-breakpoint
CREATE TABLE "game_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"venue_id" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"kind" "session_kind" DEFAULT 'open_play' NOT NULL,
	"status" "session_status" DEFAULT 'draft' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"price_paise" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"capacity" integer DEFAULT 16 NOT NULL,
	"court_count" integer DEFAULT 1 NOT NULL,
	"confirmation_gate" boolean DEFAULT true NOT NULL,
	"confirm_opens_at" timestamp with time zone,
	"confirm_deadline_at" timestamp with time zone,
	"auto_end_at" timestamp with time zone,
	"lock_at" timestamp with time zone,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"notes" text,
	"published_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"ended_by_user_id" text,
	"locked_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by_user_id" text,
	"stream_version" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "game_sessions_span" CHECK (ends_at > starts_at),
	CONSTRAINT "game_sessions_price_nonneg" CHECK (price_paise >= 0),
	CONSTRAINT "game_sessions_inr" CHECK (currency = 'INR'),
	CONSTRAINT "game_sessions_capacity" CHECK (capacity >= 1 and capacity <= 200),
	CONSTRAINT "game_sessions_courts" CHECK (court_count >= 0 and court_count <= 50),
	CONSTRAINT "game_sessions_gate_order" CHECK (confirm_opens_at is null or confirm_deadline_at is null or confirm_opens_at <= confirm_deadline_at)
);
--> statement-breakpoint
CREATE TABLE "session_participants" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"player_id" text NOT NULL,
	"payer_player_id" text NOT NULL,
	"invited_by_player_id" text,
	"state" "participation_state" DEFAULT 'joined' NOT NULL,
	"seq" integer NOT NULL,
	"seat_no" integer,
	"is_guest" boolean DEFAULT false NOT NULL,
	"source" "participation_source" DEFAULT 'self' NOT NULL,
	"display_name" text NOT NULL,
	"hide_from_public" boolean DEFAULT false NOT NULL,
	"manage_token" text NOT NULL,
	"device_id" text,
	"ip_hash" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"promoted_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by" text,
	"withdraw_reason" text,
	"checked_in_at" timestamp with time zone,
	"attendance_marked_at" timestamp with time zone,
	"attendance_marked_by" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_participants_guest_has_host" CHECK (is_guest = false or invited_by_player_id is not null),
	CONSTRAINT "session_participants_seat_shape" CHECK ((state in ('waitlisted'::participation_state, 'withdrawn'::participation_state) and seat_no is null)
          or (state not in ('waitlisted'::participation_state, 'withdrawn'::participation_state) and seat_no is not null)),
	CONSTRAINT "session_participants_seat_positive" CHECK (seat_no is null or seat_no >= 1),
	CONSTRAINT "session_participants_seq_positive" CHECK (seq >= 1)
);
--> statement-breakpoint
CREATE TABLE "session_scheduled_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"kind" text NOT NULL,
	"boundary_at" timestamp with time zone NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "scheduler_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"seen" integer DEFAULT 0 NOT NULL,
	"applied" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "game_sessions" ADD CONSTRAINT "game_sessions_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_sessions" ADD CONSTRAINT "game_sessions_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_sessions" ADD CONSTRAINT "game_sessions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_session_id_game_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_payer_player_id_players_id_fk" FOREIGN KEY ("payer_player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_invited_by_player_id_players_id_fk" FOREIGN KEY ("invited_by_player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_scheduled_actions" ADD CONSTRAINT "session_scheduled_actions_session_id_game_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "game_sessions_slug_key" ON "game_sessions" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "game_sessions_venue_start_idx" ON "game_sessions" USING btree ("venue_id","starts_at");--> statement-breakpoint
CREATE INDEX "game_sessions_status_start_idx" ON "game_sessions" USING btree ("status","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "session_participants_live_uq" ON "session_participants" USING btree ("session_id","player_id") WHERE state in ('joined'::participation_state, 'confirmed'::participation_state, 'waitlisted'::participation_state, 'checked_in'::participation_state, 'played'::participation_state, 'absent'::participation_state);--> statement-breakpoint
CREATE UNIQUE INDEX "session_participants_seat_uq" ON "session_participants" USING btree ("session_id","seat_no") WHERE seat_no is not null and state in ('joined'::participation_state, 'confirmed'::participation_state, 'checked_in'::participation_state, 'played'::participation_state, 'absent'::participation_state);--> statement-breakpoint
CREATE UNIQUE INDEX "session_participants_seq_uq" ON "session_participants" USING btree ("session_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "session_participants_token_uq" ON "session_participants" USING btree ("manage_token");--> statement-breakpoint
CREATE INDEX "session_participants_session_state_idx" ON "session_participants" USING btree ("session_id","state");--> statement-breakpoint
CREATE INDEX "session_participants_player_idx" ON "session_participants" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "session_participants_payer_idx" ON "session_participants" USING btree ("payer_player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_scheduled_actions_uq" ON "session_scheduled_actions" USING btree ("session_id","kind","boundary_at");--> statement-breakpoint
CREATE INDEX "session_scheduled_actions_session_idx" ON "session_scheduled_actions" USING btree ("session_id","boundary_at");--> statement-breakpoint
CREATE INDEX "scheduler_runs_name_idx" ON "scheduler_runs" USING btree ("name","started_at");