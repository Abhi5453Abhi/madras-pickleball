CREATE TYPE "public"."court_hold_kind" AS ENUM('tournament', 'session', 'block');--> statement-breakpoint
CREATE TABLE "court_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"court_id" text NOT NULL,
	"kind" "court_hold_kind" NOT NULL,
	"tournament_id" text,
	"session_id" text,
	"reason" text,
	"held_from" timestamp with time zone NOT NULL,
	"held_until" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "court_holds_span" CHECK (held_until > held_from),
	CONSTRAINT "court_holds_holder" CHECK ((kind = 'tournament' and tournament_id is not null and session_id is null) or (kind = 'session' and session_id is not null and tournament_id is null) or (kind = 'block' and tournament_id is null and session_id is null)),
	CONSTRAINT "court_holds_block_reason" CHECK (kind <> 'block' or (reason is not null and btrim(reason) <> ''))
);
--> statement-breakpoint
CREATE TABLE "court_hold_slots" (
	"court_id" text NOT NULL,
	"slot_start" timestamp with time zone NOT NULL,
	"hold_id" text NOT NULL,
	CONSTRAINT "court_hold_slots_court_id_slot_start_pk" PRIMARY KEY("court_id","slot_start")
);
--> statement-breakpoint
ALTER TABLE "tournaments" ADD COLUMN "court_from_min" integer;--> statement-breakpoint
ALTER TABLE "tournaments" ADD COLUMN "court_until_min" integer;--> statement-breakpoint
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_court_hours" CHECK ((court_from_min is null) = (court_until_min is null) and (court_from_min is null or (court_from_min >= 0 and court_until_min > court_from_min and court_until_min <= 1440)));--> statement-breakpoint
ALTER TABLE "court_holds" ADD CONSTRAINT "court_holds_court_id_courts_id_fk" FOREIGN KEY ("court_id") REFERENCES "public"."courts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_holds" ADD CONSTRAINT "court_holds_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_holds" ADD CONSTRAINT "court_holds_session_id_game_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_holds" ADD CONSTRAINT "court_holds_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_hold_slots" ADD CONSTRAINT "court_hold_slots_court_id_courts_id_fk" FOREIGN KEY ("court_id") REFERENCES "public"."courts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_hold_slots" ADD CONSTRAINT "court_hold_slots_hold_id_court_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."court_holds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "court_holds_court_from_idx" ON "court_holds" USING btree ("court_id","held_from");--> statement-breakpoint
CREATE INDEX "court_holds_tournament_idx" ON "court_holds" USING btree ("tournament_id") WHERE tournament_id is not null;--> statement-breakpoint
CREATE INDEX "court_holds_session_idx" ON "court_holds" USING btree ("session_id") WHERE session_id is not null;--> statement-breakpoint
CREATE INDEX "court_holds_window_idx" ON "court_holds" USING btree ("held_from","held_until");--> statement-breakpoint
CREATE INDEX "court_hold_slots_hold_idx" ON "court_hold_slots" USING btree ("hold_id");--> statement-breakpoint
CREATE FUNCTION "court_hold_slots_sync"() RETURNS trigger LANGUAGE plpgsql AS $$
begin
	-- Statement level, with transition tables, so a single statement that moves
	-- several holds at once frees every old slot BEFORE claiming any new one.
	-- A row-level trigger would re-insert row 1 while row 2 still held the slot
	-- it is moving out of, and raise on an overlap that does not exist.
	if tg_op in ('UPDATE', 'DELETE') then
		delete from "court_hold_slots" s using old_holds o where s."hold_id" = o."id";
	end if;
	if tg_op in ('INSERT', 'UPDATE') then
		insert into "court_hold_slots" ("court_id", "slot_start", "hold_id")
		select
			n."court_id",
			slot,
			n."id"
		from new_holds n
		cross join lateral generate_series(
			date_bin(interval '15 minutes', n."held_from", timestamptz '2000-01-01 00:00:00+00'),
			date_bin(interval '15 minutes', n."held_until" - interval '1 millisecond', timestamptz '2000-01-01 00:00:00+00'),
			interval '15 minutes'
		) as slot
		-- Ordered, so two transactions writing the same courts take the slot
		-- locks in the same order and one of them waits instead of both
		-- deadlocking. The caller sorts its VALUES list to match.
		order by n."court_id", slot;
	end if;
	return null;
end
$$;
--> statement-breakpoint
CREATE TRIGGER "court_holds_slots_ins" AFTER INSERT ON "court_holds" REFERENCING NEW TABLE AS new_holds FOR EACH STATEMENT EXECUTE FUNCTION "court_hold_slots_sync"();--> statement-breakpoint
CREATE TRIGGER "court_holds_slots_upd" AFTER UPDATE ON "court_holds" REFERENCING OLD TABLE AS old_holds NEW TABLE AS new_holds FOR EACH STATEMENT EXECUTE FUNCTION "court_hold_slots_sync"();--> statement-breakpoint
INSERT INTO "court_holds" ("id", "court_id", "kind", "tournament_id", "held_from", "held_until", "created_at", "updated_at")
SELECT
	'ch_' || substr(md5(random()::text || tc."id"), 1, 20),
	tc."court_id",
	'tournament',
	tc."tournament_id",
	(tc."day_key" || 'T00:00:00+05:30')::timestamptz,
	(tc."day_key" || 'T00:00:00+05:30')::timestamptz + interval '24 hours',
	tc."created_at",
	tc."created_at"
FROM "tournament_courts" tc
JOIN "tournaments" t ON t."id" = tc."tournament_id"
WHERE t."deleted_at" is null AND t."status" not in ('completed', 'archived');
--> statement-breakpoint
DO $$
DECLARE
	c record;
	ends timestamptz;
BEGIN
	-- One closure at a time, each in its own subtransaction. `court_closures`
	-- had no uniqueness of any kind, so two closures on one court in one
	-- afternoon are ordinary — and a single INSERT of both would collide on the
	-- slot index and abort the whole migration, which would leave the app
	-- unable to boot at all. A closure that cannot be placed is dropped; one
	-- that could never be seen by any screen is not worth a failed deploy.
	FOR c IN SELECT * FROM "court_closures" ORDER BY "from", "id" LOOP
		ends := coalesce(c."until", c."from" + interval '24 hours');
		CONTINUE WHEN ends <= c."from";
		BEGIN
			INSERT INTO "court_holds" ("id", "court_id", "kind", "reason", "held_from", "held_until", "created_at", "updated_at")
			VALUES (
				'ch_' || substr(md5(random()::text || c."id"), 1, 20),
				c."court_id",
				'block',
				coalesce(nullif(btrim(c."reason"), ''), 'Out of action'),
				c."from",
				ends,
				c."from",
				c."from"
			);
		EXCEPTION WHEN unique_violation THEN
			NULL;
		END;
	END LOOP;
END
$$;
--> statement-breakpoint
DROP TABLE "tournament_courts" CASCADE;--> statement-breakpoint
DROP TABLE "court_closures" CASCADE;
