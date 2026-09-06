package setup

import (
	"context"
	"database/sql"
	"time"

	"mpb/internal/core"
	"mpb/internal/engine"
	"mpb/internal/ids"
	"mpb/internal/rpc"
	"mpb/internal/store"
)

// The tournament's own data: what it is, its matches, its pairs, its table —
// and the draw that makes the matches in the first place.

type tournamentOut struct {
	ID                   string  `json:"id"`
	Slug                 string  `json:"slug"`
	Name                 string  `json:"name"`
	Day                  string  `json:"day"`
	Status               string  `json:"status"`
	Gender               string  `json:"gender"`
	Discipline           string  `json:"discipline"`
	FinalsStage          string  `json:"finalsStage"`
	AdvancePerGroup      int     `json:"advancePerGroup"`
	BestOf               int     `json:"bestOf"`
	PointsToWin          int     `json:"pointsToWin"`
	RegistrationClosedAt *string `json:"registrationClosedAt"`
	PausedAt             *string `json:"pausedAt"`
	PauseNote            *string `json:"pauseNote"`
	UpdatedAt            string  `json:"updatedAt"`
}

type matchOut struct {
	ID           string  `json:"id"`
	Stage        string  `json:"stage"`
	RoundIndex   int     `json:"roundIndex"`
	RoundName    *string `json:"roundName"`
	Seq          int     `json:"seq"`
	Status       string  `json:"status"`
	ResultState  string  `json:"resultState"`
	ResultType   string  `json:"resultType"`
	TeamAID      *string `json:"teamAId"`
	TeamBID      *string `json:"teamBId"`
	WinnerTeamID *string `json:"winnerTeamId"`
	GamesWonA    int     `json:"gamesWonA"`
	GamesWonB    int     `json:"gamesWonB"`
	CourtID      *string `json:"courtId"`
	StartedAt    *string `json:"startedAt"`
}

type teamOut struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

type playerOut struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type standingsRowOut struct {
	TeamID string `json:"teamId"`
	// Group is the pool this row belongs to — "Pool A" — or null when the
	// tournament is one league. The screen draws one table per pool.
	Group     *string `json:"group"`
	Won       int     `json:"won"`
	PointsFor int     `json:"pointsFor"`
	Reason    *string `json:"reason"`
}

type standingsTeamOut struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

type standingsOut struct {
	Rows  []standingsRowOut  `json:"rows"`
	Teams []standingsTeamOut `json:"teams"`
}

type gameOut struct {
	ScoreA int `json:"scoreA"`
	ScoreB int `json:"scoreB"`
}

type generateDrawOut struct {
	OK    bool   `json:"ok"`
	Count int    `json:"count"`
	Error string `json:"error,omitempty"`
}

func registerTournaments(reg *rpc.Registry, d *core.Deps) {
	rpc.Register(reg, "tournaments.getTournamentBySlug", rpc.Organiser,
		func(ctx context.Context, in slugIn) (tournamentOut, error) {
			return getTournamentBySlug(ctx, d, in.Slug)
		})

	rpc.Register(reg, "tournaments.listMatches", rpc.Organiser,
		func(ctx context.Context, in tournamentIDIn) ([]matchOut, error) { return listMatches(ctx, d, in) })

	rpc.Register(reg, "tournaments.listTeams", rpc.Organiser,
		func(ctx context.Context, in tournamentIDIn) ([]teamOut, error) { return listTeams(ctx, d, in) })

	rpc.Register(reg, "tournaments.listTournamentPlayers", rpc.Organiser,
		func(ctx context.Context, in tournamentIDIn) ([]playerOut, error) {
			return listTournamentPlayers(ctx, d, in)
		})

	rpc.Register(reg, "tournaments.standingsFor", rpc.Organiser,
		func(ctx context.Context, in tournamentIDIn) (standingsOut, error) { return standingsFor(ctx, d, in) })

	rpc.Register(reg, "tournaments.teamNameMap", rpc.Organiser,
		func(ctx context.Context, in tournamentIDIn) (map[string]string, error) {
			return teamNameMap(ctx, d, in)
		})

	rpc.Register(reg, "tournaments.gamesByMatch", rpc.Organiser,
		func(ctx context.Context, in tournamentIDIn) (map[string][]gameOut, error) {
			return gamesByMatch(ctx, d, in)
		})

	rpc.Register(reg, "tournaments.generateDraw", rpc.Organiser,
		func(ctx context.Context, in tournamentIDIn) (generateDrawOut, error) { return generateDraw(ctx, d, in) })
}

