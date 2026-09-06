package engine

// Ported from app/src/lib/__tests__/engine.test.ts — the "standings" section,
// plus the tiebreak ladder's own cases (mini-table, dead heat, the notes
// printed under the table). Every expected reason string was captured from
// the reference by running it.
//
// The reference's 'reported' and 'disputed' states have no test here: v4 has
// only 'final' and 'voided', so provisional and disputed rows can no longer
// occur.

import (
	"reflect"
	"testing"
)

// won builds the test-suite's helper match: A wins the games it leads.
func won(matchID, a, b string, games [][2]int) StandingsMatch {
	gs := make([]Game, len(games))
	aw, bw := 0, 0
	for i, g := range games {
		gs[i] = Game{GameNo: i + 1, ScoreA: g[0], ScoreB: g[1]}
		if g[0] > g[1] {
			aw++
		} else {
			bw++
		}
	}
	winner := b
	if aw > bw {
		winner = a
	}
	return StandingsMatch{
		MatchID: matchID, TeamAID: a, TeamBID: b, WinnerTeamID: winner,
		State: "final", ResultType: "normal", Games: gs,
	}
}

func order(rows []TeamRow) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = r.TeamID
	}
	return out
}

func reasons(rows []TeamRow) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = r.Reason
	}
	return out
}

func find(t *testing.T, rows []TeamRow, id string) TeamRow {
	t.Helper()
	for _, r := range rows {
		if r.TeamID == id {
			return r
		}
	}
	t.Fatalf("no row for %q", id)
	return TeamRow{}
}

func TestStandingsRanksOnRecordFirst(t *testing.T) {
	rows := Standings([]string{"a", "b", "c"}, []StandingsMatch{
		won("1", "a", "b", [][2]int{{11, 5}, {11, 6}}),
		won("2", "a", "c", [][2]int{{11, 7}, {11, 9}}),
		won("3", "b", "c", [][2]int{{11, 3}, {11, 4}}),
	}, PointsScoredFirst)
	if got := order(rows); !reflect.DeepEqual(got, []string{"a", "b", "c"}) {
		t.Fatalf("order %v", got)
	}
	wantReasons := []string{
		"ahead on wins — 2 won from 2 played",
		"between the others on wins — 1 won from 2 played",
		"behind on wins — 0 won from 2 played",
	}
	if got := reasons(rows); !reflect.DeepEqual(got, wantReasons) {
		t.Fatalf("reasons %q, want %q", got, wantReasons)
	}
}

func TestStandingsUsesTotalPointsScoredWhenLevel(t *testing.T) {
	// a, b and c are all 1-1. c scored the most overall — the venue's rule.
	matches := []StandingsMatch{
		won("1", "a", "b", [][2]int{{11, 5}, {11, 5}}),
		won("2", "b", "c", [][2]int{{11, 9}, {11, 9}}),
		won("3", "c", "a", [][2]int{{11, 2}, {11, 2}}),
	}
	rows := Standings([]string{"a", "b", "c"}, matches, PointsScoredFirst)
	best := rows[0]
	for _, r := range rows {
		if r.PointsFor > best.PointsFor {
			t.Fatalf("%s scored more than the top row %s", r.TeamID, best.TeamID)
		}
	}
	if best.Reason != "ahead on total points scored" {
		t.Fatalf("reason %q", best.Reason)
	}
	if got := order(rows); !reflect.DeepEqual(got, []string{"c", "b", "a"}) {
		t.Fatalf("order %v, want [c b a]", got)
	}
}

func TestStandingsSurvivesAPerfectlySymmetricThreeWayTie(t *testing.T) {
	matches := []StandingsMatch{
		won("1", "a", "b", [][2]int{{11, 5}, {11, 5}}),
		won("2", "b", "c", [][2]int{{11, 5}, {11, 5}}),
		won("3", "c", "a", [][2]int{{11, 5}, {11, 5}}),
	}
	rows := Standings([]string{"a", "b", "c"}, matches, HeadToHeadFirst)
	// Everything is equal, so it must not crash or invent an ordering it
	// cannot justify — and it must say so.
	if len(rows) != 3 {
		t.Fatalf("got %d rows, want 3", len(rows))
	}
	for _, r := range rows {
		if r.Won != 1 || r.Lost != 1 {
			t.Fatalf("%s is %d-%d, want 1-1", r.TeamID, r.Won, r.Lost)
		}
		if r.Reason != "drawn — level on everything, kept in the order the pairs were made" {
			t.Fatalf("reason %q", r.Reason)
		}
	}
	if got := order(rows); !reflect.DeepEqual(got, []string{"a", "b", "c"}) {
		t.Fatalf("a dead heat must keep seed order, got %v", got)
	}
}

