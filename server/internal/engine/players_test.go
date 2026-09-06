package engine

// Ported from app/src/lib/__tests__/parse-players.test.ts — every case, with
// the same inputs and the same expected values — plus the messy lines a
// differential run against the TypeScript was checked on (the harness is
// gone; its answers are these expectations). The words from
// app/src/server/events.ts are at the bottom: nothing else tests them.

import (
	"reflect"
	"testing"
)

func names(rows []ParsedRow) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = r.Name
	}
	return out
}

func TestParseStripsNumberingBulletsEmojiAndPaidMarkers(t *testing.T) {
	rows := ParsePlayerList("1. Ravi Kumar ✅\n" +
		"2) Priya S 9840012345\n" +
		"- Karthik\n" +
		"• Meera Nair (paid)\n" +
		"   \n" +
		"4. Arun / Deepa")
	want := []string{"Ravi Kumar", "Priya S", "Karthik", "Meera Nair", "Arun / Deepa"}
	if got := names(rows); !reflect.DeepEqual(got, want) {
		t.Errorf("names = %q, want %q", got, want)
	}
}

func TestParsePullsOutAPhoneNumberAndNormalisesIt(t *testing.T) {
	rows := ParsePlayerList("Priya S 9840012345")
	if len(rows) != 1 {
		t.Fatalf("%d rows, want 1", len(rows))
	}
	if rows[0].Name != "Priya S" {
		t.Errorf("name = %q, want \"Priya S\"", rows[0].Name)
	}
	if rows[0].Phone != "+919840012345" {
		t.Errorf("phone = %q, want +919840012345", rows[0].Phone)
	}
}

func TestParseAcceptsThe91AndZeroPrefixes(t *testing.T) {
	for _, line := range []string{
		"Ravi +91 98400 12345",
		"Ravi 09840012345",
		"🏓 Suresh 👍 +91-98400-12345",
		"Anil Kumar\t\t9 8 4 0 0 1 2 3 4 5",
	} {
		rows := ParsePlayerList(line)
		if len(rows) != 1 || rows[0].Phone != "+919840012345" {
			t.Errorf("%q gave %+v, want the one phone +919840012345", line, rows)
		}
	}
}

func TestParseFlagsALineThatLooksLikeAPair(t *testing.T) {
	for _, line := range []string{"Arun / Deepa", "Ravi and Kumar", "Gopi+Raj", "Deepa & Latha"} {
		rows := ParsePlayerList(line)
		if len(rows) != 1 || rows[0].Warning != "Two names on this line — is this a pair?" {
			t.Errorf("%q gave %+v, want the pair warning", line, rows)
		}
	}
	// The line is kept as typed, never split or dropped.
	if got := ParsePlayerList("Arun / Deepa")[0].Name; got != "Arun / Deepa" {
		t.Errorf("name = %q, want \"Arun / Deepa\"", got)
	}
}

func TestParseNeverThrowsAwayALineItCannotRead(t *testing.T) {
	rows := ParsePlayerList("9840012345")
	if len(rows) != 1 {
		t.Fatalf("%d rows, want 1", len(rows))
	}
	if rows[0].Warning != "No name on this line" {
		t.Errorf("warning = %q", rows[0].Warning)
	}
	if rows[0].Phone != "+919840012345" {
		t.Errorf("phone = %q, want +919840012345", rows[0].Phone)
	}
	if rows[0].Raw != "9840012345" {
		t.Errorf("raw = %q, want the line as typed", rows[0].Raw)
	}
}

func TestParseIgnoresBlankLines(t *testing.T) {
	if got := len(ParsePlayerList("\n\n  \nRavi\n\n")); got != 1 {
		t.Errorf("%d rows, want 1", got)
	}
	if got := len(ParsePlayerList("")); got != 0 {
		t.Errorf("%d rows for an empty paste, want 0", got)
	}
}

func TestParseWarnsAboutAShortNameAndOneWithNoLetters(t *testing.T) {
	cases := []struct{ line, name, warning string }{
		{"22", "22", "Doesn’t look like a name"},
		{"....", "....", "Doesn’t look like a name"},
		{"A", "A", "Very short name"},
		{"X Y", "X Y", ""},
	}
	for _, c := range cases {
		rows := ParsePlayerList(c.line)
		if len(rows) != 1 || rows[0].Name != c.name || rows[0].Warning != c.warning {
			t.Errorf("%q gave %+v, want name %q warning %q", c.line, rows, c.name, c.warning)
		}
	}
}

