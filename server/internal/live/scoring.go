package live

// Results — SPEC A5, ported from app/src/server/scoring.ts.
//
// v4 has one scorer: the organiser. The reference's inbox of submissions, its
// agree/dispute dance and its provisional window are gone — a score is final
// the moment it is saved. What survives is everything that decides what the
// score MEANS: the winner is derived from the games, a walkover's scoreline is
// generated rather than accepted, and which games sit out of point difference
// is worked out here, because that field decides the venue's headline tiebreak
// and a phone must not be able to set it.

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

// rulesForMatch is the rules a match was actually played under.
//
// After "Shorten what's left" the tournament says one game to 11, but a result
// that was already in was best of three — correcting it under the new rules
// would refuse its own second game. The stored games say what shape it had.
func rulesForMatch(t *store.Tournament, existing []engine.Game) engine.ScoringRules {
	rules := engine.RulesFor(t.BestOf, t.PointsToWin)
	if len(existing) == 0 {
		return rules
	}
	if len(existing) > 1 && rules.BestOf < 3 {
		rules.BestOf = 3
	}
	allFifteen := true
	for _, g := range existing {
		top := g.ScoreA
		if g.ScoreB > top {
			top = g.ScoreB
		}
		if top < 15 {
			allFifteen = false
			break
		}
	}
	if rules.PointsToWin < 15 && allFifteen {
		rules.PointsToWin = 15
	}
	return rules
}

// ── the score screen ──────────────────────────────────────────────────────

type scoringMatch struct {
	ID           string  `json:"id"`
	TournamentID string  `json:"tournamentId"`
	RoundName    *string `json:"roundName"`
	TeamAID      string  `json:"teamAId"`
	TeamBID      string  `json:"teamBId"`
	Status       string  `json:"status"`
	ResultState  string  `json:"resultState"`
	ResultType   string  `json:"resultType"`
	WinnerTeamID *string `json:"winnerTeamId"`
	// Version is what the screen sends back as expectedVersion, so a score
	// typed against a match that has since moved on is not written blind.
	Version int `json:"version"`
}

type matchForScoringOut struct {
	Match         scoringMatch        `json:"match"`
	CategoryName  string              `json:"categoryName"`
	CourtName     *string             `json:"courtName"`
	CourtColorKey *string             `json:"courtColorKey"`
	NameA         string              `json:"nameA"`
	NameB         string              `json:"nameB"`
	Rules         engine.ScoringRules `json:"rules"`
	Games         []engine.Game       `json:"games"`
}

func getMatchForScoring(ctx context.Context, d *core.Deps, matchID string) (*matchForScoringOut, error) {
	match, err := store.MatchByID(ctx, d.DB, matchID)
	if err != nil {
		return nil, rpc.NotFound("That match no longer exists.")
	}
	t, err := store.TournamentByID(ctx, d.DB, d.Venue.ID, match.TournamentID)
	if err != nil {
		return nil, rpc.NotFound("That match no longer exists.")
	}
	// A score cannot be entered for "Winner of Semi-final 1".
	if match.TeamAID == nil || match.TeamBID == nil {
		return nil, rpc.NotFound("That match is still waiting on an earlier result.")
	}
	names, err := store.TeamNames(ctx, d.DB, t.ID)
	if err != nil {
		return nil, err
	}
	out := &matchForScoringOut{
		Match: scoringMatch{
			ID: match.ID, TournamentID: match.TournamentID, RoundName: match.RoundName,
			TeamAID: *match.TeamAID, TeamBID: *match.TeamBID, Status: match.Status,
			ResultState: match.ResultState, ResultType: match.ResultType, WinnerTeamID: match.WinnerTeamID,
			Version: match.Version,
		},
		CategoryName: engine.CategoryName(t.Gender, t.Discipline),
		NameA:        names[*match.TeamAID],
		NameB:        names[*match.TeamBID],
		Rules:        rulesForMatch(t, match.Games),
		Games:        match.Games,
	}
	if out.Games == nil {
		out.Games = []engine.Game{}
	}
	// The court only matters while they are on it: a correction an hour later
	// has no business shouting COURT 1.
	if match.Status == "live" && match.CourtID != nil {
		if c, err := courtByID(ctx, d.DB, d.Venue.ID, *match.CourtID); err == nil {
			out.CourtName = strp(c.Name)
			out.CourtColorKey = strp(c.ColorKey)
		}
	}
	return out, nil
}

