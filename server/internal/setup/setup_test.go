package setup

import (
	"context"
	"database/sql"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"mpb/internal/core"
	"mpb/internal/db"
	"mpb/internal/rpc"
	"mpb/internal/store"
)

// The tests run against a real Postgres — every one of these functions is a
// handful of statements against the schema, and a fake would test the fake.
//
//	MPB_TEST_DATABASE_URL=postgres://postgres@localhost:5433/mpb_setup?sslmode=disable
//
// They skip when it is unset, so `go test ./...` is green on a laptop with no
// database.

type harness struct {
	*core.Deps
	t     *testing.T
	now   time.Time
	owner rpc.User
	ctx   context.Context
}

// newHarness brings the schema up, empties every table and seeds the venue
// again, so each test starts from the state a fresh install is in.
func newHarness(t *testing.T) *harness {
	t.Helper()
	url := os.Getenv("MPB_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("MPB_TEST_DATABASE_URL is not set")
	}
	conn, err := db.Open(url)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { conn.Close() })

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx := context.Background()
	if err := db.Migrate(ctx, conn, log); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	truncateAll(t, conn)
	venue, err := core.Seed(ctx, conn)
	if err != nil {
		t.Fatalf("seed: %v", err)
	}

	// The clock is a field so a test can move it — but it starts at the real
	// time, because half of these tables carry the database's own now() and a
	// guard counting failures across the two would compare 2026 with today.
	h := &harness{t: t, now: time.Now()}
	h.Deps = &core.Deps{DB: conn, Venue: venue, Log: log, Now: func() time.Time { return h.now }}

	var id, name, role string
	if err := conn.QueryRowContext(ctx, `select id, name, role from users order by created_at limit 1`).
		Scan(&id, &name, &role); err != nil {
		t.Fatalf("owner: %v", err)
	}
	h.owner = rpc.User{ID: id, Name: name, Role: role}
	h.ctx = h.as(&h.owner)
	return h
}

// as builds a context carrying a signed-in organiser. It carries no
// ResponseWriter: only changePin wants one, and it must work without — the
// session row is written either way, and the cookie is skipped.
func (h *harness) as(u *rpc.User) context.Context {
	return rpc.WithUser(context.Background(), u)
}

func truncateAll(t *testing.T, conn *sql.DB) {
	t.Helper()
	rows, err := conn.Query(`select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'`)
	if err != nil {
		t.Fatalf("tables: %v", err)
	}
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			rows.Close()
			t.Fatalf("scan: %v", err)
		}
		names = append(names, `"`+n+`"`)
	}
	rows.Close()
	if len(names) == 0 {
		return
	}
	if _, err := conn.Exec(`truncate table ` + strings.Join(names, ", ") + ` restart identity cascade`); err != nil {
		t.Fatalf("truncate: %v", err)
	}
}

// ── things a test needs to say in one line ────────────────────────────────

func (h *harness) courtIDs() []string {
	h.t.Helper()
	courts, err := store.VenueCourts(h.ctx, h.DB, h.Venue.ID, true)
	if err != nil {
		h.t.Fatalf("courts: %v", err)
	}
	out := make([]string, 0, len(courts))
	for _, c := range courts {
		out = append(out, c.ID)
	}
	return out
}

func (h *harness) today() string { return core.DayKey(h.now) }

// create makes a tournament and returns it, failing the test on a refusal.
func (h *harness) create(in createEventIn) *store.Tournament {
	h.t.Helper()
	if in.Name == "" {
		in.Name = "Men's Doubles"
	}
	if in.Date == "" {
		in.Date = h.today()
	}
	if in.Gender == "" {
		in.Gender = "mens"
	}
	if in.Discipline == "" {
		in.Discipline = "doubles"
	}
	if in.Format == "" {
		in.Format = "final_only"
	}
	res, err := createEvent(h.ctx, h.Deps, in)
	if err != nil {
		h.t.Fatalf("createEvent: %v", err)
	}
	if !res.OK {
		h.t.Fatalf("createEvent refused: %s", res.Error)
	}
	slug := strings.TrimPrefix(res.Redirect, "/admin/t/")
	if i := strings.Index(slug, "?"); i >= 0 {
		slug = slug[:i]
	}
	tourney, err := store.TournamentBySlug(h.ctx, h.DB, h.Venue.ID, slug)
	if err != nil {
		h.t.Fatalf("lookup %q: %v", slug, err)
	}
	return tourney
}

// add puts one name on the list through the organiser's box.
func (h *harness) add(tournamentID, text string) addByHandOut {
	h.t.Helper()
	res, err := addByHand(h.ctx, h.Deps, addByHandIn{TournamentID: tournamentID, Text: text})
	if err != nil {
		h.t.Fatalf("addByHand: %v", err)
	}
	return res
}

func (h *harness) mustAdd(tournamentID string, names ...string) {
	h.t.Helper()
	for _, n := range names {
		if res := h.add(tournamentID, n); !res.OK {
			h.t.Fatalf("addByHand %q refused: %s", n, res.Error)
		}
	}
}

// roster is the list in arrival order.
func (h *harness) roster(tournamentID string) []store.TournamentPlayer {
	h.t.Helper()
	rows, err := store.Roster(h.ctx, h.DB, tournamentID)
	if err != nil {
		h.t.Fatalf("roster: %v", err)
	}
	return rows
}

func (h *harness) playerID(tournamentID, name string) string {
	h.t.Helper()
	for _, r := range h.roster(tournamentID) {
		if r.Player.Name == name {
			return r.Player.ID
		}
	}
	h.t.Fatalf("no player %q on the list", name)
	return ""
}

// wish records that one player named another, the way the sign-up form does.
func (h *harness) wish(tournamentID, from, to string) {
	h.t.Helper()
	fromID := h.playerID(tournamentID, from)
	toID := h.playerID(tournamentID, to)
	if _, err := h.DB.ExecContext(h.ctx,
		`update tournament_players set partner_wish = $3, partner_player_id = $4
		 where tournament_id = $1 and player_id = $2`, tournamentID, fromID, to, toID); err != nil {
		h.t.Fatalf("wish: %v", err)
	}
}

func (h *harness) teams(tournamentID string) []store.Team {
	h.t.Helper()
	rows, err := store.Teams(h.ctx, h.DB, tournamentID)
	if err != nil {
		h.t.Fatalf("teams: %v", err)
	}
	return rows
}

func (h *harness) matches(tournamentID string) []*store.Match {
	h.t.Helper()
	rows, err := store.Matches(h.ctx, h.DB, tournamentID)
	if err != nil {
		h.t.Fatalf("matches: %v", err)
	}
	return rows
}

func (h *harness) reload(id string) *store.Tournament {
	h.t.Helper()
	tourney, err := store.TournamentByID(h.ctx, h.DB, h.Venue.ID, id)
	if err != nil {
		h.t.Fatalf("reload: %v", err)
	}
	return tourney
}

func (h *harness) hub(slug string) hubOut {
	h.t.Helper()
	out, err := hub(h.ctx, h.Deps, slug)
	if err != nil {
		h.t.Fatalf("hub: %v", err)
	}
	return out
}

func stepDetail(out hubOut, key string) string {
	for _, s := range out.Steps {
		if s.Key == key {
			return s.Detail
		}
	}
	return ""
}

func stepState(out hubOut, key string) string {
	for _, s := range out.Steps {
		if s.Key == key {
			return s.State
		}
	}
	return ""
}
