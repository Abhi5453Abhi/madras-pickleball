// Package rpc is the wire: one POST per server function, JSON in, JSON out.
//
// docs/GO-API.ts is the contract. A module registers each of its functions
// with a name like "events.hub", the auth it needs, and a typed handler; the
// registry decodes the body, checks the session, calls, and encodes.
package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
)

// Auth is who may call a function.
type Auth int

const (
	Public    Auth = iota // no session, no cookie read
	Organiser             // any signed-in organiser (owner included) who has chosen their PIN
	Owner                 // the venue owner only
	// OrganiserAny admits a signed-in organiser still on a temporary PIN. A
	// temporary PIN is a credential read off a screen and typed on a shared
	// phone: it opens exactly one door, the one that replaces it — so only
	// auth.me, auth.logout and organisers.changePin use this.
	OrganiserAny
)

// User is the signed-in organiser, as the session middleware found them.
type User struct {
	ID            string
	Name          string
	Role          string // "owner" | "organiser"
	MustChangePin bool
}

// IsOwner is the one role check the app makes.
func (u *User) IsOwner() bool { return u != nil && u.Role == "owner" }

type userKey struct{}

// WithUser attaches the signed-in user to a context; nil means signed out.
func WithUser(ctx context.Context, u *User) context.Context {
	return context.WithValue(ctx, userKey{}, u)
}

// UserFrom returns the signed-in user or nil.
func UserFrom(ctx context.Context) *User {
	u, _ := ctx.Value(userKey{}).(*User)
	return u
}

type responseKey struct{}

// ResponseFrom returns the ResponseWriter, for the few functions that set a
// cookie (auth.login, auth.logout). Everything else never needs it.
func ResponseFrom(ctx context.Context) http.ResponseWriter {
	w, _ := ctx.Value(responseKey{}).(http.ResponseWriter)
	return w
}

type requestKey struct{}

// RequestFrom returns the request, for the IP and the TLS flag.
func RequestFrom(ctx context.Context) *http.Request {
	r, _ := ctx.Value(requestKey{}).(*http.Request)
	return r
}

// Error is a refusal with a status the client understands and a message a
// person can read.
type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return e.Message }

// BadRequest, Unauthorized, Forbidden and NotFound are the four refusals.
func BadRequest(msg string) error   { return &Error{http.StatusBadRequest, msg} }
func Unauthorized(msg string) error { return &Error{http.StatusUnauthorized, msg} }
func Forbidden(msg string) error    { return &Error{http.StatusForbidden, msg} }
func NotFound(msg string) error     { return &Error{http.StatusNotFound, msg} }

type entry struct {
	auth Auth
	call func(ctx context.Context, body json.RawMessage) (any, error)
}

// Registry maps "module.function" to handlers.
type Registry struct {
	entries map[string]entry
	log     *slog.Logger
}

// New makes an empty registry.
func New(log *slog.Logger) *Registry {
	return &Registry{entries: map[string]entry{}, log: log}
}

// Register adds a typed handler. I is decoded from the JSON body; O is
// encoded as the reply. Registering a name twice is a programming error.
func Register[I any, O any](r *Registry, name string, auth Auth, fn func(ctx context.Context, in I) (O, error)) {
	if _, dup := r.entries[name]; dup {
		panic("rpc: " + name + " registered twice")
	}
	r.entries[name] = entry{
		auth: auth,
		call: func(ctx context.Context, body json.RawMessage) (any, error) {
			var in I
			if len(body) > 0 && string(body) != "null" {
				dec := json.NewDecoder(strings.NewReader(string(body)))
				if err := dec.Decode(&in); err != nil {
					return nil, BadRequest("That request could not be read.")
				}
			}
			return fn(ctx, in)
		},
	}
}

// Names lists what is registered, for tests that check the contract.
func (r *Registry) Names() []string {
	out := make([]string, 0, len(r.entries))
	for n := range r.entries {
		out = append(out, n)
	}
	return out
}

// Call runs a registered function in this process, with the body it would
// have arrived with over HTTP. It is for programs that already hold the
// database — cmd/seed, which builds the walks' test data — so they go through
// the same code a screen does instead of writing their own SQL. The session,
// role and CSRF checks are the HTTP handler's: they guard a browser, and there
// is no browser here.
func (r *Registry) Call(ctx context.Context, name string, body json.RawMessage) (any, error) {
	e, ok := r.entries[name]
	if !ok {
		return nil, NotFound("No such function.")
	}
	return e.call(ctx, body)
}

// AuthOf reports how a function is guarded.
func (r *Registry) AuthOf(name string) (Auth, bool) {
	e, ok := r.entries[name]
	return e.auth, ok
}

// Handler serves POST /api/rpc/{name}. The session middleware runs before
// it and puts the user (or nil) on the context.
func (r *Registry) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		name := req.PathValue("name")
		e, ok := r.entries[name]
		if !ok {
			writeError(w, NotFound("No such function."))
			return
		}
		if req.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			writeError(w, &Error{http.StatusMethodNotAllowed, "POST only."})
			return
		}
		if !sameOrigin(req) {
			writeError(w, Forbidden("That request came from somewhere else."))
			return
		}
		user := UserFrom(req.Context())
		if e.auth != Public && user == nil {
			writeError(w, Unauthorized("Sign in first."))
			return
		}
		if (e.auth == Organiser || e.auth == Owner) && user.MustChangePin {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusForbidden)
			json.NewEncoder(w).Encode(map[string]string{ //nolint:errcheck
				"error": "Choose your own PIN first.", "redirect": "/admin/account?first=1"})
			return
		}
		if e.auth == Owner && !user.IsOwner() {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusForbidden)
			json.NewEncoder(w).Encode(map[string]string{ //nolint:errcheck
				"error": "Only the venue owner can do that.", "redirect": "/admin?denied=1"})
			return
		}
		body, err := io.ReadAll(io.LimitReader(req.Body, 1<<20))
		if err != nil {
			writeError(w, BadRequest("That request could not be read."))
			return
		}
		ctx := context.WithValue(req.Context(), responseKey{}, w)
		ctx = context.WithValue(ctx, requestKey{}, req)
		out, err := e.call(ctx, body)
		if err != nil {
			var re *Error
			if errors.As(err, &re) {
				writeError(w, re)
				return
			}
			r.log.Error("rpc failed", "name", name, "err", err)
			writeError(w, &Error{http.StatusInternalServerError, "Something went wrong on our side. Try again in a moment."})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if out == nil {
			w.Write([]byte("null"))
			return
		}
		if err := json.NewEncoder(w).Encode(out); err != nil {
			r.log.Error("rpc encode", "name", name, "err", err)
		}
	})
}

func writeError(w http.ResponseWriter, err error) {
	var re *Error
	if !errors.As(err, &re) {
		re = &Error{http.StatusInternalServerError, err.Error()}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(re.Status)
	json.NewEncoder(w).Encode(map[string]string{"error": re.Message}) //nolint:errcheck
}

// sameOrigin is the CSRF check: a browser always sends Origin on a POST
// made by script, and it must be this host. A request with no Origin (curl,
// a test) is allowed — it carries no cookie the browser attached.
func sameOrigin(req *http.Request) bool {
	origin := req.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Host, req.Host)
}

// WriteJSON is for the plain GET endpoints (the version pollers).
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

// String is a small helper for the handful of places that build messages.
func String(format string, a ...any) string { return fmt.Sprintf(format, a...) }
