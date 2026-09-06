package engine

// Ported from app/src/lib/__tests__/engine.test.ts — the rules, validation,
// walkover, retirement and horn sections, with the same inputs and the same
// expected values. The reason strings are asserted character for character:
// the score screen prints them and the browser walks read them back.

import (
	"reflect"
	"testing"
)

// capAt is a hard cap as a pointer, the shape ScoringRules wants.
func capAt(n int) *int { return &n }

func TestGameWinnerNeedsTheTargetScoreAndTheWinningMargin(t *testing.T) {
	cases := []struct {
		a, b int
		want string
	}{
		{11, 9, "A"},
		{9, 11, "B"},
		{11, 10, ""},
		{10, 8, ""},
		{13, 11, "A"},
	}
	for _, c := range cases {
		if got := GameWinner(DefaultRules, Game{GameNo: 1, ScoreA: c.a, ScoreB: c.b}); got != c.want {
			t.Errorf("GameWinner(%d-%d) = %q, want %q", c.a, c.b, got, c.want)
		}
	}
}

func TestGameWinnerRefusesAScoreNoRallySequenceCouldProduce(t *testing.T) {
	// Past the target you can only ever be exactly two clear.
	if got := GameWinner(DefaultRules, Game{GameNo: 1, ScoreA: 12, ScoreB: 3}); got != "" {
		t.Errorf("12-3 = %q, want no winner", got)
	}
	if got := GameWinner(DefaultRules, Game{GameNo: 1, ScoreA: 21, ScoreB: 3}); got != "" {
		t.Errorf("21-3 = %q, want no winner", got)
	}
	capped := DefaultRules
	capped.HardCap = capAt(15)
	if got := GameWinner(capped, Game{GameNo: 1, ScoreA: 16, ScoreB: 3}); got != "" {
		t.Errorf("16-3 past a cap of 15 = %q, want no winner", got)
	}
}

func TestGameWinnerWinsByOneAtTheHardCap(t *testing.T) {
	capped := DefaultRules
	capped.HardCap = capAt(15)
	cases := []struct {
		a, b int
		want string
	}{
		{15, 14, "A"},
		{14, 14, ""},
		{14, 15, "B"},
	}
	for _, c := range cases {
		if got := GameWinner(capped, Game{GameNo: 1, ScoreA: c.a, ScoreB: c.b}); got != c.want {
			t.Errorf("GameWinner(%d-%d, cap 15) = %q, want %q", c.a, c.b, got, c.want)
		}
	}
}

func TestGameWinnerGivesATimeCappedGameToWhoeverWasAhead(t *testing.T) {
	if got := GameWinner(DefaultRules, Game{GameNo: 1, ScoreA: 7, ScoreB: 5, TimeCapped: true}); got != "A" {
		t.Errorf("7-5 on the horn = %q, want A", got)
	}
	if got := GameWinner(DefaultRules, Game{GameNo: 1, ScoreA: 6, ScoreB: 6, TimeCapped: true}); got != "" {
		t.Errorf("6-6 on the horn = %q, want no winner", got)
	}
}

func TestGameWinnerHandlesASingleGameTo15(t *testing.T) {
	to15 := ScoringRules{BestOf: 1, PointsToWin: 15, WinBy: 2}
	cases := []struct {
		a, b int
		want string
	}{
		{15, 13, "A"},
		{15, 14, ""},
		{17, 15, "A"},
	}
	for _, c := range cases {
		if got := GameWinner(to15, Game{GameNo: 1, ScoreA: c.a, ScoreB: c.b}); got != c.want {
			t.Errorf("GameWinner(%d-%d, to 15) = %q, want %q", c.a, c.b, got, c.want)
		}
	}
}

func TestRulesForIsTheDefaultsWithTheTournamentsNumbers(t *testing.T) {
	r := RulesFor(1, 15)
	want := ScoringRules{BestOf: 1, PointsToWin: 15, WinBy: 2, HardCap: nil}
	if !reflect.DeepEqual(r, want) {
		t.Errorf("RulesFor(1, 15) = %+v, want %+v", r, want)
	}
	if got := GamesNeededToWin(RulesFor(1, 11)); got != 1 {
		t.Errorf("best of 1 needs %d games, want 1", got)
	}
	if got := GamesNeededToWin(DefaultRules); got != 2 {
		t.Errorf("best of 3 needs %d games, want 2", got)
	}
}

