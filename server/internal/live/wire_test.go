package live

import (
	"encoding/json"
	"testing"
)

// The shapes on the wire, through the router the phones talk to. Field names
// are camelCase exactly as the contract has them, and a field typed `T | null`
// is always present — a missing key reads as "undefined" on the screen.
func TestWireShapes(t *testing.T) {
	d := deps(t)
	f := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "final_only", Teams: 4, Courts: 2})
	f.flow(t)
	c := api(t, d)

	var scoring map[string]any
	c.call(t, "scoring.getMatchForScoring", map[string]any{"matchId": f.Matches[0].ID}, &scoring)
	for _, key := range []string{"match", "categoryName", "courtName", "courtColorKey", "nameA", "nameB", "rules", "games"} {
		if _, ok := scoring[key]; !ok {
			t.Errorf("scoring.getMatchForScoring has no %q", key)
		}
	}
	match := scoring["match"].(map[string]any)
	for _, key := range []string{"id", "tournamentId", "roundName", "teamAId", "teamBId", "status",
		"resultState", "resultType", "winnerTeamId", "version"} {
		if _, ok := match[key]; !ok {
			t.Errorf("the match has no %q", key)
		}
	}
	rules := scoring["rules"].(map[string]any)
	if rules["bestOf"] != float64(3) || rules["pointsToWin"] != float64(11) || rules["hardCap"] != nil {
		t.Errorf("the rules on the wire are %v", rules)
	}

	// The version the screen loaded goes back with the score.
	var saved map[string]any
	c.call(t, "scoring.saveResult", map[string]any{
		"matchId":         f.Matches[0].ID,
		"resultType":      "normal",
		"winnerTeamId":    nil,
		"retiredTeamId":   nil,
		"expectedVersion": match["version"],
		"games": []map[string]any{
			{"gameNo": 1, "scoreA": 11, "scoreB": 6},
			{"gameNo": 2, "scoreA": 11, "scoreB": 9},
		},
	}, &saved)
	if saved["ok"] != true {
		t.Fatalf("the score was refused: %v", saved)
	}

	var effect map[string]any
	c.call(t, "chaos.withdrawalEffect", map[string]any{"tournamentId": f.ID, "teamId": f.Teams[3]}, &effect)
	for _, key := range []string{"played", "toWalkover", "vacates", "blocked"} {
		if _, ok := effect[key]; !ok {
			t.Errorf("chaos.withdrawalEffect has no %q", key)
		}
	}

	// The swap screen reads each member by name; a Go-shaped "Name" leaves the
	// select full of blank options and nothing to pick.
	var subs []map[string]any
	c.call(t, "chaos.substitutionOptions", map[string]any{"tournamentId": f.ID}, &subs)
	if len(subs) == 0 {
		t.Fatal("no pairs to swap from")
	}
	for _, key := range []string{"teamId", "teamName", "members"} {
		if _, ok := subs[0][key]; !ok {
			t.Errorf("chaos.substitutionOptions has no %q", key)
		}
	}
	member := subs[0]["members"].([]any)[0].(map[string]any)
	for _, key := range []string{"id", "name"} {
		if _, ok := member[key]; !ok {
			t.Errorf("a pair member has no %q", key)
		}
	}

	var paused map[string]any
	c.call(t, "chaos.pauseDay", map[string]any{"tournamentId": f.ID, "note": ""}, &paused)
	if paused["ok"] != true || paused["note"] != "Paused. The public page says so." {
		t.Errorf("chaos.pauseDay answered %v", paused)
	}
	if got := deref(f.tournament(t).PauseNote); got != "Paused" {
		t.Errorf("an empty note is stored as %q, wanted \"Paused\"", got)
	}

	var board map[string]any
	c.call(t, "board.venueBoard", map[string]any{}, &board)
	for _, key := range []string{"now", "tournaments", "courts", "liveCount", "wants"} {
		if _, ok := board[key]; !ok {
			t.Errorf("board.venueBoard has no %q", key)
		}
	}
	courts := board["courts"].([]any)
	if len(courts) != 4 {
		t.Fatalf("%d court cards", len(courts))
	}
	first := courts[0].(map[string]any)
	for _, key := range []string{"id", "name", "colorKey", "tournament", "closedReason", "live", "next",
		"nextNote", "offer", "idleReason"} {
		if _, ok := first[key]; !ok {
			t.Errorf("a court card has no %q", key)
		}
	}
	if first["closedReason"] != nil {
		t.Error("closedReason is always null in v4")
	}
	tournaments := board["tournaments"].([]any)
	one := tournaments[0].(map[string]any)
	for _, key := range []string{"id", "slug", "name", "categoryName", "shortName", "running", "paused",
		"played", "total", "toPlay", "remaining", "finishAt", "courtIds"} {
		if _, ok := one[key]; !ok {
			t.Errorf("a tournament line has no %q", key)
		}
	}
	if one["paused"] == nil {
		t.Error("the tournament was just paused and the board does not say so")
	}

	var today map[string]any
	c.call(t, "public.publicToday", map[string]any{}, &today)
	for _, key := range []string{"courts", "today", "upcoming", "version"} {
		if _, ok := today[key]; !ok {
			t.Errorf("public.publicToday has no %q", key)
		}
	}
	blob, _ := json.Marshal(today)
	if len(blob) == 0 {
		t.Error("nothing came back")
	}
}
