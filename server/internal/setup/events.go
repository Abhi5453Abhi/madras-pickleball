package setup

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"mpb/internal/core"
	"mpb/internal/db"
	"mpb/internal/engine"
	"mpb/internal/ids"
	"mpb/internal/rpc"
	"mpb/internal/store"
)

// A tournament is one category — SPEC v4.
//
// "Men's Doubles" and "Mixed Doubles" on the same Sunday are two tournaments,
// each with its own players, format, courts and table. In this schema there is
// no categories table at all: the tournament IS the category.

var (
	genders     = map[string]bool{"mens": true, "womens": true, "mixed": true, "any": true}
	disciplines = map[string]bool{"singles": true, "doubles": true}
	formats     = map[string]bool{"none": true, "final_only": true, "semis_and_final": true}
)

// ── wire shapes ───────────────────────────────────────────────────────────

type dashboardRow struct {
	ID               string     `json:"id"`
	Slug             string     `json:"slug"`
	Name             string     `json:"name"`
	Day              string     `json:"day"`
	Status           string     `json:"status"`
	Category         string     `json:"category"`
	Discipline       string     `json:"discipline"`
	Format           string     `json:"format"`
	Players          int        `json:"players"`
	Teams            int        `json:"teams"`
	Courts           []courtOut `json:"courts"`
	MatchesTotal     int        `json:"matchesTotal"`
	MatchesPlayed    int        `json:"matchesPlayed"`
	MatchesLive      int        `json:"matchesLive"`
	RegistrationOpen bool       `json:"registrationOpen"`
	PendingSignups   int        `json:"pendingSignups"`
	WinnerName       *string    `json:"winnerName"`
}

type dashboardOut struct {
	Today    []dashboardRow `json:"today"`
	Upcoming []dashboardRow `json:"upcoming"`
	Finished []dashboardRow `json:"finished"`
}

type courtCalendarOut struct {
	Courts []courtOut `json:"courts"`
	Held   []heldOut  `json:"held"`
}

type heldOut struct {
	CourtID string `json:"courtId"`
	DayKey  string `json:"dayKey"`
	Name    string `json:"name"`
}

type createEventIn struct {
	Name       string   `json:"name"`
	Date       string   `json:"date"`
	Gender     string   `json:"gender"`
	Discipline string   `json:"discipline"`
	Format     string   `json:"format"`
	Courts     []string `json:"courts"`
}

type hubTournament struct {
	ID                   string  `json:"id"`
	Slug                 string  `json:"slug"`
	Name                 string  `json:"name"`
	Day                  string  `json:"day"`
	Status               string  `json:"status"`
	Gender               string  `json:"gender"`
	Discipline           string  `json:"discipline"`
	FinalsStage          string  `json:"finalsStage"`
	AdvancePerGroup      int     `json:"advancePerGroup"`
	BestOf               int     `json:"bestOf"`
	PointsToWin          int     `json:"pointsToWin"`
	RegistrationClosedAt *string `json:"registrationClosedAt"`
	PausedAt             *string `json:"pausedAt"`
	PauseNote            *string `json:"pauseNote"`
	UpdatedAt            string  `json:"updatedAt"`
}

type hubStep struct {
	Key    string `json:"key"`
	Title  string `json:"title"`
	Detail string `json:"detail"`
	State  string `json:"state"`
	Href   string `json:"href"`
}

type hubOut struct {
	Tournament     hubTournament `json:"tournament"`
	Courts         []courtOut    `json:"courts"`
	Players        int           `json:"players"`
	TeamsMade      int           `json:"teamsMade"`
	TeamsNeeded    int           `json:"teamsNeeded"`
	Unpaired       int           `json:"unpaired"`
	MatchesTotal   int           `json:"matchesTotal"`
	MatchesPlayed  int           `json:"matchesPlayed"`
	MatchesLive    int           `json:"matchesLive"`
	PendingSignups int           `json:"pendingSignups"`
	Steps          []hubStep     `json:"steps"`
	Phase          string        `json:"phase"`
}

type courtOptionOut struct {
	ID       string      `json:"id"`
	Name     string      `json:"name"`
	ColorKey string      `json:"colorKey"`
	TakenBy  *takenByOut `json:"takenBy"`
	Mine     bool        `json:"mine"`
}

type takenByOut struct {
	Name string `json:"name"`
}

type assignCourtsIn struct {
	TournamentID string   `json:"tournamentId"`
	CourtIDs     []string `json:"courtIds"`
}

type assignCourtsOut struct {
	OK    bool   `json:"ok"`
	Count int    `json:"count"`
	Error string `json:"error,omitempty"`
}

type slugIn struct {
	Slug string `json:"slug"`
}

