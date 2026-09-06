package engine

// Ported from app/src/lib/__tests__/engine.test.ts — the "round robin",
// "league", "pools" and "seeded shuffle" sections. Expected values that the
// vitest suite only checked loosely (shapes, lengths) are pinned here to what
// the TypeScript actually produces, captured by running the reference.

import (
	"fmt"
	"reflect"
	"sort"
	"testing"
)

func teamList(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("t%d", i)
	}
	return out
}

func TestRoundRobinEveryPairMeetsOnce(t *testing.T) {
	for _, n := range []int{2, 3, 4, 5, 6, 7, 8, 9, 12, 16} {
		t.Run(fmt.Sprintf("%d teams", n), func(t *testing.T) {
			rounds := RoundRobinRounds(teamList(n))
			seen := map[string]bool{}
			count := 0
			for _, round := range rounds {
				inRound := map[string]bool{}
				for _, pair := range round {
					a, b := pair[0], pair[1]
					// Nobody plays twice in the same round.
					if inRound[a] || inRound[b] {
						t.Fatalf("%s or %s plays twice in one round", a, b)
					}
					inRound[a] = true
					inRound[b] = true
					key := a + "|" + b
					if b < a {
						key = b + "|" + a
					}
					if seen[key] {
						t.Fatalf("pair %s meets twice", key)
					}
					seen[key] = true
					count++
				}
			}
			if want := n * (n - 1) / 2; count != want {
				t.Fatalf("got %d matches, want %d", count, want)
			}
		})
	}
}

func TestRoundRobinFourTeamsThreeRoundsOfTwo(t *testing.T) {
	rounds := RoundRobinRounds([]string{"a", "b", "c", "d"})
	if len(rounds) != 3 {
		t.Fatalf("got %d rounds, want 3", len(rounds))
	}
	for i, r := range rounds {
		if len(r) != 2 {
			t.Fatalf("round %d has %d matches, want 2", i, len(r))
		}
	}
	want := [][][2]string{
		{{"a", "d"}, {"b", "c"}},
		{{"c", "a"}, {"b", "d"}},
		{{"a", "b"}, {"c", "d"}},
	}
	if !reflect.DeepEqual(rounds, want) {
		t.Fatalf("got %v, want %v", rounds, want)
	}
}

func TestRoundRobinOddNumberSitsOneOut(t *testing.T) {
	// Five teams: five rounds of two, one player idle each round. The bye is
	// never emitted as a pair.
	rounds := RoundRobinRounds([]string{"a", "b", "c", "d", "e"})
	want := [][][2]string{
		{{"b", "e"}, {"c", "d"}},
		{{"e", "a"}, {"c", "b"}},
		{{"a", "d"}, {"e", "c"}},
		{{"c", "a"}, {"b", "d"}},
		{{"a", "b"}, {"d", "e"}},
	}
	if !reflect.DeepEqual(rounds, want) {
		t.Fatalf("got %v, want %v", rounds, want)
	}
	for _, round := range rounds {
		for _, pair := range round {
			if pair[0] == "" || pair[1] == "" {
				t.Fatalf("a bye leaked into the rounds: %v", round)
			}
		}
	}
}

func TestRoundRobinTooFewTeams(t *testing.T) {
	for _, teams := range [][]string{nil, {}, {"a"}} {
		if got := RoundRobinRounds(teams); len(got) != 0 {
			t.Fatalf("RoundRobinRounds(%v) = %v, want no rounds", teams, got)
		}
	}
}

