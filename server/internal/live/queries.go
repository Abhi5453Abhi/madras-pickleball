package live

// The reads this package adds on top of `store`. Every one of them is
// venue-scoped: an id that arrives on the wire names a row, and the row has to
// belong to the venue this instance serves before anything is said about it.

import (
	"context"
	"database/sql"
	"strings"
	"time"

	"mpb/internal/core"
	"mpb/internal/store"
)

// playerRef is who is in a match, in the order the pair was entered.
type playerRef struct {
	ID   string
	Name string
}

// rosterOrder is side A first, then B, each in the order the pair was entered.
//
// Left to the query plan this is arbitrary, and it decides which name the board
// prints in "Meera Krishnamurthy is on Court 1" when both halves of a pair are
// double-booked. A blocker that names a different person on every reload is not
// something an organiser can act on.
const rosterOrder = `case when tm.id = m.team_a_id then 0 else 1 end, tp.position`

// playersByTournament is match id → who is in it, for one tournament.
func playersByTournament(ctx context.Context, q core.Querier, tournamentID string) (map[string][]playerRef, error) {
	rows, err := q.QueryContext(ctx, `
		select m.id, p.id, p.name
		from matches m
		join teams tm on tm.id = m.team_a_id or tm.id = m.team_b_id
		join team_players tp on tp.team_id = tm.id
		join players p on p.id = tp.player_id
		where m.tournament_id = $1
		order by m.id, `+rosterOrder, tournamentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]playerRef{}
	for rows.Next() {
		var matchID string
		var p playerRef
		if err := rows.Scan(&matchID, &p.ID, &p.Name); err != nil {
			return nil, err
		}
		out[matchID] = append(out[matchID], p)
	}
	return out, rows.Err()
}

// playersForMatches is the same, for a handful of matches anywhere at the venue.
func playersForMatches(ctx context.Context, q core.Querier, ids []string) (map[string][]playerRef, error) {
	if len(ids) == 0 {
		return map[string][]playerRef{}, nil
	}
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	rows, err := q.QueryContext(ctx, `
		select m.id, p.id, p.name
		from matches m
		join teams tm on tm.id = m.team_a_id or tm.id = m.team_b_id
		join team_players tp on tp.team_id = tm.id
		join players p on p.id = tp.player_id
		where m.id in (`+store.Placeholders(1, len(ids))+`)
		order by m.id, `+rosterOrder, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]playerRef{}
	for rows.Next() {
		var matchID string
		var p playerRef
		if err := rows.Scan(&matchID, &p.ID, &p.Name); err != nil {
			return nil, err
		}
		out[matchID] = append(out[matchID], p)
	}
	return out, rows.Err()
}

// busyElsewhere is player id → the court they are standing on, for every live
// match at the venue outside one tournament. Ravi plays Men's Doubles on Court
// 1 and Mixed on Court 3, and the one thing the board exists to prevent is
// calling him to both at once.
func busyElsewhere(ctx context.Context, q core.Querier, venueID, exceptTournamentID string) (map[string]string, error) {
	rows, err := q.QueryContext(ctx, `
		select p.id, coalesce(c.name, 'another court')
		from matches m
		join tournaments t on t.id = m.tournament_id
		join teams tm on tm.id = m.team_a_id or tm.id = m.team_b_id
		join team_players tp on tp.team_id = tm.id
		join players p on p.id = tp.player_id
		left join courts c on c.id = m.court_id
		where m.status = 'live' and t.venue_id = $1 and t.deleted_at is null and m.tournament_id <> $2`,
		venueID, exceptTournamentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var playerID, court string
		if err := rows.Scan(&playerID, &court); err != nil {
			return nil, err
		}
		out[playerID] = court
	}
	return out, rows.Err()
}

