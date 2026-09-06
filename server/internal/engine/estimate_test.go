package engine

// Ported from app/src/lib/__tests__/engine.test.ts — the "day estimate"
// section.

import (
	"reflect"
	"testing"
	"time"
)

func at(s string) *time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return &t
}

func TestEstimateReproducesTheWorkedExampleInTheSpec(t *testing.T) {
	est := EstimateDay(EstimateInput{
		Categories: []CategoryLoad{{Name: "all", MatchCount: 55, MinutesPerMatch: 30, MinMatchesPerEntry: 3}},
		Courts:     4,
		StartAt:    at("2026-09-14T03:30:00Z"), // 09:00 IST
	})
	// 55 / 4 * 30 * 1.1 = 453.75 → 454
	if est.Minutes != 454 {
		t.Fatalf("minutes %d, want 454", est.Minutes)
	}
	if est.TotalMatches != 55 {
		t.Fatalf("total matches %d, want 55", est.TotalMatches)
	}
	if est.FinishAt == nil {
		t.Fatal("no finish time")
	}
	if want := at("2026-09-14T11:04:00Z"); !est.FinishAt.Equal(*want) {
		t.Fatalf("finish at %v, want %v", est.FinishAt, want)
	}
	if est.PastSunset {
		t.Fatal("no sunset was given, so nothing can be past it")
	}
}

func TestEstimateAddsUpAcrossCategoriesBecauseTheyShareTheCourts(t *testing.T) {
	one := EstimateDay(EstimateInput{
		Categories: []CategoryLoad{{Name: "a", MatchCount: 30, MinutesPerMatch: 30, MinMatchesPerEntry: 3}},
		Courts:     4,
	})
	two := EstimateDay(EstimateInput{
		Categories: []CategoryLoad{
			{Name: "a", MatchCount: 30, MinutesPerMatch: 30, MinMatchesPerEntry: 3},
			{Name: "b", MatchCount: 25, MinutesPerMatch: 30, MinMatchesPerEntry: 3},
		},
		Courts: 4,
	})
	if two.Minutes <= one.Minutes {
		t.Fatalf("two categories took %d minutes, one took %d", two.Minutes, one.Minutes)
	}
	if two.TotalMatches != 55 {
		t.Fatalf("total matches %d, want 55", two.TotalMatches)
	}
	if len(two.PerCategory) != 2 || two.PerCategory[1].Name != "b" {
		t.Fatalf("per-category %+v", two.PerCategory)
	}
	if one.FinishAt != nil {
		t.Fatal("no start time was given, so there is no finish time")
	}
}

func TestEstimateNoticesWhenTheDayRunsPastSunset(t *testing.T) {
	est := EstimateDay(EstimateInput{
		Categories: []CategoryLoad{{Name: "a", MatchCount: 66, MinutesPerMatch: 30, MinMatchesPerEntry: 11}},
		Courts:     3,
		StartAt:    at("2026-09-14T03:30:00Z"),
		SunsetAt:   at("2026-09-14T12:50:00Z"), // 18:20 IST
	})
	if !est.PastSunset {
		t.Fatalf("finish at %v is past sunset but PastSunset is false", est.FinishAt)
	}
}

func TestEstimateAddsTheBreakAndHonoursOneCourtMinimum(t *testing.T) {
	// The break is added on top of the court time, not scaled by it.
	withBreak := EstimateDay(EstimateInput{
		Categories:   []CategoryLoad{{Name: "a", MatchCount: 55, MinutesPerMatch: 30}},
		Courts:       4,
		BreakMinutes: 45,
	})
	if withBreak.Minutes != 454+45 {
		t.Fatalf("minutes %d, want 499", withBreak.Minutes)
	}
	// Zero courts is not a day with no matches, it is a day on one court.
	none := EstimateDay(EstimateInput{
		Categories: []CategoryLoad{{Name: "a", MatchCount: 10, MinutesPerMatch: 30}},
		Courts:     0,
	})
	one := EstimateDay(EstimateInput{
		Categories: []CategoryLoad{{Name: "a", MatchCount: 10, MinutesPerMatch: 30}},
		Courts:     1,
	})
	if none.Minutes != one.Minutes || one.Minutes != 330 {
		t.Fatalf("zero courts gave %d, one court %d, want 330 each", none.Minutes, one.Minutes)
	}
}

func TestEstimateAnEmptyDayIsZeroMinutes(t *testing.T) {
	// No matches means no day — the break is not a day on its own.
	est := EstimateDay(EstimateInput{Courts: 4, BreakMinutes: 45, StartAt: at("2026-09-14T03:30:00Z")})
	if est.Minutes != 0 || est.TotalMatches != 0 {
		t.Fatalf("%d matches in %d minutes, want 0 and 0", est.TotalMatches, est.Minutes)
	}
	if est.FinishAt == nil || !est.FinishAt.Equal(*at("2026-09-14T03:30:00Z")) {
		t.Fatalf("finish at %v, want the start time", est.FinishAt)
	}
}

