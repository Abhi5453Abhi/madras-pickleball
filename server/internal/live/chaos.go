package live

// The things that actually go wrong — SPEC A7, ported from
// app/src/server/chaos.ts.
//
// Not edge cases. On any given Sunday somebody's knee goes, somebody's partner
// is stuck on the ECR, and the light fails at six. A tournament tool that can
// only record a day that went to plan is a toy, and the organiser goes back to
// the WhatsApp group and a notebook.
//
// Every one of these is reversible, every one is attributed, and every one
// writes a sentence a person can read six weeks later.

import (
	"context"
	"database/sql"
	"sort"
	"strings"

	"mpb/internal/core"
	"mpb/internal/engine"
	"mpb/internal/rpc"
	"mpb/internal/store"
)

type teamIn struct {
	TournamentID string `json:"tournamentId"`
	TeamID       string `json:"teamId"`
}

type tournamentIn struct {
	TournamentID string `json:"tournamentId"`
}

// ── who's pulled out ──────────────────────────────────────────────────────

type withdrawEffectOut struct {
	Played     int             `json:"played"`
	ToWalkover int             `json:"toWalkover"`
	Vacates    int             `json:"vacates"`
	Blocked    []withdrawBlock `json:"blocked"`
}

type withdrawBlock struct {
	ID        string  `json:"id"`
	RoundName *string `json:"roundName"`
}

// withdrawalEffect is what withdrawing a pair will do, before it does it. The
// organiser is standing in front of the person asking, and "are you sure?" is
// not an answer — every number in the confirm comes from here, so it is the
// number the write will act on.
func withdrawalEffect(ctx context.Context, q core.Querier, tournamentID, teamID string) (*withdrawEffectOut, error) {
	all, err := store.Matches(ctx, q, tournamentID)
	if err != nil {
		return nil, err
	}
	out := &withdrawEffectOut{Blocked: []withdrawBlock{}}
	for _, m := range all {
		if deref(m.TeamAID) != teamID && deref(m.TeamBID) != teamID {
			continue
		}
		if m.ResultState != "none" {
			out.Played++
			continue
		}
		// A match already on court is not ours to rewrite from the desk.
		if m.Status == "live" {
			out.Blocked = append(out.Blocked, withdrawBlock{ID: m.ID, RoundName: m.RoundName})
			continue
		}
		// A match still waiting on another result has nobody to give a walkover
		// to — the pair just comes off the slot. Counting it as a walkover made
		// the confirm promise something that would not happen.
		if m.TeamAID == nil || m.TeamBID == nil {
			out.Vacates++
			continue
		}
		out.ToWalkover++
	}
	return out, nil
}

// teamOf loads a team and checks it is this tournament's.
func teamOf(ctx context.Context, q core.Querier, tournamentID, teamID string) (*store.Team, error) {
	teams, err := store.Teams(ctx, q, tournamentID)
	if err != nil {
		return nil, err
	}
	for i := range teams {
		if teams[i].ID == teamID {
			return &teams[i], nil
		}
	}
	return nil, store.ErrNotFound
}

type withdrawOut struct {
	OK bool `json:"ok"`
	// walkovers and note are always present on the wire: the screen prints
	// "N matches become walkovers", and a missing field reads as "undefined".
	Walkovers int    `json:"walkovers"`
	Note      string `json:"note"`
	Error     string `json:"error,omitempty"`
	Fix       string `json:"fix,omitempty"`
}

