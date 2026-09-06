package engine

// Terminal scoring logic — SPEC A5, ported from app/src/lib/rules.ts.
//
// This is the half of the rules engine that answers "is this match over and
// who won". Quick result entry needs all of it. The rally-by-rally state
// machine, if it ever lands, must terminate into these same functions, or
// there will be two definitions of a finished match that disagree.
//
// Pure. No database, no clock, no HTTP. Tested.

import "fmt"

// ScoringRules is what a category is played under. HardCap nil means no cap;
// at the cap the next point wins, win-by-1.
type ScoringRules struct {
	BestOf      int  `json:"bestOf"` // 1 or 3
	PointsToWin int  `json:"pointsToWin"`
	WinBy       int  `json:"winBy"`
	HardCap     *int `json:"hardCap"` // nil = no cap
}

// Game is one game as stored in matches.games and as sent by the keypad.
//
// ExcludeFromDiff is carried on the game itself, where the reference keeps a
// separate list of game numbers: the standings tally reads the flag, and the
// scoring module writes the list into the ledger, so the two constructors
// below set the flag and also return the list.
type Game struct {
	GameNo          int  `json:"gameNo"`
	ScoreA          int  `json:"scoreA"`
	ScoreB          int  `json:"scoreB"`
	ExcludeFromDiff bool `json:"excludeFromDiff,omitempty"`
	TimeCapped      bool `json:"timeCapped,omitempty"`
}

// DefaultRules is best of 3 to 11, win by 2, no cap.
var DefaultRules = ScoringRules{BestOf: 3, PointsToWin: 11, WinBy: 2, HardCap: nil}

// RulesFor is the tournament's rules: DefaultRules with its best_of and
// points_to_win. v4 dropped the win_by and hard_cap columns — every category
// is win by 2 with no cap — so those come from DefaultRules and the rest of
// the engine still honours a cap when one is passed in.
func RulesFor(bestOf, pointsToWin int) ScoringRules {
	r := DefaultRules
	r.BestOf = bestOf
	r.PointsToWin = pointsToWin
	return r
}

// GamesNeededToWin — floor(bestOf/2)+1.
func GamesNeededToWin(r ScoringRules) int { return r.BestOf/2 + 1 }

// GameWinner — "A", "B" or "" when the game is not finished.
func GameWinner(r ScoringRules, g Game) string {
	hi, lo := g.ScoreA, g.ScoreB
	if hi < lo {
		hi, lo = lo, hi
	}
	leader := "B"
	if g.ScoreA > g.ScoreB {
		leader = "A"
	}

	if g.TimeCapped {
		// The horn ends it. A tied capped game is decided by the match, not
		// here.
		if g.ScoreA == g.ScoreB {
			return ""
		}
		return leader
	}
	if g.ScoreA == g.ScoreB {
		return ""
	}

	// At the cap, win by one — otherwise the game could never end.
	if r.HardCap != nil && hi >= *r.HardCap {
		if hi == *r.HardCap {
			return leader
		}
		return ""
	}
	if hi < r.PointsToWin || hi-lo < r.WinBy {
		return ""
	}
	// Past the target you can only ever be exactly winBy ahead: a 12-3 is not
	// a pickleball score in any configuration.
	if hi > r.PointsToWin && hi-lo != r.WinBy {
		return ""
	}
	return leader
}

// Validation is ok, or a reason a person can read.
type Validation struct {
	OK     bool
	Reason string
}

// ValidateGames is soft validation — the UI warns and still lets the score
// through, because a capped or time-stopped game is legitimate and an
// organiser must never be blocked from recording what actually happened
// (SPEC A5).
func ValidateGames(r ScoringRules, games []Game) Validation {
	if len(games) == 0 {
		return Validation{Reason: "No games recorded."}
	}
	if len(games) > r.BestOf {
		return Validation{Reason: fmt.Sprintf("A best-of-%d match can't have %d games.", r.BestOf, len(games))}
	}

	// A repeated game number violates the unique index on (match, game_no)
	// halfway through rewriting the ledger — which left the match with no
	// games at all and a winner nobody could account for.
	seen := make(map[int]bool, len(games))
	for _, g := range games {
		// The reference also rejects a non-integer game number; a Go int is
		// always one, so only the range check survives.
		if g.GameNo < 1 {
			return Validation{Reason: "That isn’t a game number."}
		}
		if seen[g.GameNo] {
			return Validation{Reason: fmt.Sprintf("Game %d is in there twice.", g.GameNo)}
		}
		seen[g.GameNo] = true
	}

	for _, g := range games {
		if g.ScoreA < 0 || g.ScoreB < 0 {
			return Validation{Reason: "Scores can’t be negative."}
		}
		if g.TimeCapped {
			continue
		}
		if GameWinner(r, g) == "" {
			target := r.PointsToWin
			if r.HardCap != nil {
				target = *r.HardCap
			}
			return Validation{Reason: fmt.Sprintf(
				"%d-%d isn’t a finished game — first to %d, win by %d.",
				g.ScoreA, g.ScoreB, target, r.WinBy)}
		}
	}

	// A decided match must stop; no dead rubbers.
	need := GamesNeededToWin(r)
	a, b := 0, 0
	for i, g := range games {
		switch GameWinner(r, g) {
		case "A":
			a++
		case "B":
			b++
		}
		if (a == need || b == need) && i < len(games)-1 {
			return Validation{Reason: fmt.Sprintf("The match was already won after game %d.", i+1)}
		}
	}

	return Validation{OK: true}
}

