// Package ids makes the identifiers every row and URL carries.
package ids

import (
	"crypto/rand"
	"encoding/hex"
)

// Alphabet is lowercase letters and digits only: ids appear in URLs and are
// read out over the phone, so no case to get wrong and no look-alike symbols.
const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"

// New returns "<prefix>_<16 random chars>" — about 82 bits, plenty for a
// venue and unguessable enough for the sign-up token's own use.
func New(prefix string) string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("ids: crypto/rand failed: " + err.Error())
	}
	out := make([]byte, 16)
	for i, v := range b {
		out[i] = alphabet[int(v)%len(alphabet)]
	}
	if prefix == "" {
		return string(out)
	}
	return prefix + "_" + string(out)
}

// Token returns 40 hex characters of randomness for a capability URL.
func Token() string {
	b := make([]byte, 20)
	if _, err := rand.Read(b); err != nil {
		panic("ids: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}