func TestLeagueBuildsTheFourTeamExample(t *testing.T) {
	plan := BuildLeague([]string{"a", "b", "c", "d"}, "final_only")
	var group, knockout []MatchPlan
	for _, m := range plan.Matches {
		if m.Stage == "group" {
			group = append(group, m)
		} else {
			knockout = append(knockout, m)
		}
	}
	if len(group) != 6 {
		t.Fatalf("got %d group matches, want 6", len(group))
	}
	if len(knockout) != 1 {
		t.Fatalf("got %d knockout matches, want 1", len(knockout))
	}
	if knockout[0].RoundName != "Final" {
		t.Fatalf("round name %q, want Final", knockout[0].RoundName)
	}
	wantA := SlotSource{Type: "group_rank", GroupName: "League", Rank: 1}
	wantB := SlotSource{Type: "group_rank", GroupName: "League", Rank: 2}
	if knockout[0].SlotA != wantA || knockout[0].SlotB != wantB {
		t.Fatalf("final slots %+v / %+v, want %+v / %+v", knockout[0].SlotA, knockout[0].SlotB, wantA, wantB)
	}

	wantGroups := []GroupPlan{{Name: "League", TeamIDs: []string{"a", "b", "c", "d"}, AdvanceCount: 2}}
	if !reflect.DeepEqual(plan.Groups, wantGroups) {
		t.Fatalf("groups %+v, want %+v", plan.Groups, wantGroups)
	}

	// Keys, round names and seq numbering, exactly as the reference emits them.
	wantMatches := []MatchPlan{
		{Key: "g-0-0", Stage: "group", GroupName: "League", RoundIndex: 0, RoundName: "Round 1", Seq: 0,
			SlotA: SlotSource{Type: "entry", TeamID: "a"}, SlotB: SlotSource{Type: "entry", TeamID: "d"}},
		{Key: "g-0-1", Stage: "group", GroupName: "League", RoundIndex: 0, RoundName: "Round 1", Seq: 1,
			SlotA: SlotSource{Type: "entry", TeamID: "b"}, SlotB: SlotSource{Type: "entry", TeamID: "c"}},
		{Key: "g-1-0", Stage: "group", GroupName: "League", RoundIndex: 1, RoundName: "Round 2", Seq: 0,
			SlotA: SlotSource{Type: "entry", TeamID: "c"}, SlotB: SlotSource{Type: "entry", TeamID: "a"}},
		{Key: "g-1-1", Stage: "group", GroupName: "League", RoundIndex: 1, RoundName: "Round 2", Seq: 1,
			SlotA: SlotSource{Type: "entry", TeamID: "b"}, SlotB: SlotSource{Type: "entry", TeamID: "d"}},
		{Key: "g-2-0", Stage: "group", GroupName: "League", RoundIndex: 2, RoundName: "Round 3", Seq: 0,
			SlotA: SlotSource{Type: "entry", TeamID: "a"}, SlotB: SlotSource{Type: "entry", TeamID: "b"}},
		{Key: "g-2-1", Stage: "group", GroupName: "League", RoundIndex: 2, RoundName: "Round 3", Seq: 1,
			SlotA: SlotSource{Type: "entry", TeamID: "c"}, SlotB: SlotSource{Type: "entry", TeamID: "d"}},
		{Key: "ko-final", Stage: "knockout", RoundIndex: 3, RoundName: "Final", Seq: 0, SlotA: wantA, SlotB: wantB},
	}
	if !reflect.DeepEqual(plan.Matches, wantMatches) {
		t.Fatalf("matches:\n got %+v\nwant %+v", plan.Matches, wantMatches)
	}
}

