package setup

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"mpb/internal/core"
	"mpb/internal/engine"
	"mpb/internal/ids"
	"mpb/internal/rpc"
	"mpb/internal/store"
)

// Teams — SPEC v4.
//
// Doubles only; singles skips the step. Two people who named each other are a
// pair the moment the screen loads. Everyone else the organiser pairs by hand
// or at random, and can split and re-make until the schedule exists. After
// that the pairs are the draw, and changing them is a fix under More.

// lockedMessage is what every refusal after the start says, verbatim.
const lockedMessage = "The tournament has started. Changing a pair is under More."

type boardPlayer struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type boardPair struct {
	TeamID  string        `json:"teamId"`
	Name    string        `json:"name"`
	Players []boardPlayer `json:"players"`
	How     string        `json:"how"` // mutual | organiser
}

type boardUnpaired struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	WishText       *string `json:"wishText"`
	WishPlayerName *string `json:"wishPlayerName"`
	Note           *string `json:"note"`
}

type teamBoardOut struct {
	Discipline string          `json:"discipline"`
	Pairs      []boardPair     `json:"pairs"`
	Unpaired   []boardUnpaired `json:"unpaired"`
	Needed     int             `json:"needed"`
	Locked     bool            `json:"locked"`
}

type tournamentIDIn struct {
	TournamentID string `json:"tournamentId"`
}

type pairWithIn struct {
	TournamentID string `json:"tournamentId"`
	PlayerA      string `json:"playerA"`
	PlayerB      string `json:"playerB"`
}

type pairWithOut struct {
	OK     bool   `json:"ok"`
	TeamID string `json:"teamId,omitempty"`
	Error  string `json:"error,omitempty"`
}

type splitTeamIn struct {
	TournamentID string `json:"tournamentId"`
	TeamID       string `json:"teamId"`
}

type pairRestOut struct {
	OK     bool         `json:"ok"`
	Made   int          `json:"made"`
	OddOut *boardPlayer `json:"oddOut"`
	Error  string       `json:"error,omitempty"`
}

func registerTeams(reg *rpc.Registry, d *core.Deps) {
	rpc.Register(reg, "teams.teamBoard", rpc.Organiser,
		func(ctx context.Context, in tournamentIDIn) (teamBoardOut, error) { return teamBoard(ctx, d, in) })

	rpc.Register(reg, "teams.pairWith", rpc.Organiser,
		func(ctx context.Context, in pairWithIn) (pairWithOut, error) { return pairWith(ctx, d, in) })

	rpc.Register(reg, "teams.splitTeam", rpc.Organiser,
		func(ctx context.Context, in splitTeamIn) (okErrOut, error) { return splitTeam(ctx, d, in) })

	rpc.Register(reg, "teams.pairRestRandomly", rpc.Organiser,
		func(ctx context.Context, in tournamentIDIn) (pairRestOut, error) { return pairRestRandomly(ctx, d, in) })
}

// ── settling what needs no organiser ──────────────────────────────────────

// settlePlan is the housekeeping one load's worth of state asks for:
//
//   - a pair with a member who has since left is undone, so the one still in
//     goes back to the pile rather than sitting in a team of one;
//   - two people in the pile who named each other become a pair;
//   - in singles, every player gets a team of one, because the schedule is
//     built from teams.
//
// Worked out from a read so the common case — nothing to do — costs no lock.
type settlePlan struct {
	drop []string         // team ids to delete
	make [][]store.Player // new teams, members in order
}

func (p settlePlan) empty() bool { return len(p.drop) == 0 && len(p.make) == 0 }

