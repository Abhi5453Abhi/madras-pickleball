import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Crockford base32 — excludes I, L, O, U so a printed court card can be typed
 * in the sun without ambiguity (SPEC A1).
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * Crockford's decoding rules, which is the half people forget to implement:
 * O reads as 0, I and L read as 1, and case and separators don't count. Without
 * this, excluding the ambiguous letters from the alphabet achieves nothing —
 * someone squinting at a card in the sun still types O for 0 and gets
 * "that link isn't working".
 */
export function normalizeCrockford(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** Constant-time comparison of two hex digests. */
export function hashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/** ~50 bits, formatted `K7X4M-9RQ2`. Typeable, and not brute-forceable behind a rate limit. */
export function newCourtToken(): { raw: string; hash: string; prefix: string } {
  const bytes = randomBytes(10)
  let out = ''
  for (let i = 0; i < 10; i++) out += CROCKFORD[bytes[i] % 32]
  const raw = `${out.slice(0, 5)}-${out.slice(5)}`
  // The hash is over the NORMALIZED form, so a card typed as O/0 or l/1
  // resolves to the same token the QR does.
  return { raw, hash: sha256Hex(normalizeCrockford(raw)), prefix: out.slice(0, 5) }
}

/** 32 random bytes; only the SHA-256 is ever stored (SPEC A9). */
export function newSessionToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url')
  return { raw, hash: sha256Hex(raw) }
}

/** 8 characters, shown once on screen for the admin to read out (SPEC A9). */
export function newResetCode(): { raw: string; hash: string } {
  const bytes = randomBytes(8)
  let out = ''
  for (let i = 0; i < 8; i++) out += CROCKFORD[bytes[i] % 32]
  return { raw: out, hash: sha256Hex(normalizeCrockford(out)) }
}

/** IPs are only ever stored hashed. */
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null
  return sha256Hex(`ip:${ip}`)
}

export function normalizeDigestInput(parts: unknown): string {
  return sha256Hex(JSON.stringify(parts))
}
