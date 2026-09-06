package setup

import (
	"strings"
	"testing"
	"time"

	"mpb/internal/core"
	"mpb/internal/rpc"
)

func TestCreateEventValidation(t *testing.T) {
	h := newHarness(t)
	cases := []struct {
		name string
		in   createEventIn
		want string
	}{
		{"no name", createEventIn{Date: h.today(), Gender: "mens", Discipline: "doubles", Format: "none"},
			"Give it a name — you can change it later."},
		{"no day", createEventIn{Name: "Men's Doubles", Gender: "mens", Discipline: "doubles", Format: "none"},
			"Pick the day it is on."},
		{"a day that has gone", createEventIn{Name: "Men's Doubles", Date: "2020-01-01",
			Gender: "mens", Discipline: "doubles", Format: "none"}, "That day has already gone."},
		{"no category", createEventIn{Name: "Men's Doubles", Date: h.today(), Discipline: "doubles", Format: "none"},
			"Pick a category."},
		{"no discipline", createEventIn{Name: "Men's Doubles", Date: h.today(), Gender: "mens", Format: "none"},
			"Singles or doubles?"},
		{"no format", createEventIn{Name: "Men's Doubles", Date: h.today(), Gender: "mens", Discipline: "doubles"},
			"Pick a format."},
	}
	for _, c := range cases {
		res, err := createEvent(h.ctx, h.Deps, c.in)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if res.OK || res.Error != c.want {
			t.Fatalf("%s: got %+v, want %q", c.name, res, c.want)
		}
	}
}

