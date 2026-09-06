// Package store is the rows as Go values and the loaders every module
// shares. Modules add their own queries on top; nothing here decides
// anything about the game.
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"mpb/internal/core"
	"mpb/internal/db"
	"mpb/internal/engine"
)

// ── rows ──────────────────────────────────────────────────────────────────

type Court struct {
	ID        string
	VenueID   string
	Name      string
	SortOrder int
	ColorKey  string
	Active    bool
}

type Tournament struct {
	ID                   string
	VenueID              string
	Name                 string
	Slug                 string
	Day                  string // "2006-01-02" at the venue
	Gender               string // mens | womens | mixed | any
	Discipline           string // singles | doubles
	FinalsStage          string // none | final_only | semis_and_final
	BestOf               int
	PointsToWin          int
	AdvancePerGroup      int
	Status               string // setup | live | completed
	RegistrationClosedAt *time.Time
	DrawMadeAt           *time.Time
	StartedAt            *time.Time
	PausedAt             *time.Time
	PauseNote            *string
	FinishedAt           *time.Time
	WinnerTeamID         *string
	RunnerUpTeamID       *string
	SeedOrder            []string
	Version              int
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

// TeamSize is 2 for doubles, 1 for singles.
func (t *Tournament) TeamSize() int {
	if t.Discipline == "singles" {
		return 1
	}
	return 2
}

type Player struct {
	ID       string
	Name     string
	NameKey  string
	Phone    *string
	PhoneKey *string
}

type TournamentPlayer struct {
	ID              string
	TournamentID    string
	Player          Player
	Source          string // link | hand
	PartnerWish     *string
	PartnerPlayerID *string
	CreatedAt       time.Time
}

type Group struct {
	ID           string
	TournamentID string
	Name         string
	AdvanceCount int
	SortOrder    int
}

type Team struct {
	ID           string
	TournamentID string
	GroupID      *string
	Name         string
	Seed         *int
	Status       string // active | withdrawn
	WithdrawnAt  *time.Time
	Players      []Player // in position order
}

// SlotSource and Game are the engine's types; a match stores them as JSON.
type (
	SlotSource = engine.SlotSource
	Game       = engine.Game
)

type Match struct {
	ID            string
	TournamentID  string
	Stage         string // group | knockout
	GroupID       *string
	RoundIndex    int
	RoundName     *string
	Seq           int
	TeamAID       *string
	TeamBID       *string
	SourceA       SlotSource
	SourceB       SlotSource
	CourtID       *string
	Status        string // pending | ready | live | completed | cancelled
	ResultState   string // none | final | voided
	ResultType    string // normal | bye | walkover | retired | cancelled
	WinnerTeamID  *string
	RetiredTeamID *string
	Games         []Game
	GamesWonA     int
	GamesWonB     int
	QueuePosition *int
	OnHold        bool
	StartedAt     *time.Time
	EndedAt       *time.Time
	CorrectedAt   *time.Time
	Version       int
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// ── loaders ───────────────────────────────────────────────────────────────

const tournamentCols = `id, venue_id, name, slug, to_char(day, 'YYYY-MM-DD'), gender, discipline, finals_stage,
	best_of, points_to_win, advance_per_group, status, registration_closed_at, draw_made_at, started_at,
	paused_at, pause_note, finished_at, winner_team_id, runner_up_team_id, seed_order, version, created_at, updated_at`

func scanTournament(row interface{ Scan(dest ...any) error }) (*Tournament, error) {
	var t Tournament
	var regClosed, drawMade, started, paused, finished sql.NullTime
	var pauseNote, winner, runnerUp sql.NullString
	var seed []byte
	err := row.Scan(&t.ID, &t.VenueID, &t.Name, &t.Slug, &t.Day, &t.Gender, &t.Discipline, &t.FinalsStage,
		&t.BestOf, &t.PointsToWin, &t.AdvancePerGroup, &t.Status, &regClosed, &drawMade, &started,
		&paused, &pauseNote, &finished, &winner, &runnerUp, &seed, &t.Version, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return nil, db.NoRows(err)
	}
	t.RegistrationClosedAt = core.TimePtr(regClosed)
	t.DrawMadeAt = core.TimePtr(drawMade)
	t.StartedAt = core.TimePtr(started)
	t.PausedAt = core.TimePtr(paused)
	t.PauseNote = core.StrPtr(pauseNote)
	t.FinishedAt = core.TimePtr(finished)
	t.WinnerTeamID = core.StrPtr(winner)
	t.RunnerUpTeamID = core.StrPtr(runnerUp)
	if len(seed) > 0 {
		_ = json.Unmarshal(seed, &t.SeedOrder)
	}
	return &t, nil
}

// TournamentBySlug returns db.ErrNotFound for an unknown or deleted slug.
func TournamentBySlug(ctx context.Context, q core.Querier, venueID, slug string) (*Tournament, error) {
	return scanTournament(q.QueryRowContext(ctx,
		`select `+tournamentCols+` from tournaments where venue_id = $1 and slug = $2 and deleted_at is null`, venueID, slug))
}

// TournamentByID returns db.ErrNotFound for an unknown or deleted id.
func TournamentByID(ctx context.Context, q core.Querier, venueID, id string) (*Tournament, error) {
	return scanTournament(q.QueryRowContext(ctx,
		`select `+tournamentCols+` from tournaments where venue_id = $1 and id = $2 and deleted_at is null`, venueID, id))
}

// TournamentByIDForUpdate locks the row for the rest of the transaction —
// every write that changes a tournament's state starts here, so two taps
// on two phones take turns.
func TournamentByIDForUpdate(ctx context.Context, tx *sql.Tx, venueID, id string) (*Tournament, error) {
	return scanTournament(tx.QueryRowContext(ctx,
		`select `+tournamentCols+` from tournaments where venue_id = $1 and id = $2 and deleted_at is null for update`, venueID, id))
}

// TournamentsOnDay lists a venue's tournaments for one day key, oldest first.
func TournamentsOnDay(ctx context.Context, q core.Querier, venueID, dayKey string) ([]*Tournament, error) {
	rows, err := q.QueryContext(ctx,
		`select `+tournamentCols+` from tournaments where venue_id = $1 and day = $2::date and deleted_at is null order by created_at`,
		venueID, dayKey)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Tournament
	for rows.Next() {
		t, err := scanTournament(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// VenueCourts lists the venue's courts in order; activeOnly drops the ones
// taken out.
func VenueCourts(ctx context.Context, q core.Querier, venueID string, activeOnly bool) ([]Court, error) {
	where := ``
	if activeOnly {
		where = ` and active`
	}
	rows, err := q.QueryContext(ctx,
		`select id, venue_id, name, sort_order, color_key, active from courts where venue_id = $1`+where+` order by sort_order, name`, venueID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Court
	for rows.Next() {
		var c Court
		if err := rows.Scan(&c.ID, &c.VenueID, &c.Name, &c.SortOrder, &c.ColorKey, &c.Active); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// TournamentCourts lists the courts a tournament holds, in venue order.
func TournamentCourts(ctx context.Context, q core.Querier, tournamentID string) ([]Court, error) {
	rows, err := q.QueryContext(ctx, `
		select c.id, c.venue_id, c.name, c.sort_order, c.color_key, c.active
		from tournament_courts tc join courts c on c.id = tc.court_id
		where tc.tournament_id = $1 order by c.sort_order, c.name`, tournamentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Court
	for rows.Next() {
		var c Court
		if err := rows.Scan(&c.ID, &c.VenueID, &c.Name, &c.SortOrder, &c.ColorKey, &c.Active); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// Roster lists who is in, in arrival order.
func Roster(ctx context.Context, q core.Querier, tournamentID string) ([]TournamentPlayer, error) {
	rows, err := q.QueryContext(ctx, `
		select tp.id, tp.tournament_id, p.id, p.name, p.name_key, p.phone, p.phone_key,
		       tp.source, tp.partner_wish, tp.partner_player_id, tp.created_at
		from tournament_players tp join players p on p.id = tp.player_id
		where tp.tournament_id = $1 and p.deleted_at is null
		order by tp.created_at, tp.id`, tournamentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TournamentPlayer
	for rows.Next() {
		var tp TournamentPlayer
		var phone, phoneKey, wish, partner sql.NullString
		if err := rows.Scan(&tp.ID, &tp.TournamentID, &tp.Player.ID, &tp.Player.Name, &tp.Player.NameKey,
			&phone, &phoneKey, &tp.Source, &wish, &partner, &tp.CreatedAt); err != nil {
			return nil, err
		}
		tp.Player.Phone = core.StrPtr(phone)
		tp.Player.PhoneKey = core.StrPtr(phoneKey)
		tp.PartnerWish = core.StrPtr(wish)
		tp.PartnerPlayerID = core.StrPtr(partner)
		out = append(out, tp)
	}
	return out, rows.Err()
}

// Groups lists a tournament's pools in order.
func Groups(ctx context.Context, q core.Querier, tournamentID string) ([]Group, error) {
	rows, err := q.QueryContext(ctx,
		`select id, tournament_id, name, advance_count, sort_order from groups where tournament_id = $1 order by sort_order, name`, tournamentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Group
	for rows.Next() {
		var g Group
		if err := rows.Scan(&g.ID, &g.TournamentID, &g.Name, &g.AdvanceCount, &g.SortOrder); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// Teams lists a tournament's teams with their players, in the order the
// pairs were made (created_at, id).
func Teams(ctx context.Context, q core.Querier, tournamentID string) ([]Team, error) {
	rows, err := q.QueryContext(ctx, `
		select id, tournament_id, group_id, name, seed, status, withdrawn_at
		from teams where tournament_id = $1 order by created_at, id`, tournamentID)
	if err != nil {
		return nil, err
	}
	var out []Team
	index := map[string]int{}
	for rows.Next() {
		var t Team
		var group sql.NullString
		var seed sql.NullInt64
		var withdrawn sql.NullTime
		if err := rows.Scan(&t.ID, &t.TournamentID, &group, &t.Name, &seed, &t.Status, &withdrawn); err != nil {
			rows.Close()
			return nil, err
		}
		t.GroupID = core.StrPtr(group)
		if seed.Valid {
			s := int(seed.Int64)
			t.Seed = &s
		}
		t.WithdrawnAt = core.TimePtr(withdrawn)
		index[t.ID] = len(out)
		out = append(out, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return out, nil
	}
	prows, err := q.QueryContext(ctx, `
		select tp.team_id, p.id, p.name, p.name_key, p.phone, p.phone_key
		from team_players tp join players p on p.id = tp.player_id join teams t on t.id = tp.team_id
		where t.tournament_id = $1 order by tp.team_id, tp.position`, tournamentID)
	if err != nil {
		return nil, err
	}
	defer prows.Close()
	for prows.Next() {
		var teamID string
		var p Player
		var phone, phoneKey sql.NullString
		if err := prows.Scan(&teamID, &p.ID, &p.Name, &p.NameKey, &phone, &phoneKey); err != nil {
			return nil, err
		}
		p.Phone = core.StrPtr(phone)
		p.PhoneKey = core.StrPtr(phoneKey)
		if i, ok := index[teamID]; ok {
			out[i].Players = append(out[i].Players, p)
		}
	}
	return out, prows.Err()
}

// TeamNames is id → display name for a tournament.
func TeamNames(ctx context.Context, q core.Querier, tournamentID string) (map[string]string, error) {
	rows, err := q.QueryContext(ctx, `select id, name from teams where tournament_id = $1`, tournamentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		out[id] = name
	}
	return out, rows.Err()
}

const matchCols = `id, tournament_id, stage, group_id, round_index, round_name, seq, team_a_id, team_b_id,
	source_a, source_b, court_id, status, result_state, result_type, winner_team_id, retired_team_id, games,
	games_won_a, games_won_b, queue_position, on_hold, started_at, ended_at, corrected_at, version, created_at, updated_at`

func scanMatch(row interface{ Scan(dest ...any) error }) (*Match, error) {
	var m Match
	var group, roundName, teamA, teamB, court, winner, retired sql.NullString
	var queue sql.NullInt64
	var started, ended, corrected sql.NullTime
	var srcA, srcB, games []byte
	err := row.Scan(&m.ID, &m.TournamentID, &m.Stage, &group, &m.RoundIndex, &roundName, &m.Seq, &teamA, &teamB,
		&srcA, &srcB, &court, &m.Status, &m.ResultState, &m.ResultType, &winner, &retired, &games,
		&m.GamesWonA, &m.GamesWonB, &queue, &m.OnHold, &started, &ended, &corrected, &m.Version, &m.CreatedAt, &m.UpdatedAt)
	if err != nil {
		return nil, db.NoRows(err)
	}
	m.GroupID = core.StrPtr(group)
	m.RoundName = core.StrPtr(roundName)
	m.TeamAID = core.StrPtr(teamA)
	m.TeamBID = core.StrPtr(teamB)
	m.CourtID = core.StrPtr(court)
	m.WinnerTeamID = core.StrPtr(winner)
	m.RetiredTeamID = core.StrPtr(retired)
	if queue.Valid {
		v := int(queue.Int64)
		m.QueuePosition = &v
	}
	m.StartedAt = core.TimePtr(started)
	m.EndedAt = core.TimePtr(ended)
	m.CorrectedAt = core.TimePtr(corrected)
	_ = json.Unmarshal(srcA, &m.SourceA)
	_ = json.Unmarshal(srcB, &m.SourceB)
	if len(games) > 0 {
		_ = json.Unmarshal(games, &m.Games)
	}
	if m.Games == nil {
		m.Games = []Game{}
	}
	return &m, nil
}

// Matches lists a tournament's matches in draw order (round, seq).
func Matches(ctx context.Context, q core.Querier, tournamentID string) ([]*Match, error) {
	rows, err := q.QueryContext(ctx,
		`select `+matchCols+` from matches where tournament_id = $1 order by round_index, seq, created_at`, tournamentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Match
	for rows.Next() {
		m, err := scanMatch(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// MatchByID returns db.ErrNotFound when there is no such match.
func MatchByID(ctx context.Context, q core.Querier, id string) (*Match, error) {
	return scanMatch(q.QueryRowContext(ctx, `select `+matchCols+` from matches where id = $1`, id))
}

// MatchByIDForUpdate locks the match row.
func MatchByIDForUpdate(ctx context.Context, tx *sql.Tx, id string) (*Match, error) {
	return scanMatch(tx.QueryRowContext(ctx, `select `+matchCols+` from matches where id = $1 for update`, id))
}

// LiveMatchesOnDay lists every live match at the venue on a day, with its
// court — what the venue board and the "is that court busy" checks read.
func LiveMatchesOnDay(ctx context.Context, q core.Querier, venueID, dayKey string) ([]*Match, error) {
	rows, err := q.QueryContext(ctx, `
		select `+prefixed(matchCols, "m.")+` from matches m join tournaments t on t.id = m.tournament_id
		where t.venue_id = $1 and t.day = $2::date and t.deleted_at is null and m.status = 'live'
		order by m.started_at`, venueID, dayKey)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Match
	for rows.Next() {
		m, err := scanMatch(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func prefixed(cols, prefix string) string {
	parts := strings.Split(cols, ",")
	for i, p := range parts {
		parts[i] = prefix + strings.TrimSpace(p)
	}
	return strings.Join(parts, ", ")
}

// SaveGames writes a match's games and the derived counts; callers set the
// rest of the result in the same statement's transaction.
func SaveGames(ctx context.Context, q core.Querier, matchID string, games []Game, wonA, wonB int) error {
	if games == nil {
		games = []Game{}
	}
	b, err := json.Marshal(games)
	if err != nil {
		return err
	}
	_, err = q.ExecContext(ctx,
		`update matches set games = $2, games_won_a = $3, games_won_b = $4, version = version + 1, updated_at = now() where id = $1`,
		matchID, string(b), wonA, wonB)
	return err
}

// JSON renders a value for a jsonb column.
func JSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "null"
	}
	return string(b)
}

// ErrNotFound is re-exported so modules need only import store.
var ErrNotFound = db.ErrNotFound

// IsNotFound reports whether err is a missing row.
func IsNotFound(err error) bool { return errors.Is(err, db.ErrNotFound) }

// Placeholders builds "$n, $n+1, …" for an IN list.
func Placeholders(start, n int) string {
	parts := make([]string, n)
	for i := range parts {
		parts[i] = fmt.Sprintf("$%d", start+i)
	}
	return strings.Join(parts, ", ")
}