// withdrawTeam — matches they played stand; matches they had left become
// walkovers to the other side, which count as a win and contribute nothing to
// any difference column, so a pair who go home at lunch cannot decide the pool
// on point difference for the people still playing.
func withdrawTeam(ctx context.Context, d *core.Deps, in teamIn) (withdrawOut, error) {
	var out withdrawOut
	err := d.Tx(ctx, func(tx *sql.Tx) error {
		t, err := store.TournamentByIDForUpdate(ctx, tx, d.Venue.ID, in.TournamentID)
		if err != nil {
			out = withdrawOut{Error: "That pair is no longer in the draw."}
			return nil
		}
		team, err := teamOf(ctx, tx, t.ID, in.TeamID)
		if err != nil {
			out = withdrawOut{Error: "That pair is no longer in the draw."}
			return nil
		}
		if team.Status == "withdrawn" {
			out = withdrawOut{Error: "They are already marked as withdrawn."}
			return nil
		}
		effect, err := withdrawalEffect(ctx, tx, t.ID, team.ID)
		if err != nil {
			return err
		}
		if len(effect.Blocked) > 0 {
			names := make([]string, len(effect.Blocked))
			for i, b := range effect.Blocked {
				names[i] = "a match"
				if b.RoundName != nil {
					names[i] = *b.RoundName
				}
			}
			out = withdrawOut{
				Error: strings.Join(names, ", ") + " is on court right now. Take it off court first, or let it finish.",
				Fix:   "board",
			}
			return nil
		}

		if _, err := tx.ExecContext(ctx,
			`update teams set status = 'withdrawn', withdrawn_at = now() where id = $1`, team.ID); err != nil {
			return err
		}

		rules := engine.RulesFor(t.BestOf, t.PointsToWin)
		all, err := store.Matches(ctx, tx, t.ID)
		if err != nil {
			return err
		}
		walkovers := 0
		for _, m := range all {
			if m.ResultState != "none" || m.Status == "live" {
				continue
			}
			if deref(m.TeamAID) != team.ID && deref(m.TeamBID) != team.ID {
				continue
			}
			opponent := deref(m.TeamAID)
			side := "team_a_id"
			if opponent == team.ID {
				opponent = deref(m.TeamBID)
				side = "team_b_id"
			}
			if opponent == "" {
				// A knockout match with one slot still unresolved — a final
				// waiting on the other semi. Cancelling it was catastrophic:
				// the tournament ended with no final and no champion. The
				// withdrawing pair simply comes off the slot and it re-resolves.
				if _, err := tx.ExecContext(ctx,
					`update matches set `+side+` = null, status = 'pending', version = version + 1, updated_at = now()
					 where id = $1`, m.ID); err != nil {
					return err
				}
				continue
			}
			winnerIsA := opponent == deref(m.TeamAID)
			games := engine.WalkoverGames(rules)
			if !winnerIsA {
				for i := range games {
					games[i].ScoreA, games[i].ScoreB = games[i].ScoreB, games[i].ScoreA
				}
			}
			wonA, wonB := len(games), 0
			if !winnerIsA {
				wonA, wonB = 0, len(games)
			}
			if err := store.SaveGames(ctx, tx, m.ID, games, wonA, wonB); err != nil {
				return err
			}
			// The state was read before the transaction opened. Re-asserting it
			// in the WHERE is what stops a score entered in between being
			// silently overwritten by a generated walkover.
			res, err := tx.ExecContext(ctx, `
				update matches set winner_team_id = $2, result_type = 'walkover', result_state = 'final',
					status = 'completed', ended_at = now(), court_id = null, updated_at = now()
				where id = $1 and result_state = 'none' and status <> 'live'`, m.ID, opponent)
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); n > 0 {
				walkovers++
			}
		}

		if err := core.Bump(ctx, tx, t.ID); err != nil {
			return err
		}
		if err := audit(ctx, tx, "team.withdrawn", "team", team.ID,
			team.Name+" pulled out of "+engine.CategoryName(t.Gender, t.Discipline),
			map[string]any{"played": effect.Played, "walkovers": walkovers}); err != nil {
			return err
		}
		// Their walkovers can make a later match ready.
		if err := flowTournament(ctx, tx, d, t.ID, nil); err != nil {
			return err
		}

		note := team.Name + " are out. Nothing they had left changes."
		if walkovers == 1 {
			note = team.Name + " are out. 1 match becomes a walkover to the other side."
		} else if walkovers > 1 {
			note = rpc.String("%s are out. %d matches become walkovers to the other side.", team.Name, walkovers)
		}
		out = withdrawOut{OK: true, Walkovers: walkovers, Note: note}
		return nil
	})
	return out, err
}

type reinstateOut struct {
	OK       bool   `json:"ok"`
	Restored int    `json:"restored"`
	Note     string `json:"note"`
	Error    string `json:"error,omitempty"`
}

