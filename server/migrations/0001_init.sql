-- Madras Pickleball — the v4 schema, written fresh for the Go server.
--
-- One venue, its courts, the organisers who hold a PIN, and tournaments that
-- are each exactly one category with their own courts. Everything the old
-- schema carried for court-QR scoring, umpires, disputes and rally-by-rally
-- scoring is gone: the organiser is the only scorer and a score is final the
-- moment it is saved.
--
-- Ids are text ("crt_…", "trn_…"): generated in Go, never sequences, so a row
-- can be made in a transaction without a round trip and referred to in a URL.

create table venues (
  id          text primary key,
  name        text not null,
  slug        text not null unique,
  timezone    text not null default 'Asia/Kolkata',
  created_at  timestamptz not null default now()
);

create table courts (
  id          text primary key,
  venue_id    text not null references venues(id) on delete cascade,
  name        text not null,
  sort_order  integer not null default 0,
  color_key   text not null default 'blue',
  active      boolean not null default true
);
create index courts_venue_idx on courts(venue_id, sort_order);

-- Organisers. The PIN is the whole credential: it identifies the person and
-- admits them, so two organisers can never hold the same PIN.
create table users (
  id               text primary key,
  name             text not null,
  username         text not null unique,
  role             text not null check (role in ('owner', 'organiser')),
  pin_hash         text,
  must_change_pin  boolean not null default true,
  active           boolean not null default true,
  last_login_at    timestamptz,
  created_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

create table sessions (
  id_hash      text primary key,
  user_id      text not null references users(id) on delete cascade,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index sessions_user_idx on sessions(user_id);

-- Every guarded attempt — a PIN try, a PIN change, a public sign-up — keyed
-- by what it is limited on (an IP hash, a user id, a token prefix).
create table attempts (
  id         text primary key,
  kind       text not null,
  key        text not null,
  succeeded  boolean not null default false,
  at         timestamptz not null default now()
);
create index attempts_kind_key_idx on attempts(kind, key, at);

-- The venue's roster: everyone who has ever played here.
create table players (
  id          text primary key,
  venue_id    text not null references venues(id) on delete cascade,
  name        text not null,
  name_key    text not null,
  phone       text,
  phone_key   text,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index players_venue_name_idx on players(venue_id, name_key);
create index players_venue_phone_idx on players(venue_id, phone_key) where phone_key is not null;

-- A tournament is one category (Men's Doubles, Mixed Doubles, Women's
-- Singles …) on one day, with its own courts, its own table and its own
-- winners. Its pool split and knockout shape are described by finals_stage
-- and derived from the team count at draw time.
create table tournaments (
  id                      text primary key,
  venue_id                text not null references venues(id) on delete cascade,
  name                    text not null,
  slug                    text not null unique,
  day                     date not null,
  gender                  text not null check (gender in ('mens', 'womens', 'mixed', 'any')),
  discipline              text not null check (discipline in ('singles', 'doubles')),
  finals_stage            text not null check (finals_stage in ('none', 'final_only', 'semis_and_final')),
  -- Best of 3 to 11 unless the organiser shortens a late-running day.
  best_of                 integer not null default 3 check (best_of in (1, 3)),
  points_to_win           integer not null default 11 check (points_to_win between 5 and 21),
  -- How many go through from each pool; set when the draw is made.
  advance_per_group       integer not null default 0,
  status                  text not null default 'setup' check (status in ('setup', 'live', 'completed')),
  registration_closed_at  timestamptz,
  draw_made_at            timestamptz,
  started_at              timestamptz,
  paused_at               timestamptz,
  pause_note              text,
  finished_at             timestamptz,
  winner_team_id          text,
  runner_up_team_id       text,
  -- The order the pairs were made in: the pool split and the last-resort
  -- dead-heat order both use it, so it is stored, not recomputed.
  seed_order              jsonb not null default '[]'::jsonb,
  -- Bumped by every write that changes what a screen shows; the public page
  -- and the live board poll it.
  version                 integer not null default 0,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz
);
create index tournaments_venue_day_idx on tournaments(venue_id, day) where deleted_at is null;

-- A court belongs to one tournament per day. Nothing else enforces the
-- "never lend a court" rule; this index does.
create table tournament_courts (
  tournament_id  text not null references tournaments(id) on delete cascade,
  court_id       text not null references courts(id) on delete cascade,
  day_key        text not null,
  created_at     timestamptz not null default now(),
  primary key (tournament_id, court_id)
);
create unique index tournament_courts_day_uq on tournament_courts(court_id, day_key);

-- The public sign-up link, one per tournament. Only the hash is stored; the
-- prefix lets an organiser match a printed link to a row.
create table registration_tokens (
  id             text primary key,
  tournament_id  text not null references tournaments(id) on delete cascade,
  token_hash     text not null unique,
  token_prefix   text not null,
  created_at     timestamptz not null default now(),
  revoked_at     timestamptz
);
create index registration_tokens_tournament_idx on registration_tokens(tournament_id);

-- Who is in. partner_wish is what they typed; partner_player_id is the
-- roster player it resolved to, or null.
create table tournament_players (
  id                 text primary key,
  tournament_id      text not null references tournaments(id) on delete cascade,
  player_id          text not null references players(id) on delete cascade,
  source             text not null default 'hand' check (source in ('link', 'hand')),
  partner_wish       text,
  partner_player_id  text references players(id) on delete set null,
  created_at         timestamptz not null default now(),
  unique (tournament_id, player_id)
);
create index tournament_players_player_idx on tournament_players(player_id);

-- A sign-up that looked like someone already on the list. The new roster row
-- exists (nobody is ever turned away); the organiser merges the two or keeps
-- both.
create table pending_registrations (
  id                 text primary key,
  tournament_id      text not null references tournaments(id) on delete cascade,
  player_id          text not null references players(id) on delete cascade,
  matched_player_id  text not null references players(id) on delete cascade,
  status             text not null default 'pending' check (status in ('pending', 'merged', 'kept')),
  created_at         timestamptz not null default now(),
  reviewed_at        timestamptz
);
create index pending_registrations_tournament_idx on pending_registrations(tournament_id, status);

-- Pools. A league is one group; eight teams or more are split into pools and
-- the finals are drawn across them.
create table groups (
  id             text primary key,
  tournament_id  text not null references tournaments(id) on delete cascade,
  name           text not null,
  advance_count  integer not null default 0,
  sort_order     integer not null default 0
);
create index groups_tournament_idx on groups(tournament_id, sort_order);

-- A pair (or, in singles, one player). name is "Ravi / Priya" as shown.
create table teams (
  id             text primary key,
  tournament_id  text not null references tournaments(id) on delete cascade,
  group_id       text references groups(id) on delete set null,
  name           text not null,
  seed           integer,
  status         text not null default 'active' check (status in ('active', 'withdrawn')),
  withdrawn_at   timestamptz,
  created_at     timestamptz not null default now()
);
create index teams_tournament_idx on teams(tournament_id);

create table team_players (
  team_id    text not null references teams(id) on delete cascade,
  player_id  text not null references players(id) on delete cascade,
  position   integer not null default 0,
  primary key (team_id, player_id)
);
create index team_players_player_idx on team_players(player_id);

-- Matches. source_a / source_b say where a knockout side comes from
-- ({"type":"group_rank","groupName":"A","rank":1} or
-- {"type":"winner_of","matchId":"…"}); league matches carry
-- {"type":"entry","teamId":"…"} and team ids from the start.
-- games is the whole score: [{"gameNo":1,"scoreA":11,"scoreB":7}, …].
create table matches (
  id              text primary key,
  tournament_id   text not null references tournaments(id) on delete cascade,
  stage           text not null check (stage in ('group', 'knockout')),
  group_id        text references groups(id) on delete set null,
  round_index     integer not null default 0,
  round_name      text,
  seq             integer not null default 0,
  team_a_id       text references teams(id) on delete set null,
  team_b_id       text references teams(id) on delete set null,
  source_a        jsonb not null default '{"type":"bye"}'::jsonb,
  source_b        jsonb not null default '{"type":"bye"}'::jsonb,
  court_id        text references courts(id) on delete set null,
  status          text not null default 'pending'
                  check (status in ('pending', 'ready', 'live', 'completed', 'cancelled')),
  result_state    text not null default 'none' check (result_state in ('none', 'final', 'voided')),
  result_type     text not null default 'normal'
                  check (result_type in ('normal', 'bye', 'walkover', 'retired', 'cancelled')),
  winner_team_id  text references teams(id) on delete set null,
  retired_team_id text references teams(id) on delete set null,
  games           jsonb not null default '[]'::jsonb,
  games_won_a     integer not null default 0,
  games_won_b     integer not null default 0,
  queue_position  integer,
  on_hold         boolean not null default false,
  started_at      timestamptz,
  ended_at        timestamptz,
  corrected_at    timestamptz,
  version         integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (winner_team_id is null or winner_team_id = team_a_id or winner_team_id = team_b_id)
);
create index matches_tournament_idx on matches(tournament_id, round_index, seq);
create index matches_tournament_status_idx on matches(tournament_id, status);
create index matches_court_idx on matches(court_id, status);
-- Two live matches on one court is impossible, not just unlikely.
create unique index matches_one_live_per_court on matches(court_id) where status = 'live' and court_id is not null;

-- What the organiser did and why; read by nobody most days and by everybody
-- the day a score is argued about.
create table audit_log (
  id          text primary key,
  user_id     text references users(id) on delete set null,
  action      text not null,
  entity      text not null,
  entity_id   text not null,
  reason      text,
  details     jsonb,
  at          timestamptz not null default now()
);
create index audit_log_entity_idx on audit_log(entity, entity_id, at);
