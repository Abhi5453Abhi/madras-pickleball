CREATE TABLE "tournament_courts" (
	"id" text PRIMARY KEY NOT NULL,
	"tournament_id" text NOT NULL,
	"court_id" text NOT NULL,
	"day_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tournaments" ADD COLUMN "registration_closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tournament_courts" ADD CONSTRAINT "tournament_courts_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_courts" ADD CONSTRAINT "tournament_courts_court_id_courts_id_fk" FOREIGN KEY ("court_id") REFERENCES "public"."courts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tournament_courts_uq" ON "tournament_courts" USING btree ("tournament_id","court_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tournament_courts_day_uq" ON "tournament_courts" USING btree ("court_id","day_key");--> statement-breakpoint
CREATE INDEX "tournament_courts_tournament_idx" ON "tournament_courts" USING btree ("tournament_id");