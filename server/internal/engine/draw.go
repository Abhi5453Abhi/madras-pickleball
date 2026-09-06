package engine

// Draw generation — SPEC A3, ported from app/src/lib/draw.ts.
//
// Two formats ship: League (one group, everyone plays everyone, optional
// finals) and Groups → knockout (the same machinery with more than one pool).
// Single elimination, plate draws and third-place matches are v1.1; the slot
// model already carries loser_of so they are additive rather than a migration.
//
// Pure. Returns plain descriptors; persistence sits on top — the store swaps
// each SlotSource.MatchKey for the real match id as it writes the plan.

import (
	"fmt"
	"unicode/utf16"
)

// FinalsStage is how a tournament ends: none, final_only, semis_and_final.
type FinalsStage string

// SlotSource says where one side of a match comes from.
type SlotSource struct {
	Type      string `json:"type"` // entry | group_rank | winner_of | loser_of | bye
	TeamID    string `json:"teamId,omitempty"`
	GroupName string `json:"groupName,omitempty"`
	Rank      int    `json:"rank,omitempty"`
	// MatchKey is the plan-local key of the source match (winner_of /
	// loser_of); the store swaps it for the real match id when persisting.
	MatchKey string `json:"matchKey,omitempty"`
	MatchID  string `json:"matchId,omitempty"`
}

// MatchPlan is one match of a draw before it has an id.
type MatchPlan struct {
	Key        string // stable within one generation, wires slot sources
	Stage      string // group | knockout
	GroupName  string // "" for knockout
	RoundIndex int
	RoundName  string
	Seq        int
	SlotA      SlotSource
	SlotB      SlotSource
}

type GroupPlan struct {
	Name         string
	TeamIDs      []string
	AdvanceCount int
}

type DrawPlan struct {
	Groups  []GroupPlan
	Matches []MatchPlan
}

// bye is the marker a team is paired with when it sits a round out. The
// reference uses the string '__bye__'; the Go engine uses the empty string,
// which no real team id can ever be. Either way the pair is dropped rather
// than emitted, so the marker never leaves this file.
const bye = ""

// PoolCountFor — pools of 3 are never made: two guaranteed matches, and one
// walkover wrecks the pool. Below 8 entries it is always a single-group
// league.
func PoolCountFor(teamCount int) int {
	if teamCount < 8 {
		return 1
	}
	pools := 2
	if teamCount >= 16 {
		pools = 4
	}
	for pools > 1 && teamCount/pools <= 3 {
		pools--
	}
	return pools
}

// SerpentineSplit — so the strongest entries don't land in the same pool:
// 1,2,3,4 then 8,7,6,5 then 9,10,11,12…
func SerpentineSplit(seedOrder []string, poolCount int) [][]string {
	// The reference would divide by zero here; nothing in the app asks for
	// fewer than one pool (poolCountFor never returns less than 1), so give
	// back nothing rather than panic on a caller's arithmetic slip.
	if poolCount < 1 {
		return [][]string{}
	}
	pools := make([][]string, poolCount)
	for i := range pools {
		pools[i] = []string{}
	}
	for i, teamID := range seedOrder {
		row := i / poolCount
		col := i % poolCount
		index := col
		if row%2 != 0 {
			index = poolCount - 1 - col
		}
		pools[index] = append(pools[index], teamID)
	}
	return pools
}

// RoundRobinRounds — circle method. Returns rounds of pairs; a team paired
// with the bye marker sits the round out. Every pair meets exactly once.
func RoundRobinRounds(teamIDs []string) [][][2]string {
	teams := append([]string(nil), teamIDs...)
	if len(teams) < 2 {
		return [][][2]string{}
	}
	if len(teams)%2 == 1 {
		teams = append(teams, bye)
	}

	n := len(teams)
	rounds := make([][][2]string, 0, n-1)
	rotating := append([]string(nil), teams[1:]...)

	for r := 0; r < n-1; r++ {
		round := [][2]string{}
		order := make([]string, 0, n)
		order = append(order, teams[0])
		order = append(order, rotating...)
		for i := 0; i < n/2; i++ {
			home := order[i]
			away := order[n-1-i]
			if home == bye || away == bye {
				continue
			}
			// Alternate which side is listed first so nobody is always
			// "team A".
			if r%2 == 0 {
				round = append(round, [2]string{home, away})
			} else {
				round = append(round, [2]string{away, home})
			}
		}
		rounds = append(rounds, round)
		// rotating.unshift(rotating.pop()) — rotate one step to the right.
		last := rotating[len(rotating)-1]
		copy(rotating[1:], rotating[:len(rotating)-1])
		rotating[0] = last
	}

	return rounds
}

