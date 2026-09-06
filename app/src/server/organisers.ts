// No `server-only` here: the setup script seeds PINs through this module.
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { users } from '@/db/schema'
import { hashPin, verifyPin } from '@/lib/password'

/**
 * Organisers and their PINs — SPEC v4.
 *
 * One PIN, one organiser. There is no username on the sign-in screen: the PIN
 * is the whole credential, so it identifies the person as well as admitting
 * them. Two organisers therefore cannot share a PIN, and `setPin` refuses one
 * that would collide. The old `username` column stays as an internal handle
 * and the audit log's actor label; nobody types it any more.
 */

export const PIN_LENGTH = 6
const ORGANISER_ROLES = ['admin', 'super_admin'] as const

/** Digits only, exactly six of them, or null. */
export function normalizePin(raw: unknown): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '')
  return digits.length === PIN_LENGTH ? digits : null
}

/**
 * The organisers a PIN is checked against, most recently signed-in first so
 * the usual person costs one argon2 verify, not three.
 */
async function candidates() {
  return db
    .select({
      id: users.id,
      name: users.name,
      username: users.username,
      role: users.role,
      pinHash: users.pinHash,
      mustChangePassword: users.mustChangePassword,
    })
    .from(users)
    .where(
      and(inArray(users.role, [...ORGANISER_ROLES]), eq(users.active, true), isNull(users.deletedAt)),
    )
    .orderBy(desc(users.lastLoginAt))
}

/** The organiser this PIN belongs to, or null. Constant message either way. */
export async function organiserForPin(pin: string) {
  for (const u of await candidates()) {
    if (u.pinHash && (await verifyPin(u.pinHash, pin))) return u
  }
  return null
}

/**
 * Give an organiser a new PIN. Refuses one another organiser already has,
 * because sign-in would then admit whichever of them the list reached first.
 */
export async function setPin(userId: string, pin: string) {
  for (const u of await candidates()) {
    if (u.id === userId) continue
    if (u.pinHash && (await verifyPin(u.pinHash, pin))) {
      return { ok: false as const, error: 'Another organiser already uses that PIN. Pick a different one.' }
    }
  }
  const digest = await hashPin(pin)
  await db
    .update(users)
    .set({
      pinHash: digest,
      // The password column is not read any more, but it is NOT NULL and the
      // PIN is the credential now — so it carries the same digest rather
      // than a stale password somebody could still be trying.
      passwordHash: digest,
      mustChangePassword: false,
      passwordChangedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
  return { ok: true as const }
}

/**
 * Temporary PINs for organisers who predate PIN sign-in, and for a fresh
 * install. Fixed, in order, so the person setting the app up can read them
 * off the README rather than a terminal — and every one of them must be
 * replaced on first sign-in before anything else opens.
 */
export const TEMP_PINS = ['123456', '234567', '345678', '456789'] as const

export async function ensureOrganiserPins(): Promise<Array<{ username: string; pin: string }>> {
  const rows = await db
    .select({ id: users.id, username: users.username, pinHash: users.pinHash, role: users.role })
    .from(users)
    .where(and(eq(users.active, true), isNull(users.deletedAt)))
    .orderBy(users.createdAt)

  const issued: Array<{ username: string; pin: string }> = []
  let i = 0
  for (const u of rows) {
    if (!ORGANISER_ROLES.includes(u.role as (typeof ORGANISER_ROLES)[number])) {
      // Umpire accounts from before v4 have no screen to go to. Off, not deleted.
      await db.update(users).set({ active: false, updatedAt: new Date() }).where(eq(users.id, u.id))
      continue
    }
    if (u.pinHash) continue
    // The next temporary PIN nobody already has — an organiser who chose
    // 123456 for themselves must not find a colleague sharing it.
    let pin: string | undefined
    while (i < TEMP_PINS.length) {
      const candidate = TEMP_PINS[i++]!
      if (!(await organiserForPin(candidate))) {
        pin = candidate
        break
      }
    }
    if (!pin) break
    const digest = await hashPin(pin)
    await db
      .update(users)
      .set({ pinHash: digest, passwordHash: digest, mustChangePassword: true, updatedAt: new Date() })
      .where(eq(users.id, u.id))
    issued.push({ username: u.username, pin })
  }
  return issued
}
