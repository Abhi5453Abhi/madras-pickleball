package live

import (
	"context"
	"database/sql"
	"strings"
	"testing"
)

// Eight pairs, two pools, semis and a final: the knockout resolves out of two
// tables at once and goes straight onto the courts.
func TestPoolsResolveIntoSemisAndTheFinal(t *testing.T) {
	d := deps(t)
	f := makeFixture(t, d, fixtureOpts{
		Name: "Open Doubles", Slug: "open", Gender: "any", FinalsStage: "semis_and_final",
		Teams: 8, Courts: 2, Pools: true,
	})
	if got := len(f.leagueMatches()); got != 12 {
		t.Fatalf("two pools of four is %d group matches, wanted 12", got)
	}
	if got := len(f.knockout()); got != 3 {
		t.Fatalf("%d knockout matches, wanted two semis and a final", got)
	}

	f.flow(t)
	if got := len(f.live(t)); got != 2 {
		t.Fatalf("%d matches went on court", got)
	}
	playTheLeague(t, f)

	// Serpentine split: Group A is seeds 1, 4, 5, 8 and Group B is 2, 3, 6, 7.
	// The earlier seed wins every match, so the pairings are known.
	semis := f.knockout()[:2]
	first, second := f.match(t, semis[0].ID), f.match(t, semis[1].ID)
	if deref(first.TeamAID) != f.Teams[0] || deref(first.TeamBID) != f.Teams[2] {
		t.Errorf("the first semi is %s v %s", f.Names[deref(first.TeamAID)], f.Names[deref(first.TeamBID)])
	}
	if deref(second.TeamAID) != f.Teams[1] || deref(second.TeamBID) != f.Teams[3] {
		t.Errorf("the second semi is %s v %s", f.Names[deref(second.TeamAID)], f.Names[deref(second.TeamBID)])
	}
	if first.Status != "live" || second.Status != "live" {
		t.Fatalf("the semis are %s and %s; both courts were free", first.Status, second.Status)
	}

	f.win(t, first.ID, f.Teams[0])
	f.win(t, second.ID, f.Teams[1])
	final := f.match(t, f.knockout()[2].ID)
	if deref(final.TeamAID) != f.Teams[0] || deref(final.TeamBID) != f.Teams[1] {
		t.Fatalf("the final is %s v %s, wanted the two semi winners",
			f.Names[deref(final.TeamAID)], f.Names[deref(final.TeamBID)])
	}
	if final.Status != "live" {
		t.Errorf("the final is %s, and a court was free", final.Status)
	}
}

// A semi-final waiting on two different pools has to name them: "the group" is
// two tables here, and the pair reading the board want to know which is theirs.
func TestTheBoardNamesThePoolAKnockoutSlotWaitsOn(t *testing.T) {
	d := deps(t)
	f := makeFixture(t, d, fixtureOpts{
		Name: "Open Doubles", Slug: "open", Gender: "any", FinalsStage: "semis_and_final",
		Teams: 8, Courts: 2, Pools: true,
	})
	f.flow(t)

	board, err := loadBoard(context.Background(), d.DB, d, f.tournament(t))
	if err != nil {
		t.Fatal(err)
	}
	said := map[string]string{}
	for _, m := range board.Waiting {
		if m.WaitingOn != nil {
			said[m.ID] = *m.WaitingOn
		}
	}
	semis := f.knockout()[:2]
	if got := said[semis[0].ID]; got != "Waiting for the 1st in Pool A and the 2nd in Pool B" {
		t.Errorf("the first semi says %q", got)
	}
	if got := said[semis[1].ID]; got != "Waiting for the 1st in Pool B and the 2nd in Pool A" {
		t.Errorf("the second semi says %q", got)
	}

	// One league still says "the group": there is only one table to be 1st in.
	league := makeFixture(t, d, fixtureOpts{
		Name: "Men's Doubles", Slug: "mens", FinalsStage: "final_only", Teams: 4, Courts: 2, CourtFrom: 2})
	league.flow(t)
	leagueBoard, err := loadBoard(context.Background(), d.DB, d, league.tournament(t))
	if err != nil {
		t.Fatal(err)
	}
	found := ""
	for _, m := range leagueBoard.Waiting {
		if m.WaitingOn != nil {
			found = *m.WaitingOn
		}
	}
	if found != "Waiting for the 1st and 2nd in the group" {
		t.Errorf("the league's final says %q", found)
	}
}