func TestLeagueWiresSemisIntoTheFinalByWinner(t *testing.T) {
	plan := BuildLeague([]string{"a", "b", "c", "d", "e"}, "semis_and_final")
	var final *MatchPlan
	for i := range plan.Matches {
		if plan.Matches[i].RoundName == "Final" {
			final = &plan.Matches[i]
		}
	}
	if final == nil {
		t.Fatal("no final in the plan")
	}
	if final.SlotA != (SlotSource{Type: "winner_of", MatchKey: "ko-sf1"}) {
		t.Fatalf("slotA %+v", final.SlotA)
	}
	if final.SlotB != (SlotSource{Type: "winner_of", MatchKey: "ko-sf2"}) {
		t.Fatalf("slotB %+v", final.SlotB)
	}
	if final.RoundIndex != 6 {
		t.Fatalf("final roundIndex %d, want 6", final.RoundIndex)
	}
	if plan.Groups[0].AdvanceCount != 4 {
		t.Fatalf("advanceCount %d, want 4", plan.Groups[0].AdvanceCount)
	}

	var knockout []MatchPlan
	groupCount := 0
	for _, m := range plan.Matches {
		if m.Stage == "knockout" {
			knockout = append(knockout, m)
		} else {
			groupCount++
		}
	}
	if groupCount != 10 {
		t.Fatalf("got %d group matches, want 10", groupCount)
	}
	wantKO := []MatchPlan{
		{Key: "ko-sf1", Stage: "knockout", RoundIndex: 5, RoundName: "Semi-final", Seq: 0,
			SlotA: SlotSource{Type: "group_rank", GroupName: "League", Rank: 1},
			SlotB: SlotSource{Type: "group_rank", GroupName: "League", Rank: 4}},
		{Key: "ko-sf2", Stage: "knockout", RoundIndex: 5, RoundName: "Semi-final", Seq: 1,
			SlotA: SlotSource{Type: "group_rank", GroupName: "League", Rank: 2},
			SlotB: SlotSource{Type: "group_rank", GroupName: "League", Rank: 3}},
		{Key: "ko-final", Stage: "knockout", RoundIndex: 6, RoundName: "Final", Seq: 0,
			SlotA: SlotSource{Type: "winner_of", MatchKey: "ko-sf1"},
			SlotB: SlotSource{Type: "winner_of", MatchKey: "ko-sf2"}},
	}
	if !reflect.DeepEqual(knockout, wantKO) {
		t.Fatalf("knockout:\n got %+v\nwant %+v", knockout, wantKO)
	}
}

func TestLeagueAddsNoFinalsWhenTheTableDecidesIt(t *testing.T) {
	plan := BuildLeague([]string{"a", "b", "c"}, "none")
	for _, m := range plan.Matches {
		if m.Stage != "group" {
			t.Fatalf("unexpected %s match %q", m.Stage, m.Key)
		}
	}
	if len(plan.Matches) != 3 {
		t.Fatalf("got %d matches, want 3", len(plan.Matches))
	}
	if plan.Groups[0].AdvanceCount != 0 {
		t.Fatalf("advanceCount %d, want 0", plan.Groups[0].AdvanceCount)
	}
}

func TestLeagueAdvanceCountNeverExceedsTheField(t *testing.T) {
	// Three entries and a semis stage: only three can advance.
	plan := BuildLeague([]string{"a", "b", "c"}, "semis_and_final")
	if plan.Groups[0].AdvanceCount != 3 {
		t.Fatalf("advanceCount %d, want 3", plan.Groups[0].AdvanceCount)
	}
	// …and there are not four to seed semis with, so no finals are added.
	for _, m := range plan.Matches {
		if m.Stage != "group" {
			t.Fatalf("unexpected %s match %q", m.Stage, m.Key)
		}
	}
}

func TestPoolsNeverProduceAPoolOfThreeOrFewer(t *testing.T) {
	for n := 2; n <= 40; n++ {
		pools := PoolCountFor(n)
		if pools == 1 {
			continue
		}
		if smallest := n / pools; smallest <= 3 {
			t.Fatalf("%d entries in %d pools leaves a pool of %d", n, pools, smallest)
		}
	}
}

func TestPoolsKeepASingleLeagueBelowEight(t *testing.T) {
	for n := 2; n < 8; n++ {
		if got := PoolCountFor(n); got != 1 {
			t.Fatalf("PoolCountFor(%d) = %d, want 1", n, got)
		}
	}
}

func TestPoolCountForMatchesTheReference(t *testing.T) {
	// poolCountFor(2)…poolCountFor(40), straight from the TypeScript.
	want := []int{1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 4, 4, 4, 4, 4, 4,
		4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4}
	for i, w := range want {
		n := i + 2
		if got := PoolCountFor(n); got != w {
			t.Fatalf("PoolCountFor(%d) = %d, want %d", n, got, w)
		}
	}
}

func TestSerpentineKeepsTheTopTwoApart(t *testing.T) {
	pools := SerpentineSplit([]string{"1", "2", "3", "4", "5", "6", "7", "8"}, 2)
	want := [][]string{{"1", "4", "5", "8"}, {"2", "3", "6", "7"}}
	if !reflect.DeepEqual(pools, want) {
		t.Fatalf("got %v, want %v", pools, want)
	}
}