// ── normalising what a screen sent ────────────────────────────────────────

type normalized struct {
	Games         []engine.Game
	WinnerTeamID  *string
	RetiredTeamID *string
}

// normalizeResult turns what a screen sent into what actually gets stored.
// Nothing structural is taken on trust.
func normalizeResult(rules engine.ScoringRules, match *store.Match, in saveResultIn) (normalized, string) {
	if match.TeamAID == nil || match.TeamBID == nil {
		return normalized{}, "This match is still waiting on an earlier result."
	}
	sides := map[string]bool{*match.TeamAID: true, *match.TeamBID: true}
	games := make([]engine.Game, 0, len(in.Games))
	for _, g := range in.Games {
		if g.ScoreA < 0 || g.ScoreB < 0 {
			return normalized{}, "Scores can’t be negative."
		}
		// excludeFromDiff is never accepted from the wire: it decides the
		// venue's headline tiebreak.
		games = append(games, engine.Game{GameNo: g.GameNo, ScoreA: g.ScoreA, ScoreB: g.ScoreB, TimeCapped: g.TimeCapped})
	}
	sort.SliceStable(games, func(i, j int) bool { return games[i].GameNo < games[j].GameNo })

	switch in.ResultType {
	case "walkover":
		winner := deref(in.WinnerTeamID)
		if winner == "" || !sides[winner] {
			return normalized{}, "Say which side went through."
		}
		base := engine.WalkoverGames(rules)
		if winner != *match.TeamAID {
			for i := range base {
				base[i].ScoreA, base[i].ScoreB = base[i].ScoreB, base[i].ScoreA
			}
		}
		return normalized{Games: base, WinnerTeamID: strp(winner)}, ""

	case "retired":
		retired := deref(in.RetiredTeamID)
		if retired == "" || !sides[retired] {
			return normalized{}, "Say which side couldn’t carry on."
		}
		side := "B"
		winner := *match.TeamAID
		if retired == *match.TeamAID {
			side = "A"
			winner = *match.TeamBID
		}
		gs, _ := engine.RetirementGames(rules, games, side)
		return normalized{Games: gs, WinnerTeamID: strp(winner), RetiredTeamID: strp(retired)}, ""

	case "normal", "":
		if v := engine.ValidateGames(rules, games); !v.OK {
			return normalized{}, v.Reason
		}
		// A time-capped game ends the MATCH, not just the game — so a
		// horn-stopped match is complete on one game, or on two that are level.
		stoppedByHorn := false
		for _, g := range games {
			if g.TimeCapped {
				stoppedByHorn = true
			}
		}
		outcome := engine.Outcome(rules, games)
		if stoppedByHorn {
			outcome = engine.HornOutcome(rules, games)
		}
		var winner *string
		switch outcome.Winner {
		case "A":
			winner = match.TeamAID
		case "B":
			winner = match.TeamBID
		}
		if winner == nil {
			if stoppedByHorn {
				return normalized{}, "Level on games and level on the game the horn stopped — the organiser has to call this one."
			}
			return normalized{}, "Those games don’t decide the match."
		}
		return normalized{Games: games, WinnerTeamID: winner}, ""
	}
	return normalized{}, "That isn’t a kind of result."
}

// outcomeFor is the reference's helper: the match as the engine reads it.
func outcomeFor(rules engine.ScoringRules, games []engine.Game) engine.MatchOutcome {
	return engine.Outcome(rules, games)
}

// ── saving ────────────────────────────────────────────────────────────────

type wireGame struct {
	GameNo     int  `json:"gameNo"`
	ScoreA     int  `json:"scoreA"`
	ScoreB     int  `json:"scoreB"`
	TimeCapped bool `json:"timeCapped"`
}