// reinstateTeam puts a withdrawn pair back. Their walkovers are undone, not
// left standing, and those matches go back in the queue. Only the walkovers
// THIS withdrawal created come back: a match they genuinely failed to turn up
// for at half nine is a different fact, and undoing it takes a win off the pair
// who did turn up.
func reinstateTeam(ctx context.Context, d *core.Deps, in teamIn) (reinstateOut, error) {
	var out reinstateOut
	err := d.Tx(ctx, func(tx *sql.Tx) error {
		t, err := store.TournamentByIDForUpdate(ctx, tx, d.Venue.ID, in.TournamentID)
		if err != nil {
			out = reinstateOut{Error: "That pair is no longer in the draw."}
			return nil
		}
		team, err := teamOf(ctx, tx, t.ID, in.TeamID)
		if err != nil {
			out = reinstateOut{Error: "That pair is no longer in the draw."}
			return nil
		}
		if team.Status != "withdrawn" {
			out = reinstateOut{Error: "They are not marked as withdrawn."}
			return nil
		}

		var created []string
		if team.WithdrawnAt != nil {
			rows, err := tx.QueryContext(ctx, `
				select id from matches
				where tournament_id = $1 and result_type = 'walkover'
				  and (team_a_id = $2 or team_b_id = $2) and winner_team_id is distinct from $2
				  and updated_at >= $3`, t.ID, team.ID, *team.WithdrawnAt)
			if err != nil {
				return err
			}
			for rows.Next() {
				var id string
				if err := rows.Scan(&id); err != nil {
					rows.Close()
					return err
				}
				created = append(created, id)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
		}

		if _, err := tx.ExecContext(ctx,
			`update teams set status = 'active', withdrawn_at = null where id = $1`, team.ID); err != nil {
			return err
		}
		for _, id := range created {
			if err := store.SaveGames(ctx, tx, id, nil, 0, 0); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `
				update matches set winner_team_id = null, result_type = 'normal', result_state = 'none',
					status = 'ready', ended_at = null, updated_at = now()
				where id = $1`, id); err != nil {
				return err
			}
		}

		if err := core.Bump(ctx, tx, t.ID); err != nil {
			return err
		}
		if err := audit(ctx, tx, "team.reinstated", "team", team.ID, team.Name+" are playing after all",
			map[string]any{"walkoversUndone": len(created)}); err != nil {
			return err
		}
		// Undone walkovers go back in the queue.
		if err := flowTournament(ctx, tx, d, t.ID, nil); err != nil {
			return err
		}

		note := team.Name + " are back in."
		if len(created) == 1 {
			note += " 1 walkover is undone."
		} else if len(created) > 1 {
			note = rpc.String("%s %d walkovers are undone.", note, len(created))
		}
		out = reinstateOut{OK: true, Restored: len(created), Note: note}
		return nil
	})
	return out, err
}

// ── swap a player ─────────────────────────────────────────────────────────

type substituteTarget struct {
	TeamID   string      `json:"teamId"`
	TeamName string      `json:"teamName"`
	Members  []playerRef `json:"members"`
}

// substitutionOptions — who could be swapped out. Active pairs only, in table
// order; who can step IN is the roster minus everybody who appears here.
func substitutionOptions(ctx context.Context, q core.Querier, tournamentID string) ([]substituteTarget, error) {
	teams, err := store.Teams(ctx, q, tournamentID)
	if err != nil {
		return nil, err
	}
	active := make([]store.Team, 0, len(teams))
	for _, t := range teams {
		if t.Status == "active" {
			active = append(active, t)
		}
	}
	sort.SliceStable(active, func(i, j int) bool {
		a, b := active[i].Seed, active[j].Seed
		if (a == nil) != (b == nil) {
			return a != nil
		}
		if a != nil && *a != *b {
			return *a < *b
		}
		return false // store.Teams already returns them in the order pairs were made
	})
	out := make([]substituteTarget, 0, len(active))
	for _, t := range active {
		members := make([]playerRef, 0, len(t.Players))
		for _, p := range t.Players {
			members = append(members, playerRef{ID: p.ID, Name: p.Name})
		}
		out = append(out, substituteTarget{TeamID: t.ID, TeamName: t.Name, Members: members})
	}
	return out, nil
}

type substituteIn struct {
	TournamentID string `json:"tournamentId"`
	TeamID       string `json:"teamId"`
	OutPlayerID  string `json:"outPlayerId"`
	InPlayerID   string `json:"inPlayerId"`
}