func TestSerpentineWithAnUnevenField(t *testing.T) {
	pools := SerpentineSplit([]string{"1", "2", "3", "4", "5", "6", "7", "8", "9", "10"}, 4)
	want := [][]string{{"1", "8", "9"}, {"2", "7", "10"}, {"3", "6"}, {"4", "5"}}
	if !reflect.DeepEqual(pools, want) {
		t.Fatalf("got %v, want %v", pools, want)
	}
}

func TestGroupsKnockoutBuildsExactlyTwoPerPool(t *testing.T) {
	plan := BuildGroupsKnockout(teamList(16), PoolCountFor(16))
	if len(plan.Groups) != 4 {
		t.Fatalf("got %d groups, want 4", len(plan.Groups))
	}
	wantGroups := []GroupPlan{
		{Name: "Group A", TeamIDs: []string{"t0", "t7", "t8", "t15"}, AdvanceCount: 2},
		{Name: "Group B", TeamIDs: []string{"t1", "t6", "t9", "t14"}, AdvanceCount: 2},
		{Name: "Group C", TeamIDs: []string{"t2", "t5", "t10", "t13"}, AdvanceCount: 2},
		{Name: "Group D", TeamIDs: []string{"t3", "t4", "t11", "t12"}, AdvanceCount: 2},
	}
	if !reflect.DeepEqual(plan.Groups, wantGroups) {
		t.Fatalf("groups %+v, want %+v", plan.Groups, wantGroups)
	}

	var group, knockout []MatchPlan
	for _, m := range plan.Matches {
		if m.Stage == "knockout" {
			knockout = append(knockout, m)
		} else {
			group = append(group, m)
		}
	}
	if len(group) != 24 {
		t.Fatalf("got %d group matches, want 24", len(group))
	}
	// 8 qualifiers → quarters, semis, final.
	if len(knockout) != 7 {
		t.Fatalf("got %d knockout matches, want 7", len(knockout))
	}
	counts := map[string]int{}
	for _, m := range knockout {
		counts[m.RoundName]++
	}
	if counts["Final"] != 1 || counts["Semi-final"] != 2 || counts["Quarter-final"] != 4 {
		t.Fatalf("knockout round names %v", counts)
	}

	// Group matches are numbered across the whole draw, not within a round.
	wantFirst := []MatchPlan{
		{Key: "g0-0-0", Stage: "group", GroupName: "Group A", RoundIndex: 0, RoundName: "Group A · Round 1", Seq: 0,
			SlotA: SlotSource{Type: "entry", TeamID: "t0"}, SlotB: SlotSource{Type: "entry", TeamID: "t15"}},
		{Key: "g0-0-1", Stage: "group", GroupName: "Group A", RoundIndex: 0, RoundName: "Group A · Round 1", Seq: 1,
			SlotA: SlotSource{Type: "entry", TeamID: "t7"}, SlotB: SlotSource{Type: "entry", TeamID: "t8"}},
		{Key: "g0-1-0", Stage: "group", GroupName: "Group A", RoundIndex: 1, RoundName: "Group A · Round 2", Seq: 2,
			SlotA: SlotSource{Type: "entry", TeamID: "t8"}, SlotB: SlotSource{Type: "entry", TeamID: "t0"}},
	}
	if !reflect.DeepEqual(group[:3], wantFirst) {
		t.Fatalf("first group matches:\n got %+v\nwant %+v", group[:3], wantFirst)
	}

	wantKO := []MatchPlan{
		{Key: "ko-3-0", Stage: "knockout", RoundIndex: 3, RoundName: "Quarter-final", Seq: 0,
			SlotA: SlotSource{Type: "group_rank", GroupName: "Group A", Rank: 1},
			SlotB: SlotSource{Type: "group_rank", GroupName: "Group B", Rank: 2}},
		{Key: "ko-3-1", Stage: "knockout", RoundIndex: 3, RoundName: "Quarter-final", Seq: 1,
			SlotA: SlotSource{Type: "group_rank", GroupName: "Group B", Rank: 1},
			SlotB: SlotSource{Type: "group_rank", GroupName: "Group C", Rank: 2}},
		{Key: "ko-3-2", Stage: "knockout", RoundIndex: 3, RoundName: "Quarter-final", Seq: 2,
			SlotA: SlotSource{Type: "group_rank", GroupName: "Group C", Rank: 1},
			SlotB: SlotSource{Type: "group_rank", GroupName: "Group D", Rank: 2}},
		{Key: "ko-3-3", Stage: "knockout", RoundIndex: 3, RoundName: "Quarter-final", Seq: 3,
			SlotA: SlotSource{Type: "group_rank", GroupName: "Group D", Rank: 1},
			SlotB: SlotSource{Type: "group_rank", GroupName: "Group A", Rank: 2}},
		{Key: "ko-4-0", Stage: "knockout", RoundIndex: 4, RoundName: "Semi-final", Seq: 0,
			SlotA: SlotSource{Type: "winner_of", MatchKey: "ko-3-0"},
			SlotB: SlotSource{Type: "winner_of", MatchKey: "ko-3-1"}},
		{Key: "ko-4-1", Stage: "knockout", RoundIndex: 4, RoundName: "Semi-final", Seq: 1,
			SlotA: SlotSource{Type: "winner_of", MatchKey: "ko-3-2"},
			SlotB: SlotSource{Type: "winner_of", MatchKey: "ko-3-3"}},
		{Key: "ko-5-0", Stage: "knockout", RoundIndex: 5, RoundName: "Final", Seq: 0,
			SlotA: SlotSource{Type: "winner_of", MatchKey: "ko-4-0"},
			SlotB: SlotSource{Type: "winner_of", MatchKey: "ko-4-1"}},
	}
	if !reflect.DeepEqual(knockout, wantKO) {
		t.Fatalf("knockout:\n got %+v\nwant %+v", knockout, wantKO)
	}
}

