package setup

import (
	"strings"
	"testing"

	"mpb/internal/auth"
	"mpb/internal/core"
	"mpb/internal/pin"
	"mpb/internal/rpc"
)

// The owner starts on the temporary PIN core.Seed set.
func TestChangePinRules(t *testing.T) {
	h := newHarness(t)
	me := &rpc.User{ID: h.owner.ID, Name: h.owner.Name, Role: "owner", MustChangePin: true}
	ctx := h.as(me)

	cases := []struct {
		name                   string
		current, next, confirm string
		want                   string
	}{
		{"no current PIN", "", "482913", "482913", "Type your current PIN — six digits."},
		{"a short new PIN", core.TempPIN, "4829", "4829", "The new PIN needs to be six digits."},
		{"six of the same digit", core.TempPIN, "111111", "111111",
			"Not that one — six of the same digit or a run like 123456 is the first thing anyone tries."},
		{"a run", core.TempPIN, "123456", "123456",
			"Not that one — six of the same digit or a run like 123456 is the first thing anyone tries."},
		{"the two do not match", core.TempPIN, "482913", "482914", "The two new PINs don’t match."},
		{"the current one is wrong", "999999", "482913", "482913", "Your current PIN is wrong."},
	}
	for _, c := range cases {
		res, err := changePin(ctx, h.Deps, changePinIn{Current: c.current, Next: c.next, Confirm: c.confirm})
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if res.OK || res.Error != c.want {
			t.Fatalf("%s: got %+v, want %q", c.name, res, c.want)
		}
	}

	// The real thing: the PIN changes, the forced-change flag clears, and this
	// device is signed back in.
	res, err := changePin(ctx, h.Deps, changePinIn{Current: core.TempPIN, Next: "482913", Confirm: "482913"})
	if err != nil {
		t.Fatalf("changePin: %v", err)
	}
	if !res.OK || res.Redirect != "/admin" {
		t.Fatalf("changePin: %+v", res)
	}
	var hash string
	var must bool
	if err := h.DB.QueryRowContext(ctx, `select pin_hash, must_change_pin from users where id = $1`, me.ID).
		Scan(&hash, &must); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !pin.Verify(hash, "482913") {
		t.Fatal("the new PIN does not verify")
	}
	if must {
		t.Fatal("must_change_pin should be off")
	}
	var sessions int
	if err := h.DB.QueryRowContext(ctx, `select count(*)::int from sessions where user_id = $1`, me.ID).
		Scan(&sessions); err != nil {
		t.Fatalf("sessions: %v", err)
	}
	if sessions != 1 {
		t.Fatalf("this device is signed back in and nothing else is, got %d sessions", sessions)
	}
}

func TestChangePinRefusesAnotherOrganisersPin(t *testing.T) {
	h := newHarness(t)
	owner := &rpc.User{ID: h.owner.ID, Role: "owner"}
	ownerCtx := h.as(owner)

	// The owner takes a PIN of their own first.
	if res, _ := changePin(ownerCtx, h.Deps, changePinIn{Current: core.TempPIN, Next: "482913", Confirm: "482913"}); !res.OK {
		t.Fatalf("owner changePin: %+v", res)
	}
	added, err := addOrganiser(ownerCtx, h.Deps, addOrganiserIn{Name: "Priya Ramesh"})
	if err != nil || !added.OK {
		t.Fatalf("addOrganiser: %+v %v", added, err)
	}

	u, err := auth.OrganiserForPin(ownerCtx, h.DB, added.Pin)
	if err != nil || u == nil {
		t.Fatalf("the temporary PIN does not sign in: %v", err)
	}
	priya := h.as(&rpc.User{ID: u.ID, Role: "organiser", MustChangePin: true})
	res, err := changePin(priya, h.Deps, changePinIn{Current: added.Pin, Next: "482913", Confirm: "482913"})
	if err != nil {
		t.Fatalf("changePin: %v", err)
	}
	if res.OK || res.Error != "Another organiser already uses that PIN. Pick a different one." {
		t.Fatalf("PIN collision: %+v", res)
	}
	// Her own choice goes through.
	if res, _ := changePin(priya, h.Deps, changePinIn{Current: added.Pin, Next: "917364", Confirm: "917364"}); !res.OK {
		t.Fatalf("changePin: %+v", res)
	}
}

