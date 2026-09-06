// Package setup is everything before Start: the venue's courts, the
// organisers, tournaments and their courts, sign-ups and pairs — the
// `venue.*`, `organisers.*`, `events.*`, `tournaments.*`, `registration.*`
// and `teams.*` RPCs of docs/GO-API.ts.
package setup

import (
	"net/http"

	"mpb/internal/core"
	"mpb/internal/rpc"
)

// Register wires this package's RPCs.
func Register(mux *http.ServeMux, reg *rpc.Registry, d *core.Deps) {
	_ = mux
	_ = reg
	_ = d
}