func planSettle(t *store.Tournament, roster []store.TournamentPlayer, teams []store.Team) settlePlan {
	inRoster := map[string]store.Player{}
	for _, r := range roster {
		inRoster[r.Player.ID] = r.Player
	}
	size := teamSizeOf(t)

	var plan settlePlan
	dropped := map[string]bool{}
	for _, tm := range teams {
		broken := len(tm.Players) != size
		for _, p := range tm.Players {
			if _, ok := inRoster[p.ID]; !ok {
				broken = true
			}
		}
		if broken {
			plan.drop = append(plan.drop, tm.ID)
			dropped[tm.ID] = true
		}
	}

	paired := map[string]bool{}
	for _, tm := range teams {
		if dropped[tm.ID] {
			continue
		}
		for _, p := range tm.Players {
			paired[p.ID] = true
		}
	}

	if size == 1 {
		// Singles: a team of one each, named after them.
		for _, r := range roster {
			if !paired[r.Player.ID] {
				plan.make = append(plan.make, []store.Player{r.Player})
				paired[r.Player.ID] = true
			}
		}
		return plan
	}

	// Doubles: two people who named each other are a pair, and nobody's
	// business but their own.
	wish := map[string]string{}
	for _, r := range roster {
		if r.PartnerPlayerID != nil {
			wish[r.Player.ID] = *r.PartnerPlayerID
		}
	}
	for _, r := range roster {
		me := r.Player.ID
		if paired[me] {
			continue
		}
		them, ok := wish[me]
		if !ok {
			continue
		}
		other, onList := inRoster[them]
		if !onList || paired[them] || wish[them] != me {
			continue
		}
		paired[me] = true
		paired[them] = true
		plan.make = append(plan.make, []store.Player{r.Player, other})
	}
	return plan
}

// insertTeam writes one pair. Names are unique per tournament, which two
// players called Ravi in a singles draw would otherwise trip over; seeds are
// the order the pairs were made. Returns "" when a member was paired from
// another phone between the read and the write.
func insertTeam(ctx context.Context, tx *sql.Tx, tournamentID string, members []store.Player) (string, error) {
	if len(members) == 0 {
		return "", nil
	}
	ids_ := make([]string, len(members))
	for i, m := range members {
		ids_[i] = m.ID
	}
	args := append([]any{tournamentID}, toAny(ids_)...)
	var already sql.NullString
	err := tx.QueryRowContext(ctx, `
		select tp.team_id from team_players tp join teams t on t.id = tp.team_id
		where t.tournament_id = $1 and tp.player_id in (`+store.Placeholders(2, len(ids_))+`) limit 1`, args...).
		Scan(&already)
	if err != nil && err != sql.ErrNoRows {
		return "", err
	}
	if already.Valid {
		return "", nil
	}

	var maxSeed int
	if err := tx.QueryRowContext(ctx,
		`select coalesce(max(seed), 0) from teams where tournament_id = $1`, tournamentID).Scan(&maxSeed); err != nil {
		return "", err
	}
	taken := map[string]bool{}
	rows, err := tx.QueryContext(ctx, `select name from teams where tournament_id = $1`, tournamentID)
	if err != nil {
		return "", err
	}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			rows.Close()
			return "", err
		}
		taken[n] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return "", err
	}

	// Team names are generated — "Ravi Kumar / Priya S" — never asked for.
	names := make([]string, len(members))
	for i, m := range members {
		names[i] = m.Name
	}
	base := strings.Join(names, " / ")
	name := base
	for n := 2; taken[name]; n++ {
		name = fmt.Sprintf("%s (%d)", base, n)
	}

	id := ids.New("tm")
	// clock_timestamp(), not the column's default: now() is the TRANSACTION's
	// time, and four pairs made at random in one go would all share it — which
	// is the order of the table's last-resort dead heat and of the draw's
	// seeding, so it must be the order they were actually made in.
	if _, err := tx.ExecContext(ctx,
		`insert into teams (id, tournament_id, name, seed, created_at) values ($1, $2, $3, $4, clock_timestamp())`,
		id, tournamentID, name, maxSeed+1); err != nil {
		return "", err
	}
	for pos, m := range members {
		if _, err := tx.ExecContext(ctx,
			`insert into team_players (team_id, player_id, position) values ($1, $2, $3)`,
			id, m.ID, pos); err != nil {
			return "", err
		}
	}
	return id, nil
}

func toAny(ss []string) []any {
	out := make([]any, len(ss))
	for i, s := range ss {
		out[i] = s
	}
	return out
}

func applySettle(ctx context.Context, tx *sql.Tx, plan settlePlan, tournamentID string) error {
	for _, id := range plan.drop {
		if _, err := tx.ExecContext(ctx, `delete from teams where id = $1 and tournament_id = $2`, id, tournamentID); err != nil {
			return err
		}
	}
	for _, members := range plan.make {
		if _, err := insertTeam(ctx, tx, tournamentID, members); err != nil {
			return err
		}
	}
	return nil
}