type saveResultIn struct {
	MatchID       string     `json:"matchId"`
	Games         []wireGame `json:"games"`
	ResultType    string     `json:"resultType"`
	WinnerTeamID  *string    `json:"winnerTeamId"`
	RetiredTeamID *string    `json:"retiredTeamId"`
	Reason        string     `json:"reason"`
	// ExpectedVersion is the optimistic lock: the match's version as the screen
	// loaded it. Sent by the score screen, absent from anything else.
	ExpectedVersion *int `json:"expectedVersion"`
}

type saveResultOut struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error,omitempty"`
	Recover string `json:"recover,omitempty"`
}

func saveResult(ctx context.Context, d *core.Deps, in saveResultIn) (saveResultOut, error) {
	var out saveResultOut
	err := d.Tx(ctx, func(tx *sql.Tx) error {
		match, err := store.MatchByID(ctx, tx, in.MatchID)
		if err != nil {
			out = saveResultOut{Error: "That match no longer exists."}
			return nil
		}
		// The tournament row is locked before the match row, everywhere in this
		// package, so two taps on two phones take turns rather than deadlock.
		t, err := store.TournamentByIDForUpdate(ctx, tx, d.Venue.ID, match.TournamentID)
		if err != nil {
			out = saveResultOut{Error: "That match no longer exists."}
			return nil
		}
		match, err = store.MatchByIDForUpdate(ctx, tx, in.MatchID)
		if err != nil {
			out = saveResultOut{Error: "That match no longer exists."}
			return nil
		}
		// The world moved while the score was being typed: this screen is
		// looking at the wrong thing, and re-reading is the only safe answer.
		if in.ExpectedVersion != nil && *in.ExpectedVersion != match.Version {
			out = saveResultOut{
				Error:   "This match has changed since this screen opened.",
				Recover: "reload",
			}
			return nil
		}

		hadResult := match.ResultState != "none"
		if hadResult {
			reason := strings.TrimSpace(in.Reason)
			if len([]rune(reason)) < 3 {
				out = saveResultOut{Error: "Say what changed — it goes in the log next to your name."}
				return nil
			}
			in.Reason = reason
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
				out = saveResultOut{Error: strings.Join(names, ", ") +
					" has already started off this result. Void it first, or apply this when that match finishes."}
				return nil
			}
		}

		// A correction keeps the rules the played games were entered under.
		rules := rulesForMatch(t, match.Games)
		value, refusal := normalizeResult(rules, match, in)
		if refusal != "" {
			// The organiser is the authority and the rules engine is the
			// default: a game the pair played out to an informal cap is a real
			// result, and refusing to record it sends the day back to a paper
			// list. Only for a plain result with a named winner.
			winner := deref(in.WinnerTeamID)
			ownSide := winner != "" && (winner == deref(match.TeamAID) || winner == deref(match.TeamBID))
			if in.ResultType != "normal" || !ownSide {
				out = saveResultOut{Error: refusal}
				return nil
			}
			games := make([]engine.Game, 0, len(in.Games))
			seen := map[int]bool{}
			for _, g := range in.Games {
				if g.ScoreA < 0 || g.ScoreB < 0 {
					out = saveResultOut{Error: "Scores can’t be negative."}
					return nil
				}
				if seen[g.GameNo] {
					out = saveResultOut{Error: rpc.String("Game %d is in there twice.", g.GameNo)}
					return nil
				}
				seen[g.GameNo] = true
				games = append(games, engine.Game{GameNo: g.GameNo, ScoreA: g.ScoreA, ScoreB: g.ScoreB, TimeCapped: g.TimeCapped})
			}
			value = normalized{Games: games, WinnerTeamID: strp(winner)}
		}

		// A walkover is on the record and in no difference column at all; a
		// horn-stopped game keeps its points and sits out of point difference.
		walkover := in.ResultType == "walkover"
		for i := range value.Games {
			if walkover || value.Games[i].TimeCapped {
				value.Games[i].ExcludeFromDiff = true
			}
		}

		before := map[string]any{
			"games": scorePairs(match.Games), "winnerTeamId": match.WinnerTeamID, "resultType": match.ResultType,
		}

		wonA, wonB := 0, 0
		for _, g := range value.Games {
			if g.ScoreA > g.ScoreB {
				wonA++
			} else if g.ScoreB > g.ScoreA {
				wonB++
			}
		}
		if err := store.SaveGames(ctx, tx, match.ID, value.Games, wonA, wonB); err != nil {
			return err
		}
		resultType := in.ResultType
		if resultType == "" {
			resultType = "normal"
		}
		corrected := "null"
		if hadResult {
			corrected = "now()"
		}
		// court_id is deliberately kept: the unique index only guards `live`,
		// and the public page says which court a result was played on.
		if _, err := tx.ExecContext(ctx, `
			update matches set winner_team_id = $2, retired_team_id = $3, result_type = $4,
				result_state = 'final', status = 'completed', ended_at = now(),
				corrected_at = `+corrected+`, updated_at = now()
			where id = $1`, match.ID, value.WinnerTeamID, value.RetiredTeamID, resultType); err != nil {
			return err
		}

		action := "match.set_result"
		if hadResult {
			action = "match.correct"
		}
		if err := audit(ctx, tx, action, "match", match.ID, in.Reason, map[string]any{
			"before": before,
			"after": map[string]any{
				"games": scorePairs(value.Games), "winnerTeamId": value.WinnerTeamID, "resultType": resultType,
			},
		}); err != nil {
			return err
		}
		if err := core.Bump(ctx, tx, t.ID); err != nil {
			return err
		}
		// The court this was on is free the moment the score is in. The next
		// match in order goes on before the organiser is back on the board.
		if err := flowVenue(ctx, tx, d, t.ID, nil); err != nil {
			return err
		}
		out = saveResultOut{OK: true}
		return nil
	})
	return out, err
}

