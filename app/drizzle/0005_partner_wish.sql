ALTER TABLE "tournament_players" ADD COLUMN "source" text DEFAULT 'hand' NOT NULL;--> statement-breakpoint
ALTER TABLE "tournament_players" ADD COLUMN "partner_wish" text;--> statement-breakpoint
ALTER TABLE "tournament_players" ADD COLUMN "partner_player_id" text;