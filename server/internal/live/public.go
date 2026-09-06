package live

// Public reads — the share link and the venue's "Today" page, ported from
// app/src/server/public.ts.
//
// Everything here is built by explicit mappers, never from a raw row: phone
// numbers are organiser-only, and that is how they stay unleaked. Nothing in
// this file reads a cookie.

import (
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"net/http"
	"strings"

	"mpb/internal/core"
	"mpb/internal/engine"
	"mpb/internal/rpc"
	"mpb/internal/store"
)

// ── the venue's day ───────────────────────────────────────────────────────

type todayLive struct {
	NameA    *string  `json:"nameA"`
	PlayersA []string `json:"playersA"`
	NameB    *string  `json:"nameB"`
	PlayersB []string `json:"playersB"`
}

type todayHolder struct {
	Name string `json:"name"`
	Slug string `json:"slug"`
}

type todayCourt struct {
	ID         string       `json:"id"`
	Name       string       `json:"name"`
	ColorKey   string       `json:"colorKey"`
	Tournament *todayHolder `json:"tournament"`
	Live       *todayLive   `json:"live"`
}

type todayTournament struct {
	Slug             string  `json:"slug"`
	Name             string  `json:"name"`
	Day              string  `json:"day"`
	Status           string  `json:"status"`
	PauseNote        *string `json:"pauseNote"`
	RegistrationOpen bool    `json:"registrationOpen"`
}

type publicTodayOut struct {
	Courts   []todayCourt      `json:"courts"`
	Today    []todayTournament `json:"today"`
	Upcoming []todayTournament `json:"upcoming"`
	Version  string            `json:"version"`
}

