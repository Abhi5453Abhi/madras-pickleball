// Command seed makes the test data the browser walks expect. It is the Go
// port of the three scripts the Next.js app seeded with — app/scripts/
// seed-teams.ts, seed-live.ts and seed-pub.ts — and prints exactly what they
// printed, because the walks parse it.
//
//	DATABASE_URL=postgres://… go run ./cmd/seed teams
//	DATABASE_URL=postgres://… go run ./cmd/seed live
//	DATABASE_URL=postgres://… go run ./cmd/seed pub
//
// Nothing here knows the domain: every step goes through the same registered
// function the screens call (rpc.Registry.Call runs it in this process), so
// the data is made the way the app makes it. The one exception is the partner
// wishes in `teams`, which no RPC can set — the reference wrote those with
// SQL too.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"mpb/internal/core"
	"mpb/internal/db"
	"mpb/internal/modules"
	"mpb/internal/rpc"
)

func main() {
	if len(os.Args) < 2 {
		fail("usage: seed teams|live|pub")
	}
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		fail("DATABASE_URL is not set — nothing to seed")
	}

	// Quiet: the walks read this program's stdout, and a stray log line on
	// stderr is noise in their output.
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx := context.Background()
	conn, err := db.Open(url)
	if err != nil {
		fail("database: %v", err)
	}
	defer conn.Close()
	// Both are idempotent, so the seed runs against a database the server has
	// already opened and against an empty one.
	if err := db.Migrate(ctx, conn, log); err != nil {
		fail("migrate: %v", err)
	}
	venue, err := core.Seed(ctx, conn)
	if err != nil {
		fail("seed: %v", err)
	}

	d := &core.Deps{DB: conn, Venue: venue, Log: log, Now: time.Now}
	reg := rpc.New(log)
	// The mux is thrown away: the seed calls the registry directly, and only
	// the plain GET endpoints a module also registers want a mux.
	modules.Register(http.NewServeMux(), reg, d)

	s := &seeder{ctx: withOwner(ctx, conn), db: conn, reg: reg}
	switch os.Args[1] {
	case "teams":
		s.teams()
	case "live":
		s.live()
	case "pub":
		s.pub()
	default:
		fail("usage: seed teams|live|pub")
	}
}

// ── the three seeds ───────────────────────────────────────────────────────

// doublesWishes is name → who they asked for (as typed). Karthik/Sathish and
// Hari/Naveen name each other; Manoj → Suresh → Ganesh → Manoj is a chain
// nobody can satisfy; Ravi names someone who never signed up; the rest name
// nobody.
var doublesWishes = [][2]string{
	{"Karthik Subramanian", "Sathish Kumar"},
	{"Sathish Kumar", "Karthik Subramanian"},
	{"Hari Venkatesh", "Naveen Krishnan"},
	{"Naveen Krishnan", "Hari Venkatesh"},
	{"Manoj Pillai", "Suresh Babu"},
	{"Suresh Babu", "Ganesh Iyer"},
	{"Ganesh Iyer", "Manoj Pillai"},
	{"Arun Prakash", ""},
	{"Ravi Shankar", "Priya"},
	{"Vijay Anand", ""},
	{"Deepak Raj", ""},
	{"Bala Murugan", ""},
}

var singlesNames = []string{"Anita Rao", "Divya Menon", "Kavitha Nair", "Lakshmi Iyer", "Meera Krishnan", "Priya Raman"}

