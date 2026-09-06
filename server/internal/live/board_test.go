package live

import (
	"context"
	"database/sql"
	"testing"
)

// A league of four on two courts: the first two matches go on by themselves,
// one per court, and they never share a player.
func TestFlowFillsBothCourts(t *testing.T) {
	d := deps(t)
	f := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "final_only", Teams: 4, Courts: 2})

	f.flow(t)

	live := f.live(t)
	if len(live) != 2 {
		t.Fatalf("wanted two matches on court, got %d", len(live))
	}
	if live["Court 1"].ID != f.Matches[0].ID {
		t.Errorf("Court 1 has %s, wanted the first match in the order of play", live["Court 1"].ID)
	}
	if live["Court 2"].ID != f.Matches[1].ID {
		t.Errorf("Court 2 has %s, wanted the second match in the order of play", live["Court 2"].ID)
	}
	for _, m := range live {
		if m.StartedAt == nil {
			t.Error("a live match has no start time, so the board cannot say how long it has been on")
		}
	}
}

// Enter a score and the next match is on before the organiser is back on the
// board.
func TestSavingAScoreSendsTheNextMatchOn(t *testing.T) {
	d := deps(t)
	f := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "final_only", Teams: 4, Courts: 1})
	f.flow(t)

	first := f.Matches[0]
	if f.match(t, first.ID).Status != "live" {
		t.Fatal("the first match should be on court before anything is entered")
	}
	if out := f.win(t, first.ID, deref(first.TeamAID)); !out.OK {
		t.Fatalf("saving the score was refused: %s", out.Error)
	}

	done := f.match(t, first.ID)
	if done.Status != "completed" || done.ResultState != "final" {
		t.Errorf("after a score the match is %s/%s, wanted completed/final", done.Status, done.ResultState)
	}
	if deref(done.WinnerTeamID) != deref(first.TeamAID) {
		t.Error("the winner is not the side that won the games")
	}
	next := f.match(t, f.Matches[1].ID)
	if next.Status != "live" || next.CourtID == nil {
		t.Fatalf("the next match is %s and not on a court", next.Status)
	}
}

// The final's two sides come out of the table the moment the league is done,
// and it goes straight on court.
func TestTheFinalResolvesFromTheTable(t *testing.T) {
	d := deps(t)
	f := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "final_only", Teams: 4, Courts: 1})
	f.flow(t)
	playTheLeague(t, f)

	knockout := f.knockout()
	if len(knockout) != 1 {
		t.Fatalf("wanted one final, got %d knockout matches", len(knockout))
	}
	final := f.match(t, knockout[0].ID)
	if deref(final.TeamAID) != f.Teams[0] || deref(final.TeamBID) != f.Teams[1] {
		t.Fatalf("the final is %s v %s, wanted the top two of the table (%s, %s)",
			f.Names[deref(final.TeamAID)], f.Names[deref(final.TeamBID)], f.Names[f.Teams[0]], f.Names[f.Teams[1]])
	}
	if final.Status != "live" {
		t.Errorf("the final is %s; the court was free, so it should be on it", final.Status)
	}
}

// playTheLeague enters a result for every group match, in the order of play, so
// that the seed order is also the finishing order.
func playTheLeague(t *testing.T, f *fixture) {
	t.Helper()
	rank := map[string]int{}
	for i, id := range f.Teams {
		rank[id] = i
	}
	for _, m := range f.leagueMatches() {
		current := f.match(t, m.ID)
		if current.ResultState != "none" {
			continue
		}
		// The pair earlier in the seed order wins, so the table comes out in a
		// shape the test can name.
		winner := deref(current.TeamAID)
		if rank[deref(current.TeamBID)] < rank[winner] {
			winner = deref(current.TeamBID)
		}
		if out := f.win(t, m.ID, winner); !out.OK {
			t.Fatalf("saving %s was refused: %s", m.ID, out.Error)
		}
	}
}

// Pause and nothing new goes on; start again and the courts fill.
func TestPauseStopsTheFlowAndResumeRestartsIt(t *testing.T) {
	d := deps(t)
	f := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "final_only", Teams: 4, Courts: 2})

	if out, err := pauseDay(context.Background(), d, pauseIn{TournamentID: f.ID, Note: "Rain — back shortly"}); err != nil || !out.OK {
		t.Fatalf("pause: %v %v", out, err)
	}
	if note := deref(f.tournament(t).PauseNote); note != "Rain — back shortly" {
		t.Errorf("the pause note is %q", note)
	}
	f.flow(t)
	if len(f.live(t)) != 0 {
		t.Fatal("a paused tournament put a match on court")
	}

	out, err := resumeDay(context.Background(), d, f.ID)
	if err != nil || !out.OK {
		t.Fatalf("resume: %v %v", out, err)
	}
	if out.Note != "Going again." {
		t.Errorf("resume said %q", out.Note)
	}
	if got := len(f.live(t)); got != 2 {
		t.Fatalf("after starting again %d matches are on court, wanted 2", got)
	}
	if f.tournament(t).PausedAt != nil {
		t.Error("the tournament is still marked paused")
	}
}

