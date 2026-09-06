package engine

// Turning a WhatsApp message into a player list — SPEC A2, ported from
// app/src/lib/parse-players.ts.
//
// The list already exists, in a group chat. This parses that, not a CSV:
// strip numbering, bullets and emoji, one name per line, a 10-digit number is
// a phone. It never rejects a paste — anything it can't read comes back
// flagged for the organiser to fix in the review table.
//
// Pure. Tested, including against the TypeScript it was ported from.

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// ParsedRow is one line of the paste, cleaned up.
type ParsedRow struct {
	Raw     string
	Name    string
	Phone   string // "" for none
	Warning string // "" for none, something the organiser should look at
}

// JavaScript's \s and String.trim() cover more than Go's \s, which is ASCII
// only. A pasted WhatsApp line really can carry a non-breaking space, so the
// class is spelled out here rather than borrowed — otherwise "Ravi Kumar"
// would keep the space the reference collapses.
const (
	jsSpaceChars = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005" +
		"\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
	jsSpaceSet = `\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`
	ws         = "[" + jsSpaceSet + "]"
	wsOrDash   = "[" + jsSpaceSet + "-]"
)

var (
	// The reference's EMOJI class, rune for rune. Go's regexp works on runes,
	// so the \u{…} ranges become \x{…} and nothing else changes.
	emojiRe = regexp.MustCompile(
		`[\x{1F000}-\x{1FAFF}\x{2190}-\x{21FF}\x{2300}-\x{27BF}\x{2B00}-\x{2BFF}\x{FE00}-\x{FE0F}\x{200D}]`)

	// 10-digit Indian mobile, with or without a +91 or 0 prefix, and
	// tolerating the spaces and hyphens people actually type
	// ("+91 98400 12345").
	phoneRe = regexp.MustCompile(
		`(?:\+?` + ws + `*91` + wsOrDash + `*)?0?` + ws + `*(?:[6-9](?:` + wsOrDash + `*\d){9})`)

	// Leading list markers: "1.", "1)", "-", "*", "•"
	markerRe = regexp.MustCompile(`^` + ws + `*(?:\d{1,3}` + ws + `*[.)\]-]|[-*•·—])` + ws + `*`)
	// Trailing paid markers people add: ✅ (already stripped), "paid", "(paid)"
	paidRe    = regexp.MustCompile(`(?i)\(?\bpaid\b\)?`)
	spacesRe  = regexp.MustCompile(ws + `+`)
	trailRe   = regexp.MustCompile(`[,;|]+$`)
	pairRe    = regexp.MustCompile(`(?i)[/&+]| and `)
	letterRe  = regexp.MustCompile(`[A-Za-z]`)
	notNameRe = regexp.MustCompile(`[^a-z0-9` + jsSpaceSet + `]`)
	lineRe    = regexp.MustCompile(`\r?\n`)
)

// jsTrim is String.prototype.trim: the same whitespace set as \s.
func jsTrim(s string) string { return strings.Trim(s, jsSpaceChars) }

// collapse is `.replace(/\s+/g, ' ').trim()`, the shape that appears three
// times in the reference.
func collapse(s string) string { return jsTrim(spacesRe.ReplaceAllString(s, " ")) }

// NormalizeName — the key two spellings of one person share.
func NormalizeName(name string) string {
	s := foldCompatibility(strings.ToLower(name))
	s = notNameRe.ReplaceAllString(s, "")
	return collapse(s)
}

// NormalizePhone — a 10-digit Indian mobile as "+919840012345", or "" when we
// cannot be confident (the caller keeps the raw value either way).
func NormalizePhone(input string) string {
	var digits []rune
	for _, r := range input {
		if r >= '0' && r <= '9' {
			digits = append(digits, r)
		}
	}
	if len(digits) > 10 {
		digits = digits[len(digits)-10:]
	}
	if len(digits) != 10 || digits[0] < '6' || digits[0] > '9' {
		return ""
	}
	return "+91" + string(digits)
}