// teams is seed-teams.ts: a doubles tournament with twelve players and every
// kind of partner wish, a singles tournament with six, and five people with no
// wishes at all so random pairing has to leave one out.
func (s *seeder) teams() {
	courts := s.courts()
	if len(courts) < 3 {
		fail("Run the server once first — no courts.")
	}
	day := time.Now().AddDate(0, 0, 7+rand.IntN(300)).Format("2006-01-02")
	stamp := stamp4()

	dbl := s.createEvent("Men's Doubles "+stamp, day, "mens", "doubles", "final_only", courtIDs(courts[0:2]))
	names := make([]string, 0, len(doublesWishes))
	for _, w := range doublesWishes {
		names = append(names, w[0])
	}
	s.importPlayers(dbl.ID, names, nil)
	idByName := s.rosterIDs(dbl.ID)
	for _, w := range doublesWishes {
		if w[1] == "" {
			continue
		}
		// The wish is what a person typed on the sign-up form; no RPC takes
		// one on behalf of somebody else, so the seed writes it as the
		// reference did.
		var partner any
		if id, ok := idByName[w[1]]; ok {
			partner = id
		}
		if _, err := s.db.ExecContext(s.ctx, `
			update tournament_players set partner_wish = $3, partner_player_id = $4, source = 'link'
			where tournament_id = $1 and player_id = $2`, dbl.ID, idByName[w[0]], w[1], partner); err != nil {
			fail("partner wish: %v", err)
		}
	}

	sgl := s.createEvent("Women's Singles "+stamp, day, "womens", "singles", "none", courtIDs(courts[2:3]))
	s.importPlayers(sgl.ID, singlesNames, nil)

	// Five people and no wishes: random pairing has to leave one out and say who.
	odd := s.createEvent("Mixed Doubles "+stamp, day, "mixed", "doubles", "none", courtIDs(courts[3:4]))
	s.importPlayers(odd.ID, []string{"Anand Kumar", "Bhavana Reddy", "Chandran Pillai", "Devi Prasad", "Ezhil Arasan"}, nil)

	var roster int
	if err := s.db.QueryRowContext(s.ctx, `select count(*) from players`).Scan(&roster); err != nil {
		fail("count players: %v", err)
	}
	fmt.Printf("doubles %s\n", dbl.Slug)
	fmt.Printf("singles %s\n", sgl.Slug)
	fmt.Printf("odd %s\n", odd.Slug)
	fmt.Printf("players %d on the roster\n", roster)
}

var livePairs = struct{ mens, mixed [][2]string }{
	mens: [][2]string{
		{"Karthik Subramanian", "Sathish Kumar"},
		{"Hari Venkatesh", "Naveen Krishnan"},
		{"Ravi Shankar", "Vijay Anand"},
		{"Suresh Babu", "Ganesh Iyer"},
		{"Arun Prakash", "Manoj Pillai"},
		{"Deepak Raj", "Bala Murugan"},
	},
	mixed: [][2]string{
		{"Priya Ramesh", "Rahul Menon"},
		{"Divya Natarajan", "Vikram Chandran"},
		{"Meera Krishnamurthy", "Arun Kumar"},
		{"Anjali Nair", "Ravi Varma"},
	},
}

// live is seed-live.ts: two doubles tournaments on today's date, drawn and
// ready to start — Men's on Courts 1–2 (six pairs, 16 matches), Mixed on
// Court 3 (four pairs, 7 matches). Court 4 is nobody's. The walk starts them.
func (s *seeder) live() {
	mens := s.makeDrawn("Men's Doubles — Sunday", "mens", livePairs.mens, []string{"Court 1", "Court 2"})
	mixed := s.makeDrawn("Mixed Doubles — Sunday", "mixed", livePairs.mixed, []string{"Court 3"})
	fmt.Println(mens.Slug)
	fmt.Println(mixed.Slug)
}

// makeDrawn is seed-live's `make`: an event on today, its pairs made in the
// order given, and the draw generated.
func (s *seeder) makeDrawn(name, gender string, pairs [][2]string, courtNames []string) tournament {
	byName := map[string]string{}
	for _, c := range s.courts() {
		byName[c.Name] = c.ID
	}
	ids := make([]string, 0, len(courtNames))
	for _, n := range courtNames {
		id, ok := byName[n]
		if !ok {
			fail("No court called %s", n)
		}
		ids = append(ids, id)
	}

	t := s.createEvent(name, core.DayKey(time.Now()), gender, "doubles", "final_only", ids)
	var flat []string
	for _, p := range pairs {
		flat = append(flat, p[0], p[1])
	}
	s.importPlayers(t.ID, flat, nil)
	roster := s.rosterIDs(t.ID)
	for _, p := range pairs {
		s.pairWith(t.ID, roster[p[0]], roster[p[1]])
	}
	s.generateDraw(t.ID)
	return t
}

