package engine

// This file is the engine's public surface, fixed up front so the modules
// that depend on it can be written at the same time as the engine itself.
// Every body here is a stub; the engine port replaces them file by file
// (draw.go, standings.go, rules.go, estimate.go, players.go, words.go) and
// deletes this file when nothing is left in it.
//
// The reference for each function is named in its comment. Port the
// behaviour exactly, including the words in the strings: the screens print
// them and the browser walks read them.

import "time"

// ── draws (app/src/lib/draw.ts) ───────────────────────────────────────────

// FinalsStage is how a tournament ends: none, final_only, semis_and_final.
type FinalsStage string

// SlotSource says where one side of a match comes from.
type SlotSource struct {
	Type      string `json:"type"` // entry | group_rank | winner_of | loser_of | bye
	TeamID    string `json:"teamId,omitempty"`
	GroupName string `json:"groupName,omitempty"`
	Rank      int    `json:"rank,omitempty"`
	// MatchKey is the plan-local key of the source match (winner_of /
	// loser_of); the store swaps it for the real match id when persisting.
	MatchKey string `json:"matchKey,omitempty"`
	MatchID  string `json:"matchId,omitempty"`
}

// MatchPlan is one match of a draw before it has an id.
type MatchPlan struct {
	Key        string // stable within one generation, wires slot sources
	Stage      string // group | knockout
	GroupName  string // "" for knockout
	RoundIndex int
	RoundName  string
	Seq        int
	SlotA      SlotSource
	SlotB      SlotSource
}

type GroupPlan struct {
	Name         string
	TeamIDs      []string
	AdvanceCount int
}

type DrawPlan struct {
	Groups  []GroupPlan
	Matches []MatchPlan
}

// PoolCountFor — pools of 3 are never made; below 8 entries it is one league.
func PoolCountFor(teamCount int) int { panic("engine: not ported") }

// SerpentineSplit — 1,2,3,4 then 8,7,6,5 then 9,10,11,12…
func SerpentineSplit(seedOrder []string, poolCount int) [][]string { panic("engine: not ported") }

// RoundRobinRounds — circle method; a team paired with "" sits the round out.
func RoundRobinRounds(teamIDs []string) [][][2]string { panic("engine: not ported") }

// BuildLeague — one group, everyone plays everyone, then the finals stage.
func BuildLeague(seedOrder []string, stage FinalsStage) DrawPlan { panic("engine: not ported") }

// BuildGroupsKnockout — pools, then a knockout of the top two per pool.
func BuildGroupsKnockout(seedOrder []string, poolCount int) DrawPlan { panic("engine: not ported") }

// BuildDraw — league when drawType is "league", pools otherwise.
func BuildDraw(seedOrder []string, drawType string, stage FinalsStage) DrawPlan {
	panic("engine: not ported")
}

// SeededShuffle — deterministic from a stored seed, so a random draw can be
// reproduced. Same FNV/xorshift sequence as the reference.
func SeededShuffle(items []string, seed string) []string { panic("engine: not ported") }

// PairRandomly — chunks of teamSize from the shuffled list; a leftover
// player is dropped (app/src/server/tournaments.ts pairRandomly).
func PairRandomly(playerIDs []string, seed string, teamSize int) [][]string {
	panic("engine: not ported")
}

// ── scoring rules (app/src/lib/rules.ts) ──────────────────────────────────

type ScoringRules struct {
	BestOf      int  `json:"bestOf"` // 1 or 3
	PointsToWin int  `json:"pointsToWin"`
	WinBy       int  `json:"winBy"`
	HardCap     *int `json:"hardCap"` // nil = no cap
}

// Game is one game as stored in matches.games and as sent by the keypad.
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
// points_to_win.
func RulesFor(bestOf, pointsToWin int) ScoringRules { panic("engine: not ported") }

// GamesNeededToWin — floor(bestOf/2)+1.
func GamesNeededToWin(r ScoringRules) int { panic("engine: not ported") }

// GameWinner — "A", "B" or "" when the game is not finished.
func GameWinner(r ScoringRules, g Game) string { panic("engine: not ported") }

// Validation is ok, or a reason a person can read.
type Validation struct {
	OK     bool
	Reason string
}

// ValidateGames — the reference's validateGames, same reasons word for word.
func ValidateGames(r ScoringRules, games []Game) Validation { panic("engine: not ported") }

type MatchOutcome struct {
	Complete  bool
	Winner    string // "A" | "B" | ""
	GamesWonA int
	GamesWonB int
}

// MatchOutcome — who has won, if anyone yet.
func Outcome(r ScoringRules, games []Game) MatchOutcome { panic("engine: not ported") }

// DiffCap — per-game point difference is capped so a blowout cannot decide
// a pool.
const DiffCap = 8

// CappedDiff — scoreFor − scoreAgainst, clamped to ±DiffCap.
func CappedDiff(scoreFor, scoreAgainst int) int { panic("engine: not ported") }

// WalkoverGames — the games a no-show is recorded as (kept out of point
// difference).
func WalkoverGames(r ScoringRules) []Game { panic("engine: not ported") }

// RetirementGames — the in-progress game at its actual score, unplayed games
// filled in; returns the games and the indexes kept out of point difference.
func RetirementGames(r ScoringRules, played []Game, retiringSide string) (games []Game, excludeFromDiff []int) {
	panic("engine: not ported")
}

// HornOutcome — the match as it stands when time is called.
func HornOutcome(r ScoringRules, games []Game) MatchOutcome { panic("engine: not ported") }

