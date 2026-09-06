// Package auth is the PIN sign-in and the session cookie behind every
// organiser screen.
//
// Sessions live in the database, not in a signed cookie: removing an
// organiser has to sign them out everywhere, now.
package auth

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"mpb/internal/core"
	"mpb/internal/ids"
	"mpb/internal/pin"
	"mpb/internal/rpc"
)

const (
	// CookieName is plain (no __Host- prefix) so the same binary works over
	// http on a laptop; Secure is added whenever the request came in over TLS.
	CookieName        = "mpb_session"
	sessionTTL        = 14 * 24 * time.Hour
	kindPIN           = "pin"
	globalMaxFailures = 50
)

// decoyHash is verified against when the PIN is malformed, so that path
// takes as long as a wrong PIN does.
var decoyHash, _ = pin.Hash("000000")

// Middleware reads the session cookie and puts the organiser on the context.
// It never refuses a request itself; the registry decides what needs one.
func Middleware(d *core.Deps, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(CookieName)
		if err != nil || c.Value == "" {
			next.ServeHTTP(w, r)
			return
		}
		u, refreshed, err := userForToken(r.Context(), d, c.Value)
		if err != nil {
			d.Log.Error("session lookup", "err", err)
		}
		if refreshed {
			// The row slid forward; the cookie's own expiry must follow it,
			// or an all-day organiser is signed out on day fourteen anyway.
			setCookie(w, r, c.Value, d.Now().Add(sessionTTL))
		}
		next.ServeHTTP(w, r.WithContext(rpc.WithUser(r.Context(), u)))
	})
}

func userForToken(ctx context.Context, d *core.Deps, raw string) (u *rpc.User, refreshed bool, err error) {
	h := core.Sha256Hex(raw)
	now := d.Now()
	var found rpc.User
	var expires time.Time
	var active bool
	var deleted sql.NullTime
	err = d.DB.QueryRowContext(ctx, `
		select u.id, u.name, u.role, u.must_change_pin, u.active, u.deleted_at, s.expires_at
		from sessions s join users u on u.id = s.user_id
		where s.id_hash = $1 and s.expires_at > $2`, h, now).
		Scan(&found.ID, &found.Name, &found.Role, &found.MustChangePin, &active, &deleted, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if !active || deleted.Valid {
		return nil, false, nil
	}
	// Sliding refresh past the halfway mark, so an all-day organiser is
	// never signed out mid-match.
	if expires.Sub(now) < sessionTTL/2 {
		_, _ = d.DB.ExecContext(ctx, `update sessions set expires_at = $1, last_seen_at = $2 where id_hash = $3`,
			now.Add(sessionTTL), now, h)
		refreshed = true
	}
	return &found, refreshed, nil
}

// ── the RPCs ──────────────────────────────────────────────────────────────

type loginIn struct {
	Pin  string `json:"pin"`
	Next string `json:"next"`
}

type loginOut struct {
	OK       bool   `json:"ok"`
	Redirect string `json:"redirect,omitempty"`
	Error    string `json:"error,omitempty"`
}

type meOut struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Role          string `json:"role"`
	MustChangePin bool   `json:"mustChangePin"`
}

// Register wires auth.login, auth.logout and auth.me.
func Register(reg *rpc.Registry, d *core.Deps) {
	rpc.Register(reg, "auth.login", rpc.Public, func(ctx context.Context, in loginIn) (loginOut, error) {
		return login(ctx, d, in)
	})
	rpc.Register(reg, "auth.logout", rpc.OrganiserAny, func(ctx context.Context, _ struct{}) (map[string]bool, error) {
		r := rpc.RequestFrom(ctx)
		if c, err := r.Cookie(CookieName); err == nil && c.Value != "" {
			_, _ = d.DB.ExecContext(ctx, `delete from sessions where id_hash = $1`, core.Sha256Hex(c.Value))
		}
		clearCookie(rpc.ResponseFrom(ctx), r)
		return map[string]bool{"ok": true}, nil
	})
	rpc.Register(reg, "auth.me", rpc.OrganiserAny, func(ctx context.Context, _ struct{}) (meOut, error) {
		u := rpc.UserFrom(ctx)
		return meOut{ID: u.ID, Name: u.Name, Role: u.Role, MustChangePin: u.MustChangePin}, nil
	})
}

func safeNext(raw string) string {
	// Only somewhere inside the organiser area, on this site.
	if strings.HasPrefix(raw, "/admin") && !strings.HasPrefix(raw, "//") {
		return raw
	}
	return "/admin"
}