// todaySets splits the venue's tournaments into what is on today and what is
// coming. "Today" is anything dated today at the venue, plus anything still
// running whatever its date — a day that ran past midnight is still the day.
func todaySets(ctx context.Context, q core.Querier, d *core.Deps) (today, upcoming []*store.Tournament, err error) {
	rows, err := q.QueryContext(ctx, `
		select `+tournamentColumns+` from tournaments
		where venue_id = $1 and deleted_at is null order by day, created_at, id`, d.Venue.ID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	all, err := scanTournaments(rows)
	if err != nil {
		return nil, nil, err
	}
	todayKey := core.DayKey(d.Now())
	for _, t := range all {
		switch {
		case t.Day == todayKey || t.Status == "live":
			today = append(today, t)
		case t.Day > todayKey && len(upcoming) < 3:
			upcoming = append(upcoming, t)
		}
	}
	return today, upcoming, nil
}

func toTodayTournament(t *store.Tournament) todayTournament {
	return todayTournament{
		Slug: t.Slug, Name: t.Name, Day: t.Day, Status: t.Status, PauseNote: t.PauseNote,
		RegistrationOpen: t.Status == "setup" && t.RegistrationClosedAt == nil,
	}
}

// publicToday — every court, who holds it, what is on it, and a link to each
// tournament. Someone at the gate sees EVERY court regardless of which
// tournament it belongs to.
func publicToday(ctx context.Context, d *core.Deps) (*publicTodayOut, error) {
	courtRows, err := store.VenueCourts(ctx, d.DB, d.Venue.ID, true)
	if err != nil {
		return nil, err
	}
	today, upcoming, err := todaySets(ctx, d.DB, d)
	if err != nil {
		return nil, err
	}

	byID := map[string]*store.Tournament{}
	ids := make([]string, 0, len(today))
	for _, t := range today {
		byID[t.ID] = t
		ids = append(ids, t.ID)
	}
	held, err := heldCourts(ctx, d.DB, ids)
	if err != nil {
		return nil, err
	}
	// A finished tournament has let go of its courts — the same rule the
	// organiser's court picker uses.
	holderOf := map[string]*store.Tournament{}
	for tournamentID, courts := range held {
		t := byID[tournamentID]
		if t == nil || t.Status == "completed" {
			continue
		}
		for _, c := range courts {
			holderOf[c] = t
		}
	}

	// What is on each court right now, and who is in it.
	liveByCourt := map[string]*store.Match{}
	teamNames := map[string]string{}
	members := map[string][]string{}
	for _, t := range today {
		matches, err := store.Matches(ctx, d.DB, t.ID)
		if err != nil {
			return nil, err
		}
		anyLive := false
		for _, m := range matches {
			if m.Status == "live" && m.CourtID != nil {
				liveByCourt[*m.CourtID] = m
				// A live match names the court, and that wins when it disagrees
				// with who holds it, because the match is what a person
				// standing there can see.
				holderOf[*m.CourtID] = t
				anyLive = true
			}
		}
		if !anyLive {
			continue
		}
		teams, err := store.Teams(ctx, d.DB, t.ID)
		if err != nil {
			return nil, err
		}
		for _, tm := range teams {
			teamNames[tm.ID] = tm.Name
			names := make([]string, 0, len(tm.Players))
			for _, p := range tm.Players {
				names = append(names, p.Name)
			}
			members[tm.ID] = names
		}
	}

	out := &publicTodayOut{Courts: []todayCourt{}, Today: []todayTournament{}, Upcoming: []todayTournament{}}
	for _, c := range courtRows {
		tc := todayCourt{ID: c.ID, Name: c.Name, ColorKey: c.ColorKey}
		if t := holderOf[c.ID]; t != nil {
			tc.Tournament = &todayHolder{Name: t.Name, Slug: t.Slug}
		}
		if m, ok := liveByCourt[c.ID]; ok {
			live := &todayLive{PlayersA: []string{}, PlayersB: []string{}}
			if m.TeamAID != nil {
				if n, ok := teamNames[*m.TeamAID]; ok {
					live.NameA = strp(n)
				}
				live.PlayersA = append(live.PlayersA, members[*m.TeamAID]...)
			}
			if m.TeamBID != nil {
				if n, ok := teamNames[*m.TeamBID]; ok {
					live.NameB = strp(n)
				}
				live.PlayersB = append(live.PlayersB, members[*m.TeamBID]...)
			}
			tc.Live = live
		}
		out.Courts = append(out.Courts, tc)
	}
	for _, t := range today {
		out.Today = append(out.Today, toTodayTournament(t))
	}
	for _, t := range upcoming {
		out.Upcoming = append(out.Upcoming, toTodayTournament(t))
	}
	// The version the page renders with and the version the poller returns come
	// from one function, or every phone in the venue hard-refreshes every five
	// seconds.
	out.Version, err = todayVersion(ctx, d.DB, d)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ── the share link ────────────────────────────────────────────────────────

type publicMatch struct {
	ID         string   `json:"id"`
	Stage      string   `json:"stage"`
	RoundName  *string  `json:"roundName"`
	TeamAID    *string  `json:"teamAId"`
	TeamBID    *string  `json:"teamBId"`
	NameA      *string  `json:"nameA"`
	NameB      *string  `json:"nameB"`
	PlayersA   []string `json:"playersA"`
	PlayersB   []string `json:"playersB"`
	CourtID    *string  `json:"courtId"`
	CourtName  *string  `json:"courtName"`
	CourtColor *string  `json:"courtColor"`
	Status     string   `json:"status"`
	State      string   `json:"state"`
	GamesWonA  int      `json:"gamesWonA"`
	GamesWonB  int      `json:"gamesWonB"`
	WinnerSide *string  `json:"winnerSide"`
	ScoreLine  *string  `json:"scoreLine"`
	StartedAt  *string  `json:"startedAt"`
	EndedAt    *string  `json:"endedAt"`
	ResultType string   `json:"resultType"`
}

type publicTableRow struct {
	TeamID string `json:"teamId"`
	// Group is the pool this row belongs to — "Pool A" — or null when the
	// tournament is one league. The page draws one table per pool.
	Group     *string  `json:"group"`
	Name      string   `json:"name"`
	Players   []string `json:"players"`
	Won       int      `json:"won"`
	PointsFor int      `json:"pointsFor"`
	Withdrawn bool     `json:"withdrawn"`
	Note      *string  `json:"note"`
}

type publicCourt struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type publicTournamentInfo struct {
	Name                 string  `json:"name"`
	Day                  string  `json:"day"`
	Status               string  `json:"status"`
	PauseNote            *string `json:"pauseNote"`
	RegistrationClosedAt *string `json:"registrationClosedAt"`
	UpdatedAt            string  `json:"updatedAt"`
}

type publicTournamentOut struct {
	Tournament  publicTournamentInfo `json:"tournament"`
	Discipline  string               `json:"discipline"`
	FinalsStage string               `json:"finalsStage"`
	Cut         int                  `json:"cut"`
	Courts      []publicCourt        `json:"courts"`
	Players     []string             `json:"players"`
	Matches     []publicMatch        `json:"matches"`
	Table       []publicTableRow     `json:"table"`
	Version     string               `json:"version"`
}

func publicTournament(ctx context.Context, d *core.Deps, slug string) (*publicTournamentOut, error) {
	t, err := store.TournamentBySlug(ctx, d.DB, d.Venue.ID, slug)
	if err != nil {
		// An unpublished tournament is not public, and its existence is not
		// either.
		return nil, rpc.NotFound("No such tournament.")
	}
	teams, err := store.Teams(ctx, d.DB, t.ID)
	if err != nil {
		return nil, err
	}
	matches, err := store.Matches(ctx, d.DB, t.ID)
	if err != nil {
		return nil, err
	}
	courts, err := tournamentCourts(ctx, d.DB, t.ID)
	if err != nil {
		return nil, err
	}
	roster, err := store.Roster(ctx, d.DB, t.ID)
	if err != nil {
		return nil, err
	}
	names, err := courtNameMap(ctx, d.DB, d.Venue.ID)
	if err != nil {
		return nil, err
	}
	colours := map[string]string{}
	allCourts, err := store.VenueCourts(ctx, d.DB, d.Venue.ID, false)
	if err != nil {
		return nil, err
	}
	for _, c := range allCourts {
		colours[c.ID] = c.ColorKey
	}

	teamName := map[string]string{}
	teamPlayers := map[string][]string{}
	withdrawn := map[string]bool{}
	for _, tm := range teams {
		teamName[tm.ID] = tm.Name
		list := make([]string, 0, len(tm.Players))
		for _, p := range tm.Players {
			list = append(list, p.Name)
		}
		teamPlayers[tm.ID] = list
		withdrawn[tm.ID] = tm.Status == "withdrawn"
	}

	out := &publicTournamentOut{
		Tournament: publicTournamentInfo{
			Name: t.Name, Day: t.Day, Status: t.Status, PauseNote: t.PauseNote,
			RegistrationClosedAt: iso(t.RegistrationClosedAt),
			UpdatedAt:            t.UpdatedAt.UTC().Format("2006-01-02T15:04:05.999999999Z07:00"),
		},
		Discipline: t.Discipline, FinalsStage: t.FinalsStage,
		Courts: []publicCourt{}, Players: []string{}, Matches: []publicMatch{}, Table: []publicTableRow{},
	}
	for _, c := range courts {
		out.Courts = append(out.Courts, publicCourt{ID: c.ID, Name: c.Name})
	}
	// Names only. The roster row has a phone on it and this is the one place it
	// must never come through.
	for _, r := range roster {
		out.Players = append(out.Players, r.Player.Name)
	}

	leagueDone := true
	finalDecided := false
	for _, m := range matches {
		pm := publicMatch{
			ID: m.ID, Stage: m.Stage, RoundName: m.RoundName, TeamAID: m.TeamAID, TeamBID: m.TeamBID,
			CourtID: m.CourtID, Status: m.Status, State: m.ResultState, ResultType: m.ResultType,
			PlayersA: []string{}, PlayersB: []string{},
			StartedAt: iso(m.StartedAt), EndedAt: iso(m.EndedAt),
		}
		if m.TeamAID != nil {
			if n, ok := teamName[*m.TeamAID]; ok {
				pm.NameA = strp(n)
			}
			pm.PlayersA = append(pm.PlayersA, teamPlayers[*m.TeamAID]...)
		}
		if m.TeamBID != nil {
			if n, ok := teamName[*m.TeamBID]; ok {
				pm.NameB = strp(n)
			}
			pm.PlayersB = append(pm.PlayersB, teamPlayers[*m.TeamBID]...)
		}
		if m.CourtID != nil {
			if n, ok := names[*m.CourtID]; ok {
				pm.CourtName = strp(n)
			}
			if c, ok := colours[*m.CourtID]; ok {
				pm.CourtColor = strp(c)
			}
		}
		if m.ResultState == "final" {
			pm.GamesWonA, pm.GamesWonB = m.GamesWonA, m.GamesWonB
			if m.WinnerTeamID != nil {
				switch *m.WinnerTeamID {
				case deref(m.TeamAID):
					pm.WinnerSide = strp("A")
				case deref(m.TeamBID):
					pm.WinnerSide = strp("B")
				}
			}
			// From the winner's side, the way a person says it: "we won 11–7".
			// A walkover prints the word instead — 11–0, 11–0 reads as a
			// thrashing nobody played.
			if len(m.Games) > 0 && m.ResultType != "walkover" {
				parts := make([]string, 0, len(m.Games))
				for _, g := range m.Games {
					if pm.WinnerSide != nil && *pm.WinnerSide == "B" {
						parts = append(parts, fmt.Sprintf("%d–%d", g.ScoreB, g.ScoreA))
					} else {
						parts = append(parts, fmt.Sprintf("%d–%d", g.ScoreA, g.ScoreB))
					}
				}
				pm.ScoreLine = strp(strings.Join(parts, ", "))
			}
		}
		if m.Stage == "group" && m.ResultState == "none" && m.ResultType != "cancelled" {
			// A tie is only "for the organiser" once there is nothing left to
			// play.
			leagueDone = false
		}
		if m.Stage == "knockout" && pm.WinnerSide != nil {
			finalDecided = true
		}
		out.Matches = append(out.Matches, pm)
	}

	// One table per pool, in pool order — two go through from EACH pool, so one
	// merged table put a pair who had qualified below the line. A league is one
	// table and every row's group is null.
	//
	// A pair who pulled out are still in their pool's table — their played
	// matches stand — but the row says so, or it gets argued about at the desk.
	tables, err := store.Tables(ctx, d.DB, t.ID, teams)
	if err != nil {
		return nil, err
	}
	for _, table := range tables {
		var group *string
		if table.Group != "" {
			group = strp(table.Group)
		}
		for _, row := range table.Rows {
			r := publicTableRow{
				TeamID: row.TeamID, Group: group, Name: "—", Players: teamPlayers[row.TeamID],
				Won: row.Won, PointsFor: row.PointsFor, Withdrawn: withdrawn[row.TeamID],
			}
			if n, ok := teamName[row.TeamID]; ok {
				r.Name = n
			}
			if r.Players == nil {
				r.Players = []string{}
			}
			if note := engine.TieNote(row.Reason, leagueDone); note != "" {
				r.Note = strp(note)
			}
			out.Table = append(out.Table, r)
		}
	}

	// Once the final has been played the cut line has done its job. `cut` is how
	// many go through from EACH table, and advance_per_group is what the draw
	// actually built: 0 for a league that ends with the table, 2 out of every
	// pool. Reading the finals stage as well hid the cut line on a pooled
	// tournament whose format says "everyone plays everyone" — eight pairs or
	// more get pools and a knockout whatever the format says.
	if !finalDecided {
		out.Cut = t.AdvancePerGroup
	}
	out.Version, err = tournamentVersion(ctx, d.DB, t)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ── the versions the phones poll ──────────────────────────────────────────
//
// Opaque strings: compare for equality, never order them. Each is composed from
// the `version` counters of the tournaments a page shows plus a signature of
// the courts it draws, because a court added, renamed or taken out changes the
// page without touching any tournament.

// courtSignature is a cheap checksum of the venue's active courts.
func courtSignature(ctx context.Context, q core.Querier, venueID string) (string, error) {
	rows, err := q.QueryContext(ctx,
		`select id, name, color_key, sort_order from courts where venue_id = $1 and active order by sort_order, name`, venueID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	h := fnv.New64a()
	n := 0
	for rows.Next() {
		var id, name, colour string
		var order int
		if err := rows.Scan(&id, &name, &colour, &order); err != nil {
			return "", err
		}
		fmt.Fprintf(h, "%s|%s|%s|%d;", id, name, colour, order)
		n++
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	return fmt.Sprintf("%d.%x", n, h.Sum64()), nil
}

// tournamentCourtSignature is the same, for one tournament's own courts.
func tournamentCourtSignature(ctx context.Context, q core.Querier, tournamentID string) (string, error) {
	rows, err := q.QueryContext(ctx, `
		select c.id, c.name from tournament_courts tc join courts c on c.id = tc.court_id
		where tc.tournament_id = $1 and c.active order by c.sort_order, c.name`, tournamentID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	h := fnv.New64a()
	n := 0
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return "", err
		}
		fmt.Fprintf(h, "%s|%s;", id, name)
		n++
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	return fmt.Sprintf("%d.%x", n, h.Sum64()), nil
}

// todayVersion is one number for the whole day: the tournaments the front door
// shows, their versions, and the venue's courts.
func todayVersion(ctx context.Context, q core.Querier, d *core.Deps) (string, error) {
	today, upcoming, err := todaySets(ctx, q, d)
	if err != nil {
		return "", err
	}
	sum := 0
	for _, t := range today {
		sum += t.Version
	}
	for _, t := range upcoming {
		sum += t.Version
	}
	courts, err := courtSignature(ctx, q, d.Venue.ID)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%d:%d:%s", len(today)+len(upcoming), sum, courts), nil
}

func tournamentVersion(ctx context.Context, q core.Querier, t *store.Tournament) (string, error) {
	courts, err := tournamentCourtSignature(ctx, q, t.ID)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%d:%s", t.Version, courts), nil
}

// ── the RPCs and the version endpoints ────────────────────────────────────

type slugIn struct {
	Slug string `json:"slug"`
}

func registerPublic(mux *http.ServeMux, reg *rpc.Registry, d *core.Deps) {
	rpc.Register(reg, "public.publicToday", rpc.Public,
		func(ctx context.Context, _ struct{}) (*publicTodayOut, error) {
			return publicToday(ctx, d)
		})

	rpc.Register(reg, "public.publicTournament", rpc.Public,
		func(ctx context.Context, in slugIn) (*publicTournamentOut, error) {
			return publicTournament(ctx, d, in.Slug)
		})

	// A few bytes each, polled every five seconds per phone. No cookies are
	// touched on the public two, so a CDN can hold them for a moment.
	mux.HandleFunc("GET /api/version/today", func(w http.ResponseWriter, r *http.Request) {
		v, err := todayVersion(r.Context(), d.DB, d)
		if err != nil {
			d.Log.Error("version/today", "err", err)
			writeVersion(w, http.StatusServiceUnavailable, "", map[string]string{"error": "Try again in a moment."})
			return
		}
		writeVersion(w, http.StatusOK, publicCache, map[string]string{"version": v})
	})

	mux.HandleFunc("GET /api/version/t/{slug}", func(w http.ResponseWriter, r *http.Request) {
		t, err := store.TournamentBySlug(r.Context(), d.DB, d.Venue.ID, r.PathValue("slug"))
		if err != nil {
			writeVersion(w, http.StatusNotFound, publicCache, map[string]string{"error": "No such tournament."})
			return
		}
		v, err := tournamentVersion(r.Context(), d.DB, t)
		if err != nil {
			d.Log.Error("version/t", "err", err)
			writeVersion(w, http.StatusServiceUnavailable, "", map[string]string{"error": "Try again in a moment."})
			return
		}
		writeVersion(w, http.StatusOK, publicCache, map[string]string{"version": v})
	})

	// Organiser only — it says which tournaments are on today. This one is a
	// plain handler, so it checks the session itself.
	mux.HandleFunc("GET /api/version/venue", func(w http.ResponseWriter, r *http.Request) {
		if rpc.UserFrom(r.Context()) == nil {
			writeVersion(w, http.StatusUnauthorized, "", map[string]string{"error": "Sign in first."})
			return
		}
		v, err := venueVersion(r.Context(), d.DB, d)
		if err != nil {
			d.Log.Error("version/venue", "err", err)
			writeVersion(w, http.StatusServiceUnavailable, "", map[string]string{"error": "Try again in a moment."})
			return
		}
		writeVersion(w, http.StatusOK, "", map[string]string{"version": v})
	})
}

const publicCache = "public, s-maxage=2, stale-while-revalidate=10"

func writeVersion(w http.ResponseWriter, status int, cache string, body map[string]string) {
	if cache == "" {
		cache = "no-store"
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", cache)
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body) //nolint:errcheck
}