type substituteOut struct {
	OK       bool   `json:"ok"`
	Name     string `json:"name"`
	Incoming string `json:"incoming"`
	Note     string `json:"note"`
	Error    string `json:"error,omitempty"`
	Fix      string `json:"fix,omitempty"`
}

// substitutePlayer swaps one player for another, mid-day. The team keeps its
// identity: its results, its place in the table and its position in the draw
// all stand. Only the name changes, and it changes EVERYWHERE at once, because
// a pair called "Ravi / Priya" on the board and "Ravi / Meera" on the public
// page is how an argument starts.
func substitutePlayer(ctx context.Context, d *core.Deps, in substituteIn) (substituteOut, error) {
	var out substituteOut
	if in.TeamID == "" || in.OutPlayerID == "" || in.InPlayerID == "" {
		return substituteOut{Error: "Pick who is coming out and who is going in."}, nil
	}
	err := d.Tx(ctx, func(tx *sql.Tx) error {
		t, err := store.TournamentByIDForUpdate(ctx, tx, d.Venue.ID, in.TournamentID)
		if err != nil {
			out = substituteOut{Error: "That pair is no longer in the draw."}
			return nil
		}
		team, err := teamOf(ctx, tx, t.ID, in.TeamID)
		if err != nil {
			out = substituteOut{Error: "That pair is no longer in the draw."}
			return nil
		}
		inPair := false
		for _, p := range team.Players {
			if p.ID == in.OutPlayerID {
				inPair = true
			}
		}
		if !inPair {
			out = substituteOut{Error: "That player is not in this pair."}
			return nil
		}
		for _, p := range team.Players {
			if p.ID == in.InPlayerID {
				out = substituteOut{Error: "They are already in this pair."}
				return nil
			}
		}

		var incoming string
		err = tx.QueryRowContext(ctx,
			`select name from players where id = $1 and venue_id = $2 and deleted_at is null`,
			in.InPlayerID, d.Venue.ID).Scan(&incoming)
		if err != nil {
			out = substituteOut{Error: "That player is not on the roster.", Fix: "signups"}
			return nil
		}
		// The select only offers this tournament's roster, but a select is a
		// wire format. Somebody who has never been entered goes on first.
		var one int
		if err := tx.QueryRowContext(ctx,
			`select 1 from tournament_players where tournament_id = $1 and player_id = $2`,
			t.ID, in.InPlayerID).Scan(&one); err != nil {
			out = substituteOut{Error: "Whoever is stepping in has to be on the roster first.", Fix: "signups"}
			return nil
		}

		// Nobody plays for two pairs in the same tournament — that is the
		// double-booking the board exists to prevent, arriving through a
		// different door.
		var clash string
		err = tx.QueryRowContext(ctx, `
			select t.name from team_players tp join teams t on t.id = tp.team_id
			where t.tournament_id = $1 and tp.player_id = $2 and t.id <> $3 and t.status <> 'withdrawn'
			limit 1`, t.ID, in.InPlayerID, team.ID).Scan(&clash)
		if err == nil {
			out = substituteOut{Error: incoming + " is already playing for " + clash + "."}
			return nil
		}
		if err != sql.ErrNoRows {
			return err
		}

		// And not onto a court they are already standing on. livePlayerConflict
		// only runs when a match is SENT to a court; a substitution reaches the
		// same state through a different door, and the unique index guards
		// courts, not people.
		var onCourt string
		err = tx.QueryRowContext(ctx, `
			select coalesce(c.name, 'a court') from matches m
			join teams tm on tm.id = m.team_a_id or tm.id = m.team_b_id
			join team_players tp on tp.team_id = tm.id
			left join courts c on c.id = m.court_id
			where m.tournament_id = $1 and m.status = 'live' and tp.player_id = $2 limit 1`,
			t.ID, in.InPlayerID).Scan(&onCourt)
		if err == nil {
			out = substituteOut{Error: incoming + " is on " + onCourt + " right now.", Fix: "board"}
			return nil
		}
		if err != sql.ErrNoRows {
			return err
		}

		// Nor into a pair that is mid-match: renaming a side while it is being
		// played is how the board and the public page end up disagreeing.
		var theirs string
		err = tx.QueryRowContext(ctx, `
			select coalesce(c.name, 'a court') from matches m left join courts c on c.id = m.court_id
			where m.status = 'live' and (m.team_a_id = $1 or m.team_b_id = $1) limit 1`, team.ID).Scan(&theirs)
		if err == nil {
			out = substituteOut{Error: "That pair is on " + theirs + ". Swap them when the match finishes.", Fix: "board"}
			return nil
		}
		if err != sql.ErrNoRows {
			return err
		}

		names := make([]string, 0, len(team.Players))
		for _, p := range team.Players {
			if p.ID == in.OutPlayerID {
				names = append(names, incoming)
			} else {
				names = append(names, p.Name)
			}
		}
		newName := strings.Join(names, " / ")

		if _, err := tx.ExecContext(ctx,
			`update team_players set player_id = $3 where team_id = $1 and player_id = $2`,
			team.ID, in.OutPlayerID, in.InPlayerID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `update teams set name = $2 where id = $1`, team.ID, newName); err != nil {
			return err
		}
		if err := core.Bump(ctx, tx, t.ID); err != nil {
			return err
		}
		if err := audit(ctx, tx, "team.substitution", "team", team.ID,
			incoming+" came in for somebody in "+team.Name,
			map[string]any{"before": team.Name, "after": newName}); err != nil {
			return err
		}
		out = substituteOut{
			OK: true, Name: newName, Incoming: incoming,
			Note: team.Name + " are now " + newName + ". Their results and their place in the table stand.",
		}
		return nil
	})
	return out, err
}