// The lines a real WhatsApp list throws at it, checked against the reference
// character for character — including the ones it deliberately does not
// tidy up: a hyphen left where a phone number was, and numbering the
// reference's marker pattern does not recognise.
func TestParseMatchesTheReferenceOnAMessyPaste(t *testing.T) {
	cases := []struct {
		line    string
		name    string
		phone   string
		warning string
	}{
		{"1. Karthik Subramanian ✅", "Karthik Subramanian", "", ""},
		{"2. Sathish Kumar 98400 12345", "Sathish Kumar", "+919840012345", ""},
		{"+91 98400 12345", "", "+919840012345", "No name on this line"},
		{"Ravi Shankar - 9840012345", "Ravi Shankar -", "+919840012345", ""},
		{"(1) Vijay Anand", "(1) Vijay Anand", "", ""},
		{"·  Anitha—Krishnan", "Anitha—Krishnan", "", ""},
		{"— Suresh Babu", "Suresh Babu", "", ""},
		{"* Vijay Anand PAID", "Vijay Anand", "", ""},
		{"5]  Bala   ✅✅   paid", "Bala", "", ""},
		{"6 . Chandra", "Chandra", "", ""},
		{"R. Shankar, ", "R. Shankar", "", ""},
		{"Naveen|", "Naveen", "", ""},
		{"10 Downing 9012345678 street", "10 Downing street", "+919012345678", ""},
		{"José Ángel Muñoz ✅", "José Ángel Muñoz", "", ""},
		{"Ｒａｖｉ Ｋｕｍａｒ", "Ｒａｖｉ Ｋｕｍａｒ", "", "Doesn’t look like a name"},
	}
	for _, c := range cases {
		rows := ParsePlayerList(c.line)
		if len(rows) != 1 {
			t.Errorf("%q gave %d rows, want 1", c.line, len(rows))
			continue
		}
		got := rows[0]
		if got.Name != c.name || got.Phone != c.phone || got.Warning != c.warning {
			t.Errorf("%q gave name %q phone %q warning %q, want %q / %q / %q",
				c.line, got.Name, got.Phone, got.Warning, c.name, c.phone, c.warning)
		}
	}
}

func TestParseSplitsOnWindowsLineEndings(t *testing.T) {
	rows := ParsePlayerList("Ravi\r\nPriya\r\n")
	if got := names(rows); !reflect.DeepEqual(got, []string{"Ravi", "Priya"}) {
		t.Errorf("names = %q", got)
	}
}

