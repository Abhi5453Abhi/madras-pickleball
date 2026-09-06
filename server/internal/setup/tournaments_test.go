package setup

import (
	"fmt"
	"strings"
	"testing"

	"mpb/internal/store"
)

// eightPlayers is four pairs; sixteen is eight.
func peopleFor(pairs int) []string {
	first := []string{"Ravi", "Priya", "Arun", "Deepa", "Karthik", "Meera", "Suresh", "Ganesh",
		"Anitha", "Bala", "Hari", "Naveen", "Sathish", "Vijay", "Lakshmi", "Divya"}
	out := make([]string, 0, pairs*2)
	for i := 0; i < pairs*2; i++ {
		out = append(out, fmt.Sprintf("%s %s", first[i%len(first)], string(rune('A'+i))))
	}
	return out
}

// withPairs makes a doubles tournament with `pairs` pairs, all made at random.
func withPairs(t *testing.T, h *harness, pairs int, format string) string {
	t.Helper()
	tourney := h.create(createEventIn{Name: "Men's Doubles", Format: format, Courts: h.courtIDs()[:1]})
	h.mustAdd(tourney.ID, peopleFor(pairs)...)
	res, err := pairRestRandomly(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if err != nil || !res.OK || res.Made != pairs {
		t.Fatalf("pairRestRandomly: %+v %v", res, err)
	}
	return tourney.ID
}

func TestDrawForFourTeamsIsSixLeagueMatchesAndAFinal(t *testing.T) {
	h := newHarness(t)
	id := withPairs(t, h, 4, "final_only")

	res, err := generateDraw(h.ctx, h.Deps, tournamentIDIn{TournamentID: id})
	if err != nil {
		t.Fatalf("generateDraw: %v", err)
	}
	if !res.OK || res.Count != 7 {
		t.Fatalf("four teams: six league matches and a final, got %+v", res)
	}

	matches := h.matches(id)
	league, knockout := 0, 0
	for _, m := range matches {
		switch m.Stage {
		case "group":
			league++
			// A league match carries its teams and is ready to play.
			if m.TeamAID == nil || m.TeamBID == nil || m.Status != "ready" {
				t.Fatalf("league match not ready: %+v", m)
			}
			if m.SourceA.Type != "entry" || m.SourceA.TeamID != *m.TeamAID {
				t.Fatalf("league source: %+v", m.SourceA)
			}
		case "knockout":
			knockout++
			// The final waits on the table: no teams, and it says why.
			if m.TeamAID != nil || m.TeamBID != nil || m.Status != "pending" {
				t.Fatalf("the final should be waiting: %+v", m)
			}
			if m.SourceA.Type != "group_rank" || m.SourceA.Rank != 1 || m.SourceA.GroupName != "League" {
				t.Fatalf("final's first slot: %+v", m.SourceA)
			}
			if m.RoundName == nil || *m.RoundName != "Final" {
				t.Fatalf("the last match is the Final: %+v", m.RoundName)
			}
		}
	}
	if league != 6 || knockout != 1 {
		t.Fatalf("six league matches and one final, got %d and %d", league, knockout)
	}

	after := h.reload(id)
	if after.DrawMadeAt == nil {
		t.Fatal("draw_made_at is not set")
	}
	if after.AdvancePerGroup != 2 {
		t.Fatalf("a final takes two through, got %d", after.AdvancePerGroup)
	}
	if len(after.SeedOrder) != 4 {
		t.Fatalf("seed_order holds the team order: %v", after.SeedOrder)
	}
	groups, err := h.DB.QueryContext(h.ctx, `select name from groups where tournament_id = $1`, id)
	if err != nil {
		t.Fatalf("groups: %v", err)
	}
	defer groups.Close()
	names := []string{}
	for groups.Next() {
		var n string
		groups.Scan(&n) //nolint:errcheck
		names = append(names, n)
	}
	if len(names) != 1 || names[0] != "League" {
		t.Fatalf("one pool, called League: %v", names)
	}
}

func TestDrawForEightTeamsIsTwoPools(t *testing.T) {
	h := newHarness(t)
	id := withPairs(t, h, 8, "semis_and_final")

	res, err := generateDraw(h.ctx, h.Deps, tournamentIDIn{TournamentID: id})
	if err != nil {
		t.Fatalf("generateDraw: %v", err)
	}
	// Two pools of four: 6 matches each, then semis and a final.
	if !res.OK || res.Count != 15 {
		t.Fatalf("eight teams: %+v", res)
	}

	rows, err := h.DB.QueryContext(h.ctx,
		`select name, advance_count from groups where tournament_id = $1 order by sort_order`, id)
	if err != nil {
		t.Fatalf("groups: %v", err)
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var n string
		var advance int
		if err := rows.Scan(&n, &advance); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if advance != 2 {
			t.Fatalf("two go through from each pool, got %d", advance)
		}
		names = append(names, n)
	}
	if len(names) != 2 || names[0] != "Group A" || names[1] != "Group B" {
		t.Fatalf("two pools, A and B: %v", names)
	}

	// Every team is in a pool.
	for _, tm := range h.teams(id) {
		if tm.GroupID == nil {
			t.Fatalf("%s is in no pool", tm.Name)
		}
	}

	// The final's slots point at the semi-finals by their real match ids.
	matches := h.matches(id)
	byID := map[string]bool{}
	for _, m := range matches {
		byID[m.ID] = true
	}
	finals, semis := 0, 0
	for _, m := range matches {
		if m.RoundName == nil {
			continue
		}
		switch *m.RoundName {
		case "Final":
			finals++
			for _, s := range []store.SlotSource{m.SourceA, m.SourceB} {
				if s.Type != "winner_of" {
					t.Fatalf("a final is between the winners of the semis: %+v", s)
				}
				if s.MatchKey != "" {
					t.Fatalf("the plan's key must not reach the database: %+v", s)
				}
				if !byID[s.MatchID] {
					t.Fatalf("winner_of points at no match here: %+v", s)
				}
			}
		case "Semi-final":
			semis++
			if m.SourceA.Type != "group_rank" || m.SourceB.Type != "group_rank" {
				t.Fatalf("a semi is between pool places: %+v %+v", m.SourceA, m.SourceB)
			}
		}
	}
	if finals != 1 || semis != 2 {
		t.Fatalf("two semis and a final, got %d and %d", semis, finals)
	}

	after := h.reload(id)
	if len(after.SeedOrder) != 8 {
		t.Fatalf("seed_order holds every team: %v", after.SeedOrder)
	}
}

func TestDrawRefusals(t *testing.T) {
	h := newHarness(t)
	tourney := h.create(createEventIn{Name: "Men's Doubles"})

	res, err := generateDraw(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if err != nil {
		t.Fatalf("generateDraw: %v", err)
	}
	if res.OK || res.Error != "You need at least two pairs before there is a schedule to make." {
		t.Fatalf("with nobody in: %+v", res)
	}

	h.mustAdd(tourney.ID, peopleFor(2)...)
	if r, _ := pairRestRandomly(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID}); !r.OK {
		t.Fatalf("pairRestRandomly: %+v", r)
	}
	if r, _ := generateDraw(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID}); !r.OK {
		t.Fatalf("generateDraw: %+v", r)
	}
	// Making it again is fine until a result is in.
	if r, _ := generateDraw(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID}); !r.OK {
		t.Fatalf("remaking: %+v", r)
	}
	if _, err := h.DB.ExecContext(h.ctx,
		`update matches set result_state = 'final' where tournament_id = $1 and stage = 'group'`, tourney.ID); err != nil {
		t.Fatalf("result: %v", err)
	}
	res, _ = generateDraw(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if res.OK || res.Error != "Results are already in — the schedule can’t be remade now." {
		t.Fatalf("with a result in: %+v", res)
	}
}