// The safety net: a court that came free by a door the flow does not watch is
// offered the match that should be on it, and the offer is what goes on.
func TestAFreeCourtIsOfferedTheNextMatch(t *testing.T) {
	d := deps(t)
	ctx := context.Background()
	f := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "final_only", Teams: 4, Courts: 2})
	f.flow(t)

	// Off court with no result and no flow behind it: exactly the state the
	// offer exists for.
	second := f.Matches[1]
	if err := d.Tx(ctx, func(tx *sql.Tx) error {
		msg, err := clearCourt(ctx, tx, d, second.ID, false)
		if msg != "" {
			t.Fatalf("clearCourt: %s", msg)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}

	board, err := venueBoard(ctx, d)
	if err != nil {
		t.Fatal(err)
	}
	court := board.Courts[1]
	if court.Offer == nil || court.Offer.ID != second.ID {
		t.Fatalf("Court 2 offers %v, wanted the match that just came off it", court.Offer)
	}
	if court.Live != nil {
		t.Error("Court 2 has something on it")
	}

	// And the terracotta button puts it on.
	if err := d.Tx(ctx, func(tx *sql.Tx) error {
		msg, err := sendToCourt(ctx, tx, d, f.tournament(t), second.ID, court.ID)
		if msg != "" {
			t.Fatalf("the offer was refused: %s", msg)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if m := f.match(t, second.ID); m.Status != "live" || deref(m.CourtID) != court.ID {
		t.Fatalf("the match is %s on %v", m.Status, m.CourtID)
	}
}

// The Move screen offers this tournament's other courts, and shows the busy
// ones rather than hiding them.
func TestMoveOptions(t *testing.T) {
	d := deps(t)
	f := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "final_only", Teams: 4, Courts: 2})
	makeFixture(t, d, fixtureOpts{Name: "Mixed Doubles", Slug: "mixed", Gender: "mixed", FinalsStage: "none",
		Teams: 4, Courts: 2, CourtFrom: 2})
	f.flow(t)

	var got *moveOptionsOut
	api(t, d).call(t, "board.moveOptions", map[string]any{"matchId": f.Matches[0].ID}, &got)

	if got.Match.CourtName == nil || *got.Match.CourtName != "Court 1" {
		t.Errorf("the header says %v", got.Match.CourtName)
	}
	if got.Tournament.CategoryName != "Men's Doubles" || got.Tournament.Slug != "mens" {
		t.Errorf("the meta line says %+v", got.Tournament)
	}
	if len(got.Courts) != 1 {
		t.Fatalf("%d courts offered; another tournament's court is not on the list at all", len(got.Courts))
	}
	only := got.Courts[0]
	if only.Name != "Court 2" || only.Busy == nil {
		t.Fatalf("Court 2 is %+v; a busy court is shown, not offered", only)
	}
	if only.Busy.NameA == nil || only.ClosedReason != nil {
		t.Errorf("the busy line is %+v", only.Busy)
	}
	if only.Busy.Minutes != 0 {
		t.Errorf("a match that just started has been on %d minutes", only.Busy.Minutes)
	}
}

// One person is in Men's and Mixed on the same Sunday, and has one body. The
// flow will not call them to two courts at once.
func TestAPlayerOnCourtElsewhereIsNotCalledAgain(t *testing.T) {
	d := deps(t)
	mens := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "none", Teams: 4, Courts: 2})
	mixed := makeFixture(t, d, fixtureOpts{
		Name: "Mixed Doubles", Slug: "mixed", Gender: "mixed", FinalsStage: "none", Teams: 4, Courts: 2, CourtFrom: 2})
	mens.flow(t)

	// The player standing on Men's Court 1 is also entered in Mixed, in the
	// pair that Mixed's first match needs.
	onCourt := mens.Players[0]
	first := mixed.Matches[0]
	leaving := mixed.Players[0]
	mustExec(t, d.DB, `update team_players set player_id = $2 where player_id = $1`, leaving, onCourt)
	mustExec(t, d.DB, `update tournament_players set player_id = $2 where tournament_id = $3 and player_id = $1`,
		leaving, onCourt, mixed.ID)

	mixed.flow(t)

	if m := mixed.match(t, first.ID); m.Status == "live" {
		t.Fatalf("%s is on two courts at once", mixed.Names[deref(first.TeamAID)])
	}
	live := mixed.live(t)
	if len(live) != 1 {
		t.Fatalf("%d Mixed matches went on; the second one shares a player with the first", len(live))
	}
	if live["Court 3"].ID != mixed.Matches[1].ID {
		t.Errorf("Court 3 has the wrong match on it")
	}

	// And the board says who is blocking it, by name.
	board, err := loadBoard(context.Background(), d.DB, d, mixed.tournament(t))
	if err != nil {
		t.Fatal(err)
	}
	var blocked string
	for _, m := range board.Queue {
		if m.ID == first.ID && m.BlockedBy != nil {
			blocked = *m.BlockedBy
		}
	}
	if blocked == "" || !strings.HasSuffix(blocked, " is on Court 1") {
		t.Errorf("the board says %q; it has to name the person and the court", blocked)
	}
}
