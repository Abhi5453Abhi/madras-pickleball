package setup

import (
	"context"
	"database/sql"
	"strings"

	"mpb/internal/core"
	"mpb/internal/rpc"
	"mpb/internal/store"
)

// ── shapes every module here shares ───────────────────────────────────────

// courtOut is `Court` in docs/GO-API.ts: swatch and name, nothing else.
type courtOut struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	ColorKey string `json:"colorKey"`
}

func courtsOut(rows []store.Court) []courtOut {
	out := make([]courtOut, 0, len(rows))
	for _, c := range rows {
		out = append(out, courtOut{ID: c.ID, Name: c.Name, ColorKey: c.ColorKey})
	}
	return out
}

// okOut is the shape of every action that only says yes.
type okOut struct {
	OK bool `json:"ok"`
}

// okErrOut is an action that either says yes or refuses with a sentence and
// no note. A refusal is 200: the screen prints it, the transport is fine.
type okErrOut struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// noteOut is an action that succeeded with a sentence for the screen, or a
// refusal with one. A refusal is 200 with ok:false — the screen prints it.
type noteOut struct {
	OK    bool   `json:"ok"`
	Note  string `json:"note,omitempty"`
	Error string `json:"error,omitempty"`
}

func note(s string) noteOut   { return noteOut{OK: true, Note: s} }
func refuse(s string) noteOut { return noteOut{Error: s} }

// redirectOut is an action the reference finished with a redirect().
type redirectOut struct {
	OK       bool   `json:"ok"`
	Redirect string `json:"redirect,omitempty"`
	Error    string `json:"error,omitempty"`
}

func goTo(path string) redirectOut  { return redirectOut{OK: true, Redirect: path} }
func refuseGo(s string) redirectOut { return redirectOut{Error: s} }

// ── lookups ───────────────────────────────────────────────────────────────

// mustTournament resolves an id inside this venue. Unknown or deleted is a
// 404: the id came off a screen, and a tournament that is gone is gone.
func mustTournament(ctx context.Context, d *core.Deps, q core.Querier, id string) (*store.Tournament, error) {
	if id == "" {
		return nil, rpc.NotFound("No such tournament.")
	}
	t, err := store.TournamentByID(ctx, q, d.Venue.ID, id)
	if store.IsNotFound(err) {
		return nil, rpc.NotFound("No such tournament.")
	}
	return t, err
}

// mustTournamentBySlug is the one place a slug becomes an id.
func mustTournamentBySlug(ctx context.Context, d *core.Deps, slug string) (*store.Tournament, error) {
	if slug == "" {
		return nil, rpc.NotFound("No such tournament.")
	}
	t, err := store.TournamentBySlug(ctx, d.DB, d.Venue.ID, slug)
	if store.IsNotFound(err) {
		return nil, rpc.NotFound("No such tournament.")
	}
	return t, err
}

// lockTournament is the first statement of every write: the row is locked for
// the rest of the transaction, so two taps on two phones take turns.
func lockTournament(ctx context.Context, tx *sql.Tx, d *core.Deps, id string) (*store.Tournament, error) {
	if id == "" {
		return nil, rpc.NotFound("No such tournament.")
	}
	t, err := store.TournamentByIDForUpdate(ctx, tx, d.Venue.ID, id)
	if store.IsNotFound(err) {
		return nil, rpc.NotFound("No such tournament.")
	}
	return t, err
}

// actor is the signed-in organiser's id for the audit log, or "" for the two
// public RPCs.
func actor(ctx context.Context) string {
	if u := rpc.UserFrom(ctx); u != nil {
		return u.ID
	}
	return ""
}

// ── small shared helpers ──────────────────────────────────────────────────

// cleanText collapses whitespace, trims, and cuts to max characters — what
// every free-text field on a form goes through.
func cleanText(raw string, max int) string {
	s := strings.Join(strings.Fields(raw), " ")
	r := []rune(s)
	if len(r) > max {
		s = string(r[:max])
	}
	return s
}

// plural is "1 player" / "3 players" without a switch at every call site.
func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

// teamSizeOf is 2 for doubles, 1 for singles.
func teamSizeOf(t *store.Tournament) int { return t.TeamSize() }

// isLocked — pairs are the organiser's to change right up to the start. Once
// the day is running a changed pair is a swap or a pull-out, under More.
func isLocked(t *store.Tournament) bool {
	return t.Status == "live" || t.Status == "completed"
}

// signupsClosed is the reference's pure helper: the organiser closed them, or
// the tournament has started.
func signupsClosed(t *store.Tournament) bool {
	return t.RegistrationClosedAt != nil || t.Status != "setup"
}

// firstName is what the grey notes on the Teams screen call somebody.
func firstName(name string) string {
	fields := strings.Fields(name)
	if len(fields) == 0 {
		return name
	}
	return fields[0]
}