// liveMatchesAtVenue is every match on a court right now, whichever tournament
// holds it. The board reads it to know a court is busy; the day filter of
// store.LiveMatchesOnDay would miss a tournament that ran past midnight.
func liveMatchesAtVenue(ctx context.Context, q core.Querier, venueID string) ([]*store.Match, error) {
	rows, err := q.QueryContext(ctx, `
		select m.id, m.tournament_id, m.court_id, m.team_a_id, m.team_b_id, m.started_at
		from matches m join tournaments t on t.id = m.tournament_id
		where t.venue_id = $1 and t.deleted_at is null and m.status = 'live'`, venueID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*store.Match
	for rows.Next() {
		var m store.Match
		var court, teamA, teamB sql.NullString
		var started sql.NullTime
		if err := rows.Scan(&m.ID, &m.TournamentID, &court, &teamA, &teamB, &started); err != nil {
			return nil, err
		}
		m.CourtID = core.StrPtr(court)
		m.TeamAID = core.StrPtr(teamA)
		m.TeamBID = core.StrPtr(teamB)
		m.StartedAt = core.TimePtr(started)
		m.Status = "live"
		out = append(out, &m)
	}
	return out, rows.Err()
}

// courtNameMap is court id → name, across the venue.
func courtNameMap(ctx context.Context, q core.Querier, venueID string) (map[string]string, error) {
	list, err := store.VenueCourts(ctx, q, venueID, false)
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(list))
	for _, c := range list {
		out[c.ID] = c.Name
	}
	return out, nil
}

// courtByID finds one of the venue's courts, active or not.
func courtByID(ctx context.Context, q core.Querier, venueID, courtID string) (*store.Court, error) {
	var c store.Court
	err := q.QueryRowContext(ctx,
		`select id, venue_id, name, sort_order, color_key, active from courts where id = $1 and venue_id = $2`,
		courtID, venueID).Scan(&c.ID, &c.VenueID, &c.Name, &c.SortOrder, &c.ColorKey, &c.Active)
	if err != nil {
		return nil, store.ErrNotFound
	}
	return &c, nil
}

// tournamentCourts is the active courts a tournament holds, in venue order. A
// court taken out of the venue is not one a match can go on.
func tournamentCourts(ctx context.Context, q core.Querier, tournamentID string) ([]store.Court, error) {
	all, err := store.TournamentCourts(ctx, q, tournamentID)
	if err != nil {
		return nil, err
	}
	out := make([]store.Court, 0, len(all))
	for _, c := range all {
		if c.Active {
			out = append(out, c)
		}
	}
	return out, nil
}