func registerEvents(reg *rpc.Registry, d *core.Deps) {
	rpc.Register(reg, "events.dashboard", rpc.Organiser,
		func(ctx context.Context, _ struct{}) (dashboardOut, error) { return dashboard(ctx, d) })

	rpc.Register(reg, "events.courtCalendar", rpc.Organiser,
		func(ctx context.Context, _ struct{}) (courtCalendarOut, error) { return courtCalendar(ctx, d) })

	rpc.Register(reg, "events.createEvent", rpc.Organiser,
		func(ctx context.Context, in createEventIn) (redirectOut, error) { return createEvent(ctx, d, in) })

	rpc.Register(reg, "events.hub", rpc.Organiser,
		func(ctx context.Context, in slugIn) (hubOut, error) { return hub(ctx, d, in.Slug) })

	rpc.Register(reg, "events.courtOptions", rpc.Organiser,
		func(ctx context.Context, in tournamentIDIn) ([]courtOptionOut, error) {
			t, err := mustTournament(ctx, d, d.DB, in.TournamentID)
			if err != nil {
				return nil, err
			}
			return courtOptions(ctx, d.DB, d, t)
		})

	rpc.Register(reg, "events.assignCourts", rpc.Organiser,
		func(ctx context.Context, in assignCourtsIn) (assignCourtsOut, error) { return assignCourts(ctx, d, in) })

	rpc.Register(reg, "events.myCourts", rpc.Organiser,
		func(ctx context.Context, in tournamentIDIn) ([]courtOut, error) {
			t, err := mustTournament(ctx, d, d.DB, in.TournamentID)
			if err != nil {
				return nil, err
			}
			rows, err := store.TournamentCourts(ctx, d.DB, t.ID)
			if err != nil {
				return nil, err
			}
			return courtsOut(rows), nil
		})

	rpc.Register(reg, "events.closeRegistration", rpc.Organiser,
		func(ctx context.Context, in tournamentIDIn) (okOut, error) { return closeRegistration(ctx, d, in) })

	rpc.Register(reg, "events.reopenRegistration", rpc.Organiser,
		func(ctx context.Context, in tournamentIDIn) (okErrOut, error) { return reopenRegistration(ctx, d, in) })

	rpc.Register(reg, "events.startEvent", rpc.Organiser,
		func(ctx context.Context, in tournamentIDIn) (redirectOut, error) { return startEvent(ctx, d, in) })

	rpc.Register(reg, "events.finishEvent", rpc.Organiser,
		func(ctx context.Context, in tournamentIDIn) (redirectOut, error) { return finishEvent(ctx, d, in) })

	rpc.Register(reg, "events.deleteEvent", rpc.Organiser,
		func(ctx context.Context, in tournamentIDIn) (redirectOut, error) { return deleteEvent(ctx, d, in) })
}

// ── counts every screen asks for ──────────────────────────────────────────

type matchCounts struct {
	Total, Played, Live, NoResult int
}

func countMatches(ctx context.Context, q core.Querier, tournamentID string) (matchCounts, error) {
	var c matchCounts
	err := q.QueryRowContext(ctx, `
		select count(*)::int,
		       count(*) filter (where result_state = 'final')::int,
		       count(*) filter (where status = 'live')::int,
		       count(*) filter (where result_state = 'none')::int
		from matches where tournament_id = $1`, tournamentID).
		Scan(&c.Total, &c.Played, &c.Live, &c.NoResult)
	return c, err
}

func countOne(ctx context.Context, q core.Querier, query string, args ...any) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, query, args...).Scan(&n)
	return n, err
}

func countPlayers(ctx context.Context, q core.Querier, tournamentID string) (int, error) {
	return countOne(ctx, q, `select count(*)::int from tournament_players where tournament_id = $1`, tournamentID)
}

func countPendingSignups(ctx context.Context, q core.Querier, tournamentID string) (int, error) {
	return countOne(ctx, q,
		`select count(*)::int from pending_registrations where tournament_id = $1 and status = 'pending'`, tournamentID)
}

// ── the dashboard ─────────────────────────────────────────────────────────