func TestSinglesDrawsFromTeamsOfOne(t *testing.T) {
	h := newHarness(t)
	tourney := h.create(createEventIn{Name: "Women's Singles", Gender: "womens", Discipline: "singles", Format: "none"})
	h.mustAdd(tourney.ID, "Anitha R", "Divya K", "Lakshmi S", "Meera T")

	// Nobody opened the Players screen; the draw settles the teams of one.
	res, err := generateDraw(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if err != nil {
		t.Fatalf("generateDraw: %v", err)
	}
	if !res.OK || res.Count != 6 {
		t.Fatalf("four singles players play six matches: %+v", res)
	}
	teams := h.teams(tourney.ID)
	if len(teams) != 4 {
		t.Fatalf("four teams of one: %d", len(teams))
	}
	for _, tm := range teams {
		if len(tm.Players) != 1 || tm.Name != tm.Players[0].Name {
			t.Fatalf("a team of one is named after them: %+v", tm)
		}
	}

	// The hub counts them as players in the draw, not pairs.
	out := h.hub(tourney.Slug)
	if got := stepDetail(out, "teams"); got != "4 in the draw" {
		t.Fatalf("singles teams step: %q", got)
	}
	if title := out.Steps[1].Title; title != "Players" {
		t.Fatalf("singles calls the step Players, got %q", title)
	}
}

func TestListsAndMaps(t *testing.T) {
	h := newHarness(t)
	id := withPairs(t, h, 2, "final_only")
	if r, _ := generateDraw(h.ctx, h.Deps, tournamentIDIn{TournamentID: id}); !r.OK {
		t.Fatalf("generateDraw: %+v", r)
	}

	teams, err := listTeams(h.ctx, h.Deps, tournamentIDIn{TournamentID: id})
	if err != nil || len(teams) != 2 {
		t.Fatalf("listTeams: %+v %v", teams, err)
	}
	if !strings.Contains(teams[0].Name, " / ") || teams[0].Status != "active" {
		t.Fatalf("a pair is named 'First / Second': %+v", teams[0])
	}

	names, err := teamNameMap(h.ctx, h.Deps, tournamentIDIn{TournamentID: id})
	if err != nil {
		t.Fatalf("teamNameMap: %v", err)
	}
	if len(names) != 2 || names[teams[0].ID] != teams[0].Name {
		t.Fatalf("teamNameMap: %v", names)
	}

	players, err := listMatches(h.ctx, h.Deps, tournamentIDIn{TournamentID: id})
	if err != nil || len(players) != 2 {
		t.Fatalf("listMatches: %d %v", len(players), err)
	}
	if players[0].RoundIndex > players[1].RoundIndex {
		t.Fatal("matches come back in play order")
	}

	roster, err := listTournamentPlayers(h.ctx, h.Deps, tournamentIDIn{TournamentID: id})
	if err != nil || len(roster) != 4 {
		t.Fatalf("listTournamentPlayers: %d %v", len(roster), err)
	}

	// No games yet, so the map is empty rather than full of nulls.
	games, err := gamesByMatch(h.ctx, h.Deps, tournamentIDIn{TournamentID: id})
	if err != nil || len(games) != 0 {
		t.Fatalf("gamesByMatch: %v %v", games, err)
	}

	// The table stands up with no results in it.
	table, err := standingsFor(h.ctx, h.Deps, tournamentIDIn{TournamentID: id})
	if err != nil {
		t.Fatalf("standingsFor: %v", err)
	}
	if len(table.Rows) != 2 || len(table.Teams) != 2 {
		t.Fatalf("standingsFor: %+v", table)
	}
	for _, r := range table.Rows {
		if r.Won != 0 || r.PointsFor != 0 {
			t.Fatalf("nothing has been played: %+v", r)
		}
	}
}

// getTournamentBySlug carries every field the screens read off a tournament.
func TestGetTournamentBySlug(t *testing.T) {
	h := newHarness(t)
	tourney := h.create(createEventIn{Name: "Men's Doubles", Format: "semis_and_final"})
	out, err := getTournamentBySlug(h.ctx, h.Deps, tourney.Slug)
	if err != nil {
		t.Fatalf("getTournamentBySlug: %v", err)
	}
	if out.ID != tourney.ID || out.Day != h.today() || out.Status != "setup" {
		t.Fatalf("getTournamentBySlug: %+v", out)
	}
	if out.FinalsStage != "semis_and_final" || out.BestOf != 3 || out.PointsToWin != 11 {
		t.Fatalf("format defaults: %+v", out)
	}
	if out.RegistrationClosedAt != nil || out.PausedAt != nil || out.PauseNote != nil {
		t.Fatalf("nothing is closed or paused yet: %+v", out)
	}
	if _, err := getTournamentBySlug(h.ctx, h.Deps, "nothing-here"); err == nil {
		t.Fatal("an unknown slug is a 404")
	}
}