func TestStandingsHeadToHeadFirstFallsThroughToTheMiniTable(t *testing.T) {
	// A three-way tie under head_to_head_first: head-to-head only settles
	// exactly two, so the mini-table over the matches among them decides,
	// and the reason says which column did it.
	matches := []StandingsMatch{
		won("1", "a", "b", [][2]int{{11, 5}, {11, 5}}),
		won("2", "b", "c", [][2]int{{11, 9}, {11, 9}}),
		won("3", "c", "a", [][2]int{{11, 2}, {11, 2}}),
	}
	rows := Standings([]string{"a", "b", "c"}, matches, HeadToHeadFirst)
	if got := order(rows); !reflect.DeepEqual(got, []string{"c", "a", "b"}) {
		t.Fatalf("order %v, want [c a b]", got)
	}
	want := []string{
		"ahead on point difference between the tied teams",
		"between the others on point difference between the tied teams",
		"behind on point difference between the tied teams",
	}
	if got := reasons(rows); !reflect.DeepEqual(got, want) {
		t.Fatalf("reasons %q, want %q", got, want)
	}
}

func TestStandingsSettlesTwoOnHeadToHeadOncePointsAreEqualToo(t *testing.T) {
	// a and b are both 1-1 with 32 points scored each; a beat b, so a goes
	// through. c has one win from one match and fewer points; d has none.
	matches := []StandingsMatch{
		won("1", "a", "b", [][2]int{{11, 5}, {11, 5}}),
		won("2", "c", "a", [][2]int{{11, 5}, {11, 5}}),
		won("3", "b", "d", [][2]int{{11, 5}, {11, 5}}),
	}
	rows := Standings([]string{"a", "b", "c", "d"}, matches, PointsScoredFirst)
	if got := order(rows); !reflect.DeepEqual(got, []string{"a", "b", "c", "d"}) {
		t.Fatalf("order %v, want [a b c d] — a beat b", got)
	}
	want := []string{
		"ahead on head-to-head",
		"behind on head-to-head",
		"behind on total points scored",
		"behind on wins — 0 won from 1 played",
	}
	if got := reasons(rows); !reflect.DeepEqual(got, want) {
		t.Fatalf("reasons %q, want %q", got, want)
	}
	if a := find(t, rows, "a"); a.PointsFor != 32 {
		t.Fatalf("a scored %d, want 32 — the tie has to be a real one", a.PointsFor)
	}
}

func TestStandingsRanksOnWinsCountedNotRatio(t *testing.T) {
	// a: 2 from 2. b: 2 from 3 with more points. Level on wins → points.
	rows := Standings([]string{"a", "b", "c", "d"}, []StandingsMatch{
		won("1", "a", "c", [][2]int{{11, 5}, {11, 5}}),
		won("2", "a", "d", [][2]int{{11, 5}, {11, 5}}),
		won("3", "b", "c", [][2]int{{11, 5}, {11, 5}}),
		won("4", "b", "d", [][2]int{{11, 5}, {11, 5}}),
		won("5", "c", "b", [][2]int{{11, 9}, {11, 9}}),
	}, PointsScoredFirst)
	// Fewer wins from fewer matches ranks below more wins, whatever the ratio.
	if got := order(rows); !reflect.DeepEqual(got, []string{"b", "a", "c", "d"}) {
		t.Fatalf("order %v, want [b a c d]", got)
	}
	if rows[0].TeamID != "b" || rows[0].Reason != "ahead on total points scored" {
		t.Fatalf("top row %+v", rows[0])
	}
	if rows[1].TeamID != "a" || rows[1].Reason != "behind on total points scored" {
		t.Fatalf("second row %+v", rows[1])
	}
	if rows[2].Reason != "between the others on wins — 1 won from 3 played" {
		t.Fatalf("third reason %q", rows[2].Reason)
	}
	if rows[3].Reason != "behind on wins — 0 won from 2 played" {
		t.Fatalf("fourth reason %q", rows[3].Reason)
	}
	// The ratio would have put a first; the counted wins column beside the
	// name must not contradict the order.
	if a := find(t, rows, "a"); a.WinRatio != 1 {
		t.Fatalf("a's win ratio %v, want 1", a.WinRatio)
	}
}

