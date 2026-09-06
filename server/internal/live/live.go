// Package live is the tournament day: the venue board, courts, scores and
// corrections, the More list, and the public pages — the `board.*`,
// `scoring.*`, `chaos.*` and `public.*` RPCs of docs/GO-API.ts plus the
// three GET /api/version endpoints.
package live

import (
	"net/http"

	"mpb/internal/core"
	"mpb/internal/rpc"
)

// Register wires this package's RPCs and version endpoints.
func Register(mux *http.ServeMux, reg *rpc.Registry, d *core.Deps) {
	_ = mux
	_ = reg
	_ = d
}
