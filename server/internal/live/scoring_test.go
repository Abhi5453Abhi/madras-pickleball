package live

import (
	"context"
	"strings"
	"testing"
)

// A walkover's scoreline is generated, never accepted, and sits out of every
// difference column.
func TestWalkoverScoring(t *testing.T) {
	d := deps(t)
	f := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "final_only", Teams: 4, Courts: 1})
	f.flow(t)

	first := f.Matches[0]
	winner := deref(first.TeamBID)
	out, err := saveResult(context.Background(), d, saveResultIn{
		MatchID: first.ID, ResultType: "walkover", WinnerTeamID: &winner, Games: []wireGame{},
	})
	if err != nil || !out.OK {
		t.Fatalf("walkover: %v %v", out, err)
	}
	m := f.match(t, first.ID)
	if m.ResultType != "walkover" || deref(m.WinnerTeamID) != winner {
		t.Fatalf("stored %s for %s", m.ResultType, deref(m.WinnerTeamID))
	}
	if len(m.Games) != 2 {
		t.Fatalf("a best-of-three walkover records %d games, wanted 2", len(m.Games))
	}
	for _, g := range m.Games {
		if g.ScoreA != 0 || g.ScoreB != 11 {
			t.Errorf("game %d is %d–%d; the winner's side should carry the target", g.GameNo, g.ScoreA, g.ScoreB)
		}
		if !g.ExcludeFromDiff {
			t.Error("a no-show is on the record and in no difference column at all")
		}
	}
	if m.GamesWonA != 0 || m.GamesWonB != 2 {
		t.Errorf("games won %d–%d", m.GamesWonA, m.GamesWonB)
	}
}

// A retirement records what was played and fills in the rest — and what nobody
// played counts for nothing.
func TestRetirementScoring(t *testing.T) {
	d := deps(t)
	f := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "final_only", Teams: 4, Courts: 1})
	f.flow(t)

	first := f.Matches[0]
	retired := deref(first.TeamAID)
	out, err := saveResult(context.Background(), d, saveResultIn{
		MatchID: first.ID, ResultType: "retired", RetiredTeamID: &retired,
		Games: []wireGame{{GameNo: 1, ScoreA: 11, ScoreB: 6}, {GameNo: 2, ScoreA: 5, ScoreB: 7}},
	})
	if err != nil || !out.OK {
		t.Fatalf("retirement: %v %v", out, err)
	}
	m := f.match(t, first.ID)
	if m.ResultType != "retired" || deref(m.RetiredTeamID) != retired {
		t.Fatalf("stored %s, retired %s", m.ResultType, deref(m.RetiredTeamID))
	}
	if deref(m.WinnerTeamID) != deref(first.TeamBID) {
		t.Error("the side that carried on should have won it")
	}
	if len(m.Games) != 3 {
		t.Fatalf("wanted the played games plus what it took to finish, got %d", len(m.Games))
	}
	if m.Games[0].ExcludeFromDiff || m.Games[1].ExcludeFromDiff {
		t.Error("the games they actually played count")
	}
	if !m.Games[2].ExcludeFromDiff {
		t.Error("a game nobody played must not enter point difference")
	}
	if m.Games[1].ScoreB != 11 {
		t.Errorf("the game in progress was finished at %d–%d, wanted the target", m.Games[1].ScoreA, m.Games[1].ScoreB)
	}
}

