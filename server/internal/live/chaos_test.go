package live

import (
	"context"
	"testing"

	"mpb/internal/ids"
)

// A pair pulls out at lunch: what they played stands, what they had left
// becomes a walkover to the other side, and it adds no points to anybody.
func TestWithdrawMakesWalkovers(t *testing.T) {
	d := deps(t)
	ctx := context.Background()
	f := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "final_only", Teams: 4})
	going := f.Teams[3]

	effect, err := withdrawalEffect(ctx, d.DB, f.ID, going)
	if err != nil {
		t.Fatal(err)
	}
	if effect.Played != 0 || effect.ToWalkover != 3 || effect.Vacates != 0 || len(effect.Blocked) != 0 {
		t.Fatalf("the confirm would say %+v", effect)
	}

	out, err := withdrawTeam(ctx, d, teamIn{TournamentID: f.ID, TeamID: going})
	if err != nil || !out.OK {
		t.Fatalf("withdraw: %v %v", out, err)
	}
	if out.Walkovers != 3 {
		t.Errorf("%d walkovers, wanted 3", out.Walkovers)
	}
	want := f.Names[going] + " are out. 3 matches become walkovers to the other side."
	if out.Note != want {
		t.Errorf("the note is %q, wanted %q", out.Note, want)
	}

	f.reload(t)
	for _, m := range f.Matches {
		if deref(m.TeamAID) != going && deref(m.TeamBID) != going {
			continue
		}
		if m.ResultType != "walkover" || m.ResultState != "final" {
			t.Fatalf("%s is %s/%s", deref(m.RoundName), m.ResultType, m.ResultState)
		}
		if deref(m.WinnerTeamID) == going {
			t.Error("the pair who went home won one")
		}
		for _, g := range m.Games {
			if !g.ExcludeFromDiff {
				t.Error("a walkover must add nothing to any difference column")
			}
		}
	}

	// A win that adds no points: nobody gains a point from a match nobody
	// played, so a pair who go home cannot decide the pool.
	for _, r := range f.standings(t) {
		if r.PointsFor != 0 {
			t.Errorf("%s has %d points from a match nobody played", f.Names[r.TeamID], r.PointsFor)
		}
	}
}

// Put them back and the walkovers come undone, not left standing.
func TestReinstateUndoesTheWalkovers(t *testing.T) {
	d := deps(t)
	ctx := context.Background()
	f := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "final_only", Teams: 4})
	going := f.Teams[3]

	if out, err := withdrawTeam(ctx, d, teamIn{TournamentID: f.ID, TeamID: going}); err != nil || !out.OK {
		t.Fatalf("withdraw: %v %v", out, err)
	}
	out, err := reinstateTeam(ctx, d, teamIn{TournamentID: f.ID, TeamID: going})
	if err != nil || !out.OK {
		t.Fatalf("reinstate: %v %v", out, err)
	}
	if out.Restored != 3 {
		t.Errorf("%d walkovers undone, wanted 3", out.Restored)
	}
	if want := f.Names[going] + " are back in. 3 walkovers are undone."; out.Note != want {
		t.Errorf("the note is %q, wanted %q", out.Note, want)
	}
	f.reload(t)
	for _, m := range f.Matches {
		if deref(m.TeamAID) != going && deref(m.TeamBID) != going {
			continue
		}
		if m.ResultState != "none" || m.Status != "ready" || len(m.Games) != 0 {
			t.Fatalf("%s is still %s/%s with %d games", deref(m.RoundName), m.Status, m.ResultState, len(m.Games))
		}
	}
	// Twice is refused, in the organiser's words.
	again, err := reinstateTeam(ctx, d, teamIn{TournamentID: f.ID, TeamID: going})
	if err != nil {
		t.Fatal(err)
	}
	if again.OK || again.Error != "They are not marked as withdrawn." {
		t.Errorf("got %v", again)
	}
}

// A pair with a match on court cannot be withdrawn from the desk, and the
// refusal names what to do.
func TestWithdrawRefusedWhileTheyAreOnCourt(t *testing.T) {
	d := deps(t)
	ctx := context.Background()
	f := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "final_only", Teams: 4, Courts: 1})
	f.flow(t)

	playing := deref(f.match(t, f.Matches[0].ID).TeamAID)
	out, err := withdrawTeam(ctx, d, teamIn{TournamentID: f.ID, TeamID: playing})
	if err != nil {
		t.Fatal(err)
	}
	if out.OK {
		t.Fatal("a pair standing on a court was withdrawn from the desk")
	}
	if out.Error != "Round 1 is on court right now. Take it off court first, or let it finish." {
		t.Errorf("the refusal was %q", out.Error)
	}
	if out.Fix != "board" {
		t.Error("the refusal should offer the live board")
	}
}