func login(ctx context.Context, d *core.Deps, in loginIn) (loginOut, error) {
	r := rpc.RequestFrom(ctx)
	ipKey := core.HashIP(core.ClientIP(r))
	now := d.Now()

	// There is no username to lock, so the count is per address: five wrong
	// PINs in fifteen minutes and that address waits.
	gate, err := core.CheckAllowed(ctx, d.DB, now, kindPIN, ipKey)
	if err != nil {
		return loginOut{}, err
	}
	// And a venue-wide brake behind it: a guesser rotating addresses would
	// otherwise get five tries per address for ever. It is a switch anyone
	// on the internet can flip against the organiser, which is why it sits
	// at fifty — nobody mistypes that often — and lifts by itself.
	if gate.Allowed {
		total, err := core.GlobalFailures(ctx, d.DB, now, kindPIN)
		if err != nil {
			return loginOut{}, err
		}
		if total >= globalMaxFailures {
			gate = core.Allowance{Allowed: false, RetryInMinutes: 15}
		}
	}
	if !gate.Allowed {
		unit := "minutes"
		if gate.RetryInMinutes == 1 {
			unit = "minute"
		}
		return loginOut{Error: fmt.Sprintf("Too many wrong PINs. Try again in %d %s.", gate.RetryInMinutes, unit)}, nil
	}

	// A PIN that is not six digits is wrong before it is checked — and it
	// still counts, and still costs a hash, or the shape of the input
	// becomes a free oracle.
	p := pin.Normalize(in.Pin)
	var user *rpc.User
	if p != "" {
		user, err = OrganiserForPin(ctx, d.DB, p)
		if err != nil {
			return loginOut{}, err
		}
	} else {
		pin.Verify(decoyHash, in.Pin)
	}
	if err := core.RecordAttempt(ctx, d.DB, kindPIN, ipKey, user != nil); err != nil {
		return loginOut{}, err
	}
	if user == nil {
		left := gate.TriesLeft - 1
		if left > 0 {
			word := "tries"
			if left == 1 {
				word = "try"
			}
			return loginOut{Error: fmt.Sprintf("That's not it. %d %s left before a fifteen-minute wait.", left, word)}, nil
		}
		return loginOut{Error: "That’s not it. Wait fifteen minutes before trying again."}, nil
	}

	raw := ids.Token()
	if _, err := d.DB.ExecContext(ctx,
		`insert into sessions (id_hash, user_id, expires_at) values ($1, $2, $3)`,
		core.Sha256Hex(raw), user.ID, now.Add(sessionTTL)); err != nil {
		return loginOut{}, err
	}
	_, _ = d.DB.ExecContext(ctx, `update users set last_login_at = $1 where id = $2`, now, user.ID)
	setCookie(rpc.ResponseFrom(ctx), r, raw, now.Add(sessionTTL))

	if user.MustChangePin {
		return loginOut{OK: true, Redirect: "/admin/account?first=1"}, nil
	}
	return loginOut{OK: true, Redirect: safeNext(in.Next)}, nil
}

// OrganiserForPin finds the organiser a PIN belongs to, most recently
// signed-in first so the usual person costs one hash, not three. Nil when
// nobody has it.
func OrganiserForPin(ctx context.Context, q core.Querier, p string) (*rpc.User, error) {
	rows, err := q.QueryContext(ctx, `
		select id, name, role, must_change_pin, pin_hash from users
		where active and deleted_at is null and pin_hash is not null
		order by last_login_at desc nulls last, created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var u rpc.User
		var hash string
		if err := rows.Scan(&u.ID, &u.Name, &u.Role, &u.MustChangePin, &hash); err != nil {
			return nil, err
		}
		if pin.Verify(hash, p) {
			return &u, nil
		}
	}
	return nil, rows.Err()
}

// RevokeSessions signs a user out everywhere — when they are removed, or
// when their PIN is replaced by someone else.
func RevokeSessions(ctx context.Context, q core.Querier, userID string) error {
	_, err := q.ExecContext(ctx, `delete from sessions where user_id = $1`, userID)
	return err
}

func secure(r *http.Request) bool {
	return r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

func setCookie(w http.ResponseWriter, r *http.Request, raw string, expires time.Time) {
	if w == nil {
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    raw,
		Path:     "/",
		Expires:  expires,
		HttpOnly: true,
		Secure:   secure(r),
		SameSite: http.SameSiteLaxMode,
	})
}

func clearCookie(w http.ResponseWriter, r *http.Request) {
	if w == nil {
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   secure(r),
		SameSite: http.SameSiteLaxMode,
	})
}
