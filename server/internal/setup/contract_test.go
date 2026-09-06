package setup

import (
	"io"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"sort"
	"testing"

	"mpb/internal/core"
	"mpb/internal/rpc"
)

// mine are the six modules this package answers for.
var mine = map[string]bool{
	"venue": true, "organisers": true, "events": true,
	"tournaments": true, "registration": true, "teams": true,
}

// registryEntry matches a line of the Registry type in docs/GO-API.ts:
//
//	'events.hub': Events_hub
//
// The Pages block below it names the same functions in prose, unquoted, so the
// quotes and the colon are what keep this to the contract itself.
var registryEntry = regexp.MustCompile(`(?m)^\s*'([a-z]+)\.([A-Za-z]+)':`)

func contractNames(t *testing.T) []string {
	t.Helper()
	body, err := os.ReadFile("../../../docs/GO-API.ts")
	if err != nil {
		t.Fatalf("the contract: %v", err)
	}
	var out []string
	seen := map[string]bool{}
	for _, m := range registryEntry.FindAllStringSubmatch(string(body), -1) {
		if !mine[m[1]] {
			continue
		}
		name := m[1] + "." + m[2]
		if !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	if len(out) < 30 {
		t.Fatalf("only %d names came out of the contract — the regexp has drifted", len(out))
	}
	sort.Strings(out)
	return out
}

// registered is what this package actually wires up. It needs no database:
// Register only builds closures.
func registered(t *testing.T) *rpc.Registry {
	t.Helper()
	reg := rpc.New(slog.New(slog.NewTextHandler(io.Discard, nil)))
	Register(http.NewServeMux(), reg, &core.Deps{})
	return reg
}

func TestEveryContractRpcIsRegistered(t *testing.T) {
	reg := registered(t)
	have := map[string]bool{}
	for _, n := range reg.Names() {
		have[n] = true
	}
	for _, want := range contractNames(t) {
		if !have[want] {
			t.Errorf("%s is in docs/GO-API.ts and is not registered", want)
		}
	}
}

func TestNothingIsRegisteredThatTheContractDoesNotName(t *testing.T) {
	want := map[string]bool{}
	for _, n := range contractNames(t) {
		want[n] = true
	}
	for _, got := range registered(t).Names() {
		if !want[got] {
			t.Errorf("%s is registered and is not in docs/GO-API.ts", got)
		}
	}
}

// The auth level is part of the contract: the two public ones read no cookie,
// the owner's three are the owner's, and changePin is the one door a temporary
// PIN opens.
func TestAuthLevels(t *testing.T) {
	reg := registered(t)
	cases := map[string]rpc.Auth{
		"registration.resolveRegistrationToken": rpc.Public,
		"registration.submitRegistration":       rpc.Public,
		"organisers.listOrganisers":             rpc.Owner,
		"organisers.addOrganiser":               rpc.Owner,
		"organisers.removeOrganiser":            rpc.Owner,
		"organisers.changePin":                  rpc.OrganiserAny,
		"events.hub":                            rpc.Organiser,
		"venue.venueCourts":                     rpc.Organiser,
		"teams.teamBoard":                       rpc.Organiser,
		"tournaments.generateDraw":              rpc.Organiser,
	}
	for name, want := range cases {
		got, ok := reg.AuthOf(name)
		if !ok {
			t.Errorf("%s is not registered", name)
			continue
		}
		if got != want {
			t.Errorf("%s is guarded as %d, want %d", name, got, want)
		}
	}
	// Everything else this package registers needs a signed-in organiser.
	for _, name := range reg.Names() {
		if _, special := cases[name]; special {
			continue
		}
		if got, _ := reg.AuthOf(name); got != rpc.Organiser {
			t.Errorf("%s is guarded as %d, want organiser", name, got)
		}
	}
}
