/**
 * Madras Pickleball — database schema.
 * Follows docs/SPEC.md; comments cite the section that motivates each decision.
 */
import { sql } from 'drizzle-orm'
import {
  pgTable,
  pgEnum,
  text,
  varchar,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  primaryKey,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core'

// ───────────────────────────── enums ─────────────────────────────

export const roleEnum = pgEnum('role', ['super_admin', 'admin', 'umpire'])

export const tournamentStatusEnum = pgEnum('tournament_status', [
  'draft',
  'registration',
  'live',
  'completed',
  'archived',
])

export const categoryStatusEnum = pgEnum('category_status', [
  'draft',
  'entries_open',
  'draw_locked',
  'live',
  'completed',
])

export const disciplineEnum = pgEnum('discipline', ['singles', 'doubles'])

/** "any" rather than "open" — in pickleball Open means the top skill division (SPEC A2). */
export const genderCategoryEnum = pgEnum('gender_category', ['mens', 'womens', 'mixed', 'any'])

export const genderEnum = pgEnum('gender', ['male', 'female', 'other'])

/** Shown as Strong / Regular / New; the number behind it is never displayed (SPEC A2). */
export const skillEnum = pgEnum('skill_level', ['new_player', 'regular', 'strong'])

export const teamModeEnum = pgEnum('team_mode', [
  'prebuilt',
  'random',
  'balanced',
  'self_registered',
])

/** League = one group, everyone plays everyone, optional finals stage (SPEC A3). */
export const drawTypeEnum = pgEnum('draw_type', [
  'league',
  'groups_knockout',
  'single_elim', // reserved for v1.1
  'americano', // reserved, SPEC Part C
])

export const finalsStageEnum = pgEnum('finals_stage', [
  'none',
  'final_only',
  'semis_and_final',
  'quarters_onward',
])

/**
 * Part A uses pending → ready → live → completed.
 * `called` and `warming_up` are reserved for the v1.1 calling board (SPEC A4).
 */
export const matchStatusEnum = pgEnum('match_status', [
  'pending',
  'ready',
  'called',
  'warming_up',
  'live',
  'completed',
  'cancelled',
])

/** `forfeit` is deliberately absent — merged into `walkover` (SPEC A5). */
export const resultTypeEnum = pgEnum('result_type', [
  'normal',
  'bye',
  'walkover',
  'retired',
  'cancelled',
])

/** Separate from match_status, which is the lifecycle (SPEC A9). */
export const resultStateEnum = pgEnum('result_state', [
  'none',
  'reported',
  'disputed',
  'final',
  'voided',
])

export const scoringTypeEnum = pgEnum('scoring_type', ['side_out', 'rally'])

/** Knockout semis onward default to `authenticated` (SPEC A1). */
export const scoringModeEnum = pgEnum('scoring_mode', ['open', 'authenticated'])

export const actorTypeEnum = pgEnum('actor_type', [
  'court_token',
  'umpire_pin',
  'user',
  'live_scoring',
])

export const submissionStatusEnum = pgEnum('submission_status', [
  'active',
  'superseded',
  'withdrawn',
])

export const confidenceEnum = pgEnum('confirmation_confidence', ['high', 'normal', 'low'])

export const teamStatusEnum = pgEnum('team_status', ['active', 'withdrawn', 'disqualified'])

export const registrationStatusEnum = pgEnum('registration_status', [
  'pending',
  'approved',
  'rejected',
])

export const tokenStatusEnum = pgEnum('token_status', ['active', 'revoked', 'expired'])

export const tokenKindEnum = pgEnum('token_kind', ['reset', 'recovery'])

export const matchEventTypeEnum = pgEnum('match_event_type', [
  'start',
  'rally',
  'side_out',
  'timeout',
  'undo',
  'state_override',
  'game_end',
  'match_end',
])

/**
 * The venue's stated rule is total-points-scored first (SPEC A6);
 * head_to_head_first is the per-category alternative.
 */
export const tiebreakRuleEnum = pgEnum('tiebreak_rule', [
  'points_scored_first',
  'head_to_head_first',
])

export const slotSourceEnum = pgEnum('slot_source', [
  'entry',
  'winner_of',
  'loser_of',
  'group_rank',
  'bye',
])

// ───────────────────────── people & access ─────────────────────────

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    username: text('username').notNull(),
    phone: text('phone'),
    passwordHash: text('password_hash').notNull(),
    /** Umpire PIN is a step-up on a court session, never a standalone credential (SPEC A9). */
    pinHash: text('pin_hash'),
    role: roleEnum('role').notNull(),
    active: boolean('active').notNull().default(true),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    pinFailedCount: integer('pin_failed_count').notNull().default(0),
    pinLockedUntil: timestamp('pin_locked_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('users_username_key').on(t.username),
    uniqueIndex('users_phone_key').on(t.phone).where(sql`phone is not null`),
    index('users_role_active_idx').on(t.role, t.active),
  ],
)

export const sessions = pgTable(
  'sessions',
  {
    /** SHA-256 of the raw token; the raw value never touches the database (SPEC A9). */
    idHash: text('id_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    userAgent: text('user_agent'),
    ipHash: text('ip_hash'),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expiry_idx').on(t.expiresAt)],
)

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    kind: tokenKindEnum('kind').notNull().default('reset'),
    /** Recovery codes have no expiry — SPEC A1's printed one-time code. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('reset_tokens_user_idx').on(t.userId)],
)

/** Account-level lockout, not IP — every umpire is behind one venue NAT (SPEC A9). */
export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    ipHash: text('ip_hash'),
    succeeded: boolean('succeeded').notNull().default(false),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('login_attempts_idx').on(t.identifier, t.at)],
)

// ─────────────────────────────  venue  ─────────────────────────────

export const venues = pgTable(
  'venues',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('venues_slug_key').on(t.slug)],
)

export const courts = pgTable(
  'courts',
  {
    id: text('id').primaryKey(),
    venueId: text('venue_id')
      .notNull()
      .references(() => venues.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** `order` is a SQL reserved word (SPEC A9). */
    sortOrder: integer('sort_order').notNull().default(0),
    /** Card colour, so a misplaced court card is visible from a distance (SPEC A5). */
    colorKey: text('color_key').notNull().default('blue'),
    active: boolean('active').notNull().default(true),
  },
  (t) => [
    uniqueIndex('courts_venue_name_key').on(t.venueId, t.name),
    index('courts_venue_order_idx').on(t.venueId, t.sortOrder),
  ],
)

export const courtHoldKindEnum = pgEnum('court_hold_kind', ['tournament', 'session', 'block'])

/**
 * Who has a court, and between which two instants.
 *
 * This is the only record of court occupancy, and both tournaments and daily
 * sessions write to it. It replaced `tournament_courts (court_id, day_key)`,
 * which could only say "all of Tuesday" — so a 7pm social could not have a
 * court on a tournament day, and a two-day tournament silently lost its courts
 * on day two.
 *
 * Exactly one holder, by CHECK: a tournament, a session, or nobody at all,
 * which is a block — coaching, maintenance, a private booking, a broken net.
 * A block is venue-wide on purpose; a court with a broken net is broken for
 * everybody.
 *
 * The no-two-holders guarantee is NOT here. It is `court_hold_slots` below.
 */
export const courtHolds = pgTable(
  'court_holds',
  {
    id: text('id').primaryKey(),
    courtId: text('court_id')
      .notNull()
      .references(() => courts.id, { onDelete: 'cascade' }),
    kind: courtHoldKindEnum('kind').notNull(),
    tournamentId: text('tournament_id').references(() => tournaments.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => gameSessions.id, { onDelete: 'cascade' }),
    /** Required for a block, and the whole of what a block is. */
    reason: text('reason'),
    heldFrom: timestamp('held_from', { withTimezone: true }).notNull(),
    heldUntil: timestamp('held_until', { withTimezone: true }).notNull(),
    /**
     * When a holder finished early and the court went back to the venue. The
     * row is kept for the audit trail; `held_until` is what was truncated, so
     * the slots are already gone and nothing reads this to decide occupancy.
     */
    releasedAt: timestamp('released_at', { withTimezone: true }),
    createdByUserId: text('created_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('court_holds_court_from_idx').on(t.courtId, t.heldFrom),
    index('court_holds_tournament_idx').on(t.tournamentId).where(sql`tournament_id is not null`),
    index('court_holds_session_idx').on(t.sessionId).where(sql`session_id is not null`),
    index('court_holds_window_idx').on(t.heldFrom, t.heldUntil),
    check('court_holds_span', sql`held_until > held_from`),
    check(
      'court_holds_holder',
      sql`(kind = 'tournament' and tournament_id is not null and session_id is null) or (kind = 'session' and session_id is not null and tournament_id is null) or (kind = 'block' and tournament_id is null and session_id is null)`,
    ),
    check('court_holds_block_reason', sql`kind <> 'block' or (reason is not null and btrim(reason) <> '')`),
  ],
)

/**
 * The interlock. One row per court per quarter hour, primary key
 * `(court_id, slot_start)` — so two holds that overlap by one minute collide
 * on a real index and the second one is refused by Postgres, not by a check
 * somebody might forget to write.
 *
 * These rows are NOT written by application code. A trigger on `court_holds`
 * materialises them (migration 0007, `court_hold_slots_sync`), with the
 * boundaries rounded outward to the quarter hour, so every write path gets the
 * guarantee whether or not its author knew about it. Rounding outward can only
 * ever over-reserve — a hold that ends at 19:05 keeps the court until 19:15 —
 * which is the safe direction.
 *
 * The trigger is statement level, with transition tables, deliberately: one
 * statement that moves several holds at once must free every old slot before it
 * claims any new one, or a hold shifted by an hour collides with the one behind
 * it and raises on an overlap that does not exist.
 *
 * The alternative was `EXCLUDE USING gist (court_id WITH =, tstzrange(...) WITH &&)`,
 * which needs `btree_gist`. That extension is fine on Neon and is NOT available
 * in PGlite, and the whole migration file runs in one transaction, so adding it
 * would brick the embedded database that `npm run dev` and every test use.
 * A quarter-hour grid is the price of that; a 14-hour tournament day is 56 rows.
 */
export const courtHoldSlots = pgTable(
  'court_hold_slots',
  {
    courtId: text('court_id')
      .notNull()
      .references(() => courts.id, { onDelete: 'cascade' }),
    slotStart: timestamp('slot_start', { withTimezone: true }).notNull(),
    holdId: text('hold_id')
      .notNull()
      .references(() => courtHolds.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.courtId, t.slotStart] }),
    index('court_hold_slots_hold_idx').on(t.holdId),
  ],
)