// MatchOutcome is who has won, if anyone yet.
type MatchOutcome struct {
	Complete  bool
	Winner    string // "A" | "B" | ""
	GamesWonA int
	GamesWonB int
}

// Outcome is the reference's matchOutcome.
func Outcome(r ScoringRules, games []Game) MatchOutcome {
	gamesWonA, gamesWonB := 0, 0
	for _, g := range games {
		switch GameWinner(r, g) {
		case "A":
			gamesWonA++
		case "B":
			gamesWonB++
		}
	}
	need := GamesNeededToWin(r)
	winner := ""
	if gamesWonA >= need {
		winner = "A"
	} else if gamesWonB >= need {
		winner = "B"
	}
	return MatchOutcome{
		Complete:  winner != "",
		Winner:    winner,
		GamesWonA: gamesWonA,
		GamesWonB: gamesWonB,
	}
}

// DiffCap — per-game point difference is capped so a blowout cannot decide
// a pool (SPEC A6).
const DiffCap = 8

// CappedDiff — scoreFor − scoreAgainst, clamped to ±DiffCap.
func CappedDiff(scoreFor, scoreAgainst int) int {
	d := scoreFor - scoreAgainst
	if d > DiffCap {
		return DiffCap
	}
	if d < -DiffCap {
		return -DiffCap
	}
	return d
}

// WalkoverGames — a walkover records 11-0, 11-0 for the record but
// contributes nothing to any difference column, otherwise a match nobody
// played decides the pool. The reference leaves the exclusion to its one
// caller, which marks every game of a walkover; the flag is set here so the
// games carry it wherever they go.
func WalkoverGames(r ScoringRules) []Game {
	need := GamesNeededToWin(r)
	games := make([]Game, need)
	for i := range games {
		games[i] = Game{GameNo: i + 1, ScoreA: r.PointsToWin, ScoreB: 0, ExcludeFromDiff: true}
	}
	return games
}

// RetirementGames — the in-progress game is recorded as the target against
// the points the retiring side actually had; any unplayed games are 11-0 and
// contribute nothing to difference (SPEC A5). Returns the games and the game
// numbers kept out of point difference; those games also carry the flag.
func RetirementGames(r ScoringRules, played []Game, retiringSide string) (games []Game, excludeFromDiff []int) {
	// Copy: the caller's slice is the score screen's state, and the
	// in-progress game below is rewritten in place.
	games = make([]Game, len(played))
	copy(games, played)
	excludeFromDiff = []int{}
	need := GamesNeededToWin(r)
	outcome := Outcome(r, games)
	winnerSide := "A"
	if retiringSide == "A" {
		winnerSide = "B"
	}
	won := outcome.GamesWonA
	if winnerSide == "B" {
		won = outcome.GamesWonB
	}

	// Finish the in-progress game at the target score — or, if the side that
	// retired was somehow ahead of it, at winBy above them, because 11-11 is
	// not a finished game and the whole match would come back with no winner.
	if len(games) > 0 {
		last := &games[len(games)-1]
		if GameWinner(r, *last) == "" {
			theirScore := last.ScoreB
			if winnerSide == "B" {
				theirScore = last.ScoreA
			}
			finish := r.PointsToWin
			if theirScore+r.WinBy > finish {
				finish = theirScore + r.WinBy
			}
			if winnerSide == "A" {
				last.ScoreA = finish
			} else {
				last.ScoreB = finish
			}
			won++
		}
	}

	for won < need {
		gameNo := len(games) + 1
		g := Game{GameNo: gameNo, ExcludeFromDiff: true}
		if winnerSide == "A" {
			g.ScoreA = r.PointsToWin
		} else {
			g.ScoreB = r.PointsToWin
		}
		games = append(games, g)
		excludeFromDiff = append(excludeFromDiff, gameNo)
		won++
	}

	return games, excludeFromDiff
}

// HornOutcome — the match as it stands when time is called. The horn ends the
// MATCH, not just the game (SPEC A5).
//
// The order is the one the spec gives, and it is not "most points": the team
// leading in games wins; level on games, the team leading the game that was
// actually in progress wins; level on that too, nobody here can call it.
//
// Summing every point across the match instead would hand the day to whoever
// won an early game 11-2 — the same blowout SPEC A6 caps out of the tiebreak
// precisely so it cannot decide anything.
func HornOutcome(r ScoringRules, games []Game) MatchOutcome {
	base := Outcome(r, games)
	if base.Winner != "" {
		base.Complete = true
		return base
	}

	if base.GamesWonA != base.GamesWonB {
		winner := "B"
		if base.GamesWonA > base.GamesWonB {
			winner = "A"
		}
		return MatchOutcome{
			Complete:  true,
			Winner:    winner,
			GamesWonA: base.GamesWonA,
			GamesWonB: base.GamesWonB,
		}
	}

	// The game the horn actually stopped.
	var stopped *Game
	for i := len(games) - 1; i >= 0; i-- {
		if games[i].TimeCapped {
			stopped = &games[i]
			break
		}
	}
	if stopped == nil && len(games) > 0 {
		stopped = &games[len(games)-1]
	}
	if stopped == nil || stopped.ScoreA == stopped.ScoreB {
		base.Complete = false
		return base
	}

	winner := "B"
	if stopped.ScoreA > stopped.ScoreB {
		winner = "A"
	}
	return MatchOutcome{
		Complete:  true,
		Winner:    winner,
		GamesWonA: base.GamesWonA,
		GamesWonB: base.GamesWonB,
	}
}