func TestChangePinWaitsAfterFiveWrongTries(t *testing.T) {
	h := newHarness(t)
	me := h.as(&rpc.User{ID: h.owner.ID, Role: "owner"})
	for i := 0; i < 5; i++ {
		if res, _ := changePin(me, h.Deps, changePinIn{Current: "999999", Next: "482913", Confirm: "482913"}); res.OK {
			t.Fatal("a wrong current PIN went through")
		}
	}
	// Even the right PIN waits — the sixth try is not answered at all, which
	// is the point of the guard.
	res, _ := changePin(me, h.Deps, changePinIn{Current: core.TempPIN, Next: "482913", Confirm: "482913"})
	if res.OK || !strings.HasPrefix(res.Error, "Too many tries. Come back in ") ||
		!strings.HasSuffix(res.Error, " minutes.") {
		t.Fatalf("after five wrong tries: %+v", res)
	}
}

func TestAddAndRemoveOrganiser(t *testing.T) {
	h := newHarness(t)

	list, err := listOrganisers(h.ctx, h.Deps)
	if err != nil {
		t.Fatalf("listOrganisers: %v", err)
	}
	if len(list) != 1 || list[0].ID != h.owner.ID || list[0].LastLoginAt != nil {
		t.Fatalf("a fresh venue has one organiser who has not signed in: %+v", list)
	}

	if res, _ := addOrganiser(h.ctx, h.Deps, addOrganiserIn{Name: "P"}); res.OK || res.Error != "Give them a name." {
		t.Fatalf("a one-letter name: %+v", res)
	}

	added, err := addOrganiser(h.ctx, h.Deps, addOrganiserIn{Name: "Priya Ramesh"})
	if err != nil {
		t.Fatalf("addOrganiser: %v", err)
	}
	if !added.OK || added.Name != "Priya Ramesh" || len(added.Pin) != 6 {
		t.Fatalf("addOrganiser: %+v", added)
	}
	// The owner still holds 123456, so Priya gets the next temporary PIN.
	if added.Pin != "234567" {
		t.Fatalf("the first free temporary PIN is 234567, got %s", added.Pin)
	}
	list, _ = listOrganisers(h.ctx, h.Deps)
	if len(list) != 2 || list[1].Name != "Priya Ramesh" {
		t.Fatalf("two organisers, oldest first: %+v", list)
	}

	u, err := auth.OrganiserForPin(h.ctx, h.DB, added.Pin)
	if err != nil || u == nil {
		t.Fatalf("her PIN does not sign in: %v", err)
	}
	if !u.MustChangePin {
		t.Fatal("a temporary PIN must be replaced on first sign-in")
	}
	// Give her a session, so removing her can be seen to end it.
	if _, err := h.DB.ExecContext(h.ctx,
		`insert into sessions (id_hash, user_id, expires_at) values ($1, $2, now() + interval '1 day')`,
		core.Sha256Hex("priya-session"), u.ID); err != nil {
		t.Fatalf("session: %v", err)
	}

	if res, _ := removeOrganiser(h.ctx, h.Deps, removeOrganiserIn{UserID: h.owner.ID}); res.OK ||
		res.Error != "You can’t remove yourself." {
		t.Fatalf("removing yourself: %+v", res)
	}
	if res, _ := removeOrganiser(h.ctx, h.Deps, removeOrganiserIn{UserID: "usr_nobody"}); res.OK ||
		res.Error != "That organiser is not here." {
		t.Fatalf("removing a stranger: %+v", res)
	}

	res, err := removeOrganiser(h.ctx, h.Deps, removeOrganiserIn{UserID: u.ID})
	if err != nil {
		t.Fatalf("removeOrganiser: %v", err)
	}
	if !res.OK || res.Note != "Removed. Their PIN no longer works." {
		t.Fatalf("removeOrganiser: %+v", res)
	}
	gone, err := auth.OrganiserForPin(h.ctx, h.DB, added.Pin)
	if err != nil {
		t.Fatalf("after removal: %v", err)
	}
	if gone != nil {
		t.Fatal("her PIN still signs in")
	}
	var sessions int
	if err := h.DB.QueryRowContext(h.ctx, `select count(*)::int from sessions where user_id = $1`, u.ID).
		Scan(&sessions); err != nil {
		t.Fatalf("sessions: %v", err)
	}
	if sessions != 0 {
		t.Fatal("her sessions were not revoked")
	}
	list, _ = listOrganisers(h.ctx, h.Deps)
	if len(list) != 1 {
		t.Fatalf("she is off the list: %+v", list)
	}
}

func TestOwnerCannotBeRemoved(t *testing.T) {
	h := newHarness(t)
	other := h.as(&rpc.User{ID: "usr_someone_else", Role: "organiser"})
	res, err := removeOrganiser(other, h.Deps, removeOrganiserIn{UserID: h.owner.ID})
	if err != nil {
		t.Fatalf("removeOrganiser: %v", err)
	}
	if res.OK || res.Error != "The venue owner cannot be removed." {
		t.Fatalf("the last owner came off: %+v", res)
	}
}