func TestGroupsKnockoutPairsAWinnerAgainstAnotherPoolsRunnerUp(t *testing.T) {
	plan := BuildGroupsKnockout(teamList(12), 2)
	var knockout []MatchPlan
	for _, m := range plan.Matches {
		if m.Stage == "knockout" {
			knockout = append(knockout, m)
		}
	}
	first := knockout[0]
	if first.SlotA.Type != "group_rank" || first.SlotA.Rank != 1 {
		t.Fatalf("slotA %+v, want a pool winner", first.SlotA)
	}
	if first.SlotB.Type != "group_rank" || first.SlotB.Rank != 2 {
		t.Fatalf("slotB %+v, want a runner-up", first.SlotB)
	}
	if first.SlotA.GroupName == first.SlotB.GroupName {
		t.Fatalf("a pool winner drew its own pool's runner-up: %+v", first)
	}
	wantKO := []MatchPlan{
		{Key: "ko-5-0", Stage: "knockout", RoundIndex: 5, RoundName: "Semi-final", Seq: 0,
			SlotA: SlotSource{Type: "group_rank", GroupName: "Group A", Rank: 1},
			SlotB: SlotSource{Type: "group_rank", GroupName: "Group B", Rank: 2}},
		{Key: "ko-5-1", Stage: "knockout", RoundIndex: 5, RoundName: "Semi-final", Seq: 1,
			SlotA: SlotSource{Type: "group_rank", GroupName: "Group B", Rank: 1},
			SlotB: SlotSource{Type: "group_rank", GroupName: "Group A", Rank: 2}},
		{Key: "ko-6-0", Stage: "knockout", RoundIndex: 6, RoundName: "Final", Seq: 0,
			SlotA: SlotSource{Type: "winner_of", MatchKey: "ko-5-0"},
			SlotB: SlotSource{Type: "winner_of", MatchKey: "ko-5-1"}},
	}
	if !reflect.DeepEqual(knockout, wantKO) {
		t.Fatalf("knockout:\n got %+v\nwant %+v", knockout, wantKO)
	}
	// The last group match carries the running seq, not a per-round index.
	last := plan.Matches[29]
	if last.Key != "g1-4-2" || last.Seq != 29 || last.RoundName != "Group B · Round 5" {
		t.Fatalf("last group match %+v", last)
	}
}

