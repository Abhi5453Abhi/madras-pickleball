// Package live is the tournament day: the venue board, courts, scores and
// corrections, the More list, and the public pages — the `board.*`,
// `scoring.*`, `chaos.*` and `public.*` RPCs of docs/GO-API.ts plus the
// three GET /api/version endpoints.
//
// One rule runs through all of it. Every write happens in one transaction, and
// the last thing that transaction does is FlowTournament: the slots that have
// become known are resolved, what can be played is made ready, and the next
// matches go onto this tournament's own free courts. The organiser enters
// scores; the board does the rest.
package live

import (
	"net/http"

	"mpb/internal/core"
	"mpb/internal/rpc"
)

// Register wires this package's RPCs and version endpoints.
func Register(mux *http.ServeMux, reg *rpc.Registry, d *core.Deps) {
	registerBoard(reg, d)
	registerScoring(reg, d)
	registerChaos(reg, d)
	registerPublic(mux, reg, d)
}