// ──────────────────────────  club roster  ──────────────────────────

export const players = pgTable(
  'players',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** Lowercased, punctuation-stripped: the fuzzy-duplicate basis (SPEC A2). */
    nameKey: text('name_key').notNull(),
    gender: genderEnum('gender'),
    /** Admin-only; never rendered on a public or scorer screen (SPEC A2/D2). */
    phone: text('phone'),
    /** E.164 — the strong dedupe key where present (SPEC A2). */
    phoneKey: text('phone_key'),
    skill: skillEnum('skill'),
    /** Captured now though DUPR sync is parked — re-keying later is the expensive part. */
    duprId: text('dupr_id'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('players_phone_key_uq').on(t.phoneKey).where(sql`phone_key is not null`),
    index('players_name_key_idx').on(t.nameKey),
  ],
)

// ───────────────────────────  tournament  ───────────────────────────

export const tournaments = pgTable(
  'tournaments',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    venueId: text('venue_id')
      .notNull()
      .references(() => venues.id),
    startDate: timestamp('start_date', { withTimezone: true }).notNull(),
    endDate: timestamp('end_date', { withTimezone: true }).notNull(),
    /**
     * The hours its courts are held for, each day it runs, as minutes from the
     * start of the venue day. Null is the whole day, which is what every
     * tournament held before it could hold part of one.
     *
     * Stored rather than derived from the holds: a hold that was taken up at
     * eleven, or truncated when the day finished, says nothing about the hours
     * the organiser asked for, and reading it back as if it did quietly moved
     * every other day of a two-day tournament.
     */
    courtFromMin: integer('court_from_min'),
    courtUntilMin: integer('court_until_min'),
    status: tournamentStatusEnum('status').notNull().default('draft'),
    description: text('description'),
    bannerUrl: text('banner_url'),
    /** Store UTC, render Asia/Kolkata; never use the server's date for "today" (SPEC A9). */
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    /**
     * Single monotonic counter, bumped in the same transaction as any board-visible
     * write. Replaces max(updated_at) polling (SPEC A9).
     */
    streamVersion: bigint('stream_version', { mode: 'number' }).notNull().default(0),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    pauseNote: text('pause_note'),
    breakStartsAt: timestamp('break_starts_at', { withTimezone: true }),
    breakEndsAt: timestamp('break_ends_at', { withTimezone: true }),
    /** Feeds the finish-vs-sunset line in the format picker (SPEC A3). */
    sunsetAt: timestamp('sunset_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /**
     * Set when the organiser closes sign-ups. The public link stops taking
     * names; the organiser can still add and remove people by hand.
     */
    registrationClosedAt: timestamp('registration_closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('tournaments_slug_key').on(t.slug),
    index('tournaments_status_idx').on(t.status, t.startDate),
    check(
      'tournaments_court_hours',
      sql`(court_from_min is null) = (court_until_min is null) and (court_from_min is null or (court_from_min >= 0 and court_until_min > court_from_min and court_until_min <= 1440))`,
    ),
  ],
)

export const tournamentPlayers = pgTable(
  'tournament_players',
  {
    id: text('id').primaryKey(),
    tournamentId: text('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    /** Snapshot, so editing the roster later doesn't shift historical seeding (SPEC A2). */
    skillSnapshot: skillEnum('skill_snapshot'),
    paid: boolean('paid').notNull().default(false),
    paidNote: text('paid_note'),
    withdrawn: boolean('withdrawn').notNull().default(false),
    /** 'link' when they signed themselves up, 'hand' when the organiser added them (SPEC v4). */
    source: text('source').notNull().default('hand'),
    /** Who they asked to play with, as typed; resolved to a roster player where one matches. */
    partnerWish: text('partner_wish'),
    partnerPlayerId: text('partner_player_id'),
    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('tournament_players_uq').on(t.tournamentId, t.playerId),
    index('tournament_players_idx').on(t.tournamentId),
  ],
)

// ── player self-registration: a form, not an account (SPEC A2) ──

export const registrationTokens = pgTable(
  'registration_tokens',
  {
    id: text('id').primaryKey(),
    tournamentId: text('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    tokenPrefix: text('token_prefix').notNull(),
    status: tokenStatusEnum('status').notNull().default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    useCount: integer('use_count').notNull().default(0),
  },
  (t) => [
    index('registration_tokens_idx').on(t.tournamentId, t.status),
    uniqueIndex('registration_tokens_active_uq')
      .on(t.tournamentId)
      .where(sql`status = 'active'`),
  ],
)

export const pendingRegistrations = pgTable(
  'pending_registrations',
  {
    id: text('id').primaryKey(),
    tournamentId: text('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    nameKey: text('name_key').notNull(),
    phone: text('phone'),
    gender: genderEnum('gender'),
    skill: skillEnum('skill'),
    categoryIds: jsonb('category_ids').$type<string[]>().notNull().default([]),
    /** Free-typed partner name, and/or the pending registration they named. */
    partnerName: text('partner_name'),
    partnerNameKey: text('partner_name_key'),
    partnerRegistrationId: text('partner_registration_id'),
    status: registrationStatusEnum('status').notNull().default('pending'),
    mergedPlayerId: text('merged_player_id'),
    deviceId: text('device_id'),
    ipHash: text('ip_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNote: text('review_note'),
  },
  (t) => [
    index('pending_regs_status_idx').on(t.tournamentId, t.status),
    index('pending_regs_name_idx').on(t.tournamentId, t.nameKey),
  ],
)

// ────────────────────────────  category  ────────────────────────────

/** Called "Event" in the first draft; renamed — in a club the event is Sunday (SPEC A2). */
export const categories = pgTable(
  'categories',
  {
    id: text('id').primaryKey(),
    tournamentId: text('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    discipline: disciplineEnum('discipline').notNull(),
    gender: genderCategoryEnum('gender').notNull(),
    teamMode: teamModeEnum('team_mode').notNull().default('prebuilt'),
    drawType: drawTypeEnum('draw_type').notNull().default('league'),
    finalsStage: finalsStageEnum('finals_stage').notNull().default('final_only'),
    status: categoryStatusEnum('status').notNull().default('draft'),
    seq: integer('seq').notNull().default(0),

    // scoring defaults; rounds and matches can override (SPEC A5)
    bestOf: integer('best_of').notNull().default(3),
    pointsToWin: integer('points_to_win').notNull().default(11),
    winBy: integer('win_by').notNull().default(2),
    /** Null = no cap. At the cap the next point wins, win-by-1 (SPEC A5). */
    hardCap: integer('hard_cap'),
    scoringType: scoringTypeEnum('scoring_type').notNull().default('side_out'),
    timeoutsPerGame: integer('timeouts_per_game').notNull().default(2),

    tiebreakRule: tiebreakRuleEnum('tiebreak_rule').notNull().default('points_scored_first'),

    /** Knockout matches from this round index on need an umpire PIN or admin (SPEC A1). */
    authenticatedFromRound: integer('authenticated_from_round'),

    groupCount: integer('group_count').notNull().default(1),
    advancePerGroup: integer('advance_per_group').notNull().default(2),

    /** Reproducibility for random pairing and unseeded placement (SPEC A2). */
    rngSeed: text('rng_seed'),
    seedOrder: jsonb('seed_order').$type<string[]>().notNull().default([]),

    drawVersion: integer('draw_version').notNull().default(0),
    revisionNote: text('revision_note'),
    drawLockedAt: timestamp('draw_locked_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),

    winnerTeamId: text('winner_team_id'),
    runnerUpTeamId: text('runner_up_team_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('categories_tournament_idx').on(t.tournamentId, t.seq)],
)

/** "Pools at one game to 15, knockouts at best-of-3 to 11" needs a round level (SPEC A5). */
export const categoryRoundRules = pgTable(
  'category_round_rules',
  {
    id: text('id').primaryKey(),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    stage: text('stage').notNull(),
    roundIndex: integer('round_index').notNull(),
    rules: jsonb('rules').notNull(),
  },
  (t) => [uniqueIndex('category_round_rules_uq').on(t.categoryId, t.roundIndex)],
)

export const categoryPlayers = pgTable(
  'category_players',
  {
    id: text('id').primaryKey(),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    /** Odd numbers go here rather than being dropped (SPEC A2). */
    substitute: boolean('substitute').notNull().default(false),
    /** Set when the player named a partner at self-registration. */
    requestedPartnerId: text('requested_partner_id'),
  },
  (t) => [uniqueIndex('category_players_uq').on(t.categoryId, t.playerId)],
)

export const groups = pgTable(
  'groups',
  {
    id: text('id').primaryKey(),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    advanceCount: integer('advance_count').notNull().default(2),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [uniqueIndex('groups_category_name_uq').on(t.categoryId, t.name)],
)

export const teams = pgTable(
  'teams',
  {
    id: text('id').primaryKey(),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    groupId: text('group_id').references(() => groups.id),
    /** Auto-generated "Ravi / Priya"; never asked for (SPEC A2). */
    name: text('name').notNull(),
    seed: integer('seed'),
    status: teamStatusEnum('status').notNull().default('active'),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    /** Withdrawal before half the pool matches voids results; after, they walk over (SPEC A7). */
    voidResults: boolean('void_results').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('teams_category_name_uq').on(t.categoryId, t.name),
    uniqueIndex('teams_category_seed_uq').on(t.categoryId, t.seed).where(sql`seed is not null`),
    index('teams_category_group_idx').on(t.categoryId, t.groupId),
  ],
)

export const teamPlayers = pgTable(
  'team_players',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.playerId] }),
    index('team_players_player_idx').on(t.playerId),
  ],
)

/** Swapping a partner must not silently rewrite history (SPEC A7). */
export const teamPlayerChanges = pgTable(
  'team_player_changes',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    outPlayerId: text('out_player_id'),
    inPlayerId: text('in_player_id'),
    reason: text('reason').notNull(),
    byUserId: text('by_user_id'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('team_player_changes_idx').on(t.teamId, t.at)],
)

// ─────────────────────────────  matches  ─────────────────────────────

export const matches = pgTable(
  'matches',
  {
    id: text('id').primaryKey(),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    /** Denormalised: every public query is tournament-scoped (SPEC A9). */
    tournamentId: text('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),

    stage: text('stage').notNull().default('group'),
    roundIndex: integer('round_index').notNull().default(0),
    roundName: text('round_name'),
    seq: integer('seq').notNull().default(0),
    groupId: text('group_id').references(() => groups.id),

    teamAId: text('team_a_id').references(() => teams.id),
    teamBId: text('team_b_id').references(() => teams.id),

    courtId: text('court_id').references(() => courts.id),

    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    /** Per-category "don't start before", so pools don't all end at once (v1.1). */
    notBefore: timestamp('not_before', { withTimezone: true }),
    calledAt: timestamp('called_at', { withTimezone: true }),
    warmupStartedAt: timestamp('warmup_started_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),

    status: matchStatusEnum('status').notNull().default('pending'),
    resultState: resultStateEnum('result_state').notNull().default('none'),
    resultType: resultTypeEnum('result_type').notNull().default('normal'),

    umpireId: text('umpire_id').references(() => users.id),

    winnerTeamId: text('winner_team_id').references(() => teams.id),
    retiredTeamId: text('retired_team_id').references(() => teams.id),

    scoringMode: scoringModeEnum('scoring_mode').notNull().default('open'),
    rulesOverride: jsonb('rules_override'),

    // denormalised aggregates, written in exactly one place (SPEC A9)
    gamesWonA: integer('games_won_a').notNull().default(0),
    gamesWonB: integer('games_won_b').notNull().default(0),
    scoreSummary: jsonb('score_summary'),
    /** Cache of the derived provisional state; never read for display (SPEC A5). */
    provisional: boolean('provisional').notNull().default(false),

    reportedAt: timestamp('reported_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedVia: text('confirmed_via'),
    disputeOpenedAt: timestamp('dispute_opened_at', { withTimezone: true }),
    disputeResolvedAt: timestamp('dispute_resolved_at', { withTimezone: true }),
    correctedAt: timestamp('corrected_at', { withTimezone: true }),
    correctionCount: integer('correction_count').notNull().default(0),
    lockedAt: timestamp('locked_at', { withTimezone: true }),

    queuePosition: integer('queue_position'),
    onHold: boolean('on_hold').notNull().default(false),

    /** Optimistic lock; every write sends expected_version (SPEC A1). */
    version: integer('version').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** Makes double-booking a court structurally impossible (SPEC A9). */
    uniqueIndex('matches_one_live_per_court')
      .on(t.courtId)
      .where(sql`status = 'live' and court_id is not null`),
    check(
      'matches_winner_is_a_participant',
      sql`winner_team_id is null or winner_team_id = team_a_id or winner_team_id = team_b_id`,
    ),
    index('matches_stream_idx').on(t.tournamentId, t.updatedAt),
    index('matches_tournament_status_idx').on(t.tournamentId, t.status),
    /**
     * The poll endpoint runs `where tournament_id = ? and result_state = 'reported'`
     * every few seconds on forty phones — the single most-executed query in the
     * app, and the only one that had no index of its own.
     */
    index('matches_tournament_result_idx').on(t.tournamentId, t.resultState),
    index('matches_category_round_idx').on(t.categoryId, t.roundIndex, t.seq),
    index('matches_umpire_idx').on(t.umpireId, t.status),
    index('matches_court_idx').on(t.courtId, t.status),
  ],
)

/**
 * Replaces next_match_id: the only shape that can express "winner of Group A"
 * as well as winner_of / loser_of edges (SPEC A9).
 */
export const matchSlots = pgTable(
  'match_slots',
  {
    id: text('id').primaryKey(),
    matchId: text('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    slot: varchar('slot', { length: 1 }).notNull(), // 'A' | 'B'
    sourceType: slotSourceEnum('source_type').notNull(),
    sourceMatchId: text('source_match_id'),
    sourceGroupId: text('source_group_id').references(() => groups.id),
    sourceRank: integer('source_rank'),
    resolvedTeamId: text('resolved_team_id').references(() => teams.id),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('match_slots_uq').on(t.matchId, t.slot),
    index('match_slots_source_match_idx').on(t.sourceMatchId),
    index('match_slots_source_group_idx').on(t.sourceGroupId),
  ],
)

export const games = pgTable(
  'games',
  {
    id: text('id').primaryKey(),
    matchId: text('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    gameNo: integer('game_no').notNull(),
    scoreA: integer('score_a').notNull().default(0),
    scoreB: integer('score_b').notNull().default(0),
    completed: boolean('completed').notNull().default(false),
    winnerTeamId: text('winner_team_id'),
    /** A reported result writes a provisional ledger row (SPEC A5). */
    provisional: boolean('provisional').notNull().default(true),
    /** Excluded from the point-difference column (SPEC A5/A6). */
    timeCapped: boolean('time_capped').notNull().default(false),
    excludeFromDiff: boolean('exclude_from_diff').notNull().default(false),

    // rally-scoring state, populated in v1.1 (SPEC Part B)
    serverTeamId: text('server_team_id'),
    serverNumber: integer('server_number'),
    teamAStartRightPlayerId: text('team_a_start_right_player_id'),
    teamBStartRightPlayerId: text('team_b_start_right_player_id'),
    timeoutsA: integer('timeouts_a').notNull().default(0),
    timeoutsB: integer('timeouts_b').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('games_match_no_uq').on(t.matchId, t.gameNo)],
)

/** Append-only; state_after makes undo O(1) instead of replaying a fold (SPEC A9). */
export const matchEvents = pgTable(
  'match_events',
  {
    id: text('id').primaryKey(),
    matchId: text('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: matchEventTypeEnum('type').notNull(),
    payload: jsonb('payload'),
    stateAfter: jsonb('state_after'),
    clientEventId: text('client_event_id'),
    deviceId: text('device_id'),
    clientSeq: integer('client_seq'),
    clientAt: timestamp('client_at', { withTimezone: true }),
    undoesEventId: text('undoes_event_id'),
    voidedByEventId: text('voided_by_event_id'),
    byUserId: text('by_user_id'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('match_events_seq_uq').on(t.matchId, t.seq),
    uniqueIndex('match_events_client_uq')
      .on(t.matchId, t.clientEventId)
      .where(sql`client_event_id is not null`),
    index('match_events_idx').on(t.matchId, t.at),
  ],
)

// ──────────────────────────  result inbox  ──────────────────────────

/** The inbox. `games` is the ledger; only a confirmation clears provisional (SPEC A9). */
export const resultSubmissions = pgTable(
  'result_submissions',
  {
    id: text('id').primaryKey(),
    matchId: text('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    /** user:<id> | umpire:<id> | token:<court>:dev:<device> — computed server-side (SPEC A5). */
    attributorKey: text('attributor_key').notNull(),
    actorType: actorTypeEnum('actor_type').notNull(),
    courtSessionId: text('court_session_id'),
    userId: text('user_id').references(() => users.id),
    umpireId: text('umpire_id'),
    deviceId: text('device_id'),
    ipHash: text('ip_hash'),
    submittingTeamId: text('submitting_team_id').references(() => teams.id),
    games: jsonb('games').notNull(),
    /**
     * Which of those games sit out of point difference — worked out on the
     * server, stored here so that settling a dispute by replaying a submission
     * writes the same ledger the original did rather than quietly counting the
     * games nobody played (SPEC A6).
     */
    excludeFromDiff: jsonb('exclude_from_diff').$type<number[]>().notNull().default([]),
    resultType: resultTypeEnum('result_type').notNull().default('normal'),
    retiredTeamId: text('retired_team_id'),
    winnerTeamId: text('winner_team_id'),
    /** sha256(resultType | winner | games sorted) — agreement is one string compare (SPEC A9). */
    normalizedDigest: text('normalized_digest').notNull(),
    clientEventId: text('client_event_id').notNull(),
    status: submissionStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('result_submissions_client_uq').on(t.matchId, t.clientEventId),
    /** One live submission per source — a DB constraint, not app logic (SPEC A9). */
    uniqueIndex('result_submissions_attributor_uq')
      .on(t.matchId, t.attributorKey)
      .where(sql`status = 'active'`),
    index('result_submissions_idx').on(t.matchId, t.status),
  ],
)

/** A confirmation is not a submission — the hand-the-phone path is one device (SPEC A5). */
export const matchConfirmations = pgTable(
  'match_confirmations',
  {
    id: text('id').primaryKey(),
    matchId: text('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    submissionId: text('submission_id')
      .notNull()
      .references(() => resultSubmissions.id, { onDelete: 'cascade' }),
    attributorKey: text('attributor_key').notNull(),
    agreedForTeamId: text('agreed_for_team_id').references(() => teams.id),
    digest: text('digest').notNull(),
    confidence: confidenceEnum('confidence').notNull().default('normal'),
    deviceId: text('device_id'),
    ipHash: text('ip_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('match_confirmations_idx').on(t.matchId)],
)

/** "Result recorded — not right?" — forty phones as the verification layer (SPEC A5). */
export const resultFlags = pgTable(
  'result_flags',
  {
    id: text('id').primaryKey(),
    matchId: text('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    playerId: text('player_id').references(() => players.id),
    deviceId: text('device_id').notNull(),
    note: text('note'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** One flag per device per match (SPEC A5). */
    uniqueIndex('result_flags_device_uq').on(t.matchId, t.deviceId),
    index('result_flags_open_idx').on(t.matchId, t.resolvedAt),
  ],
)

/** A late submission is never silently discarded (SPEC A7). */
export const syncConflicts = pgTable(
  'sync_conflicts',
  {
    id: text('id').primaryKey(),
    matchId: text('match_id').notNull(),
    deviceId: text('device_id'),
    payload: jsonb('payload').notNull(),
    reason: text('reason').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [index('sync_conflicts_idx').on(t.matchId, t.at)],
)

// ───────────────────────────  court access  ───────────────────────────

export const courtTokens = pgTable(
  'court_tokens',
  {
    id: text('id').primaryKey(),
    tournamentId: text('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    courtId: text('court_id')
      .notNull()
      .references(() => courts.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    /** Printed on the card so an admin can match a card to a row (SPEC A1). */
    tokenPrefix: text('token_prefix').notNull(),
    label: text('label'),
    status: tokenStatusEnum('status').notNull().default('active'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    rotatedFromId: text('rotated_from_id'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    useCount: integer('use_count').notNull().default(0),
  },
  (t) => [
    uniqueIndex('court_tokens_active_uq')
      .on(t.tournamentId, t.courtId)
      .where(sql`status = 'active'`),
    index('court_tokens_idx').on(t.tournamentId, t.status),
  ],
)

export const courtSessions = pgTable(
  'court_sessions',
  {
    idHash: text('id_hash').primaryKey(),
    courtTokenId: text('court_token_id')
      .notNull()
      .references(() => courtTokens.id, { onDelete: 'cascade' }),
    deviceId: text('device_id').notNull(),
    /** Set after a successful umpire PIN step-up (SPEC A9). */
    umpireUserId: text('umpire_user_id').references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),
  },
  (t) => [index('court_sessions_token_idx').on(t.courtTokenId)],
)

/** Keeps a scorer's phone working when the admin moves a live match (SPEC A7). */
export const matchScoringGrants = pgTable(
  'match_scoring_grants',
  {
    id: text('id').primaryKey(),
    matchId: text('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    courtSessionId: text('court_session_id')
      .notNull()
      .references(() => courtSessions.idHash, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('match_scoring_grants_idx').on(t.matchId, t.expiresAt)],
)

/** Failed token resolutions are rate-limited per IP; successes are not (SPEC A1). */
export const tokenAttempts = pgTable(
  'token_attempts',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    prefix: text('prefix'),
    ipHash: text('ip_hash'),
    succeeded: boolean('succeeded').notNull().default(false),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('token_attempts_ip_idx').on(t.ipHash, t.at),
    index('token_attempts_at_idx').on(t.at),
    /**
     * The rate-limit gate in front of every QR scan counts the last hour of
     * FAILURES. A whole tournament day of successful scans lives in this table
     * too, and the plain index on `at` made the gate walk all of them: 7,431
     * buffers to find three hundred rows. Partial, it is five.
     */
    index('token_attempts_failed_idx').on(t.at).where(sql`succeeded = false`),
  ],
)

// ──────────────────────────────  audit  ──────────────────────────────

export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id),
    /** Snapshot, so deleting a user doesn't erase who did what. */
    actorLabel: text('actor_label').notNull(),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    reason: text('reason'),
    before: jsonb('before'),
    after: jsonb('after'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_entity_idx').on(t.entity, t.entityId, t.at), index('audit_at_idx').on(t.at)],
)

// ═══════════════════════════ daily games ═══════════════════════════
//
// Open-play sessions: the host hosts, players join with a name and a phone and
// no login, they play, and the money follows afterwards. Sessions are their own
// aggregate rather than a tournament wearing a `kind` column — docs/ADR-daily-games.md
// decision 1 has the argument, including what that costs in stage 7.
//
// Money is integer paise here and everywhere downstream. There is no float in
// this feature at any stage (SPEC-v4 §4, "Money is integer paise").

/** Open play is the drop-in Tuesday; booked is a court hired by a known group. */
export const sessionKindEnum = pgEnum('session_kind', ['open_play', 'booked'])

/**
 * `locked` is the point attendance stops being editable — the moment stage 3
 * hangs charge creation off. `cancelled` and `locked` are terminal.
 */
export const sessionStatusEnum = pgEnum('session_status', [
  'draft',
  'open',
  'live',
  'ended',
  'locked',
  'cancelled',
])

/**
 * SPEC-v4 §5, Participation. `absent` produces no session charge — they did not
 * play, so they do not owe the session fee; an optional no-show fee is a separate
 * policy charge in stage 3 and never this state wearing a different label.
 */
export const participationStateEnum = pgEnum('participation_state', [
  'joined',
  'confirmed',
  'waitlisted',
  'withdrawn',
  'checked_in',
  'played',
  'absent',
])

/** Who put them on the list. A third of people always reply in the group instead. */
export const participationSourceEnum = pgEnum('participation_source', ['self', 'host'])

export const gameSessions = pgTable(
  'game_sessions',
  {
    id: text('id').primaryKey(),
    venueId: text('venue_id')
      .notNull()
      .references(() => venues.id, { onDelete: 'cascade' }),
    /** Public URL is /g/<slug>; a separate namespace from tournaments' /t/<slug>. */
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    kind: sessionKindEnum('kind').notNull().default('open_play'),
    status: sessionStatusEnum('status').notNull().default('draft'),

    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),

    /** Integer paise. No float touches money at any stage. */
    pricePaise: integer('price_paise').notNull().default(0),
    currency: text('currency').notNull().default('INR'),

    /** Soft: 16 is comfortable, 18 is fine, and "open 4 more" is one tap (s1c). */
    capacity: integer('capacity').notNull().default(16),
    /** Display only until stage 2 gives sessions real court holds. */
    courtCount: integer('court_count').notNull().default(1),

    /**
     * The gate is per session and defaults on. A host who never told anyone can
     * turn it off rather than have sixteen people silently withdrawn — in stage 1
     * the host is the only delivery channel there is (ADR 6d).
     */
    confirmationGate: boolean('confirmation_gate').notNull().default(true),

    /**
     * Resolved boundaries, written when the session is created or rescheduled.
     * Stored rather than recomputed so a transition is still explainable months
     * later and so `planSession` can stay a pure function of this row.
     */
    confirmOpensAt: timestamp('confirm_opens_at', { withTimezone: true }),
    confirmDeadlineAt: timestamp('confirm_deadline_at', { withTimezone: true }),
    autoEndAt: timestamp('auto_end_at', { withTimezone: true }),
    lockAt: timestamp('lock_at', { withTimezone: true }),
    /** Which policy produced those boundaries. */
    policyVersion: integer('policy_version').notNull().default(1),

    notes: text('notes'),

    publishedAt: timestamp('published_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedByUserId: text('ended_by_user_id').references(() => users.id),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    createdByUserId: text('created_by_user_id').references(() => users.id),

    /** Bumped in the same transaction as any visible write; drives the poll route. */
    streamVersion: bigint('stream_version', { mode: 'number' }).notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('game_sessions_slug_key').on(t.slug),
    index('game_sessions_venue_start_idx').on(t.venueId, t.startsAt),
    index('game_sessions_status_start_idx').on(t.status, t.startsAt),
    check('game_sessions_span', sql`ends_at > starts_at`),
    check('game_sessions_price_nonneg', sql`price_paise >= 0`),
    check('game_sessions_inr', sql`currency = 'INR'`),
    check('game_sessions_capacity', sql`capacity >= 1 and capacity <= 200`),
    check('game_sessions_courts', sql`court_count >= 0 and court_count <= 50`),
    check(
      'game_sessions_gate_order',
      sql`confirm_opens_at is null or confirm_deadline_at is null or confirm_opens_at <= confirm_deadline_at`,
    ),
  ],
)

export const sessionParticipants = pgTable(
  'session_participants',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => gameSessions.id, { onDelete: 'cascade' }),
    /**
     * Deliberately NOT `on delete cascade`. `mergePlayers` hard-deletes a player
     * it believes is an orphan (registration.ts:853); a cascade here would take
     * someone's whole attendance history with it. No action turns that into an
     * error, and the merge itself now refuses — ADR 8b.
     */
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    /**
     * Who owes for this spot. Equal to `player_id` for everyone except a guest,
     * whose payer defaults to the inviter. Keeping the two apart is what stops a
     * guest's game landing in the inviter's attendance history (s1k).
     *
     * INVARIANT: attendance, history and stats key on `player_id`, never on this.
     */
    payerPlayerId: text('payer_player_id')
      .notNull()
      .references(() => players.id),
    invitedByPlayerId: text('invited_by_player_id').references(() => players.id),

    state: participationStateEnum('state').notNull().default('joined'),

    /** Arrival order within the session. Never changes; the waitlist is FIFO on it. */
    seq: integer('seq').notNull(),
    /**
     * Which of the capacity seats this participation holds, 1-based. Null while
     * waitlisted or withdrawn. `session_participants_seat_uq` is what actually
     * stops two people taking the sixteenth seat — not a lock anyone has to
     * remember to take (ADR 5).
     */
    seatNo: integer('seat_no'),

    isGuest: boolean('is_guest').notNull().default(false),
    source: participationSourceEnum('source').notNull().default('self'),

    /**
     * What this one person pays for this one night, when it is not the game's
     * price — a coach who is not charged, a first-timer at half price, a
     * regular the host is squaring up with some other way (m5).
     *
     * On the participation and not on the player, deliberately: "a coach who
     * turns up on Sunday to play should pay" (SPEC-v4 §10, m5). A permanent
     * exemption on a player row is the thing this is not.
     *
     * The note is required alongside it, because a ₹0 charge with no reason is
     * indistinguishable in the ledger from a billing bug.
     */
    priceOverridePaise: integer('price_override_paise'),
    priceNote: text('price_note'),

    /** Name as given, snapshotted, so a later rename doesn't rewrite the night. */
    displayName: text('display_name').notNull(),
    /** Some people don't want their Tuesday evenings advertised (SPEC-v4 §8). */
    hideFromPublic: boolean('hide_from_public').notNull().default(false),

    /**
     * The capability that lets a phone with no login confirm or cancel its own
     * spot: 160 random bits, in the URL at /s/<token>.
     *
     * Stored as it is, and not hashed — which is a deliberate departure from
     * every other token in this schema, so it needs its reason written down.
     * In stage 1 the host IS the delivery channel: the Tonight screen puts a
     * one-tap WhatsApp link beside anybody who has not confirmed, and it cannot
     * do that from a digest. Hashing would also make the link unrecoverable for
     * a player whose phone cleared its storage, with no way to send them a new
     * one. What it would buy is small: unlike a session token this authorises
     * nothing but confirming or giving up one spot in one game, and an attacker
     * who can read this table already has every name and phone number in it.
     *
     * It is rotatable (unlike a value derived from the row id), and stage 5
     * replaces it with a verified device session.
     */
    manageToken: text('manage_token').notNull(),

    deviceId: text('device_id'),
    ipHash: text('ip_hash'),

    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    promotedAt: timestamp('promoted_at', { withTimezone: true }),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    withdrawnBy: text('withdrawn_by'),
    withdrawReason: text('withdraw_reason'),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
    attendanceMarkedAt: timestamp('attendance_marked_at', { withTimezone: true }),
    attendanceMarkedBy: text('attendance_marked_by'),

    version: integer('version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * One live participation per human per session. An allowlist rather than
     * `<> 'withdrawn'`, so a terminal state added later cannot silently re-enter
     * the index and collide with a genuine rejoin.
     */
    uniqueIndex('session_participants_live_uq')
      .on(t.sessionId, t.playerId)
      .where(
        sql`state in ('joined'::participation_state, 'confirmed'::participation_state, 'waitlisted'::participation_state, 'checked_in'::participation_state, 'played'::participation_state, 'absent'::participation_state)`,
      ),
    /** Two people cannot hold the same seat. This is the capacity interlock. */
    uniqueIndex('session_participants_seat_uq')
      .on(t.sessionId, t.seatNo)
      .where(
        sql`seat_no is not null and state in ('joined'::participation_state, 'confirmed'::participation_state, 'checked_in'::participation_state, 'played'::participation_state, 'absent'::participation_state)`,
      ),
    uniqueIndex('session_participants_seq_uq').on(t.sessionId, t.seq),
    uniqueIndex('session_participants_token_uq').on(t.manageToken),
    index('session_participants_session_state_idx').on(t.sessionId, t.state),
    index('session_participants_player_idx').on(t.playerId),
    index('session_participants_payer_idx').on(t.payerPlayerId),
    check('session_participants_guest_has_host', sql`is_guest = false or invited_by_player_id is not null`),
    /** Waitlisted and withdrawn hold no seat; everyone else holds exactly one. */
    check(
      'session_participants_seat_shape',
      sql`(state in ('waitlisted'::participation_state, 'withdrawn'::participation_state) and seat_no is null)
          or (state not in ('waitlisted'::participation_state, 'withdrawn'::participation_state) and seat_no is not null)`,
    ),
    check('session_participants_seat_positive', sql`seat_no is null or seat_no >= 1`),
    check('session_participants_seq_positive', sql`seq >= 1`),
    check('session_participants_override_nonneg', sql`price_override_paise is null or price_override_paise >= 0`),
    /** An override always says why. The charge snapshots both. */
    check(
      'session_participants_override_shape',
      sql`(price_override_paise is null and price_note is null) or (price_override_paise is not null and price_note is not null)`,
    ),
  ],
)

/**
 * One row per scheduled boundary the reconciler has already acted on.
 *
 * A pure planner makes two overlapping ticks compute PRECISELY the same actions,
 * which amplifies a replay rather than preventing one. The key is derived from
 * the boundary and never from `now`, the insert happens in the same transaction
 * as the effect, and an empty `returning` means "already done" (ADR 6b).
 *
 * `kind` is text, not an enum: stages 4 to 6 add notice, sweep and probe kinds,
 * and `ALTER TYPE … ADD VALUE` cannot be used in the migration that adds it.
 */
export const sessionScheduledActions = pgTable(
  'session_scheduled_actions',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => gameSessions.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    /** The scheduled instant this action belongs to — the idempotency key. */
    boundaryAt: timestamp('boundary_at', { withTimezone: true }).notNull(),
    firedAt: timestamp('fired_at', { withTimezone: true }).notNull().defaultNow(),
    /** applied | noop | skipped_stale */
    outcome: text('outcome').notNull(),
    detail: jsonb('detail'),
  },
  (t) => [
    uniqueIndex('session_scheduled_actions_uq').on(t.sessionId, t.kind, t.boundaryAt),
    index('session_scheduled_actions_session_idx').on(t.sessionId, t.boundaryAt),
  ],
)

/**
 * Scheduler health. The Tonight screen shows the age of the last tick and goes
 * red when it is stale — the signal an opportunistic page-render trigger would
 * have hidden by quietly doing the work on render (SPEC-v4 §7).
 */
export const schedulerRuns = pgTable(
  'scheduler_runs',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    seen: integer('seen').notNull().default(0),
    applied: integer('applied').notNull().default(0),
    error: text('error'),
  },
  (t) => [index('scheduler_runs_name_idx').on(t.name, t.startedAt)],
)

// ═════════════════════════════ the money ═════════════════════════════
//
// SPEC-v4 §4. Nine tables, and the reason there are nine rather than the five
// the ladder names is written down in docs/ADR-daily-games.md decision 14: the
// five database constraints (m22) need a webhook inbox to be unique against,
// and the reservation interlock (m23) needs an attempt to hang off. Both were
// asked for in stage 3 precisely so that stage 4 does not retrofit them.
//
// Three rules hold across every table here:
//
//   1. Money is integer paise. No float, at any stage. Currency pinned by CHECK.
//   2. Nothing is deleted and nothing is back-dated. A correction is a new row
//      with a sign. `money_row_is_forever` raises on DELETE for every table
//      below, so "we'll just remove that row" fails in development rather than
//      in a ledger. TRUNCATE does not fire row triggers, so tests still
//      truncate.
//   3. No external call happens inside an open transaction. That rule shapes
//      the collection attempt: the reservation commits, then the call happens,
//      then the outcome commits. Stage 3 has no external call to make, which is
//      exactly why the shape is built now (SPEC-v4 §4, m23).
//
// What is deliberately NOT here: a stored balance (§12 — derived from these
// rows and nowhere else), a mandate (stage 5), a sweep (stage 6), and any fee
// or settlement arithmetic (§1 — the real fee is read off the settlement
// record, never computed from a rate card).

/**
 * Where a charge came from, and it is not cosmetic.
 *
 * `participation` is the session fee for somebody who was there. `policy` is a
 * separate charge such as an optional no-show fee — never the session fee under
 * another label, so it can be waived, priced or switched off without touching
 * session billing (SPEC-v4 §5, Participation → Billing). `manual` is the host
 * writing something down by hand.
 */
export const chargeOriginEnum = pgEnum('charge_origin', ['participation', 'policy', 'manual'])

/**
 * The charge's LIFECYCLE. Not its settlement, and not its reservation.
 *
 * SPEC-v4 §5 lists `draft` and `settled` as well. Neither is stored here:
 *
 *   - `draft` — §2 says "until this moment attendance is freely editable and no
 *     charge exists". A draft row would take the `charges_participation_uq`
 *     slot while attendance was still moving, so correcting a tick would mean
 *     editing or deleting a charge — the two things §4 forbids outright.
 *   - `settled` — derived from `applied_paise` reaching `amount_paise +
 *     adjust_paise`, never set by hand (§5: "derived from applications reaching
 *     the total"). Storing it would be a second opinion about the same fact.
 *   - `reserved` is not here either, and must never be added. §6 spends a
 *     paragraph on why a status enum on the charge is the wrong place for it:
 *     it mutates an immutable row, cannot say who reserved it, and makes one of
 *     the two facts unrepresentable while the other holds. The interlock is
 *     `collection_attempt_charges`.
 */
export const chargeStateEnum = pgEnum('charge_state', ['locked', 'waived', 'written_off'])

/**
 * SPEC-v4 §5, Payment. `succeeded → failed` is refused, not trusted to order.
 *
 * The refusal is a trigger (`payments_state_forward`), not a convention: out-of-
 * order webhooks are stage 4's normal case, and "handle it by refusing backward
 * transitions" has to be something the database does rather than something the
 * webhook handler remembers. `initiated` may become anything; a payment that
 * has landed may only be reversed; nothing else moves once it is settled.
 */
export const paymentStateEnum = pgEnum('payment_state', ['initiated', 'succeeded', 'failed', 'reversed'])

/** Money going back out. Its own lifecycle and its own provider id — not a negative payment. */
export const refundStateEnum = pgEnum('refund_state', ['initiated', 'succeeded', 'failed'])

/**
 * What one player owes, for a stated reason. Immutable once written.
 *
 * The amount, the reason and the timestamp never change again. A correction is
 * a `charge_adjustments` row with a sign; money arriving is a `payments` row
 * and a `charge_applications` row. Nothing edits this table but the two
 * settlement counters below, and those move only in the same transaction as the
 * child row they summarise.
 *
 * `player_id` is the PAYER, snapshotted at the moment the charge is written —
 * for a guest that is the inviter (ADR decision 3). Who played is
 * `participation_id`, and the two are deliberately different columns.
 */
export const charges = pgTable(
  'charges',
  {
    id: text('id').primaryKey(),
    venueId: text('venue_id')
      .notNull()
      .references(() => venues.id),
    /** Who owes it. Never assumed to be the player who played. */
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    sessionId: text('session_id').references(() => gameSessions.id),
    /** Who played. Null only for a manual charge with no night behind it. */
    participationId: text('participation_id').references(() => sessionParticipants.id),

    origin: chargeOriginEnum('origin').notNull(),
    /** Only for `policy`: 'no_show' and whatever a later policy adds. */
    policyKind: text('policy_kind'),

    /** Integer paise, and it never changes. */
    amountPaise: integer('amount_paise').notNull(),
    currency: text('currency').notNull().default('INR'),
    /** A sentence a player would recognise: "Tuesday evening social, 14 Sep". */
    reason: text('reason').notNull(),

    state: chargeStateEnum('state').notNull().default('locked'),
    /** Why it was waived or written off, and by whom. Null while `locked`. */
    stateReason: text('state_reason'),
    stateAt: timestamp('state_at', { withTimezone: true }),
    stateByUserId: text('state_by_user_id').references(() => users.id),

    /**
     * The two settlement counters. They are stored because a CHECK cannot
     * aggregate another table, and `charges_applied_within` — "can't
     * over-settle a charge" — is the one guarantee that must not depend on
     * somebody remembering to write an `if`.
     *
     * This is NOT the stored balance §12 forbids. That is a per-player number
     * no constraint guards and no single transaction owns. These are per-row
     * sums, moved by the same statement that inserts the row they count, and
     * guarded by the constraint itself. `moneyDrift()` proves them against the
     * child rows, and a test runs it.
     */
    adjustPaise: integer('adjust_paise').notNull().default(0),
    appliedPaise: integer('applied_paise').notNull().default(0),

    /** What the price was and where it came from, snapshotted so a later edit cannot rewrite the night. */
    unitPricePaise: integer('unit_price_paise').notNull(),
    /** session | override — which of the two produced `unit_price_paise`. */
    priceSource: text('price_source').notNull().default('session'),
    /** "Coach", "half price, first night" — the host's words for an override. */
    priceNote: text('price_note'),
    /** The policy version that produced this amount (the stage-6 rule, applied early). */
    policyVersion: integer('policy_version').notNull().default(1),

    /**
     * A definite collection failure puts a short cooldown on the charge and the
     * link path takes over (SPEC-v4 §6, release rules). Never a reservation
     * release timer — that rule is the bug the reservation design prevents.
     */
    cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),

    createdByUserId: text('created_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** INVARIANT 1 (SPEC-v4 §4) — can't over-settle a charge. */
    check('charges_applied_within', sql`applied_paise <= amount_paise + adjust_paise`),
    check('charges_applied_nonneg', sql`applied_paise >= 0`),
    /**
     * An adjustment may cancel a charge but never invert it; the excess is a
     * credit. Strictly this follows from the two above — `applied >= 0` and
     * `applied <= amount + adjust` together already forbid a negative net — so
     * Postgres names whichever it evaluates first and this one rarely speaks.
     * It is kept because it says the rule in the words the rule is about.
     */
    check('charges_net_nonneg', sql`amount_paise + adjust_paise >= 0`),
    check('charges_amount_nonneg', sql`amount_paise >= 0`),
    check('charges_unit_price_nonneg', sql`unit_price_paise >= 0`),
    check('charges_inr', sql`currency = 'INR'`),
    check('charges_price_source', sql`price_source in ('session', 'override')`),
    check(
      'charges_origin_shape',
      sql`(origin = 'participation'::charge_origin and participation_id is not null and policy_kind is null)
          or (origin = 'policy'::charge_origin and participation_id is not null and policy_kind is not null)
          or (origin = 'manual'::charge_origin and policy_kind is null)`,
    ),
    /** A waived or written-off charge says why; a locked one has nothing to say. */
    check(
      'charges_state_reason',
      sql`(state = 'locked'::charge_state and state_reason is null and state_at is null)
          or (state <> 'locked'::charge_state and state_reason is not null and state_at is not null)`,
    ),
    /** INVARIANT 4 (SPEC-v4 §4) — can't double-bill a game. */
    uniqueIndex('charges_participation_uq')
      .on(t.participationId)
      .where(sql`origin = 'participation'::charge_origin`),
    /**
     * The same guarantee for a policy charge, which invariant 4 does not reach:
     * a replayed lock could otherwise raise the no-show fee twice (ADR 14, T11).
     */
    uniqueIndex('charges_policy_uq')
      .on(t.participationId, t.policyKind)
      .where(sql`origin = 'policy'::charge_origin`),
    index('charges_player_idx').on(t.playerId, t.state),
    index('charges_session_idx').on(t.sessionId),
    /** The collections list: what is still owed, oldest first. */
    index('charges_open_idx')
      .on(t.venueId, t.createdAt)
      .where(sql`state = 'locked'::charge_state and applied_paise < amount_paise + adjust_paise`),
  ],
)

/**
 * A signed row that changes what is owed — a discount, a waiver of part of it,
 * a correction after the fact. Not a payment: no money moved.
 */
export const chargeAdjustments = pgTable(
  'charge_adjustments',
  {
    id: text('id').primaryKey(),
    chargeId: text('charge_id')
      .notNull()
      .references(() => charges.id),
    /** Signed. Negative forgives, positive adds. Never zero — that is not a correction. */
    deltaPaise: integer('delta_paise').notNull(),
    reason: text('reason').notNull(),
    actorUserId: text('actor_user_id').references(() => users.id),
    actorLabel: text('actor_label').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('charge_adjustments_nonzero', sql`delta_paise <> 0`),
    index('charge_adjustments_charge_idx').on(t.chargeId, t.at),
  ],
)

/**
 * Money that actually arrived, by some method, from some initiator.
 *
 * A payment knows nothing about which charges it covers — that is what
 * `charge_applications` is for, and it is what makes one payment covering four
 * people expressible at all (SPEC-v4 §4).
 *
 * `method` is text with a CHECK rather than an enum: stage 4 adds gateway
 * methods and `ALTER TYPE … ADD VALUE` cannot be used in the migration that
 * adds it, whereas a CHECK can be dropped and re-added in one transaction. The
 * same reasoning is already written on `session_scheduled_actions.kind`.
 */
export const payments = pgTable(
  'payments',
  {
    id: text('id').primaryKey(),
    venueId: text('venue_id')
      .notNull()
      .references(() => venues.id),
    /** Who handed the money over. Usually the payer on the charges it settles. */
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),

    amountPaise: integer('amount_paise').notNull(),
    currency: text('currency').notNull().default('INR'),
    /** cash | venue_qr | gateway | bank_transfer — how, never how far. */
    method: text('method').notNull(),
    /** player | host | system — who set it going. */
    initiator: text('initiator').notNull(),
    state: paymentStateEnum('state').notNull().default('initiated'),

    /** INVARIANT 2's counters — see the note on `charges.applied_paise`. */
    allocatedPaise: integer('allocated_paise').notNull().default(0),
    refundedPaise: integer('refunded_paise').notNull().default(0),

    /** When the money arrived, which is not when the row was written. */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /** The attempt that collected it, when there was one. */
    attemptId: text('attempt_id'),
    provider: text('provider'),
    providerPaymentId: text('provider_payment_id'),
    note: text('note'),

    createdByUserId: text('created_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('payments_amount_positive', sql`amount_paise > 0`),
    check('payments_inr', sql`currency = 'INR'`),
    /** INVARIANT 2 (SPEC-v4 §4) — can't spend a payment twice. */
    check('payments_spent_within', sql`allocated_paise + refunded_paise <= amount_paise`),
    check('payments_allocated_nonneg', sql`allocated_paise >= 0 and refunded_paise >= 0`),
    check('payments_method', sql`method in ('cash', 'venue_qr', 'gateway', 'bank_transfer')`),
    check('payments_initiator', sql`initiator in ('player', 'host', 'system')`),
    /** One provider payment is one row, however many times the webhook arrives. */
    uniqueIndex('payments_provider_uq')
      .on(t.provider, t.providerPaymentId)
      .where(sql`provider is not null and provider_payment_id is not null`),
    index('payments_player_idx').on(t.playerId, t.receivedAt),
    index('payments_venue_day_idx').on(t.venueId, t.receivedAt),
    /** The day-end tally's working set: money in, not yet spoken for. */
    index('payments_unallocated_idx')
      .on(t.playerId)
      .where(sql`state = 'succeeded'::payment_state and allocated_paise + refunded_paise < amount_paise`),
  ],
)

/**
 * Value granted without money arriving — goodwill, a correction, a rained-off
 * session. It settles a charge but never appears in the bank, which is why it
 * is its own object and not a payment with `method = 'credit'`: the day the
 * cash line includes a credit is the day it stops matching the drawer (m4).
 */
export const credits = pgTable(
  'credits',
  {
    id: text('id').primaryKey(),
    venueId: text('venue_id')
      .notNull()
      .references(() => venues.id),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    amountPaise: integer('amount_paise').notNull(),
    currency: text('currency').notNull().default('INR'),
    reason: text('reason').notNull(),
    appliedPaise: integer('applied_paise').notNull().default(0),
    /** When an overpayment becomes a credit, this is where it came from. */
    sourcePaymentId: text('source_payment_id').references(() => payments.id),
    actorLabel: text('actor_label').notNull(),
    createdByUserId: text('created_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('credits_amount_positive', sql`amount_paise > 0`),
    check('credits_inr', sql`currency = 'INR'`),
    check('credits_applied_within', sql`applied_paise >= 0 and applied_paise <= amount_paise`),
    index('credits_player_idx').on(t.playerId, t.createdAt),
  ],
)

/**
 * The join that carries money from a payment — or a credit — to a charge.
 * Without it, one payment covering three sessions has nowhere to live.
 *
 * `amount_paise` is SIGNED, and that is the whole answer to §4's own worked
 * example. Priya is over-billed ₹300 and has already paid: the correction has
 * to take ₹300 off what her payment covers before the −₹300 adjustment can be
 * posted, or `charges_applied_within` refuses it (applied 300 <= 300 + −300 is
 * false). Deleting the application is forbidden by §4 rule 2. So a reversal is
 * a new row with a negative amount pointing at the one it undoes, the payment's
 * ₹300 goes back to unallocated, and it becomes a refund or a credit depending
 * on whose mistake it was.
 */
export const chargeApplications = pgTable(
  'charge_applications',
  {
    id: text('id').primaryKey(),
    chargeId: text('charge_id')
      .notNull()
      .references(() => charges.id),
    /** Exactly one of these two. Money from the bank, or value granted. */
    paymentId: text('payment_id').references(() => payments.id),
    creditId: text('credit_id').references(() => credits.id),
    /** Signed: positive settles, negative gives back what an earlier row took. */
    amountPaise: integer('amount_paise').notNull(),
    /** The application this one reverses. Set only on a negative row. */
    reversesId: text('reverses_id'),
    reason: text('reason'),
    actorLabel: text('actor_label').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('charge_applications_nonzero', sql`amount_paise <> 0`),
    check(
      'charge_applications_one_source',
      sql`(payment_id is not null and credit_id is null) or (payment_id is null and credit_id is not null)`,
    ),
    check(
      'charge_applications_reversal_shape',
      sql`(reverses_id is null and amount_paise > 0) or (reverses_id is not null and amount_paise < 0)`,
    ),
    /** An application is undone once. A second reversal of the same row is a bug, not a correction. */
    uniqueIndex('charge_applications_reverses_uq').on(t.reversesId).where(sql`reverses_id is not null`),
    index('charge_applications_charge_idx').on(t.chargeId, t.at),
    index('charge_applications_payment_idx').on(t.paymentId),
    index('charge_applications_credit_idx').on(t.creditId),
  ],
)

/**
 * Money sent back out, against a specific payment. Not a negative payment: it
 * has its own lifecycle and its own provider id.
 */
export const refunds = pgTable(
  'refunds',
  {
    id: text('id').primaryKey(),
    paymentId: text('payment_id')
      .notNull()
      .references(() => payments.id),
    amountPaise: integer('amount_paise').notNull(),
    reason: text('reason').notNull(),
    state: refundStateEnum('state').notNull().default('initiated'),
    provider: text('provider'),
    providerRefundId: text('provider_refund_id'),
    actorLabel: text('actor_label').notNull(),
    createdByUserId: text('created_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => [
    check('refunds_amount_positive', sql`amount_paise > 0`),
    uniqueIndex('refunds_provider_uq')
      .on(t.provider, t.providerRefundId)
      .where(sql`provider is not null and provider_refund_id is not null`),
    index('refunds_payment_idx').on(t.paymentId),
  ],
)

/**
 * One try at getting money — the desk taking cash today, a payment link in
 * stage 4, a mandate debit in stage 6. It carries the provider ids, the attempt
 * number and the outcome.
 *
 * `state` is text with a CHECK for the same reason `method` is: stages 4 to 6
 * add states to this list, and a CHECK can be replaced inside a transaction.
 * `sweep_id` is a bare column with no foreign key — sweeps are stage 6, and a
 * table that does not exist cannot be referenced, but the seam is named here so
 * the column is not added later to a table full of rows.
 */
export const collectionAttempts = pgTable(
  'collection_attempts',
  {
    id: text('id').primaryKey(),
    venueId: text('venue_id')
      .notNull()
      .references(() => venues.id),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    /** desk | link | mandate */
    kind: text('kind').notNull(),
    state: text('state').notNull().default('created'),
    /** The sum of the charges this attempt holds, fixed when they are reserved. */
    amountPaise: integer('amount_paise').notNull().default(0),
    attemptNo: integer('attempt_no').notNull().default(1),
    sweepId: text('sweep_id'),

    provider: text('provider'),
    providerRef: text('provider_ref'),
    /**
     * Chosen and committed BEFORE the external call, which is the whole point:
     * a lost response can be resolved by asking the provider about an id we
     * know we sent (SPEC-v4 §6, "When the outcome is unknown").
     */
    idempotencyKey: text('idempotency_key'),

    outcomeNote: text('outcome_note'),
    createdByUserId: text('created_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    submittingAt: timestamp('submitting_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    check('collection_attempts_amount_nonneg', sql`amount_paise >= 0`),
    check('collection_attempts_kind', sql`kind in ('desk', 'link', 'mandate')`),
    check(
      'collection_attempts_state',
      sql`state in ('created', 'reserved', 'notified', 'awaiting_window', 'submitting', 'submitted', 'succeeded', 'failed', 'unknown')`,
    ),
    uniqueIndex('collection_attempts_key_uq')
      .on(t.provider, t.idempotencyKey)
      .where(sql`provider is not null and idempotency_key is not null`),
    index('collection_attempts_player_idx').on(t.playerId, t.createdAt),
    /** What a probe job walks: everything committed as sent and not yet resolved. */
    index('collection_attempts_open_idx')
      .on(t.venueId, t.submittingAt)
      .where(sql`state in ('submitting', 'submitted', 'unknown')`),
  ],
)

/**
 * A durable claim on a charge, held from before the external call until the
 * provider says what happened. THE interlock of the money model.
 *
 * Not a lock: it survives transactions, processes and restarts, and it is
 * visible to every reader — which is why an operator can ask why a charge is
 * unpayable, and a row lock or an advisory lock could never answer (§6).
 *
 * Nothing releases it on a timer. A reservation is released by an outcome: a
 * success releases it in the same transaction that records the payment, a
 * definite failure releases it with a reason, and an unknown outcome keeps it
 * held until a named human resolves it. Freezing ₹900 is a WhatsApp message;
 * collecting it twice is a refund and a player who stops trusting the billing.
 */
export const collectionAttemptCharges = pgTable(
  'collection_attempt_charges',
  {
    id: text('id').primaryKey(),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => collectionAttempts.id),
    chargeId: text('charge_id')
      .notNull()
      .references(() => charges.id),
    /** What of this charge the attempt is trying to collect. */
    amountPaise: integer('amount_paise').notNull(),
    reservedAt: timestamp('reserved_at', { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releaseReason: text('release_reason'),
  },
  (t) => [
    check('collection_attempt_charges_amount_positive', sql`amount_paise > 0`),
    /** INVARIANT 3 (SPEC-v4 §4, §6) — can't double-collect a charge. */
    uniqueIndex('one_live_reservation_per_charge').on(t.chargeId).where(sql`released_at is null`),
    /** Unconditional, so it still holds after release and a replayed worker cannot duplicate a line. */
    uniqueIndex('collection_attempt_charges_uq').on(t.attemptId, t.chargeId),
    index('collection_attempt_charges_charge_idx').on(t.chargeId),
  ],
)

/**
 * Every message a provider sends, verified or not, stored before it is
 * interpreted. A durable inbox the reconciler drains — never a trigger.
 *
 * There is no provider until stage 4. The table is here because m22 says the
 * five constraints are "written now, before anything can violate them", and
 * because a webhook arriving twice is the cheapest possible bug to prevent and
 * an expensive one to find afterwards.
 */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    kind: text('kind'),
    /** The exact bytes received, before anything parsed them. */
    payload: text('payload').notNull(),
    signatureOk: boolean('signature_ok').notNull().default(false),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [
    /** INVARIANT 5 (SPEC-v4 §4) — can't double-process a webhook. */
    uniqueIndex('webhook_events_provider_uq').on(t.provider, t.providerEventId),
    index('webhook_events_unprocessed_idx').on(t.receivedAt).where(sql`processed_at is null`),
  ],
)