func walkover(matchID, a, b string) StandingsMatch {
	return StandingsMatch{
		MatchID: matchID, TeamAID: a, TeamBID: b, WinnerTeamID: a,
		State: "final", ResultType: "walkover",
		Games: []Game{{GameNo: 1, ScoreA: 11, ScoreB: 0}, {GameNo: 2, ScoreA: 11, ScoreB: 0}},
	}
}

func TestTallyGivesAWalkoverTheWinButNothingTowardsDifference(t *testing.T) {
	rows := TallyRows([]string{"a", "b"}, []StandingsMatch{walkover("1", "a", "b")})
	a, b := rows["a"], rows["b"]
	if a.Won != 1 || a.Played != 1 {
		t.Fatalf("a is %d won from %d played", a.Won, a.Played)
	}
	if a.PointDiff != 0 || a.PointsFor != 0 || a.PointsAgainst != 0 {
		t.Fatalf("a's points %+v", a)
	}
	// And nothing towards game difference either — capping only point
	// difference would let a match nobody played decide the pool.
	if a.GamesWon != 0 || a.GameDiff != 0 || b.GameDiff != 0 {
		t.Fatalf("a %+v b %+v", a, b)
	}
	if b.Lost != 1 {
		t.Fatalf("b lost %d, want 1", b.Lost)
	}
}

func TestStandingsIsNotSwungByAWalkoverWhenEverythingElseIsLevel(t *testing.T) {
	// a and b both beat c; a additionally got a walkover over d.
	rows := Standings([]string{"a", "b", "c", "d"}, []StandingsMatch{
		won("1", "a", "c", [][2]int{{11, 5}, {11, 5}}),
		won("2", "b", "c", [][2]int{{11, 5}, {11, 5}}),
		walkover("3", "a", "d"),
	}, PointsScoredFirst)
	a := find(t, rows, "a")
	b := find(t, rows, "b")
	if a.GameDiff != b.GameDiff {
		t.Fatalf("game difference %d vs %d", a.GameDiff, b.GameDiff)
	}
	if a.PointsFor != b.PointsFor {
		t.Fatalf("points for %d vs %d", a.PointsFor, b.PointsFor)
	}
	if got := order(rows); !reflect.DeepEqual(got, []string{"a", "b", "c", "d"}) {
		t.Fatalf("order %v", got)
	}
}

func TestTallyIgnoresVoidedMatchesEntirely(t *testing.T) {
	m := won("1", "a", "b", [][2]int{{11, 5}, {11, 5}})
	m.State = "voided"
	rows := TallyRows([]string{"a", "b"}, []StandingsMatch{m})
	if rows["a"].Played != 0 || rows["a"].Won != 0 {
		t.Fatalf("a %+v — a voided match counts for nothing, played included", rows["a"])
	}
	if rows["b"].Played != 0 || rows["b"].Lost != 0 {
		t.Fatalf("b %+v", rows["b"])
	}
}

func TestTallyIgnoresACancelledMatch(t *testing.T) {
	m := won("1", "a", "b", [][2]int{{11, 5}, {11, 5}})
	m.ResultType = "cancelled"
	rows := TallyRows([]string{"a", "b"}, []StandingsMatch{m})
	if rows["a"].Played != 0 {
		t.Fatalf("a played %d, want 0", rows["a"].Played)
	}
}

func TestTallyCapsABlowoutSoItCannotDecideAPool(t *testing.T) {
	rows := TallyRows([]string{"a", "b"}, []StandingsMatch{won("1", "a", "b", [][2]int{{11, 0}, {11, 0}})})
	if got := rows["a"].PointDiff; got != 16 {
		t.Fatalf("point difference %d, want 16 (8 + 8, not 22)", got)
	}
	if got := rows["b"].PointDiff; got != -16 {
		t.Fatalf("b's point difference %d, want -16", got)
	}
	if rows["a"].PointsFor != 22 {
		t.Fatalf("the points themselves still count: %d", rows["a"].PointsFor)
	}
}

