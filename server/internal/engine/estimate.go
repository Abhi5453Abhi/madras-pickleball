package engine

// How long the day will take — SPEC A3, ported from app/src/lib/estimate.ts.
//
// The first draft got this wrong twice: the arithmetic was about 2x
// optimistic, and it was computed per category while every category shares the
// same courts. That made the one number whose job is to stop the day running
// past sunset into the thing that would have caused it.
//
// Pure. Tested.

import (
	"math"
	"time"
)

type FormatShape struct {
	BestOf      int
	PointsToWin int
}

// MinutesPerMatch — minutes per match including changeover: 30 for best of 3,
// else 20 or 15.
func MinutesPerMatch(shape FormatShape) int {
	if shape.BestOf >= 3 {
		return 30
	}
	if shape.PointsToWin >= 15 {
		return 20
	}
	return 15
}

type CategoryLoad struct {
	Name            string
	MatchCount      int
	MinutesPerMatch int
	// MinMatchesPerEntry is the guaranteed matches per entry — what players
	// actually complain about.
	MinMatchesPerEntry int
}

// overlapAllowance is a flat allowance for players entered in more than one
// category, which forces matches to serialise. Deliberately a fudge factor,
// not a computed figure.
const overlapAllowance = 1.1

type DayEstimate struct {
	TotalMatches int
	Minutes      int
	FinishAt     *time.Time
	PastSunset   bool
	PerCategory  []CategoryLoad
}

type EstimateInput struct {
	Categories   []CategoryLoad
	Courts       int
	StartAt      *time.Time
	BreakMinutes int
	SunsetAt     *time.Time
}

// EstimateDay — how long the day will take, across shared courts.
func EstimateDay(in EstimateInput) DayEstimate {
	courts := in.Courts
	if courts < 1 {
		courts = 1
	}

	totalMatches := 0
	totalMatchMinutes := 0
	for _, c := range in.Categories {
		totalMatches += c.MatchCount
		totalMatchMinutes += c.MatchCount * c.MinutesPerMatch
	}

	minutes := 0
	if totalMatches != 0 {
		// floor(x+0.5) is JavaScript's Math.round, which rounds a half up
		// rather than away from zero. Everything here is positive, but the
		// estimate has to agree with the reference to the minute.
		minutes = int(math.Floor(float64(totalMatchMinutes)/float64(courts)*overlapAllowance+0.5)) + in.BreakMinutes
	}

	var finishAt *time.Time
	if in.StartAt != nil {
		f := in.StartAt.Add(time.Duration(minutes) * time.Minute)
		finishAt = &f
	}
	pastSunset := finishAt != nil && in.SunsetAt != nil && finishAt.After(*in.SunsetAt)

	return DayEstimate{
		TotalMatches: totalMatches,
		Minutes:      minutes,
		FinishAt:     finishAt,
		PastSunset:   pastSunset,
		PerCategory:  in.Categories,
	}
}

// LeagueMatchCount — matches and guaranteed matches per entry for a league of
// n plus its finals.
func LeagueMatchCount(teams int, stage FinalsStage) (matches, minPerEntry int) {
	if teams < 2 {
		return 0, 0
	}
	groupMatches := teams * (teams - 1) / 2
	finals := 3
	switch stage {
	case "none":
		finals = 0
	case "final_only":
		finals = 1
	}
	return groupMatches + finals, teams - 1
}

// GroupsKnockoutMatchCount — pools of roughly equal size plus a knockout of
// two per pool.
func GroupsKnockoutMatchCount(teams, poolCount int) (matches, minPerEntry int) {
	if teams < 2 {
		return 0, 0
	}
	// The reference divides by poolCount without guarding it; nothing asks
	// for fewer than one pool, and integer division by zero panics in Go.
	if poolCount < 1 {
		poolCount = 1
	}
	base := teams / poolCount
	extra := teams % poolCount
	group := 0
	smallest := teams
	for i := 0; i < poolCount; i++ {
		size := base
		if i < extra {
			size++
		}
		group += size * (size - 1) / 2
		if size < smallest {
			smallest = size
		}
	}
	field := poolCount * 2
	knockout := field - 1
	minPerEntry = smallest - 1
	if minPerEntry < 0 {
		minPerEntry = 0
	}
	return group + knockout, minPerEntry
}