func scorePairs(games []engine.Game) [][2]int {
	out := make([][2]int, 0, len(games))
	for _, g := range games {
		out = append(out, [2]int{g.ScoreA, g.ScoreB})
	}
	return out
}

// ── the downstream guard ──────────────────────────────────────────────────

type blocker struct {
	ID        string
	RoundName *string
}

// correctionBlockers — a correction is refused while a downstream match has
// already started, and the blocking match is named rather than the change
// simply failing.
//
// Two kinds of dependency. The first is a knockout match fed directly by this
// one. The second — the case the reference missed entirely — is every match fed
// by the TABLE this one sits in: a league builds its semis and final from
// group_rank slots, so for the default format the guard never fired, and an
// organiser could rewrite the group score a live semi-final had been built
// from.
func correctionBlockers(ctx context.Context, q core.Querier, match *store.Match) ([]blocker, error) {
	all, err := store.Matches(ctx, q, match.TournamentID)
	if err != nil {
		return nil, err
	}
	groupName := ""
	if match.Stage == "group" {
		groupName, err = groupNameOf(ctx, q, match)
		if err != nil {
			return nil, err
		}
	}
	var out []blocker
	for _, m := range all {
		if m.ID == match.ID {
			continue
		}
		fed := false
		for _, src := range []store.SlotSource{m.SourceA, m.SourceB} {
			switch src.Type {
			case "winner_of", "loser_of":
				if src.MatchID == match.ID {
					fed = true
				}
			case "group_rank":
				// "" means this match's group could not be named: every table
				// in the tournament then counts, which errs towards refusing.
				if match.Stage == "group" && (groupName == "" || src.GroupName == groupName) {
					fed = true
				}
			}
		}
		if !fed {
			continue
		}
		if m.Status == "live" || m.Status == "completed" {
			out = append(out, blocker{ID: m.ID, RoundName: m.RoundName})
		}
	}
	return out, nil
}

func groupNameOf(ctx context.Context, q core.Querier, match *store.Match) (string, error) {
	if match.GroupID == nil {
		return "", nil
	}
	var name string
	err := q.QueryRowContext(ctx, `select name from groups where id = $1`, *match.GroupID).Scan(&name)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return name, err
}

// ── resolving the slots ───────────────────────────────────────────────────