var pubMens = []string{
	"Karthik Subramanian", "Sathish Kumar", "Ravi Shankar", "Vijay Anand",
	"Hari Venkatesh", "Naveen Krishnan", "Deepak Raj", "Bala Murugan",
	"Arun Prakash", "Manoj Pillai", "Suresh Babu", "Ganesh Iyer",
}

var pubMixed = []string{
	"Priya Ramesh", "Rahul Menon", "Divya Natarajan", "Vikram Sethu",
	"Meera Krishnamurthy", "Anand Raghavan", "Lakshmi Narayanan", "Kiran Balaji",
}

var pubScores = [][][2]int{
	{{11, 7}, {11, 9}},
	{{9, 11}, {11, 8}, {11, 6}},
	{{11, 4}, {11, 8}},
	{{11, 9}, {7, 11}, {11, 9}},
	{{11, 6}, {11, 3}},
	{{8, 11}, {11, 9}, {11, 7}},
	{{11, 8}, {11, 10}},
}

// pub is seed-pub.ts: two doubles tournaments today for the public pages and
// More — Men's on Courts 1–2 part-played with two matches on court, Mixed on
// Court 3 played to the end and finished.
func (s *seeder) pub() {
	courts := s.courts()
	if len(courts) < 3 {
		fail("Run the server once first — no courts.")
	}
	c1, c2, c3 := courts[0].ID, courts[1].ID, courts[2].ID

	mens := s.makeStarted("Men's Doubles", "mens", pubMens, []string{c1, c2}, 43210)
	n := s.play(mens.ID, []string{c1, c2}, 7, 2)
	fmt.Printf("Men's Doubles   /t/%s  %d played, 2 on court\n", mens.Slug, n)

	mixed := s.makeStarted("Mixed Doubles", "mixed", pubMixed, []string{c3}, 43300)
	m := s.play(mixed.ID, []string{c3}, 99, 0)
	s.finishEvent(mixed.ID)
	fmt.Printf("Mixed Doubles   /t/%s  %d played, finished\n", mixed.Slug, m)

	out, err := json.Marshal(map[string]string{"mens": mens.Slug, "mixed": mixed.Slug})
	if err != nil {
		fail("json: %v", err)
	}
	fmt.Println(string(out))
}

// makeStarted is seed-pub's `make`: names paired two at a time down the list,
// drawn, and started — which puts the first matches on court by itself.
func (s *seeder) makeStarted(name, gender string, names []string, courtIDs []string, phoneFrom int) tournament {
	t := s.createEvent(name, core.DayKey(time.Now()), gender, "doubles", "final_only", courtIDs)
	// Phones are the dedupe key, so each list gets its own range.
	phones := make([]string, len(names))
	for i := range names {
		phones[i] = fmt.Sprintf("+9198765%05d", phoneFrom+i)
	}
	s.importPlayers(t.ID, names, phones)
	roster := s.rosterIDs(t.ID)
	for i := 0; i+1 < len(names); i += 2 {
		s.pairWith(t.ID, roster[names[i]], roster[names[i+1]])
	}
	s.generateDraw(t.ID)
	s.startEvent(t.ID)
	return t
}

