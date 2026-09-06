// Package setup is everything before Start: the venue's courts, the
// organisers, tournaments and their courts, sign-ups and pairs — the
// `venue.*`, `organisers.*`, `events.*`, `tournaments.*`, `registration.*`
// and `teams.*` RPCs of docs/GO-API.ts.
package setup

import (
	"context"
	"database/sql"
	"net/http"

	"mpb/internal/core"
	"mpb/internal/rpc"
)

// FlowTournament is the seam between this package and `live`: the first
// matches of a tournament go onto its free courts after a start, after a
// court is added, and wherever else the reference called `flowTournament`.
// The integrator wires it at start-up (`setup.FlowTournament = live.Flow…`);
// until then it is nil and the writes simply do not place anything, which is
// exactly what a tournament with no courts does anyway.
//
// It is called INSIDE the caller's transaction, after the write and the
// version bump, so a court that came free and the match that goes on it land
// together or not at all.
var FlowTournament func(ctx context.Context, tx *sql.Tx, d *core.Deps, tournamentID string) error

func flow(ctx context.Context, tx *sql.Tx, d *core.Deps, tournamentID string) error {
	if FlowTournament == nil {
		return nil
	}
	return FlowTournament(ctx, tx, d, tournamentID)
}

// Register wires this package's RPCs.
func Register(mux *http.ServeMux, reg *rpc.Registry, d *core.Deps) {
	_ = mux // this package serves no plain GET endpoints
	registerVenue(reg, d)
	registerOrganisers(reg, d)
	registerEvents(reg, d)
	registerTournaments(reg, d)
	registerTeams(reg, d)
	registerRegistration(reg, d)
}