// resolveSlots fills in the sides whose source has become known: the winner of
// an earlier match, or a finishing position in a group whose matches are all
// in. A match with both sides known becomes ready.
func resolveSlots(ctx context.Context, tx *sql.Tx, d *core.Deps, t *store.Tournament) error {
	all, err := store.Matches(ctx, tx, t.ID)
	if err != nil {
		return err
	}
	byID := make(map[string]*store.Match, len(all))
	for _, m := range all {
		byID[m.ID] = m
	}
	groups, err := store.Groups(ctx, tx, t.ID)
	if err != nil {
		return err
	}
	teams, err := store.Teams(ctx, tx, t.ID)
	if err != nil {
		return err
	}

	ranked := map[string][]string{} // group name → team ids, in table order
	for _, g := range groups {
		// A pair who have gone home do not take a place in the knockout. Their
		// played matches still stand in the table everyone reads — that is the
		// public page's business — but the draw is not built on them.
		var active []string
		for _, tm := range teams {
			if tm.GroupID != nil && *tm.GroupID == g.ID && tm.Status == "active" {
				active = append(active, tm.ID)
			}
		}
		if len(active) == 0 {
			continue
		}
		// A voided match is settled — it counts for nobody, which is a result
		// of a kind. Requiring `final` alone meant cancelling one group match
		// froze that group's ranking for good.
		allIn := true
		for _, m := range all {
			if m.Stage != "group" || m.GroupID == nil || *m.GroupID != g.ID {
				continue
			}
			if m.ResultState == "none" {
				allIn = false
				break
			}
		}
		if !allIn {
			continue
		}
		input, err := store.StandingsMatches(ctx, tx, t.ID, g.ID)
		if err != nil {
			return err
		}
		rows := engine.Standings(active, input, engine.PointsScoredFirst)
		ids := make([]string, 0, len(rows))
		for _, r := range rows {
			ids = append(ids, r.TeamID)
		}
		ranked[g.Name] = ids
	}

	resolve := func(src store.SlotSource) string {
		switch src.Type {
		case "winner_of":
			if s, ok := byID[src.MatchID]; ok && s.ResultState == "final" && s.WinnerTeamID != nil {
				return *s.WinnerTeamID
			}
		case "loser_of":
			if s, ok := byID[src.MatchID]; ok && s.ResultState == "final" && s.WinnerTeamID != nil {
				if *s.WinnerTeamID == deref(s.TeamAID) {
					return deref(s.TeamBID)
				}
				return deref(s.TeamAID)
			}
		case "group_rank":
			order := ranked[src.GroupName]
			if src.Rank >= 1 && src.Rank <= len(order) {
				return order[src.Rank-1]
			}
		}
		return ""
	}

	for _, m := range all {
		for _, side := range []struct {
			column  string
			src     store.SlotSource
			current *string
		}{{"team_a_id", m.SourceA, m.TeamAID}, {"team_b_id", m.SourceB, m.TeamBID}} {
			teamID := resolve(side.src)
			if teamID == "" || teamID == deref(side.current) {
				continue
			}
			// A correction upstream re-fills the slot — but never under a match
			// that has already started.
			if side.current != nil && (m.Status == "live" || m.Status == "completed") {
				continue
			}
			if _, err := tx.ExecContext(ctx,
				`update matches set `+side.column+` = $2, version = version + 1, updated_at = now() where id = $1`,
				m.ID, teamID); err != nil {
				return err
			}
		}
	}

	// A match with both slots filled becomes placeable.
	_, err = tx.ExecContext(ctx, `
		update matches set status = 'ready', updated_at = now()
		where tournament_id = $1 and status = 'pending' and team_a_id is not null and team_b_id is not null`, t.ID)
	return err
}

// ── the RPCs ──────────────────────────────────────────────────────────────

func registerScoring(reg *rpc.Registry, d *core.Deps) {
	rpc.Register(reg, "scoring.getMatchForScoring", rpc.Organiser,
		func(ctx context.Context, in matchIn) (*matchForScoringOut, error) {
			return getMatchForScoring(ctx, d, in.MatchID)
		})

	rpc.Register(reg, "scoring.saveResult", rpc.Organiser,
		func(ctx context.Context, in saveResultIn) (saveResultOut, error) {
			return saveResult(ctx, d, in)
		})
}
