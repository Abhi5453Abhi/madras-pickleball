package setup

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"time"

	"mpb/internal/auth"
	"mpb/internal/core"
	"mpb/internal/ids"
	"mpb/internal/pin"
	"mpb/internal/rpc"
)

// Organisers and their PINs — SPEC v4.
//
// One PIN, one organiser. There is no username on the sign-in screen: the PIN
// is the whole credential, so it identifies the person as well as admitting
// them. Two organisers therefore cannot share a PIN, and changePin refuses one
// that would collide. `username` stays as an internal handle; nobody types it.

const (
	// kindPinChange keys the five-in-fifteen guard on the change-PIN form:
	// both "your current PIN is wrong" and "another organiser uses that one"
	// are answers a patient guesser could learn from.
	kindPinChange = "pin-change"
	// sessionTTL matches package auth's; changePin signs this device back in
	// and auth's own constant is not exported.
	sessionTTL = 14 * 24 * time.Hour
)

// tempPINs are the fixed temporary PINs, in order, so whoever sets the app up
// can read them off the README rather than a terminal. Every one of them must
// be replaced on first sign-in before anything else opens.
var tempPINs = []string{"123456", "234567", "345678", "456789"}

type organiserOut struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	LastLoginAt *string `json:"lastLoginAt"`
}

type addOrganiserIn struct {
	Name string `json:"name"`
}

type addOrganiserOut struct {
	OK    bool   `json:"ok"`
	Name  string `json:"name,omitempty"`
	Pin   string `json:"pin,omitempty"`
	Error string `json:"error,omitempty"`
}

type removeOrganiserIn struct {
	UserID string `json:"userId"`
}

type changePinIn struct {
	Current string `json:"current"`
	Next    string `json:"next"`
	Confirm string `json:"confirm"`
}

func registerOrganisers(reg *rpc.Registry, d *core.Deps) {
	rpc.Register(reg, "organisers.listOrganisers", rpc.Owner,
		func(ctx context.Context, _ struct{}) ([]organiserOut, error) { return listOrganisers(ctx, d) })

	rpc.Register(reg, "organisers.addOrganiser", rpc.Owner,
		func(ctx context.Context, in addOrganiserIn) (addOrganiserOut, error) { return addOrganiser(ctx, d, in) })

	rpc.Register(reg, "organisers.removeOrganiser", rpc.Owner,
		func(ctx context.Context, in removeOrganiserIn) (noteOut, error) { return removeOrganiser(ctx, d, in) })

	// The one door a temporary PIN opens is the one that replaces it.
	rpc.Register(reg, "organisers.changePin", rpc.OrganiserAny,
		func(ctx context.Context, in changePinIn) (redirectOut, error) { return changePin(ctx, d, in) })
}

