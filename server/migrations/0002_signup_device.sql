-- The browser a public sign-up came from.
--
-- "Already on the list" is the same phone number, or the same name from the
-- same browser (docs/GO-API.ts, registration.submitRegistration). The first
-- half a phone number answers; the second half needs somewhere to remember
-- which browser sent a name, and nothing in 0001 could hold it — so a
-- reloaded form made a second row for the same person and the page said
-- "You're on the list" instead of "You're already on the list".
--
-- It is a per-browser id the form generates and keeps in localStorage,
-- deliberately not a cookie so the page stays cookie-free. It is never shown,
-- never returned by any RPC, and only the public form ever writes it.

alter table tournament_players add column device_id text;

create index tournament_players_device_idx
  on tournament_players (tournament_id, device_id) where device_id is not null;
