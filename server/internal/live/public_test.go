package live

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"mpb/internal/rpc"
)

// Two tournaments sharing the day: every court at the venue is on the board,
// under whichever tournament holds it.
func TestVenueBoardWithTwoTournamentsOnTheDay(t *testing.T) {
	d := deps(t)
	ctx := context.Background()
	mens := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "final_only", Teams: 4, Courts: 2})
	mixed := makeFixture(t, d, fixtureOpts{
		Name: "Mixed Doubles", Slug: "mixed", Gender: "mixed", FinalsStage: "none", Teams: 4, Courts: 2, CourtFrom: 2})
	mens.flow(t)
	mixed.flow(t)

	board, err := venueBoard(ctx, d)
	if err != nil {
		t.Fatal(err)
	}
	if len(board.Courts) != 4 {
		t.Fatalf("the venue has %d court cards, wanted 4", len(board.Courts))
	}
	if board.LiveCount != 4 {
		t.Errorf("%d on court, wanted 4", board.LiveCount)
	}
	if len(board.Tournaments) != 2 {
		t.Fatalf("%d tournaments on today", len(board.Tournaments))
	}
	for _, c := range board.Courts {
		if c.Tournament == nil {
			t.Fatalf("%s is held by nobody", c.Name)
		}
		if c.ClosedReason != nil {
			t.Errorf("%s has a closed reason; v4 has no court-closure table", c.Name)
		}
		if c.Live == nil {
			t.Errorf("%s has nothing on it", c.Name)
		}
	}
	if board.Courts[0].Tournament.Name != "Men's Doubles" || board.Courts[3].Tournament.Name != "Mixed Doubles" {
		t.Error("the courts are under the wrong tournaments")
	}

	men := board.Tournaments[0]
	if men.CategoryName != "Men's Doubles" || men.ShortName != "Men's" {
		t.Errorf("the day strip says %q / %q", men.CategoryName, men.ShortName)
	}
	if men.Paused != nil {
		t.Error("nothing is paused")
	}
	if men.Total != 7 || men.Played != 0 || men.Remaining != 7 {
		t.Errorf("Men's is %d of %d with %d remaining", men.Played, men.Total, men.Remaining)
	}
	if men.ToPlay != 5 {
		t.Errorf("%d still to go on a court, wanted 5", men.ToPlay)
	}
	if len(men.CourtIDs) != 2 {
		t.Errorf("Men's holds %d courts", len(men.CourtIDs))
	}

	// "about 16:33": seven matches at half an hour each across two courts.
	if men.FinishAt == nil {
		t.Fatal("there is no finish estimate")
	}
	finish, err := time.Parse(time.RFC3339Nano, *men.FinishAt)
	if err != nil {
		t.Fatal(err)
	}
	if mins := time.Until(finish).Minutes(); mins < 110 || mins > 120 {
		t.Errorf("the day finishes in %.0f minutes; seven best-of-three matches on two courts is about 116", mins)
	}

	// Both of Men's courts are busy and everybody left is on one of them, so
	// each card says what it is waiting for.
	var note string
	for _, c := range board.Courts {
		if c.Name == "Court 1" && c.NextNote != nil {
			note = *c.NextNote
		}
	}
	if note != "waiting on Court 2’s result" {
		t.Errorf("Court 1 says %q, wanted \"waiting on Court 2’s result\"", note)
	}
}

// The share link: the table, the results, and never a phone number.
func TestPublicTournament(t *testing.T) {
	d := deps(t)
	ctx := context.Background()
	f := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "final_only", Teams: 4, Courts: 1})
	// A phone number on the roster is the one thing that must never come
	// through.
	mustExec(t, d.DB, `update players set phone = '9840012345', phone_key = '+919840012345' where id = $1`, f.Players[0])
	f.flow(t)

	got, err := publicTournament(ctx, d, "mens")
	if err != nil {
		t.Fatal(err)
	}
	if got.Tournament.Name != "Men's Doubles" || got.Tournament.Status != "live" {
		t.Errorf("the header says %+v", got.Tournament)
	}
	if got.Discipline != "doubles" || got.FinalsStage != "final_only" {
		t.Errorf("discipline %q, finals %q", got.Discipline, got.FinalsStage)
	}
	if got.Cut != 2 {
		t.Errorf("the cut line is at %d, wanted the top two", got.Cut)
	}
	if len(got.Courts) != 1 || got.Courts[0].Name != "Court 1" {
		t.Errorf("courts: %+v", got.Courts)
	}
	if len(got.Players) != 8 {
		t.Errorf("%d players on the page, wanted 8", len(got.Players))
	}
	if len(got.Matches) != 7 || len(got.Table) != 4 {
		t.Errorf("%d matches and %d table rows", len(got.Matches), len(got.Table))
	}

	blob, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"9840012345", "+919840012345", "phone"} {
		if strings.Contains(string(blob), secret) {
			t.Fatalf("the public page carries %q", secret)
		}
	}

	// A played match reads from the winner's side; a walkover prints the word
	// instead of 11–0, 11–0.
	first := f.Matches[0]
	f.win(t, first.ID, deref(first.TeamBID))
	second := f.Matches[1]
	winner := deref(second.TeamAID)
	if _, err := saveResult(ctx, d, saveResultIn{
		MatchID: second.ID, ResultType: "walkover", WinnerTeamID: &winner, Games: []wireGame{},
	}); err != nil {
		t.Fatal(err)
	}
	got, err = publicTournament(ctx, d, "mens")
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range got.Matches {
		switch m.ID {
		case first.ID:
			if m.WinnerSide == nil || *m.WinnerSide != "B" {
				t.Error("the winner's side is wrong")
			}
			if m.ScoreLine == nil || *m.ScoreLine != "11–6, 11–6" {
				t.Errorf("the score line is %q; it reads from the winner's side", deref(m.ScoreLine))
			}
		case second.ID:
			if m.ScoreLine != nil {
				t.Errorf("a walkover has no score line, got %q", *m.ScoreLine)
			}
			if m.ResultType != "walkover" {
				t.Errorf("the result type is %q", m.ResultType)
			}
		}
	}

	if _, err := publicTournament(ctx, d, "no-such-thing"); err == nil {
		t.Error("an unknown slug should be a 404")
	}
}