func TestValidateAcceptsANormalBestOfThree(t *testing.T) {
	v := ValidateGames(DefaultRules, []Game{
		{GameNo: 1, ScoreA: 11, ScoreB: 9},
		{GameNo: 2, ScoreA: 8, ScoreB: 11},
		{GameNo: 3, ScoreA: 11, ScoreB: 6},
	})
	if !v.OK || v.Reason != "" {
		t.Errorf("a normal best-of-three came back %+v", v)
	}
}

func TestValidateRejectsAThirdGameAfterAStraightSetsWin(t *testing.T) {
	v := ValidateGames(DefaultRules, []Game{
		{GameNo: 1, ScoreA: 11, ScoreB: 9},
		{GameNo: 2, ScoreA: 11, ScoreB: 4},
		{GameNo: 3, ScoreA: 11, ScoreB: 6},
	})
	if v.OK {
		t.Fatal("a dead rubber was accepted")
	}
	if v.Reason != "The match was already won after game 2." {
		t.Errorf("reason = %q", v.Reason)
	}
}

func TestValidateRejectsAnUnfinishedScoreButAllowsATimeCappedOne(t *testing.T) {
	v := ValidateGames(DefaultRules, []Game{{GameNo: 1, ScoreA: 7, ScoreB: 5}})
	if v.OK {
		t.Fatal("7-5 was accepted as a finished game")
	}
	if v.Reason != "7-5 isn’t a finished game — first to 11, win by 2." {
		t.Errorf("reason = %q", v.Reason)
	}
	if v := ValidateGames(DefaultRules, []Game{{GameNo: 1, ScoreA: 7, ScoreB: 5, TimeCapped: true}}); !v.OK {
		t.Errorf("the horn's 7-5 was refused: %q", v.Reason)
	}
}

func TestValidateRejectsADuplicatedGameNumber(t *testing.T) {
	// Because the ledger write would fail halfway through.
	v := ValidateGames(DefaultRules, []Game{
		{GameNo: 1, ScoreA: 11, ScoreB: 9},
		{GameNo: 1, ScoreA: 11, ScoreB: 9},
	})
	if v.OK {
		t.Fatal("a repeated game number was accepted")
	}
	if v.Reason != "Game 1 is in there twice." {
		t.Errorf("reason = %q", v.Reason)
	}
}

func TestValidateReasonsAreTheReferencesWords(t *testing.T) {
	toCap := DefaultRules
	toCap.HardCap = capAt(15)
	cases := []struct {
		name  string
		rules ScoringRules
		games []Game
		want  string
	}{
		{"no games", DefaultRules, nil, "No games recorded."},
		{"too many games", DefaultRules, []Game{
			{GameNo: 1, ScoreA: 11, ScoreB: 9},
			{GameNo: 2, ScoreA: 9, ScoreB: 11},
			{GameNo: 3, ScoreA: 11, ScoreB: 9},
			{GameNo: 4, ScoreA: 11, ScoreB: 9},
		}, "A best-of-3 match can't have 4 games."},
		{"game number nought", DefaultRules, []Game{{GameNo: 0, ScoreA: 11, ScoreB: 9}},
			"That isn’t a game number."},
		{"negative score", DefaultRules, []Game{{GameNo: 1, ScoreA: -1, ScoreB: 9}},
			"Scores can’t be negative."},
		{"unfinished under a cap", toCap, []Game{{GameNo: 1, ScoreA: 12, ScoreB: 11}},
			"12-11 isn’t a finished game — first to 15, win by 2."},
		{"already won", DefaultRules, []Game{
			{GameNo: 1, ScoreA: 11, ScoreB: 2},
			{GameNo: 2, ScoreA: 11, ScoreB: 3},
			{GameNo: 3, ScoreA: 11, ScoreB: 4},
		}, "The match was already won after game 2."},
	}
	for _, c := range cases {
		v := ValidateGames(c.rules, c.games)
		if v.OK || v.Reason != c.want {
			t.Errorf("%s: got %+v, want reason %q", c.name, v, c.want)
		}
	}
}