// settleTeams runs the housekeeping inside a transaction that already holds
// the tournament row. A no-op once the schedule exists — after the start a
// changed pair is a swap, under More.
func settleTeams(ctx context.Context, tx *sql.Tx, d *core.Deps, t *store.Tournament) (bool, error) {
	if isLocked(t) {
		return false, nil
	}
	roster, err := store.Roster(ctx, tx, t.ID)
	if err != nil {
		return false, err
	}
	teams, err := store.Teams(ctx, tx, t.ID)
	if err != nil {
		return false, err
	}
	plan := planSettle(t, roster, teams)
	if plan.empty() {
		return false, nil
	}
	if err := applySettle(ctx, tx, plan, t.ID); err != nil {
		return false, err
	}
	return true, core.Bump(ctx, tx, t.ID)
}

// settleIfNeeded is the read path's version: the hub and the Teams screen
// settle on the way in, and the common case — nothing to settle — must not
// cost a row lock on every page load.
func settleIfNeeded(ctx context.Context, d *core.Deps, t *store.Tournament) error {
	if isLocked(t) {
		return nil
	}
	roster, err := store.Roster(ctx, d.DB, t.ID)
	if err != nil {
		return err
	}
	teams, err := store.Teams(ctx, d.DB, t.ID)
	if err != nil {
		return err
	}
	if planSettle(t, roster, teams).empty() {
		return nil
	}
	return d.Tx(ctx, func(tx *sql.Tx) error {
		locked, err := lockTournament(ctx, tx, d, t.ID)
		if err != nil {
			return err
		}
		_, err = settleTeams(ctx, tx, d, locked)
		return err
	})
}

// ── the board ─────────────────────────────────────────────────────────────

// describeWish is the grey phrase on the right of somebody still in the pile.
// It answers the one question the organiser has reading the row: why isn't
// this person paired yet? Null means there is nothing to explain — they named
// nobody, or named someone who never signed up — and the row offers
// "Pair with…".
func describeWish(p store.TournamentPlayer, byID map[string]store.TournamentPlayer, paired map[string]bool) (*string, *string) {
	if p.PartnerPlayerID == nil {
		return nil, nil
	}
	q, ok := byID[*p.PartnerPlayerID]
	if !ok {
		return nil, nil
	}
	name := q.Player.Name
	var note string
	switch {
	case paired[q.Player.ID]:
		note = firstName(name) + " is paired already"
	case q.PartnerPlayerID != nil && *q.PartnerPlayerID == p.Player.ID:
		note = "✓ mutual"
	default:
		if q.PartnerPlayerID != nil {
			if r, ok := byID[*q.PartnerPlayerID]; ok {
				note = firstName(name) + " named " + firstName(r.Player.Name)
				break
			}
		}
		if q.PartnerWish != nil && *q.PartnerWish != "" {
			note = firstName(name) + " named " + *q.PartnerWish
			break
		}
		// "not mutual" read as if he wanted somebody else. He named nobody,
		// which is the one case where the wish can simply be granted.
		note = firstName(name) + " named nobody"
	}
	return &name, &note
}

func teamBoard(ctx context.Context, d *core.Deps, in tournamentIDIn) (teamBoardOut, error) {
	t, err := mustTournament(ctx, d, d.DB, in.TournamentID)
	if err != nil {
		return teamBoardOut{}, err
	}
	if err := settleIfNeeded(ctx, d, t); err != nil {
		return teamBoardOut{}, err
	}
	return buildTeamBoard(ctx, d.DB, t)
}