// A correction that would change who went through is refused once the match it
// fed has been played, and the refusal names it.
func TestCorrectionRefusedOnceTheFinalHasStarted(t *testing.T) {
	d := deps(t)
	ctx := context.Background()
	f := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "final_only", Teams: 4, Courts: 1})
	f.flow(t)
	playTheLeague(t, f)

	if f.match(t, f.knockout()[0].ID).Status != "live" {
		t.Fatal("the final should be on court by now")
	}

	first := f.Matches[0]
	swap := deref(first.TeamBID) // the side that lost it
	out, err := saveResult(ctx, d, saveResultIn{
		MatchID: first.ID, ResultType: "normal", Reason: "wrong pair",
		Games: []wireGame{{GameNo: 1, ScoreA: 6, ScoreB: 11}, {GameNo: 2, ScoreA: 4, ScoreB: 11}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.OK {
		t.Fatal("the correction went through with the final already on court")
	}
	if !strings.Contains(out.Error, "Final has already started off this result") {
		t.Errorf("the refusal was %q; it has to name the match that is blocking it", out.Error)
	}
	if m := f.match(t, first.ID); deref(m.WinnerTeamID) == swap {
		t.Error("the refused correction changed the result anyway")
	}
}

// A correction without a reason is refused: it goes in the log next to a name.
func TestCorrectionNeedsAReason(t *testing.T) {
	d := deps(t)
	ctx := context.Background()
	f := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "none", Teams: 4})

	first := f.Matches[0]
	if out := f.win(t, first.ID, deref(first.TeamAID)); !out.OK {
		t.Fatalf("the first score was refused: %s", out.Error)
	}
	out, err := saveResult(ctx, d, saveResultIn{
		MatchID: first.ID, ResultType: "normal",
		Games: []wireGame{{GameNo: 1, ScoreA: 6, ScoreB: 11}, {GameNo: 2, ScoreA: 4, ScoreB: 11}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.OK || out.Error != "Say what changed — it goes in the log next to your name." {
		t.Fatalf("got %v", out)
	}

	// With a reason it goes through, and the row says it was corrected.
	out, err = saveResult(ctx, d, saveResultIn{
		MatchID: first.ID, ResultType: "normal", Reason: "entered against the wrong pair",
		Games: []wireGame{{GameNo: 1, ScoreA: 6, ScoreB: 11}, {GameNo: 2, ScoreA: 4, ScoreB: 11}},
	})
	if err != nil || !out.OK {
		t.Fatalf("the correction was refused: %v %v", out, err)
	}
	m := f.match(t, first.ID)
	if deref(m.WinnerTeamID) != deref(first.TeamBID) {
		t.Error("the correction did not change the winner")
	}
	if m.CorrectedAt == nil {
		t.Error("a correction leaves corrected_at behind")
	}
}

// After "Shorten what's left" a match that was played best of three is still
// corrected as best of three: the stored games say what shape it had.
func TestACorrectionKeepsTheRulesItWasPlayedUnder(t *testing.T) {
	d := deps(t)
	ctx := context.Background()
	f := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "none", Teams: 4})

	first := f.Matches[0]
	if out := f.win(t, first.ID, deref(first.TeamAID)); !out.OK {
		t.Fatalf("the first score was refused: %s", out.Error)
	}
	short, err := shortenFormat(ctx, d, shortenIn{TournamentID: f.ID, BestOf: 1, PointsToWin: 11})
	if err != nil || !short.OK {
		t.Fatalf("shorten: %v %v", short, err)
	}
	if short.Note != "What is left is now one game to 11." {
		t.Errorf("shorten said %q", short.Note)
	}

	out, err := saveResult(ctx, d, saveResultIn{
		MatchID: first.ID, ResultType: "normal", Reason: "second game was 11-9",
		Games: []wireGame{{GameNo: 1, ScoreA: 11, ScoreB: 6}, {GameNo: 2, ScoreA: 11, ScoreB: 9}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !out.OK {
		t.Fatalf("correcting a best-of-three match after shortening was refused: %s", out.Error)
	}
	if got := len(f.match(t, first.ID).Games); got != 2 {
		t.Errorf("the corrected match has %d games", got)
	}
}

// The score screen carries the version it loaded. A match that moved on in the
// meantime is not overwritten from a stale screen.
func TestAStaleScoreScreenIsToldToLookAgain(t *testing.T) {
	d := deps(t)
	f := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "none", Teams: 4, Courts: 1})
	f.flow(t)

	stale := 0
	out, err := saveResult(context.Background(), d, saveResultIn{
		MatchID: f.Matches[0].ID, ResultType: "normal", ExpectedVersion: &stale,
		Games: []wireGame{{GameNo: 1, ScoreA: 11, ScoreB: 6}, {GameNo: 2, ScoreA: 11, ScoreB: 4}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.OK || out.Recover != "reload" {
		t.Fatalf("got %v; a screen looking at the wrong thing has to be told to reload", out)
	}
	if f.match(t, f.Matches[0].ID).ResultState != "none" {
		t.Error("the stale save was written anyway")
	}
}

// Everything the keypad screen needs, and nothing it should not have.
func TestGetMatchForScoring(t *testing.T) {
	d := deps(t)
	ctx := context.Background()
	f := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "final_only", Teams: 4, Courts: 1})
	f.flow(t)

	got, err := getMatchForScoring(ctx, d, f.Matches[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.CategoryName != "Men's Doubles" {
		t.Errorf("the eyebrow says %q", got.CategoryName)
	}
	if got.NameA != f.Names[deref(f.Matches[0].TeamAID)] {
		t.Errorf("side A is %q", got.NameA)
	}
	if got.CourtName == nil || *got.CourtName != "Court 1" {
		t.Error("a live match should say which court it is on")
	}
	if got.Rules.BestOf != 3 || got.Rules.PointsToWin != 11 || got.Rules.WinBy != 2 || got.Rules.HardCap != nil {
		t.Errorf("the rules are %+v; v4 is best of 3 to 11, win by 2, no cap", got.Rules)
	}
	if len(got.Games) != 0 {
		t.Error("a match with no score has no games")
	}

	// A match whose sides are not known is not a match a score can be entered
	// for.
	if _, err := getMatchForScoring(ctx, d, f.knockout()[0].ID); err == nil {
		t.Error("the unresolved final should be a 404")
	}

	// Once it is played the court is off the screen, and the existing result is
	// there for the correction view.
	f.win(t, f.Matches[0].ID, deref(f.Matches[0].TeamAID))
	got, err = getMatchForScoring(ctx, d, f.Matches[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.CourtName != nil {
		t.Error("a correction an hour later has no business shouting COURT 1")
	}
	if got.Match.ResultState != "final" || len(got.Games) != 2 {
		t.Errorf("the correction view has %s and %d games", got.Match.ResultState, len(got.Games))
	}
}
