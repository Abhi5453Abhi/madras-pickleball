package setup

import (
	"context"
	"database/sql"
	"strings"

	"mpb/internal/core"
	"mpb/internal/ids"
	"mpb/internal/rpc"
	"mpb/internal/store"
)

// The venue's courts — the one piece of furniture the organiser owns. Four
// were seeded; a venue with three, or with a fifth built over the summer,
// changes them here and nowhere else.

// colourKeys are the swatches `CourtSwatch` knows, in the order new courts
// take them.
var colourKeys = []string{"blue", "orange", "teal", "violet", "clay", "indigo"}

type venueCourtOut struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	ColorKey string   `json:"colorKey"`
	HeldBy   []string `json:"heldBy"`
}

type addCourtIn struct {
	Name string `json:"name"`
}

type renameCourtIn struct {
	CourtID string `json:"courtId"`
	Name    string `json:"name"`
}

type courtIDIn struct {
	CourtID string `json:"courtId"`
}

func registerVenue(reg *rpc.Registry, d *core.Deps) {
	rpc.Register(reg, "venue.venueCourts", rpc.Organiser,
		func(ctx context.Context, _ struct{}) ([]venueCourtOut, error) { return venueCourts(ctx, d) })

	rpc.Register(reg, "venue.addCourt", rpc.Organiser,
		func(ctx context.Context, in addCourtIn) (noteOut, error) { return addCourt(ctx, d, in) })

	rpc.Register(reg, "venue.renameCourt", rpc.Organiser,
		func(ctx context.Context, in renameCourtIn) (noteOut, error) { return renameCourt(ctx, d, in) })

	rpc.Register(reg, "venue.removeCourt", rpc.Organiser,
		func(ctx context.Context, in courtIDIn) (noteOut, error) { return removeCourt(ctx, d, in) })
}

// heldByCourt is who is counting on each court from today on, so taking one
// out can say who loses it. A completed tournament has let go of its courts.
func heldByCourt(ctx context.Context, q core.Querier, d *core.Deps) (map[string][]string, error) {
	rows, err := q.QueryContext(ctx, `
		select tc.court_id, t.name
		from tournament_courts tc join tournaments t on t.id = tc.tournament_id
		where t.venue_id = $1 and tc.day_key >= $2 and t.deleted_at is null and t.status <> 'completed'
		order by t.day, t.created_at`, d.Venue.ID, core.DayKey(d.Now()))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]string{}
	for rows.Next() {
		var courtID, name string
		if err := rows.Scan(&courtID, &name); err != nil {
			return nil, err
		}
		out[courtID] = append(out[courtID], name)
	}
	return out, rows.Err()
}

func venueCourts(ctx context.Context, d *core.Deps) ([]venueCourtOut, error) {
	courts, err := store.VenueCourts(ctx, d.DB, d.Venue.ID, true)
	if err != nil {
		return nil, err
	}
	held, err := heldByCourt(ctx, d.DB, d)
	if err != nil {
		return nil, err
	}
	out := make([]venueCourtOut, 0, len(courts))
	for _, c := range courts {
		names := held[c.ID]
		if names == nil {
			names = []string{}
		}
		out = append(out, venueCourtOut{ID: c.ID, Name: c.Name, ColorKey: c.ColorKey, HeldBy: names})
	}
	return out, nil
}