func dashboard(ctx context.Context, d *core.Deps) (dashboardOut, error) {
	rows, err := d.DB.QueryContext(ctx, `
		select id, slug, name, to_char(day, 'YYYY-MM-DD'), status, gender, discipline, finals_stage,
		       registration_closed_at
		from tournaments where venue_id = $1 and deleted_at is null
		order by day desc, created_at asc limit 40`, d.Venue.ID)
	if err != nil {
		return dashboardOut{}, err
	}
	type row struct {
		dashboardRow
		regClosed bool
	}
	var list []row
	for rows.Next() {
		var r row
		var closed sql.NullTime
		var gender string
		if err := rows.Scan(&r.ID, &r.Slug, &r.Name, &r.Day, &r.Status, &gender, &r.Discipline,
			&r.Format, &closed); err != nil {
			rows.Close()
			return dashboardOut{}, err
		}
		r.Category = engine.CategoryName(gender, r.Discipline)
		r.regClosed = closed.Valid
		r.RegistrationOpen = r.Status != "completed" && !closed.Valid
		r.Courts = []courtOut{}
		list = append(list, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return dashboardOut{}, err
	}
	out := dashboardOut{Today: []dashboardRow{}, Upcoming: []dashboardRow{}, Finished: []dashboardRow{}}
	if len(list) == 0 {
		return out, nil
	}

	// One pass per fact, over the whole venue rather than a list of ids: a
	// venue has tens of tournaments, and forty round trips on the dashboard is
	// the slowest screen in the app for no reason.
	counts, err := scanCounts(ctx, d, `
		select m.tournament_id, count(*)::int, count(*) filter (where m.result_state = 'final')::int,
		       count(*) filter (where m.status = 'live')::int
		from matches m join tournaments t on t.id = m.tournament_id
		where t.venue_id = $1 and t.deleted_at is null group by m.tournament_id`, 3)
	if err != nil {
		return dashboardOut{}, err
	}
	players, err := scanCounts(ctx, d, `
		select tp.tournament_id, count(*)::int from tournament_players tp
		join tournaments t on t.id = tp.tournament_id
		where t.venue_id = $1 and t.deleted_at is null group by tp.tournament_id`, 1)
	if err != nil {
		return dashboardOut{}, err
	}
	teamCounts, err := scanCounts(ctx, d, `
		select tm.tournament_id, count(*)::int from teams tm join tournaments t on t.id = tm.tournament_id
		where t.venue_id = $1 and t.deleted_at is null and tm.status <> 'withdrawn' group by tm.tournament_id`, 1)
	if err != nil {
		return dashboardOut{}, err
	}
	pending, err := scanCounts(ctx, d, `
		select pr.tournament_id, count(*)::int from pending_registrations pr
		join tournaments t on t.id = pr.tournament_id
		where t.venue_id = $1 and t.deleted_at is null and pr.status = 'pending' group by pr.tournament_id`, 1)
	if err != nil {
		return dashboardOut{}, err
	}
	courtsBy, err := courtsByTournament(ctx, d)
	if err != nil {
		return dashboardOut{}, err
	}

	todayKey := core.DayKey(d.Now())
	for i := range list {
		r := &list[i]
		if c, ok := counts[r.ID]; ok {
			r.MatchesTotal, r.MatchesPlayed, r.MatchesLive = c[0], c[1], c[2]
		}
		if n, ok := players[r.ID]; ok {
			r.Players = n[0]
		}
		if n, ok := teamCounts[r.ID]; ok {
			r.Teams = n[0]
		}
		if n, ok := pending[r.ID]; ok {
			r.PendingSignups = n[0]
		}
		if cs, ok := courtsBy[r.ID]; ok {
			r.Courts = cs
		}
		if r.Status == "completed" {
			name, err := winnerNameFor(ctx, d, r.ID)
			if err != nil {
				return dashboardOut{}, err
			}
			r.WinnerName = name
		}

		switch {
		case r.Status == "completed":
			out.Finished = append(out.Finished, r.dashboardRow)
		case r.Day == todayKey || r.Status == "live":
			out.Today = append(out.Today, r.dashboardRow)
		case r.Day > todayKey:
			out.Upcoming = append(out.Upcoming, r.dashboardRow)
		default:
			// A past day that was never closed off.
			out.Finished = append(out.Finished, r.dashboardRow)
		}
	}
	// Soonest first: the next thing on is the one the organiser is thinking
	// about, and the list arrives newest day first.
	for i := 0; i < len(out.Upcoming); i++ {
		for j := i + 1; j < len(out.Upcoming); j++ {
			if out.Upcoming[j].Day < out.Upcoming[i].Day {
				out.Upcoming[i], out.Upcoming[j] = out.Upcoming[j], out.Upcoming[i]
			}
		}
	}
	return out, nil
}

// scanCounts reads "id, n[, n…]" rows into a map keyed by the first column.
func scanCounts(ctx context.Context, d *core.Deps, query string, cols int) (map[string][]int, error) {
	rows, err := d.DB.QueryContext(ctx, query, d.Venue.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]int{}
	for rows.Next() {
		var id string
		vals := make([]int, cols)
		dest := make([]any, 0, cols+1)
		dest = append(dest, &id)
		for i := range vals {
			dest = append(dest, &vals[i])
		}
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		out[id] = vals
	}
	return out, rows.Err()
}

func courtsByTournament(ctx context.Context, d *core.Deps) (map[string][]courtOut, error) {
	rows, err := d.DB.QueryContext(ctx, `
		select tc.tournament_id, c.id, c.name, c.color_key
		from tournament_courts tc join courts c on c.id = tc.court_id
		join tournaments t on t.id = tc.tournament_id
		where t.venue_id = $1 and t.deleted_at is null
		order by c.sort_order, c.name`, d.Venue.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]courtOut{}
	for rows.Next() {
		var tid string
		var c courtOut
		if err := rows.Scan(&tid, &c.ID, &c.Name, &c.ColorKey); err != nil {
			return nil, err
		}
		out[tid] = append(out[tid], c)
	}
	return out, rows.Err()
}

// winnerNameFor is the winner of the last knockout match, or — where the
// format is "everyone plays everyone" and there is no final — the top of the
// final table. The dashboard used to say nothing at all for a league.
func winnerNameFor(ctx context.Context, d *core.Deps, tournamentID string) (*string, error) {
	var name string
	err := d.DB.QueryRowContext(ctx, `
		select tm.name from matches m join teams tm on tm.id = m.winner_team_id
		where m.tournament_id = $1 and m.stage = 'knockout' and m.winner_team_id is not null
		order by m.round_index desc, m.seq desc limit 1`, tournamentID).Scan(&name)
	if err == nil {
		return &name, nil
	}
	if err != sql.ErrNoRows {
		return nil, err
	}
	top, _, err := tableTop(ctx, d.DB, tournamentID)
	if err != nil || top == "" {
		return nil, err
	}
	if err := d.DB.QueryRowContext(ctx, `select name from teams where id = $1`, top).Scan(&name); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return &name, nil
}

// tableTop is the top two of the table, for the winner and runner-up of a
// tournament that ends without a final.
func tableTop(ctx context.Context, q core.Querier, tournamentID string) (string, string, error) {
	teams, err := store.Teams(ctx, q, tournamentID)
	if err != nil {
		return "", "", err
	}
	ids_ := make([]string, 0, len(teams))
	for _, t := range teams {
		ids_ = append(ids_, t.ID)
	}
	if len(ids_) == 0 {
		return "", "", nil
	}
	sm, err := store.StandingsMatches(ctx, q, tournamentID, "")
	if err != nil {
		return "", "", err
	}
	rows := engine.Standings(ids_, sm, engine.PointsScoredFirst)
	first, second := "", ""
	if len(rows) > 0 {
		first = rows[0].TeamID
	}
	if len(rows) > 1 {
		second = rows[1].TeamID
	}
	return first, second, nil
}

// ── courts ────────────────────────────────────────────────────────────────

func courtCalendar(ctx context.Context, d *core.Deps) (courtCalendarOut, error) {
	courts, err := store.VenueCourts(ctx, d.DB, d.Venue.ID, true)
	if err != nil {
		return courtCalendarOut{}, err
	}
	rows, err := d.DB.QueryContext(ctx, `
		select tc.court_id, tc.day_key, t.name
		from tournament_courts tc join tournaments t on t.id = tc.tournament_id
		where t.venue_id = $1 and tc.day_key >= $2 and t.deleted_at is null and t.status <> 'completed'
		order by tc.day_key, t.created_at`, d.Venue.ID, core.DayKey(d.Now()))
	if err != nil {
		return courtCalendarOut{}, err
	}
	defer rows.Close()
	held := []heldOut{}
	for rows.Next() {
		var h heldOut
		if err := rows.Scan(&h.CourtID, &h.DayKey, &h.Name); err != nil {
			return courtCalendarOut{}, err
		}
		held = append(held, h)
	}
	if err := rows.Err(); err != nil {
		return courtCalendarOut{}, err
	}
	return courtCalendarOut{Courts: courtsOut(courts), Held: held}, nil
}

// courtOptions is every court at the venue with who holds it on THIS
// tournament's day. A court another tournament holds is shown, named and not
// pickable — to use it the organiser takes it off the other tournament first.
// No lending. A finished tournament has let go of its courts: Men's Doubles
// wrapping up at three frees Court 1 for whatever the evening is.
func courtOptions(ctx context.Context, q core.Querier, d *core.Deps, t *store.Tournament) ([]courtOptionOut, error) {
	courts, err := store.VenueCourts(ctx, q, d.Venue.ID, true)
	if err != nil {
		return nil, err
	}
	rows, err := q.QueryContext(ctx, `
		select tc.court_id, tc.tournament_id, h.name
		from tournament_courts tc join tournaments h on h.id = tc.tournament_id
		where tc.day_key = $1 and h.venue_id = $2 and h.deleted_at is null and h.status <> 'completed'`,
		t.Day, d.Venue.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type holder struct{ tournamentID, name string }
	byCourt := map[string]holder{}
	for rows.Next() {
		var courtID string
		var h holder
		if err := rows.Scan(&courtID, &h.tournamentID, &h.name); err != nil {
			return nil, err
		}
		byCourt[courtID] = h
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]courtOptionOut, 0, len(courts))
	for _, c := range courts {
		o := courtOptionOut{ID: c.ID, Name: c.Name, ColorKey: c.ColorKey}
		if h, ok := byCourt[c.ID]; ok {
			if h.tournamentID == t.ID {
				o.Mine = true
			} else {
				o.TakenBy = &takenByOut{Name: h.name}
			}
		}
		out = append(out, o)
	}
	return out, nil
}

// assignCourts sets a tournament's courts to exactly this list. A court
// missing from the list is given up; a court another tournament holds that day
// is refused and named — the organiser resolves that on the other tournament,
// deliberately, rather than this one silently taking it.
func assignCourts(ctx context.Context, d *core.Deps, in assignCourtsIn) (assignCourtsOut, error) {
	var out assignCourtsOut
	err := d.Tx(ctx, func(tx *sql.Tx) error {
		t, err := lockTournament(ctx, tx, d, in.TournamentID)
		if err != nil {
			return err
		}
		msg, count, err := setCourts(ctx, tx, d, t, in.CourtIDs)
		if err != nil {
			return err
		}
		if msg != "" {
			out = assignCourtsOut{Error: msg}
			return nil
		}
		if err := core.Bump(ctx, tx, t.ID); err != nil {
			return err
		}
		out = assignCourtsOut{OK: true, Count: count}
		// A court added to a running tournament is a free court: fill it.
		return flow(ctx, tx, d, t.ID)
	})
	if err != nil {
		return assignCourtsOut{}, err
	}
	return out, nil
}

// setCourts is the write itself, inside a transaction that already holds the
// tournament row. Returns a refusal sentence, or "" and the new count.
func setCourts(ctx context.Context, tx *sql.Tx, d *core.Deps, t *store.Tournament, wanted []string) (string, int, error) {
	seen := map[string]bool{}
	var list []string
	for _, id := range wanted {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		list = append(list, id)
	}

	options, err := courtOptions(ctx, tx, d, t)
	if err != nil {
		return "", 0, err
	}
	byID := map[string]courtOptionOut{}
	for _, o := range options {
		byID[o.ID] = o
	}
	for _, id := range list {
		o, ok := byID[id]
		if !ok {
			return "That court is not at this venue.", 0, nil
		}
		if o.TakenBy != nil {
			return o.Name + " belongs to " + o.TakenBy.Name + " that day. Take it off there first.", 0, nil
		}
	}

	// A court being taken off with a live match on it is not ours to pull away
	// from under the players.
	var dropping []string
	for _, o := range options {
		if o.Mine && !seen[o.ID] {
			dropping = append(dropping, o.ID)
		}
	}
	if len(dropping) > 0 {
		args := append([]any{t.ID}, toAny(dropping)...)
		var courtName string
		err := tx.QueryRowContext(ctx, `
			select c.name from matches m join courts c on c.id = m.court_id
			where m.tournament_id = $1 and m.status = 'live'
			  and m.court_id in (`+store.Placeholders(2, len(dropping))+`) limit 1`, args...).Scan(&courtName)
		if err == nil {
			return "There is a match on " + courtName + " right now. Let it finish, then take the court off.", 0, nil
		}
		if err != sql.ErrNoRows {
			return "", 0, err
		}
	}

	if _, err := tx.ExecContext(ctx, `delete from tournament_courts where tournament_id = $1`, t.ID); err != nil {
		return "", 0, err
	}
	if len(list) > 0 {
		// courtOptions says a finished tournament has let go of its courts,
		// but its rows still sit under the one-court-per-day index. They are
		// released here, at the moment somebody actually takes the court —
		// otherwise the insert below was a raw constraint error on the
		// afternoon Men's Doubles finished and the evening's was made.
		args := append([]any{t.Day}, toAny(list)...)
		if _, err := tx.ExecContext(ctx, `
			delete from tournament_courts tc using tournaments h
			where h.id = tc.tournament_id and tc.day_key = $1
			  and tc.court_id in (`+store.Placeholders(2, len(list))+`)
			  and (h.status = 'completed' or h.deleted_at is not null)`, args...); err != nil {
			return "", 0, err
		}
		for _, id := range list {
			if _, err := tx.ExecContext(ctx,
				`insert into tournament_courts (tournament_id, court_id, day_key) values ($1, $2, $3)`,
				t.ID, id, t.Day); err != nil {
				// The unique index is the whole of the "never lend a court"
				// rule; a race that loses it becomes the same sentence the
				// check above would have given.
				if db.IsUniqueViolation(err) {
					return byID[id].Name + " belongs to another tournament that day. Take it off there first.", 0, nil
				}
				return "", 0, err
			}
		}
	}
	if err := core.Audit(ctx, tx, actor(ctx), "tournament.courts", "tournament", t.ID, "",
		map[string]any{"courts": list}); err != nil {
		return "", 0, err
	}
	return "", len(list), nil
}

// ── making one ────────────────────────────────────────────────────────────

// slugify is the reference's: the name, normalised, plus four random
// characters, so two "Men's Doubles" in one month are two URLs.
func slugify(name string) string {
	base := strings.ReplaceAll(engine.NormalizeName(name), " ", "-")
	if r := []rune(base); len(r) > 40 {
		base = string(r[:40])
	}
	if base == "" {
		base = "tournament"
	}
	return base + "-" + ids.New("")[:4]
}

func createEvent(ctx context.Context, d *core.Deps, in createEventIn) (redirectOut, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return refuseGo("Give it a name — you can change it later."), nil
	}
	day := strings.TrimSpace(in.Date)
	if _, err := time.ParseInLocation("2006-01-02", day, core.IST); err != nil || len(day) != 10 {
		return refuseGo("Pick the day it is on."), nil
	}
	if day < core.DayKey(d.Now()) {
		return refuseGo("That day has already gone."), nil
	}
	if !genders[in.Gender] {
		return refuseGo("Pick a category."), nil
	}
	if !disciplines[in.Discipline] {
		return refuseGo("Singles or doubles?"), nil
	}
	if !formats[in.Format] {
		return refuseGo("Pick a format."), nil
	}

	id := ids.New("trn")
	slug := slugify(name)
	err := d.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `
			insert into tournaments (id, venue_id, name, slug, day, gender, discipline, finals_stage, status)
			values ($1, $2, $3, $4, $5::date, $6, $7, $8, 'setup')`,
			id, d.Venue.ID, name, slug, day, in.Gender, in.Discipline, in.Format); err != nil {
			return err
		}
		// Sign-ups open the moment it exists: the link is the first thing the
		// organiser wants, and "draft" was a state nobody could explain.
		if _, err := newRegistrationToken(ctx, tx, id); err != nil {
			return err
		}
		return core.Audit(ctx, tx, actor(ctx), "tournament.create", "tournament", id, "",
			map[string]any{"name": name, "day": day, "gender": in.Gender,
				"discipline": in.Discipline, "format": in.Format, "courts": len(in.Courts)})
	})
	if err != nil {
		return redirectOut{}, err
	}

	// The courts are a second write on purpose: if one of them turns out to
	// belong to another tournament that day the tournament is still made —
	// better than the reverse — and the redirect carries the refusal.
	courts, err := assignCourts(ctx, d, assignCourtsIn{TournamentID: id, CourtIDs: in.Courts})
	if err != nil {
		return redirectOut{}, err
	}
	if !courts.OK {
		return goTo("/admin/t/" + slug + "?courts=" + urlQueryEscape(courts.Error)), nil
	}
	return goTo("/admin/t/" + slug), nil
}