func TestTallyKeepsATimeCappedGamesPointsButNotItsDifference(t *testing.T) {
	// The horn stopped game 2 at 7-4. It WAS played, so the points count and
	// the game counts; only point difference leaves it out.
	rows := TallyRows([]string{"a", "b"}, []StandingsMatch{{
		MatchID: "1", TeamAID: "a", TeamBID: "b", WinnerTeamID: "a",
		State: "final", ResultType: "normal",
		Games: []Game{
			{GameNo: 1, ScoreA: 11, ScoreB: 5},
			{GameNo: 2, ScoreA: 7, ScoreB: 4, ExcludeFromDiff: true, TimeCapped: true},
		},
	}})
	a := rows["a"]
	if a.PointsFor != 18 || a.PointsAgainst != 9 {
		t.Fatalf("a's points %d-%d, want 18-9", a.PointsFor, a.PointsAgainst)
	}
	if a.GamesWon != 2 || a.GameDiff != 2 {
		t.Fatalf("a won %d games, difference %d, want 2 and 2", a.GamesWon, a.GameDiff)
	}
	if a.PointDiff != 6 {
		t.Fatalf("point difference %d, want 6 — only game 1 counts", a.PointDiff)
	}
}

func TestTallyDropsARetirementsPhantomGamesEntirely(t *testing.T) {
	// Game 3 is the 11-0 a retirement fills in for a game nobody played: it
	// contributes to nothing at all, not even game difference.
	rows := TallyRows([]string{"a", "b"}, []StandingsMatch{{
		MatchID: "1", TeamAID: "a", TeamBID: "b", WinnerTeamID: "a",
		State: "final", ResultType: "retired",
		Games: []Game{
			{GameNo: 1, ScoreA: 11, ScoreB: 5},
			{GameNo: 2, ScoreA: 11, ScoreB: 3},
			{GameNo: 3, ScoreA: 11, ScoreB: 0, ExcludeFromDiff: true},
		},
	}})
	a := rows["a"]
	if a.PointsFor != 22 || a.PointsAgainst != 8 {
		t.Fatalf("a's points %d-%d, want 22-8", a.PointsFor, a.PointsAgainst)
	}
	if a.GamesWon != 2 || a.GameDiff != 2 {
		t.Fatalf("a won %d games, difference %d, want 2 and 2", a.GamesWon, a.GameDiff)
	}
	if a.PointDiff != 14 {
		t.Fatalf("point difference %d, want 14 (6 + 8)", a.PointDiff)
	}
}

func TestTallyNeverFlagsProvisionalOrDisputed(t *testing.T) {
	// v4 dropped the confirm/dispute flow: every result is final or voided.
	rows := TallyRows([]string{"a", "b"}, []StandingsMatch{won("1", "a", "b", [][2]int{{11, 5}, {11, 5}})})
	if rows["a"].Provisional || rows["a"].Disputed {
		t.Fatalf("a %+v", rows["a"])
	}
}

func TestTallyIgnoresAMatchWithAStranger(t *testing.T) {
	rows := TallyRows([]string{"a", "b"}, []StandingsMatch{won("1", "a", "z", [][2]int{{11, 5}, {11, 5}})})
	if rows["a"].Played != 0 {
		t.Fatalf("a played %d, want 0 — z is not in this pool", rows["a"].Played)
	}
	if _, ok := rows["z"]; ok {
		t.Fatal("z should not have a row")
	}
}

func TestTallyWinRatio(t *testing.T) {
	rows := TallyRows([]string{"a", "b", "c"}, []StandingsMatch{
		won("1", "a", "b", [][2]int{{11, 5}, {11, 5}}),
		won("2", "c", "a", [][2]int{{11, 5}, {11, 5}}),
	})
	if got := rows["a"].WinRatio; got != 0.5 {
		t.Fatalf("a's win ratio %v, want 0.5", got)
	}
	if got := rows["b"].WinRatio; got != 0 {
		t.Fatalf("b's win ratio %v, want 0", got)
	}
}

func TestStandingsDeadHeatKeepsTheOrderThePairsWereMade(t *testing.T) {
	for _, ids := range [][]string{{"a", "b"}, {"a", "b", "c", "d"}} {
		rows := Standings(ids, nil, PointsScoredFirst)
		if got := order(rows); !reflect.DeepEqual(got, ids) {
			t.Fatalf("order %v, want %v", got, ids)
		}
		for _, r := range rows {
			if r.Reason != "drawn — level on everything, kept in the order the pairs were made" {
				t.Fatalf("reason %q", r.Reason)
			}
		}
	}
}

