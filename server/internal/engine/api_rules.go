package engine

// STUBS — the engine's public surface, fixed up front so the modules that
// depend on it can be written at the same time as the engine itself. Every
// body here panics; the engine port replaces this file's contents with real
// implementations (in this file or in files it creates) — keep every
// signature exactly as it is, the other modules are written against them.
//
// The reference for each function is named in its comment. Port the
// behaviour exactly, including the words in the strings: the screens print
// them and the browser walks read them.

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
