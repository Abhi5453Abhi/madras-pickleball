-- Which games a submission keeps out of point difference.
--
-- Settling a dispute replays a stored submission through the same ledger
-- writer. Without this the replay re-derived the exclusions from an
-- already-expanded list of games, found nothing left to expand, and marked
-- none of them excluded — so the 11-0 nobody played entered game difference
-- and point difference as the organiser's own resolution.
ALTER TABLE "result_submissions"
  ADD COLUMN IF NOT EXISTS "exclude_from_diff" jsonb DEFAULT '[]'::jsonb NOT NULL;