func TestStandingsMiniTableCanStillEndInADeadHeat(t *testing.T) {
	// a, b and c beat each other in a ring and each thrashed d by the same
	// margin: level on everything, in and out of the mini-table.
	rows := Standings([]string{"a", "b", "c", "d"}, []StandingsMatch{
		won("1", "a", "b", [][2]int{{11, 9}, {11, 9}}),
		won("2", "b", "c", [][2]int{{11, 9}, {11, 9}}),
		won("3", "c", "a", [][2]int{{11, 9}, {11, 9}}),
		won("4", "a", "d", [][2]int{{11, 1}, {11, 1}}),
		won("5", "b", "d", [][2]int{{11, 1}, {11, 1}}),
		won("6", "c", "d", [][2]int{{11, 1}, {11, 1}}),
	}, PointsScoredFirst)
	if got := order(rows); !reflect.DeepEqual(got, []string{"a", "b", "c", "d"}) {
		t.Fatalf("order %v", got)
	}
	want := []string{
		"drawn — level on everything, kept in the order the pairs were made",
		"drawn — level on everything, kept in the order the pairs were made",
		"drawn — level on everything, kept in the order the pairs were made",
		"behind on wins — 0 won from 3 played",
	}
	if got := reasons(rows); !reflect.DeepEqual(got, want) {
		t.Fatalf("reasons %q, want %q", got, want)
	}
}

func TestStandingsDefaultsToTheVenuesRule(t *testing.T) {
	// The reference's rule argument defaults to points_scored_first; an
	// unset TiebreakRule must mean the same thing.
	matches := []StandingsMatch{
		won("1", "a", "b", [][2]int{{11, 5}, {11, 5}}),
		won("2", "b", "c", [][2]int{{11, 9}, {11, 9}}),
		won("3", "c", "a", [][2]int{{11, 2}, {11, 2}}),
	}
	byDefault := Standings([]string{"a", "b", "c"}, matches, "")
	explicit := Standings([]string{"a", "b", "c"}, matches, PointsScoredFirst)
	if !reflect.DeepEqual(byDefault, explicit) {
		t.Fatalf("an unset rule gave %v, want %v", order(byDefault), order(explicit))
	}
}

func TestTiebreakNote(t *testing.T) {
	points := "Level on record: most total points scored goes through, then head-to-head, then game and point difference. Point difference is capped at 8 per game; a no-show counts as a win but adds nothing to points or difference."
	h2h := "Level on record: head-to-head first, then total points scored, then game and point difference. Point difference is capped at 8 per game; a no-show counts as a win but adds nothing to points or difference."
	if got := TiebreakNote(PointsScoredFirst); got != points {
		t.Fatalf("points note:\n got %q\nwant %q", got, points)
	}
	if got := TiebreakNote(HeadToHeadFirst); got != h2h {
		t.Fatalf("head-to-head note:\n got %q\nwant %q", got, h2h)
	}
	if got := TiebreakNote(""); got != points {
		t.Fatalf("an unset rule must read as the venue's rule, got %q", got)
	}
}

func TestTieNote(t *testing.T) {
	drawn := "drawn — level on everything, kept in the order the pairs were made"
	for _, tc := range []struct {
		reason     string
		leagueDone bool
		want       string
	}{
		{"", true, ""},
		// Wins and points are the two columns beside the name.
		{"ahead on wins — 2 won from 3 played", true, ""},
		{"ahead on total points scored", true, ""},
		{"ahead on wins between the tied teams", true, ""},
		{drawn, true, "level on everything — kept in the order the pairs were made"},
		{drawn, false, "level so far"},
		{"ahead on head-to-head", true, "ahead on head-to-head"},
		{"behind on point difference", false, "behind on point difference"},
	} {
		if got := TieNote(tc.reason, tc.leagueDone); got != tc.want {
			t.Fatalf("TieNote(%q, %v) = %q, want %q", tc.reason, tc.leagueDone, got, tc.want)
		}
	}
}

func TestCappedDiffMatchesTheRulesSide(t *testing.T) {
	// cappedDiff is duplicated from api_rules.go so this package could be
	// ported independently; if the two ever disagree the pools do too.
	for _, tc := range []struct{ a, b, want int }{
		{11, 0, 8}, {0, 11, -8}, {11, 9, 2}, {9, 11, -2}, {11, 3, 8}, {5, 5, 0},
	} {
		if got := CappedDiff(tc.a, tc.b); got != tc.want {
			t.Fatalf("CappedDiff(%d, %d) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}