// urlQueryEscape is encodeURIComponent for the one message that travels in a
// redirect. net/url's QueryEscape turns a space into "+", which reads as a
// plus on the screen that prints it.
func urlQueryEscape(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for _, c := range []byte(s) {
		switch {
		case (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'),
			c == '-', c == '_', c == '.', c == '!', c == '~', c == '*', c == '\'', c == '(', c == ')':
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&0x0f])
		}
	}
	return b.String()
}

// ── the hub ───────────────────────────────────────────────────────────────

func hubTournamentOf(t *store.Tournament) hubTournament {
	return hubTournament{
		ID: t.ID, Slug: t.Slug, Name: t.Name, Day: t.Day, Status: t.Status,
		Gender: t.Gender, Discipline: t.Discipline, FinalsStage: t.FinalsStage,
		AdvancePerGroup: t.AdvancePerGroup, BestOf: t.BestOf, PointsToWin: t.PointsToWin,
		RegistrationClosedAt: core.ISO(t.RegistrationClosedAt),
		PausedAt:             core.ISO(t.PausedAt),
		PauseNote:            t.PauseNote,
		UpdatedAt:            t.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func hub(ctx context.Context, d *core.Deps, slug string) (hubOut, error) {
	t, err := mustTournamentBySlug(ctx, d, slug)
	if err != nil {
		return hubOut{}, err
	}
	// Before anything is counted: mutual pairs and singles' teams of one are
	// settled, or the Teams step reads "0 of 4 pairs made" for a list where
	// two pairs have already named each other.
	if err := settleIfNeeded(ctx, d, t); err != nil {
		return hubOut{}, err
	}
	// Re-read: settling bumps the version, and `updatedAt` is on the screen.
	t, err = mustTournamentBySlug(ctx, d, slug)
	if err != nil {
		return hubOut{}, err
	}

	courts, err := store.TournamentCourts(ctx, d.DB, t.ID)
	if err != nil {
		return hubOut{}, err
	}
	players, err := countPlayers(ctx, d.DB, t.ID)
	if err != nil {
		return hubOut{}, err
	}
	teamsMade, err := countOne(ctx, d.DB,
		`select count(*)::int from teams where tournament_id = $1 and status <> 'withdrawn'`, t.ID)
	if err != nil {
		return hubOut{}, err
	}
	pairedPlayers, err := countOne(ctx, d.DB, `
		select count(distinct tp.player_id)::int from team_players tp join teams tm on tm.id = tp.team_id
		where tm.tournament_id = $1 and tm.status <> 'withdrawn'`, t.ID)
	if err != nil {
		return hubOut{}, err
	}
	counts, err := countMatches(ctx, d.DB, t.ID)
	if err != nil {
		return hubOut{}, err
	}
	pending, err := countPendingSignups(ctx, d.DB, t.ID)
	if err != nil {
		return hubOut{}, err
	}

	size := teamSizeOf(t)
	teamsNeeded := players / size
	unpaired := players - pairedPlayers
	if unpaired < 0 {
		unpaired = 0
	}

	phase := "setup"
	switch t.Status {
	case "completed":
		phase = "finished"
	case "live":
		phase = "running"
	}

	base := "/admin/t/" + t.Slug
	regDone := players >= size*2
	teamsDone := regDone
	if t.Discipline != "singles" {
		teamsDone = teamsMade >= 2 && unpaired == 0
	}
	scheduleDone := counts.Total > 0 && len(courts) > 0

	regDetail := fmt.Sprintf("%d %s in · %s", players, plural(players, "player", "players"),
		map[bool]string{true: "sign-ups closed", false: "link is open"}[t.RegistrationClosedAt != nil])
	if pending > 0 {
		regDetail += fmt.Sprintf(" · %d possible %s", pending, plural(pending, "duplicate", "duplicates"))
	}

	teamsTitle := "Teams"
	teamsDetail := ""
	if t.Discipline == "singles" {
		teamsTitle = "Players"
		teamsDetail = fmt.Sprintf("%d in the draw", players)
	} else if teamsNeeded == 0 {
		teamsDetail = "Once players are in"
	} else {
		teamsDetail = fmt.Sprintf("%d of %d pairs made", teamsMade, teamsNeeded)
		if unpaired > 0 {
			teamsDetail += fmt.Sprintf(" · %d %s still to pair", unpaired, plural(unpaired, "player", "players"))
		}
	}

	courtNames := make([]string, 0, len(courts))
	for _, c := range courts {
		courtNames = append(courtNames, c.Name)
	}
	scheduleDetail := "no courts yet"
	if len(courtNames) > 0 {
		scheduleDetail = strings.Join(courtNames, ", ")
	}
	if counts.Total > 0 {
		scheduleDetail += fmt.Sprintf(" · %d matches", counts.Total)
	} else {
		scheduleDetail += " · schedule not made yet"
	}

	state := func(done, previousDone bool) string {
		switch {
		case done:
			return "done"
		case previousDone:
			return "current"
		default:
			return "todo"
		}
	}
	startDetail := "Once the schedule is made"
	if scheduleDone {
		startDetail = "Everything is ready"
	}

	steps := []hubStep{
		{Key: "registration", Title: "Registration", Detail: regDetail,
			State: state(regDone, true), Href: base + "/registration"},
		{Key: "teams", Title: teamsTitle, Detail: teamsDetail,
			State: state(teamsDone, regDone), Href: base + "/teams"},
		{Key: "schedule", Title: "Schedule & courts", Detail: scheduleDetail,
			State: state(scheduleDone, teamsDone), Href: base + "/schedule"},
		{Key: "start", Title: "Start", Detail: startDetail,
			State: state(phase != "setup", scheduleDone), Href: base + "/schedule"},
	}

	return hubOut{
		Tournament:     hubTournamentOf(t),
		Courts:         courtsOut(courts),
		Players:        players,
		TeamsMade:      teamsMade,
		TeamsNeeded:    teamsNeeded,
		Unpaired:       unpaired,
		MatchesTotal:   counts.Total,
		MatchesPlayed:  counts.Played,
		MatchesLive:    counts.Live,
		PendingSignups: pending,
		Steps:          steps,
		Phase:          phase,
	}, nil
}

// ── registration open and closed ──────────────────────────────────────────

func closeRegistration(ctx context.Context, d *core.Deps, in tournamentIDIn) (okOut, error) {
	err := d.Tx(ctx, func(tx *sql.Tx) error {
		t, err := lockTournament(ctx, tx, d, in.TournamentID)
		if err != nil {
			return err
		}
		// Idempotent: closing twice must not move the time it closed at.
		if _, err := tx.ExecContext(ctx,
			`update tournaments set registration_closed_at = coalesce(registration_closed_at, $2) where id = $1`,
			t.ID, d.Now()); err != nil {
			return err
		}
		if err := core.Audit(ctx, tx, actor(ctx), "registration.closed", "tournament", t.ID, "", nil); err != nil {
			return err
		}
		return core.Bump(ctx, tx, t.ID)
	})
	if err != nil {
		return okOut{}, err
	}
	return okOut{OK: true}, nil
}

func reopenRegistration(ctx context.Context, d *core.Deps, in tournamentIDIn) (okErrOut, error) {
	var out okErrOut
	err := d.Tx(ctx, func(tx *sql.Tx) error {
		t, err := lockTournament(ctx, tx, d, in.TournamentID)
		if err != nil {
			return err
		}
		if t.Status != "setup" {
			out = okErrOut{Error: "The tournament has started, so sign-ups stay closed."}
			return nil
		}
		if _, err := tx.ExecContext(ctx,
			`update tournaments set registration_closed_at = null where id = $1`, t.ID); err != nil {
			return err
		}
		if err := core.Audit(ctx, tx, actor(ctx), "registration.reopened", "tournament", t.ID, "", nil); err != nil {
			return err
		}
		out = okErrOut{OK: true}
		return core.Bump(ctx, tx, t.ID)
	})
	if err != nil {
		return okErrOut{}, err
	}
	return out, nil
}

// ── start, finish, delete ─────────────────────────────────────────────────

func startEvent(ctx context.Context, d *core.Deps, in tournamentIDIn) (redirectOut, error) {
	var out redirectOut
	err := d.Tx(ctx, func(tx *sql.Tx) error {
		t, err := lockTournament(ctx, tx, d, in.TournamentID)
		if err != nil {
			return err
		}
		counts, err := countMatches(ctx, tx, t.ID)
		if err != nil {
			return err
		}
		if counts.Total == 0 {
			out = refuseGo("Make the schedule first.")
			return nil
		}
		courts, err := store.TournamentCourts(ctx, tx, t.ID)
		if err != nil {
			return err
		}
		if len(courts) == 0 {
			out = refuseGo("Give it at least one court first.")
			return nil
		}
		// Starting closes sign-ups: the draw is made and a new name would have
		// nowhere to go.
		if _, err := tx.ExecContext(ctx, `
			update tournaments set status = 'live', started_at = coalesce(started_at, $2),
			       registration_closed_at = coalesce(registration_closed_at, $2)
			where id = $1`, t.ID, d.Now()); err != nil {
			return err
		}
		if err := core.Audit(ctx, tx, actor(ctx), "tournament.start", "tournament", t.ID, "", nil); err != nil {
			return err
		}
		if err := core.Bump(ctx, tx, t.ID); err != nil {
			return err
		}
		out = goTo("/admin/live")
		// Off we go: the first matches in order go straight onto every court
		// the tournament holds. The organiser's next job is a score.
		return flow(ctx, tx, d, t.ID)
	})
	if err != nil {
		return redirectOut{}, err
	}
	return out, nil
}

func finishEvent(ctx context.Context, d *core.Deps, in tournamentIDIn) (redirectOut, error) {
	var out redirectOut
	err := d.Tx(ctx, func(tx *sql.Tx) error {
		t, err := lockTournament(ctx, tx, d, in.TournamentID)
		if err != nil {
			return err
		}
		counts, err := countMatches(ctx, tx, t.ID)
		if err != nil {
			return err
		}
		if counts.NoResult > 0 {
			out = refuseGo(fmt.Sprintf("%d %s no result yet.", counts.NoResult,
				plural(counts.NoResult, "match has", "matches have")))
			return nil
		}
		winner, runnerUp, err := finalPlaces(ctx, tx, t.ID)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			update tournaments set status = 'completed', finished_at = $2,
			       winner_team_id = $3, runner_up_team_id = $4
			where id = $1`, t.ID, d.Now(), nullable(winner), nullable(runnerUp)); err != nil {
			return err
		}
		if err := core.Audit(ctx, tx, actor(ctx), "tournament.finish", "tournament", t.ID, "", nil); err != nil {
			return err
		}
		out = goTo("/admin/t/" + t.Slug)
		// The courts come free for the day the moment the status changes;
		// nothing is flowed, because a finished tournament plays nothing.
		return core.Bump(ctx, tx, t.ID)
	})
	if err != nil {
		return redirectOut{}, err
	}
	return out, nil
}

// finalPlaces is who won and who came second: the last knockout match decides
// it where there is one, otherwise the top two of the table.
func finalPlaces(ctx context.Context, q core.Querier, tournamentID string) (string, string, error) {
	var winner, teamA, teamB sql.NullString
	err := q.QueryRowContext(ctx, `
		select winner_team_id, team_a_id, team_b_id from matches
		where tournament_id = $1 and stage = 'knockout' and winner_team_id is not null
		order by round_index desc, seq desc limit 1`, tournamentID).Scan(&winner, &teamA, &teamB)
	if err == nil && winner.Valid {
		runnerUp := ""
		if teamA.Valid && teamA.String != winner.String {
			runnerUp = teamA.String
		} else if teamB.Valid && teamB.String != winner.String {
			runnerUp = teamB.String
		}
		return winner.String, runnerUp, nil
	}
	if err != nil && err != sql.ErrNoRows {
		return "", "", err
	}
	return tableTop(ctx, q, tournamentID)
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// deleteEvent is soft: the row keeps `deletedAt` and everything under it stays
// for the record, but it leaves every list and its public page stops
// answering. Its `tournament_courts` rows are HARD deleted, because the
// one-court-per-tournament-per-day index would otherwise keep courts held by
// something nobody can see.
func deleteEvent(ctx context.Context, d *core.Deps, in tournamentIDIn) (redirectOut, error) {
	var out redirectOut
	err := d.Tx(ctx, func(tx *sql.Tx) error {
		t, err := lockTournament(ctx, tx, d, in.TournamentID)
		if err != nil {
			return err
		}
		var courtName sql.NullString
		err = tx.QueryRowContext(ctx, `
			select c.name from matches m left join courts c on c.id = m.court_id
			where m.tournament_id = $1 and m.status = 'live' limit 1`, t.ID).Scan(&courtName)
		if err == nil {
			// Those players are standing on it.
			name := "a court"
			if courtName.Valid {
				name = courtName.String
			}
			out = refuseGo("There is a match on " + name + " right now. Let it finish, or take it off court, then delete.")
			return nil
		}
		if err != sql.ErrNoRows {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`update tournaments set deleted_at = $2 where id = $1 and deleted_at is null`, t.ID, d.Now()); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `delete from tournament_courts where tournament_id = $1`, t.ID); err != nil {
			return err
		}
		if err := core.Audit(ctx, tx, actor(ctx), "tournament.deleted", "tournament", t.ID,
			t.Name+" deleted", nil); err != nil {
			return err
		}
		out = goTo("/admin")
		return core.Bump(ctx, tx, t.ID)
	})
	if err != nil {
		return redirectOut{}, err
	}
	return out, nil
}
