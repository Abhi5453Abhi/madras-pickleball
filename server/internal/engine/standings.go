package engine

// Standings and tiebreaks — SPEC A6, ported from app/src/lib/standings.ts.
//
// The tiebreak order is the venue's own rule: level on wins, most total points
// scored qualifies. Head-to-head is offered as an alternative and is also the
// fallback when points scored are equal too.
//
// The first draft's "wins → head-to-head → point difference" was undefined for
// a three-way tie and would have returned whatever the sort happened to do —
// in public, to an angry player. This is the fix, and it terminates.
//
// Pure. Tested.

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// StandingsMatch is what the table needs from a match. State is final or
// voided in v4 (the reference's reported/disputed count as final).
type StandingsMatch struct {
	MatchID      string
	TeamAID      string
	TeamBID      string
	WinnerTeamID string // "" when none
	State        string // final | voided
	ResultType   string // normal | bye | walkover | retired | cancelled
	Games        []Game
}

type TeamRow struct {
	TeamID        string  `json:"teamId"`
	Played        int     `json:"played"`
	Won           int     `json:"won"`
	Lost          int     `json:"lost"`
	WinRatio      float64 `json:"winRatio"`
	GamesWon      int     `json:"gamesWon"`
	GamesLost     int     `json:"gamesLost"`
	GameDiff      int     `json:"gameDiff"`
	PointsFor     int     `json:"pointsFor"`
	PointsAgainst int     `json:"pointsAgainst"`
	PointDiff     int     `json:"pointDiff"`
	// Reason is set once the table is ordered, e.g. "2nd on head-to-head vs
	// Arun / Deepa"; "" when nothing needed saying.
	Reason      string `json:"reason,omitempty"`
	Provisional bool   `json:"provisional"`
	Disputed    bool   `json:"disputed"`
}

// TiebreakRule — points_scored_first (the venue's rule) or head_to_head_first.
type TiebreakRule string

const (
	PointsScoredFirst TiebreakRule = "points_scored_first"
	HeadToHeadFirst   TiebreakRule = "head_to_head_first"
)

// cappedDiff is CappedDiff from api_rules.go, duplicated here so the standings
// port does not have to wait for the rules port to land. Both sides are the
// same three lines; the integrator should keep one of them and delete this.
func cappedDiff(scoreFor, scoreAgainst int) int {
	d := scoreFor - scoreAgainst
	if d > DiffCap {
		return DiffCap
	}
	if d < -DiffCap {
		return -DiffCap
	}
	return d
}

// contributesDiff — a walkover records a scoreline but contributes nothing to
// any difference.
func contributesDiff(m StandingsMatch) bool {
	return m.ResultType == "normal" || m.ResultType == "retired"
}

// TallyRows — the counts, unordered, keyed by team.
func TallyRows(teamIDs []string, matches []StandingsMatch) map[string]*TeamRow {
	rows := make(map[string]*TeamRow, len(teamIDs))
	for _, id := range teamIDs {
		if _, ok := rows[id]; !ok {
			rows[id] = &TeamRow{TeamID: id}
		}
	}

	for _, m := range matches {
		// Voided matches contribute zero to everything, including matches
		// played.
		if m.State == "voided" || m.ResultType == "cancelled" {
			continue
		}
		a, okA := rows[m.TeamAID]
		b, okB := rows[m.TeamBID]
		if !okA || !okB {
			continue
		}

		a.Played++
		b.Played++
		// v4 has only 'final' and 'voided': the reference's 'reported' and
		// 'disputed' states were removed with the confirm/dispute flow, so
		// Provisional and Disputed are never set and nothing counts as played
		// but unwon.

		if m.WinnerTeamID == m.TeamAID {
			a.Won++
			b.Lost++
		} else if m.WinnerTeamID == m.TeamBID {
			b.Won++
			a.Lost++
		}

		// A walkover records a scoreline for the record and contributes
		// nothing to ANY accumulator except the win itself — capping only
		// point difference would let a match nobody played decide the pool
		// through game difference.
		if !contributesDiff(m) {
			continue
		}

		for _, g := range m.Games {
			// A phantom game — the 11-0s a retirement fills in for games
			// nobody played — contributes to nothing at all. A TIME-CAPPED
			// game is the opposite case: it was played, the points were
			// really scored, and this venue decides its pools on points
			// scored. Collapsing the two deleted real points from the one
			// column that settles qualification.
			if g.ExcludeFromDiff && !g.TimeCapped {
				continue
			}

			if g.ScoreA > g.ScoreB {
				a.GamesWon++
				b.GamesLost++
			} else if g.ScoreB > g.ScoreA {
				b.GamesWon++
				a.GamesLost++
			}

			a.PointsFor += g.ScoreA
			a.PointsAgainst += g.ScoreB
			b.PointsFor += g.ScoreB
			b.PointsAgainst += g.ScoreA

			// Point difference is the column a horn-stopped game is excluded
			// from, because it stopped early through nobody's doing.
			if g.ExcludeFromDiff {
				continue
			}
			a.PointDiff += cappedDiff(g.ScoreA, g.ScoreB)
			b.PointDiff += cappedDiff(g.ScoreB, g.ScoreA)
		}
	}

	for _, row := range rows {
		if row.Played == 0 {
			row.WinRatio = 0
		} else {
			row.WinRatio = float64(row.Won) / float64(row.Played)
		}
		row.GameDiff = row.GamesWon - row.GamesLost
	}

	return rows
}