// Move a live match to a free court, and put one back in the queue.
func TestMoveAndClearCourt(t *testing.T) {
	d := deps(t)
	ctx := context.Background()
	f := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "final_only", Teams: 4, Courts: 2})
	f.flow(t)

	first, second := f.Matches[0], f.Matches[1]

	// The court the second match is on is not free.
	var refusal string
	if err := d.Tx(ctx, func(tx *sql.Tx) error {
		var err error
		refusal, err = moveMatch(ctx, tx, d, first.ID, f.Courts[1].ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if refusal != "Court 2 already has a match on it." {
		t.Errorf("moving onto a busy court said %q", refusal)
	}

	// "Back to the queue": off court, and to the back of the order.
	if err := d.Tx(ctx, func(tx *sql.Tx) error {
		msg, err := clearCourt(ctx, tx, d, second.ID, true)
		if err != nil || msg != "" {
			t.Fatalf("clearCourt: %q %v", msg, err)
		}
		return flowVenue(ctx, tx, d, f.ID, map[string]bool{second.ID: true})
	}); err != nil {
		t.Fatal(err)
	}
	cleared := f.match(t, second.ID)
	if cleared.Status != "ready" || cleared.CourtID != nil || cleared.StartedAt != nil {
		t.Fatalf("after Back to the queue the match is %s on court %v", cleared.Status, cleared.CourtID)
	}
	last := f.leagueMatches()[len(f.leagueMatches())-1]
	if cleared.RoundIndex != last.RoundIndex || cleared.Seq <= last.Seq {
		t.Errorf("the match went to (round %d, seq %d); the back of the stage is (round %d, seq %d)",
			cleared.RoundIndex, cleared.Seq, last.RoundIndex, last.Seq)
	}
	if deref(cleared.RoundName) != deref(last.RoundName) {
		t.Errorf("a league match at the back of the order should take that round's tag, got %q", deref(cleared.RoundName))
	}

	// Now Court 2 is free, so the first match can move onto it. The clock
	// starts again.
	if err := d.Tx(ctx, func(tx *sql.Tx) error {
		msg, err := moveMatch(ctx, tx, d, first.ID, f.Courts[1].ID)
		if msg != "" {
			t.Fatalf("the move was refused: %s", msg)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	moved := f.match(t, first.ID)
	if moved.CourtID == nil || *moved.CourtID != f.Courts[1].ID {
		t.Fatal("the match did not move")
	}
	if moved.StartedAt == nil || !moved.StartedAt.After(*first.StartedAt) {
		t.Error("a moved match is a match that is starting: the clock should start again")
	}
}

// A match only ever goes onto its own tournament's courts, and never onto one
// with a match already on it.
func TestSendToCourtRefusals(t *testing.T) {
	d := deps(t)
	ctx := context.Background()
	mens := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "final_only", Teams: 4, Courts: 1})
	mixed := makeFixture(t, d, fixtureOpts{Name: "Mixed Doubles", Slug: "mixed", Gender: "mixed", FinalsStage: "none", Teams: 4, Courts: 1, CourtFrom: 1})

	send := func(matchID, courtID string) string {
		t.Helper()
		var refusal string
		if err := d.Tx(ctx, func(tx *sql.Tx) error {
			var err error
			refusal, err = sendToCourt(ctx, tx, d, mens.tournament(t), matchID, courtID)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return refusal
	}

	// The venue's second court belongs to Mixed, not to Men's.
	want := "Court 2 isn’t one of this tournament’s courts — a match only goes on its own tournament’s courts."
	if got := send(mens.Matches[0].ID, mixed.Courts[0].ID); got != want {
		t.Errorf("got %q, wanted %q", got, want)
	}

	// A final whose sides are not known yet cannot be sent anywhere.
	final := mens.knockout()[0]
	if got := send(final.ID, mens.Courts[0].ID); got != "This match is still waiting on an earlier result." {
		t.Errorf("sending an unresolved final said %q", got)
	}

	// And a court with a match on it is not free.
	mens.flow(t)
	if got := send(mens.Matches[1].ID, mens.Courts[0].ID); got != "Court 1 already has a match on it." {
		t.Errorf("sending onto a busy court said %q", got)
	}
}