func addCourt(ctx context.Context, d *core.Deps, in addCourtIn) (noteOut, error) {
	name := cleanText(in.Name, 24)
	if name == "" {
		return refuse(`Give the court a name — "Court 5", or whatever it is called.`), nil
	}
	// Every court, taken-out ones included: a name that is free on screen may
	// still belong to a court that was removed, and that court comes back
	// rather than a second row being made beside it.
	all, err := store.VenueCourts(ctx, d.DB, d.Venue.ID, false)
	if err != nil {
		return noteOut{}, err
	}
	var same *store.Court
	active := 0
	for i := range all {
		if all[i].Active {
			active++
		}
		if same == nil && strings.EqualFold(all[i].Name, name) {
			same = &all[i]
		}
	}
	if same != nil && same.Active {
		return refuse("There is already a " + same.Name + "."), nil
	}
	if same != nil {
		// A court that was taken out and is wanted back keeps its history.
		if _, err := d.DB.ExecContext(ctx, `update courts set active = true, name = $2 where id = $1`, same.ID, name); err != nil {
			return noteOut{}, err
		}
		if err := core.Audit(ctx, d.DB, actor(ctx), "court.add", "court", same.ID, "", map[string]string{"name": name}); err != nil {
			return noteOut{}, err
		}
		return note(name + " is in."), nil
	}
	sortOrder := 0
	if len(all) > 0 {
		sortOrder = all[len(all)-1].SortOrder + 1
	}
	id := ids.New("crt")
	if _, err := d.DB.ExecContext(ctx,
		`insert into courts (id, venue_id, name, sort_order, color_key) values ($1, $2, $3, $4, $5)`,
		id, d.Venue.ID, name, sortOrder, colourKeys[active%len(colourKeys)]); err != nil {
		return noteOut{}, err
	}
	if err := core.Audit(ctx, d.DB, actor(ctx), "court.add", "court", id, "", map[string]string{"name": name}); err != nil {
		return noteOut{}, err
	}
	return note(name + " is in."), nil
}

func renameCourt(ctx context.Context, d *core.Deps, in renameCourtIn) (noteOut, error) {
	name := cleanText(in.Name, 24)
	if name == "" {
		return refuse("A court needs a name."), nil
	}
	all, err := store.VenueCourts(ctx, d.DB, d.Venue.ID, false)
	if err != nil {
		return noteOut{}, err
	}
	found := false
	for _, c := range all {
		if c.ID == in.CourtID {
			found = true
			continue
		}
		// Taken-out courts count too: bringing one back by this name would
		// otherwise make two courts nobody can tell apart.
		if strings.EqualFold(c.Name, name) {
			return refuse("There is already a " + name + "."), nil
		}
	}
	if !found {
		return refuse("That court is not at this venue."), nil
	}
	// The name changes on the board, the public page and every past result at
	// once — the court is the row, not its name.
	if _, err := d.DB.ExecContext(ctx, `update courts set name = $3 where id = $1 and venue_id = $2`,
		in.CourtID, d.Venue.ID, name); err != nil {
		return noteOut{}, err
	}
	if err := core.Audit(ctx, d.DB, actor(ctx), "court.rename", "court", in.CourtID, "", map[string]string{"name": name}); err != nil {
		return noteOut{}, err
	}
	return note("Renamed."), nil
}

// removeCourt is soft: `active` goes false and everything played on it stays
// on the record. Not while a match is on it, and not while a tournament from
// today on is counting on it — the organiser takes it off that tournament
// first, so nothing loses a court by surprise.
func removeCourt(ctx context.Context, d *core.Deps, in courtIDIn) (noteOut, error) {
	var live sql.NullString
	err := d.DB.QueryRowContext(ctx,
		`select id from matches where court_id = $1 and status = 'live' limit 1`, in.CourtID).Scan(&live)
	if err != nil && err != sql.ErrNoRows {
		return noteOut{}, err
	}
	if live.Valid {
		return refuse("There is a match on it right now."), nil
	}
	courts, err := venueCourts(ctx, d)
	if err != nil {
		return noteOut{}, err
	}
	var mine *venueCourtOut
	for i := range courts {
		if courts[i].ID == in.CourtID {
			mine = &courts[i]
		}
	}
	if mine == nil {
		return refuse("That court is not at this venue."), nil
	}
	if len(mine.HeldBy) > 0 {
		return refuse(mine.Name + " belongs to " + strings.Join(mine.HeldBy, " and ") +
			". Take it off there first, under Schedule & courts."), nil
	}
	if len(courts) <= 1 {
		return refuse("A venue needs at least one court."), nil
	}
	if _, err := d.DB.ExecContext(ctx, `update courts set active = false where id = $1 and venue_id = $2`,
		in.CourtID, d.Venue.ID); err != nil {
		return noteOut{}, err
	}
	if err := core.Audit(ctx, d.DB, actor(ctx), "court.remove", "court", in.CourtID, "", nil); err != nil {
		return noteOut{}, err
	}
	return note("Taken out. Add it again any time and it comes back with its history."), nil
}
