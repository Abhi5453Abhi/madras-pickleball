// Package modules wires every feature package into the server. Each package
// registers its own RPCs and any plain GET endpoints it serves.
package modules

import (
	"net/http"

	"mpb/internal/core"
	"mpb/internal/live"
	"mpb/internal/rpc"
	"mpb/internal/setup"
)

// Register adds every module to the mux and the RPC registry, and joins the
// two halves: starting a tournament or changing its courts (setup) sends
// the next matches onto free courts (live).
func Register(mux *http.ServeMux, reg *rpc.Registry, d *core.Deps) {
	setup.FlowTournament = live.FlowTournament
	setup.Register(mux, reg, d)
	live.Register(mux, reg, d)
}