// ParsePlayerList — one name per line, numbering, bullets and emoji stripped,
// a phone picked out; never rejects a paste.
func ParsePlayerList(text string) []ParsedRow {
	rows := []ParsedRow{}

	for _, line := range lineRe.Split(text, -1) {
		raw := line
		s := emojiRe.ReplaceAllString(line, " ")
		s = markerRe.ReplaceAllString(s, "")
		s = paidRe.ReplaceAllString(s, " ")
		s = collapse(s)

		if s == "" {
			continue
		}

		phone := ""
		if m := phoneRe.FindString(s); m != "" {
			phone = NormalizePhone(m)
			// The reference passes a string, not a regexp, to replace: the
			// first occurrence only.
			s = collapse(strings.Replace(s, m, " ", 1))
		}

		// Anything left that is mostly digits isn't a name.
		name := jsTrim(trailRe.ReplaceAllString(s, ""))
		if name == "" {
			rows = append(rows, ParsedRow{Raw: raw, Name: "", Phone: phone, Warning: "No name on this line"})
			continue
		}

		row := ParsedRow{Raw: raw, Name: name, Phone: phone}
		switch {
		case pairRe.MatchString(name):
			row.Warning = "Two names on this line — is this a pair?"
		case utf16Len(name) < 2:
			row.Warning = "Very short name"
		case !letterRe.MatchString(name):
			row.Warning = "Doesn’t look like a name"
		}
		rows = append(rows, row)
	}

	return rows
}

// utf16Len is JavaScript's String.length, which counts UTF-16 code units —
// the reference's "very short name" test is a length comparison, and a name
// of one astral character is two units there and one rune here.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r > 0xFFFF {
			n++
		}
	}
	return n
}

// LooksLikeSamePerson — "Ravi S", "S Ravi", "Ravi" and "Ravi Shankar" are,
// more often than not, one man typing his name four ways into a group chat.
// Two name keys look like the same person when every word of the shorter one
// is a whole word, or the start of a word, in the longer one — and at least
// one of them is a whole word, so a pair of initials does not match everybody.
//
// It is a flag for the organiser, never a decision: "Ravi Kumar" and "Ravi
// Shankar" share a first name and are two people, and this says so.
func LooksLikeSamePerson(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	if a == b {
		return true
	}
	wa := strings.Split(a, " ")
	wb := strings.Split(b, " ")
	short, long := wa, wb
	if len(wa) > len(wb) {
		short, long = wb, wa
	}
	unused := make([]string, len(long))
	copy(unused, long)
	whole := false
	for _, w := range short {
		i := -1
		for j, u := range unused {
			if u == w || strings.HasPrefix(u, w) || strings.HasPrefix(w, u) {
				i = j
				break
			}
		}
		if i == -1 {
			return false
		}
		if unused[i] == w {
			whole = true
		}
		unused = append(unused[:i], unused[i+1:]...)
	}
	return whole
}

// Existing is a person already on the venue's roster.
type Existing struct {
	ID       string
	Name     string
	NameKey  string
	PhoneKey string // "" for none
}

// Duplicate is the person a pasted row looks like, and what gave it away.
type Duplicate struct {
	ID   string
	Name string
	On   string // phone | name
}

// FindDuplicates flags rows that look like the same human, so the roster
// stays one row per person. Row index → the existing person it looks like.
func FindDuplicates(rows []ParsedRow, existing []Existing) map[int]Duplicate {
	byPhone := make(map[string]Existing, len(existing))
	byName := make(map[string]Existing, len(existing))
	for _, e := range existing {
		if e.PhoneKey != "" {
			byPhone[e.PhoneKey] = e
		}
		byName[e.NameKey] = e
	}

	out := map[int]Duplicate{}
	for i, row := range rows {
		if phoneKey := NormalizePhone(row.Phone); phoneKey != "" {
			if hit, ok := byPhone[phoneKey]; ok {
				out[i] = Duplicate{ID: hit.ID, Name: hit.Name, On: "phone"}
				continue
			}
		}
		if nameKey := NormalizeName(row.Name); nameKey != "" {
			if hit, ok := byName[nameKey]; ok {
				out[i] = Duplicate{ID: hit.ID, Name: hit.Name, On: "name"}
			}
		}
	}

	return out
}

// foldCompatibility stands in for the reference's .normalize('NFKD'). Go's
// standard library has no Unicode normaliser and this module may not take a
// dependency, so instead of decomposing everything we fold the characters
// whose decomposition would survive the [^a-z0-9\s] filter on the next line:
// Latin letters carrying a diacritic, the full-width forms, and the Latin
// ligatures. Everything else NFKD touches — Tamil, Devanagari, combining
// marks — is stripped by that filter on both sides, so the key comes out the
// same.
func foldCompatibility(s string) string {
	if isASCII(s) {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case r < utf8.RuneSelf:
			b.WriteRune(r)
		case r >= 0xFF01 && r <= 0xFF5E: // full-width ASCII
			b.WriteRune(r - 0xFEE0)
		default:
			if base, ok := latinFolds[r]; ok {
				b.WriteString(base)
			} else if !unicode.Is(unicode.Mn, r) {
				// Combining marks are dropped by NFKD's filter anyway; other
				// runes are kept and stripped (or not) exactly as they are.
				b.WriteRune(r)
			}
		}
	}
	return b.String()
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}

