// Package core is what every module shares: the database, the venue, the
// clock, the version counter the screens poll, the audit log and the
// five-in-fifteen guard.
package core

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"mpb/internal/db"
	"mpb/internal/ids"
)

// Venue is the one venue this instance serves.
type Venue struct {
	ID       string
	Name     string
	Slug     string
	Location *time.Location
}

// Deps is handed to every module's Register.
type Deps struct {
	DB    *sql.DB
	Venue Venue
	Log   *slog.Logger
	// Now is a hook so tests can freeze the clock.
	Now func() time.Time
}

// Querier is *sql.DB or *sql.Tx — every store function takes one so it can
// run inside or outside a transaction.
type Querier interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// Tx runs fn in a transaction.
func (d *Deps) Tx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	return db.Tx(ctx, d.DB, fn)
}

// ── the venue's clock ─────────────────────────────────────────────────────

// India has one offset and no daylight saving; the fixed zone means a
// container with no tzdata still gets it right.
var IST = time.FixedZone("IST", 5*3600+30*60)

// DayKey is "2026-09-14" at the venue — the only correct basis for "today".
func DayKey(t time.Time) string { return t.In(IST).Format("2006-01-02") }

// VenueTime is "16:34" at the venue.
func VenueTime(t time.Time) string { return t.In(IST).Format("15:04") }

// VenueDate is "Sun, 14 Sep" at the venue.
func VenueDate(t time.Time) string { return t.In(IST).Format("Mon, 2 Jan") }

// DayStart is the instant a venue day starts, for a "2006-01-02" key.
func DayStart(dayKey string) time.Time {
	t, _ := time.ParseInLocation("2006-01-02", dayKey, IST)
	return t
}

// DayEnd is the last instant of a venue day.
func DayEnd(dayKey string) time.Time { return DayStart(dayKey).Add(24*time.Hour - time.Second) }

// FormatDuration is "7 hrs 34" / "45 min".
func FormatDuration(minutes int) string {
	if minutes < 0 {
		minutes = 0
	}
	if minutes < 60 {
		return fmt.Sprintf("%d min", minutes)
	}
	h, rem := minutes/60, minutes%60
	unit := "hrs"
	if h == 1 {
		unit = "hr"
	}
	if rem == 0 {
		return fmt.Sprintf("%d %s", h, unit)
	}
	return fmt.Sprintf("%d %s %d", h, unit, rem)
}

// ElapsedLabel is "12 min" or "just started", for a live court card.
func ElapsedLabel(since, now time.Time) string {
	m := int(now.Sub(since).Round(time.Minute) / time.Minute)
	if m < 1 {
		return "just started"
	}
	return fmt.Sprintf("%d min", m)
}

// ── versions the screens poll ─────────────────────────────────────────────

// Bump raises a tournament's version inside the same transaction as the
// write that changed what a screen shows. Polling an integer is cheap;
// max(updated_at) across tables is not, and freezes on same-millisecond
// writes.
func Bump(ctx context.Context, q Querier, tournamentID string) error {
	_, err := q.ExecContext(ctx,
		`update tournaments set version = version + 1, updated_at = now() where id = $1`, tournamentID)
	return err
}

// ── audit ─────────────────────────────────────────────────────────────────

// Audit leaves a row for every correction and every destructive action.
func Audit(ctx context.Context, q Querier, userID, action, entity, entityID, reason string, details any) error {
	var det []byte
	if details != nil {
		det, _ = json.Marshal(details)
	}
	var uid, rsn, dj any
	if userID != "" {
		uid = userID
	}
	if reason != "" {
		rsn = reason
	}
	if det != nil {
		dj = string(det)
	}
	_, err := q.ExecContext(ctx,
		`insert into audit_log (id, user_id, action, entity, entity_id, reason, details) values ($1,$2,$3,$4,$5,$6,$7)`,
		ids.New("aud"), uid, action, entity, entityID, rsn, dj)
	return err
}

// ── the five-in-fifteen guard ─────────────────────────────────────────────

const (
	guardWindow   = 15 * time.Minute
	guardMaxFails = 5
)

// Allowance says whether another try may be made under a key.
type Allowance struct {
	Allowed        bool
	TriesLeft      int
	RetryInMinutes int
}

// CheckAllowed counts failed attempts of one kind under one key in the last
// fifteen minutes. Five and the key waits until the oldest of them ages out.
// The count lives in Postgres because an in-memory counter is worthless on a
// host that may start a fresh container for every request.
func CheckAllowed(ctx context.Context, q Querier, now time.Time, kind, key string) (Allowance, error) {
	rows, err := q.QueryContext(ctx,
		`select at from attempts where kind = $1 and key = $2 and succeeded = false and at >= $3
		 order by at desc limit $4`, kind, key, now.Add(-guardWindow), guardMaxFails)
	if err != nil {
		return Allowance{}, err
	}
	defer rows.Close()
	var ats []time.Time
	for rows.Next() {
		var at time.Time
		if err := rows.Scan(&at); err != nil {
			return Allowance{}, err
		}
		ats = append(ats, at)
	}
	if len(ats) >= guardMaxFails {
		until := ats[len(ats)-1].Add(guardWindow)
		mins := int((until.Sub(now) + time.Minute - 1) / time.Minute)
		if mins < 1 {
			mins = 1
		}
		return Allowance{Allowed: false, RetryInMinutes: mins}, nil
	}
	return Allowance{Allowed: true, TriesLeft: guardMaxFails - len(ats)}, nil
}

// RecordAttempt writes one try. A success also clears the key's failures, so
// a right PIN after four wrong ones starts the count over.
func RecordAttempt(ctx context.Context, q Querier, kind, key string, succeeded bool) error {
	if succeeded {
		_, err := q.ExecContext(ctx, `delete from attempts where kind = $1 and key = $2`, kind, key)
		return err
	}
	_, err := q.ExecContext(ctx,
		`insert into attempts (id, kind, key, succeeded) values ($1, $2, $3, false)`, ids.New("att"), kind, key)
	return err
}

// ── the caller ────────────────────────────────────────────────────────────

// ClientIP is the address a request came from, through the host's proxy.
func ClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// HashIP keys a rate limit without storing the address itself.
func HashIP(ip string) string {
	if ip == "" {
		return "none"
	}
	sum := sha256.Sum256([]byte("ip:" + ip))
	return hex.EncodeToString(sum[:8])
}

// Sha256Hex is for tokens: only the hash is ever stored.
func Sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// ── null helpers for scanning ─────────────────────────────────────────────

// StrPtr turns a nullable text column into *string.
func StrPtr(ns sql.NullString) *string {
	if !ns.Valid {
		return nil
	}
	s := ns.String
	return &s
}

// TimePtr turns a nullable timestamp into *time.Time.
func TimePtr(nt sql.NullTime) *time.Time {
	if !nt.Valid {
		return nil
	}
	t := nt.Time
	return &t
}

// ISO renders a time for the wire, or nil.
func ISO(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.UTC().Format(time.RFC3339Nano)
	return &s
}