func buildTeamBoard(ctx context.Context, q core.Querier, t *store.Tournament) (teamBoardOut, error) {
	roster, err := store.Roster(ctx, q, t.ID)
	if err != nil {
		return teamBoardOut{}, err
	}
	teams, err := store.Teams(ctx, q, t.ID)
	if err != nil {
		return teamBoardOut{}, err
	}

	byID := map[string]store.TournamentPlayer{}
	for _, r := range roster {
		byID[r.Player.ID] = r
	}
	// Members of any team, withdrawn ones included: a pair that has withdrawn
	// is out of the day, not back in the pile.
	paired := map[string]bool{}
	for _, tm := range teams {
		for _, p := range tm.Players {
			paired[p.ID] = true
		}
	}

	pairs := []boardPair{}
	for _, tm := range teams {
		if tm.Status == "withdrawn" {
			continue
		}
		members := make([]boardPlayer, 0, len(tm.Players))
		for _, p := range tm.Players {
			members = append(members, boardPlayer{ID: p.ID, Name: p.Name})
		}
		how := "organiser"
		if len(tm.Players) == 2 {
			a, aok := byID[tm.Players[0].ID]
			b, bok := byID[tm.Players[1].ID]
			if aok && bok && a.PartnerPlayerID != nil && *a.PartnerPlayerID == b.Player.ID &&
				b.PartnerPlayerID != nil && *b.PartnerPlayerID == a.Player.ID {
				how = "mutual"
			}
		}
		pairs = append(pairs, boardPair{TeamID: tm.ID, Name: tm.Name, Players: members, How: how})
	}

	unpaired := []boardUnpaired{}
	for _, r := range roster {
		if paired[r.Player.ID] {
			continue
		}
		wishName, note := describeWish(r, byID, paired)
		unpaired = append(unpaired, boardUnpaired{
			ID: r.Player.ID, Name: r.Player.Name,
			WishText: r.PartnerWish, WishPlayerName: wishName, Note: note,
		})
	}

	needed := len(roster)
	if teamSizeOf(t) == 2 {
		needed = len(roster) / 2
	}
	return teamBoardOut{
		Discipline: t.Discipline,
		Pairs:      pairs,
		Unpaired:   unpaired,
		Needed:     needed,
		Locked:     isLocked(t),
	}, nil
}

// ── the three things the organiser can do to pairs ────────────────────────

// doublesGate is the two refusals every pair-changing action starts with.
func doublesGate(t *store.Tournament) string {
	if t.Discipline == "singles" {
		return "Singles has no pairs to make."
	}
	if isLocked(t) {
		return lockedMessage
	}
	return ""
}

// dropStaleDraw — a schedule made before the pairs changed is wrong from the
// first row. It goes, and the hub's Schedule step asks for it again.
func dropStaleDraw(ctx context.Context, tx *sql.Tx, tournamentID string) error {
	var any sql.NullString
	err := tx.QueryRowContext(ctx, `select id from matches where tournament_id = $1 limit 1`, tournamentID).Scan(&any)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if !any.Valid {
		return nil
	}
	return clearDraw(ctx, tx, tournamentID)
}

func pairWith(ctx context.Context, d *core.Deps, in pairWithIn) (pairWithOut, error) {
	var out pairWithOut
	err := d.Tx(ctx, func(tx *sql.Tx) error {
		t, err := lockTournament(ctx, tx, d, in.TournamentID)
		if err != nil {
			return err
		}
		if msg := doublesGate(t); msg != "" {
			out = pairWithOut{Error: msg}
			return nil
		}
		if in.PlayerA == "" || in.PlayerB == "" || in.PlayerA == in.PlayerB {
			out = pairWithOut{Error: "Pick two different people."}
			return nil
		}
		roster, err := store.Roster(ctx, tx, t.ID)
		if err != nil {
			return err
		}
		byID := map[string]store.Player{}
		for _, r := range roster {
			byID[r.Player.ID] = r.Player
		}
		a, aok := byID[in.PlayerA]
		b, bok := byID[in.PlayerB]
		if !aok || !bok {
			out = pairWithOut{Error: "One of them is no longer on the list."}
			return nil
		}
		teams, err := store.Teams(ctx, tx, t.ID)
		if err != nil {
			return err
		}
		for _, tm := range teams {
			for _, p := range tm.Players {
				if p.ID == a.ID || p.ID == b.ID {
					out = pairWithOut{Error: p.Name + " is in a pair already. Split it first."}
					return nil
				}
			}
		}
		// The schedule points at the pairs; a changed pair takes it with it.
		if err := dropStaleDraw(ctx, tx, t.ID); err != nil {
			return err
		}
		id, err := insertTeam(ctx, tx, t.ID, []store.Player{a, b})
		if err != nil {
			return err
		}
		if id == "" {
			out = pairWithOut{Error: "One of them is in a pair already. Split it first."}
			return nil
		}
		if err := core.Audit(ctx, tx, actor(ctx), "team.paired", "team", id, "",
			map[string]any{"players": []string{a.ID, b.ID}}); err != nil {
			return err
		}
		out = pairWithOut{OK: true, TeamID: id}
		return core.Bump(ctx, tx, t.ID)
	})
	if err != nil {
		return pairWithOut{}, err
	}
	return out, nil
}

