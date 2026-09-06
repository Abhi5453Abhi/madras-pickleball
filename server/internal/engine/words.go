package engine

// The words a category is described in — ported from app/src/server/events.ts.
// They are printed on the public page and read back by the browser walks, so
// they are the reference's words, exactly.

// GenderWords — mens "Men's", womens "Women's", mixed "Mixed", any "Open".
var GenderWords = map[string]string{"mens": "Men's", "womens": "Women's", "mixed": "Mixed", "any": "Open"}

// formatWords — how a finals stage reads in a sentence.
var formatWordsByStage = map[string]string{
	"none":            "everyone plays everyone",
	"final_only":      "league, then a final",
	"semis_and_final": "league, then semis and a final",
}

// FormatWords — an unknown stage reads as semis: older rows may carry a stage
// the draw builder folds into semis, and no screen may print a raw enum.
func FormatWords(stage string) string {
	if words, ok := formatWordsByStage[stage]; ok {
		return words
	}
	return formatWordsByStage["semis_and_final"]
}

// CategoryName — "Men's Doubles", "Open Singles".
func CategoryName(gender, discipline string) string {
	play := "Doubles"
	if discipline == "singles" {
		play = "Singles"
	}
	return GenderWords[gender] + " " + play
}
