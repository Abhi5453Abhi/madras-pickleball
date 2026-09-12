CREATE TYPE "public"."charge_origin" AS ENUM('participation', 'policy', 'manual');--> statement-breakpoint
CREATE TYPE "public"."charge_state" AS ENUM('locked', 'waived', 'written_off');--> statement-breakpoint
CREATE TYPE "public"."payment_state" AS ENUM('initiated', 'succeeded', 'failed', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."refund_state" AS ENUM('initiated', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "charge_adjustments" (
	"id" text PRIMARY KEY NOT NULL,
	"charge_id" text NOT NULL,
	"delta_paise" integer NOT NULL,
	"reason" text NOT NULL,
	"actor_user_id" text,
	"actor_label" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "charge_adjustments_nonzero" CHECK (delta_paise <> 0)
);
--> statement-breakpoint
CREATE TABLE "charge_applications" (
	"id" text PRIMARY KEY NOT NULL,
	"charge_id" text NOT NULL,
	"payment_id" text,
	"credit_id" text,
	"amount_paise" integer NOT NULL,
	"reverses_id" text,
	"reason" text,
	"actor_label" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "charge_applications_nonzero" CHECK (amount_paise <> 0),
	CONSTRAINT "charge_applications_one_source" CHECK ((payment_id is not null and credit_id is null) or (payment_id is null and credit_id is not null)),
	CONSTRAINT "charge_applications_reversal_shape" CHECK ((reverses_id is null and amount_paise > 0) or (reverses_id is not null and amount_paise < 0))
);
--> statement-breakpoint
CREATE TABLE "charges" (
	"id" text PRIMARY KEY NOT NULL,
	"venue_id" text NOT NULL,
	"player_id" text NOT NULL,
	"session_id" text,
	"participation_id" text,
	"origin" charge_origin NOT NULL,
	"policy_kind" text,
	"amount_paise" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"reason" text NOT NULL,
	"state" charge_state DEFAULT 'locked' NOT NULL,
	"state_reason" text,
	"state_at" timestamp with time zone,
	"state_by_user_id" text,
	"adjust_paise" integer DEFAULT 0 NOT NULL,
	"applied_paise" integer DEFAULT 0 NOT NULL,
	"unit_price_paise" integer NOT NULL,
	"price_source" text DEFAULT 'session' NOT NULL,
	"price_note" text,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"cooldown_until" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "charges_applied_within" CHECK (applied_paise <= amount_paise + adjust_paise),
	CONSTRAINT "charges_applied_nonneg" CHECK (applied_paise >= 0),
	CONSTRAINT "charges_net_nonneg" CHECK (amount_paise + adjust_paise >= 0),
	CONSTRAINT "charges_amount_nonneg" CHECK (amount_paise >= 0),
	CONSTRAINT "charges_unit_price_nonneg" CHECK (unit_price_paise >= 0),
	CONSTRAINT "charges_inr" CHECK (currency = 'INR'),
	CONSTRAINT "charges_price_source" CHECK (price_source in ('session', 'override')),
	CONSTRAINT "charges_origin_shape" CHECK ((origin = 'participation'::charge_origin and participation_id is not null and policy_kind is null)
          or (origin = 'policy'::charge_origin and participation_id is not null and policy_kind is not null)
          or (origin = 'manual'::charge_origin and policy_kind is null)),
	CONSTRAINT "charges_state_reason" CHECK ((state = 'locked'::charge_state and state_reason is null and state_at is null)
          or (state <> 'locked'::charge_state and state_reason is not null and state_at is not null))
);
--> statement-breakpoint
CREATE TABLE "collection_attempt_charges" (
	"id" text PRIMARY KEY NOT NULL,
	"attempt_id" text NOT NULL,
	"charge_id" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"release_reason" text,
	CONSTRAINT "collection_attempt_charges_amount_positive" CHECK (amount_paise > 0)
);
--> statement-breakpoint
CREATE TABLE "collection_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"venue_id" text NOT NULL,
	"player_id" text NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'created' NOT NULL,
	"amount_paise" integer DEFAULT 0 NOT NULL,
	"attempt_no" integer DEFAULT 1 NOT NULL,
	"sweep_id" text,
	"provider" text,
	"provider_ref" text,
	"idempotency_key" text,
	"outcome_note" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitting_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "collection_attempts_amount_nonneg" CHECK (amount_paise >= 0),
	CONSTRAINT "collection_attempts_kind" CHECK (kind in ('desk', 'link', 'mandate')),
	CONSTRAINT "collection_attempts_state" CHECK (state in ('created', 'reserved', 'notified', 'awaiting_window', 'submitting', 'submitted', 'succeeded', 'failed', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "credits" (
	"id" text PRIMARY KEY NOT NULL,
	"venue_id" text NOT NULL,
	"player_id" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"reason" text NOT NULL,
	"applied_paise" integer DEFAULT 0 NOT NULL,
	"source_payment_id" text,
	"actor_label" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credits_amount_positive" CHECK (amount_paise > 0),
	CONSTRAINT "credits_inr" CHECK (currency = 'INR'),
	CONSTRAINT "credits_applied_within" CHECK (applied_paise >= 0 and applied_paise <= amount_paise)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"venue_id" text NOT NULL,
	"player_id" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"method" text NOT NULL,
	"initiator" text NOT NULL,
	"state" "payment_state" DEFAULT 'initiated' NOT NULL,
	"allocated_paise" integer DEFAULT 0 NOT NULL,
	"refunded_paise" integer DEFAULT 0 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt_id" text,
	"provider" text,
	"provider_payment_id" text,
	"note" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_positive" CHECK (amount_paise > 0),
	CONSTRAINT "payments_inr" CHECK (currency = 'INR'),
	CONSTRAINT "payments_spent_within" CHECK (allocated_paise + refunded_paise <= amount_paise),
	CONSTRAINT "payments_allocated_nonneg" CHECK (allocated_paise >= 0 and refunded_paise >= 0),
	CONSTRAINT "payments_method" CHECK (method in ('cash', 'venue_qr', 'gateway', 'bank_transfer')),
	CONSTRAINT "payments_initiator" CHECK (initiator in ('player', 'host', 'system'))
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_id" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"reason" text NOT NULL,
	"state" "refund_state" DEFAULT 'initiated' NOT NULL,
	"provider" text,
	"provider_refund_id" text,
	"actor_label" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "refunds_amount_positive" CHECK (amount_paise > 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"kind" text,
	"payload" text NOT NULL,
	"signature_ok" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "session_participants" ADD COLUMN "price_override_paise" integer;--> statement-breakpoint
ALTER TABLE "session_participants" ADD COLUMN "price_note" text;--> statement-breakpoint
ALTER TABLE "charge_adjustments" ADD CONSTRAINT "charge_adjustments_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_adjustments" ADD CONSTRAINT "charge_adjustments_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_applications" ADD CONSTRAINT "charge_applications_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_applications" ADD CONSTRAINT "charge_applications_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_applications" ADD CONSTRAINT "charge_applications_credit_id_credits_id_fk" FOREIGN KEY ("credit_id") REFERENCES "public"."credits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_session_id_game_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_participation_id_session_participants_id_fk" FOREIGN KEY ("participation_id") REFERENCES "public"."session_participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_state_by_user_id_users_id_fk" FOREIGN KEY ("state_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_attempt_charges" ADD CONSTRAINT "collection_attempt_charges_attempt_id_collection_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."collection_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_attempt_charges" ADD CONSTRAINT "collection_attempt_charges_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_attempts" ADD CONSTRAINT "collection_attempts_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_attempts" ADD CONSTRAINT "collection_attempts_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_attempts" ADD CONSTRAINT "collection_attempts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credits" ADD CONSTRAINT "credits_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credits" ADD CONSTRAINT "credits_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credits" ADD CONSTRAINT "credits_source_payment_id_payments_id_fk" FOREIGN KEY ("source_payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credits" ADD CONSTRAINT "credits_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "charge_adjustments_charge_idx" ON "charge_adjustments" USING btree ("charge_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "charge_applications_reverses_uq" ON "charge_applications" USING btree ("reverses_id") WHERE reverses_id is not null;--> statement-breakpoint
CREATE INDEX "charge_applications_charge_idx" ON "charge_applications" USING btree ("charge_id","at");--> statement-breakpoint
CREATE INDEX "charge_applications_payment_idx" ON "charge_applications" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "charge_applications_credit_idx" ON "charge_applications" USING btree ("credit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "charges_participation_uq" ON "charges" USING btree ("participation_id") WHERE origin = 'participation'::charge_origin;--> statement-breakpoint
CREATE UNIQUE INDEX "charges_policy_uq" ON "charges" USING btree ("participation_id","policy_kind") WHERE origin = 'policy'::charge_origin;--> statement-breakpoint
CREATE INDEX "charges_player_idx" ON "charges" USING btree ("player_id","state");--> statement-breakpoint
CREATE INDEX "charges_session_idx" ON "charges" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "charges_open_idx" ON "charges" USING btree ("venue_id","created_at") WHERE state = 'locked'::charge_state and applied_paise < amount_paise + adjust_paise;--> statement-breakpoint
CREATE UNIQUE INDEX "one_live_reservation_per_charge" ON "collection_attempt_charges" USING btree ("charge_id") WHERE released_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "collection_attempt_charges_uq" ON "collection_attempt_charges" USING btree ("attempt_id","charge_id");--> statement-breakpoint
CREATE INDEX "collection_attempt_charges_charge_idx" ON "collection_attempt_charges" USING btree ("charge_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_attempts_key_uq" ON "collection_attempts" USING btree ("provider","idempotency_key") WHERE provider is not null and idempotency_key is not null;--> statement-breakpoint
CREATE INDEX "collection_attempts_player_idx" ON "collection_attempts" USING btree ("player_id","created_at");--> statement-breakpoint
CREATE INDEX "collection_attempts_open_idx" ON "collection_attempts" USING btree ("venue_id","submitting_at") WHERE state in ('submitting', 'submitted', 'unknown');--> statement-breakpoint
CREATE INDEX "credits_player_idx" ON "credits" USING btree ("player_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_uq" ON "payments" USING btree ("provider","provider_payment_id") WHERE provider is not null and provider_payment_id is not null;--> statement-breakpoint
CREATE INDEX "payments_player_idx" ON "payments" USING btree ("player_id","received_at");--> statement-breakpoint
CREATE INDEX "payments_venue_day_idx" ON "payments" USING btree ("venue_id","received_at");--> statement-breakpoint
CREATE INDEX "payments_unallocated_idx" ON "payments" USING btree ("player_id") WHERE state = 'succeeded'::payment_state and allocated_paise + refunded_paise < amount_paise;--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_provider_uq" ON "refunds" USING btree ("provider","provider_refund_id") WHERE provider is not null and provider_refund_id is not null;--> statement-breakpoint
CREATE INDEX "refunds_payment_idx" ON "refunds" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_uq" ON "webhook_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_unprocessed_idx" ON "webhook_events" USING btree ("received_at") WHERE processed_at is null;--> statement-breakpoint
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_override_nonneg" CHECK (price_override_paise is null or price_override_paise >= 0);--> statement-breakpoint
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_override_shape" CHECK ((price_override_paise is null and price_note is null) or (price_override_paise is not null and price_note is not null));--> statement-breakpoint
CREATE FUNCTION "money_row_is_forever"() RETURNS trigger LANGUAGE plpgsql AS $$
begin
	raise exception 'money rows are never deleted (%): a correction is a new row with a sign', tg_table_name
		using errcode = 'restrict_violation';
end
$$;--> statement-breakpoint
CREATE TRIGGER "charges_no_delete" BEFORE DELETE ON "charges" FOR EACH ROW EXECUTE FUNCTION "money_row_is_forever"();--> statement-breakpoint
CREATE TRIGGER "charge_adjustments_no_delete" BEFORE DELETE ON "charge_adjustments" FOR EACH ROW EXECUTE FUNCTION "money_row_is_forever"();--> statement-breakpoint
CREATE TRIGGER "charge_applications_no_delete" BEFORE DELETE ON "charge_applications" FOR EACH ROW EXECUTE FUNCTION "money_row_is_forever"();--> statement-breakpoint
CREATE TRIGGER "payments_no_delete" BEFORE DELETE ON "payments" FOR EACH ROW EXECUTE FUNCTION "money_row_is_forever"();--> statement-breakpoint
CREATE TRIGGER "credits_no_delete" BEFORE DELETE ON "credits" FOR EACH ROW EXECUTE FUNCTION "money_row_is_forever"();--> statement-breakpoint
CREATE TRIGGER "refunds_no_delete" BEFORE DELETE ON "refunds" FOR EACH ROW EXECUTE FUNCTION "money_row_is_forever"();--> statement-breakpoint
CREATE TRIGGER "collection_attempts_no_delete" BEFORE DELETE ON "collection_attempts" FOR EACH ROW EXECUTE FUNCTION "money_row_is_forever"();--> statement-breakpoint
CREATE TRIGGER "collection_attempt_charges_no_delete" BEFORE DELETE ON "collection_attempt_charges" FOR EACH ROW EXECUTE FUNCTION "money_row_is_forever"();--> statement-breakpoint
CREATE TRIGGER "webhook_events_no_delete" BEFORE DELETE ON "webhook_events" FOR EACH ROW EXECUTE FUNCTION "money_row_is_forever"();--> statement-breakpoint
CREATE FUNCTION "payment_state_is_forward"() RETURNS trigger LANGUAGE plpgsql AS $$
begin
	if new."state" = old."state" then
		return new;
	end if;
	-- SPEC-v4 §5, Payment: "`succeeded` -> `failed`" is illegal, and out-of-order
	-- webhooks are handled by refusing backward transitions rather than by
	-- trusting arrival order. `initiated` may become anything; a payment that
	-- has landed may only be reversed; nothing else moves once it is settled.
	if old."state" = 'initiated' then
		return new;
	end if;
	if old."state" = 'succeeded' and new."state" = 'reversed' then
		return new;
	end if;
	raise exception 'a payment does not go from % back to %', old."state", new."state"
		using errcode = 'restrict_violation';
end
$$;--> statement-breakpoint
CREATE TRIGGER "payments_state_forward" BEFORE UPDATE OF "state" ON "payments" FOR EACH ROW EXECUTE FUNCTION "payment_state_is_forward"();--> statement-breakpoint
CREATE VIEW "player_balances" AS
select
	pl."id" as "player_id",
	v."id" as "venue_id",
	coalesce(ch."owed_paise", 0)::bigint as "owed_paise",
	(coalesce(pay."unallocated_paise", 0) + coalesce(cr."unused_paise", 0))::bigint as "on_account_paise",
	(coalesce(ch."owed_paise", 0) - coalesce(pay."unallocated_paise", 0) - coalesce(cr."unused_paise", 0))::bigint as "balance_paise",
	coalesce(ch."open_charges", 0)::bigint as "open_charges",
	ch."oldest_open_at" as "oldest_open_at"
from "players" pl
cross join "venues" v
left join lateral (
	select
		sum(c."amount_paise" + c."adjust_paise" - c."applied_paise") as "owed_paise",
		count(*) filter (where c."amount_paise" + c."adjust_paise" > c."applied_paise") as "open_charges",
		min(c."created_at") filter (where c."amount_paise" + c."adjust_paise" > c."applied_paise") as "oldest_open_at"
	from "charges" c
	where c."player_id" = pl."id" and c."venue_id" = v."id" and c."state" = 'locked'
) ch on true
left join lateral (
	select sum(p."amount_paise" - p."allocated_paise" - p."refunded_paise") as "unallocated_paise"
	from "payments" p
	where p."player_id" = pl."id" and p."venue_id" = v."id" and p."state" = 'succeeded'
) pay on true
left join lateral (
	select sum(k."amount_paise" - k."applied_paise") as "unused_paise"
	from "credits" k
	where k."player_id" = pl."id" and k."venue_id" = v."id"
) cr on true;