func TestCountsLeagueAndPoolFormatsCorrectly(t *testing.T) {
	if m, p := LeagueMatchCount(4, "final_only"); m != 7 || p != 3 {
		t.Fatalf("LeagueMatchCount(4, final_only) = %d, %d, want 7, 3", m, p)
	}
	if m, p := LeagueMatchCount(12, "none"); m != 66 || p != 11 {
		t.Fatalf("LeagueMatchCount(12, none) = %d, %d, want 66, 11", m, p)
	}
	if m, p := GroupsKnockoutMatchCount(16, 4); m != 31 || p != 3 {
		t.Fatalf("GroupsKnockoutMatchCount(16, 4) = %d, %d, want 31, 3", m, p)
	}
}

func TestLeagueMatchCountEdges(t *testing.T) {
	for _, teams := range []int{0, 1} {
		if m, p := LeagueMatchCount(teams, "final_only"); m != 0 || p != 0 {
			t.Fatalf("LeagueMatchCount(%d) = %d, %d, want 0, 0", teams, m, p)
		}
	}
	// Semis and a final add three matches to the league.
	if m, p := LeagueMatchCount(4, "semis_and_final"); m != 9 || p != 3 {
		t.Fatalf("LeagueMatchCount(4, semis_and_final) = %d, %d, want 9, 3", m, p)
	}
	// The count has to agree with the draw the generator actually builds.
	plan := BuildLeague(teamList(4), "final_only")
	if m, _ := LeagueMatchCount(4, "final_only"); m != len(plan.Matches) {
		t.Fatalf("estimate says %d matches, the draw has %d", m, len(plan.Matches))
	}
}

func TestGroupsKnockoutMatchCountWithUnevenPools(t *testing.T) {
	// 10 in 2 pools: two fives, 10 + 10 group matches, 3 knockout.
	if m, p := GroupsKnockoutMatchCount(10, 2); m != 23 || p != 4 {
		t.Fatalf("GroupsKnockoutMatchCount(10, 2) = %d, %d, want 23, 4", m, p)
	}
	// 11 in 2 pools: a six and a five — the guarantee is the smaller pool's.
	if m, p := GroupsKnockoutMatchCount(11, 2); m != 28 || p != 4 {
		t.Fatalf("GroupsKnockoutMatchCount(11, 2) = %d, %d, want 28, 4", m, p)
	}
	if m, p := GroupsKnockoutMatchCount(1, 2); m != 0 || p != 0 {
		t.Fatalf("GroupsKnockoutMatchCount(1, 2) = %d, %d, want 0, 0", m, p)
	}
	// Agrees with the draw the generator builds.
	plan := BuildDraw(teamList(10), "groups_knockout", "none")
	if m, _ := GroupsKnockoutMatchCount(10, PoolCountFor(10)); m != len(plan.Matches) {
		t.Fatalf("estimate says %d matches, the draw has %d", m, len(plan.Matches))
	}
}

func TestMinutesPerMatchPicksADurationFromTheFormat(t *testing.T) {
	for _, tc := range []struct {
		shape FormatShape
		want  int
	}{
		{FormatShape{BestOf: 3, PointsToWin: 11}, 30},
		{FormatShape{BestOf: 1, PointsToWin: 15}, 20},
		{FormatShape{BestOf: 1, PointsToWin: 11}, 15},
	} {
		if got := MinutesPerMatch(tc.shape); got != tc.want {
			t.Fatalf("MinutesPerMatch(%+v) = %d, want %d", tc.shape, got, tc.want)
		}
	}
}

func TestEstimateCarriesTheCategoriesThrough(t *testing.T) {
	cats := []CategoryLoad{
		{Name: "Men's Doubles", MatchCount: 12, MinutesPerMatch: 30, MinMatchesPerEntry: 3},
		{Name: "Mixed Doubles", MatchCount: 7, MinutesPerMatch: 20, MinMatchesPerEntry: 2},
	}
	est := EstimateDay(EstimateInput{Categories: cats, Courts: 2})
	if !reflect.DeepEqual(est.PerCategory, cats) {
		t.Fatalf("per-category %+v, want %+v", est.PerCategory, cats)
	}
	// (12*30 + 7*20) / 2 * 1.1 = 274.99… → 275
	if est.Minutes != 275 {
		t.Fatalf("minutes %d, want 275", est.Minutes)
	}
}