func knockoutRoundName(teamsInRound int) string {
	switch teamsInRound {
	case 2:
		return "Final"
	case 4:
		return "Semi-final"
	case 8:
		return "Quarter-final"
	}
	return fmt.Sprintf("Round of %d", teamsInRound)
}

// BuildLeague — one group, everyone plays everyone, then an optional finals
// stage. Four teams is the worked example: three matches each, top two to the
// final.
func BuildLeague(seedOrder []string, stage FinalsStage) DrawPlan {
	advanceCount := 4
	switch stage {
	case "none":
		advanceCount = 0
	case "final_only":
		advanceCount = 2
	}
	if advanceCount > len(seedOrder) {
		advanceCount = len(seedOrder)
	}
	groups := []GroupPlan{{
		Name:         "League",
		TeamIDs:      append([]string(nil), seedOrder...),
		AdvanceCount: advanceCount,
	}}

	matches := []MatchPlan{}
	rounds := RoundRobinRounds(seedOrder)
	for roundIndex, round := range rounds {
		for i, pair := range round {
			matches = append(matches, MatchPlan{
				Key:        fmt.Sprintf("g-%d-%d", roundIndex, i),
				Stage:      "group",
				GroupName:  "League",
				RoundIndex: roundIndex,
				RoundName:  fmt.Sprintf("Round %d", roundIndex+1),
				Seq:        i,
				SlotA:      SlotSource{Type: "entry", TeamID: pair[0]},
				SlotB:      SlotSource{Type: "entry", TeamID: pair[1]},
			})
		}
	}

	groupRounds := len(rounds)
	switch {
	case stage == "final_only" && len(seedOrder) >= 2:
		matches = append(matches, MatchPlan{
			Key:        "ko-final",
			Stage:      "knockout",
			RoundIndex: groupRounds,
			RoundName:  "Final",
			Seq:        0,
			SlotA:      SlotSource{Type: "group_rank", GroupName: "League", Rank: 1},
			SlotB:      SlotSource{Type: "group_rank", GroupName: "League", Rank: 2},
		})
	case stage == "semis_and_final" && len(seedOrder) >= 4:
		matches = append(matches,
			MatchPlan{
				Key:        "ko-sf1",
				Stage:      "knockout",
				RoundIndex: groupRounds,
				RoundName:  "Semi-final",
				Seq:        0,
				SlotA:      SlotSource{Type: "group_rank", GroupName: "League", Rank: 1},
				SlotB:      SlotSource{Type: "group_rank", GroupName: "League", Rank: 4},
			},
			MatchPlan{
				Key:        "ko-sf2",
				Stage:      "knockout",
				RoundIndex: groupRounds,
				RoundName:  "Semi-final",
				Seq:        1,
				SlotA:      SlotSource{Type: "group_rank", GroupName: "League", Rank: 2},
				SlotB:      SlotSource{Type: "group_rank", GroupName: "League", Rank: 3},
			},
			MatchPlan{
				Key:        "ko-final",
				Stage:      "knockout",
				RoundIndex: groupRounds + 1,
				RoundName:  "Final",
				Seq:        0,
				SlotA:      SlotSource{Type: "winner_of", MatchKey: "ko-sf1"},
				SlotB:      SlotSource{Type: "winner_of", MatchKey: "ko-sf2"},
			},
		)
	}

	return DrawPlan{Groups: groups, Matches: matches}
}