// getTournamentBySlug is the only place a screen turns a slug into an id;
// every write RPC then takes the id.
func getTournamentBySlug(ctx context.Context, d *core.Deps, slug string) (tournamentOut, error) {
	t, err := mustTournamentBySlug(ctx, d, slug)
	if err != nil {
		return tournamentOut{}, err
	}
	return tournamentOut{
		ID: t.ID, Slug: t.Slug, Name: t.Name, Day: t.Day, Status: t.Status,
		Gender: t.Gender, Discipline: t.Discipline, FinalsStage: t.FinalsStage,
		AdvancePerGroup: t.AdvancePerGroup, BestOf: t.BestOf, PointsToWin: t.PointsToWin,
		RegistrationClosedAt: core.ISO(t.RegistrationClosedAt),
		PausedAt:             core.ISO(t.PausedAt),
		PauseNote:            t.PauseNote,
		UpdatedAt:            t.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}, nil
}

// listTournamentPlayers is the roster as ids and names, in sign-up order.
func listTournamentPlayers(ctx context.Context, d *core.Deps, in tournamentIDIn) ([]playerOut, error) {
	t, err := mustTournament(ctx, d, d.DB, in.TournamentID)
	if err != nil {
		return nil, err
	}
	roster, err := store.Roster(ctx, d.DB, t.ID)
	if err != nil {
		return nil, err
	}
	out := make([]playerOut, 0, len(roster))
	for _, r := range roster {
		out = append(out, playerOut{ID: r.Player.ID, Name: r.Player.Name})
	}
	return out, nil
}

// teamNameMap is id → shown name, withdrawn pairs included: the screens print
// "—" for an id that is not in it.
func teamNameMap(ctx context.Context, d *core.Deps, in tournamentIDIn) (map[string]string, error) {
	t, err := mustTournament(ctx, d, d.DB, in.TournamentID)
	if err != nil {
		return nil, err
	}
	return store.TeamNames(ctx, d.DB, t.ID)
}

func listMatches(ctx context.Context, d *core.Deps, in tournamentIDIn) ([]matchOut, error) {
	t, err := mustTournament(ctx, d, d.DB, in.TournamentID)
	if err != nil {
		return nil, err
	}
	rows, err := store.Matches(ctx, d.DB, t.ID)
	if err != nil {
		return nil, err
	}
	out := make([]matchOut, 0, len(rows))
	for _, m := range rows {
		out = append(out, matchOut{
			ID: m.ID, Stage: m.Stage, RoundIndex: m.RoundIndex, RoundName: m.RoundName, Seq: m.Seq,
			Status: m.Status, ResultState: m.ResultState, ResultType: m.ResultType,
			TeamAID: m.TeamAID, TeamBID: m.TeamBID, WinnerTeamID: m.WinnerTeamID,
			GamesWonA: m.GamesWonA, GamesWonB: m.GamesWonB, CourtID: m.CourtID,
			StartedAt: core.ISO(m.StartedAt),
		})
	}
	return out, nil
}

func listTeams(ctx context.Context, d *core.Deps, in tournamentIDIn) ([]teamOut, error) {
	t, err := mustTournament(ctx, d, d.DB, in.TournamentID)
	if err != nil {
		return nil, err
	}
	teams, err := store.Teams(ctx, d.DB, t.ID)
	if err != nil {
		return nil, err
	}
	out := make([]teamOut, 0, len(teams))
	for _, tm := range teams {
		out = append(out, teamOut{ID: tm.ID, Name: tm.Name, Status: tm.Status})
	}
	return out, nil
}