func TestNormalizeNameMakesAComparableKey(t *testing.T) {
	if got := NormalizeName("Ravi  Kumar!"); got != "ravi kumar" {
		t.Errorf("NormalizeName(\"Ravi  Kumar!\") = %q", got)
	}
	if NormalizeName("RAVI KUMAR") != NormalizeName("ravi kumar") {
		t.Error("case decides the key")
	}
	// The decomposing half of the reference's NFKD, on the characters that
	// survive its filter.
	cases := []struct{ in, want string }{
		{"José Ángel", "jose angel"},
		{"Kārthik Śrī", "karthik sri"},
		{"Ｒａｖｉ Ｋｕｍａｒ", "ravi kumar"},
		{"ﬁona", "fiona"},
		{"Ĳsbrand", "ijsbrand"},
		{"Ravi‑Kumar", "ravikumar"},  // a non-ASCII hyphen is stripped
		{"Ravi Kumar", "ravi kumar"}, // a non-breaking space is a space
		{"  S. Ravi-Shankar  ", "s ravishankar"},
		{"आरव कुमार", ""},
		{"✅", ""},
	}
	for _, c := range cases {
		if got := NormalizeName(c.in); got != c.want {
			t.Errorf("NormalizeName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestNormalizePhoneRejectsThingsThatAreNotIndianMobiles(t *testing.T) {
	cases := []struct{ in, want string }{
		{"12345", ""},
		{"1234567890", ""}, // starts with 1
		{"", ""},
		{"9840012345", "+919840012345"},
		{"+91 98400 12345", "+919840012345"},
		{"09840012345", "+919840012345"},
		{"919840012345", "+919840012345"},
		{"98400-12345", "+919840012345"},
		{"+919840012345", "+919840012345"}, // its own output, unchanged
	}
	for _, c := range cases {
		if got := NormalizePhone(c.in); got != c.want {
			t.Errorf("NormalizePhone(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func roster() []Existing {
	return []Existing{
		{ID: "p1", Name: "Ravi Kumar", NameKey: "ravi kumar", PhoneKey: "+919840012345"},
		{ID: "p2", Name: "Meera Nair", NameKey: "meera nair", PhoneKey: ""},
	}
}

func TestFindDuplicatesMatchesOnPhoneFirst(t *testing.T) {
	dupes := FindDuplicates(ParsePlayerList("Ravi K 9840012345"), roster())
	want := Duplicate{ID: "p1", Name: "Ravi Kumar", On: "phone"}
	if dupes[0] != want {
		t.Errorf("dupes[0] = %+v, want %+v", dupes[0], want)
	}
}

func TestFindDuplicatesFallsBackToANormalisedName(t *testing.T) {
	dupes := FindDuplicates(ParsePlayerList("meera nair"), roster())
	want := Duplicate{ID: "p2", Name: "Meera Nair", On: "name"}
	if dupes[0] != want {
		t.Errorf("dupes[0] = %+v, want %+v", dupes[0], want)
	}
}

func TestFindDuplicatesLeavesGenuinelyNewPeopleAlone(t *testing.T) {
	if got := len(FindDuplicates(ParsePlayerList("Anjali R"), roster())); got != 0 {
		t.Errorf("%d duplicates, want 0", got)
	}
}

func TestFindDuplicatesKeepsTheRowIndexes(t *testing.T) {
	rows := ParsePlayerList("Anjali R\nMeera Nair\nRavi K 9840012345")
	dupes := FindDuplicates(rows, roster())
	if len(dupes) != 2 {
		t.Fatalf("%d duplicates, want 2", len(dupes))
	}
	if dupes[1].On != "name" || dupes[2].On != "phone" {
		t.Errorf("dupes = %+v", dupes)
	}
	if _, ok := dupes[0]; ok {
		t.Error("the new person was flagged")
	}
}

func TestLooksLikeSamePersonSpotsOneManTypingHisNameFourWays(t *testing.T) {
	same := func(a, b string) bool { return LooksLikeSamePerson(NormalizeName(a), NormalizeName(b)) }
	for _, c := range [][2]string{
		{"Ravi S", "Ravi Shankar"},
		{"Ravi", "Ravi Shankar"},
		{"S Ravi", "Ravi Shankar"},
		{"R. Shankar", "Ravi Shankar"},
		{"Ravi Shankar", "ravi   shankar"},
	} {
		if !same(c[0], c[1]) {
			t.Errorf("%q and %q are the same person", c[0], c[1])
		}
	}
}

func TestLooksLikeSamePersonLeavesTwoPeopleSharingAFirstNameAlone(t *testing.T) {
	same := func(a, b string) bool { return LooksLikeSamePerson(NormalizeName(a), NormalizeName(b)) }
	for _, c := range [][2]string{
		{"Ravi Kumar", "Ravi Shankar"},
		{"Arun Prakash", "Arun Kumar"},
		{"Karthik", "Sathish Kumar"},
		// A pair of initials must not match everybody.
		{"R S", "Ravi Shankar"},
		{"", "Ravi Shankar"},
	} {
		if same(c[0], c[1]) {
			t.Errorf("%q and %q are two people", c[0], c[1])
		}
	}
}

// ── the words (app/src/server/events.ts) ─────────────────────────────────

func TestFormatWords(t *testing.T) {
	cases := []struct{ stage, want string }{
		{"none", "everyone plays everyone"},
		{"final_only", "league, then a final"},
		{"semis_and_final", "league, then semis and a final"},
		// Older rows may carry a stage the draw builder folds into semis.
		{"quarters_and_up", "league, then semis and a final"},
		{"", "league, then semis and a final"},
	}
	for _, c := range cases {
		if got := FormatWords(c.stage); got != c.want {
			t.Errorf("FormatWords(%q) = %q, want %q", c.stage, got, c.want)
		}
	}
}

func TestCategoryName(t *testing.T) {
	cases := []struct{ gender, discipline, want string }{
		{"mens", "doubles", "Men's Doubles"},
		{"womens", "doubles", "Women's Doubles"},
		{"mixed", "doubles", "Mixed Doubles"},
		{"any", "singles", "Open Singles"},
		{"mens", "singles", "Men's Singles"},
	}
	for _, c := range cases {
		if got := CategoryName(c.gender, c.discipline); got != c.want {
			t.Errorf("CategoryName(%q, %q) = %q, want %q", c.gender, c.discipline, got, c.want)
		}
	}
}
