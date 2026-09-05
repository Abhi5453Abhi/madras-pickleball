CREATE TYPE "public"."actor_type" AS ENUM('court_token', 'umpire_pin', 'user', 'live_scoring');--> statement-breakpoint
CREATE TYPE "public"."category_status" AS ENUM('draft', 'entries_open', 'draw_locked', 'live', 'completed');--> statement-breakpoint
CREATE TYPE "public"."confirmation_confidence" AS ENUM('normal', 'low');--> statement-breakpoint
CREATE TYPE "public"."discipline" AS ENUM('singles', 'doubles');--> statement-breakpoint
CREATE TYPE "public"."draw_type" AS ENUM('league', 'groups_knockout', 'single_elim', 'americano');--> statement-breakpoint
CREATE TYPE "public"."finals_stage" AS ENUM('none', 'final_only', 'semis_and_final', 'quarters_onward');--> statement-breakpoint
CREATE TYPE "public"."gender_category" AS ENUM('mens', 'womens', 'mixed', 'any');--> statement-breakpoint
CREATE TYPE "public"."gender" AS ENUM('male', 'female', 'other');--> statement-breakpoint
CREATE TYPE "public"."match_event_type" AS ENUM('start', 'rally', 'side_out', 'timeout', 'undo', 'state_override', 'game_end', 'match_end');--> statement-breakpoint
CREATE TYPE "public"."match_status" AS ENUM('pending', 'ready', 'called', 'warming_up', 'live', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."registration_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."result_state" AS ENUM('none', 'reported', 'disputed', 'final', 'voided');--> statement-breakpoint
CREATE TYPE "public"."result_type" AS ENUM('normal', 'bye', 'walkover', 'retired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('super_admin', 'admin', 'umpire');--> statement-breakpoint
CREATE TYPE "public"."scoring_mode" AS ENUM('open', 'authenticated');--> statement-breakpoint
CREATE TYPE "public"."scoring_type" AS ENUM('side_out', 'rally');--> statement-breakpoint
CREATE TYPE "public"."skill_level" AS ENUM('new_player', 'regular', 'strong');--> statement-breakpoint
CREATE TYPE "public"."slot_source" AS ENUM('entry', 'winner_of', 'loser_of', 'group_rank', 'bye');--> statement-breakpoint
CREATE TYPE "public"."submission_status" AS ENUM('active', 'superseded', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."team_mode" AS ENUM('prebuilt', 'random', 'balanced', 'self_registered');--> statement-breakpoint
CREATE TYPE "public"."team_status" AS ENUM('active', 'withdrawn', 'disqualified');--> statement-breakpoint
CREATE TYPE "public"."tiebreak_rule" AS ENUM('points_scored_first', 'head_to_head_first');--> statement-breakpoint
CREATE TYPE "public"."token_kind" AS ENUM('reset', 'recovery');--> statement-breakpoint
CREATE TYPE "public"."token_status" AS ENUM('active', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."tournament_status" AS ENUM('draft', 'registration', 'live', 'completed', 'archived');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"actor_label" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"reason" text,
	"before" jsonb,
	"after" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" text PRIMARY KEY NOT NULL,
	"tournament_id" text NOT NULL,
	"name" text NOT NULL,
	"discipline" "discipline" NOT NULL,
	"gender" "gender_category" NOT NULL,
	"team_mode" "team_mode" DEFAULT 'prebuilt' NOT NULL,
	"draw_type" "draw_type" DEFAULT 'league' NOT NULL,
	"finals_stage" "finals_stage" DEFAULT 'final_only' NOT NULL,
	"status" "category_status" DEFAULT 'draft' NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"best_of" integer DEFAULT 3 NOT NULL,
	"points_to_win" integer DEFAULT 11 NOT NULL,
	"win_by" integer DEFAULT 2 NOT NULL,
	"hard_cap" integer,
	"scoring_type" "scoring_type" DEFAULT 'side_out' NOT NULL,
	"timeouts_per_game" integer DEFAULT 2 NOT NULL,
	"tiebreak_rule" "tiebreak_rule" DEFAULT 'points_scored_first' NOT NULL,
	"authenticated_from_round" integer,
	"group_count" integer DEFAULT 1 NOT NULL,
	"advance_per_group" integer DEFAULT 2 NOT NULL,
	"rng_seed" text,
	"seed_order" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draw_version" integer DEFAULT 0 NOT NULL,
	"revision_note" text,
	"draw_locked_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"winner_team_id" text,
	"runner_up_team_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "category_players" (
	"id" text PRIMARY KEY NOT NULL,
	"category_id" text NOT NULL,
	"player_id" text NOT NULL,
	"substitute" boolean DEFAULT false NOT NULL,
	"requested_partner_id" text
);
--> statement-breakpoint
CREATE TABLE "category_round_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"category_id" text NOT NULL,
	"stage" text NOT NULL,
	"round_index" integer NOT NULL,
	"rules" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "court_closures" (
	"id" text PRIMARY KEY NOT NULL,
	"court_id" text NOT NULL,
	"tournament_id" text,
	"reason" text,
	"from" timestamp with time zone DEFAULT now() NOT NULL,
	"until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "court_sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"court_token_id" text NOT NULL,
	"device_id" text NOT NULL,
	"umpire_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_hash" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "court_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"tournament_id" text NOT NULL,
	"court_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"label" text,
	"status" "token_status" DEFAULT 'active' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"rotated_from_id" text,
	"last_used_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "courts" (
	"id" text PRIMARY KEY NOT NULL,
	"venue_id" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"color_key" text DEFAULT 'blue' NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" text PRIMARY KEY NOT NULL,
	"match_id" text NOT NULL,
	"game_no" integer NOT NULL,
	"score_a" integer DEFAULT 0 NOT NULL,
	"score_b" integer DEFAULT 0 NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"winner_team_id" text,
	"provisional" boolean DEFAULT true NOT NULL,
	"time_capped" boolean DEFAULT false NOT NULL,
	"exclude_from_diff" boolean DEFAULT false NOT NULL,
	"server_team_id" text,
	"server_number" integer,
	"team_a_start_right_player_id" text,
	"team_b_start_right_player_id" text,
	"timeouts_a" integer DEFAULT 0 NOT NULL,
	"timeouts_b" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" text PRIMARY KEY NOT NULL,
	"category_id" text NOT NULL,
	"name" text NOT NULL,
	"advance_count" integer DEFAULT 2 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"ip_hash" text,
	"succeeded" boolean DEFAULT false NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_confirmations" (
	"id" text PRIMARY KEY NOT NULL,
	"match_id" text NOT NULL,
	"submission_id" text NOT NULL,
	"attributor_key" text NOT NULL,
	"agreed_for_team_id" text,
	"digest" text NOT NULL,
	"confidence" "confirmation_confidence" DEFAULT 'normal' NOT NULL,
	"device_id" text,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_events" (
	"id" text PRIMARY KEY NOT NULL,
	"match_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" "match_event_type" NOT NULL,
	"payload" jsonb,
	"state_after" jsonb,
	"client_event_id" text,
	"device_id" text,
	"client_seq" integer,
	"client_at" timestamp with time zone,
	"undoes_event_id" text,
	"voided_by_event_id" text,
	"by_user_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_scoring_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"match_id" text NOT NULL,
	"court_session_id" text NOT NULL,
	"reason" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_slots" (
	"id" text PRIMARY KEY NOT NULL,
	"match_id" text NOT NULL,
	"slot" varchar(1) NOT NULL,
	"source_type" "slot_source" NOT NULL,
	"source_match_id" text,
	"source_group_id" text,
	"source_rank" integer,
	"resolved_team_id" text,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" text PRIMARY KEY NOT NULL,
	"category_id" text NOT NULL,
	"tournament_id" text NOT NULL,
	"stage" text DEFAULT 'group' NOT NULL,
	"round_index" integer DEFAULT 0 NOT NULL,
	"round_name" text,
	"seq" integer DEFAULT 0 NOT NULL,
	"group_id" text,
	"team_a_id" text,
	"team_b_id" text,
	"court_id" text,
	"scheduled_at" timestamp with time zone,
	"not_before" timestamp with time zone,
	"called_at" timestamp with time zone,
	"warmup_started_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"status" "match_status" DEFAULT 'pending' NOT NULL,
	"result_state" "result_state" DEFAULT 'none' NOT NULL,
	"result_type" "result_type" DEFAULT 'normal' NOT NULL,
	"umpire_id" text,
	"winner_team_id" text,
	"retired_team_id" text,
	"scoring_mode" "scoring_mode" DEFAULT 'open' NOT NULL,
	"rules_override" jsonb,
	"games_won_a" integer DEFAULT 0 NOT NULL,
	"games_won_b" integer DEFAULT 0 NOT NULL,
	"score_summary" jsonb,
	"provisional" boolean DEFAULT false NOT NULL,
	"reported_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"confirmed_via" text,
	"dispute_opened_at" timestamp with time zone,
	"dispute_resolved_at" timestamp with time zone,
	"corrected_at" timestamp with time zone,
	"correction_count" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"queue_position" integer,
	"on_hold" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matches_winner_is_a_participant" CHECK (winner_team_id is null or winner_team_id = team_a_id or winner_team_id = team_b_id)
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"kind" "token_kind" DEFAULT 'reset' NOT NULL,
	"expires_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_registrations" (
	"id" text PRIMARY KEY NOT NULL,
	"tournament_id" text NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"phone" text,
	"gender" "gender",
	"skill" "skill_level",
	"category_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"partner_name" text,
	"partner_name_key" text,
	"partner_registration_id" text,
	"status" "registration_status" DEFAULT 'pending' NOT NULL,
	"merged_player_id" text,
	"device_id" text,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"review_note" text
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"gender" "gender",
	"phone" text,
	"phone_key" text,
	"skill" "skill_level",
	"dupr_id" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "registration_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"tournament_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"status" "token_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "result_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"match_id" text NOT NULL,
	"player_id" text,
	"device_id" text NOT NULL,
	"note" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "result_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"match_id" text NOT NULL,
	"attributor_key" text NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"court_session_id" text,
	"user_id" text,
	"umpire_id" text,
	"device_id" text,
	"ip_hash" text,
	"submitting_team_id" text,
	"games" jsonb NOT NULL,
	"result_type" "result_type" DEFAULT 'normal' NOT NULL,
	"retired_team_id" text,
	"winner_team_id" text,
	"normalized_digest" text NOT NULL,
	"client_event_id" text NOT NULL,
	"status" "submission_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"ip_hash" text
);
--> statement-breakpoint
CREATE TABLE "sync_conflicts" (
	"id" text PRIMARY KEY NOT NULL,
	"match_id" text NOT NULL,
	"device_id" text,
	"payload" jsonb NOT NULL,
	"reason" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "team_player_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"out_player_id" text,
	"in_player_id" text,
	"reason" text NOT NULL,
	"by_user_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_players" (
	"team_id" text NOT NULL,
	"player_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "team_players_team_id_player_id_pk" PRIMARY KEY("team_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"category_id" text NOT NULL,
	"group_id" text,
	"name" text NOT NULL,
	"seed" integer,
	"status" "team_status" DEFAULT 'active' NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"void_results" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"prefix" text,
	"ip_hash" text,
	"succeeded" boolean DEFAULT false NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tournament_players" (
	"id" text PRIMARY KEY NOT NULL,
	"tournament_id" text NOT NULL,
	"player_id" text NOT NULL,
	"skill_snapshot" "skill_level",
	"paid" boolean DEFAULT false NOT NULL,
	"paid_note" text,
	"withdrawn" boolean DEFAULT false NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tournaments" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"venue_id" text NOT NULL,
	"start_date" timestamp with time zone NOT NULL,
	"end_date" timestamp with time zone NOT NULL,
	"status" "tournament_status" DEFAULT 'draft' NOT NULL,
	"description" text,
	"banner_url" text,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"stream_version" bigint DEFAULT 0 NOT NULL,
	"paused_at" timestamp with time zone,
	"pause_note" text,
	"break_starts_at" timestamp with time zone,
	"break_ends_at" timestamp with time zone,
	"sunset_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"username" text NOT NULL,
	"phone" text,
	"password_hash" text NOT NULL,
	"pin_hash" text,
	"role" "role" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"password_changed_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"pin_failed_count" integer DEFAULT 0 NOT NULL,
	"pin_locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "venues" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_players" ADD CONSTRAINT "category_players_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_players" ADD CONSTRAINT "category_players_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_round_rules" ADD CONSTRAINT "category_round_rules_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_closures" ADD CONSTRAINT "court_closures_court_id_courts_id_fk" FOREIGN KEY ("court_id") REFERENCES "public"."courts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_sessions" ADD CONSTRAINT "court_sessions_court_token_id_court_tokens_id_fk" FOREIGN KEY ("court_token_id") REFERENCES "public"."court_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_sessions" ADD CONSTRAINT "court_sessions_umpire_user_id_users_id_fk" FOREIGN KEY ("umpire_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_tokens" ADD CONSTRAINT "court_tokens_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_tokens" ADD CONSTRAINT "court_tokens_court_id_courts_id_fk" FOREIGN KEY ("court_id") REFERENCES "public"."courts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courts" ADD CONSTRAINT "courts_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_confirmations" ADD CONSTRAINT "match_confirmations_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_confirmations" ADD CONSTRAINT "match_confirmations_submission_id_result_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."result_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_confirmations" ADD CONSTRAINT "match_confirmations_agreed_for_team_id_teams_id_fk" FOREIGN KEY ("agreed_for_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_scoring_grants" ADD CONSTRAINT "match_scoring_grants_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_scoring_grants" ADD CONSTRAINT "match_scoring_grants_court_session_id_court_sessions_id_hash_fk" FOREIGN KEY ("court_session_id") REFERENCES "public"."court_sessions"("id_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_slots" ADD CONSTRAINT "match_slots_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_slots" ADD CONSTRAINT "match_slots_source_group_id_groups_id_fk" FOREIGN KEY ("source_group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_slots" ADD CONSTRAINT "match_slots_resolved_team_id_teams_id_fk" FOREIGN KEY ("resolved_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_team_a_id_teams_id_fk" FOREIGN KEY ("team_a_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_team_b_id_teams_id_fk" FOREIGN KEY ("team_b_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_court_id_courts_id_fk" FOREIGN KEY ("court_id") REFERENCES "public"."courts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_umpire_id_users_id_fk" FOREIGN KEY ("umpire_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_winner_team_id_teams_id_fk" FOREIGN KEY ("winner_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_retired_team_id_teams_id_fk" FOREIGN KEY ("retired_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_registrations" ADD CONSTRAINT "pending_registrations_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_tokens" ADD CONSTRAINT "registration_tokens_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_flags" ADD CONSTRAINT "result_flags_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_flags" ADD CONSTRAINT "result_flags_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_submissions" ADD CONSTRAINT "result_submissions_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_submissions" ADD CONSTRAINT "result_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_submissions" ADD CONSTRAINT "result_submissions_submitting_team_id_teams_id_fk" FOREIGN KEY ("submitting_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_player_changes" ADD CONSTRAINT "team_player_changes_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_players" ADD CONSTRAINT "team_players_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_players" ADD CONSTRAINT "team_players_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_players" ADD CONSTRAINT "tournament_players_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_players" ADD CONSTRAINT "tournament_players_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_log" USING btree ("entity","entity_id","at");--> statement-breakpoint
CREATE INDEX "audit_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "categories_tournament_idx" ON "categories" USING btree ("tournament_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "category_players_uq" ON "category_players" USING btree ("category_id","player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "category_round_rules_uq" ON "category_round_rules" USING btree ("category_id","round_index");--> statement-breakpoint
CREATE INDEX "court_closures_idx" ON "court_closures" USING btree ("court_id","from");--> statement-breakpoint
CREATE INDEX "court_sessions_token_idx" ON "court_sessions" USING btree ("court_token_id");--> statement-breakpoint
CREATE UNIQUE INDEX "court_tokens_active_uq" ON "court_tokens" USING btree ("tournament_id","court_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "court_tokens_idx" ON "court_tokens" USING btree ("tournament_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "courts_venue_name_key" ON "courts" USING btree ("venue_id","name");--> statement-breakpoint
CREATE INDEX "courts_venue_order_idx" ON "courts" USING btree ("venue_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "games_match_no_uq" ON "games" USING btree ("match_id","game_no");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_category_name_uq" ON "groups" USING btree ("category_id","name");--> statement-breakpoint
CREATE INDEX "login_attempts_idx" ON "login_attempts" USING btree ("identifier","at");--> statement-breakpoint
CREATE INDEX "match_confirmations_idx" ON "match_confirmations" USING btree ("match_id");--> statement-breakpoint
CREATE UNIQUE INDEX "match_events_seq_uq" ON "match_events" USING btree ("match_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "match_events_client_uq" ON "match_events" USING btree ("match_id","client_event_id") WHERE client_event_id is not null;--> statement-breakpoint
CREATE INDEX "match_events_idx" ON "match_events" USING btree ("match_id","at");--> statement-breakpoint
CREATE INDEX "match_scoring_grants_idx" ON "match_scoring_grants" USING btree ("match_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "match_slots_uq" ON "match_slots" USING btree ("match_id","slot");--> statement-breakpoint
CREATE INDEX "match_slots_source_match_idx" ON "match_slots" USING btree ("source_match_id");--> statement-breakpoint
CREATE INDEX "match_slots_source_group_idx" ON "match_slots" USING btree ("source_group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "matches_one_live_per_court" ON "matches" USING btree ("court_id") WHERE status = 'live' and court_id is not null;--> statement-breakpoint
CREATE INDEX "matches_stream_idx" ON "matches" USING btree ("tournament_id","updated_at");--> statement-breakpoint
CREATE INDEX "matches_tournament_status_idx" ON "matches" USING btree ("tournament_id","status");--> statement-breakpoint
CREATE INDEX "matches_category_round_idx" ON "matches" USING btree ("category_id","round_index","seq");--> statement-breakpoint
CREATE INDEX "matches_umpire_idx" ON "matches" USING btree ("umpire_id","status");--> statement-breakpoint
CREATE INDEX "matches_court_idx" ON "matches" USING btree ("court_id","status");--> statement-breakpoint
CREATE INDEX "reset_tokens_user_idx" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pending_regs_status_idx" ON "pending_registrations" USING btree ("tournament_id","status");--> statement-breakpoint
CREATE INDEX "pending_regs_name_idx" ON "pending_registrations" USING btree ("tournament_id","name_key");--> statement-breakpoint
CREATE UNIQUE INDEX "players_phone_key_uq" ON "players" USING btree ("phone_key") WHERE phone_key is not null;--> statement-breakpoint
CREATE INDEX "players_name_key_idx" ON "players" USING btree ("name_key");--> statement-breakpoint
CREATE INDEX "registration_tokens_idx" ON "registration_tokens" USING btree ("tournament_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "registration_tokens_active_uq" ON "registration_tokens" USING btree ("tournament_id") WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "result_flags_device_uq" ON "result_flags" USING btree ("match_id","device_id");--> statement-breakpoint
CREATE INDEX "result_flags_open_idx" ON "result_flags" USING btree ("match_id","resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "result_submissions_client_uq" ON "result_submissions" USING btree ("match_id","client_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "result_submissions_attributor_uq" ON "result_submissions" USING btree ("match_id","attributor_key") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "result_submissions_idx" ON "result_submissions" USING btree ("match_id","status");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expiry_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sync_conflicts_idx" ON "sync_conflicts" USING btree ("match_id","at");--> statement-breakpoint
CREATE INDEX "team_player_changes_idx" ON "team_player_changes" USING btree ("team_id","at");--> statement-breakpoint
CREATE INDEX "team_players_player_idx" ON "team_players" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_category_name_uq" ON "teams" USING btree ("category_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_category_seed_uq" ON "teams" USING btree ("category_id","seed") WHERE seed is not null;--> statement-breakpoint
CREATE INDEX "teams_category_group_idx" ON "teams" USING btree ("category_id","group_id");--> statement-breakpoint
CREATE INDEX "token_attempts_ip_idx" ON "token_attempts" USING btree ("ip_hash","at");--> statement-breakpoint
CREATE INDEX "token_attempts_at_idx" ON "token_attempts" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "tournament_players_uq" ON "tournament_players" USING btree ("tournament_id","player_id");--> statement-breakpoint
CREATE INDEX "tournament_players_idx" ON "tournament_players" USING btree ("tournament_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tournaments_slug_key" ON "tournaments" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "tournaments_status_idx" ON "tournaments" USING btree ("status","start_date");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_key" ON "users" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "users_phone_key" ON "users" USING btree ("phone") WHERE phone is not null;--> statement-breakpoint
CREATE INDEX "users_role_active_idx" ON "users" USING btree ("role","active");--> statement-breakpoint
CREATE UNIQUE INDEX "venues_slug_key" ON "venues" USING btree ("slug");