// ── stop the clock ────────────────────────────────────────────────────────

type pauseIn struct {
	TournamentID string `json:"tournamentId"`
	Note         string `json:"note"`
}

type noteOut struct {
	OK    bool   `json:"ok"`
	Note  string `json:"note"`
	Error string `json:"error,omitempty"`
	Fix   string `json:"fix,omitempty"`
}

// pauseDay — rain, a missing net, lunch. Matches already on court carry on;
// nothing new goes on until it starts again, and the public page says why
// rather than leaving forty people looking at a board that has not moved.
func pauseDay(ctx context.Context, d *core.Deps, in pauseIn) (noteOut, error) {
	var out noteOut
	err := d.Tx(ctx, func(tx *sql.Tx) error {
		t, err := store.TournamentByIDForUpdate(ctx, tx, d.Venue.ID, in.TournamentID)
		if err != nil {
			out = noteOut{Error: "That tournament no longer exists."}
			return nil
		}
		note := clip(strings.Join(strings.Fields(in.Note), " "), 120)
		if note == "" {
			note = "Paused"
		}
		if _, err := tx.ExecContext(ctx,
			`update tournaments set paused_at = now(), pause_note = $2 where id = $1`, t.ID, note); err != nil {
			return err
		}
		if err := core.Bump(ctx, tx, t.ID); err != nil {
			return err
		}
		if err := audit(ctx, tx, "tournament.paused", "tournament", t.ID, note, nil); err != nil {
			return err
		}
		out = noteOut{OK: true, Note: "Paused. The public page says so."}
		return nil
	})
	return out, err
}

// resumeDay clears the pause, then flows the next matches onto the courts that
// stood empty through the stop.
func resumeDay(ctx context.Context, d *core.Deps, tournamentID string) (noteOut, error) {
	var out noteOut
	err := d.Tx(ctx, func(tx *sql.Tx) error {
		t, err := store.TournamentByIDForUpdate(ctx, tx, d.Venue.ID, tournamentID)
		if err != nil {
			out = noteOut{Error: "That tournament no longer exists."}
			return nil
		}
		if _, err := tx.ExecContext(ctx,
			`update tournaments set paused_at = null, pause_note = null where id = $1`, t.ID); err != nil {
			return err
		}
		if err := core.Bump(ctx, tx, t.ID); err != nil {
			return err
		}
		if err := audit(ctx, tx, "tournament.resumed", "tournament", t.ID, "", nil); err != nil {
			return err
		}
		if err := flowTournament(ctx, tx, d, t.ID, nil); err != nil {
			return err
		}
		out = noteOut{OK: true, Note: "Going again."}
		return nil
	})
	return out, err
}