func TestCreateEventTakesCourtsAndMakesTheLink(t *testing.T) {
	h := newHarness(t)
	courts := h.courtIDs()
	tourney := h.create(createEventIn{Name: "Men's Doubles", Courts: courts[:2]})

	if tourney.Status != "setup" || tourney.RegistrationClosedAt != nil {
		t.Fatalf("a new tournament is in setup with sign-ups open: %+v", tourney)
	}
	if !strings.HasPrefix(tourney.Slug, "mens-doubles-") || len(tourney.Slug) != len("mens-doubles-")+4 {
		t.Fatalf("slug is slugify(name)-xxxx, got %q", tourney.Slug)
	}
	mine, err := courtOptions(h.ctx, h.DB, h.Deps, tourney)
	if err != nil {
		t.Fatalf("courtOptions: %v", err)
	}
	got := 0
	for _, o := range mine {
		if o.Mine {
			got++
		}
		if o.TakenBy != nil {
			t.Fatalf("nothing else holds a court yet: %+v", o)
		}
	}
	if got != 2 {
		t.Fatalf("it holds two courts, got %d", got)
	}
	// The sign-up link exists from the moment it does.
	link, err := ensureRegistrationLink(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if err != nil || link == nil {
		t.Fatalf("ensureRegistrationLink: %+v %v", link, err)
	}
	if len(link.Token) != 11 || link.Token[5] != '-' {
		t.Fatalf("the link is XXXXX-XXXXX, got %q", link.Token)
	}
	again, _ := ensureRegistrationLink(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if again.Token != link.Token {
		t.Fatalf("the link is stable: %q then %q", link.Token, again.Token)
	}
}

func TestCourtClashOnTheSameDay(t *testing.T) {
	h := newHarness(t)
	courts := h.courtIDs()
	first := h.create(createEventIn{Name: "Men's Doubles", Courts: courts[:2]})

	// A second tournament the same day cannot have Court 1.
	res, err := createEvent(h.ctx, h.Deps, createEventIn{
		Name: "Mixed Doubles", Date: h.today(), Gender: "mixed", Discipline: "doubles",
		Format: "none", Courts: []string{courts[0], courts[2]}})
	if err != nil {
		t.Fatalf("createEvent: %v", err)
	}
	// It is still made — better than the reverse — and carries the refusal.
	if !res.OK || !strings.Contains(res.Redirect, "?courts=") {
		t.Fatalf("a clash still makes the tournament and says so: %+v", res)
	}
	// encodeURIComponent leaves an apostrophe alone, and so does this.
	if !strings.Contains(res.Redirect, "belongs%20to%20Men's%20Doubles%20that%20day") {
		t.Fatalf("the redirect carries the sentence: %q", res.Redirect)
	}

	slug := strings.TrimPrefix(strings.Split(res.Redirect, "?")[0], "/admin/t/")
	second, err := mustTournamentBySlug(h.ctx, h.Deps, slug)
	if err != nil {
		t.Fatalf("the second tournament exists: %v", err)
	}
	courtsOfSecond, _ := courtOptions(h.ctx, h.DB, h.Deps, second)
	for _, o := range courtsOfSecond {
		if o.Mine {
			t.Fatalf("it took no courts at all: %+v", o)
		}
		if o.ID == courts[0] && (o.TakenBy == nil || o.TakenBy.Name != "Men's Doubles") {
			t.Fatalf("Court 1 is named as Men's Doubles': %+v", o)
		}
	}

	// Asking again on its own, the refusal is the sentence itself.
	again, err := assignCourts(h.ctx, h.Deps, assignCourtsIn{TournamentID: second.ID, CourtIDs: []string{courts[0]}})
	if err != nil {
		t.Fatalf("assignCourts: %v", err)
	}
	if again.OK || again.Error != "Court 1 belongs to Men's Doubles that day. Take it off there first." {
		t.Fatalf("court clash: %+v", again)
	}

	// The free ones go on.
	ok, err := assignCourts(h.ctx, h.Deps, assignCourtsIn{TournamentID: second.ID, CourtIDs: []string{courts[2], courts[3]}})
	if err != nil || !ok.OK || ok.Count != 2 {
		t.Fatalf("assignCourts: %+v %v", ok, err)
	}

	// A court that is not at this venue at all.
	bad, _ := assignCourts(h.ctx, h.Deps, assignCourtsIn{TournamentID: second.ID, CourtIDs: []string{"crt_nowhere"}})
	if bad.OK || bad.Error != "That court is not at this venue." {
		t.Fatalf("a stranger's court: %+v", bad)
	}

	// The same court on another day is nobody's business.
	tomorrow := core.DayKey(h.now.Add(24 * time.Hour))
	later := h.create(createEventIn{Name: "Women's Doubles", Date: tomorrow, Gender: "womens", Courts: []string{courts[0]}})
	held, _ := store2Courts(h, later.ID)
	if len(held) != 1 {
		t.Fatalf("tomorrow's tournament has Court 1: %v", held)
	}
	_ = first
}

func TestAssignCourtsReleasesAFinishedTournament(t *testing.T) {
	h := newHarness(t)
	courts := h.courtIDs()
	morning := h.create(createEventIn{Name: "Men's Doubles", Courts: []string{courts[0]}})
	// The morning is over.
	if _, err := h.DB.ExecContext(h.ctx, `update tournaments set status = 'completed' where id = $1`, morning.ID); err != nil {
		t.Fatalf("finish: %v", err)
	}
	evening := h.create(createEventIn{Name: "Mixed Doubles", Gender: "mixed"})
	res, err := assignCourts(h.ctx, h.Deps, assignCourtsIn{TournamentID: evening.ID, CourtIDs: []string{courts[0]}})
	if err != nil {
		t.Fatalf("assignCourts: %v", err)
	}
	if !res.OK || res.Count != 1 {
		t.Fatalf("a finished tournament lets go of its court: %+v", res)
	}
}

// store2Courts is the courts a tournament holds, by name.
func store2Courts(h *harness, tournamentID string) ([]string, error) {
	rows, err := h.DB.QueryContext(h.ctx, `
		select c.name from tournament_courts tc join courts c on c.id = tc.court_id
		where tc.tournament_id = $1 order by c.sort_order`, tournamentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

func TestHubStepsThroughTheDay(t *testing.T) {
	h := newHarness(t)
	courts := h.courtIDs()
	tourney := h.create(createEventIn{Name: "Men's Doubles", Format: "final_only"})

	// Nothing yet.
	out := h.hub(tourney.Slug)
	if out.Phase != "setup" || out.Players != 0 {
		t.Fatalf("a new tournament: %+v", out)
	}
	if got := stepDetail(out, "registration"); got != "0 players in · link is open" {
		t.Fatalf("registration step: %q", got)
	}
	if got := stepDetail(out, "teams"); got != "Once players are in" {
		t.Fatalf("teams step with nobody in: %q", got)
	}
	if got := stepDetail(out, "schedule"); got != "no courts yet · schedule not made yet" {
		t.Fatalf("schedule step: %q", got)
	}
	if got := stepDetail(out, "start"); got != "Once the schedule is made" {
		t.Fatalf("start step: %q", got)
	}
	if stepState(out, "registration") != "current" || stepState(out, "teams") != "todo" {
		t.Fatalf("steps at the start: %+v", out.Steps)
	}

	// Four players in, none paired.
	h.mustAdd(tourney.ID, "Ravi Kumar", "Priya Sharma", "Arun Prakash", "Deepa Nair")
	out = h.hub(tourney.Slug)
	if got := stepDetail(out, "registration"); got != "4 players in · link is open" {
		t.Fatalf("registration step: %q", got)
	}
	if got := stepDetail(out, "teams"); got != "0 of 2 pairs made · 4 players still to pair" {
		t.Fatalf("teams step: %q", got)
	}
	if stepState(out, "registration") != "done" || stepState(out, "teams") != "current" {
		t.Fatalf("registration done, teams current: %+v", out.Steps)
	}

	// Two mutual pairs settle on the way in, without anybody tapping.
	h.wish(tourney.ID, "Ravi Kumar", "Priya Sharma")
	h.wish(tourney.ID, "Priya Sharma", "Ravi Kumar")
	out = h.hub(tourney.Slug)
	if got := stepDetail(out, "teams"); got != "1 of 2 pairs made · 2 players still to pair" {
		t.Fatalf("after one mutual pair: %q", got)
	}

	// The rest by hand.
	res, err := pairWith(h.ctx, h.Deps, pairWithIn{TournamentID: tourney.ID,
		PlayerA: h.playerID(tourney.ID, "Arun Prakash"), PlayerB: h.playerID(tourney.ID, "Deepa Nair")})
	if err != nil || !res.OK {
		t.Fatalf("pairWith: %+v %v", res, err)
	}
	out = h.hub(tourney.Slug)
	if got := stepDetail(out, "teams"); got != "2 of 2 pairs made" {
		t.Fatalf("all paired: %q", got)
	}
	if stepState(out, "teams") != "done" || stepState(out, "schedule") != "current" {
		t.Fatalf("teams done, schedule current: %+v", out.Steps)
	}

	// Courts and a schedule.
	if res, err := assignCourts(h.ctx, h.Deps, assignCourtsIn{TournamentID: tourney.ID,
		CourtIDs: []string{courts[0], courts[1]}}); err != nil || !res.OK {
		t.Fatalf("assignCourts: %+v %v", res, err)
	}
	drawn, err := generateDraw(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if err != nil || !drawn.OK {
		t.Fatalf("generateDraw: %+v %v", drawn, err)
	}
	out = h.hub(tourney.Slug)
	// Four players are two pairs: one league match and the final.
	if got := stepDetail(out, "schedule"); got != "Court 1, Court 2 · 2 matches" {
		t.Fatalf("schedule step: %q", got)
	}
	if got := stepDetail(out, "start"); got != "Everything is ready" {
		t.Fatalf("start step: %q", got)
	}
	if stepState(out, "schedule") != "done" || stepState(out, "start") != "current" {
		t.Fatalf("schedule done, start current: %+v", out.Steps)
	}

	// Start it: sign-ups close and the phase moves.
	started, err := startEvent(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if err != nil || !started.OK || started.Redirect != "/admin/live" {
		t.Fatalf("startEvent: %+v %v", started, err)
	}
	after := h.reload(tourney.ID)
	if after.Status != "live" || after.RegistrationClosedAt == nil || after.StartedAt == nil {
		t.Fatalf("after the start: %+v", after)
	}
	out = h.hub(tourney.Slug)
	if out.Phase != "running" || stepState(out, "start") != "done" {
		t.Fatalf("running: %+v", out)
	}
	if got := stepDetail(out, "registration"); got != "4 players in · sign-ups closed" {
		t.Fatalf("registration step after the start: %q", got)
	}

	// Sign-ups cannot be reopened once it is running.
	if res, _ := reopenRegistration(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID}); res.OK ||
		res.Error != "The tournament has started, so sign-ups stay closed." {
		t.Fatalf("reopening after the start: %+v", res)
	}
}

func TestStartRefusals(t *testing.T) {
	h := newHarness(t)
	courts := h.courtIDs()
	tourney := h.create(createEventIn{Name: "Men's Doubles"})

	res, err := startEvent(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if err != nil {
		t.Fatalf("startEvent: %v", err)
	}
	if res.OK || res.Error != "Make the schedule first." {
		t.Fatalf("no matches: %+v", res)
	}

	h.mustAdd(tourney.ID, "Ravi Kumar", "Priya Sharma", "Arun Prakash", "Deepa Nair")
	if res, _ := pairRestRandomly(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID}); !res.OK {
		t.Fatalf("pairRestRandomly: %+v", res)
	}
	if res, _ := generateDraw(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID}); !res.OK {
		t.Fatalf("generateDraw: %+v", res)
	}
	res, _ = startEvent(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if res.OK || res.Error != "Give it at least one court first." {
		t.Fatalf("no courts: %+v", res)
	}

	if res, _ := assignCourts(h.ctx, h.Deps, assignCourtsIn{TournamentID: tourney.ID, CourtIDs: courts[:1]}); !res.OK {
		t.Fatalf("assignCourts: %+v", res)
	}
	if res, _ := startEvent(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID}); !res.OK {
		t.Fatalf("startEvent: %+v", res)
	}
}

func TestFinishAndDelete(t *testing.T) {
	h := newHarness(t)
	tourney := h.create(createEventIn{Name: "Men's Doubles", Courts: h.courtIDs()[:1]})
	h.mustAdd(tourney.ID, "Ravi Kumar", "Priya Sharma", "Arun Prakash", "Deepa Nair")
	if res, _ := pairRestRandomly(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID}); !res.OK {
		t.Fatalf("pairRestRandomly: %+v", res)
	}
	if res, _ := generateDraw(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID}); !res.OK {
		t.Fatalf("generateDraw: %+v", res)
	}

	// Only a running tournament can be finished.
	res, err := finishEvent(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if err != nil {
		t.Fatalf("finishEvent: %v", err)
	}
	if res.OK || res.Error != "Only a running tournament can be finished." {
		t.Fatalf("finishing before the start: %+v", res)
	}
	if res, _ := startEvent(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID}); !res.OK {
		t.Fatalf("startEvent: %+v", res)
	}
	// And not twice.
	if res, _ := startEvent(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID}); res.OK || res.Error != "That tournament has already started." {
		t.Fatalf("starting twice: %+v", res)
	}
	res, err = finishEvent(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if err != nil {
		t.Fatalf("finishEvent: %v", err)
	}
	if res.OK || res.Error != "2 matches have no result yet." {
		t.Fatalf("finishing early: %+v", res)
	}

	// Give the league a result: the top of the table becomes the winner.
	teams := h.teams(tourney.ID)
	if _, err := h.DB.ExecContext(h.ctx, `
		update matches set result_state = 'final', status = 'completed', winner_team_id = $2,
		       games = '[{"gameNo":1,"scoreA":11,"scoreB":4},{"gameNo":2,"scoreA":11,"scoreB":5}]'::jsonb,
		       games_won_a = 2
		where tournament_id = $1 and team_a_id = $2`, tourney.ID, teams[0].ID); err != nil {
		t.Fatalf("results: %v", err)
	}
	if _, err := h.DB.ExecContext(h.ctx, `
		update matches set result_state = 'final', status = 'completed',
		       winner_team_id = coalesce(winner_team_id, team_a_id)
		where tournament_id = $1 and result_state = 'none' and team_a_id is not null`, tourney.ID); err != nil {
		t.Fatalf("results: %v", err)
	}
	// The final has no teams in it (nobody resolved the slots), so cancel it.
	if _, err := h.DB.ExecContext(h.ctx, `
		update matches set result_state = 'voided', status = 'cancelled'
		where tournament_id = $1 and result_state = 'none'`, tourney.ID); err != nil {
		t.Fatalf("void: %v", err)
	}

	res, err = finishEvent(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if err != nil {
		t.Fatalf("finishEvent: %v", err)
	}
	if !res.OK || res.Redirect != "/admin/t/"+tourney.Slug {
		t.Fatalf("finishEvent: %+v", res)
	}
	done := h.reload(tourney.ID)
	if done.Status != "completed" || done.FinishedAt == nil || done.WinnerTeamID == nil {
		t.Fatalf("a finished tournament records its winner: %+v", done)
	}

	// It is off the "today" list and on the finished one, with a name.
	board, err := dashboard(h.ctx, h.Deps)
	if err != nil {
		t.Fatalf("dashboard: %v", err)
	}
	if len(board.Today) != 0 || len(board.Finished) != 1 {
		t.Fatalf("buckets: today %d, finished %d", len(board.Today), len(board.Finished))
	}
	row := board.Finished[0]
	if row.WinnerName == nil || *row.WinnerName == "" {
		t.Fatalf("a finished tournament names its winner: %+v", row)
	}
	if row.Category != "Men's Doubles" || row.Teams != 2 || row.Players != 4 {
		t.Fatalf("dashboard row: %+v", row)
	}
	if row.RegistrationOpen {
		t.Fatal("sign-ups are not open on a finished tournament")
	}

	// Delete takes it off every list.
	gone, err := deleteEvent(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if err != nil || !gone.OK || gone.Redirect != "/admin" {
		t.Fatalf("deleteEvent: %+v %v", gone, err)
	}
	if _, err := mustTournamentBySlug(h.ctx, h.Deps, tourney.Slug); err == nil {
		t.Fatal("a deleted tournament still answers")
	}
	var courtRows int
	if err := h.DB.QueryRowContext(h.ctx,
		`select count(*)::int from tournament_courts where tournament_id = $1`, tourney.ID).Scan(&courtRows); err != nil {
		t.Fatalf("courts: %v", err)
	}
	if courtRows != 0 {
		t.Fatal("its courts are freed for the day")
	}
}

func TestDashboardBuckets(t *testing.T) {
	h := newHarness(t)
	today := h.create(createEventIn{Name: "Men's Doubles"})
	tomorrow := core.DayKey(h.now.Add(24 * time.Hour))
	later := h.create(createEventIn{Name: "Mixed Doubles", Date: tomorrow, Gender: "mixed"})
	nextWeek := core.DayKey(h.now.Add(7 * 24 * time.Hour))
	last := h.create(createEventIn{Name: "Women's Singles", Date: nextWeek, Gender: "womens", Discipline: "singles"})

	board, err := dashboard(h.ctx, h.Deps)
	if err != nil {
		t.Fatalf("dashboard: %v", err)
	}
	if len(board.Today) != 1 || board.Today[0].ID != today.ID {
		t.Fatalf("on today: %+v", board.Today)
	}
	if len(board.Upcoming) != 2 || board.Upcoming[0].ID != later.ID || board.Upcoming[1].ID != last.ID {
		t.Fatalf("upcoming, soonest first: %+v", board.Upcoming)
	}
	if len(board.Finished) != 0 {
		t.Fatalf("nothing is finished: %+v", board.Finished)
	}
	if board.Upcoming[1].Category != "Women's Singles" {
		t.Fatalf("category name: %q", board.Upcoming[1].Category)
	}
}

func TestUnknownSlugAndIdAre404(t *testing.T) {
	h := newHarness(t)
	if _, err := hub(h.ctx, h.Deps, "nothing-here"); err == nil {
		t.Fatal("an unknown slug is a 404")
	} else if e, ok := err.(*rpc.Error); !ok || e.Status != 404 {
		t.Fatalf("want 404, got %v", err)
	}
	if _, err := listMatches(h.ctx, h.Deps, tournamentIDIn{TournamentID: "trn_nothing"}); err == nil {
		t.Fatal("an unknown id is a 404")
	}
}