// ── standings (app/src/lib/standings.ts) ──────────────────────────────────

// StandingsMatch is what the table needs from a match. State is final or
// voided in v4 (the reference's reported/disputed count as final).
type StandingsMatch struct {
	MatchID      string
	TeamAID      string
	TeamBID      string
	WinnerTeamID string // "" when none
	State        string // final | voided
	ResultType   string // normal | bye | walkover | retired | cancelled
	Games        []Game
}

type TeamRow struct {
	TeamID        string  `json:"teamId"`
	Played        int     `json:"played"`
	Won           int     `json:"won"`
	Lost          int     `json:"lost"`
	WinRatio      float64 `json:"winRatio"`
	GamesWon      int     `json:"gamesWon"`
	GamesLost     int     `json:"gamesLost"`
	GameDiff      int     `json:"gameDiff"`
	PointsFor     int     `json:"pointsFor"`
	PointsAgainst int     `json:"pointsAgainst"`
	PointDiff     int     `json:"pointDiff"`
	// Reason is set once the table is ordered, e.g. "2nd on head-to-head vs
	// Arun / Deepa"; "" when nothing needed saying.
	Reason      string `json:"reason,omitempty"`
	Provisional bool   `json:"provisional"`
	Disputed    bool   `json:"disputed"`
}

// TiebreakRule — points_scored_first (the venue's rule) or head_to_head_first.
type TiebreakRule string

const (
	PointsScoredFirst TiebreakRule = "points_scored_first"
	HeadToHeadFirst   TiebreakRule = "head_to_head_first"
)

// TallyRows — the counts, unordered, keyed by team.
func TallyRows(teamIDs []string, matches []StandingsMatch) map[string]*TeamRow {
	panic("engine: not ported")
}

// Standings — the ordered table with reasons. Dead heats keep seed order
// (the order of teamIDs) and say "drawn — level on everything, kept in the
// order the pairs were made".
func Standings(teamIDs []string, matches []StandingsMatch, rule TiebreakRule) []TeamRow {
	panic("engine: not ported")
}

// TiebreakNote — the sentence printed under every table.
func TiebreakNote(rule TiebreakRule) string { panic("engine: not ported") }

// TieNote — the reason worth printing under a row, or "" for none.
func TieNote(reason string, leagueDone bool) string { panic("engine: not ported") }

// ── the finish estimate (app/src/lib/estimate.ts) ─────────────────────────

type FormatShape struct {
	BestOf      int
	PointsToWin int
}

// MinutesPerMatch — 30 for best of 3, else 20 or 15.
func MinutesPerMatch(shape FormatShape) int { panic("engine: not ported") }

type CategoryLoad struct {
	Name               string
	MatchCount         int
	MinutesPerMatch    int
	MinMatchesPerEntry int
}

type DayEstimate struct {
	TotalMatches int
	Minutes      int
	FinishAt     *time.Time
	PastSunset   bool
	PerCategory  []CategoryLoad
}

type EstimateInput struct {
	Categories   []CategoryLoad
	Courts       int
	StartAt      *time.Time
	BreakMinutes int
	SunsetAt     *time.Time
}

// EstimateDay — how long the day will take, across shared courts.
func EstimateDay(in EstimateInput) DayEstimate { panic("engine: not ported") }

// LeagueMatchCount — matches and guaranteed matches per entry for a league
// of n plus its finals.
func LeagueMatchCount(teams int, stage FinalsStage) (matches, minPerEntry int) {
	panic("engine: not ported")
}

// GroupsKnockoutMatchCount — pools of roughly equal size plus a knockout of
// two per pool.
func GroupsKnockoutMatchCount(teams, poolCount int) (matches, minPerEntry int) {
	panic("engine: not ported")
}

// ── pasted lists and names (app/src/lib/parse-players.ts) ─────────────────

type ParsedRow struct {
	Raw     string
	Name    string
	Phone   string // "" for none
	Warning string // "" for none
}

// NormalizeName — the key two spellings of one person share.
func NormalizeName(name string) string { panic("engine: not ported") }

// NormalizePhone — a 10-digit Indian mobile as "9840012345", or "".
func NormalizePhone(input string) string { panic("engine: not ported") }

// ParsePlayerList — one name per line, numbering, bullets and emoji
// stripped, a phone picked out; never rejects a paste.
func ParsePlayerList(text string) []ParsedRow { panic("engine: not ported") }

// LooksLikeSamePerson — the fuzzy name match used at sign-up.
func LooksLikeSamePerson(a, b string) bool { panic("engine: not ported") }

type Existing struct {
	ID       string
	Name     string
	NameKey  string
	PhoneKey string // "" for none
}

type Duplicate struct {
	ID   string
	Name string
	On   string // phone | name
}

// FindDuplicates — row index → the existing person it looks like.
func FindDuplicates(rows []ParsedRow, existing []Existing) map[int]Duplicate {
	panic("engine: not ported")
}

// ── words (app/src/server/events.ts) ──────────────────────────────────────

// GenderWords — mens "Men's", womens "Women's", mixed "Mixed", any "Open".
var GenderWords = map[string]string{"mens": "Men's", "womens": "Women's", "mixed": "Mixed", "any": "Open"}

// FormatWords — "everyone plays everyone" / "league, then a final" /
// "league, then semis and a final"; an unknown stage reads as semis.
func FormatWords(stage string) string { panic("engine: not ported") }

// CategoryName — "Men's Doubles", "Open Singles".
func CategoryName(gender, discipline string) string { panic("engine: not ported") }
