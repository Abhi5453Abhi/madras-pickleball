package live

import (
	"context"
	"database/sql"
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