func listOrganisers(ctx context.Context, d *core.Deps) ([]organiserOut, error) {
	rows, err := d.DB.QueryContext(ctx, `
		select id, name, last_login_at from users
		where active and deleted_at is null and role in ('owner', 'organiser')
		order by created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []organiserOut{}
	for rows.Next() {
		var o organiserOut
		var last sql.NullTime
		if err := rows.Scan(&o.ID, &o.Name, &last); err != nil {
			return nil, err
		}
		o.LastLoginAt = core.ISO(core.TimePtr(last))
		out = append(out, o)
	}
	return out, rows.Err()
}

// freePin is the first temporary PIN nobody already holds; an organiser who
// chose 123456 for themselves must not find a colleague sharing it. When all
// four are spoken for it falls back to six random digits.
func freePin(ctx context.Context, d *core.Deps) (string, error) {
	for _, p := range tempPINs {
		u, err := auth.OrganiserForPin(ctx, d.DB, p)
		if err != nil {
			return "", err
		}
		if u == nil {
			return p, nil
		}
	}
	for i := 0; i < 20; i++ {
		n, err := rand.Int(rand.Reader, big.NewInt(900000))
		if err != nil {
			return "", err
		}
		p := fmt.Sprintf("%06d", n.Int64()+100000)
		u, err := auth.OrganiserForPin(ctx, d.DB, p)
		if err != nil {
			return "", err
		}
		if u == nil {
			return p, nil
		}
	}
	return "", nil
}

// addOrganiser gives a second pair of hands a temporary PIN, shown once to
// whoever added them. It comes back in this response and NOWHERE else — never
// in a URL, which would put it in browser history and in the host's logs.
func addOrganiser(ctx context.Context, d *core.Deps, in addOrganiserIn) (addOrganiserOut, error) {
	name := cleanText(in.Name, 60)
	if len([]rune(name)) < 2 {
		return addOrganiserOut{Error: "Give them a name."}, nil
	}
	p, err := freePin(ctx, d)
	if err != nil {
		return addOrganiserOut{}, err
	}
	if p == "" {
		return addOrganiserOut{Error: "Every temporary PIN is in use. Somebody has to choose their own first."}, nil
	}
	hash, err := pin.Hash(p)
	if err != nil {
		return addOrganiserOut{}, err
	}
	id := ids.New("usr")
	if _, err := d.DB.ExecContext(ctx, `
		insert into users (id, name, username, role, pin_hash, must_change_pin)
		values ($1, $2, $3, 'organiser', $4, true)`,
		id, name, usernameFor(name), hash); err != nil {
		return addOrganiserOut{}, err
	}
	if err := core.Audit(ctx, d.DB, actor(ctx), "organiser.add", "user", id, "", map[string]string{"name": name}); err != nil {
		return addOrganiserOut{}, err
	}
	return addOrganiserOut{OK: true, Name: name, Pin: p}, nil
}

// usernameFor is the internal handle: a slug of the name plus four random
// characters, because two organisers really can be called Priya.
func usernameFor(name string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(name) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	slug := strings.Trim(collapseDashes(b.String()), "-")
	if slug == "" {
		slug = "organiser"
	}
	return slug + "-" + ids.New("")[:4]
}

func collapseDashes(s string) string {
	for strings.Contains(s, "--") {
		s = strings.ReplaceAll(s, "--", "-")
	}
	return s
}

// removeOrganiser switches somebody off — not deleted: their name stays on
// everything they did, and their sessions go so the PIN stops working now.
func removeOrganiser(ctx context.Context, d *core.Deps, in removeOrganiserIn) (noteOut, error) {
	me := rpc.UserFrom(ctx)
	if me != nil && in.UserID == me.ID {
		return refuse("You can’t remove yourself."), nil
	}
	var role string
	err := d.DB.QueryRowContext(ctx,
		`select role from users where id = $1 and active and deleted_at is null`, in.UserID).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return refuse("That organiser is not here."), nil
	}
	if err != nil {
		return noteOut{}, err
	}
	if role == "owner" {
		var owners int
		if err := d.DB.QueryRowContext(ctx,
			`select count(*) from users where role = 'owner' and active and deleted_at is null`).Scan(&owners); err != nil {
			return noteOut{}, err
		}
		if owners <= 1 {
			return refuse("The venue owner cannot be removed."), nil
		}
	}
	err = d.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `update users set active = false where id = $1`, in.UserID); err != nil {
			return err
		}
		return auth.RevokeSessions(ctx, tx, in.UserID)
	})
	if err != nil {
		return noteOut{}, err
	}
	if err := core.Audit(ctx, d.DB, actor(ctx), "organiser.remove", "user", in.UserID, "", nil); err != nil {
		return noteOut{}, err
	}
	return note("Removed. Their PIN no longer works."), nil
}

// tooEasy — six of the same digit, or a run. The first thing anyone tries.
func tooEasy(p string) bool {
	same := true
	for i := 1; i < len(p); i++ {
		if p[i] != p[0] {
			same = false
			break
		}
	}
	if same {
		return true
	}
	return strings.Contains("0123456789", p) || strings.Contains("9876543210", p)
}

func changePin(ctx context.Context, d *core.Deps, in changePinIn) (redirectOut, error) {
	me := rpc.UserFrom(ctx)
	current := pin.Normalize(in.Current)
	next := pin.Normalize(in.Next)
	confirm := pin.Normalize(in.Confirm)

	if current == "" {
		return refuseGo("Type your current PIN — six digits."), nil
	}
	if next == "" {
		return refuseGo("The new PIN needs to be six digits."), nil
	}
	if tooEasy(next) {
		return refuseGo("Not that one — six of the same digit or a run like 123456 is the first thing anyone tries."), nil
	}
	if next != confirm {
		return refuseGo("The two new PINs don’t match."), nil
	}

	now := d.Now()
	gate, err := core.CheckAllowed(ctx, d.DB, now, kindPinChange, me.ID)
	if err != nil {
		return redirectOut{}, err
	}
	if !gate.Allowed {
		return refuseGo(fmt.Sprintf("Too many tries. Come back in %d %s.",
			gate.RetryInMinutes, plural(gate.RetryInMinutes, "minute", "minutes"))), nil
	}

	var hash sql.NullString
	if err := d.DB.QueryRowContext(ctx, `select pin_hash from users where id = $1`, me.ID).Scan(&hash); err != nil {
		return redirectOut{}, err
	}
	if !hash.Valid || !pin.Verify(hash.String, current) {
		if err := core.RecordAttempt(ctx, d.DB, kindPinChange, me.ID, false); err != nil {
			return redirectOut{}, err
		}
		return refuseGo("Your current PIN is wrong."), nil
	}

	// Two organisers can never hold one PIN: sign-in would then admit
	// whichever of them the candidate list reached first.
	holder, err := auth.OrganiserForPin(ctx, d.DB, next)
	if err != nil {
		return redirectOut{}, err
	}
	if holder != nil && holder.ID != me.ID {
		if err := core.RecordAttempt(ctx, d.DB, kindPinChange, me.ID, false); err != nil {
			return redirectOut{}, err
		}
		return refuseGo("Another organiser already uses that PIN. Pick a different one."), nil
	}
	if err := core.RecordAttempt(ctx, d.DB, kindPinChange, me.ID, true); err != nil {
		return redirectOut{}, err
	}

	digest, err := pin.Hash(next)
	if err != nil {
		return redirectOut{}, err
	}
	raw := ids.Token()
	err = d.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx,
			`update users set pin_hash = $2, must_change_pin = false where id = $1`, me.ID, digest); err != nil {
			return err
		}
		if err := core.Audit(ctx, tx, me.ID, "pin.change", "user", me.ID, "", nil); err != nil {
			return err
		}
		// Every other device is signed out, then this one is signed back in:
		// a PIN somebody else may have seen must stop working everywhere.
		if err := auth.RevokeSessions(ctx, tx, me.ID); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx,
			`insert into sessions (id_hash, user_id, expires_at) values ($1, $2, $3)`,
			core.Sha256Hex(raw), me.ID, now.Add(sessionTTL))
		return err
	})
	if err != nil {
		return redirectOut{}, err
	}
	setSessionCookie(ctx, raw, now.Add(sessionTTL))
	return goTo("/admin"), nil
}

// setSessionCookie mirrors package auth's cookie exactly — HttpOnly,
// SameSite=Lax, Secure whenever the request arrived over TLS — because
// changePin is the one place outside auth that opens a session.
func setSessionCookie(ctx context.Context, raw string, expires time.Time) {
	w := rpc.ResponseFrom(ctx)
	r := rpc.RequestFrom(ctx)
	if w == nil || r == nil {
		return
	}
	secure := r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
	http.SetCookie(w, &http.Cookie{
		Name:     auth.CookieName,
		Value:    raw,
		Path:     "/",
		Expires:  expires,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
}
