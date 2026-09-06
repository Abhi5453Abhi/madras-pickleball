import { createHash, randomBytes } from 'node:crypto'

/**
 * Crockford base32 decoding rules — the sign-up link is Crockford (no I, L,
 * O, U), and this is the half people forget: O reads as 0, I and L read as
 * 1, and case and separators don't count. Someone typing a link off a
 * WhatsApp screenshot still types O for 0 and gets "that link isn't working".
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

/** 32 random bytes; only the SHA-256 is ever stored (SPEC A9). */
export function newSessionToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url')
  return { raw, hash: sha256Hex(raw) }
}

/** IPs are only ever stored hashed. */
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null
  return sha256Hex(`ip:${ip}`)
}

export function normalizeDigestInput(parts: unknown): string {
  return sha256Hex(JSON.stringify(parts))
}
