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

export const confidenceEnum = pgEnum('confirmation_confidence', ['normal', 'low'])

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

export const courtClosures = pgTable(
  'court_closures',
  {
    id: text('id').primaryKey(),
    courtId: text('court_id')
      .notNull()
      .references(() => courts.id, { onDelete: 'cascade' }),
    tournamentId: text('tournament_id'),
    reason: text('reason'),
    from: timestamp('from', { withTimezone: true }).notNull().defaultNow(),
    until: timestamp('until', { withTimezone: true }),
  },
  (t) => [index('court_closures_idx').on(t.courtId, t.from)],
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('tournaments_slug_key').on(t.slug),
    index('tournaments_status_idx').on(t.status, t.startDate),
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
  (t) => [index('token_attempts_ip_idx').on(t.ipHash, t.at), index('token_attempts_at_idx').on(t.at)],
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