func TestOutcomeNeedsTwoGamesInABestOfThree(t *testing.T) {
	one := Outcome(DefaultRules, []Game{{GameNo: 1, ScoreA: 11, ScoreB: 3}})
	if one.Complete {
		t.Errorf("one game finished the match: %+v", one)
	}
	two := Outcome(DefaultRules, []Game{
		{GameNo: 1, ScoreA: 11, ScoreB: 3},
		{GameNo: 2, ScoreA: 11, ScoreB: 7},
	})
	want := MatchOutcome{Complete: true, Winner: "A", GamesWonA: 2, GamesWonB: 0}
	if two != want {
		t.Errorf("two games = %+v, want %+v", two, want)
	}
}

func TestCappedDiffClampsToEightEitherWay(t *testing.T) {
	cases := [][3]int{{11, 0, 8}, {0, 11, -8}, {11, 9, 2}}
	for _, c := range cases {
		if got := CappedDiff(c[0], c[1]); got != c[2] {
			t.Errorf("CappedDiff(%d, %d) = %d, want %d", c[0], c[1], got, c[2])
		}
	}
}

func TestWalkoverRecordsTwoGamesToLove(t *testing.T) {
	games := WalkoverGames(DefaultRules)
	if len(games) != 2 {
		t.Fatalf("a walkover is %d games, want 2", len(games))
	}
	for i, g := range games {
		if g.GameNo != i+1 || g.ScoreA != 11 || g.ScoreB != 0 {
			t.Errorf("game %d = %+v, want %d: 11-0", i+1, g, i+1)
		}
		// The reference leaves this to its caller, which excludes every game
		// of a walkover; here the games carry it themselves.
		if !g.ExcludeFromDiff {
			t.Errorf("game %d counts towards point difference", i+1)
		}
	}
	if got := len(WalkoverGames(RulesFor(1, 11))); got != 1 {
		t.Errorf("a best-of-one walkover is %d games, want 1", got)
	}
}

func TestRetirementFinishesTheGameInProgressAndAwardsTheRest(t *testing.T) {
	games, excludeFromDiff := RetirementGames(DefaultRules,
		[]Game{{GameNo: 1, ScoreA: 5, ScoreB: 3}}, "B")

	want0 := Game{GameNo: 1, ScoreA: 11, ScoreB: 3}
	if games[0] != want0 {
		t.Errorf("game 1 = %+v, want %+v", games[0], want0)
	}
	if len(games) != 2 {
		t.Fatalf("%d games, want 2", len(games))
	}
	if !reflect.DeepEqual(excludeFromDiff, []int{2}) {
		t.Errorf("excludeFromDiff = %v, want [2]", excludeFromDiff)
	}
	if !games[1].ExcludeFromDiff {
		t.Error("the game nobody played counts towards point difference")
	}
	if got := Outcome(DefaultRules, games).Winner; got != "A" {
		t.Errorf("winner = %q, want A", got)
	}
}

func TestRetirementKeepsThePointsThatWereActuallyPlayed(t *testing.T) {
	rules := ScoringRules{BestOf: 3, PointsToWin: 11, WinBy: 2}
	// Lost game 1 9-11, then pulled a calf between games.
	games, excludeFromDiff := RetirementGames(rules,
		[]Game{{GameNo: 1, ScoreA: 9, ScoreB: 11}}, "A")
	if len(games) != 2 {
		t.Fatalf("%d games, want 2", len(games))
	}
	if !reflect.DeepEqual(excludeFromDiff, []int{2}) {
		t.Errorf("excludeFromDiff = %v, want [2]", excludeFromDiff)
	}

	rows := TallyRows([]string{"a", "b"}, []StandingsMatch{{
		MatchID: "m", TeamAID: "a", TeamBID: "b", WinnerTeamID: "b",
		State: "final", ResultType: "retired", Games: games,
	}})
	// The game they played counts in full; the one they didn't counts nowhere.
	if got := rows["b"].PointsFor; got != 11 {
		t.Errorf("points for = %d, want 11", got)
	}
	if got := rows["b"].GamesWon; got != 1 {
		t.Errorf("games won = %d, want 1", got)
	}
	if got := rows["b"].PointDiff; got != 2 {
		t.Errorf("point difference = %d, want 2", got)
	}
}