// standingsFor is the table, straight from the ledger — one table per pool,
// in pool order, each row saying which pool it is in. A league is one table
// and every row's group is null. Withdrawn pairs keep their row for the
// record; the screen greys them and draws the cut line around them.
func standingsFor(ctx context.Context, d *core.Deps, in tournamentIDIn) (standingsOut, error) {
	t, err := mustTournament(ctx, d, d.DB, in.TournamentID)
	if err != nil {
		return standingsOut{}, err
	}
	teams, err := store.Teams(ctx, d.DB, t.ID)
	if err != nil {
		return standingsOut{}, err
	}
	out := standingsOut{Rows: []standingsRowOut{}, Teams: []standingsTeamOut{}}
	for _, tm := range teams {
		out.Teams = append(out.Teams, standingsTeamOut{ID: tm.ID, Status: tm.Status})
	}
	if len(teams) == 0 {
		return out, nil
	}
	tables, err := store.Tables(ctx, d.DB, t.ID, teams)
	if err != nil {
		return standingsOut{}, err
	}
	for _, table := range tables {
		var group *string
		if table.Group != "" {
			name := table.Group
			group = &name
		}
		for _, r := range table.Rows {
			row := standingsRowOut{TeamID: r.TeamID, Group: group, Won: r.Won, PointsFor: r.PointsFor}
			if r.Reason != "" {
				reason := r.Reason
				row.Reason = &reason
			}
			out.Rows = append(out.Rows, row)
		}
	}
	return out, nil
}

// gamesByMatch is the "11–9, 8–11, 11–6" line. A match with no games — a bye,
// or one nobody has played — is simply absent.
func gamesByMatch(ctx context.Context, d *core.Deps, in tournamentIDIn) (map[string][]gameOut, error) {
	t, err := mustTournament(ctx, d, d.DB, in.TournamentID)
	if err != nil {
		return nil, err
	}
	rows, err := store.Matches(ctx, d.DB, t.ID)
	if err != nil {
		return nil, err
	}
	out := map[string][]gameOut{}
	for _, m := range rows {
		if len(m.Games) == 0 {
			continue
		}
		games := make([]gameOut, 0, len(m.Games))
		for _, g := range m.Games {
			games = append(games, gameOut{ScoreA: g.ScoreA, ScoreB: g.ScoreB})
		}
		out[m.ID] = games
	}
	return out, nil
}

// ── the draw ──────────────────────────────────────────────────────────────

// clearDraw throws a schedule away. Only ever before the start, when no match
// has a result: a changed pair makes the order of play wrong, so it goes and
// the organiser makes it again in one tap. Teams point at their group, so they
// are unhooked before the groups go.
func clearDraw(ctx context.Context, tx *sql.Tx, tournamentID string) error {
	if _, err := tx.ExecContext(ctx, `delete from matches where tournament_id = $1`, tournamentID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `update teams set group_id = null where tournament_id = $1`, tournamentID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `delete from groups where tournament_id = $1`, tournamentID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx,
		`update tournaments set draw_made_at = null, advance_per_group = 0 where id = $1`, tournamentID)
	return err
}

func generateDraw(ctx context.Context, d *core.Deps, in tournamentIDIn) (generateDrawOut, error) {
	var out generateDrawOut
	err := d.Tx(ctx, func(tx *sql.Tx) error {
		t, err := lockTournament(ctx, tx, d, in.TournamentID)
		if err != nil {
			return err
		}
		// Once the tournament has started its matches are on court: remaking
		// the draw would delete them from under the players.
		if isLocked(t) {
			out = generateDrawOut{Error: lockedMessage}
			return nil
		}
		// Remaking a draw deletes the matches; a result already in it would go
		// with them, and no screen can explain that.
		var played sql.NullString
		err = tx.QueryRowContext(ctx,
			`select id from matches where tournament_id = $1 and result_state <> 'none' limit 1`, t.ID).Scan(&played)
		if err != nil && err != sql.ErrNoRows {
			return err
		}
		if played.Valid {
			out = generateDrawOut{Error: "Results are already in — the schedule can’t be remade now."}
			return nil
		}
		// Settles mutual pairs and singles' teams of one first, so a
		// tournament whose Teams screen was never opened still has something
		// to draw from.
		if _, err := settleTeams(ctx, tx, d, t); err != nil {
			return err
		}

		teams, err := store.Teams(ctx, tx, t.ID)
		if err != nil {
			return err
		}
		// A pair that pulled out before the schedule was made is out of the
		// day: drawing them in gave them matches nobody would ever play.
		var seedOrder []string
		for _, tm := range teams {
			if tm.Status != "withdrawn" {
				seedOrder = append(seedOrder, tm.ID)
			}
		}
		if len(seedOrder) < 2 {
			out = generateDrawOut{Error: "You need at least two pairs before there is a schedule to make."}
			return nil
		}

		// Eight teams or more are split into pools; below that it is one
		// league whatever the finals stage says.
		drawType := "league"
		if engine.PoolCountFor(len(seedOrder)) > 1 {
			drawType = "groups_knockout"
		}
		plan := engine.BuildDraw(seedOrder, drawType, engine.FinalsStage(t.FinalsStage))
		count, err := persistDraw(ctx, tx, d, t, plan)
		if err != nil {
			return err
		}
		if err := core.Audit(ctx, tx, actor(ctx), "draw.generated", "tournament", t.ID, "",
			map[string]any{"matches": count, "teams": len(seedOrder)}); err != nil {
			return err
		}
		out = generateDrawOut{OK: true, Count: count}
		return core.Bump(ctx, tx, t.ID)
	})
	if err != nil {
		return generateDrawOut{}, err
	}
	return out, nil
}