// The front door: every court, whatever is on it, and a link per tournament.
func TestPublicToday(t *testing.T) {
	d := deps(t)
	ctx := context.Background()
	f := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "final_only", Teams: 4, Courts: 2})
	mustExec(t, d.DB, `update players set phone = '9840099999' where id = $1`, f.Players[0])
	f.flow(t)

	got, err := publicToday(ctx, d)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Courts) != 4 {
		t.Fatalf("%d courts at the gate", len(got.Courts))
	}
	if got.Courts[0].Tournament == nil || got.Courts[0].Tournament.Slug != "mens" {
		t.Error("Court 1 does not say who holds it")
	}
	if got.Courts[0].Live == nil || len(got.Courts[0].Live.PlayersA) != 2 {
		t.Error("Court 1 does not say who is on it")
	}
	if got.Courts[3].Tournament != nil || got.Courts[3].Live != nil {
		t.Error("Court 4 is held by nobody and should say so")
	}
	if len(got.Today) != 1 || got.Today[0].Slug != "mens" {
		t.Errorf("today: %+v", got.Today)
	}
	if got.Today[0].RegistrationOpen {
		t.Error("a running tournament is not taking sign-ups")
	}
	blob, _ := json.Marshal(got)
	if strings.Contains(string(blob), "9840099999") {
		t.Fatal("the front door carries a phone number")
	}
}

// The version a page renders with and the version the poller returns come from
// one function, or every phone in the venue hard-refreshes every five seconds.
func TestVersionEndpointsAgreeWithThePages(t *testing.T) {
	d := deps(t)
	ctx := context.Background()
	f := makeFixture(t, d, fixtureOpts{Name: "Men's Doubles", Slug: "mens", FinalsStage: "final_only", Teams: 4, Courts: 2})
	f.flow(t)

	mux := http.NewServeMux()
	reg := rpc.New(slog.New(slog.NewTextHandler(nopWriter{}, nil)))
	Register(mux, reg, d)

	get := func(path string, user *rpc.User) (int, map[string]string) {
		t.Helper()
		req := httptest.NewRequest("GET", path, nil)
		req = req.WithContext(rpc.WithUser(ctx, user))
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		var body map[string]string
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		return rec.Code, body
	}

	page, err := publicToday(ctx, d)
	if err != nil {
		t.Fatal(err)
	}
	code, body := get("/api/version/today", nil)
	if code != 200 || body["version"] != page.Version {
		t.Errorf("today: %d %q, the page rendered with %q", code, body["version"], page.Version)
	}

	tour, err := publicTournament(ctx, d, "mens")
	if err != nil {
		t.Fatal(err)
	}
	code, body = get("/api/version/t/mens", nil)
	if code != 200 || body["version"] != tour.Version {
		t.Errorf("t/mens: %d %q, the page rendered with %q", code, body["version"], tour.Version)
	}
	if code, _ := get("/api/version/t/no-such-thing", nil); code != 404 {
		t.Errorf("an unknown slug answered %d", code)
	}

	// The venue one is the organiser's, and it says which tournaments are on
	// today.
	if code, _ := get("/api/version/venue", nil); code != 401 {
		t.Errorf("signed out, the venue version answered %d", code)
	}
	want, err := venueVersion(ctx, d.DB, d)
	if err != nil {
		t.Fatal(err)
	}
	code, body = get("/api/version/venue", &rpc.User{ID: "u", Name: "Organiser", Role: "owner"})
	if code != 200 || body["version"] != want {
		t.Errorf("venue: %d %q, the board rendered with %q", code, body["version"], want)
	}

	// And every one of them moves when a score goes in.
	f.win(t, f.Matches[0].ID, deref(f.Matches[0].TeamAID))
	if _, after := get("/api/version/today", nil); after["version"] == page.Version {
		t.Error("the day's version did not move when a result went in")
	}
	if _, after := get("/api/version/t/mens", nil); after["version"] == tour.Version {
		t.Error("the tournament's version did not move when a result went in")
	}
	if _, after := get("/api/version/venue", &rpc.User{ID: "u", Role: "owner"}); after["version"] == want {
		t.Error("the board's version did not move when a result went in")
	}
}

type nopWriter struct{}

func (nopWriter) Write(p []byte) (int, error) { return len(p), nil }