// holdsCourt reports whether this tournament holds that court.
func holdsCourt(ctx context.Context, q core.Querier, tournamentID, courtID string) (bool, error) {
	var one int
	err := q.QueryRowContext(ctx,
		`select 1 from tournament_courts where tournament_id = $1 and court_id = $2`, tournamentID, courtID).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

// courtBusy reports whether any match is on that court right now — asked of the
// database at the moment of the write, not of the snapshot a board rendered.
func courtBusy(ctx context.Context, q core.Querier, courtID, exceptMatchID string) (bool, error) {
	var one int
	err := q.QueryRowContext(ctx,
		`select 1 from matches where court_id = $1 and status = 'live' and id <> $2 limit 1`, courtID, exceptMatchID).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// liveTournamentIDs is every tournament running at the venue right now.
func liveTournamentIDs(ctx context.Context, q core.Querier, venueID string) ([]string, error) {
	rows, err := q.QueryContext(ctx,
		`select id from tournaments where venue_id = $1 and status = 'live' and deleted_at is null order by created_at, id`, venueID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// todaysTournaments is every tournament on today: anything dated today at the
// venue, plus anything still running whatever its date — a day that ran past
// midnight is still the day. A completed one has let go of its courts and is
// off the board.
func todaysTournaments(ctx context.Context, q core.Querier, d *core.Deps) ([]*store.Tournament, error) {
	today := core.DayKey(d.Now())
	rows, err := q.QueryContext(ctx, `
		select `+tournamentColumns+` from tournaments
		where venue_id = $1 and deleted_at is null and status <> 'completed'
		  and (status = 'live' or day = $2::date)
		order by day, created_at, id`, d.Venue.ID, today)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanTournaments(rows)
}

// heldCourts is tournament id → the court ids it holds, for a set of
// tournaments.
func heldCourts(ctx context.Context, q core.Querier, tournamentIDs []string) (map[string][]string, error) {
	out := map[string][]string{}
	if len(tournamentIDs) == 0 {
		return out, nil
	}
	args := make([]any, len(tournamentIDs))
	for i, id := range tournamentIDs {
		args[i] = id
	}
	rows, err := q.QueryContext(ctx, `
		select tc.tournament_id, tc.court_id
		from tournament_courts tc join courts c on c.id = tc.court_id
		where tc.tournament_id in (`+store.Placeholders(1, len(tournamentIDs))+`) and c.active
		order by c.sort_order, c.name`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var tournamentID, courtID string
		if err := rows.Scan(&tournamentID, &courtID); err != nil {
			return nil, err
		}
		out[tournamentID] = append(out[tournamentID], courtID)
	}
	return out, rows.Err()
}

// ── scanning a tournament row ─────────────────────────────────────────────

// The same column list store uses; repeated here because store's is unexported
// and this package builds its own WHERE clauses.
const tournamentColumns = `id, venue_id, name, slug, to_char(day, 'YYYY-MM-DD'), gender, discipline, finals_stage,
	best_of, points_to_win, advance_per_group, status, registration_closed_at, draw_made_at, started_at,
	paused_at, pause_note, finished_at, winner_team_id, runner_up_team_id, seed_order, version, created_at, updated_at`

func scanTournaments(rows *sql.Rows) ([]*store.Tournament, error) {
	var out []*store.Tournament
	for rows.Next() {
		t, err := scanTournamentRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func scanTournamentRow(row interface{ Scan(dest ...any) error }) (*store.Tournament, error) {
	var t store.Tournament
	var regClosed, drawMade, started, paused, finished sql.NullTime
	var pauseNote, winner, runnerUp sql.NullString
	var seed []byte
	err := row.Scan(&t.ID, &t.VenueID, &t.Name, &t.Slug, &t.Day, &t.Gender, &t.Discipline, &t.FinalsStage,
		&t.BestOf, &t.PointsToWin, &t.AdvancePerGroup, &t.Status, &regClosed, &drawMade, &started,
		&paused, &pauseNote, &finished, &winner, &runnerUp, &seed, &t.Version, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return nil, err
	}
	t.RegistrationClosedAt = core.TimePtr(regClosed)
	t.DrawMadeAt = core.TimePtr(drawMade)
	t.StartedAt = core.TimePtr(started)
	t.PausedAt = core.TimePtr(paused)
	t.PauseNote = core.StrPtr(pauseNote)
	t.FinishedAt = core.TimePtr(finished)
	t.WinnerTeamID = core.StrPtr(winner)
	t.RunnerUpTeamID = core.StrPtr(runnerUp)
	_ = seed // seed_order is the setup module's business
	return &t, nil
}

// ── small shared helpers ──────────────────────────────────────────────────

func strp(s string) *string { return &s }

func intp(i int) *int { return &i }

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// iso renders a time for the wire, or nil.
func iso(t *time.Time) *string { return core.ISO(t) }

// shortCategory is "Men's" from "Men's Doubles" — the day strip has room for
// one word.
func shortCategory(name string) string {
	for _, suffix := range []string{" Doubles", " Singles"} {
		if strings.HasSuffix(name, suffix) {
			return strings.TrimSuffix(name, suffix)
		}
	}
	return name
}

// minutesSince is whole minutes, floored, never negative.
func minutesSince(then, now time.Time) int {
	m := int(now.Sub(then) / time.Minute)
	if m < 0 {
		return 0
	}
	return m
}
