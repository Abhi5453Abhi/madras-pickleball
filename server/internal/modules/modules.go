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

// Register adds every module to the mux and the RPC registry.
func Register(mux *http.ServeMux, reg *rpc.Registry, d *core.Deps) {
	setup.Register(mux, reg, d)
	live.Register(mux, reg, d)
}