// Swap one player for another: the pair keeps its results and its place in the
// table, and the name changes everywhere at once.
func TestSubstitutePlayer(t *testing.T) {
	d := deps(t)
	ctx := context.Background()
	f := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "final_only", Teams: 4})

	targets, err := substitutionOptions(ctx, d.DB, f.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(targets) != 4 || len(targets[0].Members) != 2 {
		t.Fatalf("the swap screen offers %d pairs", len(targets))
	}

	// Somebody on the list who is in no pair: the only person who can step in.
	spare := ids.New("ply")
	mustExec(t, d.DB, `insert into players (id, venue_id, name, name_key) values ($1,$2,'Sanjay Reddy','sanjay reddy')`,
		spare, d.Venue.ID)
	mustExec(t, d.DB, `insert into tournament_players (id, tournament_id, player_id, source) values ($1,$2,$3,'hand')`,
		ids.New("tpl"), f.ID, spare)

	team := targets[0]
	leaving := team.Members[1]
	out, err := substitutePlayer(ctx, d, substituteIn{
		TournamentID: f.ID, TeamID: team.TeamID, OutPlayerID: leaving.ID, InPlayerID: spare,
	})
	if err != nil || !out.OK {
		t.Fatalf("substitute: %v %v", out, err)
	}
	wantName := team.Members[0].Name + " / Sanjay Reddy"
	if out.Name != wantName {
		t.Errorf("the pair is now %q, wanted %q", out.Name, wantName)
	}
	if out.Note != team.TeamName+" are now "+wantName+". Their results and their place in the table stand." {
		t.Errorf("the note is %q", out.Note)
	}
	names := f.teamNames(t)
	if names[team.TeamID] != wantName {
		t.Errorf("the board still calls them %q", names[team.TeamID])
	}

	// Somebody already in another pair cannot step in.
	other := targets[1]
	clash, err := substitutePlayer(ctx, d, substituteIn{
		TournamentID: f.ID, TeamID: team.TeamID, OutPlayerID: team.Members[0].ID, InPlayerID: other.Members[0].ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	want := other.Members[0].Name + " is already playing for " + other.TeamName + "."
	if clash.OK || clash.Error != want {
		t.Errorf("got %q, wanted %q", clash.Error, want)
	}
}

// Shortening what is left refuses a shape that is not a shape, and refuses at
// all while a match is on court.
func TestShortenFormatRefusals(t *testing.T) {
	d := deps(t)
	ctx := context.Background()
	f := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "final_only", Teams: 4, Courts: 1})

	if out, _ := shortenFormat(ctx, d, shortenIn{TournamentID: f.ID, BestOf: 2, PointsToWin: 11}); out.Error != "A match is best of one or best of three." {
		t.Errorf("best of two said %q", out.Error)
	}
	if out, _ := shortenFormat(ctx, d, shortenIn{TournamentID: f.ID, BestOf: 1, PointsToWin: 25}); out.Error != "Games run to between 7 and 21." {
		t.Errorf("to 25 said %q", out.Error)
	}

	f.flow(t)
	out, err := shortenFormat(ctx, d, shortenIn{TournamentID: f.ID, BestOf: 1, PointsToWin: 15})
	if err != nil {
		t.Fatal(err)
	}
	if out.OK || out.Error != "A match is on court. Change it when that one finishes." || out.Fix != "board" {
		t.Errorf("got %v", out)
	}
	if tour := f.tournament(t); tour.BestOf != 3 || tour.PointsToWin != 11 {
		t.Error("the refused change was written anyway")
	}
}

// Cancelling is not correcting: the match counts for nobody afterwards.
func TestVoidMatch(t *testing.T) {
	d := deps(t)
	ctx := context.Background()
	f := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "final_only", Teams: 4})

	if out, _ := voidMatch(ctx, d, voidIn{MatchID: f.Matches[0].ID, Reason: "no"}); out.Error !=
		"Say why it is being cancelled — it goes in the log next to your name." {
		t.Errorf("a two-letter reason said %q", out.Error)
	}

	out, err := voidMatch(ctx, d, voidIn{MatchID: f.Matches[0].ID, Reason: "entered against the wrong pair"})
	if err != nil || !out.OK {
		t.Fatalf("void: %v %v", out, err)
	}
	if out.Redirect != "/admin/live" {
		t.Errorf("the redirect is %q", out.Redirect)
	}
	m := f.match(t, f.Matches[0].ID)
	if m.ResultState != "voided" || m.ResultType != "cancelled" || m.WinnerTeamID != nil || len(m.Games) != 0 {
		t.Fatalf("the voided match is %s/%s with %d games", m.ResultState, m.ResultType, len(m.Games))
	}
	// It counts for nobody: nobody's played count moved.
	for _, r := range f.standings(t) {
		if r.Played != 0 {
			t.Errorf("%s has played %d after the only match was cancelled", f.Names[r.TeamID], r.Played)
		}
	}
}

// A match the knockout was built off cannot be cancelled while that match is
// under way — and the refusal says which one.
func TestVoidRefusedWhenSomethingWasBuiltOffIt(t *testing.T) {
	d := deps(t)
	ctx := context.Background()
	f := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "final_only", Teams: 4, Courts: 1})
	f.flow(t)
	playTheLeague(t, f)

	out, err := voidMatch(ctx, d, voidIn{MatchID: f.Matches[0].ID, Reason: "should never have been played"})
	if err != nil {
		t.Fatal(err)
	}
	if out.OK || out.Error != "Final was built off this result. Sort that one out first." {
		t.Errorf("got %v", out)
	}
}