func splitTeam(ctx context.Context, d *core.Deps, in splitTeamIn) (okErrOut, error) {
	var out okErrOut
	err := d.Tx(ctx, func(tx *sql.Tx) error {
		t, err := lockTournament(ctx, tx, d, in.TournamentID)
		if err != nil {
			return err
		}
		if msg := doublesGate(t); msg != "" {
			out = okErrOut{Error: msg}
			return nil
		}
		var id string
		err = tx.QueryRowContext(ctx, `select id from teams where id = $1 and tournament_id = $2`,
			in.TeamID, t.ID).Scan(&id)
		if err == sql.ErrNoRows {
			out = okErrOut{Error: "That pair is already gone."}
			return nil
		}
		if err != nil {
			return err
		}
		if err := dropStaleDraw(ctx, tx, t.ID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `delete from teams where id = $1`, id); err != nil {
			return err
		}
		if err := core.Audit(ctx, tx, actor(ctx), "team.split", "team", id, "", nil); err != nil {
			return err
		}
		out = okErrOut{OK: true}
		return core.Bump(ctx, tx, t.ID)
	})
	if err != nil {
		return okErrOut{}, err
	}
	return out, nil
}

func pairRestRandomly(ctx context.Context, d *core.Deps, in tournamentIDIn) (pairRestOut, error) {
	var out pairRestOut
	err := d.Tx(ctx, func(tx *sql.Tx) error {
		t, err := lockTournament(ctx, tx, d, in.TournamentID)
		if err != nil {
			return err
		}
		if msg := doublesGate(t); msg != "" {
			out = pairRestOut{Error: msg}
			return nil
		}
		// Mutual pairs first: they are not the organiser's to gamble with.
		if _, err := settleTeams(ctx, tx, d, t); err != nil {
			return err
		}
		roster, err := store.Roster(ctx, tx, t.ID)
		if err != nil {
			return err
		}
		teams, err := store.Teams(ctx, tx, t.ID)
		if err != nil {
			return err
		}
		paired := map[string]bool{}
		for _, tm := range teams {
			for _, p := range tm.Players {
				paired[p.ID] = true
			}
		}
		var pile []store.Player
		for _, r := range roster {
			if !paired[r.Player.ID] {
				pile = append(pile, r.Player)
			}
		}
		if len(pile) == 0 {
			out = pairRestOut{Error: "Everyone is paired."}
			return nil
		}
		if len(pile) == 1 {
			out = pairRestOut{Error: "Only " + pile[0].Name + " is left — there is nobody to pair them with."}
			return nil
		}

		byID := map[string]store.Player{}
		pileIDs := make([]string, 0, len(pile))
		for _, p := range pile {
			byID[p.ID] = p
			pileIDs = append(pileIDs, p.ID)
		}
		// A fresh seed each time: the organiser who taps it again is asking
		// for a different answer, not the same one.
		groups := engine.PairRandomly(pileIDs, ids.New("seed"), 2)
		used := map[string]bool{}
		for _, g := range groups {
			for _, id := range g {
				used[id] = true
			}
		}
		var odd *boardPlayer
		for _, p := range pile {
			if !used[p.ID] {
				odd = &boardPlayer{ID: p.ID, Name: p.Name}
				break
			}
		}

		if len(groups) > 0 {
			if err := dropStaleDraw(ctx, tx, t.ID); err != nil {
				return err
			}
		}
		made := 0
		for _, g := range groups {
			members := make([]store.Player, 0, len(g))
			for _, id := range g {
				members = append(members, byID[id])
			}
			id, err := insertTeam(ctx, tx, t.ID, members)
			if err != nil {
				return err
			}
			if id != "" {
				made++
			}
		}
		if err := core.Audit(ctx, tx, actor(ctx), "teams.paired_randomly", "tournament", t.ID, "",
			map[string]any{"made": made}); err != nil {
			return err
		}
		out = pairRestOut{OK: true, Made: made, OddOut: odd}
		return core.Bump(ctx, tx, t.ID)
	})
	if err != nil {
		return pairRestOut{}, err
	}
	return out, nil
}
