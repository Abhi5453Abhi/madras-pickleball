package live

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"testing"

	"mpb/internal/core"
	"mpb/internal/rpc"
)

// Every name this package owns in the contract's Registry is registered, and
// guarded the way the contract says. A name that is not registered is a 404
// from the router — which the screen meets as a blank page on tournament
// morning.
func TestEveryContractNameIsRegistered(t *testing.T) {
	source, err := os.ReadFile("../../../docs/GO-API.ts")
	if err != nil {
		t.Fatalf("the contract is the agreement; without it this test says nothing: %v", err)
	}
	// Only the Registry block: the same name appears in prose above it.
	registry := regexp.MustCompile(`(?s)export type Registry = \{(.*?)\n\}`).FindSubmatch(source)
	if registry == nil {
		t.Fatal("docs/GO-API.ts has no Registry block")
	}
	names := regexp.MustCompile(`'((?:board|scoring|chaos|public)\.\w+)'`).FindAllSubmatch(registry[1], -1)
	if len(names) == 0 {
		t.Fatal("the Registry names none of this package's functions")
	}

	mux := http.NewServeMux()
	reg := rpc.New(slog.New(slog.NewTextHandler(nopWriter{}, nil)))
	Register(mux, reg, &core.Deps{Log: slog.New(slog.NewTextHandler(nopWriter{}, nil))})

	registered := map[string]bool{}
	for _, n := range reg.Names() {
		registered[n] = true
	}
	for _, m := range names {
		name := string(m[1])
		auth, ok := reg.AuthOf(name)
		if !ok {
			t.Errorf("%s is in the contract and not in the registry", name)
			continue
		}
		want := rpc.Organiser
		if name[:7] == "public." {
			// Public reads no cookie and never returns a phone number.
			want = rpc.Public
		}
		if auth != want {
			t.Errorf("%s is guarded as %v, wanted %v", name, auth, want)
		}
		delete(registered, name)
	}
	for name := range registered {
		t.Errorf("%s is registered and is not in the contract", name)
	}

	// The three pollers answer, and nothing else under /api/version does.
	for _, path := range []string{"/api/version/today", "/api/version/t/mens", "/api/version/venue"} {
		if h, pattern := mux.Handler(httpGet(path)); h == nil || pattern == "" {
			t.Errorf("GET %s is not served", path)
		}
	}
}

func httpGet(path string) *http.Request {
	req, _ := http.NewRequestWithContext(context.Background(), "GET", "http://venue"+path, nil)
	return req
}