// BuildGroupsKnockout — pools, then a knockout of the top two per pool, so
// the knockout field is always exactly 4 or 8. Cross-pool pairing keeps pool
// winners apart in the first knockout round.
func BuildGroupsKnockout(seedOrder []string, poolCount int) DrawPlan {
	pools := SerpentineSplit(seedOrder, poolCount)
	groups := make([]GroupPlan, len(pools))
	for i, teamIDs := range pools {
		groups[i] = GroupPlan{
			Name:         fmt.Sprintf("Group %c", rune('A'+i)),
			TeamIDs:      teamIDs,
			AdvanceCount: 2,
		}
	}

	matches := []MatchPlan{}
	maxGroupRounds := 0

	for gi, group := range groups {
		rounds := RoundRobinRounds(group.TeamIDs)
		if len(rounds) > maxGroupRounds {
			maxGroupRounds = len(rounds)
		}
		for roundIndex, round := range rounds {
			for i, pair := range round {
				matches = append(matches, MatchPlan{
					Key:        fmt.Sprintf("g%d-%d-%d", gi, roundIndex, i),
					Stage:      "group",
					GroupName:  group.Name,
					RoundIndex: roundIndex,
					RoundName:  fmt.Sprintf("%s · Round %d", group.Name, roundIndex+1),
					// The reference numbers group matches across the whole
					// draw, not within the round: seq is matches.length.
					Seq:   len(matches),
					SlotA: SlotSource{Type: "entry", TeamID: pair[0]},
					SlotB: SlotSource{Type: "entry", TeamID: pair[1]},
				})
			}
		}
	}

	// Winner of A plays runner-up of B, and so on around the ring.
	qualifiers := []SlotSource{}
	for i, g := range groups {
		other := groups[(i+1)%len(groups)]
		qualifiers = append(qualifiers,
			SlotSource{Type: "group_rank", GroupName: g.Name, Rank: 1},
			SlotSource{Type: "group_rank", GroupName: other.Name, Rank: 2},
		)
	}

	fieldSize := len(groups) * 2
	roundIndex := maxGroupRounds
	previousKeys := []string{}
	teamsInRound := fieldSize

	for teamsInRound >= 2 {
		roundName := knockoutRoundName(teamsInRound)
		pairs := teamsInRound / 2
		keys := make([]string, 0, pairs)
		for i := 0; i < pairs; i++ {
			key := fmt.Sprintf("ko-%d-%d", roundIndex, i)
			keys = append(keys, key)
			var slotA, slotB SlotSource
			if len(previousKeys) == 0 {
				slotA = qualifiers[i*2]
				slotB = qualifiers[i*2+1]
			} else {
				slotA = SlotSource{Type: "winner_of", MatchKey: previousKeys[i*2]}
				slotB = SlotSource{Type: "winner_of", MatchKey: previousKeys[i*2+1]}
			}
			matches = append(matches, MatchPlan{
				Key:        key,
				Stage:      "knockout",
				RoundIndex: roundIndex,
				RoundName:  roundName,
				Seq:        i,
				SlotA:      slotA,
				SlotB:      slotB,
			})
		}
		previousKeys = keys
		teamsInRound = pairs
		roundIndex++
	}

	return DrawPlan{Groups: groups, Matches: matches}
}

// BuildDraw — league when drawType is "league", pools otherwise.
func BuildDraw(seedOrder []string, drawType string, stage FinalsStage) DrawPlan {
	if drawType == "league" {
		return BuildLeague(seedOrder, stage)
	}
	return BuildGroupsKnockout(seedOrder, PoolCountFor(len(seedOrder)))
}

// SeededShuffle — deterministic from a stored seed, so a random draw can be
// reproduced.
//
// The arithmetic is the reference's, bit for bit: FNV-1a over the seed's
// UTF-16 code units, then xorshift. JavaScript's bitwise operators work on
// 32-bit integers and Math.imul multiplies as int32, so uint32 here holds
// exactly the same bits at every step — including `h >>> 0` before the
// modulo, which is what uint32 already is.
func SeededShuffle(items []string, seed string) []string {
	var h uint32 = 2166136261
	for _, unit := range utf16.Encode([]rune(seed)) {
		h ^= uint32(unit)
		h *= 16777619
	}
	rand := func() float64 {
		h ^= h << 13
		h ^= h >> 17
		h ^= h << 5
		return float64(h%100000) / 100000
	}
	out := append([]string(nil), items...)
	for i := len(out) - 1; i > 0; i-- {
		j := int(rand() * float64(i+1))
		out[i], out[j] = out[j], out[i]
	}
	return out
}

// PairRandomly — chunks of teamSize from the shuffled list; a leftover player
// is dropped (app/src/server/tournaments.ts pairRandomly).
func PairRandomly(playerIDs []string, seed string, teamSize int) [][]string {
	pairs := [][]string{}
	if teamSize < 1 {
		return pairs
	}
	shuffled := SeededShuffle(playerIDs, seed)
	for i := 0; i+teamSize <= len(shuffled); i += teamSize {
		chunk := append([]string(nil), shuffled[i:i+teamSize]...)
		pairs = append(pairs, chunk)
	}
	return pairs
}