func headToHead(a, b string, matches []StandingsMatch) int {
	aWins := 0
	bWins := 0
	for _, m := range matches {
		if m.State == "voided" {
			continue
		}
		involves := (m.TeamAID == a && m.TeamBID == b) || (m.TeamAID == b && m.TeamBID == a)
		if !involves {
			continue
		}
		if m.WinnerTeamID == a {
			aWins++
		} else if m.WinnerTeamID == b {
			bWins++
		}
	}
	return bWins - aWins // negative sorts `a` first
}

type step struct {
	label   string
	compare func(x, y TeamRow) int
	// describe gives a specific sentence for this row, when the label alone
	// isn't enough. nil for most steps.
	describe func(r TeamRow) string
}

// byWins — wins, counted, not the win ratio. The table's caption says "Level
// on wins? Most points scored goes through", and mid-league a pair with 1 win
// from 1 match sorting above a pair with 2 wins from 3 contradicted the column
// it sat next to. Everyone plays everyone, so by the end the two agree anyway.
var byWins = step{
	label:   "wins",
	compare: func(x, y TeamRow) int { return y.Won - x.Won },
	describe: func(r TeamRow) string {
		return strconv.Itoa(r.Won) + " won from " + strconv.Itoa(r.Played) + " played"
	},
}

var byPointsScored = step{
	label:   "total points scored",
	compare: func(x, y TeamRow) int { return y.PointsFor - x.PointsFor },
}

var byGameDiff = step{
	label:   "game difference",
	compare: func(x, y TeamRow) int { return y.GameDiff - x.GameDiff },
}

var byPointDiff = step{
	label:   "point difference",
	compare: func(x, y TeamRow) int { return y.PointDiff - x.PointDiff },
}

// orderGroup orders one tied group. Recursive: when a pass separates some but
// not all of a tied set, the procedure restarts from step 1 on the remaining
// subset — which means a three-way tie reduced to two is then settled by
// head-to-head, not by reading off the mini-table order. That is the trap
// implementers fall into.
func orderGroup(tied []TeamRow, allMatches []StandingsMatch, rule TiebreakRule, depth int) []TeamRow {
	if len(tied) <= 1 {
		return tied
	}
	if depth > 6 {
		return tied // pathological; the organiser decides
	}

	ids := make(map[string]bool, len(tied))
	idList := make([]string, 0, len(tied))
	for _, t := range tied {
		if !ids[t.TeamID] {
			ids[t.TeamID] = true
			idList = append(idList, t.TeamID)
		}
	}
	among := []StandingsMatch{}
	for _, m := range allMatches {
		if ids[m.TeamAID] && ids[m.TeamBID] {
			among = append(among, m)
		}
	}

	steps := []step{byWins}
	if rule == PointsScoredFirst {
		steps = append(steps, byPointsScored)
	}

	if out, ok := splitOn(steps, tied, allMatches, rule, depth); ok {
		return out
	}

	if len(tied) == 2 {
		// Exactly two left → head-to-head.
		h := headToHead(tied[0].TeamID, tied[1].TeamID, among)
		if h != 0 {
			first, second := tied[0], tied[1]
			if h > 0 {
				first, second = tied[1], tied[0]
			}
			// The rule doesn't stop the argument; the reason does.
			if first.Reason == "" {
				first.Reason = "ahead on head-to-head"
			}
			if second.Reason == "" {
				second.Reason = "behind on head-to-head"
			}
			return []TeamRow{first, second}
		}
	} else {
		// Three or more → a mini-table over only the matches among them.
		mini := TallyRows(idList, among)
		miniRows := make([]TeamRow, len(tied))
		for i, t := range tied {
			miniRows[i] = *mini[t.TeamID]
		}
		for _, s := range []step{byWins, byGameDiff, byPointDiff} {
			sorted := sortRows(miniRows, s.compare)
			buckets := bucket(sorted, s.compare)
			if len(buckets) <= 1 {
				continue
			}
			out := []TeamRow{}
			for i, b := range buckets {
				back := make([]TeamRow, 0, len(b))
				for _, r := range b {
					for _, t := range tied {
						if t.TeamID == r.TeamID {
							back = append(back, t)
							break
						}
					}
				}
				if len(back) == 1 {
					out = append(out, tag(back, sideOf(i, len(buckets), s.label+" between the tied teams"), nil)...)
				} else {
					out = append(out, orderGroup(back, allMatches, rule, depth+1)...)
				}
			}
			return out
		}
	}

	// The order here has to match the sentence printed under the table. Under
	// head_to_head_first the footer promises points scored BEFORE the
	// difference columns, and it used to come last.
	fallback := []step{byGameDiff, byPointDiff, byPointsScored}
	if rule == HeadToHeadFirst {
		fallback = []step{byPointsScored, byGameDiff, byPointDiff}
	}
	if out, ok := splitOn(fallback, tied, allMatches, rule, depth); ok {
		return out
	}

	// Nothing separates them. The order they came in — the order the pairs
	// were made — stands, and the row says so rather than pretending a rule
	// decided it.
	return tag(tied, "drawn — level on everything, kept in the order the pairs were made", nil)
}