// play scores matches in play order. Starting a tournament puts the first
// matches on court by itself, and every saved score pulls the next one on, so
// this only ever scores whatever is live — and sends one itself only when the
// flow has nothing on court. (The reference had to flow by hand after each
// score; saveResult does it here, inside the same transaction.)
func (s *seeder) play(tournamentID string, courtIDs []string, results, leaveOnCourt int) int {
	scored := 0
	for guard := 0; guard < 80 && scored < results; guard++ {
		all := s.matches(tournamentID)
		var live []match
		for _, m := range all {
			if m.Status == "live" && m.TeamAID != nil && m.TeamBID != nil {
				live = append(live, m)
			}
		}
		if len(live) == 0 {
			var next *match
			for i, m := range all {
				if m.Status == "ready" && m.ResultState == "none" && m.TeamAID != nil && m.TeamBID != nil {
					next = &all[i]
					break
				}
			}
			if next == nil {
				break
			}
			s.sendToCourt(next.ID, courtIDs[0])
			live = []match{*next}
		}
		sort.SliceStable(live, func(i, j int) bool {
			if live[i].RoundIndex != live[j].RoundIndex {
				return live[i].RoundIndex < live[j].RoundIndex
			}
			return live[i].Seq < live[j].Seq
		})
		m := live[0]
		pattern := pubScores[scored%len(pubScores)]
		games := make([]game, len(pattern))
		aWins := 0
		for i, g := range pattern {
			games[i] = game{GameNo: i + 1, ScoreA: g[0], ScoreB: g[1]}
			if g[0] > g[1] {
				aWins++
			}
		}
		winner := m.TeamBID
		if aWins >= 2 {
			winner = m.TeamAID
		}
		s.saveResult(m.ID, games, winner)
		scored++
	}
	// Leave the courts as asked: the flow fills them; clear the rest.
	var live []match
	for _, m := range s.matches(tournamentID) {
		if m.Status == "live" {
			live = append(live, m)
		}
	}
	for i := leaveOnCourt; i < len(live); i++ {
		s.clearCourt(live[i].ID)
	}
	return scored
}

// ── the wire the seed talks over ──────────────────────────────────────────

type seeder struct {
	ctx context.Context
	db  *sql.DB
	reg *rpc.Registry
}

// call runs one registered function and decodes its result. Every refusal is
// fatal: a seed that half worked is worse than one that stopped.
func (s *seeder) call(name string, in, out any) {
	body, err := json.Marshal(in)
	if err != nil {
		fail("%s: %v", name, err)
	}
	res, err := s.reg.Call(s.ctx, name, body)
	if err != nil {
		fail("%s: %v", name, err)
	}
	raw, err := json.Marshal(res)
	if err != nil {
		fail("%s: %v", name, err)
	}
	// Every action answers {ok, error}; the ones that only read have neither.
	var refusal struct {
		OK    *bool  `json:"ok"`
		Error string `json:"error"`
	}
	json.Unmarshal(raw, &refusal) //nolint:errcheck — a list result is not an object
	if refusal.Error != "" || (refusal.OK != nil && !*refusal.OK) {
		fail("%s: %s", name, refusal.Error)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			fail("%s: %v", name, err)
		}
	}
}

type court struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type tournament struct {
	ID   string `json:"id"`
	Slug string `json:"slug"`
}

type match struct {
	ID          string  `json:"id"`
	RoundIndex  int     `json:"roundIndex"`
	Seq         int     `json:"seq"`
	Status      string  `json:"status"`
	ResultState string  `json:"resultState"`
	TeamAID     *string `json:"teamAId"`
	TeamBID     *string `json:"teamBId"`
}

type game struct {
	GameNo int `json:"gameNo"`
	ScoreA int `json:"scoreA"`
	ScoreB int `json:"scoreB"`
}

func (s *seeder) courts() []court {
	var out []court
	s.call("venue.venueCourts", struct{}{}, &out)
	return out
}