// ── shorten what's left ───────────────────────────────────────────────────

type shortenIn struct {
	TournamentID string `json:"tournamentId"`
	BestOf       int    `json:"bestOf"`
	PointsToWin  int    `json:"pointsToWin"`
}

// shortenFormat — the most-used emergency tool there is, because the sun sets
// at a fixed time and a day that started late cannot get the hours back.
//
// Only matches with NO result are affected: a match already played keeps the
// shape its stored games say it had (see rulesForMatch), so rewriting the
// format cannot change what an old score meant after the fact.
func shortenFormat(ctx context.Context, d *core.Deps, in shortenIn) (noteOut, error) {
	var out noteOut
	err := d.Tx(ctx, func(tx *sql.Tx) error {
		t, err := store.TournamentByIDForUpdate(ctx, tx, d.Venue.ID, in.TournamentID)
		if err != nil {
			out = noteOut{Error: "That tournament no longer exists."}
			return nil
		}
		if in.BestOf != 1 && in.BestOf != 3 {
			out = noteOut{Error: "A match is best of one or best of three."}
			return nil
		}
		if in.PointsToWin < 7 || in.PointsToWin > 21 {
			out = noteOut{Error: "Games run to between 7 and 21."}
			return nil
		}
		var one int
		err = tx.QueryRowContext(ctx,
			`select 1 from matches where tournament_id = $1 and status = 'live' limit 1`, t.ID).Scan(&one)
		if err == nil {
			out = noteOut{Error: "A match is on court. Change it when that one finishes.", Fix: "board"}
			return nil
		}
		if err != sql.ErrNoRows {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`update tournaments set best_of = $2, points_to_win = $3 where id = $1`,
			t.ID, in.BestOf, in.PointsToWin); err != nil {
			return err
		}
		if err := core.Bump(ctx, tx, t.ID); err != nil {
			return err
		}
		if err := audit(ctx, tx, "tournament.format_shortened", "tournament", t.ID,
			t.Name+" shortened to finish before dark",
			map[string]any{
				"before": map[string]int{"bestOf": t.BestOf, "pointsToWin": t.PointsToWin},
				"after":  map[string]int{"bestOf": in.BestOf, "pointsToWin": in.PointsToWin},
			}); err != nil {
			return err
		}
		shape := rpc.String("best of %d to %d", in.BestOf, in.PointsToWin)
		if in.BestOf == 1 {
			shape = rpc.String("one game to %d", in.PointsToWin)
		}
		out = noteOut{OK: true, Note: "What is left is now " + shape + "."}
		return nil
	})
	return out, err
}

// ── cancel a match ────────────────────────────────────────────────────────

type voidIn struct {
	MatchID string `json:"matchId"`
	Reason  string `json:"reason"`
}

// voidMatch — cancelling is not correcting. The match counts for nobody
// afterwards: no winner, no points, in no table and no difference column.
func voidMatch(ctx context.Context, d *core.Deps, in voidIn) (okRedirect, error) {
	var out okRedirect
	reason := strings.TrimSpace(in.Reason)
	if len([]rune(reason)) < 3 {
		return okRedirect{Error: "Say why it is being cancelled — it goes in the log next to your name."}, nil
	}
	err := d.Tx(ctx, func(tx *sql.Tx) error {
		match, err := store.MatchByID(ctx, tx, in.MatchID)
		if err != nil {
			out = okRedirect{Error: "That match no longer exists."}
			return nil
		}
		t, err := store.TournamentByIDForUpdate(ctx, tx, d.Venue.ID, match.TournamentID)
		if err != nil {
			out = okRedirect{Error: "That match no longer exists."}
			return nil
		}
		match, err = store.MatchByIDForUpdate(ctx, tx, in.MatchID)
		if err != nil {
			out = okRedirect{Error: "That match no longer exists."}
			return nil
		}
		if match.Status == "live" {
			out = okRedirect{Error: "That match is on court. Take it off court first."}
			return nil
		}
		// Anything fed by this match — including, for a group match, everything
		// fed by the TABLE it sits in. That last sentence is the only thing
		// that tells the organiser what to sort out first, so it must reach the
		// screen.
		blockers, err := correctionBlockers(ctx, tx, match)
		if err != nil {
			return err
		}
		if len(blockers) > 0 {
			names := make([]string, len(blockers))
			for i, b := range blockers {
				names[i] = "a later match"
				if b.RoundName != nil {
					names[i] = *b.RoundName
				}
			}
			out = okRedirect{Error: strings.Join(names, ", ") + " was built off this result. Sort that one out first."}
			return nil
		}

		if err := store.SaveGames(ctx, tx, match.ID, nil, 0, 0); err != nil {
			return err
		}
		// Re-asserted here: the status was read before the row was locked, and
		// a match sent to a court in between must not be ended from the desk.
		if _, err := tx.ExecContext(ctx, `
			update matches set result_state = 'voided', result_type = 'cancelled', status = 'completed',
				winner_team_id = null, retired_team_id = null, court_id = null, ended_at = now(), updated_at = now()
			where id = $1 and status <> 'live'`, match.ID); err != nil {
			return err
		}
		if err := core.Bump(ctx, tx, t.ID); err != nil {
			return err
		}
		if err := audit(ctx, tx, "match.voided", "match", match.ID, reason,
			map[string]any{"resultState": match.ResultState}); err != nil {
			return err
		}
		// Voiding a group match can settle its table: the knockout resolves and
		// the next matches go on.
		if err := flowTournament(ctx, tx, d, t.ID, nil); err != nil {
			return err
		}
		out = okRedirect{OK: true, Redirect: "/admin/live"}
		return nil
	})
	return out, err
}