func TestBuildDrawPicksTheFormat(t *testing.T) {
	league := BuildDraw([]string{"a", "b", "c", "d"}, "league", "final_only")
	if !reflect.DeepEqual(league, BuildLeague([]string{"a", "b", "c", "d"}, "final_only")) {
		t.Fatal("league draw does not match buildLeague")
	}
	pools := BuildDraw(teamList(10), "groups_knockout", "none")
	if len(pools.Groups) != 2 || len(pools.Matches) != 23 {
		t.Fatalf("10 entries gave %d groups and %d matches, want 2 and 23", len(pools.Groups), len(pools.Matches))
	}
	wantGroups := []GroupPlan{
		{Name: "Group A", TeamIDs: []string{"t0", "t3", "t4", "t7", "t8"}, AdvanceCount: 2},
		{Name: "Group B", TeamIDs: []string{"t1", "t2", "t5", "t6", "t9"}, AdvanceCount: 2},
	}
	if !reflect.DeepEqual(pools.Groups, wantGroups) {
		t.Fatalf("groups %+v, want %+v", pools.Groups, wantGroups)
	}
}

func TestSeededShuffleIsReproducibleFromTheStoredSeed(t *testing.T) {
	items := []string{"a", "b", "c", "d", "e", "f"}
	if !reflect.DeepEqual(SeededShuffle(items, "seed-1"), SeededShuffle(items, "seed-1")) {
		t.Fatal("the same seed gave two different orders")
	}
	if reflect.DeepEqual(SeededShuffle(items, "seed-1"), SeededShuffle(items, "seed-2")) {
		t.Fatal("two seeds gave the same order")
	}
	got := append([]string(nil), SeededShuffle(items, "seed-1")...)
	sort.Strings(got)
	if !reflect.DeepEqual(got, items) {
		t.Fatalf("the shuffle lost or invented entries: %v", got)
	}
	// The input must not be touched: the caller's seed order is the table's
	// last tiebreak.
	if !reflect.DeepEqual(items, []string{"a", "b", "c", "d", "e", "f"}) {
		t.Fatalf("SeededShuffle mutated its input: %v", items)
	}
}

func TestSeededShuffleMatchesTheTypeScript(t *testing.T) {
	// Captured by running the reference:
	//   cd app && npx tsx -e "…seededShuffle(['a'…'f'], 'demo-seed')"
	// A different sequence here would silently re-draw every tournament that
	// was generated by the Next.js app.
	items := []string{"a", "b", "c", "d", "e", "f"}
	for _, tc := range []struct {
		seed string
		want []string
	}{
		{"demo-seed", []string{"e", "d", "a", "c", "f", "b"}},
		{"seed-1", []string{"b", "a", "e", "d", "c", "f"}},
		{"seed-2", []string{"b", "a", "f", "c", "d", "e"}},
	} {
		if got := SeededShuffle(items, tc.seed); !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("SeededShuffle(items, %q) = %v, want %v", tc.seed, got, tc.want)
		}
	}
}

func TestPairRandomlyChunksAndDropsTheLeftover(t *testing.T) {
	// seededShuffle(['p1'…'p5'], 'demo-seed') is ['p4','p1','p3','p5','p2'].
	pairs := PairRandomly([]string{"p1", "p2", "p3", "p4", "p5"}, "demo-seed", 2)
	want := [][]string{{"p4", "p1"}, {"p3", "p5"}}
	if !reflect.DeepEqual(pairs, want) {
		t.Fatalf("got %v, want %v", pairs, want)
	}
	// Singles: everyone is their own team, nobody is dropped.
	singles := PairRandomly([]string{"p1", "p2", "p3", "p4", "p5"}, "demo-seed", 1)
	if len(singles) != 5 {
		t.Fatalf("got %d singles teams, want 5", len(singles))
	}
	if got := PairRandomly([]string{"p1"}, "demo-seed", 2); len(got) != 0 {
		t.Fatalf("one player made %v, want no pair", got)
	}
}
