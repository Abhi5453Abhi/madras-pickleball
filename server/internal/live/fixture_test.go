package live

// The scaffolding every test in this package stands on.
//
// The setup module owns tournaments, teams and the draw, and this package
// cannot call it — so a fixture writes the same rows with SQL. The shapes come
// from the engine's own draw builder rather than being typed out, so a change
// to how a draw is laid out shows up here as a failing test rather than as a
// fixture that quietly stops resembling the product.

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"mpb/internal/core"
	"mpb/internal/db"
	"mpb/internal/engine"
	"mpb/internal/ids"
	"mpb/internal/store"
)

var testDB *sql.DB

func TestMain(m *testing.M) {
	url := os.Getenv("MPB_TEST_DATABASE_URL")
	if url == "" {
		// No sandbox database: the pure tests still run, these skip.
		os.Exit(m.Run())
	}
	conn, err := db.Open(url)
	if err != nil {
		fmt.Fprintln(os.Stderr, "live tests: cannot open the test database:", err)
		os.Exit(1)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := db.Migrate(context.Background(), conn, log); err != nil {
		fmt.Fprintln(os.Stderr, "live tests: migrate:", err)
		os.Exit(1)
	}
	testDB = conn
	code := m.Run()
	conn.Close()
	os.Exit(code)
}

// deps gives a test a clean database, the seeded venue and a frozen-enough
// clock. Every table but schema_migrations is emptied first.
func deps(t *testing.T) *core.Deps {
	t.Helper()
	if testDB == nil {
		t.Skip("MPB_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	rows, err := testDB.QueryContext(ctx,
		`select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'`)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			t.Fatal(err)
		}
		names = append(names, `"`+n+`"`)
	}
	rows.Close()
	if len(names) > 0 {
		if _, err := testDB.ExecContext(ctx, `truncate `+strings.Join(names, ", ")+` restart identity cascade`); err != nil {
			t.Fatal(err)
		}
	}
	venue, err := core.Seed(ctx, testDB)
	if err != nil {
		t.Fatal(err)
	}
	return &core.Deps{
		DB:    testDB,
		Venue: venue,
		Log:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Now:   time.Now,
	}
}

// ── a tournament, its teams and its draw ──────────────────────────────────

type fixtureOpts struct {
	Name        string
	Slug        string
	FinalsStage string // none | final_only | semis_and_final
	Discipline  string // doubles | singles
	Gender      string
	Teams       int
	// Courts is how many of the venue's courts this tournament holds, counting
	// from CourtFrom — one court belongs to one tournament per day, so a second
	// tournament on the same day starts further along.
	Courts    int
	CourtFrom int
	Status string // setup | live | completed
	// Pools splits the teams (8 or more), like the real draw does.
	Pools bool
}

type fixture struct {
	D       *core.Deps
	ID      string
	Slug    string
	Teams   []string // team ids, in seed order
	Names   map[string]string
	Players []string // player ids, in sign-up order
	Courts  []store.Court
	Matches []*store.Match // in play order
}

var firstNames = []string{
	"Ravi", "Priya", "Arun", "Deepa", "Karthik", "Meera", "Suresh", "Ganesh",
	"Lakshmi", "Vijay", "Anita", "Bala", "Divya", "Manoj", "Sathish", "Uma",
	"Nithya", "Prakash", "Rekha", "Sanjay",
}
var lastNames = []string{"Kumar", "S", "Iyer", "Raman", "Krishnan", "Menon", "Nair", "Reddy"}