// persistDraw writes a plan. Slots that are already known resolve at once and
// the match is `ready`; the rest wait on a group table or an earlier result.
// The whole draw goes down inside the caller's transaction — a half-written
// draw is a state no screen can explain.
func persistDraw(ctx context.Context, tx *sql.Tx, d *core.Deps, t *store.Tournament, plan engine.DrawPlan) (int, error) {
	if err := clearDraw(ctx, tx, t.ID); err != nil {
		return 0, err
	}

	groupIDByName := map[string]string{}
	advance := 0
	var seedOrder []string
	for i, g := range plan.Groups {
		id := ids.New("grp")
		groupIDByName[g.Name] = id
		if _, err := tx.ExecContext(ctx,
			`insert into groups (id, tournament_id, name, advance_count, sort_order) values ($1,$2,$3,$4,$5)`,
			id, t.ID, g.Name, g.AdvanceCount, i); err != nil {
			return 0, err
		}
		if g.AdvanceCount > advance {
			advance = g.AdvanceCount
		}
		for _, teamID := range g.TeamIDs {
			seedOrder = append(seedOrder, teamID)
			if _, err := tx.ExecContext(ctx,
				`update teams set group_id = $2 where id = $1 and tournament_id = $3`, teamID, id, t.ID); err != nil {
				return 0, err
			}
		}
	}

	// Every match gets its id before any of them is written, so a knockout
	// slot can point at the semi-final it waits on.
	matchID := make(map[string]string, len(plan.Matches))
	for _, m := range plan.Matches {
		matchID[m.Key] = ids.New("mch")
	}

	resolve := func(s engine.SlotSource) (engine.SlotSource, *string) {
		switch s.Type {
		case "entry":
			teamID := s.TeamID
			return engine.SlotSource{Type: "entry", TeamID: teamID}, &teamID
		case "group_rank":
			return engine.SlotSource{Type: "group_rank", GroupName: s.GroupName, Rank: s.Rank}, nil
		case "winner_of", "loser_of":
			// The plan's key becomes the real match id here; nothing outside
			// this function has ever seen a matchKey.
			return engine.SlotSource{Type: s.Type, MatchID: matchID[s.MatchKey]}, nil
		default:
			return engine.SlotSource{Type: "bye"}, nil
		}
	}

	for _, m := range plan.Matches {
		srcA, teamA := resolve(m.SlotA)
		srcB, teamB := resolve(m.SlotB)
		status := "pending"
		if teamA != nil && teamB != nil {
			status = "ready"
		}
		var groupID any
		if m.GroupName != "" {
			if gid, ok := groupIDByName[m.GroupName]; ok {
				groupID = gid
			}
		}
		var roundName any
		if m.RoundName != "" {
			roundName = m.RoundName
		}
		if _, err := tx.ExecContext(ctx, `
			insert into matches (id, tournament_id, stage, group_id, round_index, round_name, seq,
			                     team_a_id, team_b_id, source_a, source_b, status)
			values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
			matchID[m.Key], t.ID, m.Stage, groupID, m.RoundIndex, roundName, m.Seq,
			ptrArg(teamA), ptrArg(teamB), store.JSON(srcA), store.JSON(srcB), status); err != nil {
			return 0, err
		}
	}

	// The qualification line on both tables is drawn at advance_per_group;
	// left at its default a semis-and-final draw told 3rd and 4th they were
	// out and then the board called them to a semi-final.
	if _, err := tx.ExecContext(ctx, `
		update tournaments set advance_per_group = $2, draw_made_at = $3, seed_order = $4 where id = $1`,
		t.ID, advance, d.Now(), store.JSON(seedOrder)); err != nil {
		return 0, err
	}
	return len(plan.Matches), nil
}

func ptrArg(s *string) any {
	if s == nil || *s == "" {
		return nil
	}
	return *s
}
