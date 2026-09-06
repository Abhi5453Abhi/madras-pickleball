// Package pin hashes and checks the six-digit PIN an organiser signs in with.
//
// PBKDF2-SHA256 from the standard library, because the Go side of this app
// depends on nothing but Postgres. A six-digit PIN has a million
// possibilities whatever the hash, so the real defence is the lockout in
// package auth; the hash only has to make a leaked table slow to grind.
package pin

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
)

const (
	iterations = 300_000
	keyLen     = 32
	saltLen    = 16
)

// Hash returns "pbkdf2-sha256$<iterations>$<salt>$<key>", both base64.
func Hash(p string) (string, error) {
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, err := pbkdf2.Key(sha256.New, p, salt, iterations, keyLen)
	if err != nil {
		return "", err
	}
	enc := base64.RawStdEncoding
	return fmt.Sprintf("pbkdf2-sha256$%d$%s$%s", iterations, enc.EncodeToString(salt), enc.EncodeToString(key)), nil
}

// Verify reports whether p is the PIN behind hash. Malformed hashes are
// simply wrong — never an error a caller might mistake for "no PIN set".
func Verify(hash, p string) bool {
	parts := strings.Split(hash, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2-sha256" {
		return false
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter < 1000 {
		return false
	}
	enc := base64.RawStdEncoding
	salt, err := enc.DecodeString(parts[2])
	if err != nil {
		return false
	}
	want, err := enc.DecodeString(parts[3])
	if err != nil {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, p, salt, iter, len(want))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

// Normalize returns the six digits in raw, or "" when raw is not a PIN.
func Normalize(raw string) string {
	var b strings.Builder
	for _, r := range raw {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	if b.Len() != 6 {
		return ""
	}
	return b.String()
}