func makeFixture(t *testing.T, d *core.Deps, opts fixtureOpts) *fixture {
	t.Helper()
	ctx := context.Background()
	if opts.Discipline == "" {
		opts.Discipline = "doubles"
	}
	if opts.Gender == "" {
		opts.Gender = "mens"
	}
	if opts.Status == "" {
		opts.Status = "live"
	}
	teamSize := 2
	if opts.Discipline == "singles" {
		teamSize = 1
	}
	day := core.DayKey(d.Now())

	f := &fixture{D: d, ID: ids.New("trn"), Slug: opts.Slug, Names: map[string]string{}}
	advance := 0
	switch opts.FinalsStage {
	case "final_only":
		advance = 2
	case "semis_and_final":
		advance = 4
	}
	if opts.Pools {
		advance = 2
	}
	mustExec(t, d.DB, `
		insert into tournaments (id, venue_id, name, slug, day, gender, discipline, finals_stage,
			advance_per_group, status, started_at)
		values ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, now())`,
		f.ID, d.Venue.ID, opts.Name, opts.Slug, day, opts.Gender, opts.Discipline, opts.FinalsStage,
		advance, opts.Status)

	courts, err := store.VenueCourts(ctx, d.DB, d.Venue.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if opts.CourtFrom+opts.Courts > len(courts) {
		t.Fatalf("the venue has %d courts, the fixture wants %d from %d", len(courts), opts.Courts, opts.CourtFrom)
	}
	f.Courts = courts[opts.CourtFrom : opts.CourtFrom+opts.Courts]
	for _, c := range f.Courts {
		mustExec(t, d.DB, `insert into tournament_courts (tournament_id, court_id, day_key) values ($1,$2,$3)`,
			f.ID, c.ID, day)
	}

	// Players, then pairs, in the order they signed up — which is the order the
	// pairs were made, and the last-resort dead-heat order.
	n := 0
	for i := 0; i < opts.Teams; i++ {
		var members []string
		var names []string
		for j := 0; j < teamSize; j++ {
			name := fmt.Sprintf("%s %s", firstNames[n%len(firstNames)], lastNames[(n/len(firstNames))%len(lastNames)])
			if n >= len(firstNames) {
				name = fmt.Sprintf("%s %s%d", firstNames[n%len(firstNames)], lastNames[0], n)
			}
			playerID := ids.New("ply")
			mustExec(t, d.DB, `insert into players (id, venue_id, name, name_key) values ($1,$2,$3,$4)`,
				playerID, d.Venue.ID, name, engine.NormalizeName(name))
			mustExec(t, d.DB, `insert into tournament_players (id, tournament_id, player_id, source) values ($1,$2,$3,'hand')`,
				ids.New("tpl"), f.ID, playerID)
			members = append(members, playerID)
			names = append(names, name)
			f.Players = append(f.Players, playerID)
			n++
		}
		teamID := ids.New("tm")
		teamName := strings.Join(names, " / ")
		mustExec(t, d.DB, `insert into teams (id, tournament_id, name, seed, created_at) values ($1,$2,$3,$4,$5)`,
			teamID, f.ID, teamName, i+1, time.Now().Add(time.Duration(i)*time.Millisecond))
		for pos, p := range members {
			mustExec(t, d.DB, `insert into team_players (team_id, player_id, position) values ($1,$2,$3)`, teamID, p, pos)
		}
		f.Teams = append(f.Teams, teamID)
		f.Names[teamID] = teamName
	}

	// The draw comes from the engine, so the fixture is the product's own shape
	// with the plan's keys swapped for real ids.
	var plan engine.DrawPlan
	if opts.Pools {
		plan = engine.BuildGroupsKnockout(f.Teams, engine.PoolCountFor(len(f.Teams)))
	} else {
		plan = engine.BuildLeague(f.Teams, engine.FinalsStage(opts.FinalsStage))
	}

	groupID := map[string]string{}
	for i, g := range plan.Groups {
		id := ids.New("grp")
		groupID[g.Name] = id
		mustExec(t, d.DB, `insert into groups (id, tournament_id, name, advance_count, sort_order) values ($1,$2,$3,$4,$5)`,
			id, f.ID, g.Name, g.AdvanceCount, i)
		for _, teamID := range g.TeamIDs {
			mustExec(t, d.DB, `update teams set group_id = $2 where id = $1`, teamID, id)
		}
	}

	matchID := map[string]string{}
	for _, m := range plan.Matches {
		matchID[m.Key] = ids.New("mch")
	}
	resolve := func(src engine.SlotSource) (engine.SlotSource, *string) {
		out := src
		if src.MatchKey != "" {
			out.MatchID = matchID[src.MatchKey]
			out.MatchKey = ""
		}
		if src.Type == "entry" && src.TeamID != "" {
			id := src.TeamID
			return out, &id
		}
		return out, nil
	}
	for _, m := range plan.Matches {
		srcA, teamA := resolve(m.SlotA)
		srcB, teamB := resolve(m.SlotB)
		status := "pending"
		if teamA != nil && teamB != nil {
			status = "ready"
		}
		var group any
		if id, ok := groupID[m.GroupName]; ok && m.GroupName != "" {
			group = id
		}
		var roundName any
		if m.RoundName != "" {
			roundName = m.RoundName
		}
		mustExec(t, d.DB, `
			insert into matches (id, tournament_id, stage, group_id, round_index, round_name, seq,
				team_a_id, team_b_id, source_a, source_b, status)
			values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12)`,
			matchID[m.Key], f.ID, m.Stage, group, m.RoundIndex, roundName, m.Seq,
			teamA, teamB, mustJSON(t, srcA), mustJSON(t, srcB), status)
	}

	f.reload(t)
	return f
}

func (f *fixture) reload(t *testing.T) {
	t.Helper()
	all, err := store.Matches(context.Background(), f.D.DB, f.ID)
	if err != nil {
		t.Fatal(err)
	}
	sortByPlayOrder(all)
	f.Matches = all
}

func (f *fixture) tournament(t *testing.T) *store.Tournament {
	t.Helper()
	row, err := store.TournamentByID(context.Background(), f.D.DB, f.D.Venue.ID, f.ID)
	if err != nil {
		t.Fatal(err)
	}
	return row
}

func (f *fixture) match(t *testing.T, id string) *store.Match {
	t.Helper()
	m, err := store.MatchByID(context.Background(), f.D.DB, id)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// live returns the matches on court, by court name.
func (f *fixture) live(t *testing.T) map[string]*store.Match {
	t.Helper()
	f.reload(t)
	names := map[string]string{}
	for _, c := range f.Courts {
		names[c.ID] = c.Name
	}
	out := map[string]*store.Match{}
	for _, m := range f.Matches {
		if m.Status == "live" && m.CourtID != nil {
			out[names[*m.CourtID]] = m
		}
	}
	return out
}

// flow runs the hook the way every write in every module does: inside one
// transaction, after the write.
func (f *fixture) flow(t *testing.T) {
	t.Helper()
	if err := f.D.Tx(context.Background(), func(tx *sql.Tx) error {
		return FlowTournament(context.Background(), tx, f.D, f.ID)
	}); err != nil {
		t.Fatal(err)
	}
	f.reload(t)
}

// win records a plain 11-6, 11-4 for one side of a match, through the same RPC
// the score screen calls.
func (f *fixture) win(t *testing.T, matchID, winnerTeamID string) saveResultOut {
	t.Helper()
	m := f.match(t, matchID)
	a := winnerTeamID == deref(m.TeamAID)
	game := func(no int) wireGame {
		if a {
			return wireGame{GameNo: no, ScoreA: 11, ScoreB: 6}
		}
		return wireGame{GameNo: no, ScoreA: 6, ScoreB: 11}
	}
	out, err := saveResult(context.Background(), f.D, saveResultIn{
		MatchID: matchID, ResultType: "normal", Games: []wireGame{game(1), game(2)},
	})
	if err != nil {
		t.Fatal(err)
	}
	f.reload(t)
	return out
}

// leagueMatches are this fixture's group matches, in play order.
func (f *fixture) leagueMatches() []*store.Match {
	var out []*store.Match
	for _, m := range f.Matches {
		if m.Stage == "group" {
			out = append(out, m)
		}
	}
	return out
}

func (f *fixture) knockout() []*store.Match {
	var out []*store.Match
	for _, m := range f.Matches {
		if m.Stage == "knockout" {
			out = append(out, m)
		}
	}
	return out
}

// ── little helpers ────────────────────────────────────────────────────────

func mustExec(t *testing.T, q core.Querier, sqlText string, args ...any) {
	t.Helper()
	if _, err := q.ExecContext(context.Background(), sqlText, args...); err != nil {
		t.Fatalf("%s: %v", strings.TrimSpace(strings.SplitN(strings.TrimSpace(sqlText), "\n", 2)[0]), err)
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