func (s *seeder) createEvent(name, day, gender, discipline, format string, courtIDs []string) tournament {
	var out struct {
		Redirect string `json:"redirect"`
	}
	s.call("events.createEvent", map[string]any{
		"name": name, "date": day, "gender": gender,
		"discipline": discipline, "format": format, "courts": courtIDs,
	}, &out)
	// "/admin/t/<slug>", or the same with "?courts=<refusal>" when a court
	// was already somebody else's — which for a seed is a failure.
	slug := strings.TrimPrefix(out.Redirect, "/admin/t/")
	if i := strings.IndexByte(slug, '?'); i >= 0 {
		fail("createEvent %s: %s", name, slug[i+1:])
	}
	var t tournament
	s.call("tournaments.getTournamentBySlug", map[string]any{"slug": slug}, &t)
	return t
}

// importPlayers puts the list on the tournament the way the organiser does,
// with the paste box. Phones may be nil.
func (s *seeder) importPlayers(tournamentID string, names, phones []string) {
	lines := make([]string, len(names))
	for i, n := range names {
		lines[i] = n
		if phones != nil {
			lines[i] = n + " " + phones[i]
		}
	}
	s.call("registration.addByHand", map[string]any{
		"tournamentId": tournamentID, "text": strings.Join(lines, "\n"),
	}, nil)
}

// rosterIDs is name → player id for everyone on the list.
func (s *seeder) rosterIDs(tournamentID string) map[string]string {
	var players []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	s.call("tournaments.listTournamentPlayers", map[string]any{"tournamentId": tournamentID}, &players)
	out := map[string]string{}
	for _, p := range players {
		out[p.Name] = p.ID
	}
	return out
}

func (s *seeder) pairWith(tournamentID, a, b string) {
	if a == "" || b == "" {
		fail("pairWith: somebody is not on the list")
	}
	s.call("teams.pairWith", map[string]any{"tournamentId": tournamentID, "playerA": a, "playerB": b}, nil)
}

func (s *seeder) generateDraw(tournamentID string) {
	s.call("tournaments.generateDraw", map[string]any{"tournamentId": tournamentID}, nil)
}

func (s *seeder) startEvent(tournamentID string) {
	s.call("events.startEvent", map[string]any{"tournamentId": tournamentID}, nil)
}

func (s *seeder) finishEvent(tournamentID string) {
	s.call("events.finishEvent", map[string]any{"tournamentId": tournamentID}, nil)
}

func (s *seeder) matches(tournamentID string) []match {
	var out []match
	s.call("tournaments.listMatches", map[string]any{"tournamentId": tournamentID}, &out)
	return out
}

func (s *seeder) sendToCourt(matchID, courtID string) {
	s.call("board.sendToCourt", map[string]any{"matchId": matchID, "courtId": courtID}, nil)
}

func (s *seeder) clearCourt(matchID string) {
	s.call("board.clearCourt", map[string]any{"matchId": matchID}, nil)
}

func (s *seeder) saveResult(matchID string, games []game, winner *string) {
	s.call("scoring.saveResult", map[string]any{
		"matchId": matchID, "games": games, "resultType": "normal", "winnerTeamId": winner,
	}, nil)
}

// ── odds and ends ─────────────────────────────────────────────────────────

// withOwner signs the seed in as the venue's owner, so the audit log says a
// person did this rather than nobody.
func withOwner(ctx context.Context, conn *sql.DB) context.Context {
	var u rpc.User
	err := conn.QueryRowContext(ctx,
		`select id, name, role from users where deleted_at is null order by created_at limit 1`).
		Scan(&u.ID, &u.Name, &u.Role)
	if err != nil {
		fail("no organiser to seed as: %v", err)
	}
	return rpc.WithUser(ctx, &u)
}

func courtIDs(cs []court) []string {
	out := make([]string, len(cs))
	for i, c := range cs {
		out[i] = c.ID
	}
	return out
}

// stamp4 is JavaScript's Math.random().toString(36).slice(2, 6): four
// characters that keep two runs of the seed apart.
func stamp4() string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	b := make([]byte, 4)
	for i := range b {
		b[i] = alphabet[rand.IntN(len(alphabet))]
	}
	return string(b)
}

func fail(format string, a ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", a...)
	os.Exit(1)
}