// splitOn runs each step in turn and returns the ordered rows for the first
// step that actually separates the set.
func splitOn(steps []step, tied []TeamRow, allMatches []StandingsMatch, rule TiebreakRule, depth int) ([]TeamRow, bool) {
	for _, s := range steps {
		s := s
		sorted := sortRows(tied, s.compare)
		buckets := bucket(sorted, s.compare)
		if len(buckets) <= 1 {
			continue
		}
		out := []TeamRow{}
		for i, b := range buckets {
			if len(b) == 1 {
				out = append(out, tag(b, sideOf(i, len(buckets), s.label), &s)...)
			} else {
				out = append(out, orderGroup(b, allMatches, rule, depth+1)...)
			}
		}
		return out, true
	}
	return nil, false
}

// sideOf — "ahead on point difference" / "behind on point difference".
func sideOf(index, count int, label string) string {
	if count < 2 {
		return label
	}
	switch {
	case index == 0:
		return "ahead on " + label
	case index == count-1:
		return "behind on " + label
	}
	return "between the others on " + label
}

// sortRows sorts a copy. It must be a STABLE sort: the reference relies on
// JavaScript's stable Array.prototype.sort to keep the order the pairs were
// made whenever a step separates nothing, and that order is the last
// tiebreak.
func sortRows(rows []TeamRow, compare func(x, y TeamRow) int) []TeamRow {
	out := append([]TeamRow(nil), rows...)
	sort.SliceStable(out, func(i, j int) bool { return compare(out[i], out[j]) < 0 })
	return out
}

func bucket(sorted []TeamRow, compare func(x, y TeamRow) int) [][]TeamRow {
	out := [][]TeamRow{}
	for _, row := range sorted {
		if n := len(out); n > 0 && compare(out[n-1][0], row) == 0 {
			out[n-1] = append(out[n-1], row)
		} else {
			out = append(out, []TeamRow{row})
		}
	}
	return out
}

func tag(rows []TeamRow, label string, s *step) []TeamRow {
	out := make([]TeamRow, len(rows))
	for i, r := range rows {
		if r.Reason == "" {
			if s != nil && s.describe != nil {
				r.Reason = label + " — " + s.describe(r)
			} else {
				r.Reason = label
			}
		}
		out[i] = r
	}
	return out
}

// Standings — the ordered table with reasons. Dead heats keep seed order (the
// order of teamIDs) and say "drawn — level on everything, kept in the order
// the pairs were made".
func Standings(teamIDs []string, matches []StandingsMatch, rule TiebreakRule) []TeamRow {
	// The reference's rule argument defaults to points_scored_first; anything
	// that isn't head_to_head_first is that default here too.
	if rule != HeadToHeadFirst {
		rule = PointsScoredFirst
	}
	tallied := TallyRows(teamIDs, matches)
	rows := make([]TeamRow, 0, len(tallied))
	seen := make(map[string]bool, len(teamIDs))
	for _, id := range teamIDs {
		if seen[id] {
			continue
		}
		seen[id] = true
		rows = append(rows, *tallied[id])
	}
	return orderGroup(rows, matches, rule, 0)
}

// TiebreakNote — the sentence printed under every table, so the rule isn't
// folklore.
func TiebreakNote(rule TiebreakRule) string {
	if rule == HeadToHeadFirst {
		return "Level on record: head-to-head first, then total points scored, then game and point difference. Point difference is capped at 8 per game; a no-show counts as a win but adds nothing to points or difference."
	}
	return "Level on record: most total points scored goes through, then head-to-head, then game and point difference. Point difference is capped at 8 per game; a no-show counts as a win but adds nothing to points or difference."
}

var winsWord = regexp.MustCompile(`\bwins\b`)

// TieNote — the reason worth printing under a row, or "" for none: only when
// wins and points scored did not settle it. "2 won from 3 played" is the two
// columns beside it, said again; "ahead on head-to-head" is the thing someone
// will ask about.
func TieNote(reason string, leagueDone bool) string {
	if reason == "" {
		return ""
	}
	// Wins and points are the two columns beside the name; no need to say
	// them again.
	if winsWord.MatchString(reason) || strings.Contains(reason, "total points scored") {
		return ""
	}
	// Nothing separates them YET is not a decision for anyone to make.
	if strings.HasPrefix(reason, "drawn") {
		if leagueDone {
			return "level on everything — kept in the order the pairs were made"
		}
		return "level so far"
	}
	return reason
}