// latinFolds is every precomposed Latin letter in Latin-1 Supplement and
// Latin Extended-A whose NFKD form starts with an ASCII letter, plus the
// Latin ligatures. Letters NFKD leaves alone — æ ð ø þ ß œ ł đ — are absent
// on purpose: the reference strips them, so we must too.
var latinFolds = map[rune]string{
	'À': "A", 'Á': "A", 'Â': "A", 'Ã': "A", 'Ä': "A", 'Å': "A",
	'à': "a", 'á': "a", 'â': "a", 'ã': "a", 'ä': "a", 'å': "a",
	'Ç': "C", 'ç': "c",
	'È': "E", 'É': "E", 'Ê': "E", 'Ë': "E",
	'è': "e", 'é': "e", 'ê': "e", 'ë': "e",
	'Ì': "I", 'Í': "I", 'Î': "I", 'Ï': "I",
	'ì': "i", 'í': "i", 'î': "i", 'ï': "i",
	'Ñ': "N", 'ñ': "n",
	'Ò': "O", 'Ó': "O", 'Ô': "O", 'Õ': "O", 'Ö': "O",
	'ò': "o", 'ó': "o", 'ô': "o", 'õ': "o", 'ö': "o",
	'Ù': "U", 'Ú': "U", 'Û': "U", 'Ü': "U",
	'ù': "u", 'ú': "u", 'û': "u", 'ü': "u",
	'Ý': "Y", 'ý': "y", 'ÿ': "y",

	'Ā': "A", 'ā': "a", 'Ă': "A", 'ă': "a", 'Ą': "A", 'ą': "a",
	'Ć': "C", 'ć': "c", 'Ĉ': "C", 'ĉ': "c", 'Ċ': "C", 'ċ': "c", 'Č': "C", 'č': "c",
	'Ď': "D", 'ď': "d",
	'Ē': "E", 'ē': "e", 'Ĕ': "E", 'ĕ': "e", 'Ė': "E", 'ė': "e",
	'Ę': "E", 'ę': "e", 'Ě': "E", 'ě': "e",
	'Ĝ': "G", 'ĝ': "g", 'Ğ': "G", 'ğ': "g", 'Ġ': "G", 'ġ': "g", 'Ģ': "G", 'ģ': "g",
	'Ĥ': "H", 'ĥ': "h",
	'Ĩ': "I", 'ĩ': "i", 'Ī': "I", 'ī': "i", 'Ĭ': "I", 'ĭ': "i",
	'Į': "I", 'į': "i", 'İ': "I",
	'Ĳ': "IJ", 'ĳ': "ij",
	'Ĵ': "J", 'ĵ': "j",
	'Ķ': "K", 'ķ': "k",
	'Ĺ': "L", 'ĺ': "l", 'Ļ': "L", 'ļ': "l", 'Ľ': "L", 'ľ': "l", 'Ŀ': "L", 'ŀ': "l",
	'Ń': "N", 'ń': "n", 'Ņ': "N", 'ņ': "n", 'Ň': "N", 'ň': "n",
	'Ō': "O", 'ō': "o", 'Ŏ': "O", 'ŏ': "o", 'Ő': "O", 'ő': "o",
	'Ŕ': "R", 'ŕ': "r", 'Ŗ': "R", 'ŗ': "r", 'Ř': "R", 'ř': "r",
	'Ś': "S", 'ś': "s", 'Ŝ': "S", 'ŝ': "s", 'Ş': "S", 'ş': "s", 'Š': "S", 'š': "s",
	'Ţ': "T", 'ţ': "t", 'Ť': "T", 'ť': "t",
	'Ũ': "U", 'ũ': "u", 'Ū': "U", 'ū': "u", 'Ŭ': "U", 'ŭ': "u",
	'Ů': "U", 'ů': "u", 'Ű': "U", 'ű': "u", 'Ų': "U", 'ų': "u",
	'Ŵ': "W", 'ŵ': "w",
	'Ŷ': "Y", 'ŷ': "y", 'Ÿ': "Y",
	'Ź': "Z", 'ź': "z", 'Ż': "Z", 'ż': "z", 'Ž': "Z", 'ž': "z",
	'ſ': "s",

	'ﬀ': "ff", 'ﬁ': "fi", 'ﬂ': "fl", 'ﬃ': "ffi", 'ﬄ': "ffl", 'ﬅ': "st", 'ﬆ': "st",
}
