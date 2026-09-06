package setup

import (
	"context"
	"strings"
	"testing"
	"time"

	"mpb/internal/core"
	"mpb/internal/rpc"
)

// The public RPCs read no cookie: they are called with a bare context.
func publicCtx() context.Context { return context.Background() }

func (h *harness) link(tournamentID string) string {
	h.t.Helper()
	out, err := ensureRegistrationLink(h.ctx, h.Deps, tournamentIDIn{TournamentID: tournamentID})
	if err != nil || out == nil {
		h.t.Fatalf("ensureRegistrationLink: %+v %v", out, err)
	}
	return out.Token
}

func (h *harness) signUp(token, name, phone, partner, device string) submitOut {
	h.t.Helper()
	in := submitIn{Token: token, Name: name}
	if phone != "" {
		in.Phone = &phone
	}
	if partner != "" {
		in.PartnerName = &partner
	}
	if device != "" {
		in.DeviceID = &device
	}
	out, err := submitRegistration(publicCtx(), h.Deps, in)
	if err != nil {
		h.t.Fatalf("submitRegistration: %v", err)
	}
	return out
}

func TestSignUpThroughTheLink(t *testing.T) {
	h := newHarness(t)
	tourney := h.create(createEventIn{Name: "Men's Doubles"})
	token := h.link(tourney.ID)

	// What the link opens.
	view, err := resolveRegistrationToken(publicCtx(), h.Deps, resolveTokenIn{Token: token})
	if err != nil {
		t.Fatalf("resolveRegistrationToken: %v", err)
	}
	if view.Tournament.Name != "Men's Doubles" || view.Tournament.Day != h.today() {
		t.Fatalf("the card says what it is: %+v", view)
	}
	if view.Discipline != "doubles" || view.Closed {
		t.Fatalf("sign-ups are open: %+v", view)
	}
	// Typed off a screenshot, with the wrong letters for the digits.
	lower := strings.ToLower(strings.ReplaceAll(token, "0", "O"))
	if _, err := resolveRegistrationToken(publicCtx(), h.Deps, resolveTokenIn{Token: lower}); err != nil {
		t.Fatalf("a link typed by hand: %v", err)
	}
	if _, err := resolveRegistrationToken(publicCtx(), h.Deps, resolveTokenIn{Token: "AAAAA-BBBBB"}); err == nil {
		t.Fatal("an unknown link is a 404")
	} else if e, ok := err.(*rpc.Error); !ok || e.Status != 404 {
		t.Fatalf("want 404, got %v", err)
	}

	// Two people sign up; the second names the first.
	if res := h.signUp(token, "Ravi Kumar", "9840012345", "", "device-ravi-1"); !res.OK || res.AlreadyIn {
		t.Fatalf("first sign-up: %+v", res)
	}
	if res := h.signUp(token, "Priya Sharma", "9840012346", "Ravi Kumar", "device-priya-1"); !res.OK || res.AlreadyIn {
		t.Fatalf("second sign-up: %+v", res)
	}

	roster, err := listRoster(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if err != nil {
		t.Fatalf("listRoster: %v", err)
	}
	if len(roster) != 2 || roster[0].Name != "Ravi Kumar" || roster[0].Source != "link" {
		t.Fatalf("roster in arrival order: %+v", roster)
	}
	if roster[1].Partner == nil || *roster[1].Partner != "Ravi Kumar" {
		t.Fatalf("Priya named Ravi: %+v", roster[1])
	}
	if roster[0].DuplicateOf != nil || roster[1].DuplicateOf != nil {
		t.Fatalf("two different people: %+v", roster)
	}

	// The same phone and name again is "you're already on the list", not a
	// second row.
	if res := h.signUp(token, "Ravi Kumar", "9840012345", "", "device-ravi-1"); !res.OK || !res.AlreadyIn {
		t.Fatalf("signing up twice: %+v", res)
	}
	if got := len(h.roster(tourney.ID)); got != 2 {
		t.Fatalf("still two on the list, got %d", got)
	}

	// Coming back to name a partner is the one edit worth taking.
	if res := h.signUp(token, "Ravi Kumar", "9840012345", "Priya Sharma", "device-ravi-1"); !res.OK || !res.AlreadyIn {
		t.Fatalf("adding a partner later: %+v", res)
	}
	roster, _ = listRoster(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if roster[0].Partner == nil || *roster[0].Partner != "Priya Sharma" {
		t.Fatalf("Ravi's partner: %+v", roster[0])
	}

	// The two of them named each other, so the pair settles itself.
	board, _ := teamBoard(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if len(board.Pairs) != 1 || board.Pairs[0].How != "mutual" {
		t.Fatalf("a mutual pair: %+v", board.Pairs)
	}
}

func TestSignUpRefusals(t *testing.T) {
	h := newHarness(t)
	tourney := h.create(createEventIn{Name: "Men's Doubles"})
	token := h.link(tourney.ID)

	if res := h.signUp(token, " ", "", "", ""); res.OK || res.Error != "Put your name in." {
		t.Fatalf("no name: %+v", res)
	}
	if res := h.signUp(token, strings.Repeat("Ravikumar", 10), "", "", ""); res.OK ||
		res.Error != "That name is too long." {
		t.Fatalf("a long name: %+v", res)
	}
	if res := h.signUp(token, "Ravi Kumar", "12345", "", ""); res.OK ||
		res.Error != "That phone number doesn’t look right — ten digits, or leave it blank." {
		t.Fatalf("a bad phone number: %+v", res)
	}
	if res := h.signUp("AAAAA-BBBBB", "Ravi Kumar", "", "", ""); res.OK ||
		res.Error != "This link doesn’t work any more. Ask the organiser." {
		t.Fatalf("an unknown link: %+v", res)
	}

	// Closed sign-ups.
	if _, err := closeRegistration(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID}); err != nil {
		t.Fatalf("closeRegistration: %v", err)
	}
	view, err := resolveRegistrationToken(publicCtx(), h.Deps, resolveTokenIn{Token: token})
	if err != nil {
		t.Fatalf("the link still resolves once sign-ups are closed: %v", err)
	}
	if !view.Closed {
		t.Fatal("the card should say sign-ups have closed")
	}
	if res := h.signUp(token, "Ravi Kumar", "", "", ""); res.OK ||
		res.Error != "Sign-ups have closed — ask the organiser." {
		t.Fatalf("signing up after the close: %+v", res)
	}

	// Reopened, and it takes names again.
	if res, _ := reopenRegistration(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID}); !res.OK {
		t.Fatalf("reopenRegistration: %+v", res)
	}
	if res := h.signUp(token, "Ravi Kumar", "", "", ""); !res.OK {
		t.Fatalf("after reopening: %+v", res)
	}
}

func TestTheLinkStopsWorkingWhenTheDayHasPassed(t *testing.T) {
	h := newHarness(t)
	tourney := h.create(createEventIn{Name: "Men's Doubles"})
	token := h.link(tourney.ID)

	// The next morning.
	h.now = core.DayEnd(tourney.Day).Add(time.Hour)
	out, err := ensureRegistrationLink(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if err != nil {
		t.Fatalf("ensureRegistrationLink: %v", err)
	}
	if out != nil {
		t.Fatalf("the link stops working at the end of the day: %+v", out)
	}
	if _, err := resolveRegistrationToken(publicCtx(), h.Deps, resolveTokenIn{Token: token}); err == nil {
		t.Fatal("and the token stops resolving")
	}
}

func TestADuplicateIsFlaggedThenMergedOrKept(t *testing.T) {
	h := newHarness(t)
	tourney := h.create(createEventIn{Name: "Men's Doubles"})
	token := h.link(tourney.ID)

	h.mustAdd(tourney.ID, "Ravi Shankar")
	// "Ravi S" from a phone with no number looks like Ravi Shankar — but the
	// machine does not decide, it asks.
	if res := h.signUp(token, "Ravi S", "", "", "device-two"); !res.OK || res.AlreadyIn {
		t.Fatalf("the look-alike still goes on the list: %+v", res)
	}
	roster, err := listRoster(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if err != nil {
		t.Fatalf("listRoster: %v", err)
	}
	if len(roster) != 2 {
		t.Fatalf("nobody is turned away: %+v", roster)
	}
	flagged := roster[1]
	if flagged.Name != "Ravi S" || flagged.DuplicateOf == nil || flagged.DuplicateOf.Name != "Ravi Shankar" {
		t.Fatalf("the later row is flagged against the earlier one: %+v", flagged)
	}
	pending, err := countPendingSignups(h.ctx, h.DB, tourney.ID)
	if err != nil || pending != 1 {
		t.Fatalf("one thing for the organiser to answer: %d %v", pending, err)
	}
	// The hub counts it too.
	if got := stepDetail(h.hub(tourney.Slug), "registration"); got != "2 players in · link is open · 1 possible duplicate" {
		t.Fatalf("registration step: %q", got)
	}

	// "Different": the flag comes off, both stay.
	if res, err := keepBoth(h.ctx, h.Deps, playerIn{TournamentID: tourney.ID,
		PlayerID: flagged.PlayerID}); err != nil || !res.OK {
		t.Fatalf("keepBoth: %+v %v", res, err)
	}
	roster, _ = listRoster(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if len(roster) != 2 || roster[1].DuplicateOf != nil {
		t.Fatalf("both stay, unflagged: %+v", roster)
	}
	// Idempotent.
	if res, _ := keepBoth(h.ctx, h.Deps, playerIn{TournamentID: tourney.ID, PlayerID: flagged.PlayerID}); !res.OK {
		t.Fatal("keepBoth twice is a no-op, not an error")
	}
}

func TestMergingTwoRowsIntoOne(t *testing.T) {
	h := newHarness(t)
	tourney := h.create(createEventIn{Name: "Men's Doubles"})
	token := h.link(tourney.ID)

	h.mustAdd(tourney.ID, "Ravi Shankar")
	// The later row carries what the earlier one lacks: a partner and a phone.
	if res := h.signUp(token, "Ravi S", "9840012345", "Priya Sharma", "device-two"); !res.OK {
		t.Fatalf("sign-up: %+v", res)
	}
	roster, _ := listRoster(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	keep, drop := roster[0], roster[1]
	if drop.DuplicateOf == nil || drop.DuplicateOf.PlayerID != keep.PlayerID {
		t.Fatalf("flagged against the earlier row: %+v", drop)
	}

	res, err := mergePlayers(h.ctx, h.Deps, mergeIn{TournamentID: tourney.ID,
		KeepID: drop.DuplicateOf.PlayerID, DropID: drop.PlayerID})
	if err != nil {
		t.Fatalf("mergePlayers: %v", err)
	}
	if !res.OK || res.Note != "Ravi S and Ravi Shankar are one person on the list now." {
		t.Fatalf("mergePlayers: %+v", res)
	}
	roster, _ = listRoster(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if len(roster) != 1 || roster[0].PlayerID != keep.PlayerID {
		t.Fatalf("one row is left, the earlier one: %+v", roster)
	}
	if roster[0].Partner == nil || *roster[0].Partner != "Priya Sharma" {
		t.Fatalf("the partner wish came across: %+v", roster[0])
	}
	var phone string
	if err := h.DB.QueryRowContext(h.ctx, `select coalesce(phone_key, '') from players where id = $1`,
		keep.PlayerID).Scan(&phone); err != nil {
		t.Fatalf("phone: %v", err)
	}
	if phone != "+919840012345" {
		t.Fatalf("the number came across too, got %q", phone)
	}
	pending, _ := countPendingSignups(h.ctx, h.DB, tourney.ID)
	if pending != 0 {
		t.Fatalf("the flag is settled, got %d", pending)
	}

	// Merging a row that is gone.
	res, _ = mergePlayers(h.ctx, h.Deps, mergeIn{TournamentID: tourney.ID,
		KeepID: keep.PlayerID, DropID: drop.PlayerID})
	if res.OK || res.Error != "One of them is not on the list any more." {
		t.Fatalf("merging twice: %+v", res)
	}
}

func TestPasteAListFromTheGroupChat(t *testing.T) {
	h := newHarness(t)
	tourney := h.create(createEventIn{Name: "Men's Doubles"})

	paste := "1. Karthik Subramanian ✅\n2. Sathish Kumar 98400 12345\n3. Ravi Shankar\n" +
		"4. Arun Prakash\n5. Hari Venkatesh\n6. Naveen Krishnan"
	res := h.add(tourney.ID, paste)
	if !res.OK || res.Added != 6 || res.Skipped != 0 {
		t.Fatalf("six names in: %+v", res)
	}
	roster := h.roster(tourney.ID)
	if len(roster) != 6 || roster[0].Player.Name != "Karthik Subramanian" {
		t.Fatalf("the numbering and the tick are stripped: %+v", roster[0].Player)
	}
	if roster[1].Player.Phone == nil || *roster[1].Player.PhoneKey != "+919840012345" {
		t.Fatalf("the phone number is picked out: %+v", roster[1].Player)
	}
	for _, r := range roster {
		if r.Source != "hand" {
			t.Fatalf("added by the organiser: %+v", r)
		}
	}

	// The same list plus one new person: repeats are skipped, not refused.
	res = h.add(tourney.ID, "Ravi Shankar\nDeepak Raj")
	if !res.OK || res.Added != 1 || res.Skipped != 1 {
		t.Fatalf("a repeat is skipped, a new name added: %+v", res)
	}
	if got := len(h.roster(tourney.ID)); got != 7 {
		t.Fatalf("seven on the list, got %d", got)
	}

	// A paste where everybody is already in.
	res = h.add(tourney.ID, "Ravi Shankar\nDeepak Raj")
	if res.OK || res.Error != "Everyone in that list is already on it." {
		t.Fatalf("a paste of nobody new: %+v", res)
	}

	// One line is one person.
	res = h.add(tourney.ID, "Bala Murugan")
	if !res.OK || res.Added != 1 {
		t.Fatalf("a single name: %+v", res)
	}
	res = h.add(tourney.ID, "Bala Murugan")
	if res.OK || res.Error != "Bala Murugan is already on the list." {
		t.Fatalf("typing the same name again: %+v", res)
	}
	res = h.add(tourney.ID, "   ")
	if res.OK || res.Error != "Put a name in — the phone number is optional." {
		t.Fatalf("an empty box: %+v", res)
	}

	// A pasted name that looks like somebody already in is flagged, not
	// refused: "Karthik" against "Karthik Subramanian".
	res = h.add(tourney.ID, "Karthik\nVijay Anand")
	if !res.OK || res.Added != 2 {
		t.Fatalf("a look-alike still goes on: %+v", res)
	}
	if len(res.Flagged) != 1 || res.Flagged[0] != "Karthik" {
		t.Fatalf("and it says who to look at: %+v", res.Flagged)
	}
}

func TestRemovePlayer(t *testing.T) {
	h := newHarness(t)
	tourney := h.create(createEventIn{Name: "Men's Doubles"})
	h.mustAdd(tourney.ID, "Ravi Kumar", "Priya Sharma", "Arun Prakash", "Deepa Nair")

	// Somebody in no pair.
	res, err := removePlayer(h.ctx, h.Deps, playerIn{TournamentID: tourney.ID,
		PlayerID: h.playerID(tourney.ID, "Deepa Nair")})
	if err != nil {
		t.Fatalf("removePlayer: %v", err)
	}
	if !res.OK || res.Note != "Deepa Nair is off the list." {
		t.Fatalf("removePlayer: %+v", res)
	}
	if res, _ := removePlayer(h.ctx, h.Deps, playerIn{TournamentID: tourney.ID,
		PlayerID: "ply_nobody"}); res.OK || res.Error != "They are not on the list any more." {
		t.Fatalf("removing a stranger: %+v", res)
	}

	// Somebody in a pair that has not played: the pair comes apart with them.
	made, _ := pairWith(h.ctx, h.Deps, pairWithIn{TournamentID: tourney.ID,
		PlayerA: h.playerID(tourney.ID, "Ravi Kumar"), PlayerB: h.playerID(tourney.ID, "Priya Sharma")})
	if !made.OK {
		t.Fatalf("pairWith: %+v", made)
	}
	res, _ = removePlayer(h.ctx, h.Deps, playerIn{TournamentID: tourney.ID,
		PlayerID: h.playerID(tourney.ID, "Ravi Kumar")})
	if !res.OK || res.Note != "Ravi Kumar is off the list, and the pair Ravi Kumar / Priya Sharma is split." {
		t.Fatalf("removing half a pair: %+v", res)
	}
	if got := len(h.teams(tourney.ID)); got != 0 {
		t.Fatalf("the pair went with them, got %d teams", got)
	}
}

func TestRemovingSomebodyOnTheScheduleIsRefused(t *testing.T) {
	h := newHarness(t)
	id := withPairs(t, h, 2, "final_only")
	if r, _ := generateDraw(h.ctx, h.Deps, tournamentIDIn{TournamentID: id}); !r.OK {
		t.Fatalf("generateDraw: %+v", r)
	}
	roster := h.roster(id)
	res, err := removePlayer(h.ctx, h.Deps, playerIn{TournamentID: id, PlayerID: roster[0].Player.ID})
	if err != nil {
		t.Fatalf("removePlayer: %v", err)
	}
	if res.OK || !strings.Contains(res.Error, "which is on the schedule. Split the pair first, then make the schedule again.") {
		t.Fatalf("removing somebody in the draw: %+v", res)
	}

	// Once their pair has played it is not this screen's business at all.
	if _, err := h.DB.ExecContext(h.ctx,
		`update matches set result_state = 'final' where tournament_id = $1 and stage = 'group'`, id); err != nil {
		t.Fatalf("result: %v", err)
	}
	res, _ = removePlayer(h.ctx, h.Deps, playerIn{TournamentID: id, PlayerID: roster[0].Player.ID})
	if res.OK || !strings.Contains(res.Error, "and that pair has already played. Sort it out under More.") {
		t.Fatalf("removing somebody who has played: %+v", res)
	}
}

func TestAddingIsRefusedOnceItIsFinished(t *testing.T) {
	h := newHarness(t)
	tourney := h.create(createEventIn{Name: "Men's Doubles"})
	if _, err := h.DB.ExecContext(h.ctx, `update tournaments set status = 'completed' where id = $1`, tourney.ID); err != nil {
		t.Fatalf("finish: %v", err)
	}
	res := h.add(tourney.ID, "Ravi Kumar")
	if res.OK || res.Error != "That tournament has finished." {
		t.Fatalf("adding to a finished tournament: %+v", res)
	}
}

func TestThePublicRpcsNeverReturnAPhoneNumber(t *testing.T) {
	h := newHarness(t)
	tourney := h.create(createEventIn{Name: "Men's Doubles"})
	token := h.link(tourney.ID)
	if res := h.signUp(token, "Ravi Kumar", "9840012345", "", "device-one"); !res.OK {
		t.Fatalf("sign-up: %+v", res)
	}
	view, err := resolveRegistrationToken(publicCtx(), h.Deps, resolveTokenIn{Token: token})
	if err != nil {
		t.Fatalf("resolveRegistrationToken: %v", err)
	}
	// The shape simply has nowhere to put one — this is the guard that says so.
	if view.Tournament.Name == "" {
		t.Fatal("the card names the tournament")
	}
	roster, _ := listRoster(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	for _, r := range roster {
		if strings.Contains(r.Name, "9840") {
			t.Fatalf("a phone number reached the roster's name: %+v", r)
		}
	}
}

func TestOneBrowserGettingItWrongIsSlowedDown(t *testing.T) {
	h := newHarness(t)
	tourney := h.create(createEventIn{Name: "Men's Doubles"})
	token := h.link(tourney.ID)

	// Five refusals from one browser and it waits, whatever it sends next.
	for i := 0; i < 5; i++ {
		if res := h.signUp(token, "Ravi Kumar", "12345", "", "device-scripted"); res.OK {
			t.Fatalf("a bad phone number went through on try %d", i+1)
		}
	}
	if res := h.signUp(token, "Ravi Kumar", "9840012345", "", "device-scripted"); res.OK {
		t.Fatalf("the sixth try should wait: %+v", res)
	}
	// Another browser is unaffected — the venue's group chat is one address.
	if res := h.signUp(token, "Ravi Kumar", "9840012345", "", "device-someone-else"); !res.OK {
		t.Fatalf("a different browser: %+v", res)
	}
}

func TestTheSameNameFromTheSameBrowserIsTheSamePerson(t *testing.T) {
	h := newHarness(t)
	tourney := h.create(createEventIn{Name: "Men's Doubles"})
	token := h.link(tourney.ID)

	// Hari signs up with no phone at all, then reloads and sends it again.
	if res := h.signUp(token, "Hari Venkatesh", "", "Naveen Krishnan", "device-hari-abc"); !res.OK || res.AlreadyIn {
		t.Fatalf("first sign-up: %+v", res)
	}
	if res := h.signUp(token, "Hari Venkatesh", "", "", "device-hari-abc"); !res.OK || !res.AlreadyIn {
		t.Fatalf("the same browser sending the same name again: %+v", res)
	}
	if got := len(h.roster(tourney.ID)); got != 1 {
		t.Fatalf("one row, not two, got %d", got)
	}

	// The same name from a DIFFERENT browser is a second person until the
	// organiser says otherwise — two Karthiks in one group is not unusual.
	if res := h.signUp(token, "Hari Venkatesh", "", "", "device-someone-else"); !res.OK || res.AlreadyIn {
		t.Fatalf("a different browser: %+v", res)
	}
	roster, err := listRoster(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if err != nil {
		t.Fatalf("listRoster: %v", err)
	}
	if len(roster) != 2 || roster[1].DuplicateOf == nil {
		t.Fatalf("on the list with a flag for the organiser: %+v", roster)
	}

	// A device id that is not one the form would make is simply ignored.
	if res := h.signUp(token, "Bala Murugan", "", "", "no"); !res.OK || res.AlreadyIn {
		t.Fatalf("a junk device id: %+v", res)
	}
}