func TestRetirementFinishesAboveASideThatWasAhead(t *testing.T) {
	// 11-11 is not a finished game: the side still standing takes it at winBy
	// above the side that stopped, or the match comes back with no winner.
	games, excludeFromDiff := RetirementGames(DefaultRules,
		[]Game{{GameNo: 1, ScoreA: 11, ScoreB: 11}}, "A")
	if games[0].ScoreB != 13 {
		t.Errorf("game 1 = %+v, want 11-13", games[0])
	}
	if len(games) != 2 || len(excludeFromDiff) != 1 || excludeFromDiff[0] != 2 {
		t.Errorf("games = %+v, exclude = %v", games, excludeFromDiff)
	}
	if got := Outcome(DefaultRules, games).Winner; got != "B" {
		t.Errorf("winner = %q, want B", got)
	}
}

func TestRetirementBeforeAnyGameIsPlayed(t *testing.T) {
	games, excludeFromDiff := RetirementGames(DefaultRules, nil, "B")
	if len(games) != 2 {
		t.Fatalf("%d games, want 2", len(games))
	}
	if !reflect.DeepEqual(excludeFromDiff, []int{1, 2}) {
		t.Errorf("excludeFromDiff = %v, want [1 2]", excludeFromDiff)
	}
	if got := Outcome(DefaultRules, games).Winner; got != "A" {
		t.Errorf("winner = %q, want A", got)
	}
}

func TestHornEndsTheMatchOnOneCappedGame(t *testing.T) {
	rules := ScoringRules{BestOf: 3, PointsToWin: 11, WinBy: 2}
	o := HornOutcome(rules, []Game{{GameNo: 1, ScoreA: 8, ScoreB: 6, TimeCapped: true}})
	if !o.Complete || o.Winner != "A" {
		t.Errorf("horn on 8-6 = %+v, want A, complete", o)
	}
}

func TestHornLevelOnGamesIsDecidedByTheGameItStopped(t *testing.T) {
	// A won game 1 in a blowout; B was winning the game the horn stopped.
	// Summing every point would hand it to A — which is the blowout SPEC A6
	// caps out of the tiebreak precisely so it cannot decide anything.
	rules := ScoringRules{BestOf: 3, PointsToWin: 11, WinBy: 2}
	o := HornOutcome(rules, []Game{
		{GameNo: 1, ScoreA: 11, ScoreB: 2},
		{GameNo: 2, ScoreA: 2, ScoreB: 8, TimeCapped: true},
	})
	if o.Winner != "B" {
		t.Errorf("winner = %q, want B", o.Winner)
	}
}

func TestHornLeadingInGamesWinsEvenWhenBehindOnTheCappedGame(t *testing.T) {
	rules := ScoringRules{BestOf: 3, PointsToWin: 11, WinBy: 2}
	o := HornOutcome(rules, []Game{
		{GameNo: 1, ScoreA: 11, ScoreB: 9},
		{GameNo: 2, ScoreA: 11, ScoreB: 4},
	})
	if !o.Complete || o.Winner != "A" {
		t.Errorf("horn = %+v, want A, complete", o)
	}
}

func TestHornRefusesToCallAMatchLevelOnGamesAndOnTheCappedGame(t *testing.T) {
	rules := ScoringRules{BestOf: 3, PointsToWin: 11, WinBy: 2}
	o := HornOutcome(rules, []Game{
		{GameNo: 1, ScoreA: 11, ScoreB: 9},
		{GameNo: 2, ScoreA: 9, ScoreB: 11},
		{GameNo: 3, ScoreA: 6, ScoreB: 6, TimeCapped: true},
	})
	if o.Complete || o.Winner != "" {
		t.Errorf("horn = %+v, want no winner", o)
	}
}

func TestHornWithNothingPlayedCallsNobody(t *testing.T) {
	o := HornOutcome(DefaultRules, nil)
	if o.Complete || o.Winner != "" {
		t.Errorf("horn on no games = %+v, want no winner", o)
	}
}
