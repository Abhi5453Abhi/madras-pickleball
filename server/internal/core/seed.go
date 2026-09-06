package core

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"time"

	"mpb/internal/ids"
	"mpb/internal/pin"
)

// TempPIN is what a fresh install's organiser signs in with the first time;
// it must be replaced before anything else opens.
const TempPIN = "123456"

var courtColours = []string{"blue", "orange", "teal", "violet"}

// Seed makes sure the venue, its four courts and one owner exist. Safe to
// run at every start; it only fills in what is missing. Returns the venue.
func Seed(ctx context.Context, d *sql.DB) (Venue, error) {
	var v Venue
	err := d.QueryRowContext(ctx, `select id, name, slug from venues order by created_at limit 1`).
		Scan(&v.ID, &v.Name, &v.Slug)
	if errors.Is(err, sql.ErrNoRows) {
		v = Venue{ID: ids.New("ven"), Name: "Madras Pickleball", Slug: "madras-pickleball"}
		if _, err := d.ExecContext(ctx, `insert into venues (id, name, slug) values ($1, $2, $3)`, v.ID, v.Name, v.Slug); err != nil {
			return v, err
		}
	} else if err != nil {
		return v, err
	}
	v.Location = IST

	var courtCount int
	if err := d.QueryRowContext(ctx, `select count(*) from courts where venue_id = $1`, v.ID).Scan(&courtCount); err != nil {
		return v, err
	}
	if courtCount == 0 {
		for i, colour := range courtColours {
			if _, err := d.ExecContext(ctx,
				`insert into courts (id, venue_id, name, sort_order, color_key) values ($1, $2, $3, $4, $5)`,
				ids.New("crt"), v.ID, "Court "+string(rune('1'+i)), i, colour); err != nil {
				return v, err
			}
		}
	}

	var userCount int
	if err := d.QueryRowContext(ctx, `select count(*) from users`).Scan(&userCount); err != nil {
		return v, err
	}
	if userCount == 0 {
		// One owner. The PIN is the whole credential: a fixed temporary one
		// that must be replaced on first sign-in, or the one the deployment
		// sets in MPB_SEED_PIN.
		p := os.Getenv("MPB_SEED_PIN")
		mustChange := true
		if pin.Normalize(p) == "" {
			p = TempPIN
		} else {
			p = pin.Normalize(p)
			mustChange = false
		}
		hash, err := pin.Hash(p)
		if err != nil {
			return v, err
		}
		if _, err := d.ExecContext(ctx,
			`insert into users (id, name, username, role, pin_hash, must_change_pin, created_at)
			 values ($1, 'Organiser', 'organiser', 'owner', $2, $3, $4)`,
			ids.New("usr"), hash, mustChange, time.Now()); err != nil {
			return v, err
		}
	}
	return v, nil
}