// ── the RPCs ──────────────────────────────────────────────────────────────

func registerChaos(reg *rpc.Registry, d *core.Deps) {
	rpc.Register(reg, "chaos.withdrawalEffect", rpc.Organiser,
		func(ctx context.Context, in teamIn) (*withdrawEffectOut, error) {
			t, err := store.TournamentByID(ctx, d.DB, d.Venue.ID, in.TournamentID)
			if err != nil {
				return nil, rpc.NotFound("That tournament no longer exists.")
			}
			if _, err := teamOf(ctx, d.DB, t.ID, in.TeamID); err != nil {
				return nil, rpc.NotFound("That pair is no longer in the draw.")
			}
			return withdrawalEffect(ctx, d.DB, t.ID, in.TeamID)
		})

	rpc.Register(reg, "chaos.withdrawTeam", rpc.Organiser,
		func(ctx context.Context, in teamIn) (withdrawOut, error) { return withdrawTeam(ctx, d, in) })

	rpc.Register(reg, "chaos.reinstateTeam", rpc.Organiser,
		func(ctx context.Context, in teamIn) (reinstateOut, error) { return reinstateTeam(ctx, d, in) })

	rpc.Register(reg, "chaos.substitutionOptions", rpc.Organiser,
		func(ctx context.Context, in tournamentIn) ([]substituteTarget, error) {
			t, err := store.TournamentByID(ctx, d.DB, d.Venue.ID, in.TournamentID)
			if err != nil {
				return nil, rpc.NotFound("That tournament no longer exists.")
			}
			return substitutionOptions(ctx, d.DB, t.ID)
		})

	rpc.Register(reg, "chaos.substitutePlayer", rpc.Organiser,
		func(ctx context.Context, in substituteIn) (substituteOut, error) { return substitutePlayer(ctx, d, in) })

	rpc.Register(reg, "chaos.pauseDay", rpc.Organiser,
		func(ctx context.Context, in pauseIn) (noteOut, error) { return pauseDay(ctx, d, in) })

	rpc.Register(reg, "chaos.resumeDay", rpc.Organiser,
		func(ctx context.Context, in tournamentIn) (noteOut, error) { return resumeDay(ctx, d, in.TournamentID) })

	rpc.Register(reg, "chaos.shortenFormat", rpc.Organiser,
		func(ctx context.Context, in shortenIn) (noteOut, error) { return shortenFormat(ctx, d, in) })

	rpc.Register(reg, "chaos.voidMatch", rpc.Organiser,
		func(ctx context.Context, in voidIn) (okRedirect, error) { return voidMatch(ctx, d, in) })
}

// clip keeps a free-text field to a length a screen can show.
func clip(s string, max int) string {
	r := []rune(s)
	if len(r) > max {
		return string(r[:max])
	}
	return s
}
